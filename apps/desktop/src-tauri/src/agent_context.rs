use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;
use vibe_cs_agent::HistoryMessage;
use vibe_cs_domain::{
    AgentSession, AgentSessionEntry, AgentToolCall, AgentTurnStatus, EditorTransition,
    EditorTransitionKind, Project, ProjectEditOperation, TextStyle, TimelineClip,
    TimelineClipMaterial, TimelineClipTransitions, TimelinePlacement, TimelineTrack, TrackKind,
    Transform,
};

const MAXIMUM_MODEL_HISTORY_MESSAGES: usize = 40;
const MAXIMUM_HISTORY_CHECKPOINT_CHARS: usize = 15_000;
const MAXIMUM_ASSISTANT_PROSE_CHARS: usize = 2_000;
const MAXIMUM_SUMMARY_CLIPS: usize = 128;
const MAXIMUM_SUMMARY_CLIPS_PER_TRACK: usize = 32;
const MAXIMUM_SUMMARY_MARKERS: usize = 32;

pub(crate) fn clip_event_coverage(
    clip: &TimelineClip,
    analysis: &vibe_cs_domain::MatchAnalysis,
) -> Result<Value, String> {
    let capture = clip
        .capture_intent
        .as_ref()
        .ok_or("clip has no Demo Capture Intent")?;
    let to_ticks = |seconds| crate::agent::seconds_to_replay_ticks(seconds, analysis.tick_rate);
    let capture_start = capture
        .start_tick
        .saturating_sub(to_ticks(capture.pre_roll_seconds)?);
    let capture_end = capture
        .end_tick
        .checked_add(to_ticks(capture.post_roll_seconds)?)
        .ok_or("capture end exceeds the Demo tick range")?;
    let used_start = capture_start
        .checked_add(to_ticks(clip.placement.source_in)?)
        .ok_or("source start exceeds the Demo tick range")?;
    let used_end = capture_start
        .checked_add(to_ticks(clip.placement.source_out)?)
        .ok_or("source end exceeds the Demo tick range")?;
    let highlight = analysis.highlights.iter().find(|highlight| {
        capture.highlight_id.as_deref() == Some(highlight.id.as_str())
            && capture.player_id == highlight.player_id
    });
    let expected = highlight.map(|highlight| highlight_key_events(analysis, highlight));
    let event_coverage = if clip.placement.frame_hold_source_time.is_some() {
        json!({"status":"not_evaluated","reason":"frame_hold_does_not_play_the_source_interval"})
    } else if let Some(expected) = expected {
        let (visible, missing): (Vec<_>, Vec<_>) = expected
            .into_iter()
            .partition(|event| event.tick >= used_start && event.tick < used_end);
        json!({
            "status":if visible.is_empty() && missing.is_empty() {"no_key_events"} else if missing.is_empty() {"complete"} else {"partial"},
            "expectedCount":visible.len()+missing.len(), "visibleCount":visible.len(),
            "visibleEvents":visible.iter().take(32).map(|event| key_event_summary(event, &capture.player_id)).collect::<Vec<_>>(),
            "missingEvents":missing.iter().take(32).map(|event| key_event_summary(event, &capture.player_id)).collect::<Vec<_>>(),
            "eventsTruncated":visible.len()>32 || missing.len()>32,
        })
    } else {
        json!({"status":"unknown","reason":"highlight_reference_missing_or_player_mismatched"})
    };
    Ok(json!({
        "clipId":clip.id,"name":clip.name,"demoId":capture.demo_id,"highlightId":capture.highlight_id,
        "enabled":clip.placement.enabled,"tickRate":analysis.tick_rate,
        "sourceInSeconds":clip.placement.source_in,"sourceOutSeconds":clip.placement.source_out,
        "timelineDurationSeconds":clip.placement.duration,
        "captureRange":{"startTick":capture_start,"endTick":capture_end},
        "usedRange":{"startTick":used_start,"endTickExclusive":used_end},
        "sourceWindowWithinCapture":used_start>=capture_start && used_end<=capture_end,
        "eventCoverage":event_coverage,
        "captureValidation":capture_boundary_validation(capture, analysis, capture_start, capture_end),
    }))
}

fn capture_boundary_validation(
    capture: &vibe_cs_domain::CaptureIntent,
    analysis: &vibe_cs_domain::MatchAnalysis,
    capture_start: u64,
    capture_end: u64,
) -> Value {
    let bounds = analysis
        .rounds
        .iter()
        .filter(|round| round.start_tick <= capture.start_tick)
        .max_by_key(|round| round.start_tick)
        .and_then(|round| analysis.round_capture_bounds(round.number, &capture.player_id));
    let demo_end = analysis
        .verified_total_ticks
        .filter(|ticks| *ticks > 0)
        .map(u64::from);
    let ordinary_pov =
        capture.camera_style == vibe_cs_domain::HlaeCameraStyle::Pov && !capture.victim_pov;
    let death_tick = ordinary_pov
        .then(|| bounds.and_then(|bounds| bounds.player_death_tick))
        .flatten();
    let mut issues = Vec::new();
    let mut unchecked = Vec::new();
    if demo_end.is_some_and(|limit| capture_end > limit) {
        issues.push("after_verified_demo_end");
    } else if demo_end.is_none() {
        unchecked.push("verified_demo_end");
    }
    if let Some(bounds) = bounds {
        if capture_start < bounds.round_start_tick {
            issues.push("before_round_start");
        }
        if bounds
            .recordable_end_tick
            .is_some_and(|limit| capture_end > limit)
        {
            issues.push("after_recordable_round_end");
        } else if bounds.recordable_end_tick.is_none() {
            unchecked.push("recordable_round_end");
        }
    } else {
        unchecked.push("round_bounds");
    }
    if death_tick.is_some_and(|death| capture_end >= death) {
        issues.push("ordinary_pov_reaches_player_death");
    }
    if capture.victim_pov {
        unchecked.push("victim_camera_identity_and_death");
    } else if !ordinary_pov {
        unchecked.push("non_pov_spatial_camera_feasibility");
    }
    json!({
        "status":if !issues.is_empty() {"blocked"} else if !unchecked.is_empty() {"requires_preflight"} else {"within_known_bounds"},
        "scope":"known_recording_bounds_only", "issues":issues, "unchecked":unchecked,
        "limits":{
            "roundStartTick":bounds.map(|bounds| bounds.round_start_tick),
            "recordableEndTick":bounds.and_then(|bounds| bounds.recordable_end_tick),
            "demoEndTick":demo_end,"playerDeathTick":death_tick,
        },
    })
}

fn highlight_key_events<'a>(
    analysis: &'a vibe_cs_domain::MatchAnalysis,
    highlight: &vibe_cs_domain::Highlight,
) -> Vec<&'a vibe_cs_domain::TimelineEvent> {
    let mut events = analysis
        .rounds
        .iter()
        .find(|round| round.number == highlight.round)
        .into_iter()
        .flat_map(|round| &round.events)
        .filter(|event| {
            event.tick >= highlight.start_tick
                && event.tick <= highlight.end_tick
                && matches!(
                    event.kind,
                    vibe_cs_domain::EventKind::Kill
                        | vibe_cs_domain::EventKind::BombPlant
                        | vibe_cs_domain::EventKind::BombDefuse
                )
                && (event.actor.as_deref() == Some(highlight.player_id.as_str())
                    || (event.kind == vibe_cs_domain::EventKind::Kill
                        && event.target.as_deref() == Some(highlight.player_id.as_str())))
        })
        .collect::<Vec<_>>();
    events.sort_by_key(|event| event.tick);
    events
}

fn key_event_summary(event: &vibe_cs_domain::TimelineEvent, player_id: &str) -> Value {
    json!({"tick":event.tick,"kind":event.kind,
        "role":if event.actor.as_deref() == Some(player_id) {"performed"} else {"received"}})
}

pub(crate) async fn timeline_event_coverage(
    storage: &vibe_cs_storage::Storage,
    clips: &[&TimelineClip],
) -> Result<Value, String> {
    let mut analyses = std::collections::HashMap::new();
    let mut rows = Vec::new();
    let demo_clips = clips
        .iter()
        .filter(|clip| clip.capture_intent.is_some())
        .collect::<Vec<_>>();
    for clip in demo_clips.iter().take(64) {
        let capture = clip.capture_intent.as_ref().expect("filtered Demo clip");
        if let std::collections::hash_map::Entry::Vacant(entry) = analyses.entry(capture.demo_id) {
            entry.insert(
                storage
                    .get_analysis(capture.demo_id)
                    .await
                    .map_err(|error| format!("unable to read clip analysis: {error}"))?,
            );
        }
        rows.push(match analyses[&capture.demo_id].as_ref() {
            Some(snapshot) => clip_event_coverage(clip, snapshot)?,
            None => json!({"clipId":clip.id,"name":clip.name,"eventCoverage":{"status":"unknown","reason":"analysis_unavailable"},"captureValidation":{"status":"requires_preflight","unchecked":["analysis_unavailable"]}}),
        });
    }
    Ok(json!({
        "clips":rows,"totalDemoClipCount":demo_clips.len(),"truncated":demo_clips.len()>64,
        "evidenceBoundary":"Authored source-window event inclusion, not visual/audio QA of rendered footage. usedRange is [startTick,endTickExclusive); an event at endTickExclusive is excluded. Intentional B-roll/replay omissions must be explained, not reported as complete highlight coverage. captureValidation separately checks the entire Capture against known limits; within_known_bounds does not replace recording preflight or prove the observer's runtime behavior."
    }))
}

pub(crate) async fn workspace_event_coverage(
    storage: &vibe_cs_storage::Storage,
    project: &Project,
    input: &Value,
) -> Result<Value, String> {
    let track_ids = optional_uuid_filter(input, "trackIds", 16)?;
    let clip_ids = optional_uuid_filter(input, "clipIds", 64)?;
    let clips = project
        .document
        .tracks
        .iter()
        .filter(|track| track_ids.as_ref().is_none_or(|ids| ids.contains(&track.id)))
        .flat_map(|track| &track.clips)
        .filter(|clip| clip_ids.as_ref().is_none_or(|ids| ids.contains(&clip.id)))
        .collect::<Vec<_>>();
    let mut coverage = timeline_event_coverage(storage, &clips).await?;
    coverage["projectId"] = json!(project.id);
    coverage["projectRevision"] = json!(project.revision);
    Ok(coverage)
}

pub(crate) fn demo_evidence_with_capture_bounds(
    analysis: &vibe_cs_domain::MatchAnalysis,
) -> Result<Value, serde_json::Error> {
    let mut evidence = serde_json::to_value(analysis)?;
    let rows = evidence["highlights"]
        .as_array_mut()
        .expect("MatchAnalysis serializes a highlight array");
    for (highlight, row) in analysis.highlights.iter().zip(rows) {
        let bounds = analysis.round_capture_bounds(highlight.round, &highlight.player_id);
        row["captureBounds"] = json!({
            "roundStartTick":bounds.map(|bounds| bounds.round_start_tick),
            "roundEndTick":bounds.map(|bounds| bounds.round_end_tick),
            "recordableEndTick":bounds.and_then(|bounds| bounds.recordable_end_tick),
            "nextRoundStartTick":bounds.and_then(|bounds| bounds.next_round_start_tick),
            "demoEndTick":bounds.and_then(|bounds| bounds.demo_end_tick),
            "playerDeathTick":bounds.and_then(|bounds| bounds.player_death_tick),
        });
        let key_events = highlight_key_events(analysis, highlight);
        row["keyEvents"] = json!(
            key_events
                .iter()
                .take(32)
                .map(|event| key_event_summary(event, &highlight.player_id))
                .collect::<Vec<_>>()
        );
        row["keyEventCount"] = json!(key_events.len());
        row["keyEventsTruncated"] = json!(key_events.len() > 32);
        row["demo_id"] = json!(analysis.demo_id);
        row["tick_rate"] = json!(analysis.tick_rate);
    }
    Ok(evidence)
}

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
                "next":"Read detail='assets' to discover imported library media, including unused music. Read detail='timeline' with trackIds or clipIds for existing editable fields. Before creating text or caption clips, read detail='editing_reference' with topic='text' or 'caption' for a valid current-type example."
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
        "editing_reference" => editing_reference(project, input),
        _ => Err(
            "read_workspace detail must be 'summary', 'timeline', or 'editing_reference'"
                .to_owned(),
        ),
    }
}

fn editing_reference(project: &Project, input: &Value) -> Result<Value, String> {
    if input.get("topic").and_then(Value::as_str) == Some("transitions") {
        return Ok(transition_reference(project));
    }
    let (kind, caption) = match input.get("topic").and_then(Value::as_str) {
        Some("text") => (TrackKind::Text, false),
        Some("caption") => (TrackKind::Caption, true),
        _ => {
            return Err(
                "editing_reference requires topic='text', 'caption', or 'transitions'".to_owned(),
            );
        }
    };
    let duration = project
        .document
        .duration_seconds
        .clamp(1.0 / f64::from(project.document.fps), 3.0);
    let clip = TimelineClip {
        id: Uuid::new_v4(),
        name: if caption { "Caption" } else { "Title" }.to_owned(),
        capture_intent: None,
        material: TimelineClipMaterial::Planned,
        placement: TimelinePlacement {
            start: 0.0,
            duration,
            source_in: 0.0,
            source_out: duration,
            speed: 1.0,
            reverse: false,
            frame_hold_source_time: None,
            volume: 1.0,
            pan: 0.0,
            enabled: true,
        },
        transform: Transform::default(),
        effects: Vec::new(),
        transitions: TimelineClipTransitions::default(),
        text: Some(TextStyle {
            content: if caption {
                "Your caption"
            } else {
                "Your title"
            }
            .to_owned(),
            font_family: "Arial".to_owned(),
            font_asset_id: None,
            font_size: if caption { 48.0 } else { 72.0 },
            color: "#FFFFFF".to_owned(),
            background: None,
            align: "center".to_owned(),
        }),
        metadata: json!({}),
        group_id: None,
        link_group_id: None,
        keyframes: Vec::new(),
        speed_segments: Vec::new(),
    };
    let track = TimelineTrack {
        id: Uuid::new_v4(),
        name: if caption { "Captions" } else { "Titles" }.to_owned(),
        kind,
        order: 0,
        muted: false,
        solo: false,
        volume: 1.0,
        pan: 0.0,
        keyframes: Vec::new(),
        locked: false,
        hidden: false,
        clips: vec![clip],
    };
    let operation = ProjectEditOperation::InsertTrack {
        index: project.document.tracks.len(),
        track: Box::new(track),
    };
    Ok(json!({
        "context":{"detail":"editing_reference","topic":kind},
        "reference":{
            "topic":kind,
            "instructions":[
                "Copy the complete typed example, then change only the requested content, style, and placement. Do not invent top-level clip fields: enabled, start, duration, and source ranges belong inside placement.",
                "Generated text/caption clips use material={kind:'planned'}, capture_intent=null, and text containing TextStyle. They need no video asset or recording and do not block delivery.",
                "Use insert_track to add a new layer without replacing or moving existing video. For an existing text track, read that track then insert_clip at a valid index with the same complete clip shape.",
                "The example contains fresh track/clip UUIDs. Reuse each identity only once; additional clips need distinct valid UUIDs. Example generation does not edit the Project.",
                "Set placement.start on the sequence, keep source_in=0 and source_out=duration at speed=1. For opening/closing overlays, keep them inside the existing sequence duration unless an extension was requested.",
                "Edit text.content, font_family/font_asset_id, font_size, color, background, and align. font_asset_id=null uses a system font; background=null is transparent. transform.x/y offset the centered text in pixels.",
                "This is a current-revision example. If the Project changes before submission, re-read its revision and insertion index. Preserve the nullable fields and empty arrays shown here."
            ],
            "examplePatch":{
                "projectId":project.id, "baseRevision":project.revision,
                "scope":{"kind":"project"}, "summary":if caption {"Add caption layer"} else {"Add title layer"},
                "operations":[operation]
            }
        }
    }))
}

fn transition_reference(project: &Project) -> Value {
    let video = EditorTransition {
        kind: EditorTransitionKind::Fade,
        duration_seconds: 0.25,
    };
    let audio = EditorTransition {
        kind: EditorTransitionKind::ConstantPower,
        duration_seconds: 0.25,
    };
    let example = TimelineClipTransitions {
        video_in: Some(video.clone()),
        video_out: Some(video),
        audio_in: Some(audio.clone()),
        audio_out: Some(audio),
    };
    json!({
        "projectId":project.id, "projectRevision":project.revision,
        "context":{"detail":"editing_reference","topic":"transitions"},
        "reference":{
            "topic":"transitions", "exampleTransitions":example,
            "allowedVideoKinds":[EditorTransitionKind::Fade, EditorTransitionKind::Dip,
                EditorTransitionKind::Flash, EditorTransitionKind::Zoom, EditorTransitionKind::Wipe,
                EditorTransitionKind::Slide, EditorTransitionKind::Blur, EditorTransitionKind::Glitch,
                EditorTransitionKind::Spin],
            "allowedAudioKinds":[EditorTransitionKind::Fade, EditorTransitionKind::ConstantPower],
            "minimumSeconds":0.05, "maximumSeconds":5.0,
            "instructions":[
                "Read the exact existing clip with detail='timeline' and clipIds, copy the full clip, then change only clip.transitions and submit replace_clip. Preserve its material, capture_intent, placement, and all other fields.",
                "Each transition uses kind and duration_seconds, never type or duration. The four slots are video_in, video_out, audio_in, audio_out; use null for slots not requested. The example enables all four only to show their types.",
                "Each duration must be between minimumSeconds and maximumSeconds and strictly shorter than placement.duration. Video in+out durations together must not exceed the clip duration; the same rule applies separately to audio in+out.",
                "Video uses allowedVideoKinds; audio uses only fade or constant_power. Transitions do not change the clip source range or sequence timing."
            ]
        }
    })
}

pub(crate) async fn workspace_assets(
    storage: &vibe_cs_storage::Storage,
    project: &Project,
    input: &Value,
) -> Result<Value, String> {
    let query: AssetContextQuery = serde_json::from_value(input.clone())
        .map_err(|error| format!("invalid asset query: {error}"))?;
    let maximum = query.maximum_assets.unwrap_or(32);
    if !(1..=64).contains(&maximum)
        || query
            .asset_ids
            .as_ref()
            .is_some_and(|ids| ids.is_empty() || ids.len() > 64)
    {
        return Err("maximumAssets and assetIds must contain 1 to 64 entries".to_owned());
    }
    let mut assets = if let Some(ids) = query.asset_ids {
        let mut assets = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(asset) = storage
                .get_asset(id)
                .await
                .map_err(|error| format!("unable to read media asset: {error}"))?
                .filter(|asset| asset.project_id == Some(project.id))
            {
                assets.push(asset);
            }
        }
        assets
    } else {
        storage
            .list_assets(Some(project.id))
            .await
            .map_err(|error| format!("unable to read Project media library: {error}"))?
    };
    let name = query.name.as_deref().map(|name| name.trim().to_lowercase());
    assets.retain(|asset| {
        name.as_ref()
            .is_none_or(|name| asset.name.to_lowercase().contains(name))
            && query
                .kind
                .as_ref()
                .is_none_or(|kind| asset.kind.eq_ignore_ascii_case(kind.trim()))
    });
    assets.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    let matched_count = assets.len();
    let offset = query.offset.unwrap_or(0);
    let items = assets
        .into_iter()
        .skip(offset)
        .take(maximum)
        .map(|asset| {
            json!({
                "id":asset.id, "name":asset.name, "kind":asset.kind,
                "durationSeconds":asset.duration_seconds, "createdAt":asset.created_at,
                "status":match asset.metadata_status {
                    vibe_cs_domain::MediaMetadataStatus::Pending => "pending",
                    vibe_cs_domain::MediaMetadataStatus::Ready => "ready",
                    vibe_cs_domain::MediaMetadataStatus::Unavailable { .. } => "unavailable",
                },
            })
        })
        .collect::<Vec<_>>();
    let next_offset = offset.saturating_add(items.len());
    Ok(json!({
        "projectId":project.id, "projectRevision":project.revision,
        "context":{
            "detail":"assets", "statusMeaning":"stored import/metadata state, not a delivery or file-existence guarantee",
            "next":"Use name/kind or assetIds to narrow results; use nextOffset for the next page. Results are newest first and include assets not placed on the timeline. Read timeline fields before placing media."
        },
        "assets":items, "matchedCount":matched_count,
        "nextOffset":(next_offset < matched_count).then_some(next_offset),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetContextQuery {
    #[serde(rename = "detail")]
    _detail: String,
    name: Option<String>,
    kind: Option<String>,
    asset_ids: Option<Vec<Uuid>>,
    maximum_assets: Option<usize>,
    offset: Option<usize>,
}

fn project_summary(project: &Project) -> Value {
    let (planned, takes, assets, sequences) = project
        .document
        .tracks
        .iter()
        .flat_map(|track| &track.clips)
        .fold((0_usize, 0_usize, 0_usize, 0_usize), |mut counts, clip| {
            match clip.material {
                TimelineClipMaterial::Planned => counts.0 += 1,
                TimelineClipMaterial::Take { .. } => counts.1 += 1,
                TimelineClipMaterial::Asset { .. } => counts.2 += 1,
                TimelineClipMaterial::Sequence { .. } => counts.3 += 1,
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
                        TimelineClipMaterial::Sequence { .. } => "sequence",
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
            "sequences":sequences,
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
            status: Some(AgentTurnStatus::Failed | AgentTurnStatus::Cancelled),
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

    #[test]
    fn capture_window_validation_is_independent_of_used_events_and_respects_camera_identity() {
        use vibe_cs_domain::{
            CaptureIntent, EventKind, Highlight, HighlightKind, HlaeCameraStyle, MatchAnalysis,
            RoundSummary, TimelineEvent,
        };
        let template = editing_reference(&project(), &json!({"topic":"text"})).unwrap();
        let operation: ProjectEditOperation =
            serde_json::from_value(template["reference"]["examplePatch"]["operations"][0].clone())
                .unwrap();
        let ProjectEditOperation::InsertTrack { mut track, .. } = operation else {
            panic!("clip fixture");
        };
        let mut clip = track.clips.remove(0);
        clip.text = None;
        clip.placement.duration = 6.0;
        clip.placement.source_out = 6.0;
        let demo_id = Uuid::new_v4();
        let player_id = "76561198041683378";
        clip.capture_intent = Some(CaptureIntent {
            demo_id,
            highlight_id: Some("clip-15".to_owned()),
            player_id: player_id.to_owned(),
            start_tick: 97_918,
            end_tick: 98_334,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
            camera_style: HlaeCameraStyle::Pov,
            presentation: None,
        });
        let event = |tick, actor: &str, target: &str| TimelineEvent {
            id: format!("kill-{tick}"),
            tick,
            seconds: 0.0,
            kind: EventKind::Kill,
            actor: Some(actor.to_owned()),
            target: Some(target.to_owned()),
            weapon: None,
            headshot: false,
            penetrated: false,
            position: None,
            detail: json!({}),
        };
        let mut analysis = MatchAnalysis {
            demo_id,
            map_name: "de_anubis".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 1562.5,
            verified_total_ticks: Some(100_000),
            players: Vec::new(),
            teams: Vec::new(),
            rounds: vec![
                RoundSummary {
                    number: 1,
                    start_tick: 97_000,
                    end_tick: 98_600,
                    winner: String::new(),
                    reason: String::new(),
                    team_a_score: 1,
                    team_b_score: 0,
                    events: vec![
                        event(98_280, player_id, "opponent"),
                        event(98_308, "opponent", player_id),
                    ],
                },
                RoundSummary {
                    number: 2,
                    start_tick: 99_000,
                    end_tick: 99_500,
                    winner: String::new(),
                    reason: String::new(),
                    team_a_score: 1,
                    team_b_score: 1,
                    events: Vec::new(),
                },
            ],
            highlights: vec![Highlight {
                id: "clip-15".to_owned(),
                player_id: player_id.to_owned(),
                round: 1,
                start_tick: 98_200,
                end_tick: 98_300,
                kind: HighlightKind::OneTap,
                title: "NiKo kill".to_owned(),
                description: String::new(),
                score: 1.0,
                tags: Vec::new(),
                victims: Vec::new(),
            }],
        };
        let report = clip_event_coverage(&clip, &analysis).unwrap();
        assert_eq!(
            report["usedRange"],
            json!({"startTick":97_918,"endTickExclusive":98_302})
        );
        assert_eq!(report["sourceWindowWithinCapture"], true);
        assert_eq!(report["eventCoverage"]["status"], "complete");
        assert_eq!(report["captureValidation"]["status"], "blocked");
        assert_eq!(
            report["captureValidation"]["issues"],
            json!(["ordinary_pov_reaches_player_death"])
        );
        assert_eq!(
            report["captureValidation"]["limits"]["playerDeathTick"],
            98_308
        );

        clip.capture_intent.as_mut().unwrap().end_tick = 98_308;
        assert_eq!(
            clip_event_coverage(&clip, &analysis).unwrap()["captureValidation"]["status"],
            "blocked"
        );
        clip.capture_intent.as_mut().unwrap().end_tick = 98_306;
        assert_eq!(
            clip_event_coverage(&clip, &analysis).unwrap()["captureValidation"]["status"],
            "within_known_bounds"
        );

        let capture = clip.capture_intent.as_mut().unwrap();
        capture.end_tick = 98_334;
        capture.victim_pov = true;
        let victim = clip_event_coverage(&clip, &analysis).unwrap();
        assert_eq!(victim["captureValidation"]["status"], "requires_preflight");
        assert_eq!(victim["captureValidation"]["issues"], json!([]));
        assert_eq!(
            victim["captureValidation"]["unchecked"],
            json!(["victim_camera_identity_and_death"])
        );
        assert!(victim["captureValidation"]["limits"]["playerDeathTick"].is_null());

        let capture = clip.capture_intent.as_mut().unwrap();
        capture.victim_pov = false;
        capture.end_tick = 100_001;
        let eof = clip_event_coverage(&clip, &analysis).unwrap();
        assert!(
            eof["captureValidation"]["issues"]
                .as_array()
                .unwrap()
                .contains(&json!("after_verified_demo_end"))
        );
        let capture = clip.capture_intent.as_mut().unwrap();
        capture.start_tick = 99_100;
        capture.end_tick = 99_490;
        analysis.verified_total_ticks = None;
        assert_eq!(
            clip_event_coverage(&clip, &analysis).unwrap()["captureValidation"]["status"],
            "requires_preflight"
        );
    }

    #[test]
    fn capture_bounds_come_from_matching_rounds_and_player_death_events_before_filtering() {
        use vibe_cs_domain::{
            EventKind, Highlight, HighlightKind, MatchAnalysis, PlayerStats, RoundSummary,
            TimelineEvent,
        };
        let event = |tick, kind, target: &str| TimelineEvent {
            id: format!("event-{tick}"),
            tick,
            seconds: f64::from(u32::try_from(tick).expect("fixture tick")) / 64.0,
            kind,
            actor: Some("opponent".to_owned()),
            target: Some(target.to_owned()),
            weapon: None,
            headshot: false,
            penetrated: false,
            position: None,
            detail: json!({}),
        };
        let highlight = |id: &str, player: &str, round, start_tick, score| Highlight {
            id: id.to_owned(),
            player_id: player.to_owned(),
            round,
            start_tick,
            end_tick: start_tick + 50,
            kind: HighlightKind::OneTap,
            title: id.to_owned(),
            description: String::new(),
            score,
            tags: Vec::new(),
            victims: Vec::new(),
        };
        let analysis = MatchAnalysis {
            demo_id: Uuid::new_v4(),
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 30.0,
            verified_total_ticks: Some(1920),
            teams: Vec::new(),
            players: vec![PlayerStats {
                steam_id: "niko".to_owned(),
                spectator_slot: Some(1),
                name: "NiKo".to_owned(),
                team: "team".to_owned(),
                kills: 1,
                deaths: 1,
                assists: 0,
                headshots: 1,
                damage: 100,
                adr: 50.0,
                kill_death_ratio: 1.0,
                score: 0,
            }],
            rounds: vec![
                RoundSummary {
                    number: 1,
                    start_tick: 100,
                    end_tick: 900,
                    winner: String::new(),
                    reason: String::new(),
                    team_a_score: 1,
                    team_b_score: 0,
                    events: vec![
                        event(300, EventKind::Damage, "niko"),
                        event(400, EventKind::Kill, "other"),
                        event(550, EventKind::Kill, "niko"),
                        event(500, EventKind::Kill, "niko"),
                    ],
                },
                RoundSummary {
                    number: 2,
                    start_tick: 1000,
                    end_tick: 1800,
                    winner: String::new(),
                    reason: String::new(),
                    team_a_score: 1,
                    team_b_score: 1,
                    events: vec![event(1200, EventKind::Kill, "other")],
                },
            ],
            highlights: vec![
                highlight("first", "niko", 1, 350, 0.8),
                highlight("second", "niko", 2, 1100, 0.9),
                highlight("missing", "niko", 99, 1850, 0.1),
                highlight("other", "other", 1, 400, 1.0),
            ],
        };
        let evidence = demo_evidence_with_capture_bounds(&analysis).expect("analysis evidence");
        assert_eq!(
            evidence["highlights"][0]["captureBounds"],
            json!({
                "roundStartTick":100, "roundEndTick":900, "playerDeathTick":500,
                "recordableEndTick":999,"nextRoundStartTick":1000,"demoEndTick":1920
            })
        );
        assert_eq!(
            evidence["highlights"][2]["captureBounds"],
            json!({
                "roundStartTick":null, "roundEndTick":null, "playerDeathTick":null,
                "recordableEndTick":null,"nextRoundStartTick":null,"demoEndTick":null
            })
        );
        let selected = vibe_cs_agent::query_demo_evidence(
            &evidence,
            &json!({"playerName":"NiKo","kinds":["one_tap"],"maximumHighlights":1}),
        )
        .expect("targeted evidence");
        assert_eq!(selected["highlights"].as_array().unwrap().len(), 1);
        assert_eq!(selected["highlights"][0]["id"], "second");
        assert_eq!(
            selected["highlights"][0]["captureBounds"],
            json!({
                "roundStartTick":1000, "roundEndTick":1800, "playerDeathTick":null,
                "recordableEndTick":1920,"nextRoundStartTick":null,"demoEndTick":1920
            })
        );
        assert!(selected["rounds"].as_array().unwrap().is_empty());
        assert!(selected["evidence_query"]["truncated"].as_bool().unwrap());
    }

    #[tokio::test]
    async fn asset_discovery_reads_unreferenced_owned_media_and_excludes_other_projects() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let mut current = project();
        current.document.duration_seconds = 0.0;
        current.revision = 1;
        let mut other = current.clone();
        other.id = Uuid::new_v4();
        storage
            .create_project(current.clone())
            .await
            .expect("project");
        storage
            .create_project(other.clone())
            .await
            .expect("other project");
        let audio_id = Uuid::new_v4();
        let video_id = Uuid::new_v4();
        let foreign_id = Uuid::new_v4();
        for (id, project_id, name, kind) in [
            (audio_id, current.id, "Late Night Music", "audio"),
            (video_id, current.id, "Recorded video", "video"),
            (foreign_id, other.id, "Other project music", "audio"),
        ] {
            storage
                .put_asset(vibe_cs_domain::MediaAsset {
                    id,
                    project_id: Some(project_id),
                    path: "unused-local-fixture".to_owned(),
                    name: name.to_owned(),
                    kind: kind.to_owned(),
                    duration_seconds: Some(20.0),
                    width: None,
                    height: None,
                    file_size: 100,
                    has_audio: true,
                    proxy_path: None,
                    proxy_status: vibe_cs_domain::MediaProxyStatus::NotRequested,
                    waveform: Some(vec![0.5; 10_000]),
                    metadata_status: vibe_cs_domain::MediaMetadataStatus::Ready,
                    markers: Vec::new(),
                    created_at: Utc::now(),
                })
                .await
                .expect("import asset");
        }
        assert!(
            current
                .document
                .tracks
                .iter()
                .all(|track| track.clips.is_empty())
        );
        let found = workspace_assets(
            &storage,
            &current,
            &json!({
                "detail":"assets", "kind":"audio", "name":"NIGHT"
            }),
        )
        .await
        .expect("discover imported music");
        assert_eq!(found["assets"][0]["id"], audio_id.to_string());
        assert_eq!(found["assets"][0]["durationSeconds"], 20.0);
        assert_eq!(found["matchedCount"], 1);
        for field in ["waveform", "markers", "path", "proxy_path"] {
            assert!(found["assets"][0].get(field).is_none());
        }
        let exact = workspace_assets(
            &storage,
            &current,
            &json!({
                "detail":"assets", "assetIds":[audio_id, foreign_id]
            }),
        )
        .await
        .expect("exact owned ids");
        assert_eq!(exact["assets"].as_array().unwrap().len(), 1);
        assert_eq!(exact["assets"][0]["id"], audio_id.to_string());
        let page = workspace_assets(
            &storage,
            &current,
            &json!({
                "detail":"assets", "maximumAssets":1
            }),
        )
        .await
        .expect("first page");
        assert_eq!(page["matchedCount"], 2);
        assert_eq!(page["assets"].as_array().unwrap().len(), 1);
        assert_eq!(page["nextOffset"], 1);
        let next = workspace_assets(
            &storage,
            &current,
            &json!({
                "detail":"assets", "maximumAssets":1, "offset":1
            }),
        )
        .await
        .expect("second page");
        assert!(next["nextOffset"].is_null());
        assert_ne!(page["assets"][0]["id"], next["assets"][0]["id"]);
    }

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
    fn cancelled_turn_retains_completed_tool_evidence_for_continuation() {
        let active_request = Uuid::new_v4();
        let session = AgentSession {
            id: Uuid::new_v4(),
            title: "Stopped editing".to_owned(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            entries: vec![
                user("调整开场并整理结尾"),
                assistant(
                    Uuid::new_v4(),
                    AgentTurnStatus::Cancelled,
                    "开场已经调整。",
                    vec![AgentToolCall {
                        id: "completed-opening-edit".to_owned(),
                        name: "apply_project_patch".to_owned(),
                        input: json!({"summary":"调整开场"}),
                        output: json!({"revision":8}),
                        status: AgentToolCallStatus::Completed,
                    }],
                ),
                user("继续整理结尾"),
                assistant(active_request, AgentTurnStatus::Streaming, "", Vec::new()),
            ],
        };

        let history = model_history(&session, active_request).expect("model history");
        assert_eq!(history.len(), 2);
        let evidence: Value = serde_json::from_str(&history[1].content).expect("tool evidence");
        assert_eq!(evidence["tool_calls"][0]["id"], "completed-opening-edit");
        assert_eq!(evidence["tool_calls"][0]["result"]["projectRevision"], 8);
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
    fn transition_reference_deserializes_and_applies_to_a_recorded_clip() {
        let mut project = project();
        let text_reference = editing_reference(&project, &json!({"topic":"text"})).unwrap();
        let operation: ProjectEditOperation = serde_json::from_value(
            text_reference["reference"]["examplePatch"]["operations"][0].clone(),
        )
        .unwrap();
        let ProjectEditOperation::InsertTrack { mut track, .. } = operation else {
            panic!("text template");
        };
        let mut clip = track.clips.remove(0);
        clip.text = None;
        clip.material = TimelineClipMaterial::Asset {
            asset_id: Uuid::new_v4(),
            media_duration_seconds: 3.0,
        };
        project.document.tracks[0].clips.push(clip.clone());
        project.document.duration_seconds = 3.0;
        project.validate().expect("recorded source");
        let reference = workspace_context(
            &json!({}),
            &project,
            &json!({
                "detail":"editing_reference", "topic":"transitions"
            }),
        )
        .expect("transition reference");
        clip.transitions =
            serde_json::from_value(reference["reference"]["exampleTransitions"].clone())
                .expect("real transition fields");
        let patch = vibe_cs_domain::ProjectPatch {
            project_id: project.id,
            base_revision: project.revision,
            scope: vibe_cs_domain::ProjectPatchScope::Project,
            author: vibe_cs_domain::ProjectChangeAuthor::Human,
            reverts_change_group_id: None,
            summary: "Add transitions".to_owned(),
            operations: vec![ProjectEditOperation::ReplaceClip {
                clip_id: clip.id,
                clip: Box::new(clip.clone()),
            }],
        };
        project
            .apply_patch(patch, Uuid::new_v4(), Utc::now())
            .expect("valid transition patch");
        assert_eq!(project.document.tracks[0].clips[0], clip);
        assert!(project.unresolved_delivery_clips().unwrap().is_empty());
    }

    #[test]
    fn generated_text_references_apply_as_real_patches_without_changing_existing_tracks() {
        for topic in ["text", "caption"] {
            let mut project = project();
            let reference = workspace_context(
                &json!({"projectId":project.id}),
                &project,
                &json!({"detail":"editing_reference","topic":topic}),
            )
            .expect("text creation reference");
            let example = &reference["reference"]["examplePatch"];
            let operations: Vec<vibe_cs_domain::ProjectEditOperation> =
                serde_json::from_value(example["operations"].clone())
                    .expect("canonical operations");
            // Seed a real footage clip from the fully typed shape, then ensure
            // inserting generated text leaves that existing material untouched.
            let vibe_cs_domain::ProjectEditOperation::InsertTrack { track, .. } = &operations[0]
            else {
                panic!("reference must insert its own text track");
            };
            let mut footage = track.clips[0].clone();
            footage.id = Uuid::new_v4();
            footage.name = "Existing video".to_owned();
            footage.text = None;
            footage.material = TimelineClipMaterial::Asset {
                asset_id: Uuid::new_v4(),
                media_duration_seconds: 20.0,
            };
            footage.placement.duration = 20.0;
            footage.placement.source_out = 20.0;
            project.document.tracks[0].clips.push(footage);
            project.document.duration_seconds = 20.0;
            project.validate().expect("existing footage project");
            let original_tracks = project.document.tracks.clone();
            let patch: vibe_cs_domain::ProjectPatch = serde_json::from_value(json!({
                "project_id":example["projectId"], "base_revision":example["baseRevision"],
                "scope":example["scope"], "author":{"kind":"agent","session_id":Uuid::new_v4(),"turn_id":Uuid::new_v4()},
                "reverts_change_group_id":null, "summary":example["summary"], "operations":example["operations"]
            })).expect("canonical Project Patch");
            project
                .apply_patch(patch, Uuid::new_v4(), Utc::now())
                .expect("valid text insertion");
            assert_eq!(
                &project.document.tracks[..original_tracks.len()],
                original_tracks.as_slice()
            );
            assert!((project.document.duration_seconds - 20.0).abs() < f64::EPSILON);
            let inserted = project.document.tracks.last().unwrap();
            assert_eq!(serde_json::to_value(inserted.kind).unwrap(), topic);
            assert!(inserted.clips[0].text.is_some());
            assert!(
                project
                    .unresolved_delivery_clips()
                    .expect("delivery gate")
                    .is_empty()
            );
        }
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
