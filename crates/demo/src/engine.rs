use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    panic::{AssertUnwindSafe, catch_unwind},
    path::Path,
};

use serde_json::{Map, Value};
use source2_demo::prelude::*;
use source2_demo::proto::{
    CDemoFileHeader, CDemoFileInfo, CMsgPlayerInfo, CNetMsgSignonState, CSvcMsgClearAllStringTables,
};
use uuid::Uuid;
use vibe_cs_domain::{
    EventKind, MatchAnalysis, PlayerStats, RoundSummary, TeamSummary, TimelineEvent,
};

use crate::{
    DemoError, DemoResult, EntityReplayLimits, HighlightPolicy, ParseCancellation,
    ValidationLimits, classify_highlights_with_players,
    demoparser_backend::analyze_fast,
    entity_replay::{EntityReplayCapture, attach_entity_replay},
    validate_demo,
};

#[derive(Debug, Clone, Copy)]
pub struct DemoEngineConfig {
    pub validation: ValidationLimits,
    pub maximum_events: usize,
    pub highlights: HighlightPolicy,
    pub entity_replay: EntityReplayLimits,
    pub backend: DemoParserBackend,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum DemoParserBackend {
    #[default]
    Cooperative,
    Fast,
}

impl DemoParserBackend {
    pub fn from_environment_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("cooperative") => Self::Cooperative,
            _ => Self::Fast,
        }
    }
}

impl Default for DemoEngineConfig {
    fn default() -> Self {
        Self {
            validation: ValidationLimits::default(),
            maximum_events: 500_000,
            highlights: HighlightPolicy::default(),
            entity_replay: EntityReplayLimits::default(),
            backend: DemoParserBackend::Cooperative,
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
pub(crate) struct ParsedEvent {
    pub(crate) sequence: u64,
    pub(crate) tick: u64,
    pub(crate) name: String,
    pub(crate) fields: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GameRulesRoundSnapshot {
    total_rounds_played: u32,
    round_start_number: u32,
    winner_team: i64,
    end_reason: i64,
    end_message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GameRulesRoundRecord {
    number: u32,
    start_tick: u64,
    end_tick: u64,
    winner_team: i64,
    end_reason: i64,
    end_message: String,
}

#[derive(Debug, Default)]
struct GameRulesRoundCapture {
    last_total_rounds: Option<u32>,
    starts: BTreeMap<u32, u64>,
    records: Vec<GameRulesRoundRecord>,
}

#[derive(Debug, Default)]
struct RoundRosterCapture {
    current: BTreeMap<String, String>,
    snapshots: Vec<(u64, BTreeMap<String, String>)>,
}

impl RoundRosterCapture {
    fn observe(&mut self, tick: u64, player_id: String, team: String) {
        if self.current.get(&player_id) == Some(&team) {
            return;
        }
        self.current.insert(player_id, team);
        self.snapshots.push((tick, self.current.clone()));
    }

    fn into_snapshots(self) -> Vec<(u64, BTreeMap<String, String>)> {
        self.snapshots
    }
}

impl GameRulesRoundCapture {
    fn observe(&mut self, tick: u64, snapshot: GameRulesRoundSnapshot) {
        let active_round = snapshot.round_start_number.saturating_add(1);
        self.starts.entry(active_round).or_insert(tick);

        let Some(previous_total) = self.last_total_rounds.replace(snapshot.total_rounds_played)
        else {
            return;
        };
        if snapshot.total_rounds_played <= previous_total {
            return;
        }
        let number = snapshot.total_rounds_played;
        let Some(start_tick) = self.starts.get(&number).copied() else {
            return;
        };
        self.records.push(GameRulesRoundRecord {
            number,
            start_tick,
            end_tick: tick,
            winner_team: snapshot.winner_team,
            end_reason: snapshot.end_reason,
            end_message: snapshot.end_message,
        });
    }

    fn into_records(self) -> Vec<GameRulesRoundRecord> {
        self.records
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlayerIdentity {
    pub(crate) stable_id: String,
    pub(crate) name: String,
    pub(crate) spectator_slot: Option<u8>,
    pub(crate) spectator_slot_conflicted: bool,
}

pub(crate) type PlayerIdentities = HashMap<String, PlayerIdentity>;

#[derive(Debug)]
struct EventObserver {
    cancellation: ParseCancellation,
    maximum_events: usize,
    events: Vec<ParsedEvent>,
    identities: PlayerIdentities,
    header_map_name: Option<String>,
    network_map_name: Option<String>,
    game_rules_rounds: GameRulesRoundCapture,
    round_rosters: RoundRosterCapture,
    entity_replay: EntityReplayCapture,
}

impl Observer for EventObserver {
    fn interests(&self) -> Interests {
        Interests::BASE_GAME_EVENT
            | Interests::DEMO_MESSAGE
            | Interests::NET_MESSAGE
            | Interests::SVC_MESSAGE
            | Interests::TICK_START
            | Interests::TICK_END
            | Interests::ENTITY_STATE
            | Interests::ENTITY_EVENTS
            | Interests::STRING_TABLE_STATE
            | Interests::STRING_TABLE_ENTRIES
    }

    fn on_demo_command(
        &mut self,
        _context: &Context,
        message_type: EDemoCommands,
        message: &[u8],
    ) -> ObserverResult {
        if self.header_map_name.is_none() {
            self.header_map_name = map_name_from_demo_message(message_type, message);
        }
        Ok(())
    }

    fn on_net_message(
        &mut self,
        _context: &Context,
        message_type: NetMessages,
        message: &[u8],
    ) -> ObserverResult {
        if self.network_map_name.is_none() {
            self.network_map_name = map_name_from_net_message(message_type, message);
        }
        Ok(())
    }

    fn on_svc_message(
        &mut self,
        _context: &Context,
        message_type: SvcMessages,
        message: &[u8],
    ) -> ObserverResult {
        if self.network_map_name.is_none() {
            self.network_map_name = map_name_from_svc_message(message_type, message);
        }
        Ok(())
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

    fn on_entity(
        &mut self,
        context: &Context,
        _event: EntityEvents,
        entity: &Entity,
    ) -> ObserverResult {
        if let Some(snapshot) = game_rules_round_snapshot(entity) {
            self.game_rules_rounds
                .observe(u64::from(context.tick()), snapshot);
        }
        if let Some((player_id, team)) = controller_player_team(entity) {
            self.round_rosters
                .observe(u64::from(context.tick()), player_id, team);
        }
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
    match config.backend {
        DemoParserBackend::Cooperative => {
            analyze_source2_blocking(path, demo_id, config, cancellation)
        }
        DemoParserBackend::Fast => analyze_fast(path, demo_id, config, cancellation),
    }
}

fn analyze_source2_blocking(
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
    let (verified_total_ticks, playback_time, tick_rate) =
        verified_replay_metadata(parser.replay_info())?;

    let observer = parser.add_observer(EventObserver {
        cancellation: cancellation.clone(),
        maximum_events: config.maximum_events,
        events: Vec::new(),
        identities: HashMap::new(),
        header_map_name: None,
        network_map_name: None,
        game_rules_rounds: GameRulesRoundCapture::default(),
        round_rosters: RoundRosterCapture::default(),
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
    let (
        events,
        observed_identities,
        header_map_name,
        network_map_name,
        game_rules_rounds,
        round_rosters,
        entity_frames,
        entity_unavailable,
    ) = {
        let mut observer = observer.borrow_mut();
        let entity_replay = std::mem::take(&mut observer.entity_replay);
        let (entity_frames, entity_unavailable) = entity_replay.into_parts();
        (
            observer.events.clone(),
            observer.identities.clone(),
            observer.header_map_name.clone(),
            observer.network_map_name.clone(),
            std::mem::take(&mut observer.game_rules_rounds).into_records(),
            std::mem::take(&mut observer.round_rosters).into_snapshots(),
            entity_frames,
            entity_unavailable,
        )
    };
    if events.is_empty() {
        return Err(DemoError::Parse("no game events were decoded".to_owned()));
    }

    let events = canonicalize_round_events(events, &game_rules_rounds, &round_rosters);
    let map_name = header_map_name
        .or(network_map_name)
        .or_else(|| find_map_name(&events))
        .ok_or(DemoError::MetadataUnavailable("map name"))?;
    let (mut rounds, players) = build_rounds_and_players(&events, tick_rate, &observed_identities)?;
    attach_entity_replay(&mut rounds, &entity_frames, entity_unavailable.as_deref());
    let teams = build_teams(&players, &rounds);
    let highlights = classify_highlights_with_players(&rounds, &players, config.highlights);
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

pub(crate) fn verified_replay_metadata(replay_info: &CDemoFileInfo) -> DemoResult<(u32, f64, f64)> {
    let playback_ticks = replay_info.playback_ticks();
    let playback_time = f64::from(replay_info.playback_time());
    if playback_ticks <= 0 || !playback_time.is_finite() || playback_time <= 0.0 {
        return Err(DemoError::MetadataUnavailable("playback duration/ticks"));
    }
    let verified_total_ticks = u32::try_from(playback_ticks)
        .map_err(|_| DemoError::MetadataUnavailable("playback ticks"))?;
    let tick_rate = f64::from(playback_ticks) / playback_time;
    if !tick_rate.is_finite() || tick_rate <= 0.0 {
        return Err(DemoError::MetadataUnavailable("tick rate"));
    }
    Ok((verified_total_ticks, playback_time, tick_rate))
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

fn game_rules_round_snapshot(entity: &Entity) -> Option<GameRulesRoundSnapshot> {
    if entity.class().name() != "CCSGameRulesProxy" {
        return None;
    }
    let fields = entity.fields();
    Some(GameRulesRoundSnapshot {
        total_rounds_played: u32::try_from(game_rules_integer(
            &fields,
            "m_pGameRules.m_totalRoundsPlayed",
        )?)
        .ok()?,
        round_start_number: u32::try_from(game_rules_integer(
            &fields,
            "m_pGameRules.m_iRoundStartRoundNumber",
        )?)
        .ok()?,
        winner_team: game_rules_integer(&fields, "m_pGameRules.m_iRoundEndWinnerTeam")?,
        end_reason: game_rules_integer(&fields, "m_pGameRules.m_eRoundEndReason")?,
        end_message: game_rules_string(&fields, "m_pGameRules.m_sRoundEndMessage")?.to_owned(),
    })
}

fn controller_player_team(entity: &Entity) -> Option<(String, String)> {
    if entity.class().name() != "CCSPlayerController" {
        return None;
    }
    let fields = entity.fields();
    let steam_id = entity_unsigned(&fields, "m_steamID").filter(|value| *value > 0)?;
    let team = entity_unsigned(&fields, "m_iTeamNum")
        .and_then(|value| i64::try_from(value).ok())
        .and_then(team_side)?;
    Some((steam_id.to_string(), team.to_owned()))
}

fn entity_unsigned(fields: &[EntityField<'_>], name: &str) -> Option<u64> {
    let value = fields
        .iter()
        .find(|field| field.name == name || field.name.ends_with(&format!(".{name}")))?
        .value?;
    match value {
        FieldValue::Unsigned8(value) => Some(u64::from(*value)),
        FieldValue::Unsigned16(value) => Some(u64::from(*value)),
        FieldValue::Unsigned32(value) => Some(u64::from(*value)),
        FieldValue::Unsigned64(value) => Some(*value),
        FieldValue::Signed8(value) => u64::try_from(*value).ok(),
        FieldValue::Signed16(value) => u64::try_from(*value).ok(),
        FieldValue::Signed32(value) => u64::try_from(*value).ok(),
        FieldValue::Signed64(value) => u64::try_from(*value).ok(),
        _ => None,
    }
}

fn game_rules_integer(fields: &[EntityField<'_>], name: &str) -> Option<i64> {
    let value = fields.iter().find(|field| field.name == name)?.value?;
    match value {
        FieldValue::Signed8(value) => Some(i64::from(*value)),
        FieldValue::Signed16(value) => Some(i64::from(*value)),
        FieldValue::Signed32(value) => Some(i64::from(*value)),
        FieldValue::Signed64(value) => Some(*value),
        FieldValue::Unsigned8(value) => Some(i64::from(*value)),
        FieldValue::Unsigned16(value) => Some(i64::from(*value)),
        FieldValue::Unsigned32(value) => Some(i64::from(*value)),
        FieldValue::Unsigned64(value) => i64::try_from(*value).ok(),
        _ => None,
    }
}

fn game_rules_string<'a>(fields: &'a [EntityField<'a>], name: &str) -> Option<&'a str> {
    let value = fields.iter().find(|field| field.name == name)?.value?;
    match value {
        FieldValue::String(value) => Some(value),
        _ => None,
    }
}

fn canonicalize_round_events(
    mut events: Vec<ParsedEvent>,
    records: &[GameRulesRoundRecord],
    roster_snapshots: &[(u64, BTreeMap<String, String>)],
) -> Vec<ParsedEvent> {
    if records.is_empty() {
        return events;
    }
    events.retain(|event| !matches!(event.name.as_str(), "round_start" | "round_end"));
    let mut sequence = events
        .iter()
        .map(|event| event.sequence)
        .max()
        .unwrap_or(0)
        .saturating_add(1);
    for record in records {
        let mut start_fields = Map::new();
        start_fields.insert("round_number".to_owned(), Value::from(record.number));
        start_fields.insert(
            "source".to_owned(),
            Value::String("CCSGameRulesProxy".to_owned()),
        );
        if let Some(roster) = roster_for_round(record, roster_snapshots) {
            start_fields.insert(
                "_round_roster".to_owned(),
                serde_json::to_value(roster).expect("round roster serialization cannot fail"),
            );
        }
        events.push(ParsedEvent {
            sequence,
            tick: record.start_tick,
            name: "round_start".to_owned(),
            fields: start_fields,
        });
        sequence = sequence.saturating_add(1);

        let mut end_fields = Map::new();
        end_fields.insert("round_number".to_owned(), Value::from(record.number));
        end_fields.insert("winner".to_owned(), Value::from(record.winner_team));
        end_fields.insert("reason_code".to_owned(), Value::from(record.end_reason));
        end_fields.insert(
            "reason".to_owned(),
            Value::String(record.end_message.clone()),
        );
        end_fields.insert(
            "source".to_owned(),
            Value::String("CCSGameRulesProxy".to_owned()),
        );
        events.push(ParsedEvent {
            sequence,
            tick: record.end_tick,
            name: "round_end".to_owned(),
            fields: end_fields,
        });
        sequence = sequence.saturating_add(1);
    }
    events.sort_by_key(|event| {
        let boundary_order = match event.name.as_str() {
            "round_start" => 0_u8,
            "round_end" => 2,
            _ => 1,
        };
        (event.tick, boundary_order, event.sequence)
    });
    events
}

fn roster_for_round<'a>(
    record: &GameRulesRoundRecord,
    snapshots: &'a [(u64, BTreeMap<String, String>)],
) -> Option<&'a BTreeMap<String, String>> {
    snapshots
        .iter()
        .rfind(|(tick, roster)| {
            *tick <= record.end_tick
                && roster.len() >= 4
                && roster.values().collect::<BTreeSet<_>>().len() == 2
        })
        .map(|(_, roster)| roster)
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

fn map_name_from_demo_message(message_type: EDemoCommands, message: &[u8]) -> Option<String> {
    if message_type != EDemoCommands::DemFileHeader {
        return None;
    }
    let message = CDemoFileHeader::decode(message).ok()?;
    nonempty_map_name(message.map_name)
}

fn map_name_from_net_message(message_type: NetMessages, message: &[u8]) -> Option<String> {
    if message_type != NetMessages::NetSignonState {
        return None;
    }
    let message = CNetMsgSignonState::decode(message).ok()?;
    nonempty_map_name(message.map_name)
}

fn map_name_from_svc_message(message_type: SvcMessages, message: &[u8]) -> Option<String> {
    if message_type != SvcMessages::SvcClearAllStringTables {
        return None;
    }
    let message = CSvcMsgClearAllStringTables::decode(message).ok()?;
    nonempty_map_name(message.mapname)
}

fn nonempty_map_name(map_name: Option<String>) -> Option<String> {
    let map_name = map_name?.trim().to_owned();
    (!map_name.is_empty()).then_some(map_name)
}

fn register_player_info(identities: &mut PlayerIdentities, info: &CMsgPlayerInfo) {
    let raw_user_id = info.userid;
    let user_id = raw_user_id
        .map(|value| value & 0xff)
        .filter(|value| *value > 0);
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
    let previous = identities.get(&stable_id);
    let (spectator_slot, spectator_slot_conflicted) = match raw_user_id {
        None => previous.map_or((None, false), |identity| {
            (identity.spectator_slot, identity.spectator_slot_conflicted)
        }),
        Some(user_id) => match spectator_slot_from_userid(user_id) {
            None => (None, true),
            Some(slot) => match previous {
                Some(identity) if identity.spectator_slot_conflicted => (None, true),
                Some(identity)
                    if identity
                        .spectator_slot
                        .is_some_and(|existing| existing != slot) =>
                {
                    (None, true)
                }
                _ => (Some(slot), false),
            },
        },
    };
    let identity = PlayerIdentity {
        stable_id: stable_id.clone(),
        name,
        spectator_slot,
        spectator_slot_conflicted,
    };

    for existing in identities
        .values_mut()
        .filter(|existing| existing.stable_id == stable_id)
    {
        existing.clone_from(&identity);
    }
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

pub(crate) fn spectator_slot_from_userid(user_id: i32) -> Option<u8> {
    let slot = (user_id & 0xff).checked_add(1)?;
    u8::try_from(slot)
        .ok()
        .filter(|slot| (1..=64).contains(slot))
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

pub(crate) fn build_rounds_and_players(
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
    let spectator_slots = resolved_spectator_slots(&identities);
    let players = players
        .into_values()
        .map(|player| PlayerStats {
            spectator_slot: spectator_slots.get(&player.id).copied(),
            steam_id: player.id,
            name: player.name,
            team: player.team,
            kills: player.kills,
            deaths: player.deaths,
            assists: player.assists,
            headshots: player.headshots,
            damage: player.damage,
            adr: f64::from(player.damage) / f64::from(round_count),
            kill_death_ratio: f64::from(player.kills) / f64::from(player.deaths.max(1)),
            score: i32::try_from(player.kills.saturating_mul(2)).unwrap_or(i32::MAX)
                - i32::try_from(player.deaths).unwrap_or(i32::MAX),
        })
        .collect();
    Ok((rounds, players))
}

fn resolved_spectator_slots(identities: &PlayerIdentities) -> HashMap<String, u8> {
    let mut by_player = BTreeMap::<String, (bool, BTreeSet<u8>)>::new();
    for identity in identities.values() {
        let (conflicted, observed) = by_player.entry(identity.stable_id.clone()).or_default();
        *conflicted |= identity.spectator_slot_conflicted;
        if let Some(slot) = identity.spectator_slot {
            observed.insert(slot);
        }
    }
    let mut slot_counts = HashMap::<u8, usize>::new();
    for slot in by_player.values().filter_map(|(conflicted, observed)| {
        (!conflicted && observed.len() == 1)
            .then(|| observed.iter().next().copied())
            .flatten()
    }) {
        *slot_counts.entry(slot).or_default() += 1;
    }
    by_player
        .into_iter()
        .filter_map(|(player_id, (conflicted, observed))| {
            if conflicted || observed.len() != 1 {
                return None;
            }
            let slot = observed.into_iter().next()?;
            (slot_counts.get(&slot) == Some(&1)).then_some((player_id, slot))
        })
        .collect()
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
            spectator_slot: None,
            spectator_slot_conflicted: false,
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
    let weapon_keys: &[&str] = if kind == EventKind::Purchase {
        &["item_name", "weapon", "weapon_name"]
    } else {
        &["weapon", "weapon_name"]
    };
    TimelineEvent {
        id: format!("{}-{}-{}", raw.name, raw.tick, raw.sequence),
        tick: raw.tick,
        seconds: f64::from(u32::try_from(raw.tick).unwrap_or(u32::MAX)) / tick_rate,
        kind,
        actor,
        target,
        weapon: field_string(&raw.fields, weapon_keys),
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
        if let Some(team) = field_i64(
            fields,
            &["attackerteam", "attacker_team", "attacker_team_num"],
        )
        .and_then(team_side)
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
            if let Some(team) = field_i64(
                fields,
                &["userteam", "victimteam", "user_team_num", "victim_team_num"],
            )
            .and_then(team_side)
            {
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
            if let Some(team) =
                field_i64(fields, &["assisterteam", "assister_team_num"]).and_then(team_side)
            {
                team.clone_into(&mut player.team);
                current_teams.insert(assister.clone(), team.to_owned());
            } else if let Some(team) = current_teams.get(&assister) {
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

pub(crate) fn build_teams(players: &[PlayerStats], rounds: &[RoundSummary]) -> Vec<TeamSummary> {
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
    if value.is_empty() || matches!(value, "0" | "-1" | "65535") {
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
    use std::io::Write as _;

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
    fn extracts_map_name_from_trusted_protocol_metadata() {
        let header = source2_demo::proto::CDemoFileHeader {
            demo_file_stamp: "PBDEMS2".to_owned(),
            map_name: Some("de_mirage".to_owned()),
            ..Default::default()
        };
        let signon = source2_demo::proto::CNetMsgSignonState {
            map_name: Some("de_anubis".to_owned()),
            ..Default::default()
        };
        let cleared = source2_demo::proto::CSvcMsgClearAllStringTables {
            mapname: Some("de_inferno".to_owned()),
            ..Default::default()
        };

        assert_eq!(
            map_name_from_demo_message(EDemoCommands::DemFileHeader, &header.encode_to_vec())
                .as_deref(),
            Some("de_mirage")
        );
        assert_eq!(
            map_name_from_net_message(NetMessages::NetSignonState, &signon.encode_to_vec())
                .as_deref(),
            Some("de_anubis")
        );
        assert_eq!(
            map_name_from_svc_message(
                SvcMessages::SvcClearAllStringTables,
                &cleared.encode_to_vec()
            )
            .as_deref(),
            Some("de_inferno")
        );
        assert_eq!(map_name_from_net_message(NetMessages::NetTick, &[]), None);
        assert_eq!(map_name_from_svc_message(SvcMessages::SvcPrint, &[]), None);
        assert_eq!(
            map_name_from_demo_message(EDemoCommands::DemStop, &[]),
            None
        );
    }

    #[test]
    fn game_rules_round_state_emits_once_per_completed_round() {
        let mut capture = GameRulesRoundCapture::default();
        capture.observe(
            1,
            GameRulesRoundSnapshot {
                total_rounds_played: 0,
                round_start_number: 0,
                winner_team: 3,
                end_reason: 12,
                end_message: "#SFUI_Notice_Target_Saved".to_owned(),
            },
        );
        capture.observe(
            4_041,
            GameRulesRoundSnapshot {
                total_rounds_played: 1,
                round_start_number: 0,
                winner_team: 3,
                end_reason: 8,
                end_message: "#SFUI_Notice_CTs_Win".to_owned(),
            },
        );
        capture.observe(
            4_042,
            GameRulesRoundSnapshot {
                total_rounds_played: 1,
                round_start_number: 0,
                winner_team: 3,
                end_reason: 8,
                end_message: "#SFUI_Notice_CTs_Win".to_owned(),
            },
        );
        capture.observe(
            4_361,
            GameRulesRoundSnapshot {
                total_rounds_played: 1,
                round_start_number: 1,
                winner_team: 3,
                end_reason: 8,
                end_message: "#SFUI_Notice_CTs_Win".to_owned(),
            },
        );
        capture.observe(
            9_461,
            GameRulesRoundSnapshot {
                total_rounds_played: 2,
                round_start_number: 1,
                winner_team: 2,
                end_reason: 1,
                end_message: "#SFUI_Notice_Target_Bombed".to_owned(),
            },
        );

        assert_eq!(
            capture.into_records(),
            vec![
                GameRulesRoundRecord {
                    number: 1,
                    start_tick: 1,
                    end_tick: 4_041,
                    winner_team: 3,
                    end_reason: 8,
                    end_message: "#SFUI_Notice_CTs_Win".to_owned(),
                },
                GameRulesRoundRecord {
                    number: 2,
                    start_tick: 4_361,
                    end_tick: 9_461,
                    winner_team: 2,
                    end_reason: 1,
                    end_message: "#SFUI_Notice_Target_Bombed".to_owned(),
                },
            ]
        );
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
        assert_eq!(canonical_player_id(Some("65535"), &identities), None);
    }

    #[test]
    fn source2_userinfo_low_byte_becomes_one_based_spectator_slot() {
        let mut identities = HashMap::new();
        register_player_info(
            &mut identities,
            &CMsgPlayerInfo {
                name: Some("Player One".to_owned()),
                xuid: Some(76_561_198_000_000_123),
                userid: Some(0x12_0007),
                steamid: Some(76_561_198_000_000_123),
                ..CMsgPlayerInfo::default()
            },
        );
        let events = vec![
            raw(10, "round_start", &json!({})),
            raw(
                20,
                "player_death",
                &json!({"attacker": 7, "userid": 0, "weapon": "world"}),
            ),
            raw(30, "round_end", &json!({"winner": 2})),
        ];

        let (_, players) =
            build_rounds_and_players(&events, 64.0, &identities).expect("one competitive round");
        let player = players
            .iter()
            .find(|player| player.steam_id == "76561198000000123")
            .expect("userinfo player");

        assert_eq!(player.spectator_slot, Some(8));
    }

    #[test]
    fn conflicting_or_shared_source2_userinfo_slots_are_unavailable() {
        let mut identities = HashMap::new();
        for (steam_id, user_id) in [(76_561_198_000_000_001, 7), (76_561_198_000_000_002, 7)] {
            register_player_info(
                &mut identities,
                &CMsgPlayerInfo {
                    name: Some(steam_id.to_string()),
                    userid: Some(user_id),
                    steamid: Some(steam_id),
                    ..CMsgPlayerInfo::default()
                },
            );
        }
        register_player_info(
            &mut identities,
            &CMsgPlayerInfo {
                name: Some("conflict".to_owned()),
                userid: Some(8),
                steamid: Some(76_561_198_000_000_001),
                ..CMsgPlayerInfo::default()
            },
        );
        let slots = resolved_spectator_slots(&identities);

        assert_eq!(slots.get("76561198000000001"), None);
        assert_eq!(slots.get("76561198000000002"), Some(&8));

        let mut shared = HashMap::new();
        for steam_id in [76_561_198_000_000_001, 76_561_198_000_000_002] {
            register_player_info(
                &mut shared,
                &CMsgPlayerInfo {
                    userid: Some(7),
                    steamid: Some(steam_id),
                    ..CMsgPlayerInfo::default()
                },
            );
        }
        assert!(resolved_spectator_slots(&shared).is_empty());
    }

    #[test]
    fn source2_userinfo_slots_outside_cs2_range_are_unavailable() {
        assert_eq!(spectator_slot_from_userid(63), Some(64));
        assert_eq!(spectator_slot_from_userid(64), None);
        assert_eq!(spectator_slot_from_userid(255), None);
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
    fn purchase_preserves_the_vendored_item_name_as_event_evidence() {
        let identities = HashMap::new();
        let purchase = timeline_event(
            &raw(
                128,
                "item_purchase",
                &json!({
                    "steamid": "76561198000000007",
                    "item_name": "weapon_ak47",
                    "user_X": 1.0,
                    "user_Y": 2.0,
                    "user_Z": 3.0,
                    "x": 1.0,
                    "y": 2.0,
                    "z": 3.0
                }),
            ),
            EventKind::Purchase,
            64.0,
            &identities,
        );

        assert_eq!(purchase.weapon.as_deref(), Some("weapon_ak47"));
        assert_eq!(purchase.position, Some([1.0, 2.0, 3.0]));
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

    #[test]
    fn parser_backend_uses_only_current_names_and_requires_an_explicit_cooperative_override() {
        assert_eq!(
            DemoEngineConfig::default().backend,
            DemoParserBackend::Cooperative
        );
        assert_eq!(
            DemoParserBackend::from_environment_value(None),
            DemoParserBackend::Fast
        );
        assert_eq!(
            DemoParserBackend::from_environment_value(Some("unknown")),
            DemoParserBackend::Fast
        );
        assert_eq!(
            DemoParserBackend::from_environment_value(Some(" COOPERATIVE ")),
            DemoParserBackend::Cooperative
        );
        assert_eq!(
            DemoParserBackend::from_environment_value(Some(" FAST ")),
            DemoParserBackend::Fast
        );
    }

    #[test]
    fn replay_metadata_keeps_header_ticks_instead_of_reconstructing_them_from_time() {
        let replay_info = CDemoFileInfo {
            playback_ticks: Some(7_681),
            playback_time: Some(120.0),
            ..CDemoFileInfo::default()
        };

        let (verified_total_ticks, duration_seconds, tick_rate) =
            verified_replay_metadata(&replay_info).expect("valid replay metadata");

        assert_eq!(verified_total_ticks, 7_681);
        assert!((duration_seconds - 120.0).abs() < f64::EPSILON);
        assert!((tick_rate - (7_681.0 / 120.0)).abs() < f64::EPSILON);
    }

    #[test]
    fn fast_backend_returns_its_own_error_without_retrying_another_parser() {
        let mut demo = tempfile::Builder::new().suffix(".dem").tempfile().unwrap();
        demo.write_all(b"PBDEMS2\0abcdefgh").unwrap();
        let config = DemoEngineConfig {
            backend: DemoParserBackend::Fast,
            ..DemoEngineConfig::default()
        };
        let cancellation = ParseCancellation::default();
        let fast_error = analyze_fast(demo.path(), Uuid::nil(), config, &cancellation)
            .expect_err("incomplete demo must fail in the selected fast parser");
        assert!(matches!(
            fast_error,
            DemoError::Parse(_) | DemoError::MetadataUnavailable(_)
        ));

        let selected_error = analyze_blocking(
            demo.path(),
            Uuid::nil(),
            config,
            &ParseCancellation::default(),
        )
        .expect_err("selected fast parser must report its own failure");

        assert_eq!(selected_error.to_string(), fast_error.to_string());
    }

    #[test]
    #[ignore = "requires VIBE_CS_REAL_DEMO_DIR pointing at the local Major final demos"]
    fn real_major_replay_headers_report_authoritative_total_ticks() {
        let directory = std::path::PathBuf::from(
            std::env::var("VIBE_CS_REAL_DEMO_DIR").expect("VIBE_CS_REAL_DEMO_DIR"),
        );
        for (file, expected_total_ticks) in [
            ("furia-vs-falcons-m1-mirage.dem", 189_316),
            ("furia-vs-falcons-m2-anubis.dem", 211_707),
            ("furia-vs-falcons-m3-inferno.dem", 216_279),
        ] {
            let bytes = std::fs::read(directory.join(file)).expect("read real demo");
            let parser = Parser::new(&bytes).expect("read authoritative replay header");
            let playback_ticks = parser.replay_info().playback_ticks();
            assert_eq!(playback_ticks, expected_total_ticks, "{file}");
        }
    }

    #[test]
    #[ignore = "requires VIBE_CS_REAL_DEMO_DIR pointing at the local Major final demos"]
    fn cooperative_parser_persists_authoritative_total_ticks_for_the_real_major_final() {
        let directory = std::path::PathBuf::from(
            std::env::var("VIBE_CS_REAL_DEMO_DIR").expect("VIBE_CS_REAL_DEMO_DIR"),
        );
        for (file, expected_total_ticks) in [
            ("furia-vs-falcons-m1-mirage.dem", 189_316),
            ("furia-vs-falcons-m2-anubis.dem", 211_707),
            ("furia-vs-falcons-m3-inferno.dem", 216_279),
        ] {
            let analysis = analyze_source2_blocking(
                &directory.join(file),
                Uuid::nil(),
                DemoEngineConfig::default(),
                &ParseCancellation::default(),
            )
            .unwrap_or_else(|error| panic!("cooperative parser should parse {file}: {error}"));
            let verified_total_ticks = analysis
                .verified_total_ticks
                .unwrap_or_else(|| panic!("{file} must persist replay_info.playback_ticks"));
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
                .collect::<BTreeSet<_>>();

            assert_eq!(verified_total_ticks, expected_total_ticks, "{file}");
            assert_eq!(analysis.players.len(), 10, "{file}");
            assert_eq!(spectator_slots.len(), 10, "{file}");
            assert!(
                spectator_slots.iter().all(|slot| (1..=64).contains(slot)),
                "{file}"
            );
            assert!(
                u64::from(verified_total_ticks)
                    >= analysis
                        .rounds
                        .last()
                        .expect("last competitive round")
                        .end_tick,
                "{file}"
            );
        }
    }
}
