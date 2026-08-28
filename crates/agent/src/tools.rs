use std::sync::Arc;

use rig_agent::tool::DynamicTool;
use rig_core::tool::{ToolExecutionError, ToolOutput};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::{AgentContext, AgentMode, AgentToolHost};

const MAXIMUM_CAPTURED_TOOL_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CapturedToolCall {
    pub name: String,
    pub input: Value,
    pub output: Value,
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
}

impl ToolState {
    pub(crate) fn new(
        context: AgentContext,
        tool_host: Option<Arc<dyn AgentToolHost>>,
        _auto_mode: bool,
    ) -> Self {
        Self {
            context: Arc::new(context),
            tool_host,
            captures: Arc::new(Mutex::new(Captures::default())),
        }
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
        let output = match kind {
            ToolKind::ReadWorkspace => json!({
                "workspace": self.context.workspace,
                "project": self.context.project,
            }),
            ToolKind::ReadDemoEvidence => json!({
                "demo": self.context.demo,
                "analysis": self.context.analysis,
                "mapContext": self.context.map_context,
            }),
            ToolKind::ReadCinematicContext => {
                let host = self.host()?;
                let ids = string_array(&input, "highlightIds", 64)?;
                host.read_cinematic_context(&ids)
                    .await
                    .map_err(ToolExecutionError::other)?
            }
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
        self.captures
            .lock()
            .await
            .tool_calls
            .push(CapturedToolCall {
                name: name.to_owned(),
                input,
                output: bounded_output(&output),
            });
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
            "Read the exact current workspace and canonical Project revision. Always call this before editing.",
            object_schema(json!({}), &[]),
        ),
        definition(
            ToolKind::ReadDemoEvidence,
            "read_demo_evidence",
            ALL_MODES,
            "Read bounded verified Demo analysis supplied by the current workspace.",
            object_schema(json!({}), &[]),
        ),
        definition(
            ToolKind::ReadCinematicContext,
            "read_cinematic_context",
            EDIT_MODES,
            "Read bounded replay-derived cinematic evidence for explicit highlight IDs.",
            object_schema(
                json!({"highlightIds": string_array_schema(64)}),
                &["highlightIds"],
            ),
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
            "Atomically replan the entire story track. This is an Agent-only high-level operation; the host allocates clip identities, validates the staged timeline, and commits one undoable Change Group.",
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
            "scope": {"type":"object"},
            "operations": {
                "type":"array",
                "minItems":1,
                "maxItems":128,
                "items":{"type":"object"}
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
}
