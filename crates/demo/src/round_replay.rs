use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::Path,
};

use ahash::AHashMap;
use demoparser::{
    first_pass::{
        parser_settings::{ParserInputs, rm_user_friendly_names},
        prop_controller::TICK_ID,
    },
    parse_demo::{Parser as FastParser, ParserResourceOptions, ParsingMode},
    second_pass::{
        parser_settings::create_huffman_lookup_table,
        variants::{PropColumn, VarVec},
    },
};
use sha2::{Digest, Sha256};
use source2_demo::prelude::Parser as MetadataParser;
use vibe_cs_domain::{
    RoundReplayArtifact, RoundReplayFieldAvailability, RoundReplayFields, RoundReplayFrame,
    RoundReplayMetadata, RoundReplayPlayer, RoundReplayRequest,
};

use crate::{
    DemoError, DemoResult, ParseCancellation, ValidationLimits,
    demoparser_backend::{parser_decode_error, parser_resource_policy_error},
    engine::verified_replay_metadata,
    validate_demo,
};

pub const ROUND_REPLAY_SAMPLING_CONTRACT_VERSION: u32 = 1;
pub const ROUND_REPLAY_SAMPLE_INTERVAL_TICKS: u32 = 16;
pub const MAXIMUM_ROUND_REPLAY_FRAMES: usize = 2_048;

/// Extracts exact selected-tick player state for one producer-bound round.
///
/// # Errors
///
/// Returns an error when the request is not a bounded exact round or when the
/// source/parser cannot prove the complete ten-player state.
pub fn extract_round_replay(
    path: impl AsRef<Path>,
    request: &RoundReplayRequest,
    cancellation: &ParseCancellation,
) -> DemoResult<RoundReplayArtifact> {
    validate_request(request)?;
    let requested_ticks = requested_ticks(request)?;
    let path = path.as_ref();
    let validated = validate_demo(path, ValidationLimits::default(), cancellation)?;
    if validated.sha256 != request.input_sha256 || validated.size != request.input_size {
        return Err(DemoError::Unavailable {
            capability: "selected-round replay",
            reason: "the current Demo source does not match the producer run fingerprint"
                .to_owned(),
        });
    }
    cancellation.check()?;
    let bytes = std::fs::read(path).map_err(|error| crate::io_error(path, error))?;
    let observed_size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    let observed_sha256 = hex::encode(Sha256::digest(&bytes));
    if observed_size != request.input_size || observed_sha256 != request.input_sha256 {
        return Err(DemoError::Unavailable {
            capability: "selected-round replay",
            reason: "the Demo source changed while selected-round replay was opening it".to_owned(),
        });
    }
    cancellation.check()?;

    let metadata = MetadataParser::new(&bytes)
        .map_err(|error| DemoError::Parse(format!("metadata parser: {error}")))?;
    let (total_ticks, _, tick_rate) = verified_replay_metadata(metadata.replay_info())?;
    if u64::from(total_ticks) != request.verified_total_ticks
        || (tick_rate - request.tick_rate).abs() > f64::EPSILON
    {
        return Err(DemoError::Unavailable {
            capability: "selected-round replay",
            reason: "the producer run replay header does not match the current Demo source"
                .to_owned(),
        });
    }

    let frames = parse_selected_ticks(&bytes, request, &requested_ticks, cancellation)?;
    let tick_count = u32::try_from(requested_ticks.len())
        .map_err(|_| DemoError::MetadataUnavailable("selected-round replay tick count overflow"))?;
    Ok(RoundReplayArtifact {
        metadata: RoundReplayMetadata {
            producer_run_id: request.producer_run_id,
            demo_id: request.demo_id,
            input_sha256: request.input_sha256.clone(),
            input_size: request.input_size,
            round: request.round,
            start_tick: request.start_tick,
            end_tick: request.end_tick,
            tick_rate: request.tick_rate,
            sampling_contract_version: ROUND_REPLAY_SAMPLING_CONTRACT_VERSION,
            sample_interval_ticks: ROUND_REPLAY_SAMPLE_INTERVAL_TICKS,
            requested_tick_count: tick_count,
            accepted_tick_count: tick_count,
            event_tick_count: u32::try_from(
                request
                    .event_ticks
                    .iter()
                    .copied()
                    .collect::<HashSet<_>>()
                    .len(),
            )
            .map_err(|_| {
                DemoError::MetadataUnavailable("selected-round replay event tick count overflow")
            })?,
            players_per_frame: 10,
            fields: RoundReplayFields {
                position: RoundReplayFieldAvailability::Required,
                yaw: RoundReplayFieldAvailability::Required,
                health: RoundReplayFieldAvailability::Required,
                armor: RoundReplayFieldAvailability::Required,
                life_state: RoundReplayFieldAvailability::Required,
                active_weapon_name: RoundReplayFieldAvailability::Nullable,
            },
        },
        frames,
    })
}

fn parse_selected_ticks(
    bytes: &[u8],
    request: &RoundReplayRequest,
    requested_ticks: &[u64],
    cancellation: &ParseCancellation,
) -> DemoResult<Vec<RoundReplayFrame>> {
    let friendly_props = [
        "X",
        "Y",
        "Z",
        "yaw",
        "health",
        "armor",
        "life_state",
        "team_num",
        "active_weapon_name",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    let real_props = rm_user_friendly_names(&friendly_props)
        .map_err(|error| DemoError::Parse(format!("demoparser replay properties: {error}")))?;
    let real_name_to_og_name = real_props
        .iter()
        .zip(&friendly_props)
        .map(|(real, friendly)| (real.clone(), friendly.clone()))
        .collect();
    let wanted_ticks = requested_ticks
        .iter()
        .map(|tick| {
            i32::try_from(*tick).map_err(|_| {
                DemoError::Parse("selected-round replay tick exceeds parser range".to_owned())
            })
        })
        .collect::<DemoResult<Vec<_>>>()?;
    let huffman = create_huffman_lookup_table();
    let inputs = ParserInputs {
        real_name_to_og_name,
        wanted_players: Vec::new(),
        wanted_player_props: real_props,
        wanted_other_props: Vec::new(),
        wanted_prop_states: AHashMap::default(),
        wanted_ticks,
        wanted_events: Vec::new(),
        parse_ents: true,
        parse_projectiles: false,
        parse_grenades: false,
        only_header: true,
        only_convars: false,
        huffman_lookup_table: &huffman,
        order_by_steamid: true,
        list_props: false,
        fallback_bytes: None,
    };
    let mut parser = FastParser::with_resource_options(
        inputs,
        ParsingMode::Normal,
        ParserResourceOptions {
            // demoparser still observes the Demo's event stream while resolving
            // selected entity ticks even when no event payloads are requested.
            max_game_events: 100_000,
            max_collected_rows: MAXIMUM_ROUND_REPLAY_FRAMES * 64,
            ..ParserResourceOptions::default()
        },
    )
    .map_err(parser_resource_policy_error)?;
    let output = parser.parse_demo(bytes).map_err(parser_decode_error)?;
    cancellation.check()?;

    let prop_ids = ReplayPropertyIds::from_columns(&output.prop_controller.prop_infos)?;
    materialize_frames(&output.df_per_player, request, requested_ticks, prop_ids)
}

#[derive(Debug, Clone, Copy)]
struct ReplayPropertyIds {
    x: u32,
    y: u32,
    z: u32,
    yaw: u32,
    health: u32,
    armor: u32,
    life_state: u32,
    team_num: u32,
    active_weapon_name: u32,
}

impl ReplayPropertyIds {
    fn from_columns(
        infos: &[demoparser::first_pass::prop_controller::PropInfo],
    ) -> DemoResult<Self> {
        let find = |name: &str| {
            infos
                .iter()
                .find(|info| info.prop_friendly_name == name)
                .map(|info| info.id)
                .ok_or_else(|| {
                    DemoError::Parse(format!(
                        "demoparser selected-round property {name} is absent"
                    ))
                })
        };
        Ok(Self {
            x: find("X")?,
            y: find("Y")?,
            z: find("Z")?,
            yaw: find("yaw")?,
            health: find("health")?,
            armor: find("armor")?,
            life_state: find("life_state")?,
            team_num: find("team_num")?,
            active_weapon_name: find("active_weapon_name")?,
        })
    }
}

fn materialize_frames(
    per_player: &AHashMap<u64, AHashMap<u32, PropColumn>>,
    request: &RoundReplayRequest,
    requested_ticks: &[u64],
    ids: ReplayPropertyIds,
) -> DemoResult<Vec<RoundReplayFrame>> {
    let requested = requested_ticks.iter().copied().collect::<HashSet<_>>();
    let roster = request
        .roster
        .iter()
        .map(|player| {
            (
                player.steam_id.parse::<u64>().expect("validated Steam64"),
                player,
            )
        })
        .collect::<HashMap<_, _>>();
    let mut by_tick = requested_ticks
        .iter()
        .copied()
        .map(|tick| (tick, Vec::with_capacity(10)))
        .collect::<HashMap<_, _>>();

    for (steam_id, columns) in per_player {
        let tick_values = tick_values(columns)?;
        let roster_player = roster.get(steam_id).copied();
        for (index, tick) in tick_values.iter().enumerate() {
            let Some(tick) = tick.and_then(|tick| u64::try_from(tick).ok()) else {
                continue;
            };
            if !requested.contains(&tick) {
                continue;
            }
            let observed_side = match numeric_at(columns.get(&ids.team_num), index) {
                Some(2) => Some("T"),
                Some(3) => Some("CT"),
                _ => None,
            };
            let Some(roster_player) = roster_player else {
                if observed_side.is_some() && *steam_id != 0 {
                    return Err(DemoError::Parse(
                        "selected-round replay contains an extra competitive player".to_owned(),
                    ));
                }
                continue;
            };
            if observed_side != Some(roster_player.side.as_str()) {
                return Err(DemoError::Parse(format!(
                    "selected-round replay side conflicts for {} at tick {tick}",
                    roster_player.steam_id
                )));
            }
            let x = finite_at(columns.get(&ids.x), index)?;
            let y = finite_at(columns.get(&ids.y), index)?;
            let z = finite_at(columns.get(&ids.z), index)?;
            let yaw = finite_at(columns.get(&ids.yaw), index)?;
            if ![x, y, z]
                .into_iter()
                .all(|value| (-1_000_000.0..=1_000_000.0).contains(&value))
                || !(-360.0..=360.0).contains(&yaw)
            {
                return Err(DemoError::Parse(
                    "selected-round replay contains out-of-range spatial state".to_owned(),
                ));
            }
            let health = bounded_u32_at(columns.get(&ids.health), index, 200)?;
            let armor = bounded_u32_at(columns.get(&ids.armor), index, 200)?;
            let life_state = bounded_u32_at(columns.get(&ids.life_state), index, 255)?;
            let active_weapon_name = string_at(columns.get(&ids.active_weapon_name), index)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            if active_weapon_name
                .as_deref()
                .is_some_and(|value| !is_bounded_text(value, 128))
            {
                return Err(DemoError::Parse(
                    "selected-round replay weapon name is invalid".to_owned(),
                ));
            }
            by_tick
                .get_mut(&tick)
                .expect("requested tick exists")
                .push(RoundReplayPlayer {
                    steam_id: roster_player.steam_id.clone(),
                    name: roster_player.name.clone(),
                    team: roster_player.team.clone(),
                    side: roster_player.side.clone(),
                    position: [x, y, z],
                    yaw,
                    health,
                    armor,
                    life_state,
                    alive: life_state == 0 && health > 0,
                    active_weapon_name,
                });
        }
    }

    let mut frames = Vec::with_capacity(requested_ticks.len());
    for tick in requested_ticks {
        let mut players = by_tick.remove(tick).expect("requested tick exists");
        players.sort_by(|left, right| left.steam_id.cmp(&right.steam_id));
        if players.len() != 10
            || players
                .iter()
                .map(|player| player.steam_id.as_str())
                .collect::<HashSet<_>>()
                .len()
                != 10
        {
            return Err(DemoError::Unavailable {
                capability: "selected-round replay",
                reason: format!(
                    "tick {tick} does not contain the exact verified ten-player roster"
                ),
            });
        }
        frames.push(RoundReplayFrame {
            tick: *tick,
            players,
        });
    }
    Ok(frames)
}

fn tick_values(columns: &AHashMap<u32, PropColumn>) -> DemoResult<&[Option<i32>]> {
    match columns
        .get(&TICK_ID)
        .and_then(|column| column.data.as_ref())
    {
        Some(VarVec::I32(values)) => Ok(values),
        _ => Err(DemoError::Parse(
            "demoparser selected-round tick column is absent".to_owned(),
        )),
    }
}

fn numeric_at(column: Option<&PropColumn>, index: usize) -> Option<i64> {
    match column.and_then(|column| column.data.as_ref()) {
        Some(VarVec::I32(values)) => values.get(index).copied().flatten().map(i64::from),
        Some(VarVec::U32(values)) => values.get(index).copied().flatten().map(i64::from),
        Some(VarVec::U64(values)) => values
            .get(index)
            .copied()
            .flatten()
            .and_then(|value| i64::try_from(value).ok()),
        _ => None,
    }
}

fn finite_at(column: Option<&PropColumn>, index: usize) -> DemoResult<f64> {
    let value = match column.and_then(|column| column.data.as_ref()) {
        Some(VarVec::F32(values)) => values.get(index).copied().flatten().map(f64::from),
        Some(VarVec::I32(values)) => values.get(index).copied().flatten().map(f64::from),
        Some(VarVec::U32(values)) => values.get(index).copied().flatten().map(f64::from),
        _ => None,
    }
    .filter(|value| value.is_finite())
    .ok_or_else(|| {
        DemoError::Parse("selected-round replay required numeric state is absent".to_owned())
    })?;
    Ok(value)
}

fn bounded_u32_at(column: Option<&PropColumn>, index: usize, maximum: u32) -> DemoResult<u32> {
    let value = numeric_at(column, index)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value <= maximum)
        .ok_or_else(|| {
            DemoError::Parse("selected-round replay bounded player state is absent".to_owned())
        })?;
    Ok(value)
}

fn string_at(column: Option<&PropColumn>, index: usize) -> Option<&str> {
    match column.and_then(|column| column.data.as_ref()) {
        Some(VarVec::String(values)) => values.get(index)?.as_deref(),
        _ => None,
    }
}

fn validate_request(request: &RoundReplayRequest) -> DemoResult<()> {
    if request.producer_run_id.is_nil()
        || request.demo_id.is_nil()
        || request.input_size == 0
        || !is_sha256(&request.input_sha256)
        || !request.tick_rate.is_finite()
        || !(8.0..=1_024.0).contains(&request.tick_rate)
        || request.round == 0
        || request.start_tick > request.end_tick
        || request.end_tick > request.verified_total_ticks
    {
        return Err(DemoError::Parse(
            "selected-round replay has invalid round bounds".to_owned(),
        ));
    }
    if request
        .event_ticks
        .iter()
        .any(|tick| !(request.start_tick..=request.end_tick).contains(tick))
    {
        return Err(DemoError::Parse(
            "selected-round replay event tick is outside the exact round".to_owned(),
        ));
    }
    validate_roster(request)?;
    let _ = requested_ticks(request)?;
    Ok(())
}

fn validate_roster(request: &RoundReplayRequest) -> DemoResult<()> {
    if request.roster.len() != 10 {
        return Err(DemoError::Parse(
            "selected-round replay roster must contain exactly ten players".to_owned(),
        ));
    }
    let mut identities = HashSet::with_capacity(request.roster.len());
    let mut team_counts = HashMap::<&str, usize>::new();
    let mut side_counts = HashMap::<&str, usize>::new();
    let mut team_sides = HashMap::<&str, &str>::new();
    for player in &request.roster {
        if !is_steam_id(&player.steam_id)
            || !identities.insert(player.steam_id.as_str())
            || !is_bounded_text(&player.name, 128)
            || !matches!(player.team.as_str(), "A" | "B")
            || !matches!(player.side.as_str(), "T" | "CT")
        {
            return Err(DemoError::Parse(
                "selected-round replay roster contains a noncanonical player".to_owned(),
            ));
        }
        *team_counts.entry(&player.team).or_default() += 1;
        *side_counts.entry(&player.side).or_default() += 1;
        if team_sides
            .insert(&player.team, &player.side)
            .is_some_and(|side| side != player.side)
        {
            return Err(DemoError::Parse(
                "selected-round replay roster maps one team to conflicting sides".to_owned(),
            ));
        }
    }
    if team_counts.get("A") != Some(&5)
        || team_counts.get("B") != Some(&5)
        || side_counts.get("T") != Some(&5)
        || side_counts.get("CT") != Some(&5)
        || team_sides.get("A") == team_sides.get("B")
    {
        return Err(DemoError::Parse(
            "selected-round replay roster is not one verified 5v5 Team A/B mapping".to_owned(),
        ));
    }
    Ok(())
}

fn requested_ticks(request: &RoundReplayRequest) -> DemoResult<Vec<u64>> {
    let mut ticks = BTreeSet::new();
    let mut tick = request.start_tick;
    loop {
        ticks.insert(tick);
        if tick >= request.end_tick {
            break;
        }
        tick = tick
            .checked_add(u64::from(ROUND_REPLAY_SAMPLE_INTERVAL_TICKS))
            .unwrap_or(request.end_tick)
            .min(request.end_tick);
    }
    ticks.insert(request.end_tick);
    ticks.extend(request.event_ticks.iter().copied());
    if ticks.len() > MAXIMUM_ROUND_REPLAY_FRAMES {
        return Err(DemoError::ParserResourceLimit {
            resource: "selected_round_replay_frames".to_owned(),
            limit: MAXIMUM_ROUND_REPLAY_FRAMES,
            actual: ticks.len(),
        });
    }
    Ok(ticks.into_iter().collect())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        && value.bytes().all(|byte| !byte.is_ascii_uppercase())
}

fn is_steam_id(value: &str) -> bool {
    if value.len() != 17 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Ok(steam_id) = value.parse::<u64>() else {
        return false;
    };
    let universe = (steam_id >> 56) & 0xff;
    let account_type = (steam_id >> 52) & 0x0f;
    let instance = (steam_id >> 32) & 0x000f_ffff;
    let account_id = steam_id & u64::from(u32::MAX);
    universe == 1 && account_type == 1 && instance == 1 && account_id != 0
}

fn is_bounded_text(value: &str, maximum_chars: usize) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.chars().count() <= maximum_chars
        && !value.contains(['\r', '\n', '\0'])
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use uuid::Uuid;
    use vibe_cs_domain::{RoundReplayRequest, RoundReplayRosterPlayer};

    use super::extract_round_replay;
    use crate::{DemoError, ParseCancellation};

    fn request() -> RoundReplayRequest {
        RoundReplayRequest {
            producer_run_id: Uuid::new_v4(),
            demo_id: Uuid::new_v4(),
            input_sha256: "0".repeat(64),
            input_size: 16,
            round: 1,
            start_tick: 100,
            end_tick: 132,
            verified_total_ticks: 200,
            tick_rate: 64.0,
            event_ticks: vec![116],
            roster: (0..10)
                .map(|index| RoundReplayRosterPlayer {
                    steam_id: format!("7656119800000000{index}"),
                    name: format!("Player {index}"),
                    team: if index < 5 { "A" } else { "B" }.to_owned(),
                    side: if index < 5 { "T" } else { "CT" }.to_owned(),
                })
                .collect(),
        }
    }

    #[test]
    fn selected_round_replay_rejects_event_ticks_outside_the_exact_round_before_io() {
        let mut request = request();
        request.event_ticks.push(133);

        let error = extract_round_replay(
            PathBuf::from("missing.dem"),
            &request,
            &ParseCancellation::default(),
        )
        .expect_err("an out-of-round event tick must fail closed");

        assert!(matches!(error, DemoError::Parse(message) if message.contains("event tick")));
    }

    #[test]
    fn selected_round_replay_rejects_a_noncanonical_or_duplicate_ten_player_roster_before_io() {
        let mut request = request();
        request.roster[9].steam_id = request.roster[0].steam_id.clone();

        let error = extract_round_replay(
            PathBuf::from("missing.dem"),
            &request,
            &ParseCancellation::default(),
        )
        .expect_err("a duplicate roster identity must fail closed");

        assert!(matches!(error, DemoError::Parse(message) if message.contains("roster")));
    }

    #[test]
    #[ignore = "requires VIBE_CS_REAL_DEMO_DIR with the 2026 Major final demos"]
    fn real_major_m1_round_20_materializes_every_requested_tick_with_exact_ten_player_state() {
        let root = std::env::var_os("VIBE_CS_REAL_DEMO_DIR")
            .map(PathBuf::from)
            .expect("VIBE_CS_REAL_DEMO_DIR");
        let mut request = request();
        request.input_sha256 =
            "04f26f0f092f24fd13e7939dc56e72a3783a61872500b97b09810ed5a2363697".to_owned();
        request.input_size = 438_520_684;
        request.round = 20;
        request.start_tick = 156_234;
        request.end_tick = 161_310;
        request.verified_total_ticks = 189_316;
        request.event_ticks.clear();
        request.roster = [
            ("76561197960690195", "FalleN", "A", "CT"),
            ("76561198058500492", "KSCERATO", "A", "CT"),
            ("76561198134401925", "YEKINDAR", "A", "CT"),
            ("76561198164970560", "yuurih", "A", "CT"),
            ("76561198200982290", "molodoy", "A", "CT"),
            ("76561197989430253", "karrigan", "B", "T"),
            ("76561197996678278", "TeSeS", "B", "T"),
            ("76561198041683378", "NiKo", "B", "T"),
            ("76561198074762801", "m0NESY", "B", "T"),
            ("76561199032006224", "kyousuke", "B", "T"),
        ]
        .into_iter()
        .map(|(steam_id, name, team, side)| RoundReplayRosterPlayer {
            steam_id: steam_id.to_owned(),
            name: name.to_owned(),
            team: team.to_owned(),
            side: side.to_owned(),
        })
        .collect();

        let artifact = extract_round_replay(
            root.join("furia-vs-falcons-m1-mirage.dem"),
            &request,
            &ParseCancellation::default(),
        )
        .expect("selected-round replay");

        assert_eq!(artifact.metadata.requested_tick_count, 319);
        assert_eq!(artifact.metadata.accepted_tick_count, 319);
        assert_eq!(artifact.frames.len(), 319);
        assert!(
            artifact
                .frames
                .iter()
                .all(|frame| frame.players.len() == 10)
        );
        assert_eq!(artifact.frames.first().unwrap().tick, 156_234);
        assert_eq!(artifact.frames.last().unwrap().tick, 161_310);
    }
}
