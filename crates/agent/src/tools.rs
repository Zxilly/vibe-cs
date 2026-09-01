use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use rig_agent::tool::DynamicTool;
use rig_core::tool::{ToolExecutionError, ToolOutput};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use ts_rs::TS;

use crate::{AgentContext, AgentMode, AgentToolHost};

const MAXIMUM_CAPTURED_TOOL_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CapturedToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub output: Value,
    pub status: CapturedToolCallStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CapturedToolCallStatus {
    Completed,
    Failed,
    AwaitingConfirmation,
}

#[derive(Debug, Clone)]
pub(crate) enum ToolLifecycleEvent {
    Started {
        id: String,
        name: String,
        input: Value,
    },
    Finished(CapturedToolCall),
}

#[derive(Debug, Default)]
struct Captures {
    tool_calls: Vec<CapturedToolCall>,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolState {
    context: Arc<AgentContext>,
    tool_host: Option<Arc<dyn AgentToolHost>>,
    captures: Arc<Mutex<Captures>>,
    request_id: Arc<str>,
    sequence: Arc<AtomicU64>,
    lifecycle: mpsc::UnboundedSender<ToolLifecycleEvent>,
}

impl ToolState {
    pub(crate) fn new(
        context: AgentContext,
        tool_host: Option<Arc<dyn AgentToolHost>>,
        request_id: &str,
    ) -> (Self, mpsc::UnboundedReceiver<ToolLifecycleEvent>) {
        let (lifecycle, receiver) = mpsc::unbounded_channel();
        (
            Self {
                context: Arc::new(context),
                tool_host,
                captures: Arc::new(Mutex::new(Captures::default())),
                request_id: Arc::from(request_id),
                sequence: Arc::new(AtomicU64::new(0)),
                lifecycle,
            },
            receiver,
        )
    }

    pub(crate) async fn snapshot(&self) -> Vec<CapturedToolCall> {
        self.captures.lock().await.tool_calls.clone()
    }

    async fn execute(
        &self,
        kind: ToolKind,
        name: &str,
        input: Value,
    ) -> Result<Value, ToolExecutionError> {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let id = format!("{}:tool:{sequence}", self.request_id);
        let _ = self.lifecycle.send(ToolLifecycleEvent::Started {
            id: id.clone(),
            name: name.to_owned(),
            input: input.clone(),
        });
        let result = async {
            let output = match kind {
                ToolKind::ReadWorkspace => {
                    if let Some(host) = self.tool_host.as_ref() {
                        host.read_workspace(&input)
                            .await
                            .map_err(ToolExecutionError::other)?
                    } else {
                        json!({
                            "workspace": self.context.workspace,
                            "project": self.context.project,
                        })
                    }
                }
                ToolKind::ReadDemoEvidence => {
                    let analysis = if let Some(host) = self.tool_host.as_ref() {
                        host.read_demo_evidence(&input)
                            .await
                            .map_err(ToolExecutionError::other)?
                    } else {
                        query_demo_evidence(&self.context.analysis, &input)
                            .map_err(ToolExecutionError::invalid_args)?
                    };
                    json!({
                        "demo": self.context.demo,
                        "analysis": analysis,
                        "mapContext": self.context.map_context,
                    })
                }
                ToolKind::ReadCinematicContext => {
                    let host = self.host()?;
                    let ids = string_array(&input, "highlightIds", 64)?;
                    host.read_cinematic_context(&ids)
                        .await
                        .map_err(ToolExecutionError::other)?
                }
                ToolKind::ReadProjectDelivery => self
                    .host()?
                    .read_project_delivery(&input)
                    .await
                    .map_err(ToolExecutionError::other)?,
                ToolKind::ApplyProjectPatch => self
                    .host()?
                    .apply_project_patch(input.clone())
                    .await
                    .map_err(ToolExecutionError::other)?,
                ToolKind::ReplaceStoryTimeline => self
                    .host()?
                    .replace_story_timeline(input.clone())
                    .await
                    .map_err(ToolExecutionError::other)?,
                ToolKind::RequestRecording => confirmation_request("recording", &input)?,
                ToolKind::RequestExport => confirmation_request("export", &input)?,
            };
            Ok::<_, ToolExecutionError>(output)
        }
        .await;
        let (output, status) = match result {
            Ok(output) => {
                let status = if output.get("status").and_then(Value::as_str)
                    == Some("requires_human_confirmation")
                {
                    CapturedToolCallStatus::AwaitingConfirmation
                } else {
                    CapturedToolCallStatus::Completed
                };
                (output, status)
            }
            Err(error) => {
                let call = CapturedToolCall {
                    id,
                    name: name.to_owned(),
                    input,
                    output: bounded_output(&json!({ "error": error.to_string() })),
                    status: CapturedToolCallStatus::Failed,
                };
                self.captures.lock().await.tool_calls.push(call.clone());
                let _ = self.lifecycle.send(ToolLifecycleEvent::Finished(call));
                return Err(error);
            }
        };
        let call = CapturedToolCall {
            id,
            name: name.to_owned(),
            input,
            output: bounded_output(&output),
            status,
        };
        self.captures.lock().await.tool_calls.push(call.clone());
        let _ = self.lifecycle.send(ToolLifecycleEvent::Finished(call));
        Ok(output)
    }

    fn host(&self) -> Result<&Arc<dyn AgentToolHost>, ToolExecutionError> {
        self.tool_host
            .as_ref()
            .ok_or_else(|| ToolExecutionError::other("project tool host is unavailable"))
    }
}

#[derive(Debug, Clone, Copy)]
enum ToolKind {
    ReadWorkspace,
    ReadDemoEvidence,
    ReadCinematicContext,
    ReadProjectDelivery,
    ApplyProjectPatch,
    ReplaceStoryTimeline,
    RequestRecording,
    RequestExport,
}

#[derive(Debug)]
struct ToolDefinition {
    kind: ToolKind,
    name: &'static str,
    modes: &'static [AgentMode],
    description: &'static str,
    parameters: Value,
}

const ALL_MODES: &[AgentMode] = &[AgentMode::Guide, AgentMode::Edit, AgentMode::Hlae];
const EDIT_MODES: &[AgentMode] = &[AgentMode::Edit, AgentMode::Hlae];

pub(crate) fn create_tools(state: &ToolState, mode: AgentMode) -> Vec<DynamicTool> {
    tool_catalog()
        .into_iter()
        .filter(|tool| tool.modes.contains(&mode))
        .map(|tool| {
            let state = state.clone();
            DynamicTool::new(
                tool.name,
                tool.description,
                tool.parameters,
                move |_context, input| {
                    let state = state.clone();
                    Box::pin(async move {
                        state
                            .execute(tool.kind, tool.name, input)
                            .await
                            .map(ToolOutput::json)
                    })
                },
            )
        })
        .collect()
}

fn tool_catalog() -> Vec<ToolDefinition> {
    vec![
        definition(
            ToolKind::ReadWorkspace,
            "read_workspace",
            ALL_MODES,
            "Read live canonical Project context with progressive disclosure. Omit detail or use summary for status, counts, and marker-only refreshes; markers are exact when markersTruncated=false. Use detail='timeline' only for placement, track, clip, effect, or setting fields. If an exact clipId is known, clipIds is required and its enclosing track must not be read. Use trackIds only for an explicitly whole-track scope, and omit selectors only for a deliberate whole-Project operation. Returns the exact current revision in both formats.",
            object_schema(
                json!({
                    "detail":{"type":"string","enum":["summary","timeline"],"default":"summary"},
                    "trackIds":{"type":"array","items":uuid_schema(),"minItems":1,"maxItems":16},
                    "clipIds":{"type":"array","items":uuid_schema(),"minItems":1,"maxItems":64}
                }),
                &[],
            ),
        ),
        definition(
            ToolKind::ReadDemoEvidence,
            "read_demo_evidence",
            ALL_MODES,
            "Query bounded verified Demo evidence supplied by the current workspace. For player-focused work, pass playerName or playerId; optionally narrow demoIds and kinds. The result returns stable highlight/demo IDs and at most maximumHighlights rows instead of dumping the whole series.",
            object_schema(
                json!({
                    "playerId":{"type":"string","minLength":1,"maxLength":64},
                    "playerName":{"type":"string","minLength":1,"maxLength":128},
                    "demoIds":{"type":"array","items":uuid_schema(),"maxItems":16},
                    "kinds":string_array_schema(32),
                    "maximumHighlights":{"type":"integer","minimum":1,"maximum":128}
                }),
                &[],
            ),
        ),
        definition(
            ToolKind::ReadCinematicContext,
            "read_cinematic_context",
            EDIT_MODES,
            "Read bounded selected-round replay evidence and camera feasibility for explicit highlight IDs. Non-POV camera styles require at least four target-player spatial samples inside the requested round-bounded capture handles.",
            object_schema(
                json!({"highlightIds": string_array_schema(64)}),
                &["highlightIds"],
            ),
        ),
        definition(
            ToolKind::ReadProjectDelivery,
            "read_project_delivery",
            ALL_MODES,
            "Read the authoritative Project Delivery Gate and latest export artifact, including its source Project revision, job status, file availability, size, duration, resolution, frame rate, and codecs when probing succeeds. matchesCurrentRevision is true only when that artifact was rendered from the current Project Head. Call this after recording or export completion before claiming the Project is deliverable.",
            object_schema(json!({"projectId":uuid_schema()}), &["projectId"]),
        ),
        definition(
            ToolKind::ApplyProjectPatch,
            "apply_project_patch",
            EDIT_MODES,
            "Apply a small revision-bound edit directly to the canonical Project. The host validates the Project Patch, holds the Agent edit lease, writes one undoable Change Group, and returns the new revision.",
            project_patch_schema(),
        ),
        definition(
            ToolKind::ReplaceStoryTimeline,
            "replace_story_timeline",
            EDIT_MODES,
            "Atomically replan the entire story track. This is an Agent-only high-level operation; the host allocates clip identities, canonicalizes verified highlight IDs, rejects non-POV cameras without four in-range spatial samples, validates the staged timeline, and commits one undoable Change Group.",
            replace_story_schema(),
        ),
        definition(
            ToolKind::RequestRecording,
            "request_project_recording",
            EDIT_MODES,
            "Prepare a recording request for unrecorded or stale clips. This never starts recording; the human must explicitly confirm it in the UI.",
            execution_request_schema("clipIds"),
        ),
        definition(
            ToolKind::RequestExport,
            "request_project_export",
            EDIT_MODES,
            "Prepare a final export request. This never starts export; the human must explicitly confirm it in the UI and the Delivery Gate must pass.",
            execution_request_schema("clipIds"),
        ),
    ]
}

fn definition(
    kind: ToolKind,
    name: &'static str,
    modes: &'static [AgentMode],
    description: &'static str,
    parameters: Value,
) -> ToolDefinition {
    ToolDefinition {
        kind,
        name,
        modes,
        description,
        parameters,
    }
}

fn project_patch_schema() -> Value {
    object_schema(
        json!({
            "projectId": uuid_schema(),
            "baseRevision": {"type":"integer","minimum":1},
            "summary": {"type":"string","minLength":1,"maxLength":400},
            "scope": project_patch_scope_schema(),
            "operations": {
                "type":"array",
                "minItems":1,
                "maxItems":128,
                "items":project_edit_operation_schema()
            }
        }),
        &[
            "projectId",
            "baseRevision",
            "summary",
            "scope",
            "operations",
        ],
    )
}

fn project_patch_scope_schema() -> Value {
    json!({"oneOf":[
        object_schema(json!({"kind":{"const":"project"}}), &["kind"]),
        object_schema(
            json!({"kind":{"const":"track"},"track_id":uuid_schema()}),
            &["kind","track_id"],
        ),
        object_schema(
            json!({
                "kind":{"const":"time_range"},
                "start":{"type":"number","minimum":0},
                "end":{"type":"number","exclusiveMinimum":0}
            }),
            &["kind","start","end"],
        )
    ]})
}

fn project_edit_operation_schema() -> Value {
    let marker = object_schema(
        json!({
            "id":uuid_schema(),
            "time":{"type":"number","minimum":0},
            "label":{"type":"string","minLength":1,"maxLength":200},
            "color":{"type":"string","minLength":1,"maxLength":64}
        }),
        &["id", "time", "label", "color"],
    );
    json!({"oneOf":[
        object_schema(
            json!({"op":{"const":"rename_project"},"name":{"type":"string","minLength":1,"maxLength":200}}),
            &["op","name"],
        ),
        object_schema(
            json!({"op":{"const":"replace_settings"},"settings":{"type":"object"}}),
            &["op","settings"],
        ),
        object_schema(
            json!({"op":{"const":"replace_markers"},"markers":{"type":"array","maxItems":1024,"items":marker}}),
            &["op","markers"],
        ),
        object_schema(
            json!({
                "op":{"const":"insert_track"},
                "index":{"type":"integer","minimum":0},
                "track":{"type":"object"}
            }),
            &["op","index","track"],
        ),
        object_schema(
            json!({"op":{"const":"remove_track"},"track_id":uuid_schema()}),
            &["op","track_id"],
        ),
        object_schema(
            json!({"op":{"const":"replace_track"},"track_id":uuid_schema(),"track":{"type":"object"}}),
            &["op","track_id","track"],
        ),
        object_schema(
            json!({
                "op":{"const":"reorder_tracks"},
                "track_ids":{"type":"array","items":uuid_schema(),"maxItems":128}
            }),
            &["op","track_ids"],
        ),
        object_schema(
            json!({
                "op":{"const":"insert_clip"},
                "track_id":uuid_schema(),
                "index":{"type":"integer","minimum":0},
                "clip":{"type":"object"}
            }),
            &["op","track_id","index","clip"],
        ),
        object_schema(
            json!({"op":{"const":"remove_clip"},"clip_id":uuid_schema()}),
            &["op","clip_id"],
        ),
        object_schema(
            json!({"op":{"const":"replace_clip"},"clip_id":uuid_schema(),"clip":{"type":"object"}}),
            &["op","clip_id","clip"],
        ),
        object_schema(
            json!({
                "op":{"const":"move_clip"},
                "clip_id":uuid_schema(),
                "to_track_id":uuid_schema(),
                "index":{"type":"integer","minimum":0}
            }),
            &["op","clip_id","to_track_id","index"],
        ),
        object_schema(
            json!({
                "op":{"const":"replace_track_clips"},
                "track_id":uuid_schema(),
                "clips":{"type":"array","items":{"type":"object"},"maxItems":1024}
            }),
            &["op","track_id","clips"],
        )
    ]})
}

fn replace_story_schema() -> Value {
    object_schema(
        json!({
            "projectId": uuid_schema(),
            "baseRevision": {"type":"integer","minimum":1},
            "summary": {"type":"string","minLength":1,"maxLength":400},
            "clips": {
                "type":"array",
                "minItems":1,
                "maxItems":64,
                "items": {
                    "type":"object",
                    "additionalProperties":false,
                    "properties":{
                        "name":{"type":"string","minLength":1,"maxLength":200},
                        "demoId":uuid_schema(),
                        "highlightId":{"type":["string","null"],"maxLength":200},
                        "playerId":{"type":"string","pattern":"^[0-9]{17}$"},
                        "startTick":{"type":"integer","minimum":0},
                        "endTick":{"type":"integer","minimum":1},
                        "preRollSeconds":{"type":"number","minimum":0,"maximum":30},
                        "postRollSeconds":{"type":"number","minimum":0,"maximum":30},
                        "durationSeconds":{"type":"number","exclusiveMinimum":0,"maximum":120},
                        "cameraStyle":{"type":"string","enum":["pov","orbit","dolly","static","tracking","crane","flyby"]},
                        "rationale":{"type":"string","maxLength":500}
                    },
                    "required":["name","demoId","playerId","startTick","endTick","durationSeconds","cameraStyle"]
                }
            }
        }),
        &["projectId", "baseRevision", "summary", "clips"],
    )
}

fn execution_request_schema(ids_key: &str) -> Value {
    object_schema(
        json!({
            "projectId": uuid_schema(),
            "baseRevision":{"type":"integer","minimum":1},
            ids_key: string_array_schema(64),
            "summary":{"type":"string","minLength":1,"maxLength":400}
        }),
        &["projectId", "baseRevision", "summary"],
    )
}

fn confirmation_request(kind: &str, input: &Value) -> Result<Value, ToolExecutionError> {
    let project_id = input
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolExecutionError::invalid_args("projectId is required"))?;
    let revision = input
        .get("baseRevision")
        .and_then(Value::as_u64)
        .ok_or_else(|| ToolExecutionError::invalid_args("baseRevision is required"))?;
    Ok(json!({
        "status":"requires_human_confirmation",
        "action":kind,
        "projectId":project_id,
        "baseRevision":revision,
        "request":input,
    }))
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "tool schemas are constructed inline and moved into the returned JSON value"
)]
fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type":"object",
        "additionalProperties":false,
        "properties":properties,
        "required":required,
    })
}

fn string_array_schema(maximum: usize) -> Value {
    json!({
        "type":"array",
        "items":{"type":"string","minLength":1,"maxLength":200},
        "maxItems":maximum,
    })
}

fn uuid_schema() -> Value {
    json!({"type":"string","format":"uuid"})
}

fn string_array(
    input: &Value,
    key: &str,
    maximum: usize,
) -> Result<Vec<String>, ToolExecutionError> {
    let values = input
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| ToolExecutionError::invalid_args(format!("{key} must be an array")))?;
    if values.is_empty() || values.len() > maximum {
        return Err(ToolExecutionError::invalid_args(format!(
            "{key} must contain 1 to {maximum} values"
        )));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 200)
                .map(ToOwned::to_owned)
                .ok_or_else(|| ToolExecutionError::invalid_args(format!("invalid {key} value")))
        })
        .collect()
}

fn optional_string(input: &Value, key: &str, maximum: usize) -> Result<Option<String>, String> {
    let Some(value) = input.get(key) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= maximum)
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| format!("invalid {key} value"))
}

fn optional_string_array(
    input: &Value,
    key: &str,
    maximum: usize,
) -> Result<Option<Vec<String>>, String> {
    let Some(values) = input.get(key).and_then(Value::as_array) else {
        return if input.get(key).is_none() {
            Ok(None)
        } else {
            Err(format!("{key} must be an array"))
        };
    };
    if values.is_empty() || values.len() > maximum {
        return Err(format!("{key} must contain 1 to {maximum} values"));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 200)
                .map(ToOwned::to_owned)
                .ok_or_else(|| format!("invalid {key} value"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// Filter one authoritative Demo or series analysis through the public Agent evidence vocabulary.
///
/// # Errors
///
/// Returns an error when the analysis is unavailable, a query field is malformed, both player
/// selectors are supplied, or the requested player is absent from the current series.
pub fn query_demo_evidence(analysis: &Value, input: &Value) -> Result<Value, String> {
    let source = analysis
        .as_object()
        .ok_or_else(|| "Demo analysis is unavailable".to_owned())?;
    let player_id = optional_string(input, "playerId", 64)?;
    let player_name = optional_string(input, "playerName", 128)?;
    if player_id.is_some() && player_name.is_some() {
        return Err("provide playerId or playerName, not both".to_owned());
    }
    let requested_demo_ids = optional_string_array(input, "demoIds", 16)?
        .map(|values| values.into_iter().collect::<std::collections::HashSet<_>>());
    let requested_kinds = optional_string_array(input, "kinds", 32)?.map(|values| {
        values
            .into_iter()
            .map(|value| value.to_ascii_lowercase())
            .collect::<std::collections::HashSet<_>>()
    });
    let maximum = input
        .get("maximumHighlights")
        .map_or(Ok(64_usize), |value| {
            value
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .filter(|value| (1..=128).contains(value))
                .ok_or_else(|| "maximumHighlights must be between 1 and 128".to_owned())
        })?;

    let players = source
        .get("players")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let matched_player_ids = if let Some(id) = player_id.as_ref() {
        players
            .iter()
            .filter(|player| player.get("steam_id").and_then(Value::as_str) == Some(id.as_str()))
            .filter_map(|player| {
                player
                    .get("steam_id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .collect::<Vec<_>>()
    } else if let Some(name) = player_name.as_ref() {
        players
            .iter()
            .filter(|player| {
                player
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|candidate| candidate.eq_ignore_ascii_case(name))
            })
            .filter_map(|player| {
                player
                    .get("steam_id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    if (player_id.is_some() || player_name.is_some()) && matched_player_ids.is_empty() {
        return Err("requested player is not present in this Demo series".to_owned());
    }
    let matched_player_ids = matched_player_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();

    let mut highlights = source
        .get("highlights")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|highlight| {
            (matched_player_ids.is_empty()
                || highlight
                    .get("player_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| matched_player_ids.contains(id)))
                && requested_demo_ids.as_ref().is_none_or(|ids| {
                    highlight
                        .get("demo_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| ids.contains(id))
                })
                && requested_kinds.as_ref().is_none_or(|kinds| {
                    highlight
                        .get("kind")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| kinds.contains(&kind.to_ascii_lowercase()))
                })
        })
        .cloned()
        .collect::<Vec<_>>();
    highlights.sort_by(|left, right| {
        right
            .get("score")
            .and_then(Value::as_f64)
            .unwrap_or_default()
            .total_cmp(
                &left
                    .get("score")
                    .and_then(Value::as_f64)
                    .unwrap_or_default(),
            )
            .then_with(|| {
                left.get("demo_id")
                    .and_then(Value::as_str)
                    .cmp(&right.get("demo_id").and_then(Value::as_str))
            })
            .then_with(|| {
                left.get("start_tick")
                    .and_then(Value::as_u64)
                    .cmp(&right.get("start_tick").and_then(Value::as_u64))
            })
    });
    let matched_highlight_count = highlights.len();
    highlights.truncate(maximum);
    let selected_players = if matched_player_ids.is_empty() {
        players
    } else {
        players
            .into_iter()
            .filter(|player| {
                player
                    .get("steam_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| matched_player_ids.contains(id))
            })
            .collect()
    };
    let mut result = source.clone();
    result.insert("players".to_owned(), Value::Array(selected_players));
    result.insert("highlights".to_owned(), Value::Array(highlights));
    result.insert("rounds".to_owned(), Value::Array(Vec::new()));
    result.insert("insights".to_owned(), Value::Null);
    result.insert(
        "evidence_query".to_owned(),
        json!({
            "player_id": player_id,
            "player_name": player_name,
            "demo_ids": requested_demo_ids,
            "kinds": requested_kinds,
            "matched_highlight_count": matched_highlight_count,
            "returned_highlight_count": result.get("highlights").and_then(Value::as_array).map_or(0, Vec::len),
            "truncated": matched_highlight_count > maximum,
        }),
    );
    Ok(Value::Object(result))
}

fn bounded_output(output: &Value) -> Value {
    if serde_json::to_vec(output)
        .is_ok_and(|bytes| bytes.len() <= MAXIMUM_CAPTURED_TOOL_OUTPUT_BYTES)
    {
        return output.clone();
    }
    json!({"status":"completed","detail":"tool output omitted from transcript because it exceeded 64 KiB"})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct DeliveryHost;

    #[async_trait::async_trait]
    impl AgentToolHost for DeliveryHost {
        async fn read_workspace(&self, _input: &Value) -> Result<Value, String> {
            Ok(json!({
                "workspace":{"projectId":"00000000-0000-4000-8000-000000000001"},
                "project":{"revision":9},
            }))
        }

        async fn read_cinematic_context(&self, _highlight_ids: &[String]) -> Result<Value, String> {
            Ok(json!({"scenes":[]}))
        }

        async fn read_project_delivery(&self, input: &Value) -> Result<Value, String> {
            Ok(json!({
                "projectId":input["projectId"],
                "deliveryGate":{"ready":true},
                "latestExport":{"status":"completed","availability":"present"},
            }))
        }
    }

    #[test]
    fn current_catalog_has_one_project_edit_path() {
        let names = tool_catalog()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"apply_project_patch"));
        assert!(names.contains(&"replace_story_timeline"));
        assert!(
            !names
                .iter()
                .any(|name| name.contains("agent_plan") || name.contains("editor"))
        );
    }

    #[test]
    fn workspace_schema_defaults_to_summary_and_allows_targeted_timeline_detail() {
        let tool = tool_catalog()
            .into_iter()
            .find(|tool| tool.name == "read_workspace")
            .expect("workspace tool");
        let schema = &tool.parameters;

        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"]["detail"]["default"], "summary");
        assert_eq!(
            schema["properties"]["detail"]["enum"],
            json!(["summary", "timeline"])
        );
        assert!(tool.description.contains("marker-only refreshes"));
        assert!(tool.description.contains("markersTruncated=false"));
        assert_eq!(schema["properties"]["trackIds"]["maxItems"], 16);
        assert_eq!(schema["properties"]["clipIds"]["maxItems"], 64);
    }

    #[test]
    fn project_patch_schema_exposes_the_closed_scope_and_edit_vocabulary() {
        let schema = project_patch_schema();
        let scopes = schema["properties"]["scope"]["oneOf"]
            .as_array()
            .expect("closed Project Patch scopes");
        assert_eq!(scopes.len(), 3);
        assert!(
            scopes
                .iter()
                .any(|scope| scope["properties"]["kind"]["const"] == "project")
        );

        let operations = schema["properties"]["operations"]["items"]["oneOf"]
            .as_array()
            .expect("closed Project edit operations");
        let replace_markers = operations
            .iter()
            .find(|operation| operation["properties"]["op"]["const"] == "replace_markers")
            .expect("replace_markers schema");
        assert_eq!(replace_markers["additionalProperties"], false);
        assert_eq!(
            replace_markers["properties"]["markers"]["items"]["required"],
            json!(["id", "time", "label", "color"])
        );
    }

    #[test]
    fn demo_evidence_schema_exposes_targeted_bounded_queries() {
        let schema = tool_catalog()
            .into_iter()
            .find(|tool| tool.name == "read_demo_evidence")
            .expect("Demo evidence tool")
            .parameters;
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"]["maximumHighlights"]["maximum"], 128);
        assert_eq!(schema["properties"]["demoIds"]["maxItems"], 16);
        assert_eq!(schema["required"], json!([]));
    }

    #[test]
    fn project_delivery_schema_requires_one_exact_project() {
        let schema = tool_catalog()
            .into_iter()
            .find(|tool| tool.name == "read_project_delivery")
            .expect("Project delivery tool")
            .parameters;
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["projectId"]));
        assert_eq!(schema["properties"]["projectId"]["format"], "uuid");
    }

    #[tokio::test]
    async fn project_delivery_is_captured_from_the_single_host_runtime() {
        let project_id = "00000000-0000-4000-8000-000000000001";
        let (state, mut lifecycle) = ToolState::new(
            AgentContext::default(),
            Some(Arc::new(DeliveryHost)),
            "turn-delivery",
        );
        let output = state
            .execute(
                ToolKind::ReadProjectDelivery,
                "read_project_delivery",
                json!({"projectId":project_id}),
            )
            .await
            .expect("authoritative Project delivery");

        assert_eq!(output["projectId"], project_id);
        assert_eq!(output["latestExport"]["availability"], "present");
        assert!(matches!(
            lifecycle.recv().await,
            Some(ToolLifecycleEvent::Started { ref name, .. })
                if name == "read_project_delivery"
        ));
        assert!(matches!(
            lifecycle.recv().await,
            Some(ToolLifecycleEvent::Finished(ref call))
                if call.status == CapturedToolCallStatus::Completed
                    && call.output["deliveryGate"]["ready"] == true
        ));
    }

    #[tokio::test]
    async fn workspace_reads_the_live_host_after_a_same_turn_edit() {
        let (state, _lifecycle) = ToolState::new(
            AgentContext {
                project: json!({"revision":8}),
                ..AgentContext::default()
            },
            Some(Arc::new(DeliveryHost)),
            "turn-workspace",
        );
        let output = state
            .execute(
                ToolKind::ReadWorkspace,
                "read_workspace",
                json!({"detail":"timeline"}),
            )
            .await
            .expect("live workspace");

        assert_eq!(output["project"]["revision"], 9);
    }

    #[test]
    fn demo_evidence_query_resolves_player_name_and_returns_top_matching_events() {
        let analysis = json!({
            "series_demo_count": 2,
            "players": [
                {"steam_id":"niko-id","name":"NiKo","team":"B"},
                {"steam_id":"other-id","name":"Other","team":"A"}
            ],
            "rounds": [{"round":1}],
            "highlights": [
                {"id":"d1:one","demo_id":"11111111-1111-4111-8111-111111111111","player_id":"niko-id","kind":"one_tap","score":0.88,"start_tick":100},
                {"id":"d2:multi","demo_id":"22222222-2222-4222-8222-222222222222","player_id":"niko-id","kind":"multi_kill","score":0.95,"start_tick":200},
                {"id":"d1:fail","demo_id":"11111111-1111-4111-8111-111111111111","player_id":"niko-id","kind":"fail","score":0.5,"start_tick":300},
                {"id":"d1:other","demo_id":"11111111-1111-4111-8111-111111111111","player_id":"other-id","kind":"one_tap","score":0.99,"start_tick":400}
            ],
            "insights": {"large":"unused"}
        });

        let result = query_demo_evidence(
            &analysis,
            &json!({
                "playerName":"niko",
                "kinds":["one_tap","multi_kill"],
                "maximumHighlights":1
            }),
        )
        .expect("targeted evidence");

        assert_eq!(result["players"].as_array().map(Vec::len), Some(1));
        assert_eq!(result["highlights"].as_array().map(Vec::len), Some(1));
        assert_eq!(result["highlights"][0]["id"], "d2:multi");
        assert_eq!(result["rounds"], json!([]));
        assert_eq!(result["insights"], Value::Null);
        assert_eq!(result["evidence_query"]["matched_highlight_count"], 2);
        assert_eq!(result["evidence_query"]["returned_highlight_count"], 1);
        assert_eq!(result["evidence_query"]["truncated"], true);
    }

    #[test]
    fn unfiltered_demo_evidence_is_still_bounded() {
        let highlights = (0..200)
            .map(|index| json!({"id":format!("h-{index}"),"score":index}))
            .collect::<Vec<_>>();
        let result = query_demo_evidence(
            &json!({"players":[],"rounds":[],"highlights":highlights,"insights":null}),
            &json!({}),
        )
        .expect("bounded evidence");

        assert_eq!(result["highlights"].as_array().map(Vec::len), Some(64));
        assert_eq!(result["evidence_query"]["matched_highlight_count"], 200);
        assert_eq!(result["evidence_query"]["truncated"], true);
    }

    #[test]
    fn recording_and_export_are_confirmation_only() {
        for kind in ["recording", "export"] {
            let result = confirmation_request(
                kind,
                &json!({
                    "projectId":"11111111-1111-4111-8111-111111111111",
                    "baseRevision":1,
                    "summary":"go"
                }),
            )
            .expect("valid request");
            assert_eq!(result["status"], "requires_human_confirmation");
        }
    }

    #[tokio::test]
    async fn confirmation_tool_has_one_stable_started_and_finished_identity() {
        let (state, mut lifecycle) = ToolState::new(AgentContext::default(), None, "turn-hitl");
        state
            .execute(
                ToolKind::RequestExport,
                "request_project_export",
                json!({
                    "projectId":"00000000-0000-4000-8000-000000000001",
                    "baseRevision":1
                }),
            )
            .await
            .expect("confirmation checkpoint");
        let calls = state.snapshot().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "turn-hitl:tool:1");
        assert_eq!(
            calls[0].status,
            CapturedToolCallStatus::AwaitingConfirmation
        );
        assert!(matches!(
            lifecycle.recv().await,
            Some(ToolLifecycleEvent::Started { ref id, .. }) if id == "turn-hitl:tool:1"
        ));
        assert!(matches!(
            lifecycle.recv().await,
            Some(ToolLifecycleEvent::Finished(ref call))
                if call.id == "turn-hitl:tool:1"
                    && call.status == CapturedToolCallStatus::AwaitingConfirmation
        ));
    }
}
