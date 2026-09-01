use serde_json::{Value, json};
use uuid::Uuid;
use vibe_cs_agent::HistoryMessage;
use vibe_cs_domain::{
    AgentSession, AgentSessionEntry, AgentToolCall, AgentTurnStatus, Project, TimelineClipMaterial,
};

const MAXIMUM_MODEL_HISTORY_MESSAGES: usize = 40;
const MAXIMUM_HISTORY_CHECKPOINT_CHARS: usize = 15_000;
const MAXIMUM_ASSISTANT_PROSE_CHARS: usize = 2_000;
const MAXIMUM_SUMMARY_CLIPS: usize = 128;
const MAXIMUM_SUMMARY_CLIPS_PER_TRACK: usize = 32;
const MAXIMUM_SUMMARY_MARKERS: usize = 32;

/// Returns the smallest useful live Project context, expanding the canonical Editing Document
/// only when the model explicitly requests timeline detail.
pub(crate) fn workspace_context(
    workspace: &Value,
    project: &Project,
    input: &Value,
) -> Result<Value, String> {
    let detail = input
        .get("detail")
        .and_then(Value::as_str)
        .unwrap_or("summary");
    match detail {
        "summary" => Ok(json!({
            "workspace":workspace,
            "project":project_summary(project),
            "context":{
                "detail":"summary",
                "next":"Call read_workspace with detail='timeline' and optional trackIds or clipIds only when exact editable fields are required."
            }
        })),
        "timeline" => {
            let track_ids = optional_uuid_filter(input, "trackIds", 16)?;
            let clip_ids = optional_uuid_filter(input, "clipIds", 64)?;
            let mut project = project.clone();
            if let Some(track_ids) = &track_ids {
                project
                    .document
                    .tracks
                    .retain(|track| track_ids.contains(&track.id));
            }
            if let Some(clip_ids) = &clip_ids {
                for track in &mut project.document.tracks {
                    track.clips.retain(|clip| clip_ids.contains(&clip.id));
                }
                project
                    .document
                    .tracks
                    .retain(|track| !track.clips.is_empty());
            }
            Ok(json!({
                "workspace":workspace,
                "project":project,
                "context":{
                    "detail":"timeline",
                    "filtered":track_ids.is_some() || clip_ids.is_some(),
                    "trackIds":track_ids,
                    "clipIds":clip_ids,
                }
            }))
        }
        _ => Err("read_workspace detail must be 'summary' or 'timeline'".to_owned()),
    }
}

fn project_summary(project: &Project) -> Value {
    let (planned, takes, assets) = project
        .document
        .tracks
        .iter()
        .flat_map(|track| &track.clips)
        .fold((0_usize, 0_usize, 0_usize), |mut counts, clip| {
            match clip.material {
                TimelineClipMaterial::Planned => counts.0 += 1,
                TimelineClipMaterial::Take { .. } => counts.1 += 1,
                TimelineClipMaterial::Asset { .. } => counts.2 += 1,
            }
            counts
        });
    let mut remaining_clips = MAXIMUM_SUMMARY_CLIPS;
    let tracks = project
        .document
        .tracks
        .iter()
        .map(|track| {
            let clip_limit = remaining_clips.min(MAXIMUM_SUMMARY_CLIPS_PER_TRACK);
            let clips = track
                .clips
                .iter()
                .take(clip_limit)
                .map(|clip| {
                    let material = match clip.material {
                        TimelineClipMaterial::Planned => "planned",
                        TimelineClipMaterial::Take { .. } => "take",
                        TimelineClipMaterial::Asset { .. } => "asset",
                    };
                    json!({
                        "id":clip.id,
                        "name":clip.name,
                        "material":material,
                        "enabled":clip.placement.enabled,
                        "start":clip.placement.start,
                        "duration":clip.placement.duration,
                    })
                })
                .collect::<Vec<_>>();
            remaining_clips = remaining_clips.saturating_sub(clips.len());
            json!({
                "id":track.id,
                "name":track.name,
                "kind":track.kind,
                "order":track.order,
                "muted":track.muted,
                "locked":track.locked,
                "hidden":track.hidden,
                "clips":clips,
                "clipCount":track.clips.len(),
                "clipsTruncated":clips.len() < track.clips.len(),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "id":project.id,
        "name":project.name,
        "revision":project.revision,
        "timeline":{
            "width":project.document.width,
            "height":project.document.height,
            "fps":project.document.fps,
            "durationSeconds":project.document.duration_seconds,
            "storyTrackId":project.document.story_track_id,
            "tracks":tracks,
            "markers":project.document.markers.iter().take(MAXIMUM_SUMMARY_MARKERS).collect::<Vec<_>>(),
            "markerCount":project.document.markers.len(),
            "markersTruncated":project.document.markers.len() > MAXIMUM_SUMMARY_MARKERS,
        },
        "material":{
            "planned":planned,
            "takes":takes,
            "assets":assets,
        },
        "sourceDemoIds":project.document.settings.source_demo_ids,
    })
}

fn optional_uuid_filter(
    input: &Value,
    key: &str,
    maximum: usize,
) -> Result<Option<Vec<Uuid>>, String> {
    let Some(values) = input.get(key) else {
        return Ok(None);
    };
    let values = values
        .as_array()
        .ok_or_else(|| format!("read_workspace {key} must be an array"))?;
    if values.is_empty() || values.len() > maximum {
        return Err(format!(
            "read_workspace {key} must contain 1 to {maximum} identifiers"
        ));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| format!("read_workspace {key} contains an invalid identifier"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// Builds the model-facing history from the durable Agent Conversation Projection.
///
/// The current user entry and its streaming Assistant placeholder are already represented by the
/// explicit request message, so they are excluded. Completed tool evidence remains host-owned
/// structured context; unverified Assistant prose is never replayed as an Assistant authority.
pub(crate) fn model_history(
    session: &AgentSession,
    request_id: Uuid,
) -> Result<Vec<HistoryMessage>, String> {
    let active_turn_index = session
        .entries
        .iter()
        .position(|entry| {
            matches!(
                entry,
                AgentSessionEntry::Assistant {
                    request_id: Some(candidate),
                    status: Some(AgentTurnStatus::Pending | AgentTurnStatus::Streaming),
                    ..
                } if *candidate == request_id
            )
        })
        .ok_or_else(|| "durable Agent session does not contain the active turn".to_owned())?;
    let current_user_index = active_turn_index
        .checked_sub(1)
        .filter(|index| matches!(session.entries[*index], AgentSessionEntry::User { .. }))
        .ok_or_else(|| "active Agent turn is not preceded by its user request".to_owned())?;

    let mut history = session.entries[..current_user_index]
        .iter()
        .filter_map(history_message)
        .collect::<Vec<_>>();
    if history.len() > MAXIMUM_MODEL_HISTORY_MESSAGES {
        history.drain(..history.len() - MAXIMUM_MODEL_HISTORY_MESSAGES);
    }
    Ok(history)
}

fn history_message(entry: &AgentSessionEntry) -> Option<HistoryMessage> {
    let checkpoint = match entry {
        AgentSessionEntry::User { content, .. } if !content.trim().is_empty() => {
            return Some(HistoryMessage {
                role: "user".to_owned(),
                content: content.clone(),
            });
        }
        AgentSessionEntry::ToolDecision {
            tool_call_id,
            decision,
            content,
            ..
        } => tool_decision_checkpoint(tool_call_id, *decision, content),
        AgentSessionEntry::Assistant {
            content,
            tool_calls,
            status: None | Some(AgentTurnStatus::Completed),
            ..
        } => json!({
            "type":"prior_turn_tool_evidence",
            "instruction":"This is host-owned history. Assistant prose is conversational context only. Any action claim without matching completed or awaiting_confirmation tool evidence is false and must be corrected before continuing.",
            "assistant_prose":bounded_chars(content.trim(), MAXIMUM_ASSISTANT_PROSE_CHARS),
            "tool_calls":tool_calls.iter().map(tool_call_evidence).collect::<Vec<_>>(),
        }),
        AgentSessionEntry::Assistant {
            tool_calls,
            status: Some(AgentTurnStatus::Failed),
            error,
            ..
        } if !tool_calls.is_empty() => json!({
            "type":"prior_turn_checkpoint",
            "instruction":"Reuse these completed structured results; continue from the first unfinished step.",
            "tool_calls":tool_calls.iter().map(tool_call_evidence).collect::<Vec<_>>(),
            "error":error,
        }),
        AgentSessionEntry::User { .. } | AgentSessionEntry::Assistant { .. } => return None,
    };
    Some(HistoryMessage {
        role: "user".to_owned(),
        content: bounded_checkpoint(&checkpoint),
    })
}

fn tool_decision_checkpoint(
    tool_call_id: &str,
    decision: vibe_cs_domain::AgentToolDecisionKind,
    content: &str,
) -> Value {
    let delivery_group = tool_call_id
        .strip_prefix("delivery:")
        .and_then(|value| Uuid::parse_str(value).ok());
    if let Some(change_group_id) = delivery_group {
        return json!({
            "type":"human_delivery_review",
            "change_group_id":change_group_id,
            "decision":match decision {
                vibe_cs_domain::AgentToolDecisionKind::Approved => "accepted",
                vibe_cs_domain::AgentToolDecisionKind::Rejected => "changes_requested",
            },
            "content":content,
        });
    }
    json!({
        "type":"human_tool_decision",
        "tool_call_id":tool_call_id,
        "decision":decision,
        "content":content,
    })
}

fn tool_call_evidence(call: &AgentToolCall) -> Value {
    let input = call.input.as_object();
    let output = call.output.as_object();
    let operations = input
        .and_then(|input| input.get("operations"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|operation| operation.get("op").and_then(Value::as_str))
        .collect::<Vec<_>>();
    json!({
        "id":call.id,
        "name":call.name,
        "status":call.status,
        "request":{
            "projectId":input.and_then(|value| value.get("projectId")),
            "baseRevision":input.and_then(|value| value.get("baseRevision")),
            "summary":input.and_then(|value| value.get("summary")),
            "operationNames":operations,
            "clipCount":input.and_then(|value| value.get("clips")).and_then(Value::as_array).map(Vec::len),
            "clipIds":input.and_then(|value| value.get("clipIds")),
        },
        "result":{
            "status":output.and_then(|value| value.get("status")),
            "action":output.and_then(|value| value.get("action")),
            "error":output.and_then(|value| value.get("error")),
            "projectRevision":output
                .and_then(|value| value.get("project"))
                .and_then(|project| project.get("revision"))
                .or_else(|| output.and_then(|value| value.get("revision"))),
            "changeGroupId":output
                .and_then(|value| value.get("changeGroup"))
                .and_then(|group| group.get("id")),
        },
    })
}

fn bounded_checkpoint(checkpoint: &Value) -> String {
    let serialized = serde_json::to_string(&checkpoint)
        .unwrap_or_else(|_| "{\"type\":\"invalid_host_checkpoint\"}".to_owned());
    if serialized.chars().count() <= MAXIMUM_HISTORY_CHECKPOINT_CHARS {
        return serialized;
    }
    let excerpt = bounded_chars(&serialized, MAXIMUM_HISTORY_CHECKPOINT_CHARS - 1_000);
    serde_json::to_string(&json!({
        "type":"prior_turn_checkpoint_excerpt",
        "instruction":"The checkpoint was bounded for model history. Reuse it, then re-read only evidence needed for unfinished steps.",
        "excerpt":excerpt,
    }))
    .unwrap_or_else(|_| "{\"type\":\"prior_turn_checkpoint_excerpt\"}".to_owned())
}

fn bounded_chars(value: &str, maximum: usize) -> String {
    let mut characters = value.chars();
    let bounded = characters.by_ref().take(maximum).collect::<String>();
    if characters.next().is_some() {
        format!("{bounded}…")
    } else {
        bounded
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;
    use vibe_cs_domain::{
        AgentToolCallStatus, AgentToolDecisionKind, EditingDocument, EditingDocumentSettings,
        TimelineTrack, TrackKind,
    };

    use super::*;

    fn user(content: &str) -> AgentSessionEntry {
        AgentSessionEntry::User {
            id: Uuid::new_v4(),
            at: Utc::now(),
            content: content.to_owned(),
        }
    }

    fn assistant(
        request_id: Uuid,
        status: AgentTurnStatus,
        content: &str,
        tool_calls: Vec<AgentToolCall>,
    ) -> AgentSessionEntry {
        AgentSessionEntry::Assistant {
            id: Uuid::new_v4(),
            at: Utc::now(),
            content: content.to_owned(),
            tool_calls,
            status: Some(status),
            request_id: Some(request_id),
            retry_of: None,
            error: None,
            metadata: None,
        }
    }

    fn project() -> Project {
        let story_track_id = Uuid::from_u128(10);
        Project {
            id: Uuid::from_u128(1),
            name: "NiKo montage".to_owned(),
            revision: 7,
            document: EditingDocument {
                width: 1920,
                height: 1080,
                fps: 60,
                duration_seconds: 180.0,
                story_track_id,
                tracks: vec![
                    TimelineTrack {
                        id: story_track_id,
                        name: "Story".to_owned(),
                        kind: TrackKind::Video,
                        order: 0,
                        muted: false,
                        solo: false,
                        volume: 1.0,
                        pan: 0.0,
                        keyframes: Vec::new(),
                        locked: false,
                        hidden: false,
                        clips: Vec::new(),
                    },
                    TimelineTrack {
                        id: Uuid::from_u128(11),
                        name: "Music".to_owned(),
                        kind: TrackKind::Audio,
                        order: 1,
                        muted: false,
                        solo: false,
                        volume: 1.0,
                        pan: 0.0,
                        keyframes: Vec::new(),
                        locked: false,
                        hidden: false,
                        clips: Vec::new(),
                    },
                ],
                markers: Vec::new(),
                settings: EditingDocumentSettings::default(),
            },
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn history_is_built_from_durable_entries_and_excludes_the_active_request() {
        let previous_request = Uuid::new_v4();
        let active_request = Uuid::new_v4();
        let session = AgentSession {
            id: Uuid::new_v4(),
            title: "NiKo montage".to_owned(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            entries: vec![
                user("先检查交付"),
                assistant(
                    previous_request,
                    AgentTurnStatus::Completed,
                    "已经导出。",
                    vec![AgentToolCall {
                        id: "tool-1".to_owned(),
                        name: "read_project_delivery".to_owned(),
                        input: json!({"projectId":Uuid::new_v4()}),
                        output: json!({"status":"completed","revision":7}),
                        status: AgentToolCallStatus::Completed,
                    }],
                ),
                AgentSessionEntry::ToolDecision {
                    id: Uuid::new_v4(),
                    at: Utc::now(),
                    tool_call_id: "tool-1".to_owned(),
                    decision: AgentToolDecisionKind::Approved,
                    content: "接受交付".to_owned(),
                },
                AgentSessionEntry::ToolDecision {
                    id: Uuid::new_v4(),
                    at: Utc::now(),
                    tool_call_id: format!("delivery:{}", Uuid::from_u128(99)),
                    decision: AgentToolDecisionKind::Rejected,
                    content: "需要调整开场".to_owned(),
                },
                user("现在优化开场"),
                assistant(active_request, AgentTurnStatus::Streaming, "", Vec::new()),
            ],
        };

        let history = model_history(&session, active_request).expect("model history");

        assert_eq!(history.len(), 4);
        assert_eq!(history[0].content, "先检查交付");
        assert!(history[1].content.contains("prior_turn_tool_evidence"));
        assert!(history[1].content.contains("read_project_delivery"));
        assert!(history[2].content.contains("human_tool_decision"));
        assert!(history[3].content.contains("human_delivery_review"));
        assert!(history[3].content.contains("changes_requested"));
        assert!(
            history
                .iter()
                .all(|message| !message.content.contains("现在优化开场"))
        );
    }

    #[test]
    fn missing_active_turn_is_rejected_instead_of_replaying_ambiguous_history() {
        let session = AgentSession {
            id: Uuid::new_v4(),
            title: "Agent".to_owned(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            entries: vec![user("hello")],
        };

        let error = model_history(&session, Uuid::new_v4()).expect_err("missing active turn");
        assert!(error.contains("active turn"));
    }

    #[test]
    fn workspace_summary_discloses_inventory_without_the_editing_document() {
        let project = project();
        let context = workspace_context(&json!({"projectId":project.id}), &project, &json!({}))
            .expect("summary");

        assert_eq!(context.pointer("/project/revision"), Some(&json!(7)));
        assert_eq!(context.pointer("/context/detail"), Some(&json!("summary")));
        assert!(context.pointer("/project/document").is_none());
        assert_eq!(
            context
                .pointer("/project/timeline/tracks")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn workspace_timeline_expands_only_requested_tracks() {
        let project = project();
        let music_track_id = project.document.tracks[1].id;
        let context = workspace_context(
            &json!({"projectId":project.id}),
            &project,
            &json!({"detail":"timeline","trackIds":[music_track_id]}),
        )
        .expect("timeline detail");

        let tracks = context
            .pointer("/project/document/tracks")
            .and_then(Value::as_array)
            .expect("tracks");
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].get("id"), Some(&json!(music_track_id)));
        assert_eq!(context.pointer("/context/filtered"), Some(&json!(true)));
    }
}
