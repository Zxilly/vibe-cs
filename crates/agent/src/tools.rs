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

use crate::{AgentContext, AgentMode, AgentToolHost};

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
    /// An HLAE bundle to review before it is written.
    Hlae,
    /// A recording queue, which is the one that needs an explicit confirmation.
    VideoRender,
}

/// One proposal the model emitted during a turn. `kind` selects how a client
/// renders `payload`; the payload itself is not interpreted here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CapturedPlan {
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
    cinematic_cache: Arc<Mutex<HashMap<String, Value>>>,
    captures: Arc<Mutex<Captures>>,
}

impl ToolState {
    pub(crate) fn new(context: AgentContext, tool_host: Option<Arc<dyn AgentToolHost>>) -> Self {
        Self {
            context: Arc::new(context),
            tool_host,
            cinematic_cache: Arc::new(Mutex::new(HashMap::new())),
            captures: Arc::new(Mutex::new(Captures::default())),
        }
    }

    pub(crate) async fn snapshot(&self) -> (Vec<CapturedToolCall>, Vec<CapturedPlan>) {
        let captures = self.captures.lock().await;
        (captures.tool_calls.clone(), captures.plans.clone())
    }

    async fn execute(&self, name: &str, input: Value) -> Result<Value, ToolExecutionError> {
        let external_cinematic = if matches!(name, "read_cinematic_context" | "draft_video_plan") {
            self.external_cinematic_context(&input)
                .await
                .map_err(ToolExecutionError::other)?
        } else {
            None
        };
        let (output, plan) =
            execute_tool_with_cinematic(name, &self.context, &input, external_cinematic.as_ref())
                .map_err(ToolExecutionError::invalid_args)?;
        let mut captures = self.captures.lock().await;
        if captures.tool_calls.len() >= 32 {
            return Err(ToolExecutionError::other("tool call limit exceeded"));
        }
        if plan.is_some() && captures.plans.len() >= 8 {
            return Err(ToolExecutionError::other("proposal limit exceeded"));
        }
        captures.tool_calls.push(CapturedToolCall {
            name: name.to_owned(),
            input,
            output: output.clone(),
        });
        if let Some(plan) = plan {
            captures.plans.push(plan);
        }
        Ok(output)
    }

    async fn external_cinematic_context(&self, input: &Value) -> Result<Option<Value>, String> {
        let ids = string_vec_required(input, "highlightIds", 16)?;
        let missing = {
            let cache = self.cinematic_cache.lock().await;
            ids.iter()
                .filter(|id| !cache.contains_key(*id))
                .cloned()
                .collect::<Vec<_>>()
        };
        if !missing.is_empty()
            && let Some(host) = &self.tool_host
        {
            let supplied = host.read_cinematic_context(&missing).await?;
            let mut cache = self.cinematic_cache.lock().await;
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
        let cache = self.cinematic_cache.lock().await;
        let scenes = ids
            .iter()
            .filter_map(|id| cache.get(id).cloned())
            .collect::<Vec<_>>();
        Ok((!scenes.is_empty()).then(|| json!({ "scenes": scenes })))
    }
}

pub(crate) fn create_tools(state: &ToolState, mode: AgentMode) -> Vec<DynamicTool> {
    tool_definitions()
        .into_iter()
        .filter(|(name, _, _)| tool_allowed_in_mode(mode, name))
        .map(|(name, description, parameters)| {
            let state = state.clone();
            DynamicTool::new(name, description, parameters, move |_context, input| {
                let state = state.clone();
                Box::pin(async move { state.execute(name, input).await.map(ToolOutput::json) })
            })
        })
        .collect()
}

fn tool_allowed_in_mode(mode: AgentMode, name: &str) -> bool {
    match name {
        // Evidence and navigation are safe in every mode.
        "read_workspace_context"
        | "read_demo_evidence"
        | "search_rounds"
        | "read_round_context"
        | "read_round_events"
        | "read_player_matchups"
        | "read_highlights"
        | "navigate_workspace" => true,
        // Editing tools can only propose changes to an editing workflow.
        "read_editor_timeline"
        | "draft_edit_plan"
        | "draft_agent_plan_changes"
        | "read_audio_analysis"
        | "draft_beat_alignment" => matches!(mode, AgentMode::Edit),
        // Initial video creation exposes exactly one proposal kind. This keeps
        // an empty Agent plan from receiving an inapplicable highlight-edit
        // proposal that leaves its shot list empty.
        "read_cinematic_context" | "draft_video_plan" => matches!(mode, AgentMode::Hlae),
        _ => false,
    }
}

fn tool_definitions() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "read_workspace_context",
            "Read the exact visible Vibe CS workflow, destination, and selected round, tick, player, Demo, and editor project identifiers. Values may be null and must not be inferred.",
            object_schema(json!({}), &[]),
        ),
        (
            "read_demo_evidence",
            "Read verified local demo metadata, highlights, rounds, or players. Use this before giving match-specific guidance.",
            object_schema(
                json!({
                    "section": {"type":"string","enum":["summary","highlights","rounds","players"]},
                    "roundNumbers": integer_array_schema(12)
                }),
                &["section"],
            ),
        ),
        (
            "search_rounds",
            "Run a strict deterministic query over selected local Demo rounds. Returns bounded round/tick evidence only.",
            object_schema(
                json!({
                    "winningSide": {"type":"string","enum":["T","CT"]}, "playerIds": string_array_schema(10),
                    "purchasedItems": string_array_schema(12), "roundNumbers": integer_array_schema(24),
                    "eventKinds": event_array_schema(), "maximumResults": {"type":"integer","minimum":1,"maximum":24,"default":24}
                }),
                &[],
            ),
        ),
        (
            "read_round_context",
            "Read context for up to 12 explicit rounds from the selected local Demo.",
            object_schema(
                json!({
                    "roundNumbers": integer_array_schema(12)
                }),
                &["roundNumbers"],
            ),
        ),
        (
            "read_round_events",
            "Read bounded local events for explicit rounds, event kinds, and player identifiers.",
            object_schema(
                json!({
                    "roundNumbers": integer_array_schema(24), "eventKinds": event_array_schema(),
                    "playerIds": string_array_schema(10), "maximumResults": {"type":"integer","minimum":1,"maximum":256,"default":128}
                }),
                &["roundNumbers"],
            ),
        ),
        (
            "read_player_matchups",
            "Read deterministic player-versus-player aggregates derived by the local Demo analyzer.",
            object_schema(
                json!({
                    "playerIds": string_array_schema(10)
                }),
                &["playerIds"],
            ),
        ),
        (
            "read_highlights",
            "Read filtered local highlight evidence with explicit identifiers and tick ranges.",
            object_schema(
                json!({
                    "playerIds": string_array_schema(10), "kinds": string_array_schema(12), "roundNumbers": integer_array_schema(24),
                    "minimumScore": {"type":"number","minimum":0,"maximum":1,"default":0},
                    "maximumResults": {"type":"integer","minimum":1,"maximum":64,"default":32}
                }),
                &[],
            ),
        ),
        (
            "read_cinematic_context",
            "Read the selected highlights as map-space scenes: exact map, round, positioned action, spatial spread, movement axis, and camera-intent recommendations. Call this before drafting any cinematic video shot.",
            object_schema(
                json!({
                    "highlightIds": string_array_schema(16)
                }),
                &["highlightIds"],
            ),
        ),
        (
            "read_editor_timeline",
            "Read selected editor project and its real tracks, clips, markers, dimensions, frame rate, and revision.",
            object_schema(
                json!({
                    "includeClips": {"type":"boolean","default":true}
                }),
                &[],
            ),
        ),
        (
            "draft_edit_plan",
            "Draft a non-destructive edit plan from verified highlight identifiers. This never changes the timeline by itself.",
            object_schema(
                json!({
                    "highlightIds": string_array_schema(16), "pacing": {"type":"string","enum":["measured","energetic","impact"]},
                    "includeContextSeconds": {"type":"number","minimum":0,"maximum":8,"default":2},
                    "transitionStyle": {"type":"string","enum":["auto","cut","fade","flash","slide"],"default":"auto"}
                }),
                &["highlightIds", "pacing"],
            ),
        ),
        (
            "draft_agent_plan_changes",
            "Draft reviewable changes to the currently selected Agent shot list. Use only target shot ids returned in workspace.plan. This never changes the plan by itself.",
            object_schema(
                json!({
                    "title": {"type":"string","minLength":1,"maxLength":200},
                    "changes": {
                        "type":"array","minItems":1,"maxItems":16,
                        "items": {
                            "type":"object","additionalProperties":false,
                            "properties": {
                                "op": {"type":"string","enum":["shorten","delete"]},
                                "target": {"type":"string","minLength":1,"maxLength":128},
                                "deltaSeconds": {"type":"number","maximum":-0.01},
                                "rationale": {"type":"string","minLength":1,"maxLength":400},
                                "warning": {"type":["string","null"],"maxLength":400}
                            },
                            "required":["op","target","rationale"]
                        }
                    }
                }),
                &["title", "changes"],
            ),
        ),
        (
            "draft_video_plan",
            "Draft a complete video task from selected Demo highlights. The user reviews the shots and confirms before recording starts.",
            object_schema(
                json!({
                    "highlightIds": string_array_schema(16),
                    "leadSeconds": {"type":"number","minimum":0.5,"maximum":8,"default":2.5},
                    "tailSeconds": {"type":"number","minimum":0.5,"maximum":8,"default":2},
                    "cameraStyle": {"type":"string","enum":["pov","orbit","dolly","static","tracking","crane","flyby"],"default":"pov"},
                    "cameraStyles": {"type":"array","items":{"type":"string","enum":["pov","orbit","dolly","static","tracking","crane","flyby"]},"maxItems":16,"default":[]},
                    "cameraIntents": {"type":"array","items":{"type":"string","enum":["player_pov","establish_location","follow_entry","reveal_duel","hold_crossfire","rise_after_climax","transition_through_space"]},"minItems":1,"maxItems":16},
                    "cameraRationales": {"type":"array","items":{"type":"string","minLength":1,"maxLength":128},"minItems":1,"maxItems":16}
                }),
                &["highlightIds", "cameraIntents", "cameraRationales"],
            ),
        ),
        (
            "read_audio_analysis",
            "Read real locally decoded BGM tempo, beat, onset, energy, and section evidence. Never infer analysis when unavailable.",
            object_schema(
                json!({
                    "includeEnergyCurve": {"type":"boolean","default":false}
                }),
                &[],
            ),
        ),
        (
            "draft_beat_alignment",
            "Return the advisory beat-alignment draft computed by the native Rust audio engine for selected BGM and real clips.",
            object_schema(
                json!({
                    "acknowledgeAdvisoryOnly": {"type":"boolean","const":true}
                }),
                &["acknowledgeAdvisoryOnly"],
            ),
        ),
        (
            "navigate_workspace",
            "Navigate the visible Vibe CS workspace through a typed destination. Use this when the user asks to open Review, Players, Evidence, Replay, Heatmap, Edit, Queue, Studio, or Outputs.",
            object_schema(
                json!({
                    "destination": {"type":"string","enum":["review","players","evidence","replay","heatmap","edit","queue","studio","outputs"]}
                }),
                &["destination"],
            ),
        ),
    ]
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

fn event_array_schema() -> Value {
    json!({"type":"array","items":{"type":"string","enum":["round_start","round_end","kill","damage","bomb_plant","bomb_defuse","bomb_explode","grenade","purchase"]},"maxItems":9,"default":[]})
}

#[cfg(test)]
fn execute_tool(
    name: &str,
    context: &AgentContext,
    input: &Value,
) -> Result<(Value, Option<CapturedPlan>), String> {
    execute_tool_with_cinematic(name, context, input, None)
}

fn execute_tool_with_cinematic(
    name: &str,
    context: &AgentContext,
    input: &Value,
    external_cinematic: Option<&Value>,
) -> Result<(Value, Option<CapturedPlan>), String> {
    ensure_object(input)?;
    match name {
        "read_workspace_context" => Ok((read_workspace_context(context, input)?, None)),
        "read_demo_evidence" => Ok((read_demo_evidence(context, input)?, None)),
        "search_rounds" => Ok((search_rounds(context, input)?, None)),
        "read_round_context" => Ok((read_round_context(context, input)?, None)),
        "read_round_events" => Ok((read_round_events(context, input)?, None)),
        "read_player_matchups" => Ok((read_player_matchups(context, input)?, None)),
        "read_highlights" => Ok((read_highlights(context, input)?, None)),
        "read_cinematic_context" => Ok((
            read_cinematic_context(context, input, external_cinematic)?,
            None,
        )),
        "read_editor_timeline" => Ok((read_editor_timeline(context, input), None)),
        "draft_edit_plan" => draft_edit_plan(context, input),
        "draft_agent_plan_changes" => draft_agent_plan_changes(context, input),
        "draft_video_plan" => draft_video_plan(context, input, external_cinematic),
        // Kept for persisted pre-video conversations, but no longer exposed to the model.
        "draft_hlae_plan" => draft_hlae_plan(context, input),
        "read_audio_analysis" => Ok((read_audio_analysis(context, input), None)),
        "draft_beat_alignment" => draft_beat_alignment(context, input),
        "navigate_workspace" => Ok((navigate_workspace(context, input)?, None)),
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn read_workspace_context(context: &AgentContext, input: &Value) -> Result<Value, String> {
    if !ensure_object(input)?.is_empty() {
        return Err("read_workspace_context accepts no fields".into());
    }
    Ok(context.workspace.clone())
}

fn navigate_workspace(context: &AgentContext, input: &Value) -> Result<Value, String> {
    let object = ensure_object(input)?;
    if object.len() != 1 {
        return Err("navigate_workspace accepts only destination".into());
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
    let has_demo = context
        .demo
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
        && context.analysis.is_object();
    if requires_demo && !has_demo {
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

fn read_demo_evidence(context: &AgentContext, input: &Value) -> Result<Value, String> {
    let section = required_str(input, "section")?;
    let Some(analysis) = context.analysis.as_object() else {
        return Ok(
            json!({"section":section,"evidence":{"available":false,"reason":"No analyzed demo is selected."}}),
        );
    };
    let evidence = match section {
        "summary" => {
            json!({"available":true,"demo":context.demo,"mapName":analysis.get("map_name"),"tickRate":analysis.get("tick_rate"),"durationSeconds":analysis.get("duration_seconds"),"teams":analysis.get("teams")})
        }
        "highlights" => Value::Array(highlight_evidence(&context.analysis)),
        "players" => analysis
            .get("players")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "rounds" => {
            let wanted = integer_set(input, "roundNumbers", 12)?;
            Value::Array(
                rounds(&context.analysis)
                    .filter(|round| {
                        wanted.is_empty()
                            || round_number(round).is_some_and(|value| wanted.contains(&value))
                    })
                    .take(24)
                    .map(|round| Value::Object(round.clone()))
                    .collect(),
            )
        }
        _ => return Err("section must be summary, highlights, rounds, or players".into()),
    };
    Ok(json!({"section":section,"evidence":evidence}))
}

fn search_rounds(context: &AgentContext, input: &Value) -> Result<Value, String> {
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
            json!({"evidenceId":format!("event:{id}"),"tick":event.get("tick"),"kind":event.get("kind"),"actor":event.get("actor"),"target":event.get("target")})
        }).collect::<Vec<_>>();
        matches.push(json!({"evidenceId":format!("round:{number}"),"round":number,"startTick":round.get("start_tick"),"endTick":round.get("end_tick"),"winner":round.get("winner"),"score":[round.get("team_a_score"),round.get("team_b_score")],"economy":economy,"matchedEvents":matched_events}));
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
    let wanted = integer_set_required(input, "roundNumbers", 12)?;
    let selected = rounds(&context.analysis).filter_map(|round| {
        let value = round_number(round)?;
        wanted.contains(&value).then(|| json!({"evidenceId":format!("round:{value}"),"round":value,"startTick":round.get("start_tick"),"endTick":round.get("end_tick"),"winner":round.get("winner"),"reason":round.get("reason"),"score":[round.get("team_a_score"),round.get("team_b_score")],"economy":round_economy(&context.analysis,value),"events":round_events(round).take(64).collect::<Vec<_>>() }))
    }).collect::<Vec<_>>();
    Ok(json!({"available":!selected.is_empty(),"rounds":selected}))
}

fn read_round_events(context: &AgentContext, input: &Value) -> Result<Value, String> {
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
            all.push(json!({"evidenceId":format!("event:{id}"),"round":value,"tick":event.get("tick"),"seconds":event.get("seconds"),"kind":event.get("kind"),"actor":event.get("actor"),"target":event.get("target"),"weapon":event.get("weapon"),"headshot":event.get("headshot").and_then(Value::as_bool).unwrap_or(false)}));
        }
    }
    let truncated = all.len() > maximum;
    all.truncate(maximum);
    Ok(json!({"available":!all.is_empty(),"events":all,"truncated":truncated}))
}

fn read_player_matchups(context: &AgentContext, input: &Value) -> Result<Value, String> {
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
            Value::String(format!("matchup:{player}:{opponent}")),
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
            object.insert(
                "evidenceId".into(),
                Value::String(format!("highlight:{id}")),
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
    let ids = string_vec_required(input, "highlightIds", 16)?;
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
            let mut intents = Vec::new();
            if points.is_empty() {
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
                    "collisionGeometryAvailable": false,
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
        "designRule": "Choose a shot for a stated map-space purpose. If positioned action is unavailable, use player_pov. Camera paths remain subject to user review because collision geometry is not reconstructed.",
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

fn read_editor_timeline(context: &AgentContext, input: &Value) -> Value {
    let Some(project) = context.editor_project.as_object() else {
        return json!({"available":false,"project":null});
    };
    if bool_value(input.get("includeClips"), true) {
        return json!({"available":true,"project":project});
    }
    let mut summary = project.clone();
    summary.remove("tracks");
    json!({"available":true,"project":summary})
}

fn draft_edit_plan(
    context: &AgentContext,
    input: &Value,
) -> Result<(Value, Option<CapturedPlan>), String> {
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
            kind: CapturedPlanKind::AgentPlanChange,
            title: title.to_owned(),
            payload,
        }),
    ))
}

fn draft_hlae_plan(
    context: &AgentContext,
    input: &Value,
) -> Result<(Value, Option<CapturedPlan>), String> {
    let ids = string_vec_required(input, "highlightIds", 16)?;
    let camera = enum_value(
        input,
        "cameraStyle",
        &[
            "pov", "orbit", "dolly", "static", "tracking", "crane", "flyby",
        ],
    )?;
    let mode = enum_value_default(input, "mode", "preview", &["preview", "capture"])?;
    let lead = bounded_f64(input, "leadSeconds", 2.5, 0.5, 8.0)?;
    let tail = bounded_f64(input, "tailSeconds", 2.0, 0.5, 8.0)?;
    let binding = bind_highlights(&context.analysis, &ids);
    let demo_id = text(context.demo.get("id"));
    let mut rejection_reasons = binding.rejection_reasons();
    if demo_id.is_none() {
        rejection_reasons.push("No analyzed Demo is selected.".into());
    }
    let accepted = binding.ready() && demo_id.is_some();
    let selected_ids = if accepted { ids.clone() } else { Vec::new() };
    let payload = json!({"demo_id":demo_id,"highlight_ids":selected_ids,"camera_style":camera,"mode":mode,"lead_seconds":lead,"tail_seconds":tail});
    let plan = accepted.then(|| CapturedPlan {
        kind: CapturedPlanKind::Hlae,
        title: "HLAE camera proposal".into(),
        payload: payload.clone(),
    });
    let missing = binding
        .missing
        .iter()
        .map(|id| format!("missing_highlight:{id}"))
        .chain(
            binding
                .duplicates
                .iter()
                .map(|id| format!("duplicate_highlight:{id}")),
        )
        .chain(
            binding
                .ambiguous
                .iter()
                .map(|id| format!("ambiguous_highlight:{id}")),
        )
        .chain(demo_id.is_none().then_some("demo_id".into()))
        .collect::<Vec<_>>();
    let tick_rate = number_value(context.analysis.get("tick_rate")).unwrap_or(64.0);
    let mut review = payload.as_object().expect("payload object").clone();
    review.extend(Map::from_iter([
        ("tickRate".into(), json!(tick_rate)),
        ("requiresUserReview".into(), json!(true)),
        ("missingHighlightIds".into(), json!(binding.missing)),
        ("duplicateHighlightIds".into(), json!(binding.duplicates)),
        ("ambiguousHighlightIds".into(), json!(binding.ambiguous)),
        ("rejectionReasons".into(), json!(rejection_reasons)),
    ]));
    Ok((
        json!({"accepted":accepted,"plan":review,"missingEvidence":missing}),
        plan,
    ))
}

fn draft_video_plan(
    context: &AgentContext,
    input: &Value,
    external_cinematic: Option<&Value>,
) -> Result<(Value, Option<CapturedPlan>), String> {
    let ids = string_vec_required(input, "highlightIds", 16)?;
    let lead = bounded_f64(input, "leadSeconds", 2.5, 0.5, 8.0)?;
    let tail = bounded_f64(input, "tailSeconds", 2.0, 0.5, 8.0)?;
    let allowed_camera_styles = [
        "pov", "orbit", "dolly", "static", "tracking", "crane", "flyby",
    ];
    let _ = enum_value_default(input, "cameraStyle", "pov", &allowed_camera_styles)?;
    let camera_styles = optional_enum_vec(input, "cameraStyles", 16, &allowed_camera_styles)?;
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
    let camera_intents = optional_enum_vec(input, "cameraIntents", 16, &allowed_camera_intents)?;
    let camera_rationales = string_vec_required(input, "cameraRationales", 16)?;
    if camera_intents.len() != ids.len() || camera_rationales.len() != ids.len() {
        return Err("cameraIntents and cameraRationales must match highlightIds length".into());
    }
    let resolved_camera_styles = ids
        .iter()
        .enumerate()
        .map(|(index, _)| {
            camera_styles.get(index).map_or_else(
                || camera_style_for_intent(&camera_intents[index]),
                String::as_str,
            )
        })
        .collect::<Vec<_>>();
    for ((intent, style), rationale) in camera_intents
        .iter()
        .zip(&resolved_camera_styles)
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
    let valid_demo_id = demo_id.and_then(|value| Uuid::parse_str(value).ok());
    let missing_players = binding
        .selected
        .iter()
        .filter(|item| text(item.get("playerId")).is_none_or(str::is_empty))
        .map(|item| text(item.get("id")).unwrap_or("unknown").to_owned())
        .collect::<Vec<_>>();
    let accepted = binding.ready() && valid_demo_id.is_some() && missing_players.is_empty();
    let items = if accepted {
        binding
            .selected
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let item_camera_style = resolved_camera_styles[index];
                json!({
                    "id": Uuid::new_v4(),
                    "demo_id": valid_demo_id,
                    "highlight_id": text(item.get("id")),
                    "player_id": text(item.get("playerId")),
                    "title": text(item.get("title")).unwrap_or("Highlight video"),
                    "start_tick": round_to_tick(number_value(item.get("startTick")).unwrap_or_default()),
                    "end_tick": round_to_tick(number_value(item.get("endTick")).unwrap_or_default()),
                    "pre_roll_seconds": lead,
                    "post_roll_seconds": tail,
                    "victim_pov": false,
                    "camera_style": item_camera_style
                })
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let cinematic_context =
        read_cinematic_context(context, &json!({"highlightIds":&ids}), external_cinematic)?;
    let scenes = cinematic_context
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (index, intent) in camera_intents.iter().enumerate() {
        let has_spatial_evidence = scenes
            .get(index)
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
                json!({
                    "highlight_id": id,
                    "map_name": context.analysis.get("map_name"),
                    "camera_intent": camera_intents[index],
                    "camera_style": resolved_camera_styles[index],
                    "rationale": camera_rationales[index],
                    "spatial_evidence": scenes.get(index),
                    "requires_user_review": true,
                })
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut rejection_reasons = binding.rejection_reasons();
    if valid_demo_id.is_none() {
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
        "output": {"container":"mp4"},
        "source_highlight_ids": if accepted { ids.clone() } else { Vec::new() },
        "requires_user_confirmation": true
    });
    let plan = accepted.then(|| CapturedPlan {
        kind: CapturedPlanKind::VideoRender,
        title: "Highlight video generation".into(),
        payload: payload.clone(),
    });
    Ok((
        json!({
            "accepted": accepted,
            "plan": payload,
            "rejectionReasons": rejection_reasons,
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

fn read_audio_analysis(context: &AgentContext, input: &Value) -> Value {
    let Some(analysis) = context.audio_analysis.as_object() else {
        return json!({"available":false,"analysis":null});
    };
    if bool_value(input.get("includeEnergyCurve"), false) {
        return json!({"available":true,"analysis":analysis});
    }
    let mut summary = analysis.clone();
    summary.remove("energy");
    json!({"available":true,"analysis":summary})
}

fn draft_beat_alignment(
    context: &AgentContext,
    input: &Value,
) -> Result<(Value, Option<CapturedPlan>), String> {
    if input
        .get("acknowledgeAdvisoryOnly")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err("acknowledgeAdvisoryOnly must be true".into());
    }
    let Some(draft) = context.beat_alignment_draft.as_object() else {
        return Ok((json!({"available":false,"draft":null}), None));
    };
    let project_id = text(context.editor_project.get("id"));
    let revision = integer(context.editor_project.get("revision"));
    let audio_id = text(context.selected_audio.get("assetId"));
    let placement = context
        .selected_audio
        .get("placement")
        .filter(|value| value.is_object());
    let plan = project_id.zip(revision).zip(audio_id).zip(placement).map(|(((project_id, revision), audio_id), placement)| CapturedPlan {
        kind: CapturedPlanKind::BeatAlignment, title:"BGM beat alignment".into(),
        payload:json!({"project_id":project_id,"expected_revision":revision,"audio_asset_id":audio_id,"audio_placement":placement,"draft":draft}),
    });
    Ok((json!({"available":true,"draft":draft}), plan))
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
        Some(json!({"id":id,"kind":text(item.get("kind")).unwrap_or_default(),"title":text(item.get("title")).or_else(||text(item.get("label"))).unwrap_or("Highlight"),"playerId":text(item.get("player_id")).unwrap_or_default(),"round":number_value(item.get("round")),"startTick":start,"endTick":end,"score":number_value(item.get("score")).or_else(||number_value(item.get("confidence"))),"description":text(item.get("description")).unwrap_or_default(),"victims":array(item.get("victims")).filter_map(Value::as_str).collect::<Vec<_>>(),"tags":array(item.get("tags")).filter_map(Value::as_str).collect::<Vec<_>>() }))
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

    fn context() -> AgentContext {
        AgentContext {
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

    #[test]
    fn creation_mode_exposes_only_the_materializable_video_proposal() {
        let names = |mode| {
            tool_definitions()
                .into_iter()
                .filter(|(name, _, _)| tool_allowed_in_mode(mode, name))
                .map(|(name, _, _)| name)
                .collect::<Vec<_>>()
        };

        let creation = names(AgentMode::Hlae);
        assert!(creation.contains(&"read_cinematic_context"));
        assert!(creation.contains(&"draft_video_plan"));
        assert!(!creation.contains(&"draft_edit_plan"));
        assert!(!creation.contains(&"draft_agent_plan_changes"));
        assert!(!creation.contains(&"draft_beat_alignment"));

        let editing = names(AgentMode::Edit);
        assert!(editing.contains(&"draft_edit_plan"));
        assert!(editing.contains(&"draft_agent_plan_changes"));
        assert!(!editing.contains(&"draft_video_plan"));

        let guide = names(AgentMode::Guide);
        assert!(!guide.iter().any(|name| name.starts_with("draft_")));
    }

    #[test]
    fn workspace_navigation_emits_only_a_typed_destination() {
        let (output, plan) = execute_tool(
            "navigate_workspace",
            &context(),
            &json!({"destination":"replay"}),
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
            "projectId":null,"playerId":"76561198000000001","roundNumber":7,"tick":640
        });
        let (output, plan) =
            execute_tool("read_workspace_context", &value, &json!({})).expect("workspace context");
        assert_eq!(output["destination"], "replay");
        assert_eq!(output["tick"], 640);
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
    fn hlae_plan_binds_exact_highlight_evidence() {
        let (output, plan) = draft_hlae_plan(
            &context(),
            &json!({"highlightIds":["ace-1"],"cameraStyle":"orbit","mode":"preview"}),
        )
        .unwrap();
        assert_eq!(output["accepted"], true);
        assert_eq!(plan.unwrap().payload["highlight_ids"], json!(["ace-1"]));
    }

    #[test]
    fn cinematic_context_exposes_map_space_and_recommends_purposeful_motion() {
        let (output, plan) = execute_tool(
            "read_cinematic_context",
            &context(),
            &json!({"highlightIds":["ace-1"]}),
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
        assert!(
            output["scenes"][0]["recommendedDesigns"]
                .as_array()
                .unwrap()
                .iter()
                .any(|design| design["intent"] == "follow_entry")
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
            "read_cinematic_context",
            &context(),
            &json!({"highlightIds":["ace-1"]}),
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

        let (output, plan) = execute_tool(
            "draft_video_plan",
            &context,
            &json!({
                "highlightIds":["ace-1","clutch-2"],
                "leadSeconds":2.0,
                "tailSeconds":2.5,
                "cameraStyles":["crane","flyby"],
                "cameraIntents":["establish_location","transition_through_space"],
                "cameraRationales":[
                    "Establish the occupied map lane before the eliminations.",
                    "Travel through the proven action axis into the clutch."
                ]
            }),
        )
        .expect("video plan");

        assert_eq!(output["accepted"], true);
        let plan = plan.expect("accepted video proposal");
        assert_eq!(plan.kind, CapturedPlanKind::VideoRender);
        assert_eq!(plan.payload["output"]["container"], "mp4");
        assert_eq!(plan.payload["items"][0]["demo_id"], context.demo["id"]);
        assert_eq!(plan.payload["items"][0]["highlight_id"], "ace-1");
        assert_eq!(plan.payload["items"][0]["player_id"], "player-1");
        assert_eq!(plan.payload["items"][0]["start_tick"], 640);
        assert_eq!(plan.payload["items"][0]["end_tick"], 1280);
        assert_eq!(plan.payload["items"][0]["pre_roll_seconds"], 2.0);
        assert_eq!(plan.payload["items"][0]["post_roll_seconds"], 2.5);
        assert_eq!(plan.payload["items"][0]["victim_pov"], false);
        assert_eq!(plan.payload["items"][0]["camera_style"], "crane");
        assert_eq!(plan.payload["items"][1]["highlight_id"], "clutch-2");
        assert_eq!(plan.payload["items"][1]["camera_style"], "flyby");
        assert_eq!(
            plan.payload["shot_designs"][0]["camera_intent"],
            "establish_location"
        );
    }

    #[test]
    fn edit_plan_emits_the_current_explicit_nullable_target_shape() {
        let (_, plan) = draft_edit_plan(
            &context(),
            &json!({"highlightIds":["ace-1"],"pacing":"energetic"}),
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
            &json!({"highlightIds":["missing","missing"],"pacing":"impact"}),
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
        let result = search_rounds(&context, &json!({"winningSide":"T"})).unwrap();
        assert_eq!(result["rounds"][0]["round"], 7);
        assert!(search_rounds(&context, &json!({"winningSide":"A"})).is_err());
    }
}
