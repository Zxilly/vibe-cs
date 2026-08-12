use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use rig_agent::tool::DynamicTool;
use rig_core::tool::{ToolExecutionError, ToolOutput};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;

use crate::AgentContext;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapturedToolCall {
    pub name: String,
    pub input: Value,
    pub output: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapturedPlan {
    pub kind: String,
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
    captures: Arc<Mutex<Captures>>,
}

impl ToolState {
    pub(crate) fn new(context: AgentContext) -> Self {
        Self {
            context: Arc::new(context),
            captures: Arc::new(Mutex::new(Captures::default())),
        }
    }

    pub(crate) async fn snapshot(&self) -> (Vec<CapturedToolCall>, Vec<CapturedPlan>) {
        let captures = self.captures.lock().await;
        (captures.tool_calls.clone(), captures.plans.clone())
    }

    async fn execute(&self, name: &str, input: Value) -> Result<Value, ToolExecutionError> {
        let (output, plan) =
            execute_tool(name, &self.context, &input).map_err(ToolExecutionError::invalid_args)?;
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
}

pub(crate) fn create_tools(state: &ToolState) -> Vec<DynamicTool> {
    tool_definitions()
        .into_iter()
        .map(|(name, description, parameters)| {
            let state = state.clone();
            DynamicTool::new(name, description, parameters, move |_context, input| {
                let state = state.clone();
                Box::pin(async move { state.execute(name, input).await.map(ToolOutput::json) })
            })
        })
        .collect()
}

fn tool_definitions() -> Vec<(&'static str, &'static str, Value)> {
    vec![
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
                    "winningSide": {"type":"string","enum":["A","B"]}, "playerIds": string_array_schema(10),
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
            "draft_hlae_plan",
            "Draft a reviewable HLAE camera intent from verified demo ticks. Preview inspects paths; capture exports image-sequence commands. Emits data only.",
            object_schema(
                json!({
                    "highlightIds": string_array_schema(16), "cameraStyle": {"type":"string","enum":["pov","orbit","dolly"]},
                    "mode": {"type":"string","enum":["preview","capture"],"default":"preview"},
                    "leadSeconds": {"type":"number","minimum":0.5,"maximum":8,"default":2.5},
                    "tailSeconds": {"type":"number","minimum":0.5,"maximum":8,"default":2}
                }),
                &["highlightIds", "cameraStyle"],
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

fn execute_tool(
    name: &str,
    context: &AgentContext,
    input: &Value,
) -> Result<(Value, Option<CapturedPlan>), String> {
    ensure_object(input)?;
    match name {
        "read_demo_evidence" => Ok((read_demo_evidence(context, input)?, None)),
        "search_rounds" => Ok((search_rounds(context, input)?, None)),
        "read_round_context" => Ok((read_round_context(context, input)?, None)),
        "read_round_events" => Ok((read_round_events(context, input)?, None)),
        "read_player_matchups" => Ok((read_player_matchups(context, input)?, None)),
        "read_highlights" => Ok((read_highlights(context, input)?, None)),
        "read_editor_timeline" => Ok((read_editor_timeline(context, input), None)),
        "draft_edit_plan" => draft_edit_plan(context, input),
        "draft_hlae_plan" => draft_hlae_plan(context, input),
        "read_audio_analysis" => Ok((read_audio_analysis(context, input), None)),
        "draft_beat_alignment" => draft_beat_alignment(context, input),
        _ => Err(format!("unknown tool: {name}")),
    }
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
    if winning_side.is_some_and(|value| !matches!(value, "A" | "B")) {
        return Err("winningSide must be A or B".into());
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
    let payload = json!({"schemaVersion":1,"pacing":pacing,"tickRate":tick_rate,"clips":clips,"missingHighlightIds":binding.missing,"duplicateHighlightIds":binding.duplicates,"ambiguousHighlightIds":binding.ambiguous,"rejectionReasons":rejection_reasons});
    let plan = accepted.then(|| CapturedPlan { kind:"highlight_edit".into(), title:"Recorded highlight edit draft".into(), payload:json!({"demo_id":demo_id,"highlight_ids":ids,"intent":{"pacing":pacing,"include_context_seconds":include,"transition":resolved}}) });
    Ok((json!({"accepted":accepted,"plan":payload}), plan))
}

fn draft_hlae_plan(
    context: &AgentContext,
    input: &Value,
) -> Result<(Value, Option<CapturedPlan>), String> {
    let ids = string_vec_required(input, "highlightIds", 16)?;
    let camera = enum_value(input, "cameraStyle", &["pov", "orbit", "dolly"])?;
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
        kind: "hlae".into(),
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
        kind:"beat_alignment".into(), title:"BGM beat alignment".into(),
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
            analysis: json!({"tick_rate":64,"highlights":[{"id":"ace-1","kind":"ace","title":"ACE","start_tick":640,"end_tick":1280,"description":"five kills"}]}),
            ..AgentContext::default()
        }
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
    fn edit_plan_rejects_missing_and_duplicate_ids() {
        let (output, plan) = draft_edit_plan(
            &context(),
            &json!({"highlightIds":["missing","missing"],"pacing":"impact"}),
        )
        .unwrap();
        assert_eq!(output["accepted"], false);
        assert!(plan.is_none());
        assert_eq!(output["plan"]["missingHighlightIds"], json!(["missing"]));
        assert_eq!(output["plan"]["duplicateHighlightIds"], json!(["missing"]));
    }
}
