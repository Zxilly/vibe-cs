use std::{
    collections::{BTreeMap, HashMap},
    panic::{AssertUnwindSafe, catch_unwind},
    path::Path,
};

use serde_json::{Map, Value};
use source2_demo::prelude::*;
use source2_demo::proto::CMsgPlayerInfo;
use uuid::Uuid;
use vibe_cs_domain::{
    EventKind, MatchAnalysis, PlayerStats, RoundSummary, TeamSummary, TimelineEvent,
};

use crate::{
    DemoError, DemoResult, EntityReplayLimits, HighlightPolicy, ParseCancellation,
    ValidationLimits, classify_highlights_with_players,
    entity_replay::{EntityReplayCapture, attach_entity_replay},
    validate_demo,
};

#[derive(Debug, Clone, Copy)]
pub struct DemoEngineConfig {
    pub validation: ValidationLimits,
    pub maximum_events: usize,
    pub highlights: HighlightPolicy,
    pub entity_replay: EntityReplayLimits,
}

impl Default for DemoEngineConfig {
    fn default() -> Self {
        Self {
            validation: ValidationLimits::default(),
            maximum_events: 500_000,
            highlights: HighlightPolicy::default(),
            entity_replay: EntityReplayLimits::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DemoEngine {
    config: DemoEngineConfig,
}

impl Default for DemoEngine {
    fn default() -> Self {
        Self::new(DemoEngineConfig::default())
    }
}

impl DemoEngine {
    #[must_use]
    pub const fn new(config: DemoEngineConfig) -> Self {
        Self { config }
    }

    /// Validates and parses a demo on Tokio's blocking pool. The size limit is
    /// enforced before the file is allocated into memory.
    ///
    /// # Errors
    ///
    /// Returns an explicit validation, cancellation, metadata, or parser error;
    /// incomplete input is never replaced with synthetic match data.
    pub async fn analyze(
        &self,
        path: impl AsRef<Path>,
        demo_id: Uuid,
        cancellation: ParseCancellation,
    ) -> DemoResult<MatchAnalysis> {
        let path = path.as_ref().to_path_buf();
        let config = self.config;
        tokio::task::spawn_blocking(move || {
            let result = catch_unwind(AssertUnwindSafe(|| {
                analyze_blocking(&path, demo_id, config, &cancellation)
            }));
            match result {
                Ok(result) => result,
                Err(_) => Err(DemoError::ParserPanicked),
            }
        })
        .await
        .map_err(|error| DemoError::Join(error.to_string()))?
    }

    /// Analyzes a demo using a newly generated application identifier.
    ///
    /// # Errors
    ///
    /// Returns the same validation and parsing errors as [`Self::analyze`].
    pub async fn analyze_new(
        &self,
        path: impl AsRef<Path>,
        cancellation: ParseCancellation,
    ) -> DemoResult<MatchAnalysis> {
        self.analyze(path, Uuid::new_v4(), cancellation).await
    }
}

#[derive(Debug, Clone)]
struct ParsedEvent {
    sequence: u64,
    tick: u64,
    name: String,
    fields: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlayerIdentity {
    stable_id: String,
    name: String,
}

type PlayerIdentities = HashMap<String, PlayerIdentity>;

#[derive(Debug)]
struct EventObserver {
    cancellation: ParseCancellation,
    maximum_events: usize,
    events: Vec<ParsedEvent>,
    identities: PlayerIdentities,
    entity_replay: EntityReplayCapture,
}

impl Observer for EventObserver {
    fn interests(&self) -> Interests {
        Interests::BASE_GAME_EVENT
            | Interests::TICK_START
            | Interests::TICK_END
            | Interests::ENTITY_STATE
            | Interests::STRING_TABLE_STATE
            | Interests::STRING_TABLE_ENTRIES
    }

    fn on_tick_start(&mut self, _context: &Context) -> ObserverResult {
        if self.cancellation.is_cancelled() {
            return Err(std::io::Error::other("demo parsing cancelled").into());
        }
        Ok(())
    }

    fn on_game_event(&mut self, context: &Context, event: &GameEvent) -> ObserverResult {
        if self.cancellation.is_cancelled() {
            return Err(std::io::Error::other("demo parsing cancelled").into());
        }
        if self.events.len() >= self.maximum_events {
            return Err(std::io::Error::other("demo event limit exceeded").into());
        }
        let fields = event
            .iter()
            .map(|(key, value)| (key.to_owned(), event_value_to_json(value)))
            .collect();
        self.events.push(ParsedEvent {
            sequence: u64::try_from(self.events.len()).unwrap_or(u64::MAX),
            tick: u64::from(context.tick()),
            name: event.name().to_owned(),
            fields,
        });
        Ok(())
    }

    fn on_tick_end(&mut self, context: &Context) -> ObserverResult {
        if self.cancellation.is_cancelled() {
            return Err(std::io::Error::other("demo parsing cancelled").into());
        }
        self.entity_replay.capture_tick(context);
        Ok(())
    }

    fn on_string_table(
        &mut self,
        _context: &Context,
        table: &StringTable,
        modified: &[i32],
    ) -> ObserverResult {
        if table.name() != "userinfo" {
            return Ok(());
        }
        for index in modified {
            let Ok(index) = usize::try_from(*index) else {
                continue;
            };
            let Ok(row) = table.get_row(index) else {
                continue;
            };
            let Some(data) = row.value() else {
                continue;
            };
            let Ok(info) = CMsgPlayerInfo::decode(data) else {
                continue;
            };
            register_player_info(&mut self.identities, &info);
        }
        Ok(())
    }
}

fn analyze_blocking(
    path: &Path,
    demo_id: Uuid,
    config: DemoEngineConfig,
    cancellation: &ParseCancellation,
) -> DemoResult<MatchAnalysis> {
    let validated = validate_demo(path, config.validation, cancellation)?;
    cancellation.check()?;
    let bytes =
        std::fs::read(&validated.path).map_err(|error| crate::io_error(&validated.path, error))?;
    cancellation.check()?;

    let mut parser = Parser::new(&bytes).map_err(|error| DemoError::Parse(error.to_string()))?;
    let playback_ticks = parser.replay_info().playback_ticks();
    let playback_time = f64::from(parser.replay_info().playback_time());
    if playback_ticks <= 0 || !playback_time.is_finite() || playback_time <= 0.0 {
        return Err(DemoError::MetadataUnavailable("playback duration/ticks"));
    }
    let tick_rate = f64::from(playback_ticks) / playback_time;
    if !tick_rate.is_finite() || tick_rate <= 0.0 {
        return Err(DemoError::MetadataUnavailable("tick rate"));
    }

    let observer = parser.add_observer(EventObserver {
        cancellation: cancellation.clone(),
        maximum_events: config.maximum_events,
        events: Vec::new(),
        identities: HashMap::new(),
        entity_replay: EntityReplayCapture::new(config.entity_replay),
    });
    if let Err(error) = parser.run_to_end() {
        if cancellation.is_cancelled() {
            return Err(DemoError::Cancelled);
        }
        let message = error.to_string();
        if message.contains("event limit") {
            return Err(DemoError::EventLimitExceeded {
                limit: config.maximum_events,
            });
        }
        return Err(DemoError::Parse(message));
    }
    cancellation.check()?;
    let (events, observed_identities, entity_frames, entity_unavailable) = {
        let mut observer = observer.borrow_mut();
        let entity_replay = std::mem::take(&mut observer.entity_replay);
        let (entity_frames, entity_unavailable) = entity_replay.into_parts();
        (
            observer.events.clone(),
            observer.identities.clone(),
            entity_frames,
            entity_unavailable,
        )
    };
    if events.is_empty() {
        return Err(DemoError::Parse("no game events were decoded".to_owned()));
    }

    let map_name = find_map_name(&events).ok_or(DemoError::MetadataUnavailable("map name"))?;
    let (mut rounds, players) = build_rounds_and_players(&events, tick_rate, &observed_identities)?;
    attach_entity_replay(&mut rounds, &entity_frames, entity_unavailable.as_deref());
    let teams = build_teams(&players, &rounds);
    let highlights = classify_highlights_with_players(&rounds, &players, config.highlights);
    Ok(MatchAnalysis {
        demo_id,
        map_name,
        tick_rate,
        duration_seconds: playback_time,
        teams,
        players,
        rounds,
        highlights,
    })
}

fn event_value_to_json(value: &EventValue) -> Value {
    match value {
        EventValue::String(value) => Value::String(value.clone()),
        EventValue::Float(value) => {
            serde_json::Number::from_f64(f64::from(*value)).map_or(Value::Null, Value::Number)
        }
        EventValue::Int(value) => Value::from(*value),
        EventValue::Bool(value) => Value::from(*value),
        EventValue::Byte(value) => Value::from(*value),
        EventValue::U64(value) => Value::from(*value),
    }
}

fn find_map_name(events: &[ParsedEvent]) -> Option<String> {
    events
        .iter()
        .filter(|event| {
            matches!(
                event.name.as_str(),
                "server_spawn" | "game_newmap" | "begin_new_match"
            )
        })
        .find_map(|event| field_string(&event.fields, &["mapname", "map_name", "map"]))
        .filter(|name| !name.trim().is_empty())
}

fn register_player_info(identities: &mut PlayerIdentities, info: &CMsgPlayerInfo) {
    let user_id = info.userid.filter(|value| *value > 0);
    let steam_id = info
        .steamid
        .filter(|value| *value > 0)
        .or_else(|| info.xuid.filter(|value| *value > 0));
    let Some(stable_id) = steam_id
        .map(|value| value.to_string())
        .or_else(|| user_id.map(|value| format!("userid:{value}")))
    else {
        return;
    };
    let name = info
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&stable_id)
        .to_owned();
    let identity = PlayerIdentity {
        stable_id: stable_id.clone(),
        name,
    };

    identities.insert(stable_id.clone(), identity.clone());
    if let Some(user_id) = user_id {
        identities.insert(user_id.to_string(), identity.clone());
        identities.insert(format!("userid:{user_id}"), identity.clone());
    }
    if let Some(xuid) = info.xuid.filter(|value| *value > 0) {
        identities.insert(xuid.to_string(), identity.clone());
    }
    if let Some(steam_id) = info.steamid.filter(|value| *value > 0) {
        identities.insert(steam_id.to_string(), identity);
    }
}

#[derive(Debug, Default)]
struct PlayerAccumulator {
    id: String,
    name: String,
    team: String,
    kills: u32,
    deaths: u32,
    assists: u32,
    headshots: u32,
    damage: u32,
}

fn build_rounds_and_players(
    parsed: &[ParsedEvent],
    tick_rate: f64,
    observed_identities: &PlayerIdentities,
) -> DemoResult<(Vec<RoundSummary>, Vec<PlayerStats>)> {
    let identities = collect_identities(parsed, observed_identities);
    let mut players: BTreeMap<String, PlayerAccumulator> = BTreeMap::new();
    let mut current_teams = HashMap::new();
    let mut rounds = Vec::new();
    let mut current: Option<RoundSummary> = None;
    let mut t_score = 0_u32;
    let mut ct_score = 0_u32;

    for raw in parsed {
        update_team_assignment(raw, &identities, &mut current_teams, &mut players);
        if raw.name == "round_start" {
            if let Some(previous) = current.take() {
                rounds.push(previous);
            }
            current = Some(RoundSummary {
                number: u32::try_from(rounds.len() + 1).unwrap_or(u32::MAX),
                start_tick: raw.tick,
                end_tick: raw.tick,
                winner: String::new(),
                reason: String::new(),
                team_a_score: t_score,
                team_b_score: ct_score,
                events: vec![timeline_event(
                    raw,
                    EventKind::RoundStart,
                    tick_rate,
                    &identities,
                )],
            });
            continue;
        }
        let Some(round) = current.as_mut() else {
            continue;
        };
        let kind = match raw.name.as_str() {
            "round_end" => EventKind::RoundEnd,
            "player_death" => EventKind::Kill,
            "player_hurt" => EventKind::Damage,
            "bomb_planted" => EventKind::BombPlant,
            "bomb_defused" => EventKind::BombDefuse,
            "bomb_exploded" => EventKind::BombExplode,
            "item_purchase" => EventKind::Purchase,
            "grenade_thrown"
            | "hegrenade_detonate"
            | "flashbang_detonate"
            | "smokegrenade_detonate"
            | "smokegrenade_expired"
            | "decoy_started"
            | "decoy_detonate"
            | "inferno_startburn"
            | "inferno_expire"
            | "player_blind" => EventKind::Grenade,
            _ => continue,
        };
        let event = timeline_event(raw, kind, tick_rate, &identities);
        update_players(
            &mut players,
            &event,
            &raw.fields,
            &identities,
            &mut current_teams,
        );
        round.end_tick = raw.tick;
        if kind == EventKind::RoundEnd {
            let winner_code = field_i64(&raw.fields, &["winner", "winner_team"]);
            let winner = winner_code
                .and_then(team_side)
                .or_else(|| {
                    field_string(&raw.fields, &["winner_name"])
                        .as_deref()
                        .and_then(normalize_team_side)
                })
                .unwrap_or_default();
            winner.clone_into(&mut round.winner);
            round.reason = field_string(&raw.fields, &["reason", "message"]).unwrap_or_default();
            match round.winner.as_str() {
                "T" => t_score = t_score.saturating_add(1),
                "CT" => ct_score = ct_score.saturating_add(1),
                _ => {}
            }
            round.team_a_score = t_score;
            round.team_b_score = ct_score;
        }
        round.events.push(event);
        if kind == EventKind::RoundEnd {
            rounds.push(current.take().expect("round exists"));
        }
    }
    if let Some(round) = current {
        rounds.push(round);
    }
    if rounds.is_empty() {
        return Err(DemoError::Parse(
            "no competitive rounds were decoded".to_owned(),
        ));
    }
    let round_count = u32::try_from(rounds.len()).unwrap_or(u32::MAX).max(1);
    let players = players
        .into_values()
        .map(|player| PlayerStats {
            steam_id: player.id,
            name: player.name,
            team: player.team,
            kills: player.kills,
            deaths: player.deaths,
            assists: player.assists,
            headshots: player.headshots,
            damage: player.damage,
            adr: f64::from(player.damage) / f64::from(round_count),
            rating: f64::from(player.kills) / f64::from(player.deaths.max(1)),
            score: i32::try_from(player.kills.saturating_mul(2)).unwrap_or(i32::MAX)
                - i32::try_from(player.deaths).unwrap_or(i32::MAX),
        })
        .collect();
    Ok((rounds, players))
}

fn collect_identities(
    events: &[ParsedEvent],
    observed_identities: &PlayerIdentities,
) -> PlayerIdentities {
    let mut identities = observed_identities.clone();
    for event in events.iter().filter(|event| {
        matches!(
            event.name.as_str(),
            "player_connect" | "player_connect_full" | "player_info" | "player_spawn"
        )
    }) {
        let user_id = field_string(&event.fields, &["userid", "user_id"])
            .as_deref()
            .and_then(normalize_raw_player_id);
        let stable_id = field_string(&event.fields, &["steamid", "xuid", "networkid"])
            .as_deref()
            .and_then(normalize_raw_player_id)
            .filter(|value| is_stable_player_id(value))
            .or_else(|| user_id.as_ref().map(|value| format!("userid:{value}")));
        let Some(stable_id) = stable_id else {
            continue;
        };
        let name = field_string(&event.fields, &["name", "player_name"])
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| stable_id.clone());
        let identity = PlayerIdentity {
            stable_id: stable_id.clone(),
            name,
        };
        identities
            .entry(stable_id.clone())
            .or_insert_with(|| identity.clone());
        if let Some(user_id) = user_id {
            identities
                .entry(user_id.clone())
                .or_insert_with(|| identity.clone());
            identities
                .entry(format!("userid:{user_id}"))
                .or_insert_with(|| identity.clone());
        }
        for key in ["steamid", "xuid", "networkid"] {
            if let Some(alias) = field_string(&event.fields, &[key])
                .as_deref()
                .and_then(normalize_raw_player_id)
            {
                identities.entry(alias).or_insert_with(|| identity.clone());
            }
        }
    }
    identities
}

fn timeline_event(
    raw: &ParsedEvent,
    kind: EventKind,
    tick_rate: f64,
    identities: &PlayerIdentities,
) -> TimelineEvent {
    let actor_keys: &[&str] =
        if matches!(kind, EventKind::Kill | EventKind::Damage) || raw.name == "player_blind" {
            &[
                "attacker_steamid",
                "attacker_xuid",
                "attacker",
                "attackerid",
            ]
        } else {
            &[
                "steamid",
                "xuid",
                "user_steamid",
                "user_xuid",
                "userid",
                "user_id",
                "player",
            ]
        };
    let target_keys: &[&str] =
        if matches!(kind, EventKind::Kill | EventKind::Damage) || raw.name == "player_blind" {
            &[
                "victim_steamid",
                "victim_xuid",
                "user_steamid",
                "user_xuid",
                "userid",
                "user_id",
                "victim",
            ]
        } else {
            &[]
        };
    let raw_actor = field_string(&raw.fields, actor_keys);
    let raw_target = field_string(&raw.fields, target_keys);
    let actor = canonical_player_id(raw_actor.as_deref(), identities);
    let target = canonical_player_id(raw_target.as_deref(), identities);
    let position = match (
        field_f64(&raw.fields, &["x", "pos_x"]),
        field_f64(&raw.fields, &["y", "pos_y"]),
        field_f64(&raw.fields, &["z", "pos_z"]),
    ) {
        (Some(x), Some(y), Some(z)) if x.is_finite() && y.is_finite() && z.is_finite() => {
            Some([x, y, z])
        }
        _ => None,
    };
    TimelineEvent {
        id: format!("{}-{}-{}", raw.name, raw.tick, raw.sequence),
        tick: raw.tick,
        seconds: f64::from(u32::try_from(raw.tick).unwrap_or(u32::MAX)) / tick_rate,
        kind,
        actor,
        target,
        weapon: field_string(&raw.fields, &["weapon", "weapon_name"]),
        headshot: field_bool(&raw.fields, &["headshot"]),
        penetrated: field_bool(&raw.fields, &["penetrated"])
            || field_i64(&raw.fields, &["penetrated"]).is_some_and(|value| value > 0),
        position,
        detail: Value::Object(raw.fields.clone()),
    }
}

fn update_players(
    players: &mut BTreeMap<String, PlayerAccumulator>,
    event: &TimelineEvent,
    fields: &Map<String, Value>,
    identities: &PlayerIdentities,
    current_teams: &mut HashMap<String, String>,
) {
    if let Some(actor) = event.actor.as_ref() {
        let player = player_entry(players, actor, identities);
        if let Some(team) =
            field_i64(fields, &["attackerteam", "attacker_team"]).and_then(team_side)
        {
            team.clone_into(&mut player.team);
            current_teams.insert(actor.clone(), team.to_owned());
        } else if let Some(team) = current_teams.get(actor) {
            player.team.clone_from(team);
        }
        match event.kind {
            EventKind::Kill => {
                player.kills = player.kills.saturating_add(1);
                if event.headshot {
                    player.headshots = player.headshots.saturating_add(1);
                }
            }
            EventKind::Damage => {
                let damage = field_i64(fields, &["dmg_health", "damage"])
                    .and_then(|value| u32::try_from(value.max(0)).ok())
                    .unwrap_or(0);
                player.damage = player.damage.saturating_add(damage);
            }
            _ => {}
        }
    }
    if event.kind == EventKind::Kill {
        if let Some(target) = event.target.as_ref() {
            let player = player_entry(players, target, identities);
            if let Some(team) = field_i64(fields, &["userteam", "victimteam"]).and_then(team_side) {
                team.clone_into(&mut player.team);
                current_teams.insert(target.clone(), team.to_owned());
            } else if let Some(team) = current_teams.get(target) {
                player.team.clone_from(team);
            }
            player.deaths = player.deaths.saturating_add(1);
        }
        let raw_assister = field_string(fields, &["assister_steamid", "assister_xuid", "assister"]);
        if let Some(assister) = canonical_player_id(raw_assister.as_deref(), identities) {
            let player = player_entry(players, &assister, identities);
            if let Some(team) = current_teams.get(&assister) {
                player.team.clone_from(team);
            }
            player.assists = player.assists.saturating_add(1);
        }
    }
}

fn update_team_assignment(
    event: &ParsedEvent,
    identities: &PlayerIdentities,
    current_teams: &mut HashMap<String, String>,
    players: &mut BTreeMap<String, PlayerAccumulator>,
) {
    if !matches!(event.name.as_str(), "player_team" | "player_spawn") {
        return;
    }
    let raw_player_id = field_string(
        &event.fields,
        &["steamid", "xuid", "userid", "user_id", "player"],
    );
    let Some(player_id) = canonical_player_id(raw_player_id.as_deref(), identities) else {
        return;
    };
    let Some(team_number) = field_i64(&event.fields, &["team", "teamid", "team_num", "teamnum"])
    else {
        return;
    };
    if let Some(team) = team_side(team_number) {
        current_teams.insert(player_id.clone(), team.to_owned());
        team.clone_into(&mut player_entry(players, &player_id, identities).team);
    } else {
        current_teams.remove(&player_id);
        if let Some(player) = players.get_mut(&player_id) {
            player.team.clear();
        }
    }
}

fn player_entry<'a>(
    players: &'a mut BTreeMap<String, PlayerAccumulator>,
    id: &str,
    identities: &PlayerIdentities,
) -> &'a mut PlayerAccumulator {
    players
        .entry(id.to_owned())
        .or_insert_with(|| PlayerAccumulator {
            id: id.to_owned(),
            name: identities
                .get(id)
                .map_or_else(|| id.to_owned(), |identity| identity.name.clone()),
            ..PlayerAccumulator::default()
        })
}

fn build_teams(players: &[PlayerStats], rounds: &[RoundSummary]) -> Vec<TeamSummary> {
    let (t_score, ct_score) = rounds
        .last()
        .map_or((0, 0), |round| (round.team_a_score, round.team_b_score));
    [("T", "T", t_score), ("CT", "CT", ct_score)]
        .into_iter()
        .map(|(name, side, score)| TeamSummary {
            name: name.to_owned(),
            side: side.to_owned(),
            score,
            players: players
                .iter()
                .filter(|player| player.team == name)
                .map(|player| player.steam_id.clone())
                .collect(),
        })
        .collect()
}

fn team_side(value: i64) -> Option<&'static str> {
    match value {
        2 => Some("T"),
        3 => Some("CT"),
        _ => None,
    }
}

fn normalize_team_side(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_uppercase().as_str() {
        "2" | "T" | "TERRORIST" | "TERRORISTS" => Some("T"),
        "3" | "CT" | "COUNTER-TERRORIST" | "COUNTER-TERRORISTS" | "COUNTERTERRORIST" => Some("CT"),
        _ => None,
    }
}

fn canonical_player_id(raw_id: Option<&str>, identities: &PlayerIdentities) -> Option<String> {
    let raw_id = raw_id.and_then(normalize_raw_player_id)?;
    if let Some(identity) = identities.get(&raw_id) {
        return Some(identity.stable_id.clone());
    }
    if raw_id.starts_with("userid:") || is_stable_player_id(&raw_id) {
        Some(raw_id)
    } else {
        Some(format!("userid:{raw_id}"))
    }
}

fn normalize_raw_player_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || matches!(value, "0" | "-1") {
        None
    } else {
        Some(value.to_owned())
    }
}

fn is_stable_player_id(value: &str) -> bool {
    (value.len() == 17 && value.bytes().all(|byte| byte.is_ascii_digit()))
        || value.starts_with("STEAM_")
        || value.starts_with("[U:")
}

fn field_value<'a>(fields: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| fields.get(*key))
}

fn field_string(fields: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    match field_value(fields, keys)? {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn field_i64(fields: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    let value = field_value(fields, keys)?;
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
}

fn field_f64(fields: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    field_value(fields, keys)?.as_f64()
}

fn field_bool(fields: &Map<String, Value>, keys: &[&str]) -> bool {
    let Some(value) = field_value(fields, keys) else {
        return false;
    };
    value
        .as_bool()
        .unwrap_or_else(|| value.as_i64().is_some_and(|number| number != 0))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn raw(tick: u64, name: &str, fields: &Value) -> ParsedEvent {
        ParsedEvent {
            sequence: tick,
            tick,
            name: name.to_owned(),
            fields: fields.as_object().unwrap().clone(),
        }
    }

    #[test]
    fn maps_actual_round_events_and_player_stats() {
        let mut identities = HashMap::new();
        for (user_id, steam_id, name) in [
            (7, 76_561_198_000_000_007, "Alice"),
            (8, 76_561_198_000_000_008, "Bob"),
            (9, 76_561_198_000_000_009, "Charlie"),
        ] {
            register_player_info(
                &mut identities,
                &CMsgPlayerInfo {
                    name: Some(name.to_owned()),
                    userid: Some(user_id),
                    steamid: Some(steam_id),
                    ..CMsgPlayerInfo::default()
                },
            );
        }
        let events = vec![
            raw(1, "player_team", &json!({"userid": 7, "team": 2})),
            raw(2, "player_team", &json!({"userid": 8, "team": 3})),
            raw(3, "player_team", &json!({"userid": 9, "team": 3})),
            raw(10, "round_start", &json!({})),
            raw(
                20,
                "player_death",
                &json!({"attacker": 7, "userid": 8, "weapon": "ak47", "headshot": true}),
            ),
            raw(
                30,
                "player_hurt",
                &json!({"attacker": 7, "userid": 9, "dmg_health": 37}),
            ),
            raw(
                40,
                "bomb_planted",
                &json!({"userid": 7, "x": 1.0, "y": 2.0, "z": 3.0}),
            ),
            raw(
                50,
                "round_end",
                &json!({"winner": 2, "reason": "target_bombed"}),
            ),
        ];
        let (rounds, players) = build_rounds_and_players(&events, 64.0, &identities).unwrap();
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].events.len(), 5);
        assert_eq!(rounds[0].winner, "T");
        let attacker = players
            .iter()
            .find(|player| player.steam_id == "76561198000000007")
            .unwrap();
        assert_eq!(attacker.name, "Alice");
        assert_eq!(attacker.team, "T");
        assert_eq!(attacker.kills, 1);
        assert_eq!(attacker.damage, 37);

        let teams = build_teams(&players, &rounds);
        assert_eq!(teams[0].name, "T");
        assert_eq!(teams[0].side, "T");
        assert_eq!(teams[0].players, ["76561198000000007"]);
        assert_eq!(teams[1].name, "CT");
        assert_eq!(teams[1].side, "CT");
    }

    #[test]
    fn userinfo_identity_maps_event_userid_to_steam64() {
        let mut identities = HashMap::new();
        register_player_info(
            &mut identities,
            &CMsgPlayerInfo {
                name: Some("Player One".to_owned()),
                xuid: Some(76_561_198_000_000_123),
                userid: Some(42),
                steamid: Some(76_561_198_000_000_123),
                ..CMsgPlayerInfo::default()
            },
        );

        assert_eq!(
            canonical_player_id(Some("42"), &identities).as_deref(),
            Some("76561198000000123")
        );
        assert_eq!(identities["42"].name, "Player One");
        assert_eq!(canonical_player_id(Some("0"), &identities), None);
    }

    #[test]
    fn unknown_short_event_id_is_explicitly_a_userid() {
        let identities = HashMap::new();
        let event = timeline_event(
            &raw(
                64,
                "player_death",
                &json!({"attacker": 7, "userid": 0, "weapon": "world"}),
            ),
            EventKind::Kill,
            64.0,
            &identities,
        );

        assert_eq!(event.actor.as_deref(), Some("userid:7"));
        assert_eq!(event.target, None);
        assert!((event.seconds - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn position_requires_complete_finite_coordinates() {
        let identities = HashMap::new();
        let positioned = timeline_event(
            &raw(
                128,
                "hegrenade_detonate",
                &json!({"userid": 7, "x": 1.0, "y": 2.0, "z": 3.0}),
            ),
            EventKind::Grenade,
            64.0,
            &identities,
        );
        let partial = timeline_event(
            &raw(
                129,
                "hegrenade_detonate",
                &json!({"userid": 7, "x": 1.0, "y": 2.0}),
            ),
            EventKind::Grenade,
            64.0,
            &identities,
        );

        assert_eq!(positioned.tick, 128);
        assert!((positioned.seconds - 2.0).abs() < f64::EPSILON);
        assert_eq!(positioned.position, Some([1.0, 2.0, 3.0]));
        assert_eq!(partial.position, None);
    }

    #[test]
    fn blind_event_preserves_thrower_target_and_duration() {
        let mut identities = HashMap::new();
        for (user_id, steam_id, name) in [
            (7, 76_561_198_000_000_007, "Thrower"),
            (8, 76_561_198_000_000_008, "Target"),
        ] {
            register_player_info(
                &mut identities,
                &CMsgPlayerInfo {
                    name: Some(name.to_owned()),
                    userid: Some(user_id),
                    steamid: Some(steam_id),
                    ..CMsgPlayerInfo::default()
                },
            );
        }
        let event = timeline_event(
            &raw(
                160,
                "player_blind",
                &json!({"attacker": 7, "userid": 8, "blind_duration": 2.5}),
            ),
            EventKind::Grenade,
            64.0,
            &identities,
        );

        assert_eq!(event.actor.as_deref(), Some("76561198000000007"));
        assert_eq!(event.target.as_deref(), Some("76561198000000008"));
        assert_eq!(event.detail["blind_duration"], json!(2.5));
    }

    #[test]
    fn team_aliases_normalize_to_consistent_side_labels() {
        assert_eq!(team_side(2), Some("T"));
        assert_eq!(team_side(3), Some("CT"));
        assert_eq!(team_side(1), None);
        assert_eq!(normalize_team_side("TERRORIST"), Some("T"));
        assert_eq!(normalize_team_side("counter-terrorist"), Some("CT"));
        assert_eq!(normalize_team_side("spectator"), None);
    }
}
