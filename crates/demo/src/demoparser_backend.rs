use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
};

use ahash::AHashMap;
use demoparser::{
    first_pass::read_bits::DemoParserError,
    first_pass::{
        parser_settings::{ParserInputs, rm_user_friendly_names},
        prop_controller::TICK_ID,
    },
    parse_demo::{Parser as FastParser, ParserResourceError, ParserResourceOptions, ParsingMode},
    second_pass::{
        game_events::GameEvent,
        parser_settings::{PlayerEndMetaData, create_huffman_lookup_table},
        variants::{PropColumn, VarVec, Variant},
    },
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use source2_demo::prelude::Parser as MetadataParser;
use uuid::Uuid;
use vibe_cs_domain::MatchAnalysis;

use crate::{
    DemoError, DemoResult, ParseCancellation,
    engine::{
        DemoEngineConfig, ParsedEvent, PlayerIdentities, PlayerIdentity, build_rounds_and_players,
        build_teams, verified_replay_metadata,
    },
    entity_replay::attach_entity_replay,
    validate_demo,
};

const FAST_EVENTS: &[&str] = &[
    "round_start",
    "round_end",
    "player_death",
    "player_hurt",
    "bomb_planted",
    "bomb_defused",
    "bomb_exploded",
    "item_purchase",
    "grenade_thrown",
    "hegrenade_detonate",
    "flashbang_detonate",
    "smokegrenade_detonate",
    "smokegrenade_expired",
    "decoy_started",
    "decoy_detonate",
    "inferno_startburn",
    "inferno_expire",
    "player_blind",
];
const MAXIMUM_COMPETITIVE_ROUNDS: usize = 128;

pub(crate) fn analyze_fast(
    path: &Path,
    demo_id: Uuid,
    config: DemoEngineConfig,
    cancellation: &ParseCancellation,
) -> DemoResult<MatchAnalysis> {
    let validated = validate_demo(path, config.validation, cancellation)?;
    cancellation.check()?;
    // The worker owns these immutable bytes for the full parse. This avoids mapping a file that
    // another process could truncate while demoparser's parallel workers still hold slices.
    let bytes =
        std::fs::read(&validated.path).map_err(|error| crate::io_error(&validated.path, error))?;
    let actual_size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    let actual_sha256 = hex::encode(Sha256::digest(&bytes));
    if actual_size != validated.size || actual_sha256 != validated.sha256 {
        return Err(DemoError::Io {
            path: validated.path,
            source: std::io::Error::other("demo changed while it was being opened for parsing"),
        });
    }
    cancellation.check()?;

    let metadata = MetadataParser::new(&bytes)
        .map_err(|error| DemoError::Parse(format!("metadata parser: {error}")))?;
    let (verified_total_ticks, playback_time, tick_rate) =
        verified_replay_metadata(metadata.replay_info())?;

    let huffman = create_huffman_lookup_table();
    let wanted_player_props = ["X", "Y", "Z", "team_num"]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let wanted_other_props = ["total_rounds_played", "is_warmup_period"]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let real_player_props = rm_user_friendly_names(&wanted_player_props)
        .map_err(|error| DemoError::Parse(format!("demoparser player properties: {error}")))?;
    let real_other_props = rm_user_friendly_names(&wanted_other_props)
        .map_err(|error| DemoError::Parse(format!("demoparser match properties: {error}")))?;
    let real_name_to_og_name = real_player_props
        .iter()
        .zip(&wanted_player_props)
        .chain(real_other_props.iter().zip(&wanted_other_props))
        .map(|(real, friendly)| (real.clone(), friendly.clone()))
        .collect::<AHashMap<_, _>>();
    let inputs = ParserInputs {
        real_name_to_og_name,
        wanted_players: Vec::new(),
        wanted_player_props: real_player_props,
        wanted_other_props: real_other_props,
        wanted_prop_states: AHashMap::default(),
        wanted_ticks: Vec::new(),
        wanted_events: FAST_EVENTS.iter().map(ToString::to_string).collect(),
        parse_ents: true,
        parse_projectiles: false,
        parse_grenades: false,
        only_header: true,
        only_convars: false,
        huffman_lookup_table: &huffman,
        order_by_steamid: false,
        list_props: false,
        fallback_bytes: None,
    };
    let mut parser = FastParser::with_resource_options(
        inputs,
        ParsingMode::Normal,
        ParserResourceOptions {
            max_game_events: config.maximum_events,
            max_collected_rows: 0,
            ..ParserResourceOptions::default()
        },
    )
    .map_err(parser_resource_policy_error)?;
    let output = parser.parse_demo(&bytes).map_err(parser_decode_error)?;
    cancellation.check()?;

    if output.game_events.len() > config.maximum_events {
        return Err(DemoError::EventLimitExceeded {
            limit: config.maximum_events,
        });
    }

    let map_name = output
        .header
        .as_ref()
        .and_then(|header| header.get("map_name"))
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .ok_or(DemoError::MetadataUnavailable("map name"))?;
    let identities = collect_player_identities(
        &output.player_md,
        &output.roster,
        &output.game_events,
        &output.player_userids,
    );
    let mut events = output
        .game_events
        .into_iter()
        .enumerate()
        .map(|(sequence, event)| convert_event(sequence as u64, event))
        .filter(|event| !event_is_warmup(event))
        .collect::<Vec<_>>();
    events = competitive_events(events)?;
    attach_selected_tick_rosters(&mut events, &bytes, &huffman, config)?;
    if events.len() > config.maximum_events {
        return Err(DemoError::EventLimitExceeded {
            limit: config.maximum_events,
        });
    }
    let (mut rounds, players) = build_rounds_and_players(&events, tick_rate, &identities)?;
    attach_entity_replay(
        &mut rounds,
        &[],
        Some(
            "fast statistics parsing omits dense entity replay; request replay as a separate operation",
        ),
    );
    let teams = build_teams(&players, &rounds);
    let highlights = crate::classify_highlights_with_players(&rounds, &players, config.highlights);
    Ok(MatchAnalysis {
        demo_id,
        map_name,
        tick_rate,
        duration_seconds: playback_time,
        verified_total_ticks: Some(verified_total_ticks),
        teams,
        players,
        rounds,
        highlights,
    })
}

fn attach_selected_tick_rosters(
    events: &mut [ParsedEvent],
    bytes: &[u8],
    huffman: &Vec<(u8, u8)>,
    config: DemoEngineConfig,
) -> DemoResult<()> {
    let wanted_ticks = events
        .iter()
        .filter(|event| event.name == "round_start")
        .filter_map(|event| i32::try_from(event.tick).ok())
        .collect::<Vec<_>>();
    if wanted_ticks.is_empty() || wanted_ticks.len() > MAXIMUM_COMPETITIVE_ROUNDS {
        return Err(DemoError::ParserResourceLimit {
            resource: "round_roster_ticks".to_owned(),
            limit: MAXIMUM_COMPETITIVE_ROUNDS,
            actual: wanted_ticks.len(),
        });
    }

    let friendly_props = vec!["team_num".to_owned()];
    let real_props = rm_user_friendly_names(&friendly_props)
        .map_err(|error| DemoError::Parse(format!("demoparser roster properties: {error}")))?;
    let real_name_to_og_name = real_props
        .iter()
        .zip(&friendly_props)
        .map(|(real, friendly)| (real.clone(), friendly.clone()))
        .collect();
    let inputs = ParserInputs {
        real_name_to_og_name,
        wanted_players: Vec::new(),
        wanted_player_props: real_props,
        wanted_other_props: Vec::new(),
        wanted_prop_states: AHashMap::default(),
        wanted_ticks: wanted_ticks.clone(),
        wanted_events: Vec::new(),
        parse_ents: true,
        parse_projectiles: false,
        parse_grenades: false,
        only_header: true,
        only_convars: false,
        huffman_lookup_table: huffman,
        order_by_steamid: true,
        list_props: false,
        fallback_bytes: None,
    };
    let mut parser = FastParser::with_resource_options(
        inputs,
        ParsingMode::Normal,
        ParserResourceOptions {
            max_game_events: config.maximum_events,
            max_collected_rows: MAXIMUM_COMPETITIVE_ROUNDS * 64,
            ..ParserResourceOptions::default()
        },
    )
    .map_err(parser_resource_policy_error)?;
    let output = parser.parse_demo(bytes).map_err(parser_decode_error)?;
    let team_prop_id = output
        .prop_controller
        .prop_infos
        .iter()
        .find(|info| info.prop_friendly_name == "team_num")
        .map(|info| info.id)
        .ok_or_else(|| DemoError::Parse("demoparser roster team property is absent".to_owned()))?;
    let rosters = selected_tick_rosters(&output.df_per_player, team_prop_id);
    for event in events
        .iter_mut()
        .filter(|event| event.name == "round_start")
    {
        let roster = i32::try_from(event.tick)
            .ok()
            .and_then(|tick| rosters.get(&tick).cloned())
            .and_then(complete_competitive_roster)
            .unwrap_or_default();
        event.fields.insert(
            "_round_roster".to_owned(),
            serde_json::to_value(roster).expect("round roster serialization cannot fail"),
        );
    }
    Ok(())
}

fn selected_tick_rosters(
    per_player: &AHashMap<u64, AHashMap<u32, PropColumn>>,
    team_prop_id: u32,
) -> BTreeMap<i32, BTreeMap<String, String>> {
    let mut rosters = BTreeMap::<i32, BTreeMap<String, String>>::new();
    for (steam_id, columns) in per_player {
        if *steam_id == 0 {
            continue;
        }
        let Some(VarVec::I32(ticks)) = columns
            .get(&TICK_ID)
            .and_then(|column| column.data.as_ref())
        else {
            continue;
        };
        let Some(teams) = columns
            .get(&team_prop_id)
            .and_then(|column| column.data.as_ref())
        else {
            continue;
        };
        for (index, tick) in ticks.iter().enumerate() {
            let Some(tick) = tick else {
                continue;
            };
            let team = match team_number_at(teams, index) {
                Some(2) => "T",
                Some(3) => "CT",
                _ => continue,
            };
            rosters
                .entry(*tick)
                .or_default()
                .insert(steam_id.to_string(), team.to_owned());
        }
    }
    rosters
}

fn team_number_at(values: &VarVec, index: usize) -> Option<i64> {
    match values {
        VarVec::I32(values) => values.get(index).copied().flatten().map(i64::from),
        VarVec::U32(values) => values.get(index).copied().flatten().map(i64::from),
        _ => None,
    }
}

fn parser_resource_policy_error(error: ParserResourceError) -> DemoError {
    let (resource, limit, actual) = match error {
        ParserResourceError::InvalidThreadCount { requested, maximum } => {
            ("rayon_threads", maximum, requested)
        }
        ParserResourceError::InvalidResourceLimit {
            resource,
            requested,
            maximum,
        } => (resource, maximum, requested),
        ParserResourceError::InvalidHuffmanTableLength { expected, actual } => {
            ("huffman_lookup_table", expected, actual)
        }
        ParserResourceError::ThreadPoolBuild(message) => {
            return DemoError::Parse(format!("demoparser thread pool: {message}"));
        }
    };
    DemoError::ParserResourceLimit {
        resource: resource.to_owned(),
        limit,
        actual,
    }
}

fn parser_decode_error(error: DemoParserError) -> DemoError {
    match error {
        DemoParserError::ResourceLimitExceeded {
            resource,
            limit,
            actual,
        } => DemoError::ParserResourceLimit {
            resource: resource.to_owned(),
            limit,
            actual,
        },
        error => DemoError::Parse(format!("demoparser: {error}")),
    }
}

fn event_is_warmup(event: &ParsedEvent) -> bool {
    event
        .fields
        .get("is_warmup_period")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn competitive_events(mut events: Vec<ParsedEvent>) -> DemoResult<Vec<ParsedEvent>> {
    let mut starts = HashMap::<u64, ParsedEvent>::new();
    let mut ends = HashMap::<u64, ParsedEvent>::new();
    for event in &events {
        let round = event
            .fields
            .get("total_rounds_played")
            .and_then(Value::as_u64);
        match (event.name.as_str(), round) {
            ("round_start", Some(completed)) => {
                starts
                    .entry(completed.saturating_add(1))
                    .or_insert_with(|| event.clone());
            }
            ("round_end", Some(number)) if number > 0 && has_round_winner(&event.fields) => {
                ends.entry(number).or_insert_with(|| event.clone());
            }
            _ => {}
        }
    }
    let mut boundaries = starts
        .into_iter()
        .filter_map(|(number, start)| {
            let end = ends.remove(&number)?;
            (start.tick <= end.tick).then_some((number, start, end))
        })
        .collect::<Vec<_>>();
    boundaries.sort_by_key(|(number, _, _)| *number);
    if boundaries.is_empty() {
        let round_samples = events
            .iter()
            .filter(|event| matches!(event.name.as_str(), "round_start" | "round_end"))
            .take(3)
            .map(|event| format!("{}@{} {:?}", event.name, event.tick, event.fields))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(DemoError::Parse(format!(
            "demoparser decoded no paired competitive round boundaries: {round_samples}"
        )));
    }
    if boundaries.len() > MAXIMUM_COMPETITIVE_ROUNDS {
        return Err(DemoError::ParserResourceLimit {
            resource: "competitive_rounds".to_owned(),
            limit: MAXIMUM_COMPETITIVE_ROUNDS,
            actual: boundaries.len(),
        });
    }

    events.sort_by_key(|event| (event.tick, event.sequence));
    let mut selected = Vec::new();
    let mut cursor = 0;
    for (_, mut start, end) in boundaries {
        let start_key = (start.tick, start.sequence);
        let end_key = (end.tick, end.sequence);
        while cursor < events.len() && (events[cursor].tick, events[cursor].sequence) < start_key {
            cursor += 1;
        }
        let mut interval_events = Vec::new();
        while cursor < events.len() && (events[cursor].tick, events[cursor].sequence) < end_key {
            if !matches!(events[cursor].name.as_str(), "round_start" | "round_end") {
                interval_events.push(events[cursor].clone());
            }
            cursor += 1;
        }
        let roster = round_roster(&interval_events);
        let roster = complete_competitive_roster(roster);
        start.fields.insert(
            "_round_roster".to_owned(),
            serde_json::to_value(roster.unwrap_or_default())
                .expect("round roster serialization cannot fail"),
        );
        selected.push(start);
        selected.extend(interval_events);
        selected.push(end);
    }
    selected.sort_by_key(|event| (event.tick, event.sequence));
    Ok(selected)
}

fn complete_competitive_roster(
    roster: BTreeMap<String, String>,
) -> Option<BTreeMap<String, String>> {
    let terrorists = roster.values().filter(|team| team.as_str() == "T").count();
    let counter_terrorists = roster.values().filter(|team| team.as_str() == "CT").count();
    (roster.len() == 10 && terrorists == 5 && counter_terrorists == 5).then_some(roster)
}

fn has_round_winner(fields: &Map<String, Value>) -> bool {
    match fields.get("winner") {
        Some(Value::Number(number)) => number.as_i64().is_some(),
        Some(Value::String(side)) => {
            matches!(side.trim().to_ascii_uppercase().as_str(), "T" | "CT")
        }
        _ => false,
    }
}

fn round_roster(events: &[ParsedEvent]) -> BTreeMap<String, String> {
    let mut roster = BTreeMap::new();
    for event in events {
        for role in ["user", "attacker", "assister"] {
            let Some(steam_id) = event
                .fields
                .get(&format!("{role}_steamid"))
                .and_then(json_u64)
                .filter(|steam_id| *steam_id > 0)
            else {
                continue;
            };
            let Some(team) = event
                .fields
                .get(&format!("{role}_team_num"))
                .and_then(Value::as_i64)
                .and_then(|team| match team {
                    2 => Some("T"),
                    3 => Some("CT"),
                    _ => None,
                })
            else {
                continue;
            };
            roster.insert(steam_id.to_string(), team.to_owned());
        }
    }
    roster
}

fn json_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

fn collect_player_identities(
    player_md: &[PlayerEndMetaData],
    roster: &[PlayerEndMetaData],
    events: &[GameEvent],
    player_userids: &BTreeMap<u64, Option<i32>>,
) -> PlayerIdentities {
    let mut identities = PlayerIdentities::new();
    for player in player_md.iter().chain(roster) {
        if let Some(steam_id) = player.steamid.filter(|id| *id > 0) {
            register_identity(&mut identities, steam_id, player.name.as_deref());
        }
    }
    for event in events {
        let values = event
            .fields
            .iter()
            .filter_map(|field| field.data.as_ref().map(|data| (field.name.as_str(), data)))
            .collect::<HashMap<_, _>>();
        for role in ["user", "attacker", "assister"] {
            let Some(Variant::U64(steam_id)) = values.get(format!("{role}_steamid").as_str())
            else {
                continue;
            };
            let name = match values.get(format!("{role}_name").as_str()) {
                Some(Variant::String(name)) => Some(name.as_str()),
                _ => None,
            };
            register_identity(&mut identities, *steam_id, name);
        }
    }
    for (&steam_id, &user_id) in player_userids {
        let Some(identity) = identities.get_mut(&steam_id.to_string()) else {
            continue;
        };
        if let Some(slot) = user_id.and_then(super::engine::spectator_slot_from_userid) {
            identity.spectator_slot = Some(slot);
        } else {
            identity.spectator_slot = None;
            identity.spectator_slot_conflicted = true;
        }
    }
    identities
}

fn register_identity(identities: &mut PlayerIdentities, steam_id: u64, name: Option<&str>) {
    let stable_id = steam_id.to_string();
    let name = name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&stable_id)
        .to_owned();
    identities.insert(
        stable_id.clone(),
        PlayerIdentity {
            stable_id,
            name,
            spectator_slot: None,
            spectator_slot_conflicted: false,
        },
    );
}

fn convert_event(sequence: u64, event: GameEvent) -> ParsedEvent {
    let mut fields: Map<String, Value> = event
        .fields
        .into_iter()
        .filter_map(|field| field.data.map(|data| (field.name, variant_to_json(data))))
        .collect();
    add_alias(&mut fields, "attacker_team_num", "attackerteam");
    add_alias(&mut fields, "user_team_num", "userteam");
    if fields.get("winner").is_some_and(Value::is_string) {
        add_alias(&mut fields, "winner", "winner_name");
    }
    if event.name == "round_end"
        && let Some(reason) = fields.get("reason").and_then(Value::as_str)
        && let Some(message) = canonical_round_reason(reason)
    {
        fields.insert("reason".to_owned(), Value::String(message.to_owned()));
    }
    // Generic event coordinates belong to the event subject (`user`). Attacker coordinates stay
    // role-qualified so downstream consumers cannot accidentally draw a victim at the shooter's
    // position. Native effect coordinates already use `x/y/z` and therefore remain untouched.
    for (source, target) in [("user_X", "x"), ("user_Y", "y"), ("user_Z", "z")] {
        add_alias(&mut fields, source, target);
    }
    ParsedEvent {
        sequence,
        tick: u64::try_from(event.tick).unwrap_or_default(),
        name: event.name,
        fields,
    }
}

fn canonical_round_reason(reason: &str) -> Option<&'static str> {
    match reason {
        "t_killed" => Some("#SFUI_Notice_CTs_Win"),
        "ct_killed" => Some("#SFUI_Notice_Terrorists_Win"),
        "bomb_defused" => Some("#SFUI_Notice_Bomb_Defused"),
        "bomb_exploded" => Some("#SFUI_Notice_Target_Bombed"),
        "time_ran_out" => Some("#SFUI_Notice_Target_Saved"),
        _ => None,
    }
}

fn add_alias(fields: &mut Map<String, Value>, source: &str, target: &str) {
    if !fields.contains_key(target)
        && let Some(value) = fields.get(source).cloned()
    {
        fields.insert(target.to_owned(), value);
    }
}

fn variant_to_json(value: Variant) -> Value {
    match value {
        Variant::Bool(value) => Value::Bool(value),
        Variant::U32(value) => Value::from(value),
        Variant::I32(value) => Value::from(value),
        Variant::F32(value) => {
            serde_json::Number::from_f64(f64::from(value)).map_or(Value::Null, Value::Number)
        }
        Variant::U64(value) => Value::from(value),
        Variant::String(value) => Value::String(value),
        Variant::VecXY(value) => Value::Array(value.into_iter().map(Value::from).collect()),
        Variant::VecXYZ(value) => Value::Array(value.into_iter().map(Value::from).collect()),
        Variant::StringVec(value) => Value::Array(value.into_iter().map(Value::from).collect()),
        Variant::U32Vec(value) => Value::Array(value.into_iter().map(Value::from).collect()),
        Variant::U64Vec(value) => Value::Array(value.into_iter().map(Value::from).collect()),
        Variant::Stickers(value) => serde_json::to_value(value).unwrap_or(Value::Null),
        Variant::InputHistory(value) => serde_json::to_value(value).unwrap_or(Value::Null),
        Variant::UserCmdSubtickMoves(value) => serde_json::to_value(value).unwrap_or(Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use demoparser::second_pass::game_events::EventField;
    use serde_json::json;

    use super::*;

    #[test]
    fn fast_userinfo_evidence_becomes_a_player_spectator_slot() {
        let steam_id = 76_561_198_000_000_001_u64;
        let player_md = vec![PlayerEndMetaData {
            steamid: Some(steam_id),
            name: Some("Player One".to_owned()),
            team_number: Some(2),
        }];
        let player_userids = BTreeMap::from([(steam_id, Some(9))]);
        let identities = collect_player_identities(&player_md, &[], &[], &player_userids);
        let parsed = vec![
            ParsedEvent {
                sequence: 0,
                tick: 10,
                name: "round_start".to_owned(),
                fields: Map::new(),
            },
            ParsedEvent {
                sequence: 1,
                tick: 20,
                name: "player_death".to_owned(),
                fields: serde_json::json!({
                    "attacker_steamid": steam_id,
                    "user_steamid": 0,
                    "weapon": "world"
                })
                .as_object()
                .expect("object")
                .clone(),
            },
            ParsedEvent {
                sequence: 2,
                tick: 30,
                name: "round_end".to_owned(),
                fields: serde_json::json!({"winner": 2})
                    .as_object()
                    .expect("object")
                    .clone(),
            },
        ];

        let (_, players) =
            build_rounds_and_players(&parsed, 64.0, &identities).expect("one competitive round");

        assert_eq!(players[0].steam_id, steam_id.to_string());
        assert_eq!(players[0].spectator_slot, Some(10));
    }

    #[test]
    fn converts_demoparser_event_values_without_losing_identity_or_position() {
        let event = GameEvent {
            name: "player_death".to_owned(),
            tick: 640,
            fields: vec![
                EventField {
                    name: "attacker_steamid".to_owned(),
                    data: Some(Variant::U64(76_561_198_000_000_001)),
                },
                EventField {
                    name: "attacker_X".to_owned(),
                    data: Some(Variant::F32(12.5)),
                },
                EventField {
                    name: "attacker_Y".to_owned(),
                    data: Some(Variant::F32(13.5)),
                },
                EventField {
                    name: "attacker_Z".to_owned(),
                    data: Some(Variant::F32(14.5)),
                },
                EventField {
                    name: "user_X".to_owned(),
                    data: Some(Variant::F32(22.5)),
                },
                EventField {
                    name: "user_Y".to_owned(),
                    data: Some(Variant::F32(23.5)),
                },
                EventField {
                    name: "user_Z".to_owned(),
                    data: Some(Variant::F32(24.5)),
                },
                EventField {
                    name: "headshot".to_owned(),
                    data: Some(Variant::Bool(true)),
                },
            ],
        };

        let converted = convert_event(7, event);

        assert_eq!(converted.sequence, 7);
        assert_eq!(converted.tick, 640);
        assert_eq!(converted.name, "player_death");
        assert_eq!(
            converted.fields["attacker_steamid"],
            json!(76_561_198_000_000_001_u64)
        );
        assert_eq!(converted.fields["attacker_X"], json!(12.5));
        assert_eq!(converted.fields["x"], json!(22.5));
        assert_eq!(converted.fields["y"], json!(23.5));
        assert_eq!(converted.fields["z"], json!(24.5));
        assert_eq!(converted.fields["headshot"], json!(true));
    }

    #[test]
    fn pairs_rounds_by_total_rounds_and_rejects_a_phantom_end() {
        let event = |sequence, tick, name: &str, fields: Value| ParsedEvent {
            sequence,
            tick,
            name: name.to_owned(),
            fields: fields.as_object().expect("object fixture").clone(),
        };
        let events = vec![
            event(0, 1, "round_end", json!({"total_rounds_played": 0})),
            event(1, 100, "round_start", json!({"total_rounds_played": 0})),
            event(2, 120, "player_death", json!({"total_rounds_played": 0})),
            event(
                3,
                200,
                "round_end",
                json!({"total_rounds_played": 1, "winner": "CT"}),
            ),
        ];

        let selected = competitive_events(events).expect("one competitive round");

        assert_eq!(
            selected
                .iter()
                .map(|event| event.name.as_str())
                .collect::<Vec<_>>(),
            ["round_start", "player_death", "round_end"]
        );
    }

    #[test]
    fn normalizes_round_end_reasons_to_the_existing_product_vocabulary() {
        assert_eq!(
            canonical_round_reason("time_ran_out"),
            Some("#SFUI_Notice_Target_Saved")
        );
        assert_eq!(canonical_round_reason("unknown_future_reason"), None);
    }

    #[test]
    fn partial_round_rosters_are_explicitly_unavailable() {
        let partial = (0..9)
            .map(|index| {
                (
                    format!("7656119800000000{index}"),
                    if index < 5 { "T" } else { "CT" }.to_owned(),
                )
            })
            .collect();

        assert_eq!(complete_competitive_roster(partial), None);
    }

    #[test]
    fn selected_tick_columns_form_exact_steam_rosters() {
        let team_prop_id = 1_234;
        let mut per_player = AHashMap::new();
        per_player.insert(
            76_561_198_000_000_001,
            AHashMap::from_iter([
                (
                    TICK_ID,
                    PropColumn {
                        data: Some(VarVec::I32(vec![Some(100), Some(200)])),
                        num_nones: 0,
                    },
                ),
                (
                    team_prop_id,
                    PropColumn {
                        data: Some(VarVec::U32(vec![Some(2), Some(3)])),
                        num_nones: 0,
                    },
                ),
            ]),
        );

        let rosters = selected_tick_rosters(&per_player, team_prop_id);

        assert_eq!(rosters[&100]["76561198000000001"], "T");
        assert_eq!(rosters[&200]["76561198000000001"], "CT");
    }

    #[test]
    #[ignore = "requires VIBE_CS_REAL_DEMO_DIR pointing at the local Major final demos"]
    fn real_major_final_matches_the_verified_summary_oracles() {
        let directory = std::path::PathBuf::from(
            std::env::var("VIBE_CS_REAL_DEMO_DIR").expect("VIBE_CS_REAL_DEMO_DIR"),
        );
        for (file, map, kills, expected_total_ticks) in [
            (
                "furia-vs-falcons-m1-mirage.dem",
                "de_mirage",
                133_usize,
                189_316,
            ),
            ("furia-vs-falcons-m2-anubis.dem", "de_anubis", 139, 211_707),
            (
                "furia-vs-falcons-m3-inferno.dem",
                "de_inferno",
                135,
                216_279,
            ),
        ] {
            let analysis = analyze_fast(
                &directory.join(file),
                Uuid::nil(),
                DemoEngineConfig::default(),
                &ParseCancellation::default(),
            )
            .unwrap_or_else(|error| panic!("fast backend should parse {file}: {error}"));

            assert_eq!(analysis.map_name, map, "{file}");
            assert_eq!(analysis.rounds.len(), 21, "{file}");
            assert_eq!(analysis.players.len(), 10, "{file}");
            let spectator_slots = analysis
                .players
                .iter()
                .map(|player| {
                    player.spectator_slot.unwrap_or_else(|| {
                        panic!(
                            "{file}: {} has no parser-observed spectator slot",
                            player.steam_id
                        )
                    })
                })
                .collect::<std::collections::BTreeSet<_>>();
            assert_eq!(spectator_slots.len(), 10, "{file}");
            assert!(
                spectator_slots.iter().all(|slot| (1..=64).contains(slot)),
                "{file}"
            );
            let verified_total_ticks = analysis
                .verified_total_ticks
                .unwrap_or_else(|| panic!("{file} must persist replay_info.playback_ticks"));
            assert_eq!(verified_total_ticks, expected_total_ticks, "{file}");
            assert!(
                u64::from(verified_total_ticks)
                    >= analysis
                        .rounds
                        .last()
                        .expect("last competitive round")
                        .end_tick,
                "{file}"
            );
            assert!(
                analysis.rounds.iter().all(|round| {
                    round
                        .events
                        .first()
                        .and_then(|event| event.detail.get("_round_roster"))
                        .and_then(Value::as_object)
                        .is_some_and(|roster| roster.len() == 10)
                }),
                "{file} must have a complete selected-tick roster for every round"
            );
            assert_eq!(
                analysis
                    .rounds
                    .iter()
                    .flat_map(|round| &round.events)
                    .filter(|event| event.kind == vibe_cs_domain::EventKind::Kill)
                    .count(),
                kills,
                "{file}"
            );
            assert_eq!(
                analysis.teams.iter().map(|team| team.score).sum::<u32>(),
                21,
                "{file}"
            );
            let clutches = analysis
                .highlights
                .iter()
                .filter(|highlight| highlight.tags.iter().any(|tag| tag == "clutch"))
                .collect::<Vec<_>>();
            if file.contains("m2-") {
                assert_eq!(clutches.len(), 1, "{file}");
                assert_eq!(clutches[0].round, 16, "{file}");
                assert_eq!(clutches[0].player_id, "76561198074762801", "{file}");
                assert_eq!(clutches[0].title, "1v2 clutch", "{file}");
            } else {
                assert!(clutches.is_empty(), "{file}");
            }
        }
    }
}
