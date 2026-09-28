use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
};

use sha2::{Digest, Sha256};
use source2_demo::prelude::Parser as MetadataParser;
use vibe_cs_domain::{
    REPLAY_MAX_FRAMES, REPLAY_MAX_PLAYER_RECORDS, ReplayArtifact, ReplayFidelityMetadata,
    ReplayFidelityMode, ReplayFrame, ReplayPlayer, ReplayRequest,
};

use crate::{
    DemoError, DemoResult, ParseCancellation, ValidationLimits, engine::verified_replay_metadata,
    replay::apply_replay_state, replay_projectiles::read_projectiles,
    replay_snapshots::read_player_snapshots, validate_demo,
};

pub const REPLAY_SAMPLE_INTERVAL_TICKS: u32 = 16;
pub const HIGHLIGHT_SAMPLE_INTERVAL_TICKS: u32 = 8;

/// Extract a complete selected-tick replay directly from the immutable Demo.
/// Statistics events contribute utility lifetimes and bomb state, never substitute
/// stale event positions for player snapshots.
///
/// # Errors
/// Rejects changed input, invalid selection bounds, missing player state and
/// parser resource limits. It never returns a synthetic or event-only replay.
#[allow(
    clippy::missing_panics_doc,
    reason = "snapshot tick membership is established by the bounded snapshot reader"
)]
pub fn extract_replay(
    path: impl AsRef<Path>,
    request: &ReplayRequest,
    cancellation: &ParseCancellation,
) -> DemoResult<ReplayArtifact> {
    let ticks = replay_ticks(request)?;
    let fingerprint = &request.input;
    let mut identities = HashMap::new();
    for player in &request.roster {
        let id = player
            .id
            .parse::<u64>()
            .ok()
            .filter(|id| *id != 0)
            .ok_or_else(|| {
                DemoError::Parse("replay requires canonical Steam identities".to_owned())
            })?;
        if !matches!(player.team.as_str(), "A" | "B") || identities.insert(id, player).is_some() {
            return Err(DemoError::Parse(
                "replay requires unique stable Team A/B identities".to_owned(),
            ));
        }
    }
    if identities.is_empty()
        || identities.len() > 64
        || ticks.len().saturating_mul(identities.len()) > REPLAY_MAX_PLAYER_RECORDS
    {
        return Err(DemoError::ParserResourceLimit {
            resource: "replay_player_records".to_owned(),
            limit: REPLAY_MAX_PLAYER_RECORDS,
            actual: ticks.len().saturating_mul(identities.len()),
        });
    }
    let validated = validate_demo(path, ValidationLimits::default(), cancellation)?;
    if validated.size != fingerprint.size
        || !validated.sha256.eq_ignore_ascii_case(&fingerprint.sha256)
    {
        return Err(DemoError::Unavailable {
            capability: "replay",
            reason: "the Demo no longer matches its analyzed source fingerprint".to_owned(),
        });
    }
    let bytes =
        std::fs::read(&validated.path).map_err(|error| crate::io_error(&validated.path, error))?;
    if bytes.len() as u64 != fingerprint.size
        || !hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(&fingerprint.sha256)
    {
        return Err(DemoError::Unavailable {
            capability: "replay",
            reason: "the Demo changed while replay was opening it".to_owned(),
        });
    }
    let metadata =
        MetadataParser::new(&bytes).map_err(|error| DemoError::Parse(error.to_string()))?;
    let (total_ticks, _, tick_rate) = verified_replay_metadata(metadata.replay_info())?;
    if request.verified_total_ticks != total_ticks
        || (request.tick_rate - tick_rate).abs() > f64::EPSILON
    {
        return Err(DemoError::Unavailable {
            capability: "replay",
            reason: "replay header differs from the analyzed source".to_owned(),
        });
    }
    let players = identities.keys().copied().collect::<Vec<_>>();
    let ticks = crate::replay_snapshots::select_snapshot_ticks(&bytes, &ticks)?;
    let snapshots = read_player_snapshots(
        &bytes,
        &ticks,
        &players,
        cancellation,
        REPLAY_MAX_PLAYER_RECORDS,
    )?;
    let mut frames = ticks
        .iter()
        .map(|tick| {
            (
                *tick,
                ReplayFrame {
                    tick: *tick,
                    players: Vec::new(),
                    projectiles: Vec::new(),
                    bomb: None,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    for snapshot in snapshots {
        let player = identities[&snapshot.steam_id];
        frames
            .get_mut(&snapshot.tick)
            .expect("selected snapshot tick")
            .players
            .push(ReplayPlayer {
                id: player.id.clone(),
                name: player.name.clone(),
                team: player.team.clone(),
                position: snapshot.position,
                yaw: snapshot.yaw,
                pitch: snapshot.pitch,
                health: snapshot.health,
                armor: snapshot.armor,
                alive: snapshot.life_state == 0 && snapshot.health > 0,
                weapon: snapshot.active_weapon_name.unwrap_or_default(),
                input: snapshot.input,
            });
    }
    if let Some(frame) = frames.values().find(|frame| frame.players.is_empty()) {
        return Err(DemoError::Unavailable {
            capability: "replay",
            reason: format!(
                "no competitive player snapshots were captured at tick {}",
                frame.tick
            ),
        });
    }
    let mut events = request.utility_events.clone();
    for [start, _] in &request.rounds {
        events.push(crate::replay::round_boundary(*start, tick_rate)?);
    }
    let mut flights = read_projectiles(&bytes, &ticks, &events, cancellation)?;
    for frame in frames.values_mut() {
        frame.projectiles = flights.remove(&frame.tick).unwrap_or_default();
    }
    let mut frames = frames.into_values().collect::<Vec<_>>();
    apply_replay_state(&mut frames, &events)?;
    cancellation.check()?;
    Ok(ReplayArtifact {
        fidelity: ReplayFidelityMetadata {
            mode: ReplayFidelityMode::Hybrid,
            tick_rate,
            frame_count: frames.len() as u64,
            positioned_event_count: events
                .iter()
                .filter(|event| event.position.is_some())
                .count() as u64,
            start_tick: frames.first().map_or(0, |frame| frame.tick),
            end_tick: frames.last().map_or(0, |frame| frame.tick),
        },
        frames,
    })
}

fn replay_ticks(request: &ReplayRequest) -> DemoResult<Vec<u64>> {
    let total = request.verified_total_ticks;
    let mut ticks = BTreeSet::new();
    let mut add_range = |start: u64, end: u64, step: u32| -> DemoResult<()> {
        if start > end || end > u64::from(total) {
            return Err(DemoError::Parse(
                "replay selection is outside verified ticks".to_owned(),
            ));
        }
        for tick in (start..=end)
            .step_by(step as usize)
            .chain(std::iter::once(end))
        {
            ticks.insert(tick);
            if ticks.len() > REPLAY_MAX_FRAMES {
                return Err(DemoError::ParserResourceLimit {
                    resource: "replay_frames".to_owned(),
                    limit: REPLAY_MAX_FRAMES,
                    actual: ticks.len(),
                });
            }
        }
        Ok(())
    };
    for [start, end] in &request.rounds {
        add_range(*start, *end, REPLAY_SAMPLE_INTERVAL_TICKS)?;
    }
    for [start, end] in &request.highlights {
        add_range(*start, *end, HIGHLIGHT_SAMPLE_INTERVAL_TICKS)?;
    }
    for tick in &request.event_ticks {
        add_range(*tick, *tick, 1)?;
    }
    if ticks.is_empty() {
        return Err(DemoError::Unavailable {
            capability: "replay",
            reason: "analysis has no replay ranges".to_owned(),
        });
    }
    Ok(ticks.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ReplayRequest {
        ReplayRequest {
            demo_id: uuid::Uuid::new_v4(),
            input: vibe_cs_domain::AnalysisInputFingerprint {
                sha256: "a".repeat(64),
                size: 100,
            },
            tick_rate: 64.0,
            verified_total_ticks: 64,
            roster: Vec::new(),
            rounds: vec![[0, 64]],
            highlights: vec![[16, 32]],
            event_ticks: vec![19],
            utility_events: Vec::new(),
        }
    }

    #[test]
    fn sampling_merges_base_highlight_and_exact_event_ticks_without_duplicates() {
        assert_eq!(
            replay_ticks(&request()).unwrap(),
            [0, 16, 19, 24, 32, 48, 64]
        );
        let mut invalid = request();
        invalid.highlights = vec![[32, 65]];
        assert!(replay_ticks(&invalid).is_err());
        let mut large = request();
        large.verified_total_ticks = u32::MAX;
        large.rounds = vec![[0, u64::from(u32::MAX)]];
        assert!(matches!(
            replay_ticks(&large),
            Err(DemoError::ParserResourceLimit { .. })
        ));
    }
}
