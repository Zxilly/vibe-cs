use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use source2_demo::prelude::{Context, Entity, EntityField, FieldValue};
use vibe_cs_domain::{ReplayFrame, ReplayInputState, ReplayPlayer, RoundSummary, TimelineEvent};

const CELL_WIDTH: f64 = 512.0;
const MAX_COORDINATE: f64 = 16_384.0;
const REPLAY_DETAIL_KEY: &str = "_entity_replay";
const REPLAY_UNAVAILABLE_DETAIL_KEY: &str = "_entity_replay_unavailable";
const MAX_DECODED_FRAMES: usize = 50_000;
const MAX_DECODED_PLAYERS_PER_FRAME: usize = 64;

/// Bounds entity-state sampling independently from the game-event limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntityReplayLimits {
    /// Minimum number of demo ticks between retained entity frames.
    pub sample_every_ticks: u32,
    /// Maximum retained entity frames for one analysis.
    pub maximum_frames: usize,
    /// Maximum fully linked players accepted in one frame.
    pub maximum_players_per_frame: usize,
}

impl Default for EntityReplayLimits {
    fn default() -> Self {
        Self {
            sample_every_ticks: 64,
            maximum_frames: 20_000,
            maximum_players_per_frame: 24,
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct EntityReplayCapture {
    limits: EntityReplayLimits,
    last_sample_tick: Option<u32>,
    frames: Vec<ReplayFrame>,
    unavailable_reason: Option<String>,
    saw_steam_controller: bool,
    saw_exact_pawn_link: bool,
    saw_position: bool,
}

impl EntityReplayCapture {
    pub(crate) fn new(limits: EntityReplayLimits) -> Self {
        let unavailable_reason = (limits.sample_every_ticks == 0
            || limits.maximum_frames == 0
            || limits.maximum_players_per_frame == 0)
            .then(|| "entity replay sampling is disabled by its configured limits".to_owned());
        Self {
            limits,
            unavailable_reason,
            ..Self::default()
        }
    }

    pub(crate) fn capture_tick(&mut self, context: &Context) {
        if self.unavailable_reason.is_some() {
            return;
        }
        let tick = context.tick();
        if self
            .last_sample_tick
            .is_some_and(|previous| tick.saturating_sub(previous) < self.limits.sample_every_ticks)
        {
            return;
        }
        self.last_sample_tick = Some(tick);
        if self.frames.len() >= self.limits.maximum_frames {
            self.frames.clear();
            self.unavailable_reason = Some(format!(
                "entity replay exceeded the configured {} frame limit",
                self.limits.maximum_frames
            ));
            return;
        }

        let mut players = BTreeMap::new();
        for controller in context
            .entities()
            .iter()
            .filter(|entity| entity.class().name() == "CCSPlayerController")
        {
            let Some(player) = snapshot_player(context, controller, self) else {
                continue;
            };
            if players.insert(player.id.clone(), player).is_some() {
                self.frames.clear();
                self.unavailable_reason =
                    Some("multiple controllers resolved to the same Steam identity".to_owned());
                return;
            }
            if players.len() > self.limits.maximum_players_per_frame {
                self.frames.clear();
                self.unavailable_reason = Some(format!(
                    "entity replay exceeded the configured {} players-per-frame limit",
                    self.limits.maximum_players_per_frame
                ));
                return;
            }
        }
        if !players.is_empty() {
            self.frames.push(ReplayFrame {
                tick: u64::from(tick),
                players: players.into_values().collect(),
                projectiles: Vec::new(),
                bomb: None,
            });
        }
    }

    pub(crate) fn into_parts(self) -> (Vec<ReplayFrame>, Option<String>) {
        if let Some(reason) = self.unavailable_reason {
            return (Vec::new(), Some(reason));
        }
        if !self.frames.is_empty() {
            return (self.frames, None);
        }
        let reason = if !self.saw_steam_controller {
            "no CCSPlayerController with a non-zero Steam identity was decoded"
        } else if !self.saw_exact_pawn_link {
            "no controller resolved to an exact-serial CCSPlayerPawn handle"
        } else if !self.saw_position {
            "linked pawns did not expose a complete finite world position"
        } else {
            "linked pawns did not expose complete yaw, health, armor, life-state, and weapon state"
        };
        (Vec::new(), Some(reason.to_owned()))
    }
}

fn snapshot_player(
    context: &Context,
    controller: &Entity,
    capture: &mut EntityReplayCapture,
) -> Option<ReplayPlayer> {
    let controller_fields = controller.fields();
    let steam_id = unsigned(field(&controller_fields, &["m_steamID"], &[".m_steamID"])?)?;
    if steam_id == 0 {
        return None;
    }
    capture.saw_steam_controller = true;

    let pawn_handle = unsigned(field(
        &controller_fields,
        &["m_hPlayerPawn"],
        &[".m_hPlayerPawn"],
    )?)
    .and_then(|value| u32::try_from(value).ok())?;
    let pawn = exact_handle(context, pawn_handle)?;
    if pawn.class().name() != "CCSPlayerPawn" {
        return None;
    }
    capture.saw_exact_pawn_link = true;

    let pawn_fields = pawn.fields();
    if let Some(backlink) = field(&pawn_fields, &["m_hController"], &[".m_hController"])
        .and_then(unsigned)
        .and_then(|value| u32::try_from(value).ok())
        && backlink != controller.handle()
    {
        return None;
    }

    let position = pawn_position(&pawn_fields)?;
    capture.saw_position = true;
    let angles = vector3(field(
        &pawn_fields,
        &["m_angEyeAngles"],
        &[".m_angEyeAngles"],
    )?)?;
    let yaw = f64::from(angles[1]);
    if !yaw.is_finite() {
        return None;
    }
    let health = bounded_u32(field(&pawn_fields, &["m_iHealth"], &[".m_iHealth"])?, 200)?;
    let armor = bounded_u32(
        field(
            &pawn_fields,
            &["m_ArmorValue", "m_iArmor"],
            &[".m_ArmorValue", ".m_iArmor"],
        )?,
        200,
    )?;
    let life_state = unsigned(field(&pawn_fields, &["m_lifeState"], &[".m_lifeState"])?)?;
    let alive = life_state == 0 && health > 0;
    if let Some(controller_alive) = field(
        &controller_fields,
        &["m_bPawnIsAlive"],
        &[".m_bPawnIsAlive"],
    )
    .and_then(boolean)
        && controller_alive != alive
    {
        return None;
    }

    let weapon_handle = field(
        &pawn_fields,
        &[
            "CCSPlayer_WeaponServices.m_hActiveWeapon",
            "m_hActiveWeapon",
        ],
        &[".m_hActiveWeapon"],
    )
    .and_then(unsigned)
    .and_then(|value| u32::try_from(value).ok());
    let weapon_entity = weapon_handle.and_then(|handle| exact_handle(context, handle));
    let weapon = weapon_entity.map(|entity| entity.class().name().to_owned());
    let weapon_fields = weapon_entity.map(Entity::fields);
    if alive && weapon.is_none() {
        return None;
    }

    let controller_team = field(&controller_fields, &["m_iTeamNum"], &[".m_iTeamNum"])
        .and_then(unsigned)
        .and_then(team_side);
    let pawn_team = field(&pawn_fields, &["m_iTeamNum"], &[".m_iTeamNum"])
        .and_then(unsigned)
        .and_then(team_side);
    let team = match (controller_team, pawn_team) {
        (Some(controller), Some(pawn)) if controller != pawn => return None,
        (Some(team), _) | (_, Some(team)) => team.to_owned(),
        (None, None) => return None,
    };
    let id = steam_id.to_string();
    let name = field(
        &controller_fields,
        &["m_iszPlayerName"],
        &[".m_iszPlayerName"],
    )
    .and_then(string)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or(&id)
    .to_owned();

    Some(ReplayPlayer {
        id,
        name,
        team,
        position,
        yaw,
        health,
        armor,
        alive,
        weapon: weapon.unwrap_or_default(),
        input: pawn_input(&pawn_fields, weapon_fields.as_deref()),
    })
}

fn pawn_input(
    pawn_fields: &[EntityField<'_>],
    weapon_fields: Option<&[EntityField<'_>]>,
) -> Option<ReplayInputState> {
    let mask = field(
        pawn_fields,
        &[
            "CCSPlayerPawn.CCSPlayer_MovementServices.m_nButtonDownMaskPrev",
            "CCSPlayer_MovementServices.m_nButtonDownMaskPrev",
            "m_nButtonDownMaskPrev",
        ],
        &[".m_nButtonDownMaskPrev"],
    )
    .and_then(unsigned)?;
    let bit = |index: u32| mask & (1_u64 << index) != 0;
    let crouch = field(
        pawn_fields,
        &[
            "CCSPlayerPawn.CCSPlayer_MovementServices.m_bDesiresDuck",
            "CCSPlayer_MovementServices.m_bDesiresDuck",
            "m_bDesiresDuck",
            "m_bDucking",
        ],
        &[".m_bDesiresDuck", ".m_bDucking"],
    )
    .and_then(boolean)
    .unwrap_or_else(|| bit(2));
    let walk = field(pawn_fields, &["m_bIsWalking"], &[".m_bIsWalking"])
        .and_then(boolean)
        .unwrap_or_else(|| bit(17) || bit(18));
    let reload = weapon_fields
        .and_then(|fields| field(fields, &["m_bInReload"], &[".m_bInReload"]))
        .and_then(boolean)
        .unwrap_or_else(|| bit(13));
    Some(ReplayInputState {
        forward: bit(3),
        left: bit(9),
        backward: bit(4),
        right: bit(10),
        jump: bit(1),
        crouch,
        walk,
        reload,
        fire: bit(0),
        secondary_fire: bit(11),
    })
}

fn exact_handle(context: &Context, handle: u32) -> Option<&Entity> {
    if handle == 0 || handle == u32::MAX {
        return None;
    }
    let entity = context.entities().get_by_handle(handle as usize).ok()?;
    (entity.handle() == handle).then_some(entity)
}

fn pawn_position(fields: &[EntityField<'_>]) -> Option<[f64; 3]> {
    if let Some(position) = field(
        fields,
        &["m_vecAbsOrigin", "m_vecOrigin"],
        &[".m_vecAbsOrigin", ".m_vecOrigin"],
    )
    .and_then(vector3)
    {
        let position = position.map(f64::from);
        if position.iter().all(|value| value.is_finite()) {
            return Some(position);
        }
    }

    let cells = [
        body_axis(fields, "m_cellX").and_then(unsigned)?,
        body_axis(fields, "m_cellY").and_then(unsigned)?,
        body_axis(fields, "m_cellZ").and_then(unsigned)?,
    ];
    let offsets = [
        body_axis(fields, "m_vecX").and_then(float)?,
        body_axis(fields, "m_vecY").and_then(float)?,
        body_axis(fields, "m_vecZ").and_then(float)?,
    ];
    reconstruct_cell_position(cells, offsets)
}

fn reconstruct_cell_position(cells: [u64; 3], offsets: [f64; 3]) -> Option<[f64; 3]> {
    let mut position = [0.0; 3];
    for index in 0..3 {
        if cells[index] > 63
            || !offsets[index].is_finite()
            || !(0.0..=CELL_WIDTH).contains(&offsets[index])
        {
            return None;
        }
        let cell = u32::try_from(cells[index]).expect("validated cell fits in u32");
        position[index] = f64::from(cell) * CELL_WIDTH - MAX_COORDINATE + offsets[index];
        if !(-MAX_COORDINATE..=MAX_COORDINATE).contains(&position[index]) {
            return None;
        }
    }
    Some(position)
}

fn body_axis<'a>(fields: &'a [EntityField<'a>], leaf: &str) -> Option<&'a FieldValue> {
    let exact = [
        format!("CBodyComponentBaseAnimGraph.{leaf}"),
        format!("CBodyComponent.{leaf}"),
        leaf.to_owned(),
    ];
    let exact = exact.iter().map(String::as_str).collect::<Vec<_>>();
    if let Some(value) = field(fields, &exact, &[]) {
        return Some(value);
    }
    unique_field(fields, |name| {
        name.ends_with(&format!(".{leaf}")) && name.contains("BodyComponent")
    })
}

fn field<'a>(
    fields: &'a [EntityField<'a>],
    exact: &[&str],
    suffixes: &[&str],
) -> Option<&'a FieldValue> {
    for name in exact {
        if let Some(value) = unique_field(fields, |candidate| candidate == *name) {
            return Some(value);
        }
    }
    unique_field(fields, |name| {
        suffixes.iter().any(|suffix| name.ends_with(suffix))
    })
}

fn unique_field<'a>(
    fields: &'a [EntityField<'a>],
    predicate: impl Fn(&str) -> bool,
) -> Option<&'a FieldValue> {
    let mut matches = fields
        .iter()
        .filter(|entry| predicate(&entry.name))
        .filter_map(|entry| entry.value);
    let value = matches.next()?;
    matches.next().is_none().then_some(value)
}

fn unsigned(value: &FieldValue) -> Option<u64> {
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

fn bounded_u32(value: &FieldValue, maximum: u32) -> Option<u32> {
    let value = u32::try_from(unsigned(value)?).ok()?;
    (value <= maximum).then_some(value)
}

fn boolean(value: &FieldValue) -> Option<bool> {
    match value {
        FieldValue::Boolean(value) => Some(*value),
        _ => match unsigned(value)? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        },
    }
}

fn float(value: &FieldValue) -> Option<f64> {
    match value {
        FieldValue::Float(value) => Some(f64::from(*value)),
        _ => None,
    }
}

fn vector3(value: &FieldValue) -> Option<[f32; 3]> {
    match value {
        FieldValue::Vector3D(value) => Some(*value),
        _ => None,
    }
}

fn string(value: &FieldValue) -> Option<&str> {
    match value {
        FieldValue::String(value) => Some(value),
        _ => None,
    }
}

fn team_side(value: u64) -> Option<&'static str> {
    match value {
        2 => Some("T"),
        3 => Some("CT"),
        _ => None,
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplayEnvelope {
    frames: Vec<ReplayFrame>,
}

pub(crate) fn attach_entity_replay(
    rounds: &mut [RoundSummary],
    frames: &[ReplayFrame],
    unavailable_reason: Option<&str>,
) {
    let mut attached = false;
    for round in rounds.iter_mut() {
        let round_frames = frames
            .iter()
            .filter(|frame| frame.tick >= round.start_tick && frame.tick <= round.end_tick)
            .cloned()
            .collect::<Vec<_>>();
        if round_frames.is_empty() {
            continue;
        }
        let Some(detail) = round
            .events
            .first_mut()
            .and_then(|event| event.detail.as_object_mut())
        else {
            continue;
        };
        detail.insert(
            REPLAY_DETAIL_KEY.to_owned(),
            serde_json::to_value(ReplayEnvelope {
                frames: round_frames,
            })
            .expect("ReplayFrame serialization cannot fail"),
        );
        attached = true;
    }
    if attached {
        return;
    }
    let reason = unavailable_reason.unwrap_or("no entity snapshots fell within decoded rounds");
    if let Some(detail) = rounds
        .first_mut()
        .and_then(|round| round.events.first_mut())
        .and_then(|event| event.detail.as_object_mut())
    {
        detail.insert(
            REPLAY_UNAVAILABLE_DETAIL_KEY.to_owned(),
            Value::String(reason.to_owned()),
        );
    }
}

pub(crate) fn embedded_entity_replay(events: &[TimelineEvent]) -> Result<Vec<ReplayFrame>, String> {
    let mut frames = Vec::new();
    for value in events
        .iter()
        .filter_map(|event| event.detail.get(REPLAY_DETAIL_KEY))
    {
        let envelope: ReplayEnvelope = serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid embedded entity replay: {error}"))?;
        frames.extend(envelope.frames);
        if frames.len() > MAX_DECODED_FRAMES {
            return Err(format!(
                "embedded entity replay exceeds {MAX_DECODED_FRAMES} frames"
            ));
        }
    }
    frames.sort_by_key(|frame| frame.tick);
    if frames.windows(2).any(|pair| pair[0].tick == pair[1].tick) {
        return Err("embedded entity replay contains duplicate frame ticks".to_owned());
    }
    for frame in &frames {
        let mut identities = BTreeSet::new();
        if frame.players.is_empty()
            || frame.players.len() > MAX_DECODED_PLAYERS_PER_FRAME
            || frame.players.iter().any(|player| {
                player.id.is_empty()
                    || player.name.is_empty()
                    || !matches!(player.team.as_str(), "T" | "CT")
                    || player.health > 200
                    || player.armor > 200
                    || (player.alive && player.weapon.is_empty())
                    || !player.yaw.is_finite()
                    || player.position.iter().any(|value| !value.is_finite())
                    || !identities.insert(player.id.as_str())
            })
        {
            return Err("embedded entity replay contains invalid player state".to_owned());
        }
    }
    Ok(frames)
}

pub(crate) fn entity_replay_unavailable_reason(events: &[TimelineEvent]) -> Option<String> {
    events.iter().find_map(|event| {
        event
            .detail
            .get(REPLAY_UNAVAILABLE_DETAIL_KEY)
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use vibe_cs_domain::{EventKind, TimelineEvent};

    use super::*;

    #[test]
    fn default_replay_sampling_stays_below_the_frame_budget_for_long_matches() {
        let limits = EntityReplayLimits::default();
        let maximum_frames = u32::try_from(limits.maximum_frames).expect("frame limit fits u32");

        assert_eq!(limits.sample_every_ticks, 64);
        assert!(175_000_u32.div_ceil(limits.sample_every_ticks) < maximum_frames);
    }

    fn round() -> RoundSummary {
        RoundSummary {
            number: 1,
            start_tick: 100,
            end_tick: 200,
            winner: "T".to_owned(),
            reason: String::new(),
            team_a_score: 1,
            team_b_score: 0,
            events: vec![TimelineEvent {
                id: "round-start".to_owned(),
                tick: 100,
                seconds: 1.0,
                kind: EventKind::RoundStart,
                actor: None,
                target: None,
                weapon: None,
                headshot: false,
                penetrated: false,
                position: None,
                detail: json!({}),
            }],
        }
    }

    fn frame(tick: u64) -> ReplayFrame {
        ReplayFrame {
            tick,
            players: vec![ReplayPlayer {
                id: "76561198000000001".to_owned(),
                name: "Player".to_owned(),
                team: "T".to_owned(),
                position: [1.0, 2.0, 3.0],
                yaw: 90.0,
                health: 100,
                armor: 50,
                alive: true,
                weapon: "CWeaponAK47".to_owned(),
                input: None,
            }],
            projectiles: Vec::new(),
            bomb: None,
        }
    }

    #[test]
    fn cell_coordinates_require_a_complete_bounded_tuple() {
        assert_eq!(
            reconstruct_cell_position([32, 31, 32], [10.0, 500.0, 64.0]),
            Some([10.0, -12.0, 64.0])
        );
        assert_eq!(
            reconstruct_cell_position([64, 31, 32], [10.0, 500.0, 64.0]),
            None
        );
        assert_eq!(
            reconstruct_cell_position([32, 31, 32], [f64::NAN, 500.0, 64.0]),
            None
        );
    }

    #[test]
    fn pawn_field_fixture_reconstructs_standard_body_component_position() {
        let cell_x = FieldValue::Unsigned16(32);
        let cell_y = FieldValue::Unsigned16(31);
        let cell_z = FieldValue::Unsigned16(32);
        let offset_x = FieldValue::Float(10.0);
        let offset_y = FieldValue::Float(500.0);
        let offset_z = FieldValue::Float(64.0);
        let fixture = [
            ("CBodyComponentBaseAnimGraph.m_cellX", &cell_x),
            ("CBodyComponentBaseAnimGraph.m_cellY", &cell_y),
            ("CBodyComponentBaseAnimGraph.m_cellZ", &cell_z),
            ("CBodyComponentBaseAnimGraph.m_vecX", &offset_x),
            ("CBodyComponentBaseAnimGraph.m_vecY", &offset_y),
            ("CBodyComponentBaseAnimGraph.m_vecZ", &offset_z),
        ]
        .into_iter()
        .map(|(name, value)| EntityField {
            path: Vec::new(),
            name: name.to_owned(),
            field_type: String::new(),
            decoded_type: Some(value.type_name()),
            value: Some(value),
        })
        .collect::<Vec<_>>();

        assert_eq!(pawn_position(&fixture), Some([10.0, -12.0, 64.0]));
        assert_eq!(pawn_position(&fixture[..5]), None);
    }

    #[test]
    fn embedded_replay_accepts_only_the_current_exact_shape() {
        let mut rounds = vec![round()];
        attach_entity_replay(&mut rounds, &[frame(120)], None);
        let detail = &rounds[0].events[0].detail;
        let current = detail
            .get("_entity_replay")
            .expect("current embedded replay detail");
        assert!(current.get("version").is_none());
        let mut invalid = current.clone();
        invalid["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<ReplayEnvelope>(invalid).is_err());
    }

    #[test]
    fn embedded_frames_round_trip_only_inside_round_bounds() {
        let mut rounds = vec![round()];
        attach_entity_replay(&mut rounds, &[frame(99), frame(120), frame(201)], None);
        let frames = embedded_entity_replay(&rounds[0].events).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].tick, 120);
        assert_eq!(frames[0].players[0].weapon, "CWeaponAK47");
    }

    #[test]
    fn unavailable_reason_is_persisted_without_frames() {
        let mut rounds = vec![round()];
        attach_entity_replay(&mut rounds, &[], Some("pawn position unavailable"));
        assert_eq!(
            entity_replay_unavailable_reason(&rounds[0].events).as_deref(),
            Some("pawn position unavailable")
        );
    }
}
