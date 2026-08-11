use std::collections::{BTreeMap, HashMap, VecDeque};

use vibe_cs_domain::{
    EventKind, HeatPoint, ReplayBomb, ReplayFrame, ReplayPlayer, ReplayProjectile, TimelineEvent,
};

use crate::entity_replay::{embedded_entity_replay, entity_replay_unavailable_reason};
use crate::{DemoError, DemoResult};

/// Builds deterministic sparse frames from events that carry world positions.
/// A kill/damage position is assigned to its target; other positioned player
/// events are assigned to their actor. Unknown attributes remain conservative
/// (`0`/empty) rather than being fabricated.
///
/// # Errors
///
/// Returns an unavailable error when no positioned event can form a frame.
pub fn replay_frames_from_events(events: &[TimelineEvent]) -> DemoResult<Vec<ReplayFrame>> {
    let entity_frames =
        embedded_entity_replay(events).map_err(|reason| DemoError::Unavailable {
            capability: "2D replay",
            reason,
        })?;
    if !entity_frames.is_empty() {
        let event_frames = sparse_replay_frames_from_events(events).unwrap_or_default();
        let mut frames = merge_replay_frames(entity_frames, event_frames);
        apply_replay_state(&mut frames, events);
        return Ok(frames);
    }

    match sparse_replay_frames_from_events(events) {
        Ok(mut frames) => {
            apply_replay_state(&mut frames, events);
            Ok(frames)
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
) -> Vec<ReplayFrame> {
    let mut frames = entity_frames
        .into_iter()
        .map(|frame| (frame.tick, frame))
        .collect::<BTreeMap<_, _>>();
    for event_frame in event_frames {
        if let Some(entity_frame) = frames.get_mut(&event_frame.tick) {
            entity_frame.projectiles.extend(event_frame.projectiles);
        } else {
            frames.insert(event_frame.tick, event_frame);
        }
    }

    frames.into_values().collect()
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

fn apply_replay_state(frames: &mut [ReplayFrame], events: &[TimelineEvent]) {
    frames.sort_by_key(|frame| frame.tick);
    apply_projectile_lifecycles(frames, events);
    apply_bomb_state(frames, events);
}

fn apply_projectile_lifecycles(frames: &mut [ReplayFrame], events: &[TimelineEvent]) {
    let mut intervals = effect_intervals(events);
    intervals.sort_by_key(|effect| effect.start_tick);
    let mut next = 0;
    let mut active = Vec::<EffectInterval>::new();
    for frame in frames {
        while next < intervals.len() && intervals[next].start_tick <= frame.tick {
            active.push(intervals[next].clone());
            next += 1;
        }
        active.retain(|effect| effect.end_tick >= frame.tick);
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
}

fn effect_intervals(events: &[TimelineEvent]) -> Vec<EffectInterval> {
    let tick_rate = evidence_tick_rate(events);
    let mut ordered = events
        .iter()
        .filter(|event| event.kind == EventKind::Grenade)
        .collect::<Vec<_>>();
    ordered.sort_by_key(|event| event.tick);

    let mut pending = HashMap::<(String, String), VecDeque<&TimelineEvent>>::new();
    let mut intervals = Vec::new();
    for event in ordered {
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

    for ((kind, _), starts) in pending {
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
    intervals
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
                    let position =
                        valid_position(event).or_else(|| bomb.as_ref().map(|b| b.position));
                    if let Some(position) = position {
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
    let (id, health, alive, name_keys, team_keys, yaw_keys, armor_keys) = match event.kind {
        EventKind::Kill => (
            event.target.as_ref()?,
            0,
            false,
            &["target_name", "name"][..],
            &["target_team", "userteam", "victimteam", "teamnum", "team"][..],
            &["target_yaw", "yaw"][..],
            &["target_armor", "armor"][..],
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
            )
        }
        EventKind::BombPlant | EventKind::BombDefuse | EventKind::Purchase => (
            event.actor.as_ref()?,
            detail_u32(event, &["health", "actor_health", "attacker_health"]),
            true,
            &["actor_name", "name"][..],
            &["actor_team", "attackerteam", "teamnum", "team"][..],
            &["actor_yaw", "yaw"][..],
            &["actor_armor", "armor"][..],
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
        weapon: event.weapon.clone().unwrap_or_default(),
        input: None,
    })
}

/// Builds an evidence-based heat map from event coordinates only.
///
/// # Errors
///
/// Returns an unavailable error when no event contains world coordinates.
pub fn heatmap_from_events(events: &[TimelineEvent]) -> DemoResult<Vec<HeatPoint>> {
    let entity_frames =
        embedded_entity_replay(events).map_err(|reason| DemoError::Unavailable {
            capability: "heat map",
            reason,
        })?;
    let mut points = movement_heat_points(&entity_frames);
    points.extend(events.iter().filter_map(|event| {
        let [x, y, z] = event.position?;
        let weight = match event.kind {
            EventKind::Kill => 1.0,
            EventKind::Damage => 0.35,
            EventKind::BombPlant | EventKind::BombDefuse | EventKind::BombExplode => 0.8,
            EventKind::Grenade => 0.45,
            _ => 0.15,
        };
        Some(HeatPoint {
            x,
            y,
            weight,
            floor: floor_index(z),
            kind: format!("{:?}", event.kind).to_ascii_lowercase(),
            player_id: match event.kind {
                EventKind::Kill | EventKind::Damage => event.target.clone(),
                _ => event.actor.clone(),
            },
            team: match event.kind {
                EventKind::Kill | EventKind::Damage => {
                    detail_team(event, &["target_team", "victim_team", "user_team", "team"])
                }
                _ => detail_team(event, &["actor_team", "attacker_team", "user_team", "team"]),
            },
            event_kind: Some(format!("{:?}", event.kind).to_ascii_lowercase()),
        })
    }));
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

fn movement_heat_points(frames: &[ReplayFrame]) -> Vec<HeatPoint> {
    let mut last_positions = HashMap::<String, [f64; 3]>::new();
    let mut points = Vec::new();
    for player in frames.iter().flat_map(|frame| &frame.players) {
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
            points.push(HeatPoint {
                x: player.position[0],
                y: player.position[1],
                weight: 0.2,
                floor: floor_index(player.position[2]),
                kind: "movement".to_owned(),
                player_id: Some(player.id.clone()),
                team: (!player.team.trim().is_empty()).then(|| player.team.clone()),
                event_kind: Some("movement".to_owned()),
            });
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
        match raw.trim().to_ascii_uppercase().as_str() {
            "2" | "T" | "TERRORIST" | "TERRORISTS" => Some("T".to_owned()),
            "3" | "CT" | "COUNTER-TERRORIST" | "COUNTER-TERRORISTS" | "COUNTERTERRORIST" => {
                Some("CT".to_owned())
            }
            _ => None,
        }
    })
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
        assert_eq!(movement_heat_points(&repeated_frames).len(), 1);
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
}
