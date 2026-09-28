use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::Path,
};

use sha2::{Digest, Sha256};
use source2_demo::prelude::Parser as MetadataParser;
use vibe_cs_domain::{
    RoundReplayArtifact, RoundReplayFieldAvailability, RoundReplayFields, RoundReplayFrame,
    RoundReplayMetadata, RoundReplayPlayer, RoundReplayRequest,
};

use crate::{
    DemoError, DemoResult, ParseCancellation, ValidationLimits, engine::verified_replay_metadata,
    validate_demo,
};

pub const ROUND_REPLAY_SAMPLING_CONTRACT_VERSION: u32 = 3;
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

    let requested_tick_count = requested_ticks.len();
    let requested_ticks = crate::replay_snapshots::select_snapshot_ticks(&bytes, &requested_ticks)?;
    let mut utility =
        crate::replay_projectiles::read_utility_events(&bytes, tick_rate, cancellation)?;
    let freeze_ticks = utility
        .freeze_ends
        .into_iter()
        .filter(|tick| (request.start_tick..=request.end_tick).contains(tick))
        .collect::<BTreeSet<_>>();
    if freeze_ticks.len() > 1 {
        return Err(DemoError::Parse(
            "selected-round replay contains ambiguous freeze-end events".to_owned(),
        ));
    }
    let freeze_end_tick = freeze_ticks.into_iter().next();
    utility.events.push(crate::replay::round_boundary(
        request.start_tick,
        tick_rate,
    )?);
    let mut frames = parse_selected_ticks(&bytes, request, &requested_ticks, cancellation)?;
    let mut flights = crate::replay_projectiles::read_projectiles(
        &bytes,
        &requested_ticks,
        &utility.events,
        cancellation,
    )?;
    let mut utility_frames = requested_ticks
        .iter()
        .map(|tick| vibe_cs_domain::ReplayFrame {
            tick: *tick,
            players: Vec::new(),
            projectiles: flights.remove(tick).unwrap_or_default(),
            bomb: None,
        })
        .collect::<Vec<_>>();
    crate::replay::apply_replay_state(&mut utility_frames, &utility.events)?;
    for (frame, utility) in frames.iter_mut().zip(utility_frames) {
        frame.projectiles = utility.projectiles;
        frame.bomb = utility.bomb;
    }
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
            requested_tick_count: u32::try_from(requested_tick_count)
                .map_err(|_| DemoError::MetadataUnavailable("round requested tick count"))?,
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
            freeze_end_tick,
            players_per_frame: 10,
            fields: RoundReplayFields {
                pitch: vibe_cs_domain::RoundReplayFieldAvailability::Required,
                position: RoundReplayFieldAvailability::Required,
                yaw: RoundReplayFieldAvailability::Required,
                health: RoundReplayFieldAvailability::Required,
                armor: RoundReplayFieldAvailability::Required,
                life_state: RoundReplayFieldAvailability::Required,
                money: RoundReplayFieldAvailability::Required,
                current_equipment_value: RoundReplayFieldAvailability::Required,
                round_start_equipment_value: RoundReplayFieldAvailability::Required,
                has_helmet: RoundReplayFieldAvailability::Required,
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
    let snapshots = crate::replay_snapshots::read_player_snapshots(
        bytes,
        requested_ticks,
        &[],
        cancellation,
        MAXIMUM_ROUND_REPLAY_FRAMES * 64,
    )?;
    materialize_frames(snapshots, request, requested_ticks)
}

fn materialize_frames(
    snapshots: Vec<crate::replay_snapshots::PlayerSnapshot>,
    request: &RoundReplayRequest,
    requested_ticks: &[u64],
) -> DemoResult<Vec<RoundReplayFrame>> {
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
    for snapshot in snapshots {
        let Some(player) = roster.get(&snapshot.steam_id) else {
            return Err(DemoError::Parse(
                "selected-round replay contains an extra competitive player".to_owned(),
            ));
        };
        if snapshot.side != player.side {
            return Err(DemoError::Parse(format!(
                "selected-round replay side conflicts for {} at tick {}",
                player.steam_id, snapshot.tick
            )));
        }
        by_tick
            .get_mut(&snapshot.tick)
            .expect("requested snapshot tick")
            .push(RoundReplayPlayer {
                steam_id: player.steam_id.clone(),
                name: player.name.clone(),
                team: player.team.clone(),
                side: player.side.clone(),
                position: snapshot.position,
                yaw: snapshot.yaw,
                pitch: snapshot.pitch,
                health: snapshot.health,
                armor: snapshot.armor,
                life_state: snapshot.life_state,
                alive: snapshot.life_state == 0 && snapshot.health > 0,
                money: snapshot.money,
                current_equipment_value: snapshot.current_equipment_value,
                round_start_equipment_value: snapshot.round_start_equipment_value,
                has_helmet: snapshot.has_helmet,
                active_weapon_name: snapshot.active_weapon_name,
            });
    }
    requested_ticks
        .iter()
        .map(|tick| {
            let mut players = by_tick.remove(tick).expect("requested tick");
            players.sort_by(|left, right| left.steam_id.cmp(&right.steam_id));
            if players.len() != 10 {
                return Err(DemoError::Unavailable {
                    capability: "selected-round replay",
                    reason: format!(
                        "tick {tick} does not contain the exact verified ten-player roster"
                    ),
                });
            }
            Ok(RoundReplayFrame {
                tick: *tick,
                players,
                projectiles: Vec::new(),
                bomb: None,
            })
        })
        .collect()
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
        assert!(artifact.metadata.freeze_end_tick.is_some());
        assert!(
            artifact
                .frames
                .iter()
                .any(|frame| frame.players.iter().any(|player| player.pitch.abs() > 1.0))
        );
        assert!(
            artifact
                .frames
                .iter()
                .any(|frame| !frame.projectiles.is_empty())
        );
        assert_eq!(artifact.frames.len(), 319);
        assert!(
            artifact
                .frames
                .iter()
                .all(|frame| frame.players.len() == 10)
        );
        assert!(
            artifact
                .frames
                .iter()
                .all(|frame| frame.players.iter().all(|player| {
                    player.money <= 100_000
                        && player.current_equipment_value <= 100_000
                        && player.round_start_equipment_value <= 100_000
                }))
        );
        assert_eq!(artifact.frames.first().unwrap().tick, 156_234);
        assert_eq!(artifact.frames.last().unwrap().tick, 161_310);
    }
}
