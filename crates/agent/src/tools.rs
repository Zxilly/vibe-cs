use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use rig_agent::tool::DynamicTool;
use rig_core::tool::{ToolExecutionError, ToolOutput};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;
use ts_rs::TS;
use uuid::Uuid;

use crate::{AgentContext, AgentMode, AgentToolHost, HitlRequest};

const MAXIMUM_VIDEO_PLAN_SHOTS: usize = 64;
const DEFAULT_VIDEO_TARGET_SECONDS: f64 = 40.0;
const MINIMUM_VIDEO_TARGET_COVERAGE: f64 = 0.85;

const MAXIMUM_CAPTURED_TOOL_OUTPUT_BYTES: usize = 32 * 1024;

/// One tool invocation the model made during a turn, with its arguments and
/// result verbatim.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CapturedToolCall {
    pub name: String,
    pub input: Value,
    pub output: Value,
}

/// What kind of proposal the model emitted, which selects how a client renders
/// the payload beside it.
///
/// A closed set: every value is minted by one of the proposal tool handlers in
/// this file, and another kind requires another handler. It was a `String`, so
/// the binding said `string` and the web app carried the union in a comment
/// with a note that Rust did not enforce it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CapturedPlanKind {
    /// Reviewable changes to an existing Agent shot list.
    AgentPlanChange,
    /// A change to an existing highlight edit.
    HighlightEdit,
    /// Music beats aligned against the cut.
    BeatAlignment,
    /// A recording queue, which is the one that needs an explicit confirmation.
    VideoRender,
}

/// One proposal the model emitted during a turn. `kind` selects how a client
/// renders `payload`; the payload itself is not interpreted here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CapturedPlan {
    pub id: Uuid,
    pub kind: CapturedPlanKind,
    pub title: String,
    pub payload: Value,
}

#[derive(Debug, Default)]
struct Captures {
    tool_calls: Vec<CapturedToolCall>,
    plans: Vec<CapturedPlan>,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolState {
    context: Arc<AgentContext>,
    tool_host: Option<Arc<dyn AgentToolHost>>,
    auto_mode: bool,
    cinematic_scene_cache: Arc<Mutex<HashMap<String, Value>>>,
    evidence_cache: Arc<Mutex<HashMap<Uuid, Value>>>,
    captures: Arc<Mutex<Captures>>,
}

impl ToolState {
    pub(crate) fn new(
        context: AgentContext,
        tool_host: Option<Arc<dyn AgentToolHost>>,
        auto_mode: bool,
    ) -> Self {
        Self {
            context: Arc::new(context),
            tool_host,
            auto_mode,
            cinematic_scene_cache: Arc::new(Mutex::new(HashMap::new())),
            evidence_cache: Arc::new(Mutex::new(HashMap::new())),
            captures: Arc::new(Mutex::new(Captures::default())),
        }
    }

    pub(crate) async fn snapshot(&self) -> (Vec<CapturedToolCall>, Vec<CapturedPlan>) {
        let captures = self.captures.lock().await;
        (captures.tool_calls.clone(), captures.plans.clone())
    }

    #[cfg(test)]
    async fn execute_named(&self, name: &str, input: Value) -> Result<Value, ToolExecutionError> {
        let tool = tool_catalog()
            .into_iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| ToolExecutionError::invalid_args(format!("unknown tool: {name}")))?;
        self.execute(tool.kind, tool.name, input).await
    }

    async fn execute(
        &self,
        kind: ToolKind,
        name: &str,
        input: Value,
    ) -> Result<Value, ToolExecutionError> {
        if confirmation_kind(kind).is_some() {
            return self.execute_confirmation(kind, name, input).await;
        }
        let external_cinematic = match kind {
            ToolKind::ReadCinematicContext => self
                .external_cinematic_context(&input)
                .await
                .map_err(ToolExecutionError::other)?,
            ToolKind::DraftVideoPlan => self
                .explicit_cinematic_evidence(&input)
                .await
                .map_err(ToolExecutionError::invalid_args)?,
            _ => None,
        };
        let (mut output, plan) = match kind {
            ToolKind::ReadAudioEvidence => self
                .read_audio_evidence(&input)
                .await
                .map_err(ToolExecutionError::other)?,
            ToolKind::DraftBeatAlignment => self
                .draft_beat_alignment(&input)
                .await
                .map_err(ToolExecutionError::other)?,
            _ => execute_tool_with_cinematic(
                kind,
                &self.context,
                &input,
                external_cinematic.as_ref(),
            )
            .map_err(ToolExecutionError::invalid_args)?,
        };
        if let Some(proposal) = &plan {
            let object = output.as_object_mut().ok_or_else(|| {
                ToolExecutionError::other("proposal tool output must be an object")
            })?;
            object.insert("proposalId".to_owned(), json!(proposal.id));
        }
        if kind == ToolKind::ReadCinematicContext && output["available"] == Value::Bool(true) {
            let evidence_id = Uuid::new_v4();
            self.evidence_cache
                .lock()
                .await
                .insert(evidence_id, output.clone());
            output
                .as_object_mut()
                .expect("cinematic evidence output is an object")
                .insert("cinematicEvidenceId".to_owned(), json!(evidence_id));
        }
        let mut captures = self.captures.lock().await;
        captures.tool_calls.push(CapturedToolCall {
            name: name.to_owned(),
            input,
            output: bounded_captured_output(&output),
        });
        if let Some(plan) = plan {
            captures.plans.push(plan);
        }
        Ok(output)
    }

    async fn execute_confirmation(
        &self,
        tool_kind: ToolKind,
        name: &str,
        input: Value,
    ) -> Result<Value, ToolExecutionError> {
        let request = serde_json::from_value::<HitlRequest>(input.clone())
            .map_err(|error| ToolExecutionError::invalid_args(error.to_string()))?;
        validate_hitl_request(&request).map_err(ToolExecutionError::invalid_args)?;
        let kind = confirmation_kind(tool_kind)
            .ok_or_else(|| ToolExecutionError::invalid_args("unknown confirmation tool"))?;
        let proposal = {
            let captures = self.captures.lock().await;
            captures
                .plans
                .iter()
                .find(|proposal| proposal.id == request.proposal_id)
                .cloned()
                .ok_or_else(|| {
                    ToolExecutionError::other(format!(
                        "proposal {} is not available in this turn",
                        request.proposal_id
                    ))
                })?
        };
        if !confirmation_matches(kind, proposal.kind) {
            return Err(ToolExecutionError::invalid_args(format!(
                "{name} does not accept proposal kind {:?}",
                proposal.kind
            )));
        }
        let automatic = self.auto_mode;
        let execution_result = if automatic {
            match &self.tool_host {
                Some(host) => host
                    .execute_confirmation(confirmation_name(kind), &proposal)
                    .await
                    .map_err(ToolExecutionError::other)?,
                None => json!({"status":"approved_without_execution_host"}),
            }
        } else {
            Value::Null
        };
        let output = json!({
            "confirmation": confirmation_name(kind),
            "status": if automatic {"approved"} else {"pending"},
            "approved": automatic,
            "automatic": automatic,
            "proposalId": proposal.id,
            "proposalKind": proposal.kind,
            "title": request.title,
            "summary": request.summary,
            "risks": request.risks,
            "executionResult": execution_result
        });
        let mut captures = self.captures.lock().await;
        captures.tool_calls.push(CapturedToolCall {
            name: name.to_owned(),
            input,
            output: bounded_captured_output(&output),
        });
        Ok(output)
    }

    async fn external_cinematic_context(&self, input: &Value) -> Result<Option<Value>, String> {
        let ids = string_vec_required(input, "highlightIds", MAXIMUM_VIDEO_PLAN_SHOTS)?;
        let missing = {
            let cache = self.cinematic_scene_cache.lock().await;
            ids.iter()
                .filter(|id| !cache.contains_key(*id))
                .cloned()
                .collect::<Vec<_>>()
        };
        if !missing.is_empty()
            && let Some(host) = &self.tool_host
        {
            let supplied = host.read_cinematic_context(&missing).await?;
            let mut cache = self.cinematic_scene_cache.lock().await;
            for scene in supplied
                .get("scenes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(id) = scene.get("highlightId").and_then(Value::as_str) {
                    cache.insert(id.to_owned(), scene.clone());
                }
            }
        }
        let cache = self.cinematic_scene_cache.lock().await;
        let scenes = ids
            .iter()
            .filter_map(|id| cache.get(id).cloned())
            .collect::<Vec<_>>();
        Ok((!scenes.is_empty()).then(|| json!({ "scenes": scenes })))
    }

    async fn explicit_cinematic_evidence(&self, input: &Value) -> Result<Option<Value>, String> {
        let evidence_id = required_str(input, "cinematicEvidenceId")?;
        let evidence_id = Uuid::parse_str(evidence_id)
            .map_err(|_| "cinematicEvidenceId must be a UUID returned by read_cinematic_context")?;
        let evidence = self
            .evidence_cache
            .lock()
            .await
            .get(&evidence_id)
            .cloned()
            .ok_or_else(|| "cinematicEvidenceId is not available in this turn".to_owned())?;
        let requested = string_set_required(input, "highlightIds", 16)?;
        let evidenced = evidence
            .get("scenes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|scene| text(scene.get("highlightId")))
            .collect::<HashSet<_>>();
        if requested.iter().any(|id| !evidenced.contains(id.as_str())) {
            return Err("cinematic Evidence does not cover every requested Highlight".to_owned());
        }
        Ok(Some(evidence))
    }

    async fn read_audio_evidence(
        &self,
        input: &Value,
    ) -> Result<(Value, Option<CapturedPlan>), String> {
        require_workspace_resource(&self.context, input, "audioAssetId")?;
        let asset_id = parse_uuid_field(input, "audioAssetId")?;
        let view = enum_value(input, "view", &["summary", "rhythm_map"])?;
        let host = self
            .tool_host
            .as_ref()
            .ok_or_else(|| "audio analysis host is unavailable".to_owned())?;
        let analysis = host.read_audio_analysis(asset_id).await?;
        Ok((project_audio_evidence(&analysis, view)?, None))
    }

    async fn draft_beat_alignment(
        &self,
        input: &Value,
    ) -> Result<(Value, Option<CapturedPlan>), String> {
        require_workspace_resource(&self.context, input, "editorProjectId")?;
        require_workspace_resource(&self.context, input, "audioAssetId")?;
        let editor_project_id = parse_uuid_field(input, "editorProjectId")?;
        let audio_asset_id = parse_uuid_field(input, "audioAssetId")?;
        let expected_revision = input
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .filter(|revision| *revision > 0)
            .ok_or_else(|| "expectedRevision must be a positive integer".to_owned())?;
        let audio_placement = input
            .get("audioPlacement")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| "audioPlacement must be an object".to_owned())?;
        let host = self
            .tool_host
            .as_ref()
            .ok_or_else(|| "beat-alignment host is unavailable".to_owned())?;
        let payload = host
            .draft_beat_alignment(
                editor_project_id,
                expected_revision,
                audio_asset_id,
                audio_placement,
            )
            .await?;
        let draft = payload
            .get("draft")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| "beat-alignment host returned no advisory draft".to_owned())?;
        if draft.get("advisory_only").and_then(Value::as_bool) != Some(true) {
            return Err("beat-alignment host returned a non-advisory draft".to_owned());
        }
        let plan = CapturedPlan {
            id: Uuid::new_v4(),
            kind: CapturedPlanKind::BeatAlignment,
            title: "BGM beat alignment".to_owned(),
            payload,
        };
        Ok((json!({"available":true,"draft":draft}), Some(plan)))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ToolKind {
    ReadWorkspace,
    ReadDemoSummary,
    ReadPlayers,
    SearchRounds,
    ReadRoundContext,
    ReadRoundEvents,
    ReadPlayerMatchups,
    ReadHighlights,
    ReadCinematicContext,
    ReadEditorTimeline,
    ReadAgentPlan,
    DraftEditPlan,
    DraftAgentPlanChanges,
    DraftVideoPlan,
    ReadAudioEvidence,
    DraftBeatAlignment,
    NavigateWorkspace,
    ConfirmVideoPlan,
    ConfirmEditPlan,
    ConfirmBeatAlignment,
}

#[derive(Debug)]
struct ToolDefinition {
    kind: ToolKind,
    name: &'static str,
    modes: &'static [AgentMode],
    description: &'static str,
    parameters: Value,
}

impl ToolDefinition {
    fn supports(&self, mode: AgentMode) -> bool {
        self.modes.contains(&mode)
    }
}

const ALL_MODES: &[AgentMode] = &[AgentMode::Guide, AgentMode::Edit, AgentMode::Hlae];
const EDIT_MODE: &[AgentMode] = &[AgentMode::Edit];
const HLAE_MODE: &[AgentMode] = &[AgentMode::Hlae];

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

pub(crate) fn create_tools(state: &ToolState, mode: AgentMode) -> Vec<DynamicTool> {
    tool_catalog()
        .into_iter()
        .filter(|tool| tool.supports(mode))
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
    let demo_ids = || json!({"type":"array","items":object_id_schema(),"minItems":1,"maxItems":12});
    let confirmation = || {
        object_schema(
            json!({
                "proposalId":{"type":"string","format":"uuid"},
                "title":{"type":"string","minLength":1,"maxLength":200},
                "summary":{"type":"string","minLength":1,"maxLength":2000},
                "risks":{"type":"array","maxItems":8,"items":{"type":"string","minLength":1,"maxLength":400},"default":[]}
            }),
            &["proposalId", "title", "summary"],
        )
    };
    vec![
        definition(
            ToolKind::ReadWorkspace,
            "read_workspace_context",
            ALL_MODES,
            "Read exact visible workflow and structured object references. Values may be null and must not be inferred.",
            object_schema(json!({}), &[]),
        ),
        definition(
            ToolKind::ReadDemoSummary,
            "read_demo_summary",
            ALL_MODES,
            "Read bounded metadata for one explicit analyzed Demo; no rounds, events, players, or Highlights.",
            object_schema(json!({"demoId":object_id_schema()}), &["demoId"]),
        ),
        definition(
            ToolKind::ReadPlayers,
            "read_players",
            ALL_MODES,
            "Read the bounded player directory for one explicit analyzed Demo.",
            object_schema(
                json!({"demoId":object_id_schema(),"playerIds":string_array_schema(10),"maximumResults":{"type":"integer","minimum":1,"maximum":64,"default":32}}),
                &["demoId"],
            ),
        ),
        definition(
            ToolKind::SearchRounds,
            "search_rounds",
            ALL_MODES,
            "Run a deterministic query over one explicit Demo and return bounded Round Evidence references.",
            object_schema(
                json!({"demoId":object_id_schema(),"winningSide":{"type":"string","enum":["T","CT"]},"playerIds":string_array_schema(10),"purchasedItems":string_array_schema(12),"roundNumbers":integer_array_schema(24),"eventKinds":event_array_schema(),"maximumResults":{"type":"integer","minimum":1,"maximum":24,"default":24}}),
                &["demoId"],
            ),
        ),
        definition(
            ToolKind::ReadRoundContext,
            "read_round_context",
            ALL_MODES,
            "Read bounded facts for explicit Rounds without embedding Event rows.",
            object_schema(
                json!({"demoId":object_id_schema(),"roundNumbers":integer_array_schema(12)}),
                &["demoId", "roundNumbers"],
            ),
        ),
        definition(
            ToolKind::ReadRoundEvents,
            "read_round_events",
            ALL_MODES,
            "Read bounded Events for explicit Rounds and filters.",
            object_schema(
                json!({"demoId":object_id_schema(),"roundNumbers":integer_array_schema(24),"eventKinds":event_array_schema(),"playerIds":string_array_schema(10),"maximumResults":{"type":"integer","minimum":1,"maximum":256,"default":128}}),
                &["demoId", "roundNumbers"],
            ),
        ),
        definition(
            ToolKind::ReadPlayerMatchups,
            "read_player_matchups",
            ALL_MODES,
            "Read verified player-versus-player aggregates for one explicit Demo.",
            object_schema(
                json!({"demoId":object_id_schema(),"playerIds":string_array_schema(10)}),
                &["demoId", "playerIds"],
            ),
        ),
        definition(
            ToolKind::ReadHighlights,
            "read_highlights",
            ALL_MODES,
            "Search bounded Highlight Evidence in explicit authorized Demos.",
            object_schema(
                json!({"demoIds":demo_ids(),"playerIds":string_array_schema(10),"kinds":string_array_schema(12),"roundNumbers":integer_array_schema(24),"minimumScore":{"type":"number","minimum":0,"maximum":1,"default":0},"maximumResults":{"type":"integer","minimum":1,"maximum":64,"default":32}}),
                &["demoIds"],
            ),
        ),
        definition(
            ToolKind::ReadCinematicContext,
            "read_cinematic_context",
            HLAE_MODE,
            "Create bounded cinematic Evidence for explicit Highlights and return cinematicEvidenceId.",
            object_schema(
                json!({"demoIds":demo_ids(),"highlightIds":string_array_schema(MAXIMUM_VIDEO_PLAN_SHOTS)}),
                &["demoIds", "highlightIds"],
            ),
        ),
        definition(
            ToolKind::ReadEditorTimeline,
            "read_editor_timeline",
            EDIT_MODE,
            "Read one explicit Editor Project timeline.",
            object_schema(
                json!({"editorProjectId":object_id_schema(),"includeClips":{"type":"boolean","default":true}}),
                &["editorProjectId"],
            ),
        ),
        definition(
            ToolKind::ReadAgentPlan,
            "read_agent_plan",
            EDIT_MODE,
            "Read one explicit Agent Plan revision and its bounded Shot list.",
            object_schema(
                json!({"planId":object_id_schema(),"expectedRevision":{"type":"integer","minimum":1}}),
                &["planId", "expectedRevision"],
            ),
        ),
        definition(
            ToolKind::DraftEditPlan,
            "draft_edit_plan",
            EDIT_MODE,
            "Draft one non-destructive Highlight Edit Proposal from explicit Demo Evidence.",
            object_schema(
                json!({"demoId":object_id_schema(),"highlightIds":string_array_schema(16),"pacing":{"type":"string","enum":["measured","energetic","impact"]},"includeContextSeconds":{"type":"number","minimum":0,"maximum":8,"default":2},"transitionStyle":{"type":"string","enum":["auto","cut","fade","flash","slide"],"default":"auto"}}),
                &["demoId", "highlightIds", "pacing"],
            ),
        ),
        definition(
            ToolKind::DraftAgentPlanChanges,
            "draft_agent_plan_changes",
            EDIT_MODE,
            "Draft one reviewable Agent Plan change Proposal against an explicit revision.",
            object_schema(
                json!({"planId":object_id_schema(),"expectedRevision":{"type":"integer","minimum":1},"title":{"type":"string","minLength":1,"maxLength":200},"changes":{"type":"array","minItems":1,"maxItems":16,"items":{"type":"object","additionalProperties":false,"properties":{"op":{"type":"string","enum":["shorten","delete"]},"target":{"type":"string","minLength":1,"maxLength":128},"deltaSeconds":{"type":"number","maximum":-0.01},"rationale":{"type":"string","minLength":1,"maxLength":400},"warning":{"type":["string","null"],"maxLength":400}},"required":["op","target","rationale"]}}}),
                &["planId", "expectedRevision", "title", "changes"],
            ),
        ),
        definition(
            ToolKind::DraftVideoPlan,
            "draft_video_plan",
            HLAE_MODE,
            "Draft one duration-aware Video Proposal from explicit non-overlapping Highlight and cinematic Evidence references. The result reports deterministic duration coverage and returns a proposalId only when the requested target is feasible.",
            object_schema(
                json!({"demoIds":demo_ids(),"cinematicEvidenceId":{"type":"string","format":"uuid"},"title":{"type":"string","minLength":1,"maxLength":200},"highlightIds":string_array_schema(MAXIMUM_VIDEO_PLAN_SHOTS),"targetDurationSeconds":{"type":"number","minimum":5,"maximum":3600,"default":40},"pacing":{"type":"string","enum":["energetic","impact","cinematic"]},"storyRoles":{"type":"array","items":{"type":"string","enum":["hook","build","climax"]},"minItems":1,"maxItems":MAXIMUM_VIDEO_PLAN_SHOTS},"transitionStyle":{"type":"string","enum":["cut","flash","fade","slide"]},"leadSeconds":{"type":"number","minimum":0.5,"maximum":8,"default":2.5},"tailSeconds":{"type":"number","minimum":0.5,"maximum":8,"default":2},"cameraStyle":{"type":"string","enum":["pov","orbit","dolly","static","tracking","crane","flyby"],"default":"pov"},"cameraStyles":{"type":"array","items":{"type":"string","enum":["pov","orbit","dolly","static","tracking","crane","flyby"]},"maxItems":MAXIMUM_VIDEO_PLAN_SHOTS,"default":[]},"cameraIntents":{"type":"array","items":{"type":"string","enum":["player_pov","establish_location","follow_entry","reveal_duel","hold_crossfire","rise_after_climax","transition_through_space"]},"minItems":1,"maxItems":MAXIMUM_VIDEO_PLAN_SHOTS},"cameraRationales":{"type":"array","items":{"type":"string","minLength":1,"maxLength":128},"minItems":1,"maxItems":MAXIMUM_VIDEO_PLAN_SHOTS}}),
                &[
                    "demoIds",
                    "cinematicEvidenceId",
                    "title",
                    "highlightIds",
                    "pacing",
                    "storyRoles",
                    "transitionStyle",
                    "cameraIntents",
                    "cameraRationales",
                ],
            ),
        ),
        definition(
            ToolKind::ReadAudioEvidence,
            "read_audio_evidence",
            EDIT_MODE,
            "Analyze one explicit managed audio asset on demand with summary or rhythm_map view.",
            object_schema(
                json!({"audioAssetId":object_id_schema(),"view":{"type":"string","enum":["summary","rhythm_map"]}}),
                &["audioAssetId", "view"],
            ),
        ),
        definition(
            ToolKind::DraftBeatAlignment,
            "draft_beat_alignment",
            EDIT_MODE,
            "Compute one advisory Beat Alignment Proposal on demand from explicit object references.",
            object_schema(
                json!({"editorProjectId":object_id_schema(),"expectedRevision":{"type":"integer","minimum":1},"audioAssetId":object_id_schema(),"audioPlacement":{"type":"object","additionalProperties":false,"properties":{"timeline_start_seconds":{"type":"number","minimum":0},"source_in_seconds":{"type":"number","minimum":0},"volume":{"type":"number","minimum":0,"maximum":4}},"required":["timeline_start_seconds","source_in_seconds","volume"]}}),
                &[
                    "editorProjectId",
                    "expectedRevision",
                    "audioAssetId",
                    "audioPlacement",
                ],
            ),
        ),
        definition(
            ToolKind::NavigateWorkspace,
            "navigate_workspace",
            ALL_MODES,
            "Request one typed visible destination; returns explicit prerequisites when unavailable.",
            object_schema(
                json!({"destination":{"type":"string","enum":["review","players","evidence","replay","heatmap","edit","queue","studio","outputs"]},"demoId":object_id_schema()}),
                &["destination"],
            ),
        ),
        definition(
            ToolKind::ConfirmVideoPlan,
            "confirm_video_plan",
            HLAE_MODE,
            "Confirm exactly one referenced Video Proposal.",
            confirmation(),
        ),
        definition(
            ToolKind::ConfirmEditPlan,
            "confirm_edit_plan",
            EDIT_MODE,
            "Confirm exactly one referenced Edit Proposal.",
            confirmation(),
        ),
        definition(
            ToolKind::ConfirmBeatAlignment,
            "confirm_beat_alignment",
            EDIT_MODE,
            "Confirm exactly one referenced Beat Alignment Proposal.",
            confirmation(),
        ),
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfirmationKind {
    Video,
    Edit,
    BeatAlignment,
}

fn confirmation_kind(kind: ToolKind) -> Option<ConfirmationKind> {
    match kind {
        ToolKind::ConfirmVideoPlan => Some(ConfirmationKind::Video),
        ToolKind::ConfirmEditPlan => Some(ConfirmationKind::Edit),
        ToolKind::ConfirmBeatAlignment => Some(ConfirmationKind::BeatAlignment),
        _ => None,
    }
}

const fn confirmation_name(kind: ConfirmationKind) -> &'static str {
    match kind {
        ConfirmationKind::Video => "video_plan",
        ConfirmationKind::Edit => "edit_plan",
        ConfirmationKind::BeatAlignment => "beat_alignment",
    }
}

const fn confirmation_matches(kind: ConfirmationKind, proposal: CapturedPlanKind) -> bool {
    match kind {
        ConfirmationKind::Video => matches!(proposal, CapturedPlanKind::VideoRender),
        ConfirmationKind::Edit => matches!(
            proposal,
            CapturedPlanKind::HighlightEdit | CapturedPlanKind::AgentPlanChange
        ),
        ConfirmationKind::BeatAlignment => matches!(proposal, CapturedPlanKind::BeatAlignment),
    }
}

fn validate_hitl_request(request: &HitlRequest) -> Result<(), String> {
    if request.proposal_id.is_nil()
        || request.title.trim().is_empty()
        || request.title.chars().count() > 200
        || request.summary.trim().is_empty()
        || request.summary.chars().count() > 2_000
        || request.risks.len() > 8
        || request
            .risks
            .iter()
            .any(|risk| risk.trim().is_empty() || risk.chars().count() > 400)
    {
        Err("HITL request is outside the supported text or risk bounds".to_owned())
    } else {
        Ok(())
    }
}

#[allow(clippy::needless_pass_by_value)]
fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn integer_array_schema(maximum: usize) -> Value {
    json!({"type":"array","items":{"type":"integer","minimum":1},"maxItems":maximum,"default":[]})
}

fn string_array_schema(maximum: usize) -> Value {
    json!({"type":"array","items":{"type":"string","minLength":1,"maxLength":128},"maxItems":maximum,"default":[]})
}

fn object_id_schema() -> Value {
    json!({"type":"string","minLength":1,"maxLength":200})
}

fn bounded_captured_output(output: &Value) -> Value {
    let serialized_bytes = serde_json::to_vec(output).map_or(usize::MAX, |bytes| bytes.len());
    if serialized_bytes <= MAXIMUM_CAPTURED_TOOL_OUTPUT_BYTES {
        return output.clone();
    }
    let mut summary = Map::new();
    if let Some(object) = output.as_object() {
        for key in [
            "available",
            "accepted",
            "status",
            "approved",
            "automatic",
            "confirmation",
            "proposalId",
            "proposalKind",
            "cinematicEvidenceId",
            "title",
            "summary",
            "risks",
        ] {
            if let Some(value) = object.get(key) {
                summary.insert(key.to_owned(), value.clone());
            }
        }
    }
    summary.insert("captureTruncated".to_owned(), Value::Bool(true));
    summary.insert("originalBytes".to_owned(), json!(serialized_bytes));
    Value::Object(summary)
}

fn event_array_schema() -> Value {
    json!({"type":"array","items":{"type":"string","enum":["round_start","round_end","kill","damage","bomb_plant","bomb_defuse","bomb_explode","grenade","purchase"]},"maxItems":9,"default":[]})
}

#[cfg(test)]
fn execute_tool(
    name: &str,
    context: &AgentContext,
    input: &Value,
) -> Result<(Value, Option<CapturedPlan>), String> {
    let kind = tool_catalog()
        .into_iter()
        .find(|tool| tool.name == name)
        .map(|tool| tool.kind)
        .ok_or_else(|| format!("unknown tool: {name}"))?;
    execute_tool_with_cinematic(kind, context, input, None)
}

fn execute_tool_with_cinematic(
    kind: ToolKind,
    context: &AgentContext,
    input: &Value,
    external_cinematic: Option<&Value>,
) -> Result<(Value, Option<CapturedPlan>), String> {
    ensure_object(input)?;
    match kind {
        ToolKind::ReadWorkspace => Ok((read_workspace_context(context, input)?, None)),
        ToolKind::ReadDemoSummary => Ok((read_demo_summary(context, input)?, None)),
        ToolKind::ReadPlayers => Ok((read_players(context, input)?, None)),
        ToolKind::SearchRounds => Ok((search_rounds(context, input)?, None)),
        ToolKind::ReadRoundContext => Ok((read_round_context(context, input)?, None)),
        ToolKind::ReadRoundEvents => Ok((read_round_events(context, input)?, None)),
        ToolKind::ReadPlayerMatchups => Ok((read_player_matchups(context, input)?, None)),
        ToolKind::ReadHighlights => Ok((read_highlights(context, input)?, None)),
        ToolKind::ReadCinematicContext => Ok((
            read_cinematic_context(context, input, external_cinematic)?,
            None,
        )),
        ToolKind::ReadEditorTimeline => Ok((read_editor_timeline(context, input)?, None)),
        ToolKind::ReadAgentPlan => Ok((read_agent_plan(context, input)?, None)),
        ToolKind::DraftEditPlan => draft_edit_plan(context, input),
        ToolKind::DraftAgentPlanChanges => draft_agent_plan_changes(context, input),
        ToolKind::DraftVideoPlan => draft_video_plan(context, input, external_cinematic),
        ToolKind::NavigateWorkspace => Ok((navigate_workspace(context, input)?, None)),
        ToolKind::ReadAudioEvidence
        | ToolKind::DraftBeatAlignment
        | ToolKind::ConfirmVideoPlan
        | ToolKind::ConfirmEditPlan
        | ToolKind::ConfirmBeatAlignment => {
            Err("tool requires the asynchronous ToolState executor".to_owned())
        }
    }
}

fn read_workspace_context(context: &AgentContext, input: &Value) -> Result<Value, String> {
    if !ensure_object(input)?.is_empty() {
        return Err("read_workspace_context accepts no fields".into());
    }
    let mut workspace = context
        .workspace
        .as_object()
        .cloned()
        .ok_or_else(|| "workspace context is unavailable".to_owned())?;
    let plan_available = workspace.get("plan").is_some_and(Value::is_object);
    let series_demo_count = workspace
        .get("series")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    workspace.remove("plan");
    workspace.remove("series");
    workspace.insert("planAvailable".to_owned(), json!(plan_available));
    workspace.insert("seriesDemoCount".to_owned(), json!(series_demo_count));
    Ok(Value::Object(workspace))
}

fn navigate_workspace(context: &AgentContext, input: &Value) -> Result<Value, String> {
    let object = ensure_object(input)?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "destination" | "demoId"))
    {
        return Err("navigate_workspace accepts only destination and demoId".into());
    }
    let destination = enum_value(
        input,
        "destination",
        &[
            "review", "players", "evidence", "replay", "heatmap", "edit", "queue", "studio",
            "outputs",
        ],
    )?;
    let requires_demo = matches!(destination, "replay" | "heatmap");
    if requires_demo && require_selected_demo(context, input).is_err() {
        return Ok(json!({
            "accepted": false,
            "destination": destination,
            "reason": "A completed analyzed Demo must be selected for this destination"
        }));
    }
    Ok(json!({"accepted":true,"destination":destination,"reason":null}))
}

fn ensure_object(input: &Value) -> Result<&Map<String, Value>, String> {
    input
        .as_object()
        .ok_or_else(|| "tool input must be a JSON object".into())
}

fn require_selected_demo<'a>(context: &'a AgentContext, input: &Value) -> Result<&'a str, String> {
    let requested = required_str(input, "demoId")?;
    let actual = context
        .demo
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "No Demo is selected.".to_owned())?;
    if requested != actual {
        return Err("demoId does not match the selected Demo".to_owned());
    }
    Ok(actual)
}

fn require_selected_editor_project(context: &AgentContext, input: &Value) -> Result<(), String> {
    require_matching_id(
        input,
        "editorProjectId",
        context.editor_project.get("id"),
        "Editor Project",
    )
}

fn require_selected_agent_plan(context: &AgentContext, input: &Value) -> Result<(), String> {
    let plan = context
        .workspace
        .get("plan")
        .ok_or_else(|| "No Agent Plan is selected.".to_owned())?;
    require_matching_id(input, "planId", plan.get("id"), "Agent Plan")?;
    let expected = integer(input.get("expectedRevision"))
        .filter(|revision| *revision > 0)
        .ok_or_else(|| "expectedRevision must be a positive integer".to_owned())?;
    let current = integer(plan.get("revision"))
        .ok_or_else(|| "selected Agent Plan has no revision".to_owned())?;
    if expected != current {
        return Err(format!(
            "Agent Plan revision changed: expected {expected}, current {current}"
        ));
    }
    Ok(())
}

fn require_matching_id(
    input: &Value,
    key: &str,
    actual: Option<&Value>,
    label: &str,
) -> Result<(), String> {
    let requested = required_str(input, key)?;
    let actual = actual
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("No {label} is selected."))?;
    if requested != actual {
        return Err(format!("{key} does not match the selected {label}"));
    }
    Ok(())
}

fn require_workspace_resource(
    context: &AgentContext,
    input: &Value,
    key: &str,
) -> Result<(), String> {
    require_matching_id(
        input,
        key,
        context
            .workspace
            .get("resources")
            .and_then(|value| value.get(key)),
        "workspace resource",
    )
}

fn parse_uuid_field(input: &Value, key: &str) -> Result<Uuid, String> {
    Uuid::parse_str(required_str(input, key)?).map_err(|_| format!("{key} must be a UUID"))
}

fn require_authorized_demo_ids(context: &AgentContext, input: &Value) -> Result<(), String> {
    let requested = string_vec_required(input, "demoIds", 12).map_err(|error| {
        let keys = input
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        format!("{error}; received fields: {keys:?}")
    })?;
    let authorized = context
        .workspace
        .get("demoIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(context.demo.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    if authorized.is_empty() || requested.iter().any(|id| !authorized.contains(id.as_str())) {
        return Err("demoIds contains a Demo outside the selected workspace".to_owned());
    }
    Ok(())
}

fn read_demo_summary(context: &AgentContext, input: &Value) -> Result<Value, String> {
    require_selected_demo(context, input)?;
    let Some(analysis) = context.analysis.as_object() else {
        return Ok(json!({"available":false,"reason":"No analyzed Demo is selected."}));
    };
    Ok(json!({
        "available":true,
        "demo":context.demo,
        "mapName":analysis.get("map_name"),
        "tickRate":analysis.get("tick_rate"),
        "durationSeconds":analysis.get("duration_seconds"),
        "teams":analysis.get("teams")
    }))
}

fn read_players(context: &AgentContext, input: &Value) -> Result<Value, String> {
    require_selected_demo(context, input)?;
    let wanted = string_set(input, "playerIds", 10)?;
    let maximum = bounded_usize(input, "maximumResults", 32, 1, 64)?;
    let players = array(context.analysis.get("players"))
        .filter(|player| {
            wanted.is_empty()
                || text(player.get("steam_id")).is_some_and(|id| wanted.contains(id))
                || text(player.get("id")).is_some_and(|id| wanted.contains(id))
        })
        .take(maximum)
        .cloned()
        .collect::<Vec<_>>();
    Ok(json!({"available":!players.is_empty(),"players":players}))
}

fn search_rounds(context: &AgentContext, input: &Value) -> Result<Value, String> {
    let demo_id = require_selected_demo(context, input)?;
    if !context.analysis.is_object() {
        return Ok(
            json!({"available":false,"rounds":[],"aggregate":{"reason":"No analyzed Demo is selected."}}),
        );
    }
    let winning_side = optional_str(input, "winningSide")?;
    if winning_side.is_some_and(|value| !matches!(value, "T" | "CT")) {
        return Err("winningSide must be T or CT".into());
    }
    let wanted_players = string_set(input, "playerIds", 10)?;
    let wanted_items = string_set(input, "purchasedItems", 12)?
        .into_iter()
        .map(|item| item.to_lowercase())
        .collect::<HashSet<_>>();
    let wanted_rounds = integer_set(input, "roundNumbers", 24)?;
    let wanted_events = event_set(input, "eventKinds")?;
    let maximum = bounded_usize(input, "maximumResults", 24, 1, 24)?;
    let mut matches = Vec::new();
    for round in rounds(&context.analysis) {
        let Some(number) = round_number(round) else {
            continue;
        };
        if !wanted_rounds.is_empty() && !wanted_rounds.contains(&number) {
            continue;
        }
        if winning_side.is_some_and(|side| text(round.get("winner")) != Some(side)) {
            continue;
        }
        let events = round_events(round)
            .filter(|event| event_matches(event, &wanted_events, &wanted_players))
            .collect::<Vec<_>>();
        if (!wanted_events.is_empty() || !wanted_players.is_empty()) && events.is_empty() {
            continue;
        }
        let economy = round_economy(&context.analysis, number);
        if !wanted_items.is_empty() {
            let has_item = economy
                .iter()
                .flat_map(|team| array(team.get("items")))
                .filter_map(|item| text(item.get("name")))
                .any(|item| wanted_items.contains(&item.to_lowercase()));
            if !has_item {
                continue;
            }
        }
        let matched_events = events.into_iter().take(32).map(|event| {
            let id = text(event.get("id")).map_or_else(|| format!("{number}:{}", number_value(event.get("tick")).unwrap_or(0.0)), str::to_owned);
            json!({"evidenceId":format!("event:{demo_id}:{id}"),"tick":event.get("tick"),"kind":event.get("kind"),"actor":event.get("actor"),"target":event.get("target")})
        }).collect::<Vec<_>>();
        matches.push(json!({"evidenceId":format!("round:{demo_id}:{number}"),"round":number,"startTick":round.get("start_tick"),"endTick":round.get("end_tick"),"winner":round.get("winner"),"score":[round.get("team_a_score"),round.get("team_b_score")],"economy":economy,"matchedEvents":matched_events}));
        if matches.len() == maximum {
            break;
        }
    }
    let count = matches.len();
    Ok(
        json!({"available":count > 0,"rounds":matches,"aggregate":{"count":count,"truncated":count == maximum}}),
    )
}

fn read_round_context(context: &AgentContext, input: &Value) -> Result<Value, String> {
    let demo_id = require_selected_demo(context, input)?;
    let wanted = integer_set_required(input, "roundNumbers", 12)?;
    let selected = rounds(&context.analysis).filter_map(|round| {
        let value = round_number(round)?;
        wanted.contains(&value).then(|| json!({"evidenceId":format!("round:{demo_id}:{value}"),"round":value,"startTick":round.get("start_tick"),"endTick":round.get("end_tick"),"winner":round.get("winner"),"reason":round.get("reason"),"score":[round.get("team_a_score"),round.get("team_b_score")],"economy":round_economy(&context.analysis,value) }))
    }).collect::<Vec<_>>();
    Ok(json!({"available":!selected.is_empty(),"rounds":selected}))
}

fn read_round_events(context: &AgentContext, input: &Value) -> Result<Value, String> {
    let demo_id = require_selected_demo(context, input)?;
    let wanted_rounds = integer_set_required(input, "roundNumbers", 24)?;
    let wanted_events = event_set(input, "eventKinds")?;
    let wanted_players = string_set(input, "playerIds", 10)?;
    let maximum = bounded_usize(input, "maximumResults", 128, 1, 256)?;
    let mut all = Vec::new();
    for round in rounds(&context.analysis) {
        let Some(value) = round_number(round) else {
            continue;
        };
        if !wanted_rounds.contains(&value) {
            continue;
        }
        for event in round_events(round)
            .filter(|event| event_matches(event, &wanted_events, &wanted_players))
        {
            let id = text(event.get("id")).map_or_else(
                || format!("{value}:{}", number_value(event.get("tick")).unwrap_or(0.0)),
                str::to_owned,
            );
            all.push(json!({"evidenceId":format!("event:{demo_id}:{id}"),"round":value,"tick":event.get("tick"),"seconds":event.get("seconds"),"kind":event.get("kind"),"actor":event.get("actor"),"target":event.get("target"),"weapon":event.get("weapon"),"headshot":event.get("headshot").and_then(Value::as_bool).unwrap_or(false)}));
        }
    }
    let truncated = all.len() > maximum;
    all.truncate(maximum);
    Ok(json!({"available":!all.is_empty(),"events":all,"truncated":truncated}))
}

fn read_player_matchups(context: &AgentContext, input: &Value) -> Result<Value, String> {
    let demo_id = require_selected_demo(context, input)?;
    let wanted = string_set_required(input, "playerIds", 10)?;
    let mut matchups = Vec::new();
    for value in array(insights(&context.analysis).get("matchups")) {
        let Some(matchup) = value.as_object() else {
            continue;
        };
        let player = text(matchup.get("player_id")).unwrap_or_default();
        let opponent = text(matchup.get("opponent_id")).unwrap_or_default();
        if !wanted.contains(player) && !wanted.contains(opponent) {
            continue;
        }
        let mut result = matchup.clone();
        result.insert(
            "evidenceId".into(),
            Value::String(format!("matchup:{demo_id}:{player}:{opponent}")),
        );
        matchups.push(Value::Object(result));
        if matchups.len() == 100 {
            break;
        }
    }
    if matchups.is_empty() {
        Ok(
            json!({"available":false,"matchups":[],"reason":"No verified matchup evidence is available for those players."}),
        )
    } else {
        Ok(json!({"available":true,"matchups":matchups}))
    }
}

fn read_highlights(context: &AgentContext, input: &Value) -> Result<Value, String> {
    require_authorized_demo_ids(context, input)?;
    let players = string_set(input, "playerIds", 10)?;
    let kinds = string_set(input, "kinds", 12)?;
    let wanted_rounds = integer_set(input, "roundNumbers", 24)?;
    let minimum = bounded_f64(input, "minimumScore", 0.0, 0.0, 1.0)?;
    let maximum = bounded_usize(input, "maximumResults", 32, 1, 64)?;
    let highlights = highlight_evidence(&context.analysis)
        .into_iter()
        .filter(|item| {
            let object = item.as_object().expect("highlight evidence is an object");
            (players.is_empty()
                || text(object.get("playerId")).is_some_and(|value| players.contains(value)))
                && (kinds.is_empty()
                    || text(object.get("kind")).is_some_and(|value| kinds.contains(value)))
                && (wanted_rounds.is_empty()
                    || integer(object.get("round"))
                        .is_some_and(|value| wanted_rounds.contains(&value)))
                && number_value(object.get("score")).unwrap_or(0.0) >= minimum
        })
        .take(maximum)
        .map(|item| {
            let mut object = item
                .as_object()
                .expect("highlight evidence is an object")
                .clone();
            let id = text(object.get("id")).unwrap_or_default();
            let owner = text(object.get("demoId"))
                .or_else(|| text(context.demo.get("id")))
                .unwrap_or("unknown");
            let source = text(object.get("sourceHighlightId")).unwrap_or(id);
            object.insert(
                "evidenceId".into(),
                Value::String(format!("highlight:{owner}:{source}")),
            );
            Value::Object(object)
        })
        .collect::<Vec<_>>();
    Ok(json!({"available":!highlights.is_empty(),"highlights":highlights}))
}

fn read_cinematic_context(
    context: &AgentContext,
    input: &Value,
    external_cinematic: Option<&Value>,
) -> Result<Value, String> {
    require_authorized_demo_ids(context, input)?;
    let ids = string_vec_required(input, "highlightIds", MAXIMUM_VIDEO_PLAN_SHOTS)?;
    let binding = bind_highlights(&context.analysis, &ids);
    if !binding.ready() {
        return Ok(json!({
            "available": false,
            "mapName": context.analysis.get("map_name"),
            "scenes": [],
            "missingHighlightIds": binding.missing,
            "duplicateHighlightIds": binding.duplicates,
            "ambiguousHighlightIds": binding.ambiguous,
        }));
    }
    let map_name = text(context.analysis.get("map_name")).unwrap_or("unknown");
    let radar_transform = context
        .map_context
        .get("transform")
        .filter(|value| value.is_object());
    let scenes = binding
        .selected
        .iter()
        .map(|highlight| {
            let highlight_id = text(highlight.get("id")).unwrap_or("unknown");
            let round = number_value(highlight.get("round"))
                .map(round_to_i64)
                .unwrap_or_default();
            let start_tick = number_value(highlight.get("startTick")).unwrap_or_default();
            let end_tick = number_value(highlight.get("endTick")).unwrap_or_default();
            let replay_scene = external_cinematic
                .and_then(|value| value.get("scenes"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|scene| {
                    text(scene.get("highlightId")) == Some(highlight_id)
                });
            let replay_positioned = replay_scene
                .and_then(|scene| scene.get("positionedAction"))
                .and_then(Value::as_array)
                .filter(|samples| !samples.is_empty());
            let mut positioned = replay_positioned.cloned().unwrap_or_else(|| rounds(&context.analysis)
                .find(|candidate| round_number(candidate) == Some(round))
                .into_iter()
                .flat_map(round_events)
                .filter(|event| {
                    number_value(event.get("tick"))
                        .is_some_and(|tick| tick >= start_tick && tick <= end_tick)
                })
                .filter_map(|event| {
                    let position = event.get("position").and_then(spatial_position)?;
                    let radar_percent = radar_transform
                        .and_then(|transform| world_to_radar_percent(position, transform));
                    Some(json!({
                        "tick": event.get("tick"),
                        "kind": event.get("kind"),
                        "actor": event.get("actor"),
                        "target": event.get("target"),
                        "position": position,
                        "radarPercent": radar_percent,
                    }))
                })
                .take(32)
                .collect::<Vec<_>>());
            for sample in &mut positioned {
                let Some(object) = sample.as_object_mut() else {
                    continue;
                };
                let radar_percent = object
                    .get("position")
                    .and_then(spatial_position)
                    .and_then(|position| {
                        radar_transform.and_then(|transform| {
                            world_to_radar_percent(position, transform)
                        })
                    });
                object.insert("radarPercent".into(), json!(radar_percent));
                if let Some(focus) = object
                    .get("nearestOpponentPosition")
                    .and_then(spatial_position)
                {
                    let focus_percent = radar_transform.and_then(|transform| {
                        world_to_radar_percent(focus, transform)
                    });
                    object.insert("nearestOpponentRadarPercent".into(), json!(focus_percent));
                }
            }
            let mut verified_engagements = replay_scene
                .and_then(|scene| scene.get("verifiedEngagements"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for engagement in &mut verified_engagements {
                let Some(object) = engagement.as_object_mut() else {
                    continue;
                };
                for (position_key, radar_key) in [
                    ("playerPosition", "playerRadarPercent"),
                    ("targetPosition", "targetRadarPercent"),
                ] {
                    let radar_percent = object
                        .get(position_key)
                        .and_then(spatial_position)
                        .and_then(|position| {
                            radar_transform.and_then(|transform| {
                                world_to_radar_percent(position, transform)
                            })
                        });
                    object.insert(radar_key.into(), json!(radar_percent));
                }
            }
            let points = positioned
                .iter()
                .filter_map(|event| event.get("position").and_then(spatial_position))
                .collect::<Vec<_>>();
            let (bounds, movement_distance, movement_axis, spread) = spatial_scene_metrics(&points);
            let victims = array(highlight.get("victims")).count();
            let collision_geometry_available = replay_scene
                .and_then(|scene| scene.get("mapSpace"))
                .and_then(|space| space.get("collisionGeometryAvailable"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut intents = Vec::new();
            if !collision_geometry_available {
                intents.push(json!({
                    "intent":"player_pov",
                    "cameraStyle":"pov",
                    "reason":"Collision geometry is unavailable; use the verified player perspective so walls cannot hide the action."
                }));
            } else if points.is_empty() {
                intents.push(json!({
                    "intent":"player_pov",
                    "cameraStyle":"pov",
                    "reason":"No positioned action is available; preserve verified player perspective."
                }));
            } else {
                if spread > 384.0 {
                    intents.push(json!({
                        "intent":"establish_location",
                        "cameraStyle":"crane",
                        "reason":"The action spans a broad part of the map; establish the route before the kills."
                    }));
                }
                if movement_distance > 192.0 {
                    intents.push(json!({
                        "intent":"follow_entry",
                        "cameraStyle":"tracking",
                        "reason":"The action moves through map space; follow the player's route and engagement direction."
                    }));
                }
                if victims >= 2 && spread <= 384.0 {
                    intents.push(json!({
                        "intent":"hold_crossfire",
                        "cameraStyle":"static",
                        "reason":"Multiple eliminations happen in one compact engagement; hold a readable crossfire angle."
                    }));
                }
                intents.push(json!({
                    "intent":"reveal_duel",
                    "cameraStyle":"dolly",
                    "reason":"Reveal the player-to-opponent lane while keeping the duel readable."
                }));
                if victims >= 3 {
                    intents.push(json!({
                        "intent":"rise_after_climax",
                        "cameraStyle":"crane",
                        "reason":"Use the final elimination as the climax, then widen to show the won space."
                    }));
                }
            }
            json!({
                "highlightId": highlight_id,
                "mapName": map_name,
                "round": round,
                "playerId": highlight.get("playerId"),
                "startTick": start_tick,
                "endTick": end_tick,
                "positionedAction": positioned,
                "mapSpace": {
                    "evidence": if points.is_empty() { "unavailable" } else if replay_positioned.is_some() { "selected_round_replay" } else { "positioned_demo_events" },
                    "bounds": bounds,
                    "spreadUnits": spread,
                    "movementUnits": movement_distance,
                    "movementAxis": movement_axis,
                    "collisionGeometryAvailable": collision_geometry_available,
                    "radarTransformAvailable": radar_transform.is_some(),
                    "replayFidelity": replay_scene.and_then(|scene| scene.get("fidelity")),
                    "verifiedEngagements": verified_engagements,
                },
                "recommendedDesigns": intents,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "available": true,
        "mapName": map_name,
        "coordinateSystem": "CS2 world coordinates",
        "radar": context.map_context,
        "scenes": scenes,
        "designRule": "Use player_pov unless collision geometry is reconstructed and verified. Positioned action alone can aim a camera but cannot prove that walls will not hide the action.",
    }))
}

fn world_to_radar_percent(position: [f64; 3], transform: &Value) -> Option<[f64; 2]> {
    let position_x = number_value(transform.get("pos_x"))?;
    let position_y = number_value(transform.get("pos_y"))?;
    let scale = number_value(transform.get("scale"))?;
    if !position_x.is_finite() || !position_y.is_finite() || !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    // Valve's overview transform already describes the final authored orientation. `rotate`
    // is metadata, not an instruction to rotate these coordinates a second time.
    let x = (position[0] - position_x) / (scale * 1024.0) * 100.0;
    let y = (position_y - position[1]) / (scale * 1024.0) * 100.0;
    (x.is_finite() && y.is_finite()).then_some([x, y])
}

fn spatial_position(value: &Value) -> Option<[f64; 3]> {
    let values = value.as_array()?;
    if values.len() != 3 {
        return None;
    }
    let point = [
        number_value(values.first())?,
        number_value(values.get(1))?,
        number_value(values.get(2))?,
    ];
    point
        .iter()
        .all(|coordinate| coordinate.is_finite())
        .then_some(point)
}

fn spatial_scene_metrics(points: &[[f64; 3]]) -> (Value, f64, Value, f64) {
    let Some(first) = points.first() else {
        return (Value::Null, 0.0, Value::Null, 0.0);
    };
    let mut minimum = *first;
    let mut maximum = *first;
    for point in &points[1..] {
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(point[axis]);
            maximum[axis] = maximum[axis].max(point[axis]);
        }
    }
    let last = points.last().unwrap_or(first);
    let movement = [last[0] - first[0], last[1] - first[1], last[2] - first[2]];
    let movement_distance = movement[0].hypot(movement[1]);
    let spread = (maximum[0] - minimum[0]).hypot(maximum[1] - minimum[1]);
    (
        json!({"minimum":minimum,"maximum":maximum}),
        movement_distance,
        json!(movement),
        spread,
    )
}

fn read_editor_timeline(context: &AgentContext, input: &Value) -> Result<Value, String> {
    require_selected_editor_project(context, input)?;
    let Some(project) = context.editor_project.as_object() else {
        return Ok(json!({"available":false,"project":null}));
    };
    if bool_value(input.get("includeClips"), true) {
        return Ok(json!({"available":true,"project":project}));
    }
    let mut summary = project.clone();
    summary.remove("tracks");
    Ok(json!({"available":true,"project":summary}))
}

fn read_agent_plan(context: &AgentContext, input: &Value) -> Result<Value, String> {
    require_selected_agent_plan(context, input)?;
    Ok(json!({
        "available":true,
        "plan":context.workspace.get("plan")
    }))
}

fn draft_edit_plan(
    context: &AgentContext,
    input: &Value,
) -> Result<(Value, Option<CapturedPlan>), String> {
    require_selected_demo(context, input)?;
    let ids = string_vec_required(input, "highlightIds", 16)?;
    let pacing = enum_value(input, "pacing", &["measured", "energetic", "impact"])?;
    let include = bounded_f64(input, "includeContextSeconds", 2.0, 0.0, 8.0)?;
    let transition = enum_value_default(
        input,
        "transitionStyle",
        "auto",
        &["auto", "cut", "fade", "flash", "slide"],
    )?;
    let binding = bind_highlights(&context.analysis, &ids);
    let tick_rate = number_value(context.analysis.get("tick_rate")).unwrap_or(64.0);
    let resolved = if transition == "auto" {
        match pacing {
            "impact" => "flash",
            "energetic" => "slide",
            _ => "fade",
        }
    } else {
        transition
    };
    let demo_id = text(context.demo.get("id"));
    let mut rejection_reasons = binding.rejection_reasons();
    if demo_id.is_none() {
        rejection_reasons.push("No analyzed Demo is selected.".into());
    }
    let accepted = binding.ready() && demo_id.is_some();
    let clips = if accepted {
        binding.selected.iter().enumerate().map(|(index, item)| {
        let object = item.as_object().expect("highlight object");
        let start = number_value(object.get("startTick")).unwrap_or(0.0);
        let end = number_value(object.get("endTick")).unwrap_or(0.0);
        json!({"sourceHighlightId":object.get("id"),"order":index,"startTick":(start-include*tick_rate).max(0.0).round(),"endTick":(end+include*tick_rate).round(),"transition":if index == 0 {"cut"} else {resolved},"rationale":text(object.get("description")).filter(|value| !value.is_empty()).or_else(|| text(object.get("title"))).unwrap_or("Highlight")})
    }).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let payload = json!({"pacing":pacing,"tickRate":tick_rate,"clips":clips,"missingHighlightIds":binding.missing,"duplicateHighlightIds":binding.duplicates,"ambiguousHighlightIds":binding.ambiguous,"rejectionReasons":rejection_reasons});
    let plan = accepted.then(|| CapturedPlan {
        id: Uuid::new_v4(),
        kind: CapturedPlanKind::HighlightEdit,
        title: "Recorded highlight edit draft".into(),
        payload: json!({
            "demo_id": demo_id,
            "highlight_ids": ids,
            "intent": {
                "pacing": pacing,
                "include_context_seconds": include,
                "transition": resolved
            },
            "target_project_id": null,
            "expected_revision": null,
            "new_project_name": null
        }),
    });
    Ok((json!({"accepted":accepted,"plan":payload}), plan))
}

fn draft_agent_plan_changes(
    context: &AgentContext,
    input: &Value,
) -> Result<(Value, Option<CapturedPlan>), String> {
    require_selected_agent_plan(context, input)?;
    let title = required_str(input, "title")?.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err("title must contain 1 to 200 characters".into());
    }
    let plan = context
        .workspace
        .get("plan")
        .and_then(Value::as_object)
        .ok_or_else(|| "no Agent plan is selected".to_owned())?;
    let shots = plan
        .get("shots")
        .and_then(Value::as_array)
        .ok_or_else(|| "selected Agent plan has no shots".to_owned())?;
    let requested = input
        .get("changes")
        .and_then(Value::as_array)
        .filter(|changes| !changes.is_empty() && changes.len() <= 16)
        .ok_or_else(|| "changes must contain 1 to 16 entries".to_owned())?;
    let mut targets = HashSet::new();
    let mut changes = Vec::with_capacity(requested.len());
    for raw in requested {
        let object = raw
            .as_object()
            .ok_or_else(|| "each change must be an object".to_owned())?;
        let op = required_str(raw, "op")?;
        if !matches!(op, "shorten" | "delete") {
            return Err("change op must be shorten or delete".into());
        }
        let target = required_str(raw, "target")?;
        if !targets.insert(target) {
            return Err(format!(
                "shot {target} may be changed only once per proposal"
            ));
        }
        let shot = shots
            .iter()
            .find(|shot| shot.get("id").and_then(Value::as_str) == Some(target))
            .ok_or_else(|| format!("target shot {target} is not in the selected plan"))?;
        if !shot.get("removed_by").is_none_or(Value::is_null) {
            return Err(format!("target shot {target} is already removed"));
        }
        let current = shot
            .get("duration_seconds")
            .and_then(Value::as_f64)
            .filter(|duration| duration.is_finite() && *duration >= 0.0)
            .ok_or_else(|| format!("target shot {target} has no valid duration"))?;
        let rationale = required_str(raw, "rationale")?.trim();
        if rationale.is_empty() || rationale.chars().count() > 400 {
            return Err("change rationale must contain 1 to 400 characters".into());
        }
        let warning = object
            .get("warning")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_str()
                    .filter(|warning| warning.chars().count() <= 400)
                    .ok_or_else(|| {
                        "change warning must be null or at most 400 characters".to_owned()
                    })
            })
            .transpose()?;
        let delta = if op == "delete" {
            -current
        } else {
            let delta = object
                .get("deltaSeconds")
                .and_then(Value::as_f64)
                .filter(|delta| delta.is_finite() && *delta < 0.0)
                .ok_or_else(|| "shorten requires a finite negative deltaSeconds".to_owned())?;
            if current + delta < 0.01 {
                return Err(format!(
                    "shortening shot {target} would remove its whole duration"
                ));
            }
            delta
        };
        let after = (op == "shorten").then(|| format!("{:.1}s", current + delta));
        changes.push(json!({
            "id": Uuid::new_v4(),
            "op": op,
            "target": target,
            "before": format!("{current:.1}s"),
            "after": after,
            "delta_seconds": delta,
            "rationale": rationale,
            "warning": warning,
        }));
    }
    let payload = json!({ "changes": changes });
    Ok((
        json!({ "accepted": true, "plan": payload }),
        Some(CapturedPlan {
            id: Uuid::new_v4(),
            kind: CapturedPlanKind::AgentPlanChange,
            title: title.to_owned(),
            payload,
        }),
    ))
}

fn overlapping_highlight_pairs(highlights: &[Value]) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for (index, first) in highlights.iter().enumerate() {
        for second in highlights.iter().skip(index + 1) {
            if text(first.get("demoId")) != text(second.get("demoId"))
                || text(first.get("playerId")) != text(second.get("playerId"))
                || number_value(first.get("round")) != number_value(second.get("round"))
            {
                continue;
            }
            let first_start = number_value(first.get("startTick")).unwrap_or_default();
            let first_end = number_value(first.get("endTick")).unwrap_or(first_start);
            let second_start = number_value(second.get("startTick")).unwrap_or_default();
            let second_end = number_value(second.get("endTick")).unwrap_or(second_start);
            let shorter = (first_end - first_start)
                .max(0.0)
                .min((second_end - second_start).max(0.0));
            if shorter <= 0.0 {
                continue;
            }
            let overlap = first_end.min(second_end) - first_start.max(second_start);
            if overlap.max(0.0) / shorter < 0.8 {
                continue;
            }
            pairs.push((
                text(first.get("id")).unwrap_or("unknown").to_owned(),
                text(second.get("id")).unwrap_or("unknown").to_owned(),
            ));
        }
    }
    pairs
}

fn draft_video_plan(
    context: &AgentContext,
    input: &Value,
    external_cinematic: Option<&Value>,
) -> Result<(Value, Option<CapturedPlan>), String> {
    require_authorized_demo_ids(context, input)?;
    let title = required_str(input, "title")?.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err("video title must contain 1 to 200 characters".into());
    }
    let ids = string_vec_required(input, "highlightIds", MAXIMUM_VIDEO_PLAN_SHOTS)?;
    let duration_target_is_explicit = input.get("targetDurationSeconds").is_some();
    let target_duration_seconds = bounded_f64(
        input,
        "targetDurationSeconds",
        DEFAULT_VIDEO_TARGET_SECONDS,
        5.0,
        3_600.0,
    )?;
    let pacing = enum_value(input, "pacing", &["energetic", "impact", "cinematic"])?;
    let story_roles = optional_enum_vec(
        input,
        "storyRoles",
        MAXIMUM_VIDEO_PLAN_SHOTS,
        &["hook", "build", "climax"],
    )?;
    if story_roles.len() != ids.len() {
        return Err("storyRoles must match highlightIds length".into());
    }
    let transition_style =
        enum_value(input, "transitionStyle", &["cut", "flash", "fade", "slide"])?;
    let lead = bounded_f64(input, "leadSeconds", 2.5, 0.5, 8.0)?;
    let tail = bounded_f64(input, "tailSeconds", 2.0, 0.5, 8.0)?;
    let allowed_camera_styles = [
        "pov", "orbit", "dolly", "static", "tracking", "crane", "flyby",
    ];
    let _ = enum_value_default(input, "cameraStyle", "pov", &allowed_camera_styles)?;
    let camera_styles = optional_enum_vec(
        input,
        "cameraStyles",
        MAXIMUM_VIDEO_PLAN_SHOTS,
        &allowed_camera_styles,
    )?;
    if !camera_styles.is_empty() && camera_styles.len() != ids.len() {
        return Err("cameraStyles must be empty or match highlightIds length".into());
    }
    let allowed_camera_intents = [
        "player_pov",
        "establish_location",
        "follow_entry",
        "reveal_duel",
        "hold_crossfire",
        "rise_after_climax",
        "transition_through_space",
    ];
    let camera_intents = optional_enum_vec(
        input,
        "cameraIntents",
        MAXIMUM_VIDEO_PLAN_SHOTS,
        &allowed_camera_intents,
    )?;
    let camera_rationales =
        string_vec_required(input, "cameraRationales", MAXIMUM_VIDEO_PLAN_SHOTS)?;
    if camera_intents.len() != ids.len() || camera_rationales.len() != ids.len() {
        return Err("cameraIntents and cameraRationales must match highlightIds length".into());
    }
    let requested_camera_styles = ids
        .iter()
        .enumerate()
        .map(|(index, _)| {
            camera_styles.get(index).map_or_else(
                || camera_style_for_intent(&camera_intents[index]).to_owned(),
                Clone::clone,
            )
        })
        .collect::<Vec<_>>();
    for ((intent, style), rationale) in camera_intents
        .iter()
        .zip(&requested_camera_styles)
        .zip(&camera_rationales)
    {
        if !camera_style_supports_intent(intent, style) {
            return Err(format!(
                "camera style {style} does not express camera intent {intent}"
            ));
        }
        if rationale.trim().chars().count() < 8 {
            return Err("each camera rationale must explain a concrete map-space purpose".into());
        }
    }
    let binding = bind_highlights(&context.analysis, &ids);
    let demo_id = text(context.demo.get("id"));
    let primary_demo_id = demo_id.and_then(|value| Uuid::parse_str(value).ok());
    let resolved_demo_ids = binding
        .selected
        .iter()
        .map(|item| {
            text(item.get("demoId"))
                .and_then(|value| Uuid::parse_str(value).ok())
                .or(primary_demo_id)
        })
        .collect::<Vec<_>>();
    let missing_players = binding
        .selected
        .iter()
        .filter(|item| text(item.get("playerId")).is_none_or(str::is_empty))
        .map(|item| text(item.get("id")).unwrap_or("unknown").to_owned())
        .collect::<Vec<_>>();
    let overlapping_highlights = overlapping_highlight_pairs(&binding.selected);
    let mut accepted = binding.ready()
        && resolved_demo_ids.iter().all(Option::is_some)
        && missing_players.is_empty()
        && overlapping_highlights.is_empty();
    let cinematic_context = external_cinematic
        .ok_or_else(|| "draft_video_plan requires explicit cinematic Evidence".to_owned())?;
    let scenes = cinematic_context
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut resolved_camera_intents = camera_intents.clone();
    let mut resolved_camera_styles = requested_camera_styles;
    let mut resolved_camera_rationales = camera_rationales.clone();
    let mut safety_fallbacks = vec![None; ids.len()];
    for (index, highlight_id) in ids.iter().enumerate() {
        let collision_geometry_available = scenes
            .iter()
            .find(|scene| text(scene.get("highlightId")) == Some(highlight_id))
            .and_then(|scene| scene.get("mapSpace"))
            .and_then(|space| space.get("collisionGeometryAvailable"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if resolved_camera_styles[index] != "pov" && !collision_geometry_available {
            "player_pov".clone_into(&mut resolved_camera_intents[index]);
            "pov".clone_into(&mut resolved_camera_styles[index]);
            "Use the verified player perspective because collision geometry is unavailable; an external camera could be hidden behind map walls."
                .clone_into(&mut resolved_camera_rationales[index]);
            safety_fallbacks[index] = Some("collision_geometry_unavailable");
        }
    }
    let items = if accepted {
        binding
            .selected
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let item_camera_style = &resolved_camera_styles[index];
                let mut action_handle = if safety_fallbacks[index].is_some() {
                    0.5
                } else {
                    lead
                };
                let mut action_tail = if safety_fallbacks[index].is_some() {
                    0.5
                } else {
                    tail
                };
                let tick_rate = number_value(item.get("tickRate")).unwrap_or(64.0);
                let source_start_tick = number_value(item.get("startTick")).unwrap_or_default();
                let source_end_tick = number_value(item.get("endTick")).unwrap_or_default();
                let scene = scenes
                    .iter()
                    .find(|scene| text(scene.get("highlightId")) == Some(ids[index].as_str()));
                let engagement_ticks = scene
                    .and_then(|scene| scene.get("mapSpace"))
                    .and_then(|space| space.get("verifiedEngagements"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|engagement| number_value(engagement.get("tick")))
                    .collect::<Vec<_>>();
                let positioned_kill_ticks = scene
                    .and_then(|scene| scene.get("positionedAction"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|event| text(event.get("kind")) == Some("kill"))
                    .filter_map(|event| number_value(event.get("tick")))
                    .collect::<Vec<_>>();
                let action_ticks = if engagement_ticks.is_empty() {
                    &positioned_kill_ticks
                } else {
                    &engagement_ticks
                };
                let requested_start_tick = action_ticks
                    .iter()
                    .copied()
                    .reduce(f64::min)
                    .map_or(source_start_tick, |tick| {
                        (tick - tick_rate * 0.25).max(source_start_tick)
                    });
                let requested_end_tick = action_ticks
                    .iter()
                    .copied()
                    .reduce(f64::max)
                    .map_or(source_end_tick, |tick| {
                        (tick + tick_rate * 0.25).min(source_end_tick)
                    });
                let action_count = array(item.get("victims"))
                    .count()
                    .max(action_ticks.len())
                    .max(1);
                let base_duration =
                    ((requested_end_tick - requested_start_tick) / tick_rate).max(0.0);
                let maximum_shot_seconds = match action_count {
                    3.. => 8.0,
                    2 => 7.0,
                    _ => 4.5,
                };
                let handle_budget = (maximum_shot_seconds - base_duration).max(0.0);
                let requested_handles = action_handle + action_tail;
                if requested_handles > handle_budget && requested_handles > 0.0 {
                    let scale = handle_budget / requested_handles;
                    action_handle *= scale;
                    action_tail *= scale;
                }
                let fidelity = scene
                    .and_then(|scene| scene.get("mapSpace"))
                    .and_then(|space| space.get("replayFidelity"));
                let artifact_start = fidelity
                    .and_then(|value| number_value(value.get("artifactStartTick")));
                let artifact_end = fidelity
                    .and_then(|value| number_value(value.get("artifactEndTick")));
                let start_tick = artifact_start
                    .map_or(requested_start_tick, |boundary| requested_start_tick.max(boundary));
                let end_tick = artifact_end
                    .map_or(requested_end_tick, |boundary| requested_end_tick.min(boundary));
                let effective_pre_roll = artifact_start.map_or(action_handle, |boundary| {
                    action_handle.min(((start_tick - boundary) / tick_rate).max(0.0))
                });
                let effective_post_roll = artifact_end.map_or(action_tail, |boundary| {
                    action_tail.min(((boundary - end_tick) / tick_rate).max(0.0))
                });
                json!({
                    "id": Uuid::new_v4(),
                    "demo_id": resolved_demo_ids[index],
                    "highlight_id": text(item.get("sourceHighlightId")).or_else(||text(item.get("id"))),
                    "player_id": text(item.get("playerId")),
                    "title": text(item.get("title")).unwrap_or("Highlight video"),
                    "start_tick": round_to_tick(start_tick),
                    "end_tick": round_to_tick(end_tick.max(start_tick)),
                    "pre_roll_seconds": effective_pre_roll,
                    "post_roll_seconds": effective_post_roll,
                    "victim_pov": false,
                    "camera_style": item_camera_style
                })
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let selected_duration_seconds = items
        .iter()
        .zip(&binding.selected)
        .map(|(item, highlight)| {
            let start = number_value(item.get("start_tick")).unwrap_or_default();
            let end = number_value(item.get("end_tick")).unwrap_or(start);
            let tick_rate = number_value(highlight.get("tickRate"))
                .filter(|value| *value > 0.0)
                .unwrap_or(64.0);
            (end - start).max(0.0) / tick_rate
                + number_value(item.get("pre_roll_seconds")).unwrap_or_default()
                + number_value(item.get("post_roll_seconds")).unwrap_or_default()
        })
        .sum::<f64>();
    let minimum_target_seconds = target_duration_seconds * MINIMUM_VIDEO_TARGET_COVERAGE;
    let duration_target_met = !duration_target_is_explicit
        || selected_duration_seconds + f64::EPSILON >= minimum_target_seconds;
    if !duration_target_met {
        accepted = false;
    }
    for (index, intent) in resolved_camera_intents.iter().enumerate() {
        let has_spatial_evidence = scenes
            .iter()
            .find(|scene| text(scene.get("highlightId")) == Some(ids[index].as_str()))
            .and_then(|scene| scene.get("mapSpace"))
            .and_then(|space| space.get("evidence"))
            .and_then(Value::as_str)
            .is_some_and(|evidence| {
                matches!(evidence, "positioned_demo_events" | "selected_round_replay")
            });
        if !has_spatial_evidence && intent != "player_pov" {
            return Err(format!(
                "highlight {} has no positioned map-space evidence; cameraIntent must be player_pov",
                ids[index]
            ));
        }
    }
    let shot_designs = if accepted {
        ids.iter()
            .enumerate()
            .map(|(index, id)| {
                let item = &items[index];
                let item_start = number_value(item.get("start_tick")).unwrap_or_default();
                let item_end = number_value(item.get("end_tick")).unwrap_or(item_start);
                let item_rate = number_value(binding.selected[index].get("tickRate"))
                    .unwrap_or(64.0);
                let final_duration_seconds = (item_end - item_start).max(0.0) / item_rate
                    + number_value(item.get("pre_roll_seconds")).unwrap_or_default()
                    + number_value(item.get("post_roll_seconds")).unwrap_or_default();
                json!({
                    "highlight_id": text(binding.selected[index].get("sourceHighlightId")).unwrap_or(id),
                    "evidence_id": id,
                    "demo_id": resolved_demo_ids[index],
                    "map_name": binding.selected[index].get("mapName").or_else(||context.analysis.get("map_name")),
                    "tick_rate": binding.selected[index].get("tickRate").or_else(||context.analysis.get("tick_rate")),
                    "camera_intent": resolved_camera_intents[index],
                    "camera_style": resolved_camera_styles[index],
                    "story_role": story_roles[index],
                    "rationale": resolved_camera_rationales[index],
                    "spatial_evidence": scenes.iter().find(|scene| text(scene.get("highlightId")) == Some(id.as_str())),
                    "requires_user_review": true,
                    "safety_fallback": safety_fallbacks[index],
                    "requested_timing": {"lead_seconds": lead, "tail_seconds": tail},
                    "effective_timing": {
                        "start_tick": items[index].get("start_tick"),
                        "end_tick": items[index].get("end_tick"),
                        "lead_seconds": items[index].get("pre_roll_seconds"),
                        "tail_seconds": items[index].get("post_roll_seconds"),
                    },
                    "timing_clipped": items[index].get("pre_roll_seconds").and_then(Value::as_f64) != Some(lead)
                        || items[index].get("post_roll_seconds").and_then(Value::as_f64) != Some(tail),
                    "action_count": array(binding.selected[index].get("victims")).count().max(1),
                    "final_duration_seconds": final_duration_seconds,
                    "video_presentation": {
                        "pacing": pacing,
                        "transition_style": transition_style,
                        "target_duration_seconds": target_duration_seconds,
                        "selected_duration_seconds": selected_duration_seconds,
                        "duration_target_met": duration_target_met,
                        "intro_seconds": match pacing { "energetic" => 0.65, "impact" => 0.8, _ => 1.0 },
                        "include_name_cards": true,
                        "name_card_seconds": 1.1,
                        "branding_theme": if pacing == "energetic" { "neon" } else { "broadcast" }
                    }
                })
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut rejection_reasons = binding.rejection_reasons();
    for (first, second) in &overlapping_highlights {
        rejection_reasons.push(format!(
            "Highlights {first} and {second} substantially overlap; merge them or keep only one."
        ));
    }
    if !duration_target_met {
        rejection_reasons.push(format!(
            "The selected non-overlapping footage covers {selected_duration_seconds:.1} seconds, below the required {minimum_target_seconds:.1} seconds for a {target_duration_seconds:.1}-second target."
        ));
    }
    if resolved_demo_ids.iter().any(Option::is_none) {
        rejection_reasons
            .push("The selected Demo does not have a valid persistent identifier.".into());
    }
    for highlight_id in &missing_players {
        rejection_reasons.push(format!(
            "Highlight {highlight_id} has no verified player identifier."
        ));
    }
    let payload = json!({
        "items": items,
        "shot_designs": shot_designs,
        "output": {"container":"mp4","title":title},
        "presentation": {
            "pacing": pacing,
            "transition_style": transition_style,
            "target_duration_seconds": target_duration_seconds,
            "selected_duration_seconds": selected_duration_seconds,
            "duration_target_met": duration_target_met,
            "intro_seconds": match pacing { "energetic" => 0.65, "impact" => 0.8, _ => 1.0 },
            "include_name_cards": true,
            "name_card_seconds": 1.1,
            "branding_theme": if pacing == "energetic" { "neon" } else { "broadcast" }
        },
        "source_highlight_ids": if accepted { ids.clone() } else { Vec::new() },
        "requires_user_confirmation": true
    });
    let plan = accepted.then(|| CapturedPlan {
        id: Uuid::new_v4(),
        kind: CapturedPlanKind::VideoRender,
        title: title.to_owned(),
        payload: payload.clone(),
    });
    Ok((
        json!({
            "accepted": accepted,
            "plan": payload,
            "rejectionReasons": rejection_reasons,
            "targetDurationSeconds": target_duration_seconds,
            "selectedDurationSeconds": selected_duration_seconds,
            "durationTargetMet": duration_target_met,
            "delivery": "mp4",
            "captureEngine": "managed_hlae"
        }),
        plan,
    ))
}

fn camera_style_for_intent(intent: &str) -> &'static str {
    match intent {
        "establish_location" | "hold_crossfire" => "static",
        "follow_entry" => "tracking",
        "reveal_duel" => "dolly",
        "rise_after_climax" => "crane",
        "transition_through_space" => "flyby",
        // `player_pov`, plus anything outside the validated intent set, keeps
        // the first-person camera.
        _ => "pov",
    }
}

fn camera_style_supports_intent(intent: &str, style: &str) -> bool {
    match intent {
        "player_pov" => style == "pov",
        "establish_location" => matches!(style, "static" | "crane"),
        "follow_entry" => matches!(style, "tracking" | "dolly"),
        "reveal_duel" => matches!(style, "dolly" | "orbit"),
        "hold_crossfire" => style == "static",
        "rise_after_climax" => style == "crane",
        "transition_through_space" => style == "flyby",
        _ => false,
    }
}

fn project_audio_evidence(analysis: &Value, view: &str) -> Result<Value, String> {
    let analysis = analysis
        .as_object()
        .ok_or_else(|| "audio analysis host returned an invalid object".to_owned())?;
    let summary = json!({
        "duration_seconds": analysis.get("duration_seconds"),
        "analysis_sample_rate": analysis.get("analysis_sample_rate"),
        "bpm": analysis.get("bpm"),
        "tempo_confidence": analysis.get("tempo_confidence"),
        "beat_count": analysis.get("beats").and_then(Value::as_array).map_or(0, Vec::len),
        "onset_count": analysis.get("onsets").and_then(Value::as_array).map_or(0, Vec::len),
        "sections": analysis.get("sections"),
        "rhythm_diagnostics": analysis.get("rhythm_diagnostics"),
        "limitations": analysis.get("limitations"),
    });
    if view == "summary" {
        return Ok(json!({"available":true,"view":"summary","evidence":summary}));
    }
    let energy = analysis
        .get("energy")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |points| bounded_even_samples(points, 128));
    Ok(json!({
        "available": true,
        "view": "rhythm_map",
        "evidence": {
            "summary": summary,
            "energy": energy,
            "spectral_map": analysis.get("spectral_map"),
        }
    }))
}

fn bounded_even_samples(values: &[Value], maximum: usize) -> Vec<Value> {
    if values.len() <= maximum {
        return values.to_vec();
    }
    (0..maximum)
        .map(|index| values[index * values.len() / maximum].clone())
        .collect()
}

#[derive(Debug)]
struct HighlightBinding {
    selected: Vec<Value>,
    missing: Vec<String>,
    duplicates: Vec<String>,
    ambiguous: Vec<String>,
}

impl HighlightBinding {
    fn ready(&self) -> bool {
        self.missing.is_empty()
            && self.duplicates.is_empty()
            && self.ambiguous.is_empty()
            && !self.selected.is_empty()
    }
    fn rejection_reasons(&self) -> Vec<String> {
        let mut result = Vec::new();
        if !self.missing.is_empty() {
            result.push(format!(
                "Missing highlight evidence: {}",
                self.missing.join(", ")
            ));
        }
        if !self.duplicates.is_empty() {
            result.push(format!(
                "Duplicate requested highlight IDs: {}",
                self.duplicates.join(", ")
            ));
        }
        if !self.ambiguous.is_empty() {
            result.push(format!(
                "Highlight IDs are ambiguous in the current analysis: {}",
                self.ambiguous.join(", ")
            ));
        }
        result
    }
}

fn bind_highlights(analysis: &Value, ids: &[String]) -> HighlightBinding {
    let mut by_id: HashMap<String, Vec<Value>> = HashMap::new();
    for item in highlight_evidence(analysis) {
        if let Some(id) = text(item.get("id")) {
            by_id.entry(id.into()).or_default().push(item);
        }
    }
    let mut seen = HashSet::new();
    let duplicates = unique(ids.iter().filter(|id| !seen.insert((*id).clone())).cloned());
    let missing = unique(ids.iter().filter(|id| !by_id.contains_key(*id)).cloned());
    let ambiguous = unique(
        ids.iter()
            .filter(|id| by_id.get(*id).is_some_and(|items| items.len() > 1))
            .cloned(),
    );
    let selected = ids
        .iter()
        .filter_map(|id| {
            by_id
                .get(id)
                .filter(|items| items.len() == 1)
                .and_then(|items| items.first())
                .cloned()
        })
        .collect();
    HighlightBinding {
        selected,
        missing,
        duplicates,
        ambiguous,
    }
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn highlight_evidence(analysis: &Value) -> Vec<Value> {
    array(analysis.get("highlights")).filter_map(|value| {
        let item = value.as_object()?;
        let id = text(item.get("id"))?;
        let start = number_value(item.get("start_tick"))?;
        let end = number_value(item.get("end_tick"))?;
        Some(json!({"id":id,"sourceHighlightId":text(item.get("source_highlight_id")).unwrap_or(id),"demoId":item.get("demo_id"),"mapName":item.get("map_name").or_else(||analysis.get("map_name")),"tickRate":item.get("tick_rate").or_else(||analysis.get("tick_rate")),"kind":text(item.get("kind")).unwrap_or_default(),"title":text(item.get("title")).or_else(||text(item.get("label"))).unwrap_or("Highlight"),"playerId":text(item.get("player_id")).unwrap_or_default(),"round":number_value(item.get("round")),"startTick":start,"endTick":end,"score":number_value(item.get("score")).or_else(||number_value(item.get("confidence"))),"description":text(item.get("description")).unwrap_or_default(),"victims":array(item.get("victims")).filter_map(Value::as_str).collect::<Vec<_>>(),"tags":array(item.get("tags")).filter_map(Value::as_str).collect::<Vec<_>>() }))
    }).collect()
}

fn rounds(analysis: &Value) -> impl Iterator<Item = &Map<String, Value>> {
    array(analysis.get("rounds")).filter_map(Value::as_object)
}
fn round_number(round: &Map<String, Value>) -> Option<i64> {
    integer(round.get("number"))
}
fn round_events(round: &Map<String, Value>) -> impl Iterator<Item = &Map<String, Value>> {
    array(round.get("events")).filter_map(Value::as_object)
}
fn insights(analysis: &Value) -> &Map<String, Value> {
    match analysis.get("insights").and_then(Value::as_object) {
        Some(value) => value,
        None => empty_map(),
    }
}
fn empty_map() -> &'static Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    EMPTY.get_or_init(Map::new)
}
fn round_economy(analysis: &Value, round: i64) -> Vec<Value> {
    array(insights(analysis).get("round_economy"))
        .find(|value| integer(value.get("round")) == Some(round))
        .map_or_else(Vec::new, |value| {
            array(value.get("teams")).cloned().collect()
        })
}
fn event_matches(
    event: &Map<String, Value>,
    kinds: &HashSet<String>,
    players: &HashSet<String>,
) -> bool {
    if !kinds.is_empty() && !text(event.get("kind")).is_some_and(|kind| kinds.contains(kind)) {
        return false;
    }
    players.is_empty()
        || [event.get("actor"), event.get("target")]
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|id| players.contains(id))
}

fn array(value: Option<&Value>) -> impl Iterator<Item = &Value> {
    value.and_then(Value::as_array).into_iter().flatten()
}
fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}
fn number_value(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}
/// Rounds a tool-supplied JSON number to the nearest signed integer.
///
/// Tool arguments arrive as JSON numbers, so they are only available as `f64`.
/// A float-to-integer `as` cast saturates at the target bounds instead of
/// wrapping, which is the clamp we want for values we do not control.
#[expect(
    clippy::cast_possible_truncation,
    reason = "the saturating float-to-int cast is the intended clamp for tool-supplied numbers"
)]
fn round_to_i64(value: f64) -> i64 {
    value.round() as i64
}
/// Rounds a tool-supplied JSON number to the nearest tick.
///
/// Ticks are non-negative; `max(0.0)` states that domain explicitly and the
/// saturating `as` cast clamps anything beyond `u64::MAX` rather than wrapping.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "ticks are clamped into the non-negative range before the saturating cast"
)]
fn round_to_tick(value: f64) -> u64 {
    value.round().max(0.0) as u64
}
fn integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).or_else(|| {
        value
            .and_then(Value::as_u64)
            .and_then(|value| i64::try_from(value).ok())
    })
}
fn bool_value(value: Option<&Value>, default: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(default)
}
fn required_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    optional_str(input, key)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} is required"))
}
fn optional_str<'a>(input: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        _ => Err(format!("{key} must be a string")),
    }
}
fn enum_value<'a>(input: &'a Value, key: &str, allowed: &[&str]) -> Result<&'a str, String> {
    let value = required_str(input, key)?;
    allowed
        .contains(&value)
        .then_some(value)
        .ok_or_else(|| format!("{key} has an unsupported value"))
}
fn enum_value_default<'a>(
    input: &'a Value,
    key: &str,
    default: &'a str,
    allowed: &[&str],
) -> Result<&'a str, String> {
    match optional_str(input, key)? {
        Some(value) => allowed
            .contains(&value)
            .then_some(value)
            .ok_or_else(|| format!("{key} has an unsupported value")),
        None => Ok(default),
    }
}
fn optional_enum_vec(
    input: &Value,
    key: &str,
    maximum: usize,
    allowed: &[&str],
) -> Result<Vec<String>, String> {
    let Some(value) = input.get(key) else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    if values.len() > maximum {
        return Err(format!("{key} exceeds the maximum item count"));
    }
    values
        .iter()
        .map(|value| {
            let value = value
                .as_str()
                .ok_or_else(|| format!("{key} must contain only strings"))?;
            allowed
                .contains(&value)
                .then(|| value.to_owned())
                .ok_or_else(|| format!("{key} has an unsupported value"))
        })
        .collect()
}
fn bounded_usize(
    input: &Value,
    key: &str,
    default: usize,
    min: usize,
    max: usize,
) -> Result<usize, String> {
    let value = input
        .get(key)
        .and_then(Value::as_u64)
        .map_or(default, |value| {
            usize::try_from(value).unwrap_or(usize::MAX)
        });
    (min..=max)
        .contains(&value)
        .then_some(value)
        .ok_or_else(|| format!("{key} is outside the allowed range"))
}
fn bounded_f64(input: &Value, key: &str, default: f64, min: f64, max: f64) -> Result<f64, String> {
    let value = number_value(input.get(key)).unwrap_or(default);
    (min..=max)
        .contains(&value)
        .then_some(value)
        .ok_or_else(|| format!("{key} is outside the allowed range"))
}
fn string_vec_required(input: &Value, key: &str, max: usize) -> Result<Vec<String>, String> {
    let values = string_vec(input, key, max)?;
    if values.is_empty() {
        Err(format!("{key} must not be empty"))
    } else {
        Ok(values)
    }
}
fn string_vec(input: &Value, key: &str, max: usize) -> Result<Vec<String>, String> {
    let Some(value) = input.get(key) else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    if values.len() > max {
        return Err(format!("{key} contains too many values"));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 128)
                .map(str::to_owned)
                .ok_or_else(|| format!("{key} contains an invalid string"))
        })
        .collect()
}
fn string_set(input: &Value, key: &str, max: usize) -> Result<HashSet<String>, String> {
    Ok(string_vec(input, key, max)?.into_iter().collect())
}
fn string_set_required(input: &Value, key: &str, max: usize) -> Result<HashSet<String>, String> {
    Ok(string_vec_required(input, key, max)?.into_iter().collect())
}
fn integer_set(input: &Value, key: &str, max: usize) -> Result<HashSet<i64>, String> {
    let Some(value) = input.get(key) else {
        return Ok(HashSet::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    if values.len() > max {
        return Err(format!("{key} contains too many values"));
    }
    values
        .iter()
        .map(|value| {
            integer(Some(value))
                .filter(|value| *value > 0)
                .ok_or_else(|| format!("{key} contains an invalid round"))
        })
        .collect()
}
fn integer_set_required(input: &Value, key: &str, max: usize) -> Result<HashSet<i64>, String> {
    let values = integer_set(input, key, max)?;
    if values.is_empty() {
        Err(format!("{key} must not be empty"))
    } else {
        Ok(values)
    }
}
fn event_set(input: &Value, key: &str) -> Result<HashSet<String>, String> {
    let values = string_set(input, key, 9)?;
    let allowed = [
        "round_start",
        "round_end",
        "kill",
        "damage",
        "bomb_plant",
        "bomb_defuse",
        "bomb_explode",
        "grenade",
        "purchase",
    ];
    if values.iter().all(|value| allowed.contains(&value.as_str())) {
        Ok(values)
    } else {
        Err(format!("{key} contains an unsupported event kind"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Debug, Default)]
    struct FixedToolHost {
        audio_reads: AtomicUsize,
        alignment_drafts: AtomicUsize,
    }

    #[async_trait]
    impl AgentToolHost for FixedToolHost {
        async fn read_cinematic_context(&self, _highlight_ids: &[String]) -> Result<Value, String> {
            Ok(json!({"scenes":[]}))
        }

        async fn read_audio_analysis(&self, _audio_asset_id: Uuid) -> Result<Value, String> {
            self.audio_reads.fetch_add(1, Ordering::SeqCst);
            Ok(json!({
                "duration_seconds":10.0,"analysis_sample_rate":11025,"bpm":120.0,
                "tempo_confidence":0.9,"beats":[{"index":0}],"onsets":[],"energy":[],
                "sections":[],"spectral_map":{"floor_db":-80.0,"bands":[],"points":[]},
                "rhythm_diagnostics":{"onset_rate_per_second":0.0,"strong_onset_rate_per_second":0.0,"dynamic_range_db":0.0,"silence_ratio":0.0,"silence_regions":[],"recommended_cut_points":[]},
                "limitations":[]
            }))
        }

        async fn draft_beat_alignment(
            &self,
            editor_project_id: Uuid,
            expected_revision: u64,
            audio_asset_id: Uuid,
            audio_placement: Value,
        ) -> Result<Value, String> {
            self.alignment_drafts.fetch_add(1, Ordering::SeqCst);
            Ok(json!({
                "project_id":editor_project_id,"expected_revision":expected_revision,
                "audio_asset_id":audio_asset_id,"audio_placement":audio_placement,
                "draft":{"advisory_only":true,"clips":[],"unplaced_clip_ids":[],"constraints":[]}
            }))
        }
    }

    fn context() -> AgentContext {
        AgentContext {
            workspace: json!({"demoIds":["demo-1"],"resources":{}}),
            demo: json!({"id":"demo-1"}),
            map_context: json!({
                "map_name":"de_mirage",
                "transform":{"pos_x":-2000.0,"pos_y":1500.0,"scale":4.0,"rotate":false}
            }),
            analysis: json!({
                "map_name":"de_mirage",
                "tick_rate":64,
                "highlights":[{"id":"ace-1","kind":"ace","title":"ACE","round":1,"start_tick":640,"end_tick":1280,"description":"five kills"}],
                "rounds":[{"number":1,"events":[
                    {"tick":700,"kind":"kill","actor":"player-1","target":"enemy-1","position":[-1000.0,500.0,32.0]},
                    {"tick":1100,"kind":"kill","actor":"player-1","target":"enemy-2","position":[-720.0,620.0,40.0]}
                ]}]
            }),
            ..AgentContext::default()
        }
    }

    fn authorize_demos(context: &mut AgentContext, ids: &[&str]) {
        context.workspace["demoIds"] = json!(ids);
    }

    #[test]
    fn audio_tools_separate_compact_summary_from_bounded_rhythm_map() {
        let analysis = json!({
            "duration_seconds": 120.0, "analysis_sample_rate": 11_025,
            "bpm": 128.0, "tempo_confidence": 0.91,
            "beats": (0..300).map(|index| json!({"index":index})).collect::<Vec<_>>(),
            "onsets": (0..400).map(|index| json!({"time_seconds":f64::from(index) * 0.2})).collect::<Vec<_>>(),
            "energy": (0..256).map(|index| json!({"time_seconds":index,"rms":0.5,"peak":0.8})).collect::<Vec<_>>(),
            "sections": [], "spectral_map": {"floor_db":-80.0,"bands":[],"points":[]},
            "rhythm_diagnostics": {"onset_rate_per_second":3.3,"strong_onset_rate_per_second":1.2,"dynamic_range_db":8.0,"silence_ratio":0.0,"silence_regions":[],"recommended_cut_points":[]},
            "limitations": ["test limitation"]
        });
        let summary = project_audio_evidence(&analysis, "summary").unwrap();
        assert_eq!(summary["evidence"]["beat_count"], 300);
        assert_eq!(summary["evidence"]["onset_count"], 400);
        assert!(summary["evidence"].get("beats").is_none());
        let rhythm_map = project_audio_evidence(&analysis, "rhythm_map").unwrap();
        assert_eq!(
            rhythm_map["evidence"]["energy"].as_array().unwrap().len(),
            128
        );
        assert!(rhythm_map["evidence"].get("spectral_map").is_some());
    }

    #[test]
    fn creation_mode_exposes_only_the_materializable_video_proposal() {
        let names = |mode| {
            tool_catalog()
                .into_iter()
                .filter(|tool| tool.supports(mode))
                .map(|tool| tool.name)
                .collect::<Vec<_>>()
        };

        let creation = names(AgentMode::Hlae);
        assert!(creation.contains(&"read_cinematic_context"));
        assert!(creation.contains(&"draft_video_plan"));
        assert!(creation.contains(&"confirm_video_plan"));
        assert!(!creation.contains(&"confirm_edit_plan"));
        assert!(!creation.contains(&"draft_edit_plan"));
        assert!(!creation.contains(&"draft_agent_plan_changes"));
        assert!(!creation.contains(&"draft_beat_alignment"));

        let editing = names(AgentMode::Edit);
        assert!(editing.contains(&"draft_edit_plan"));
        assert!(editing.contains(&"draft_agent_plan_changes"));
        assert!(editing.contains(&"read_agent_plan"));
        assert!(editing.contains(&"confirm_edit_plan"));
        assert!(editing.contains(&"confirm_beat_alignment"));
        assert!(!editing.contains(&"confirm_video_plan"));
        assert!(!editing.contains(&"draft_video_plan"));

        let guide = names(AgentMode::Guide);
        assert!(!guide.iter().any(|name| name.starts_with("draft_")));
        assert!(!guide.iter().any(|name| name.starts_with("confirm_")));
    }

    #[test]
    fn tool_catalog_is_unique_complete_and_has_no_legacy_hlae_path() {
        let catalog = tool_catalog();
        let names = catalog.iter().map(|tool| tool.name).collect::<HashSet<_>>();
        let kinds = catalog.iter().map(|tool| tool.kind).collect::<HashSet<_>>();
        assert_eq!(names.len(), catalog.len());
        assert_eq!(kinds.len(), catalog.len());
        assert_eq!(catalog.len(), 20);
        assert!(catalog.iter().all(|tool| !tool.modes.is_empty()));
    }

    #[tokio::test]
    async fn audio_and_alignment_tools_compute_only_when_explicitly_called() {
        let audio_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let host = Arc::new(FixedToolHost::default());
        let context = AgentContext {
            workspace: json!({"resources":{"audioAssetId":audio_id,"editorProjectId":project_id}}),
            ..AgentContext::default()
        };
        let state = ToolState::new(context, Some(host.clone()), false);
        assert_eq!(host.audio_reads.load(Ordering::SeqCst), 0);
        let audio = state
            .execute_named(
                "read_audio_evidence",
                json!({"audioAssetId":audio_id,"view":"summary"}),
            )
            .await
            .expect("audio Evidence");
        assert_eq!(audio["evidence"]["bpm"], 120.0);
        assert_eq!(host.audio_reads.load(Ordering::SeqCst), 1);
        let alignment = state
            .execute_named(
                "draft_beat_alignment",
                json!({
                    "editorProjectId":project_id,"expectedRevision":4,
                    "audioAssetId":audio_id,
                    "audioPlacement":{"timeline_start_seconds":0.0,"source_in_seconds":0.0,"volume":1.0}
                }),
            )
            .await
            .expect("Beat Alignment Proposal");
        assert!(alignment["proposalId"].is_string());
        assert_eq!(host.alignment_drafts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn auto_edit_confirmation_links_to_the_prior_proposal_without_pausing() {
        let state = ToolState::new(context(), None, true);
        let draft = state
            .execute_named(
                "draft_edit_plan",
                json!({
                    "demoId":"demo-1",
                    "highlightIds":["ace-1"],
                    "pacing":"impact",
                    "includeContextSeconds":2,
                    "transitionStyle":"cut"
                }),
            )
            .await
            .expect("edit proposal");
        let proposal_id = draft["proposalId"].clone();
        let later = state
            .execute_named(
                "draft_edit_plan",
                json!({"demoId":"demo-1","highlightIds":["ace-1"],"pacing":"measured"}),
            )
            .await
            .expect("later edit proposal");
        assert_ne!(later["proposalId"], proposal_id);
        let output = state
            .execute_named(
                "confirm_edit_plan",
                json!({
                    "proposalId":proposal_id,
                    "title":"Apply the selected edit",
                    "summary":"Create one bounded edit from ace-1"
                }),
            )
            .await
            .expect("automatic confirmation");
        assert_eq!(output["approved"], true);
        assert_eq!(output["automatic"], true);
        assert_eq!(output["status"], "approved");
        assert_eq!(output["proposalId"], proposal_id);
        assert_eq!(output["proposalKind"], "highlight_edit");
    }

    #[tokio::test]
    async fn manual_edit_confirmation_becomes_a_pending_ui_request() {
        let state = ToolState::new(context(), None, false);
        let draft = state
            .execute_named(
                "draft_edit_plan",
                json!({"demoId":"demo-1","highlightIds":["ace-1"],"pacing":"impact"}),
            )
            .await
            .expect("edit proposal");
        let proposal_id = draft["proposalId"].clone();
        let output = state
            .execute_named(
                "confirm_edit_plan",
                json!({
                    "proposalId":proposal_id,
                    "title":"Apply edit",
                    "summary":"Shorten the selected shot"
                }),
            )
            .await
            .expect("manual confirmation");
        assert_eq!(output["approved"], false);
        assert_eq!(output["automatic"], false);
        assert_eq!(output["status"], "pending");
    }

    #[tokio::test]
    async fn each_confirmation_requires_the_matching_prior_proposal() {
        let state = ToolState::new(context(), None, true);
        assert!(
            state
                .execute_named(
                    "confirm_edit_plan",
                    json!({"proposalId":Uuid::new_v4(),"title":"Edit","summary":"Apply edit"})
                )
                .await
                .is_err()
        );
        let draft = state
            .execute_named(
                "draft_edit_plan",
                json!({"demoId":"demo-1","highlightIds":["ace-1"],"pacing":"impact"}),
            )
            .await
            .expect("edit proposal");
        let proposal_id = draft["proposalId"].clone();
        assert!(
            state
                .execute_named(
                    "confirm_beat_alignment",
                    json!({"proposalId":proposal_id,"title":"Beat","summary":"Apply beats"})
                )
                .await
                .is_err()
        );
    }

    #[test]
    fn workspace_navigation_emits_only_a_typed_destination() {
        let (output, plan) = execute_tool(
            "navigate_workspace",
            &context(),
            &json!({"destination":"replay","demoId":"demo-1"}),
        )
        .expect("typed navigation");
        assert_eq!(
            output,
            json!({"accepted":true,"destination":"replay","reason":null})
        );
        assert!(plan.is_none());
        assert!(
            execute_tool(
                "navigate_workspace",
                &context(),
                &json!({"destination":"/settings"}),
            )
            .is_err()
        );
    }

    #[test]
    fn workspace_context_is_read_only_and_exact() {
        let mut value = context();
        value.workspace = json!({
            "workflow":"review","destination":"replay","demoId":"demo-1",
            "projectId":null,"playerId":"76561198000000001","roundNumber":7,"tick":640,
            "plan":{"id":"plan-1","shots":[{"id":"shot-1"}]},
            "series":[{"demoId":"demo-1","analysis":{"large":"x".repeat(100_000)}}]
        });
        let (output, plan) =
            execute_tool("read_workspace_context", &value, &json!({})).expect("workspace context");
        assert_eq!(output["destination"], "replay");
        assert_eq!(output["tick"], 640);
        assert!(output.get("plan").is_none());
        assert!(output.get("series").is_none());
        assert_eq!(output["planAvailable"], true);
        assert_eq!(output["seriesDemoCount"], 1);
        assert!(plan.is_none());
        assert!(
            execute_tool(
                "read_workspace_context",
                &value,
                &json!({"path":"/settings"}),
            )
            .is_err()
        );
    }

    #[test]
    fn captured_tool_output_keeps_references_but_not_megabyte_evidence() {
        let proposal_id = Uuid::new_v4();
        let captured = bounded_captured_output(&json!({
            "available":true,"proposalId":proposal_id,"evidence":"x".repeat(100_000)
        }));
        assert_eq!(captured["proposalId"], proposal_id.to_string());
        assert_eq!(captured["captureTruncated"], true);
        assert!(serde_json::to_vec(&captured).unwrap().len() < MAXIMUM_CAPTURED_TOOL_OUTPUT_BYTES);
    }

    #[test]
    fn cinematic_context_exposes_map_space_and_recommends_purposeful_motion() {
        let (output, plan) = execute_tool(
            "read_cinematic_context",
            &context(),
            &json!({"demoIds":["demo-1"],"highlightIds":["ace-1"]}),
        )
        .expect("cinematic context");

        assert!(plan.is_none());
        assert_eq!(output["mapName"], "de_mirage");
        assert_eq!(
            output["scenes"][0]["mapSpace"]["radarTransformAvailable"],
            true
        );
        assert!(output["scenes"][0]["positionedAction"][0]["radarPercent"].is_array());
        assert_eq!(
            output["scenes"][0]["mapSpace"]["evidence"],
            "positioned_demo_events"
        );
        assert!(
            output["scenes"][0]["mapSpace"]["movementUnits"]
                .as_f64()
                .unwrap()
                > 250.0
        );
        assert_eq!(
            output["scenes"][0]["recommendedDesigns"],
            json!([{
                "intent": "player_pov",
                "cameraStyle": "pov",
                "reason": "Collision geometry is unavailable; use the verified player perspective so walls cannot hide the action."
            }])
        );
    }

    #[test]
    fn cinematic_context_prefers_selected_round_replay_samples() {
        let replay = json!({
            "scenes": [{
                "highlightId": "ace-1",
                "positionedAction": [
                    {
                        "tick": 700,
                        "kind": "player_sample",
                        "actor": "player-1",
                        "position": [-1552.0, -190.0, -161.0],
                        "yaw": 20.0,
                        "nearestOpponentPosition": [-1250.0, -100.0, -160.0]
                    },
                    {
                        "tick": 1100,
                        "kind": "player_sample",
                        "actor": "player-1",
                        "position": [-1714.0, -232.0, -167.0],
                        "yaw": 35.0,
                        "nearestOpponentPosition": [-1400.0, -120.0, -165.0]
                    }
                ],
                "verifiedEngagements": [{
                    "tick": 700,
                    "target": "enemy-1",
                    "playerPosition": [-1552.0, -190.0, -161.0],
                    "targetPosition": [-1250.0, -100.0, -160.0],
                    "axis": [302.0, 90.0, 1.0],
                    "distanceUnits": 315.1
                }],
                "fidelity": {
                    "source": "selected_round_replay",
                    "targetFrameCount": 38,
                    "clampedToArtifactEnd": true
                }
            }]
        });
        let (output, _) = execute_tool_with_cinematic(
            ToolKind::ReadCinematicContext,
            &context(),
            &json!({"demoIds":["demo-1"],"highlightIds":["ace-1"]}),
            Some(&replay),
        )
        .expect("replay-backed cinematic context");

        let scene = &output["scenes"][0];
        assert_eq!(scene["mapSpace"]["evidence"], "selected_round_replay");
        assert_eq!(scene["mapSpace"]["replayFidelity"]["targetFrameCount"], 38);
        assert_eq!(scene["positionedAction"].as_array().map(Vec::len), Some(2));
        assert!(scene["positionedAction"][0]["radarPercent"].is_array());
        assert!(scene["positionedAction"][0]["nearestOpponentRadarPercent"].is_array());
        assert!(scene["mapSpace"]["verifiedEngagements"][0]["targetRadarPercent"].is_array());
    }

    #[test]
    fn video_plan_binds_verified_highlights_to_executable_recording_items() {
        let mut context = context();
        context.demo = json!({"id":"00000000-0000-4000-8000-0000000000d1"});
        authorize_demos(&mut context, &["00000000-0000-4000-8000-0000000000d1"]);
        context.analysis["highlights"][0]["player_id"] = json!("player-1");
        context.analysis["highlights"]
            .as_array_mut()
            .expect("highlights")
            .push(json!({
                "id":"clutch-2","kind":"clutch","title":"Clutch",
                "round":1,"start_tick":1400,"end_tick":1800,"description":"round win",
                "player_id":"player-1"
            }));
        context.analysis["rounds"][0]["events"]
            .as_array_mut()
            .expect("round events")
            .push(json!({
                "tick":1500,"kind":"kill","actor":"player-1","target":"enemy-3",
                "position":[-300.0,900.0,48.0]
            }));

        let cinematic = read_cinematic_context(
            &context,
            &json!({"demoIds":["00000000-0000-4000-8000-0000000000d1"],"highlightIds":["ace-1","clutch-2"]}),
            None,
        )
        .expect("cinematic Evidence");
        let (output, plan) = execute_tool_with_cinematic(
            ToolKind::DraftVideoPlan,
            &context,
            &json!({
                "title":"Ace to Clutch",
                "demoIds":["00000000-0000-4000-8000-0000000000d1"],
                "highlightIds":["ace-1","clutch-2"],
                "pacing":"impact",
                "storyRoles":["hook","climax"],
                "transitionStyle":"flash",
                "leadSeconds":2.0,
                "tailSeconds":2.5,
                "cameraStyles":["crane","flyby"],
                "cameraIntents":["establish_location","transition_through_space"],
                "cameraRationales":[
                    "Establish the occupied map lane before the eliminations.",
                    "Travel through the proven action axis into the clutch."
                ]
            }),
            Some(&cinematic),
        )
        .expect("video plan");

        assert_eq!(output["accepted"], true);
        let plan = plan.expect("accepted video proposal");
        assert_eq!(plan.kind, CapturedPlanKind::VideoRender);
        assert_eq!(plan.payload["output"]["container"], "mp4");
        assert_eq!(plan.payload["items"][0]["demo_id"], context.demo["id"]);
        assert_eq!(plan.payload["items"][0]["highlight_id"], "ace-1");
        assert_eq!(plan.payload["items"][0]["player_id"], "player-1");
        assert_eq!(plan.payload["items"][0]["start_tick"], 684);
        assert_eq!(plan.payload["items"][0]["end_tick"], 1116);
        assert_eq!(plan.payload["items"][0]["pre_roll_seconds"], 0.125);
        assert_eq!(plan.payload["items"][0]["post_roll_seconds"], 0.125);
        assert_eq!(plan.payload["items"][0]["victim_pov"], false);
        assert_eq!(plan.payload["items"][0]["camera_style"], "pov");
        assert_eq!(plan.payload["items"][1]["highlight_id"], "clutch-2");
        assert_eq!(plan.payload["items"][1]["camera_style"], "pov");
        assert_eq!(
            plan.payload["shot_designs"][0]["camera_intent"],
            "player_pov"
        );
        assert_eq!(
            plan.payload["shot_designs"][0]["safety_fallback"],
            "collision_geometry_unavailable"
        );
    }

    #[test]
    fn video_plan_rejects_a_requested_duration_the_selected_action_cannot_cover() {
        let demo_id = "00000000-0000-4000-8000-0000000000d1";
        let mut context = context();
        context.demo = json!({"id":demo_id});
        authorize_demos(&mut context, &[demo_id]);
        context.analysis["highlights"][0]["player_id"] = json!("player-1");
        let cinematic = read_cinematic_context(
            &context,
            &json!({"demoIds":[demo_id],"highlightIds":["ace-1"]}),
            None,
        )
        .expect("cinematic evidence");

        let (output, plan) = execute_tool_with_cinematic(
            ToolKind::DraftVideoPlan,
            &context,
            &json!({
                "title":"Three minute ace reel",
                "demoIds":[demo_id],
                "highlightIds":["ace-1"],
                "targetDurationSeconds":180.0,
                "pacing":"impact",
                "storyRoles":["climax"],
                "transitionStyle":"cut",
                "cameraIntents":["player_pov"],
                "cameraRationales":["Keep the verified player view through the ace."]
            }),
            Some(&cinematic),
        )
        .expect("duration-aware plan result");

        assert_eq!(output["accepted"], false);
        assert_eq!(output["durationTargetMet"], false);
        assert_eq!(output["targetDurationSeconds"], 180.0);
        assert!(
            output["selectedDurationSeconds"]
                .as_f64()
                .is_some_and(|seconds| seconds < 135.0)
        );
        assert!(plan.is_none());
    }

    #[test]
    fn video_plan_overlap_detection_rejects_nested_highlights() {
        let highlights = json!([{
            "id":"short","demoId":"demo-1","playerId":"player-1","round":11,
            "startTick":85_125,"endTick":85_222
        }, {
            "id":"long","demoId":"demo-1","playerId":"player-1","round":11,
            "startTick":85_125,"endTick":85_836
        }]);
        let pairs = overlapping_highlight_pairs(highlights.as_array().expect("highlights"));

        assert_eq!(pairs, vec![("short".to_owned(), "long".to_owned())]);
    }

    #[test]
    fn video_plan_keeps_each_series_highlight_on_its_own_demo() {
        let first = "00000000-0000-4000-8000-0000000000d1";
        let second = "00000000-0000-4000-8000-0000000000d2";
        let mut context = context();
        context.demo = json!({"id":first});
        authorize_demos(&mut context, &[first, second]);
        context.analysis["highlights"] = json!([{
            "id": format!("{first}:shared"),
            "source_highlight_id": "shared",
            "demo_id": first,
            "map_name": "de_mirage",
            "tick_rate": 64.0,
            "kind":"multi_kill","title":"Map one","round":1,
            "start_tick":640,"end_tick":960,"player_id":"player-1"
        }, {
            "id": format!("{second}:shared"),
            "source_highlight_id": "shared",
            "demo_id": second,
            "map_name": "de_nuke",
            "tick_rate": 128.0,
            "kind":"clutch","title":"Map two","round":2,
            "start_tick":1280,"end_tick":1792,"player_id":"player-1"
        }]);

        let ids = [format!("{first}:shared"), format!("{second}:shared")];
        let cinematic = read_cinematic_context(
            &context,
            &json!({"demoIds":[first,second],"highlightIds":ids}),
            None,
        )
        .expect("series cinematic Evidence");
        let (_, plan) = execute_tool_with_cinematic(
            ToolKind::DraftVideoPlan,
            &context,
            &json!({
                "title":"Two-map sequence",
                "demoIds":[first,second],
                "highlightIds": ids,
                "pacing":"energetic",
                "storyRoles":["hook","climax"],
                "transitionStyle":"flash",
                "cameraIntents":["player_pov","player_pov"],
                "cameraRationales":[
                    "Keep the verified player view on the first map.",
                    "Keep the verified player view on the second map."
                ]
            }),
            Some(&cinematic),
        )
        .expect("series video plan");

        let payload = plan.expect("accepted series proposal").payload;
        assert_eq!(payload["items"][0]["demo_id"], first);
        assert_eq!(payload["items"][1]["demo_id"], second);
        assert_eq!(payload["items"][0]["highlight_id"], "shared");
        assert_eq!(payload["items"][1]["highlight_id"], "shared");
        assert_eq!(payload["shot_designs"][0]["map_name"], "de_mirage");
        assert_eq!(payload["shot_designs"][1]["map_name"], "de_nuke");
        assert_eq!(payload["shot_designs"][1]["tick_rate"], 128.0);
    }

    #[test]
    fn video_plan_keeps_cinematic_camera_when_collision_geometry_is_verified() {
        let mut context = context();
        context.demo = json!({"id":"00000000-0000-4000-8000-0000000000d1"});
        authorize_demos(&mut context, &["00000000-0000-4000-8000-0000000000d1"]);
        context.analysis["highlights"][0]["player_id"] = json!("player-1");
        let cinematic = json!({
            "scenes": [{
                "highlightId": "ace-1",
                "positionedAction": [{
                    "tick": 700,
                    "kind": "player_sample",
                    "actor": "player-1",
                    "position": [-1000.0, 500.0, 32.0],
                    "yaw": 20.0,
                    "nearestOpponentPosition": [-900.0, 450.0, 32.0]
                }],
                "mapSpace": {
                    "collisionGeometryAvailable": true
                }
            }]
        });
        let cinematic = read_cinematic_context(
            &context,
            &json!({"demoIds":["00000000-0000-4000-8000-0000000000d1"],"highlightIds":["ace-1"]}),
            Some(&cinematic),
        )
        .expect("processed cinematic Evidence");

        let (_, plan) = execute_tool_with_cinematic(
            ToolKind::DraftVideoPlan,
            &context,
            &json!({
                "title":"Verified cinematic ace",
                "demoIds":["00000000-0000-4000-8000-0000000000d1"],
                "highlightIds":["ace-1"],
                "pacing":"cinematic",
                "storyRoles":["climax"],
                "transitionStyle":"fade",
                "cameraStyles":["crane"],
                "cameraIntents":["establish_location"],
                "cameraRationales":["Establish the verified space before the eliminations."]
            }),
            Some(&cinematic),
        )
        .expect("collision-verified cinematic plan");

        let plan = plan.expect("accepted cinematic proposal");
        assert_eq!(plan.title, "Verified cinematic ace");
        assert_eq!(plan.payload["items"][0]["camera_style"], "crane");
        assert_eq!(
            plan.payload["shot_designs"][0]["camera_intent"],
            "establish_location"
        );
        assert!(plan.payload["shot_designs"][0]["safety_fallback"].is_null());
        assert_eq!(plan.payload["presentation"]["transition_style"], "fade");
    }

    #[test]
    fn video_plan_reports_effective_timing_at_replay_boundaries() {
        let mut context = context();
        context.demo = json!({"id":"00000000-0000-4000-8000-0000000000d1"});
        authorize_demos(&mut context, &["00000000-0000-4000-8000-0000000000d1"]);
        context.analysis["highlights"][0]["player_id"] = json!("player-1");
        let cinematic = json!({"scenes":[{
            "highlightId":"ace-1",
            "positionedAction":[],
            "fidelity":{
                "artifactStartTick":600,
                "artifactEndTick":1100,
                "clampedToArtifactEnd":true
            }
        }]});
        let cinematic = read_cinematic_context(
            &context,
            &json!({"demoIds":["00000000-0000-4000-8000-0000000000d1"],"highlightIds":["ace-1"]}),
            Some(&cinematic),
        )
        .expect("processed boundary Evidence");

        let (_, plan) = execute_tool_with_cinematic(
            ToolKind::DraftVideoPlan,
            &context,
            &json!({
                "title":"Boundary-safe ace",
                "demoIds":["00000000-0000-4000-8000-0000000000d1"],
                "highlightIds":["ace-1"],
                "pacing":"impact",
                "storyRoles":["climax"],
                "transitionStyle":"flash",
                "leadSeconds":2.0,
                "tailSeconds":2.0,
                "cameraIntents":["player_pov"],
                "cameraRationales":["Keep the verified player view through the available replay."]
            }),
            Some(&cinematic),
        )
        .expect("boundary-clamped plan");

        let payload = plan.expect("accepted boundary plan").payload;
        assert_eq!(payload["items"][0]["start_tick"], 684);
        assert_eq!(payload["items"][0]["end_tick"], 1100);
        assert_eq!(payload["items"][0]["pre_roll_seconds"], 0.125);
        assert_eq!(payload["items"][0]["post_roll_seconds"], 0.0);
        assert_eq!(payload["shot_designs"][0]["timing_clipped"], true);
        assert_eq!(
            payload["shot_designs"][0]["effective_timing"]["tail_seconds"],
            0.0
        );
    }

    #[test]
    fn single_kill_plan_is_bounded_by_publishable_action_density() {
        let mut context = context();
        context.demo = json!({"id":"00000000-0000-4000-8000-0000000000d1"});
        authorize_demos(&mut context, &["00000000-0000-4000-8000-0000000000d1"]);
        context.analysis["highlights"][0]["player_id"] = json!("player-1");
        let cinematic = json!({"scenes":[{
            "highlightId":"ace-1",
            "positionedAction":[],
            "verifiedEngagements":[{"tick":960}],
            "fidelity":{"artifactStartTick":0,"artifactEndTick":2000}
        }]});
        let cinematic = read_cinematic_context(
            &context,
            &json!({"demoIds":["00000000-0000-4000-8000-0000000000d1"],"highlightIds":["ace-1"]}),
            Some(&cinematic),
        )
        .expect("processed action Evidence");

        let (_, plan) = execute_tool_with_cinematic(
            ToolKind::DraftVideoPlan,
            &context,
            &json!({
                "title":"NiKo opening one-tap",
                "demoIds":["00000000-0000-4000-8000-0000000000d1"],
                "highlightIds":["ace-1"],
                "pacing":"energetic",
                "storyRoles":["hook"],
                "transitionStyle":"flash",
                "leadSeconds":4.0,
                "tailSeconds":4.0,
                "cameraIntents":["player_pov"],
                "cameraRationales":["Start on the verified player sightline and cut immediately after impact."]
            }),
            Some(&cinematic),
        )
        .expect("action-dense plan");

        let payload = plan.expect("accepted action-dense plan").payload;
        assert_eq!(payload["items"][0]["start_tick"], 944);
        assert_eq!(payload["items"][0]["end_tick"], 976);
        assert_eq!(payload["items"][0]["pre_roll_seconds"], 2.0);
        assert_eq!(payload["items"][0]["post_roll_seconds"], 2.0);
        assert_eq!(payload["shot_designs"][0]["final_duration_seconds"], 4.5);
        assert_eq!(payload["shot_designs"][0]["story_role"], "hook");
        assert_eq!(payload["presentation"]["branding_theme"], "neon");
    }

    #[test]
    fn edit_plan_emits_the_current_explicit_nullable_target_shape() {
        let (_, plan) = draft_edit_plan(
            &context(),
            &json!({"demoId":"demo-1","highlightIds":["ace-1"],"pacing":"energetic"}),
        )
        .expect("draft edit plan");
        let payload = plan.expect("accepted edit plan").payload;
        let object = payload.as_object().expect("proposal payload");

        for field in ["target_project_id", "expected_revision", "new_project_name"] {
            assert!(object.contains_key(field), "missing current field {field}");
            assert!(object[field].is_null(), "new-project field must be null");
        }
    }

    #[test]
    fn agent_plan_changes_are_bound_to_real_shots_and_server_computed_durations() {
        let mut context = context();
        let shot_id = "00000000-0000-4000-8000-0000000000a1";
        context.workspace = json!({
            "plan": {
                "id": "00000000-0000-4000-8000-0000000000b1",
                "revision": 3,
                "shots": [{
                    "id": shot_id,
                    "title": "Ace",
                    "duration_seconds": 8.0,
                    "removed_by": null
                }]
            }
        });

        let (_, proposal) = execute_tool(
            "draft_agent_plan_changes",
            &context,
            &json!({
                "planId":"00000000-0000-4000-8000-0000000000b1",
                "expectedRevision":3,
                "title": "压短开场",
                "changes": [{
                    "op": "shorten",
                    "target": shot_id,
                    "deltaSeconds": -2.5,
                    "rationale": "更快进入第一处击杀。",
                    "warning": null
                }]
            }),
        )
        .expect("Agent plan changes");
        let proposal = proposal.expect("captured proposal");
        assert_eq!(proposal.kind, CapturedPlanKind::AgentPlanChange);
        assert_eq!(proposal.payload["changes"][0]["target"], shot_id);
        assert_eq!(proposal.payload["changes"][0]["before"], "8.0s");
        assert_eq!(proposal.payload["changes"][0]["after"], "5.5s");
        assert_eq!(proposal.payload["changes"][0]["delta_seconds"], -2.5);

        assert!(
            execute_tool(
                "draft_agent_plan_changes",
                &context,
                &json!({
                    "planId":"00000000-0000-4000-8000-0000000000b1",
                    "expectedRevision":3,
                    "title": "Unknown",
                    "changes": [{
                        "op": "delete",
                        "target": "00000000-0000-4000-8000-0000000000ff",
                        "rationale": "not in plan"
                    }]
                }),
            )
            .is_err()
        );
    }

    #[test]
    fn edit_plan_rejects_missing_and_duplicate_ids() {
        let (output, plan) = draft_edit_plan(
            &context(),
            &json!({"demoId":"demo-1","highlightIds":["missing","missing"],"pacing":"impact"}),
        )
        .unwrap();
        assert_eq!(output["accepted"], false);
        assert!(plan.is_none());
        assert!(output["plan"].is_object());
        assert_eq!(output["plan"]["missingHighlightIds"], json!(["missing"]));
        assert_eq!(output["plan"]["duplicateHighlightIds"], json!(["missing"]));
    }

    #[test]
    fn round_search_uses_counter_strike_side_names() {
        let mut context = context();
        context.analysis["rounds"] = json!([{
            "number": 7,
            "winner": "T",
            "start_tick": 900,
            "end_tick": 1_700,
            "events": []
        }]);
        let result =
            search_rounds(&context, &json!({"demoId":"demo-1","winningSide":"T"})).unwrap();
        assert_eq!(result["rounds"][0]["round"], 7);
        assert!(search_rounds(&context, &json!({"demoId":"demo-1","winningSide":"A"})).is_err());
        let context_only =
            read_round_context(&context, &json!({"demoId":"demo-1","roundNumbers":[7]})).unwrap();
        assert!(context_only["rounds"][0].get("events").is_none());
    }
}
