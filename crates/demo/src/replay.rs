use std::collections::{BTreeMap, HashMap, VecDeque};

use vibe_cs_domain::{
    EventKind, HeatPoint, ReplayArtifact, ReplayBomb, ReplayFidelityMetadata, ReplayFidelityMode,
    ReplayFrame, ReplayPlayer, ReplayProjectile, RoundSummary, TimelineEvent,
};

use crate::entity_replay::{embedded_entity_replay, entity_replay_unavailable_reason};
use crate::{DemoError, DemoResult};

const MAXIMUM_REPLAY_FRAMES: usize = 20_000;
const MAXIMUM_REPLAY_PLAYERS_PER_FRAME: usize = 64;
// Retains a full ten-player competitive state at the maximum frame budget.
const MAXIMUM_REPLAY_PLAYER_RECORDS: usize = 200_000;
const MAXIMUM_REPLAY_EFFECTS_PER_FRAME: usize = 512;
// Retains five simultaneous effects across every maximum-budget frame.
const MAXIMUM_REPLAY_EFFECT_RECORDS: usize = 100_000;
const MAXIMUM_REPLAY_SOURCE_EVENTS: usize = 100_000;

/// Builds deterministic sparse frames from events that carry world positions.
/// A kill/damage position is assigned to its target; other positioned player
/// events are assigned to their actor. Unknown attributes remain conservative
/// (`0`/empty) rather than being fabricated.
///
/// # Errors
///
/// Returns an unavailable error when no positioned event can form a frame.
pub fn replay_frames_from_events(events: &[TimelineEvent]) -> DemoResult<Vec<ReplayFrame>> {
    build_replay_frames(events).map(|(frames, _)| frames)
}

/// Builds replay frames together with explicit spatial and timing fidelity.
///
/// # Errors
///
/// Returns an unavailable error when no trustworthy spatial evidence exists,
/// or a metadata error when `tick_rate` cannot safely drive playback timing.
pub fn replay_artifact_from_events(
    events: &[TimelineEvent],
    tick_rate: f64,
) -> DemoResult<ReplayArtifact> {
    if !tick_rate.is_finite() || !(8.0..=1024.0).contains(&tick_rate) {
        return Err(DemoError::MetadataUnavailable("tick rate"));
    }
    let (frames, mode) = build_replay_frames(events)?;
    let start_tick = frames.first().map_or(0, |frame| frame.tick);
    let end_tick = frames.last().map_or(0, |frame| frame.tick);
    Ok(ReplayArtifact {
        fidelity: ReplayFidelityMetadata {
            mode,
            tick_rate,
            frame_count: u64::try_from(frames.len()).unwrap_or(u64::MAX),
            positioned_event_count: u64::try_from(
                events
                    .iter()
                    .filter(|event| valid_position(event).is_some())
                    .count(),
            )
            .unwrap_or(u64::MAX),
            start_tick,
            end_tick,
        },
        frames,
    })
}

fn build_replay_frames(
    events: &[TimelineEvent],
) -> DemoResult<(Vec<ReplayFrame>, ReplayFidelityMode)> {
    if events.len() > MAXIMUM_REPLAY_SOURCE_EVENTS {
        return Err(DemoError::ParserResourceLimit {
            resource: "replay_source_events".to_owned(),
            limit: MAXIMUM_REPLAY_SOURCE_EVENTS,
            actual: events.len(),
        });
    }
    let entity_frames =
        embedded_entity_replay(events).map_err(|reason| DemoError::Unavailable {
            capability: "2D replay",
            reason,
        })?;
    if !entity_frames.is_empty() {
        let event_frames = match sparse_replay_frames_from_events(events) {
            Ok(frames) => frames,
            Err(DemoError::Unavailable { .. }) => Vec::new(),
            Err(error) => return Err(error),
        };
        let mode = if event_frames.is_empty() {
            ReplayFidelityMode::EntitySnapshots
        } else {
            ReplayFidelityMode::Hybrid
        };
        let mut frames = merge_replay_frames(entity_frames, event_frames)?;
        apply_replay_state(&mut frames, events)?;
        return Ok((frames, mode));
    }

    match sparse_replay_frames_from_events(events) {
        Ok(mut frames) => {
            apply_replay_state(&mut frames, events)?;
            Ok((frames, ReplayFidelityMode::EventSparse))
        }
        Err(DemoError::Unavailable { capability, reason }) => {
            let reason = entity_replay_unavailable_reason(events)
                .map(|entity_reason| {
                    format!(
                        "entity snapshots are unavailable ({entity_reason}); event fallback failed ({reason})"
                    )
                })
                .unwrap_or(reason);
            Err(DemoError::Unavailable { capability, reason })
        }
        Err(error) => Err(error),
    }
}

fn sparse_replay_frames_from_events(events: &[TimelineEvent]) -> DemoResult<Vec<ReplayFrame>> {
    if !events.iter().any(|event| valid_position(event).is_some()) {
        return Err(DemoError::Unavailable {
            capability: "2D replay",
            reason: "the selected events contain no world coordinates".to_owned(),
        });
    }
    let mut by_tick: BTreeMap<u64, Vec<&TimelineEvent>> = BTreeMap::new();
    for event in events.iter().filter(|event| {
        valid_position(event).is_some()
            || matches!(
                event.kind,
                EventKind::RoundStart
                    | EventKind::BombDefuse
                    | EventKind::BombExplode
                    | EventKind::Grenade
            )
    }) {
        by_tick.entry(event.tick).or_default().push(event);
    }

    let mut known_players: HashMap<String, ReplayPlayer> = HashMap::new();
    let mut frames = Vec::new();
    let mut player_records = 0;
    for (tick, tick_events) in by_tick {
        let mut changed = false;
        for event in tick_events {
            if event.kind == EventKind::RoundStart {
                known_players.clear();
                continue;
            }
            let Some(position) = valid_position(event) else {
                changed |= matches!(
                    event.kind,
                    EventKind::BombDefuse | EventKind::BombExplode | EventKind::Grenade
                );
                continue;
            };
            if let Some(player) = replay_player_from_event(event, position) {
                known_players.insert(player.id.clone(), player);
                if known_players.len() > MAXIMUM_REPLAY_PLAYERS_PER_FRAME {
                    return Err(DemoError::ParserResourceLimit {
                        resource: "replay_players_per_frame".to_owned(),
                        limit: MAXIMUM_REPLAY_PLAYERS_PER_FRAME,
                        actual: known_players.len(),
                    });
                }
                changed = true;
            }
            match event.kind {
                EventKind::Grenade
                | EventKind::BombPlant
                | EventKind::BombDefuse
                | EventKind::BombExplode => {
                    changed = true;
                }
                _ => {}
            }
        }
        if changed {
            if frames.len() >= MAXIMUM_REPLAY_FRAMES {
                return Err(DemoError::ParserResourceLimit {
                    resource: "sparse_replay_frames".to_owned(),
                    limit: MAXIMUM_REPLAY_FRAMES,
                    actual: frames.len().saturating_add(1),
                });
            }
            player_records = checked_record_total(
                player_records,
                known_players.len(),
                "replay_player_records",
                MAXIMUM_REPLAY_PLAYER_RECORDS,
            )?;
            let mut players = known_players.values().cloned().collect::<Vec<_>>();
            players.sort_by(|left, right| left.id.cmp(&right.id));
            frames.push(ReplayFrame {
                tick,
                players,
                projectiles: Vec::new(),
                bomb: None,
            });
        }
    }
    if frames.is_empty() {
        Err(DemoError::Unavailable {
            capability: "2D replay",
            reason: "positioned events did not identify a player, projectile, or bomb".to_owned(),
        })
    } else {
        Ok(frames)
    }
}

fn merge_replay_frames(
    entity_frames: Vec<ReplayFrame>,
    event_frames: Vec<ReplayFrame>,
) -> DemoResult<Vec<ReplayFrame>> {
    if entity_frames.len() > MAXIMUM_REPLAY_FRAMES {
        return Err(DemoError::ParserResourceLimit {
            resource: "replay_frames".to_owned(),
            limit: MAXIMUM_REPLAY_FRAMES,
            actual: entity_frames.len(),
        });
    }
    let mut player_records = 0;
    for frame in &entity_frames {
        player_records = checked_record_total(
            player_records,
            frame.players.len(),
            "replay_player_records",
            MAXIMUM_REPLAY_PLAYER_RECORDS,
        )?;
    }
    let mut frames = entity_frames
        .into_iter()
        .map(|frame| (frame.tick, frame))
        .collect::<BTreeMap<_, _>>();
    for event_frame in event_frames {
        if let Some(entity_frame) = frames.get_mut(&event_frame.tick) {
            entity_frame.projectiles.extend(event_frame.projectiles);
        } else {
            player_records = checked_record_total(
                player_records,
                event_frame.players.len(),
                "replay_player_records",
                MAXIMUM_REPLAY_PLAYER_RECORDS,
            )?;
            frames.insert(event_frame.tick, event_frame);
            if frames.len() > MAXIMUM_REPLAY_FRAMES {
                return Err(DemoError::ParserResourceLimit {
                    resource: "replay_frames".to_owned(),
                    limit: MAXIMUM_REPLAY_FRAMES,
                    actual: frames.len(),
                });
            }
        }
    }

    Ok(frames.into_values().collect())
}

fn checked_record_total(
    current: usize,
    additional: usize,
    resource: &'static str,
    limit: usize,
) -> DemoResult<usize> {
    let actual = current.saturating_add(additional);
    if actual > limit {
        Err(DemoError::ParserResourceLimit {
            resource: resource.to_owned(),
            limit,
            actual,
        })
    } else {
        Ok(actual)
    }
}

#[derive(Debug, Clone)]
struct EffectInterval {
    kind: String,
    position: [f64; 3],
    start_tick: u64,
    end_tick: u64,
    radius: Option<f64>,
    masks_vision: bool,
}

#[derive(Debug, Clone, Copy)]
enum EffectSignal {
    PersistentStart(&'static str),
    PersistentEnd(&'static str),
    Instant(&'static str, f64),
    Ignore,
    Exact,
}

fn apply_replay_state(frames: &mut [ReplayFrame], events: &[TimelineEvent]) -> DemoResult<()> {
    frames.sort_by_key(|frame| frame.tick);
    apply_projectile_lifecycles(frames, events)?;
    apply_bomb_state(frames, events);
    Ok(())
}

fn apply_projectile_lifecycles(
    frames: &mut [ReplayFrame],
    events: &[TimelineEvent],
) -> DemoResult<()> {
    let mut intervals = effect_intervals(events);
    intervals.sort_by_key(|effect| effect.start_tick);
    let mut next = 0;
    let mut active = Vec::<EffectInterval>::new();
    let mut effect_records = 0;
    for frame in frames {
        while next < intervals.len() && intervals[next].start_tick <= frame.tick {
            active.push(intervals[next].clone());
            next += 1;
        }
        active.retain(|effect| effect.end_tick >= frame.tick);
        if active.len() > MAXIMUM_REPLAY_EFFECTS_PER_FRAME {
            return Err(DemoError::ParserResourceLimit {
                resource: "replay_effects_per_frame".to_owned(),
                limit: MAXIMUM_REPLAY_EFFECTS_PER_FRAME,
                actual: active.len(),
            });
        }
        effect_records = checked_record_total(
            effect_records,
            active.len(),
            "replay_effect_records",
            MAXIMUM_REPLAY_EFFECT_RECORDS,
        )?;
        frame.projectiles = active
            .iter()
            .map(|effect| ReplayProjectile {
                kind: effect.kind.clone(),
                position: effect.position,
                active: true,
                radius: effect.radius,
                masks_vision: effect.masks_vision,
            })
            .collect();
        frame.projectiles.sort_by(|left, right| {
            left.kind
                .cmp(&right.kind)
                .then_with(|| left.position[0].total_cmp(&right.position[0]))
                .then_with(|| left.position[1].total_cmp(&right.position[1]))
        });
    }
    Ok(())
}

fn effect_intervals(events: &[TimelineEvent]) -> Vec<EffectInterval> {
    let tick_rate = evidence_tick_rate(events);
    let mut ordered = events.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|event| event.tick);

    let mut pending = HashMap::<(String, String), VecDeque<&TimelineEvent>>::new();
    let mut intervals = Vec::new();
    for event in ordered {
        if event.kind == EventKind::RoundStart {
            drain_pending_effects(&mut pending, &mut intervals);
            continue;
        }
        if event.kind != EventKind::Grenade {
            continue;
        }
        match effect_signal(event) {
            EffectSignal::PersistentStart(kind) => {
                if let Some(key) = lifecycle_key(event) {
                    pending
                        .entry((kind.to_owned(), key))
                        .or_default()
                        .push_back(event);
                }
            }
            EffectSignal::PersistentEnd(kind) => {
                let Some(key) = lifecycle_key(event) else {
                    continue;
                };
                let map_key = (kind.to_owned(), key);
                let Some(starts) = pending.get_mut(&map_key) else {
                    continue;
                };
                if let Some(start) = starts.pop_front()
                    && let Some(position) = valid_position(start)
                {
                    intervals.push(EffectInterval {
                        kind: kind.to_owned(),
                        position,
                        start_tick: start.tick,
                        end_tick: event.tick.saturating_sub(1).max(start.tick),
                        radius: effect_radius(start),
                        masks_vision: kind == "smoke",
                    });
                }
                if starts.is_empty() {
                    pending.remove(&map_key);
                }
            }
            EffectSignal::Instant(kind, seconds) => {
                if let Some(position) = valid_position(event) {
                    let window_ticks = tick_rate.map_or(0, |rate| {
                        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                        let ticks = (rate * seconds).round() as u64;
                        ticks
                    });
                    intervals.push(EffectInterval {
                        kind: kind.to_owned(),
                        position,
                        start_tick: event.tick,
                        end_tick: event.tick.saturating_add(window_ticks),
                        radius: effect_radius(event),
                        masks_vision: false,
                    });
                }
            }
            EffectSignal::Exact => {
                if let Some(position) = valid_position(event) {
                    intervals.push(EffectInterval {
                        kind: canonical_weapon_kind(event),
                        position,
                        start_tick: event.tick,
                        end_tick: event.tick,
                        radius: effect_radius(event),
                        masks_vision: false,
                    });
                }
            }
            EffectSignal::Ignore => {}
        }
    }

    drain_pending_effects(&mut pending, &mut intervals);
    intervals
}

fn drain_pending_effects(
    pending: &mut HashMap<(String, String), VecDeque<&TimelineEvent>>,
    intervals: &mut Vec<EffectInterval>,
) {
    for ((kind, _), starts) in pending.drain() {
        for start in starts {
            if let Some(position) = valid_position(start) {
                intervals.push(EffectInterval {
                    kind: format!("{kind}_event"),
                    position,
                    start_tick: start.tick,
                    end_tick: start.tick,
                    radius: effect_radius(start),
                    masks_vision: false,
                });
            }
        }
    }
}

fn effect_radius(event: &TimelineEvent) -> Option<f64> {
    detail_f64(
        event,
        &["radius", "effect_radius", "smoke_radius", "inferno_radius"],
    )
    .filter(|radius| (0.0..=4096.0).contains(radius))
}

fn effect_signal(event: &TimelineEvent) -> EffectSignal {
    if event.id.starts_with("smokegrenade_detonate-") {
        EffectSignal::PersistentStart("smoke")
    } else if event.id.starts_with("smokegrenade_expired-") {
        EffectSignal::PersistentEnd("smoke")
    } else if event.id.starts_with("inferno_startburn-") {
        EffectSignal::PersistentStart("inferno")
    } else if event.id.starts_with("inferno_expire-") {
        EffectSignal::PersistentEnd("inferno")
    } else if event.id.starts_with("decoy_started-") {
        EffectSignal::PersistentStart("decoy")
    } else if event.id.starts_with("decoy_detonate-") {
        EffectSignal::PersistentEnd("decoy")
    } else if event.id.starts_with("hegrenade_detonate-") {
        EffectSignal::Instant("he", 0.35)
    } else if event.id.starts_with("flashbang_detonate-") {
        EffectSignal::Instant("flash", 0.45)
    } else if event.id.starts_with("grenade_thrown-") || event.id.starts_with("player_blind-") {
        EffectSignal::Ignore
    } else {
        EffectSignal::Exact
    }
}

fn canonical_weapon_kind(event: &TimelineEvent) -> String {
    let weapon = event
        .weapon
        .as_deref()
        .unwrap_or("grenade")
        .to_ascii_lowercase();
    if weapon.contains("smoke") {
        "smoke_event".to_owned()
    } else if weapon.contains("molotov")
        || weapon.contains("incendiary")
        || weapon.contains("inferno")
        || weapon.contains("fire")
    {
        "inferno_event".to_owned()
    } else if weapon.contains("decoy") {
        "decoy_event".to_owned()
    } else if weapon.contains("flash") {
        "flash".to_owned()
    } else if weapon.contains("hegrenade") || weapon == "he" {
        "he".to_owned()
    } else {
        "grenade_event".to_owned()
    }
}

fn lifecycle_key(event: &TimelineEvent) -> Option<String> {
    const ID_KEYS: [&str; 6] = [
        "entityid",
        "entity_id",
        "projectileid",
        "projectile_id",
        "grenadeid",
        "grenade_id",
    ];
    for key in ID_KEYS {
        if let Some(value) = event.detail.get(key) {
            if let Some(value) = value.as_str().filter(|value| !value.is_empty()) {
                return Some(format!("id:{value}"));
            }
            if let Some(value) = value.as_i64() {
                return Some(format!("id:{value}"));
            }
            if let Some(value) = value.as_u64() {
                return Some(format!("id:{value}"));
            }
        }
    }
    valid_position(event).map(|position| {
        format!(
            "position:{:016x}:{:016x}:{:016x}",
            position[0].to_bits(),
            position[1].to_bits(),
            position[2].to_bits()
        )
    })
}

fn valid_position(event: &TimelineEvent) -> Option<[f64; 3]> {
    event
        .position
        .filter(|position| position.iter().all(|coordinate| coordinate.is_finite()))
}

fn evidence_tick_rate(events: &[TimelineEvent]) -> Option<f64> {
    let rates = events
        .iter()
        .filter(|event| event.tick > 0 && event.seconds.is_finite() && event.seconds > 0.0)
        .filter_map(|event| {
            u32::try_from(event.tick)
                .ok()
                .map(|tick| f64::from(tick) / event.seconds)
        })
        .filter(|rate| rate.is_finite() && (8.0..=1024.0).contains(rate))
        .collect::<Vec<_>>();
    let first = *rates.first()?;
    rates
        .iter()
        .all(|rate| ((rate - first) / first).abs() <= 0.005)
        .then_some(first)
}

fn apply_bomb_state(frames: &mut [ReplayFrame], events: &[TimelineEvent]) {
    let mut ordered = events.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|event| event.tick);
    let mut next = 0;
    let mut bomb: Option<ReplayBomb> = None;
    for frame in frames {
        while next < ordered.len() && ordered[next].tick <= frame.tick {
            let event = ordered[next];
            match event.kind {
                EventKind::RoundStart => bomb = None,
                EventKind::BombPlant => {
                    if let Some(position) = valid_position(event) {
                        bomb = Some(ReplayBomb {
                            position,
                            state: "planted".to_owned(),
                            carrier_id: None,
                        });
                    }
                }
                EventKind::BombDefuse | EventKind::BombExplode => {
                    if let Some(position) = bomb.as_ref().map(|value| value.position) {
                        bomb = Some(ReplayBomb {
                            position,
                            state: if event.kind == EventKind::BombDefuse {
                                "defused".to_owned()
                            } else {
                                "exploded".to_owned()
                            },
                            carrier_id: None,
                        });
                    }
                }
                _ => {}
            }
            next += 1;
        }
        frame.bomb.clone_from(&bomb);
    }
}

fn replay_player_from_event(event: &TimelineEvent, position: [f64; 3]) -> Option<ReplayPlayer> {
    let (id, health, alive, name_keys, team_keys, yaw_keys, armor_keys, position, weapon) =
        match event.kind {
            EventKind::Kill => (
                event.target.as_ref()?,
                0,
                false,
                &["target_name", "name"][..],
                &["target_team", "userteam", "victimteam", "teamnum", "team"][..],
                &["target_yaw", "yaw"][..],
                &["target_armor", "armor"][..],
                combat_target_position(event, position)?,
                String::new(),
            ),
            EventKind::Damage => {
                let health = detail_u32_option(event, &["health", "health_remaining"]);
                (
                    event.target.as_ref()?,
                    health.unwrap_or(0),
                    health.is_none_or(|value| value > 0),
                    &["target_name", "name"][..],
                    &["target_team", "userteam", "victimteam", "teamnum", "team"][..],
                    &["target_yaw", "yaw"][..],
                    &["target_armor", "armor"][..],
                    combat_target_position(event, position)?,
                    String::new(),
                )
            }
            EventKind::BombPlant | EventKind::BombDefuse => (
                event.actor.as_ref()?,
                detail_u32(event, &["health", "actor_health", "attacker_health"]),
                true,
                &["actor_name", "name"][..],
                &["actor_team", "attackerteam", "teamnum", "team"][..],
                &["actor_yaw", "yaw"][..],
                &["actor_armor", "armor"][..],
                position,
                event.weapon.clone().unwrap_or_default(),
            ),
            EventKind::Purchase => (
                event.actor.as_ref()?,
                detail_u32(event, &["health", "actor_health", "attacker_health"]),
                true,
                &["actor_name", "name"][..],
                &["actor_team", "attackerteam", "teamnum", "team"][..],
                &["actor_yaw", "yaw"][..],
                &["actor_armor", "armor"][..],
                position,
                String::new(),
            ),
            EventKind::RoundStart
            | EventKind::RoundEnd
            | EventKind::BombExplode
            | EventKind::Grenade => return None,
        };
    Some(ReplayPlayer {
        id: id.clone(),
        name: detail_string(event, name_keys).unwrap_or_else(|| id.clone()),
        team: detail_team(event, team_keys).unwrap_or_default(),
        position,
        yaw: detail_f64(event, yaw_keys).unwrap_or(0.0),
        health,
        armor: detail_u32(event, armor_keys),
        alive,
        weapon,
        input: None,
    })
}

fn detail_position(event: &TimelineEvent, role: &str) -> Option<[f64; 3]> {
    let position = [
        detail_f64(event, &[&format!("{role}_X")])?,
        detail_f64(event, &[&format!("{role}_Y")])?,
        detail_f64(event, &[&format!("{role}_Z")])?,
    ];
    position
        .iter()
        .all(|coordinate| coordinate.is_finite())
        .then_some(position)
}

fn combat_target_position(event: &TimelineEvent, generic: [f64; 3]) -> Option<[f64; 3]> {
    detail_position(event, "user").or_else(|| {
        let has_attacker_position = ["attacker_X", "attacker_Y", "attacker_Z"]
            .into_iter()
            .any(|key| event.detail.get(key).is_some());
        (!has_attacker_position).then_some(generic)
    })
}

/// Builds an evidence-based heat map from event coordinates only.
///
/// # Errors
///
/// Returns an unavailable error when no event contains world coordinates.
pub fn heatmap_from_events(events: &[TimelineEvent]) -> DemoResult<Vec<HeatPoint>> {
    let points = heat_points_from_events(events, None)?;
    require_heat_points(points, events)
}

/// Builds round-scoped heat evidence while retaining the authoritative round
/// number carried by the stored analysis.
///
/// # Errors
///
/// Returns an unavailable error when no round contains trustworthy world
/// coordinates, or when embedded entity evidence is invalid.
pub fn heatmap_from_rounds(rounds: &[RoundSummary]) -> DemoResult<Vec<HeatPoint>> {
    let mut points = Vec::new();
    for round in rounds {
        points.extend(heat_points_from_events(&round.events, Some(round.number))?);
    }
    let events = rounds
        .iter()
        .flat_map(|round| round.events.iter())
        .cloned()
        .collect::<Vec<_>>();
    require_heat_points(points, &events)
}

fn heat_points_from_events(
    events: &[TimelineEvent],
    round_number: Option<u32>,
) -> DemoResult<Vec<HeatPoint>> {
    let entity_frames =
        embedded_entity_replay(events).map_err(|reason| DemoError::Unavailable {
            capability: "heat map",
            reason,
        })?;
    let mut points = movement_heat_points(&entity_frames, round_number);
    let mut ordered_events = events.iter().collect::<Vec<_>>();
    ordered_events.sort_by_key(|event| event.tick);
    let mut round_roster = HashMap::new();
    for event in ordered_events {
        if event.kind == EventKind::RoundStart {
            round_roster = event_round_roster(event).unwrap_or_default();
        }
        points.extend(event_heat_points(event, round_number, &round_roster));
    }
    Ok(points)
}

fn require_heat_points(
    points: Vec<HeatPoint>,
    events: &[TimelineEvent],
) -> DemoResult<Vec<HeatPoint>> {
    if points.is_empty() {
        let reason = entity_replay_unavailable_reason(events).map_or_else(
            || "the selected events contain no world coordinates".to_owned(),
            |entity_reason| {
                format!(
                    "entity snapshots are unavailable ({entity_reason}); the selected events contain no world coordinates"
                )
            },
        );
        Err(DemoError::Unavailable {
            capability: "heat map",
            reason,
        })
    } else {
        Ok(points)
    }
}

fn event_heat_points(
    event: &TimelineEvent,
    round_number: Option<u32>,
    round_roster: &HashMap<String, String>,
) -> Vec<HeatPoint> {
    if event.kind == EventKind::Kill {
        let mut points = Vec::with_capacity(2);
        if let (Some(player_id), Some([x, y, z])) =
            (event.actor.as_deref(), detail_position(event, "attacker"))
        {
            points.push(HeatPoint {
                id: heat_point_id(round_number, event, "kill", Some(player_id)),
                round: round_number,
                tick: event.tick,
                x,
                y,
                weight: 1.0,
                floor: floor_index(z),
                kind: "kill".to_owned(),
                player_id: Some(player_id.to_owned()),
                side: detail_team(
                    event,
                    &[
                        "actor_team",
                        "attacker_team",
                        "attackerteam",
                        "attacker_team_num",
                    ],
                )
                .or_else(|| roster_team(round_roster, event.actor.as_deref())),
                event_kind: Some("kill".to_owned()),
            });
        }
        if let (Some(player_id), Some([x, y, z])) = (
            event.target.as_deref(),
            event
                .position
                .and_then(|generic| combat_target_position(event, generic)),
        ) {
            points.push(HeatPoint {
                id: heat_point_id(round_number, event, "death", Some(player_id)),
                round: round_number,
                tick: event.tick,
                x,
                y,
                weight: 1.0,
                floor: floor_index(z),
                kind: "death".to_owned(),
                player_id: Some(player_id.to_owned()),
                side: detail_team(
                    event,
                    &[
                        "target_team",
                        "victim_team",
                        "user_team",
                        "userteam",
                        "victimteam",
                        "user_team_num",
                        "victim_team_num",
                    ],
                )
                .or_else(|| roster_team(round_roster, event.target.as_deref())),
                event_kind: Some("death".to_owned()),
            });
        }
        return points;
    }

    let Some(generic) = event.position else {
        return Vec::new();
    };
    let Some([x, y, z]) = (match event.kind {
        EventKind::Damage => combat_target_position(event, generic),
        _ => Some(generic),
    }) else {
        return Vec::new();
    };
    let weight = match event.kind {
        EventKind::Damage => 0.35,
        EventKind::BombPlant | EventKind::BombDefuse | EventKind::BombExplode => 0.8,
        EventKind::Grenade => 0.45,
        _ => 0.15,
    };
    let player_id = match event.kind {
        EventKind::Kill | EventKind::Damage => event.target.clone(),
        _ => event.actor.clone(),
    };
    if event.kind == EventKind::Damage && player_id.is_none() {
        return Vec::new();
    }
    let event_kind = format!("{:?}", event.kind).to_ascii_lowercase();
    vec![HeatPoint {
        id: heat_point_id(round_number, event, &event_kind, player_id.as_deref()),
        round: round_number,
        tick: event.tick,
        x,
        y,
        weight,
        floor: floor_index(z),
        kind: event_kind.clone(),
        player_id,
        side: match event.kind {
            EventKind::Kill | EventKind::Damage => detail_team(
                event,
                &[
                    "target_team",
                    "victim_team",
                    "user_team",
                    "userteam",
                    "victimteam",
                    "user_team_num",
                    "victim_team_num",
                    "team",
                ],
            )
            .or_else(|| roster_team(round_roster, event.target.as_deref())),
            _ => detail_team(
                event,
                &[
                    "actor_team",
                    "attacker_team",
                    "attackerteam",
                    "attacker_team_num",
                    "user_team",
                    "userteam",
                    "user_team_num",
                    "team",
                ],
            )
            .or_else(|| roster_team(round_roster, event.actor.as_deref())),
        },
        event_kind: Some(event_kind),
    }]
}

fn heat_point_id(
    round_number: Option<u32>,
    event: &TimelineEvent,
    role: &str,
    player_id: Option<&str>,
) -> String {
    let round = round_number.map_or_else(|| "unknown".to_owned(), |value| value.to_string());
    player_id.map_or_else(
        || format!("round:{round}/event:{}/{role}", event.id),
        |player_id| format!("round:{round}/event:{}/{role}:{player_id}", event.id),
    )
}

fn event_round_roster(event: &TimelineEvent) -> Option<HashMap<String, String>> {
    event
        .detail
        .get("_round_roster")?
        .as_object()?
        .iter()
        .filter_map(|(player, side)| {
            normalized_team(side.as_str()?).map(|side| (player.clone(), side.to_owned()))
        })
        .collect::<HashMap<_, _>>()
        .into()
}

fn roster_team(round_roster: &HashMap<String, String>, player_id: Option<&str>) -> Option<String> {
    player_id.and_then(|player_id| round_roster.get(player_id).cloned())
}

fn movement_heat_points(frames: &[ReplayFrame], round_number: Option<u32>) -> Vec<HeatPoint> {
    let mut last_positions = HashMap::<String, [f64; 3]>::new();
    let mut points = Vec::new();
    for frame in frames {
        for player in &frame.players {
            if !player.alive {
                last_positions.remove(&player.id);
                continue;
            }
            let moved = last_positions.get(&player.id).is_none_or(|previous| {
                previous
                    .iter()
                    .zip(player.position)
                    .map(|(previous, current)| (current - previous).powi(2))
                    .sum::<f64>()
                    > 0.25
            });
            last_positions.insert(player.id.clone(), player.position);
            if moved {
                let round =
                    round_number.map_or_else(|| "unknown".to_owned(), |value| value.to_string());
                points.push(HeatPoint {
                    id: format!("round:{round}/frame:{}/movement:{}", frame.tick, player.id),
                    round: round_number,
                    tick: frame.tick,
                    x: player.position[0],
                    y: player.position[1],
                    weight: 0.2,
                    floor: floor_index(player.position[2]),
                    kind: "movement".to_owned(),
                    player_id: Some(player.id.clone()),
                    side: normalized_team(&player.team).map(str::to_owned),
                    event_kind: Some("movement".to_owned()),
                });
            }
        }
    }
    points
}

#[allow(clippy::cast_possible_truncation)]
fn floor_index(z: f64) -> i32 {
    (z / 256.0)
        .floor()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn detail_u32(event: &TimelineEvent, keys: &[&str]) -> u32 {
    detail_u32_option(event, keys).unwrap_or(0)
}

fn detail_u32_option(event: &TimelineEvent, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .find_map(|key| event.detail.get(*key))
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn detail_f64(event: &TimelineEvent, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| event.detail.get(*key))
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
}

fn detail_string(event: &TimelineEvent, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| event.detail.get(*key))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn detail_team(event: &TimelineEvent, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = event.detail.get(*key)?;
        let raw = value
            .as_str()
            .map(str::to_owned)
            .or_else(|| value.as_i64().map(|number| number.to_string()))?;
        normalized_team(&raw).map(str::to_owned)
    })
}

fn normalized_team(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_uppercase().as_str() {
        "2" | "T" | "TERRORIST" | "TERRORISTS" => Some("T"),
        "3" | "CT" | "COUNTER-TERRORIST" | "COUNTER-TERRORISTS" | "COUNTERTERRORIST" => Some("CT"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use vibe_cs_domain::{ReplayPlayer, RoundSummary, TimelineEvent};

    use super::*;
    use crate::entity_replay::attach_entity_replay;

    fn event(kind: EventKind, tick: u64, position: Option<[f64; 3]>) -> TimelineEvent {
        TimelineEvent {
            id: format!("event-{tick}"),
            tick,
            seconds: f64::from(u32::try_from(tick).unwrap_or(u32::MAX)) / 64.0,
            kind,
            actor: Some("attacker".to_owned()),
            target: Some("victim".to_owned()),
            weapon: Some("ak47".to_owned()),
            headshot: false,
            penetrated: false,
            position,
            detail: json!({"health": 63, "armor": 20}),
        }
    }

    fn named_grenade(name: &str, tick: u64, position: [f64; 3]) -> TimelineEvent {
        let mut event = event(EventKind::Grenade, tick, Some(position));
        event.id = format!("{name}-{tick}-1");
        event.weapon = None;
        event
    }

    #[test]
    fn heatmap_requires_real_coordinates() {
        let mut event = event(EventKind::Kill, 10, None);
        event.detail = Value::Null;
        let error = heatmap_from_events(&[event]).unwrap_err();
        assert!(matches!(
            error,
            DemoError::Unavailable {
                capability: "heat map",
                ref reason,
            } if reason == "the selected events contain no world coordinates"
        ));
    }

    #[test]
    fn combat_heatmap_uses_the_target_position() {
        let mut damage = event(EventKind::Damage, 10, Some([100.0, 200.0, 300.0]));
        damage.detail = json!({
            "user_X": 1.0,
            "user_Y": 2.0,
            "user_Z": 3.0,
            "attacker_X": 100.0,
            "attacker_Y": 200.0,
            "attacker_Z": 300.0
        });

        let points = heatmap_from_events(&[damage]).expect("target heat point");

        assert_eq!(points[0].player_id.as_deref(), Some("victim"));
        assert!((points[0].x - 1.0).abs() < f64::EPSILON);
        assert!((points[0].y - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn kill_heatmap_exposes_distinct_attacker_kill_and_victim_death_evidence() {
        let mut kill = event(EventKind::Kill, 10, Some([100.0, 200.0, 300.0]));
        kill.detail = json!({
            "user_X": 1.0,
            "user_Y": 2.0,
            "user_Z": 3.0,
            "user_team": "CT",
            "attacker_X": 100.0,
            "attacker_Y": 200.0,
            "attacker_Z": 300.0,
            "attacker_team": "T"
        });

        let points = heatmap_from_events(&[kill]).expect("kill and death heat points");

        assert_eq!(points.len(), 2);
        assert!(points.iter().any(|point| {
            point.event_kind.as_deref() == Some("kill")
                && point.player_id.as_deref() == Some("attacker")
                && point.side.as_deref() == Some("T")
                && (point.x - 100.0).abs() < f64::EPSILON
                && (point.y - 200.0).abs() < f64::EPSILON
        }));
        assert!(points.iter().any(|point| {
            point.event_kind.as_deref() == Some("death")
                && point.player_id.as_deref() == Some("victim")
                && point.side.as_deref() == Some("CT")
                && (point.x - 1.0).abs() < f64::EPSILON
                && (point.y - 2.0).abs() < f64::EPSILON
        }));
    }

    #[test]
    fn round_heatmap_exposes_stable_identity_round_tick_player_and_side() {
        let mut kill = event(EventKind::Kill, 640, Some([100.0, 200.0, 300.0]));
        kill.detail = json!({
            "user_X": 1.0,
            "user_Y": 2.0,
            "user_Z": 3.0,
            "user_team": "CT",
            "attacker_X": 100.0,
            "attacker_Y": 200.0,
            "attacker_Z": 300.0,
            "attacker_team": "T"
        });
        let rounds = vec![RoundSummary {
            number: 7,
            start_tick: 600,
            end_tick: 700,
            winner: "T".to_owned(),
            reason: String::new(),
            team_a_score: 4,
            team_b_score: 3,
            events: vec![kill],
        }];

        let points = heatmap_from_rounds(&rounds).expect("round-scoped heat evidence");

        assert_eq!(points.len(), 2);
        let kill = points
            .iter()
            .find(|point| point.kind == "kill")
            .expect("killer evidence");
        assert_eq!(kill.id, "round:7/event:event-640/kill:attacker");
        assert_eq!(kill.round, Some(7));
        assert_eq!(kill.tick, 640);
        assert_eq!(kill.player_id.as_deref(), Some("attacker"));
        assert_eq!(kill.side.as_deref(), Some("T"));
        let death = points
            .iter()
            .find(|point| point.kind == "death")
            .expect("victim evidence");
        assert_eq!(death.id, "round:7/event:event-640/death:victim");
        assert_eq!(death.round, Some(7));
        assert_eq!(death.tick, 640);
        assert_eq!(death.player_id.as_deref(), Some("victim"));
        assert_eq!(death.side.as_deref(), Some("CT"));
    }

    #[test]
    fn heatmap_side_evidence_accepts_the_canonical_parser_team_fields() {
        let mut kill = event(EventKind::Kill, 640, Some([10.0, 20.0, 30.0]));
        kill.detail = json!({
            "user_X": 10.0,
            "user_Y": 20.0,
            "user_Z": 30.0,
            "userteam": 3,
            "attacker_X": 100.0,
            "attacker_Y": 200.0,
            "attacker_Z": 300.0,
            "attackerteam": 2
        });

        let points = heatmap_from_events(&[kill]).expect("side-scoped heat evidence");

        assert_eq!(
            points
                .iter()
                .find(|point| point.kind == "kill")
                .and_then(|point| point.side.as_deref()),
            Some("T")
        );
        assert_eq!(
            points
                .iter()
                .find(|point| point.kind == "death")
                .and_then(|point| point.side.as_deref()),
            Some("CT")
        );
    }

    #[test]
    fn heatmap_uses_each_rounds_real_t_ct_roster_when_event_team_fields_are_absent() {
        let mut round_start = event(EventKind::RoundStart, 1, None);
        round_start.actor = None;
        round_start.target = None;
        round_start.detail = json!({
            "_round_roster": {
                "attacker": "T",
                "victim": "CT"
            }
        });
        let mut kill = event(EventKind::Kill, 10, Some([100.0, 200.0, 300.0]));
        kill.detail = json!({
            "user_X": 1.0,
            "user_Y": 2.0,
            "user_Z": 3.0,
            "attacker_X": 100.0,
            "attacker_Y": 200.0,
            "attacker_Z": 300.0
        });

        let points = heatmap_from_events(&[round_start, kill]).expect("roster-bound heat points");

        assert_eq!(
            points
                .iter()
                .find(|point| point.event_kind.as_deref() == Some("kill"))
                .and_then(|point| point.side.as_deref()),
            Some("T")
        );
        assert_eq!(
            points
                .iter()
                .find(|point| point.event_kind.as_deref() == Some("death"))
                .and_then(|point| point.side.as_deref()),
            Some("CT")
        );
    }

    #[test]
    fn heatmap_side_filter_evidence_follows_the_round_roster_across_a_side_swap() {
        let round = |number: u32, attacker_side: &str, victim_side: &str| {
            let mut round_start = event(EventKind::RoundStart, u64::from(number) * 100, None);
            round_start.actor = None;
            round_start.target = None;
            round_start.detail = json!({
                "_round_roster": {
                    "attacker": attacker_side,
                    "victim": victim_side
                }
            });
            let mut kill = event(
                EventKind::Kill,
                u64::from(number) * 100 + 10,
                Some([1.0, 2.0, 3.0]),
            );
            kill.detail = json!({
                "user_X": 1.0,
                "user_Y": 2.0,
                "user_Z": 3.0,
                "attacker_X": 100.0,
                "attacker_Y": 200.0,
                "attacker_Z": 300.0
            });
            RoundSummary {
                number,
                start_tick: u64::from(number) * 100,
                end_tick: u64::from(number) * 100 + 99,
                winner: attacker_side.to_owned(),
                reason: String::new(),
                team_a_score: number,
                team_b_score: 0,
                events: vec![round_start, kill],
            }
        };

        let points = heatmap_from_rounds(&[round(1, "T", "CT"), round(2, "CT", "T")])
            .expect("side-swap heat evidence");
        let attacker_sides = points
            .iter()
            .filter(|point| point.kind == "kill")
            .map(|point| (point.round, point.side.as_deref()))
            .collect::<Vec<_>>();

        assert_eq!(
            attacker_sides,
            vec![(Some(1), Some("T")), (Some(2), Some("CT"))]
        );
        assert!(points.iter().all(|point| {
            point
                .side
                .as_deref()
                .is_none_or(|side| matches!(side, "T" | "CT"))
        }));
    }

    #[test]
    fn sparse_replay_groups_positions_by_tick_and_carries_state() {
        let frames = replay_frames_from_events(&[
            event(EventKind::Damage, 10, Some([1.0, 2.0, 3.0])),
            event(EventKind::Grenade, 20, Some([4.0, 5.0, 6.0])),
        ])
        .unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].players[0].id, "victim");
        assert_eq!(frames[0].players[0].health, 63);
        assert_eq!(frames[1].players.len(), 1);
        assert_eq!(frames[1].projectiles.len(), 1);
    }

    #[test]
    fn sparse_combat_replay_uses_the_target_position_without_attacker_weapon() {
        let mut damage = event(EventKind::Damage, 10, Some([100.0, 200.0, 300.0]));
        damage.detail = json!({
            "user_X": 1.0,
            "user_Y": 2.0,
            "user_Z": 3.0,
            "attacker_X": 100.0,
            "attacker_Y": 200.0,
            "attacker_Z": 300.0,
            "health": 63,
            "armor": 20
        });

        let frames = replay_frames_from_events(&[damage]).expect("target evidence frame");
        let victim = frames[0].players.first().expect("victim marker");

        assert_eq!(victim.id, "victim");
        assert!(
            victim
                .position
                .into_iter()
                .zip([1.0, 2.0, 3.0])
                .all(|(actual, expected)| (actual - expected).abs() < f64::EPSILON)
        );
        assert!(victim.weapon.is_empty());
    }

    #[test]
    fn purchase_item_evidence_does_not_claim_the_players_equipped_weapon() {
        let mut purchase = event(EventKind::Purchase, 10, Some([1.0, 2.0, 3.0]));
        purchase.target = None;
        purchase.weapon = Some("weapon_ak47".to_owned());

        let frames = replay_frames_from_events(&[purchase]).expect("purchase position evidence");

        assert_eq!(frames[0].players[0].id, "attacker");
        assert!(frames[0].players[0].weapon.is_empty());
    }

    #[test]
    fn embedded_entity_frames_drive_replay_and_movement_heatmap() {
        let mut round_start = event(EventKind::RoundStart, 10, None);
        round_start.actor = None;
        round_start.target = None;
        let mut rounds = vec![RoundSummary {
            number: 1,
            start_tick: 10,
            end_tick: 20,
            winner: "T".to_owned(),
            reason: String::new(),
            team_a_score: 1,
            team_b_score: 0,
            events: vec![round_start],
        }];
        attach_entity_replay(
            &mut rounds,
            &[ReplayFrame {
                tick: 12,
                players: vec![ReplayPlayer {
                    id: "76561198000000001".to_owned(),
                    name: "Player".to_owned(),
                    team: "T".to_owned(),
                    position: [128.0, 256.0, 64.0],
                    yaw: 45.0,
                    health: 100,
                    armor: 50,
                    alive: true,
                    weapon: "CWeaponAK47".to_owned(),
                    input: None,
                }],
                projectiles: Vec::new(),
                bomb: None,
            }],
            None,
        );

        let frames = replay_frames_from_events(&rounds[0].events).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].players[0].id, "76561198000000001");
        assert_eq!(frames[0].players[0].health, 100);
        let mut repeated_frames = frames.clone();
        let mut repeated = frames[0].clone();
        repeated.tick = 13;
        repeated_frames.push(repeated);
        assert_eq!(movement_heat_points(&repeated_frames, Some(1)).len(), 1);
        let heatmap = heatmap_from_events(&rounds[0].events).unwrap();
        assert_eq!(heatmap.len(), 1);
        assert_eq!(heatmap[0].kind, "movement");
        assert!((heatmap[0].x - 128.0).abs() < f64::EPSILON);
    }

    #[test]
    fn grenade_coordinates_do_not_relocate_the_thrower() {
        let frames =
            replay_frames_from_events(&[event(EventKind::Grenade, 20, Some([4.0, 5.0, 6.0]))])
                .unwrap();

        assert!(frames[0].players.is_empty());
        assert!(
            frames[0].projectiles[0]
                .position
                .into_iter()
                .zip([4.0, 5.0, 6.0])
                .all(|(actual, expected)| (actual - expected).abs() < f64::EPSILON)
        );
    }

    #[test]
    fn explicit_effect_lifecycles_span_only_evidenced_frames() {
        let position = [40.0, 50.0, 6.0];
        let frames = replay_frames_from_events(&[
            named_grenade("smokegrenade_detonate", 10, position),
            event(EventKind::Damage, 15, Some([1.0, 2.0, 3.0])),
            named_grenade("smokegrenade_expired", 20, position),
            event(EventKind::Damage, 25, Some([2.0, 3.0, 4.0])),
        ])
        .unwrap();

        assert_eq!(frames[0].projectiles[0].kind, "smoke");
        assert_eq!(frames[1].projectiles[0].kind, "smoke");
        assert!(frames[2].projectiles.is_empty());
        assert!(frames[3].projectiles.is_empty());
    }

    #[test]
    fn unmatched_persistent_effect_is_event_only() {
        let frames =
            replay_frames_from_events(&[named_grenade("inferno_startburn", 10, [4.0, 5.0, 6.0])])
                .unwrap();

        assert_eq!(frames[0].projectiles[0].kind, "inferno_event");
        assert_eq!(frames[0].tick, 10);
    }

    #[test]
    fn persistent_effects_never_pair_across_round_boundaries() {
        let position = [4.0, 5.0, 6.0];
        let mut start = named_grenade("smokegrenade_detonate", 10, position);
        start.detail = json!({"entityid": 319});
        let mut next_round = event(EventKind::RoundStart, 20, None);
        next_round.actor = None;
        next_round.target = None;
        let mut expired = named_grenade("smokegrenade_expired", 30, position);
        expired.detail = json!({"entityid": 319});

        let frames = replay_frames_from_events(&[
            start,
            next_round,
            expired,
            event(EventKind::Damage, 40, Some([1.0, 2.0, 3.0])),
        ])
        .expect("bounded sparse replay");

        assert_eq!(frames[0].tick, 10);
        assert_eq!(frames[0].projectiles[0].kind, "smoke_event");
        assert!(
            frames
                .iter()
                .skip(1)
                .all(|frame| frame.projectiles.is_empty())
        );
    }

    #[test]
    fn instantaneous_effect_uses_evidenced_tick_rate_window() {
        let frames = replay_frames_from_events(&[
            named_grenade("flashbang_detonate", 64, [4.0, 5.0, 6.0]),
            event(EventKind::Damage, 80, Some([1.0, 2.0, 3.0])),
            event(EventKind::Damage, 96, Some([2.0, 3.0, 4.0])),
        ])
        .unwrap();

        assert_eq!(frames[0].projectiles[0].kind, "flash");
        assert_eq!(frames[1].projectiles[0].kind, "flash");
        assert!(frames[2].projectiles.is_empty());
    }

    #[test]
    fn bomb_state_reuses_planted_position_and_resets_next_round() {
        let planted = [12.0, 24.0, 3.0];
        let mut round_start = event(EventKind::RoundStart, 30, None);
        round_start.actor = None;
        round_start.target = None;
        let frames = replay_frames_from_events(&[
            event(EventKind::BombPlant, 10, Some(planted)),
            event(EventKind::BombDefuse, 20, None),
            round_start,
            named_grenade("hegrenade_detonate", 35, [2.0, 3.0, 4.0]),
        ])
        .unwrap();

        assert_eq!(frames[0].bomb.as_ref().unwrap().state, "planted");
        assert_eq!(frames[1].bomb.as_ref().unwrap().state, "defused");
        assert!(
            frames[1]
                .bomb
                .as_ref()
                .unwrap()
                .position
                .into_iter()
                .zip(planted)
                .all(|(actual, expected)| (actual - expected).abs() < f64::EPSILON)
        );
        assert!(frames.last().unwrap().bomb.is_none());
        assert!(frames.last().unwrap().players.is_empty());
    }

    #[test]
    fn bomb_completion_without_a_planted_position_does_not_invent_one() {
        let mut exploded = event(EventKind::BombExplode, 10, Some([40.0, 50.0, 6.0]));
        exploded.actor = None;
        exploded.target = None;
        exploded.detail = json!({"user_X": 40.0, "user_Y": 50.0, "user_Z": 6.0});

        let frames = replay_frames_from_events(&[
            exploded,
            named_grenade("hegrenade_detonate", 20, [2.0, 3.0, 4.0]),
        ])
        .expect("effect evidence remains replayable");

        assert!(frames.iter().all(|frame| frame.bomb.is_none()));
    }

    #[test]
    fn sparse_replay_is_unavailable_without_positions() {
        let error = replay_frames_from_events(&[event(EventKind::Damage, 10, None)]).unwrap_err();
        assert!(matches!(
            error,
            DemoError::Unavailable {
                capability: "2D replay",
                ref reason,
            } if reason == "the selected events contain no world coordinates"
        ));
    }

    #[test]
    fn sparse_replay_has_an_independent_frame_budget() {
        let events = (1..=20_001)
            .map(|tick| event(EventKind::Damage, tick, Some([1.0, 2.0, 3.0])))
            .collect::<Vec<_>>();

        let error = replay_artifact_from_events(&events, 64.0).unwrap_err();

        assert!(matches!(
            error,
            DemoError::ParserResourceLimit {
                ref resource,
                limit: 20_000,
                actual: 20_001,
            } if resource == "sparse_replay_frames"
        ));
    }

    #[test]
    fn hybrid_replay_propagates_sparse_resource_failures() {
        let player = ReplayPlayer {
            id: "76561198000000001".to_owned(),
            name: "Player".to_owned(),
            team: "T".to_owned(),
            position: [128.0, 256.0, 64.0],
            yaw: 45.0,
            health: 100,
            armor: 50,
            alive: true,
            weapon: "CWeaponAK47".to_owned(),
            input: None,
        };
        let mut round_start = event(EventKind::RoundStart, 1, None);
        round_start.actor = None;
        round_start.target = None;
        let mut rounds = vec![RoundSummary {
            number: 1,
            start_tick: 1,
            end_tick: 20_001,
            winner: "T".to_owned(),
            reason: String::new(),
            team_a_score: 1,
            team_b_score: 0,
            events: vec![round_start],
        }];
        attach_entity_replay(
            &mut rounds,
            &[ReplayFrame {
                tick: 1,
                players: vec![player],
                projectiles: Vec::new(),
                bomb: None,
            }],
            None,
        );
        let mut events = rounds.pop().expect("round").events;
        events
            .extend((1..=20_001).map(|tick| event(EventKind::Damage, tick, Some([1.0, 2.0, 3.0]))));

        let error = replay_artifact_from_events(&events, 64.0).unwrap_err();

        assert!(matches!(
            error,
            DemoError::ParserResourceLimit {
                ref resource,
                limit: 20_000,
                actual: 20_001,
            } if resource == "sparse_replay_frames"
        ));
    }

    #[test]
    fn merged_entity_and_event_replay_has_a_total_frame_budget() {
        let player = ReplayPlayer {
            id: "76561198000000001".to_owned(),
            name: "Player".to_owned(),
            team: "T".to_owned(),
            position: [128.0, 256.0, 64.0],
            yaw: 45.0,
            health: 100,
            armor: 50,
            alive: true,
            weapon: "CWeaponAK47".to_owned(),
            input: None,
        };
        let entity_frames = (1..=20_000)
            .map(|tick| ReplayFrame {
                tick,
                players: vec![player.clone()],
                projectiles: Vec::new(),
                bomb: None,
            })
            .collect::<Vec<_>>();
        let mut round_start = event(EventKind::RoundStart, 1, None);
        round_start.actor = None;
        round_start.target = None;
        let mut rounds = vec![RoundSummary {
            number: 1,
            start_tick: 1,
            end_tick: 20_001,
            winner: "T".to_owned(),
            reason: String::new(),
            team_a_score: 1,
            team_b_score: 0,
            events: vec![round_start],
        }];
        attach_entity_replay(&mut rounds, &entity_frames, None);
        let mut events = rounds.pop().expect("round").events;
        events.push(event(EventKind::Damage, 20_001, Some([1.0, 2.0, 3.0])));

        let error = replay_artifact_from_events(&events, 64.0).unwrap_err();

        assert!(matches!(
            error,
            DemoError::ParserResourceLimit {
                ref resource,
                limit: 20_000,
                actual: 20_001,
            } if resource == "replay_frames"
        ));
    }

    #[test]
    fn sparse_replay_has_a_players_per_frame_budget() {
        let events = (0..65)
            .map(|index| {
                let mut event = event(EventKind::Damage, 64, Some([1.0, 2.0, 3.0]));
                event.target = Some(format!("player-{index}"));
                event
            })
            .collect::<Vec<_>>();

        let error = replay_artifact_from_events(&events, 64.0).unwrap_err();

        assert!(matches!(
            error,
            DemoError::ParserResourceLimit {
                ref resource,
                limit: 64,
                actual: 65,
            } if resource == "replay_players_per_frame"
        ));
    }

    #[test]
    fn sparse_replay_bounds_sixty_four_player_records_across_twenty_thousand_frames() {
        let mut events = (0..64)
            .map(|index| {
                let mut event = event(EventKind::Damage, 1, Some([1.0, 2.0, 3.0]));
                event.id = format!("initial-player-{index}");
                event.target = Some(format!("player-{index}"));
                event
            })
            .collect::<Vec<_>>();
        events.extend((2..=20_000).map(|tick| {
            let mut event = event(EventKind::Damage, tick, Some([1.0, 2.0, 3.0]));
            event.target = Some("player-0".to_owned());
            event
        }));

        let result = replay_artifact_from_events(&events, 64.0);

        assert!(matches!(
            result,
            Err(DemoError::ParserResourceLimit {
                ref resource,
                limit: 200_000,
                actual: 200_064,
            }) if resource == "replay_player_records"
        ));
    }

    #[test]
    fn sparse_replay_has_an_effects_per_frame_budget() {
        let events = (0..513)
            .map(|index| named_grenade("hegrenade_detonate", 64, [f64::from(index), 2.0, 3.0]))
            .collect::<Vec<_>>();

        let error = replay_artifact_from_events(&events, 64.0).unwrap_err();

        assert!(matches!(
            error,
            DemoError::ParserResourceLimit {
                ref resource,
                limit: 512,
                actual: 513,
            } if resource == "replay_effects_per_frame"
        ));
    }

    #[test]
    fn sparse_replay_bounds_five_hundred_twelve_effect_records_across_twenty_thousand_frames() {
        let mut events = Vec::new();
        for index in 0..512 {
            let position = [f64::from(index), 2.0, 3.0];
            let mut started = named_grenade("smokegrenade_detonate", 1, position);
            started.detail = json!({"entityid": index});
            events.push(started);
            let mut expired = named_grenade("smokegrenade_expired", 20_000, position);
            expired.detail = json!({"entityid": index});
            events.push(expired);
        }
        events
            .extend((1..20_000).map(|tick| event(EventKind::Damage, tick, Some([1.0, 2.0, 3.0]))));

        let result = replay_artifact_from_events(&events, 64.0);

        assert!(matches!(
            result,
            Err(DemoError::ParserResourceLimit {
                ref resource,
                limit: 100_000,
                actual: 100_352,
            }) if resource == "replay_effect_records"
        ));
    }

    #[test]
    fn sparse_replay_has_an_independent_source_event_budget() {
        let events = (0..100_001)
            .map(|tick| event(EventKind::Damage, tick, None))
            .collect::<Vec<_>>();

        let error = replay_artifact_from_events(&events, 64.0).unwrap_err();

        assert!(matches!(
            error,
            DemoError::ParserResourceLimit {
                ref resource,
                limit: 100_000,
                actual: 100_001,
            } if resource == "replay_source_events"
        ));
    }
}
