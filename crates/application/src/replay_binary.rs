//! ARPL v2, the only whole-replay wire: shared identities/strings and a bounded
//! zlib payload. Coordinates use 1/16-unit deltas; angles use 1/128 degree.
use std::{
    collections::{HashMap, HashSet},
    io::Write,
};

use axum::http::StatusCode;
use flate2::{Compression, write::ZlibEncoder};
use vibe_cs_domain::{
    REPLAY_MAX_EFFECT_RECORDS, REPLAY_MAX_FRAMES, REPLAY_MAX_PLAYER_RECORDS, ReplayInputState,
    ReplayPlayer, ReplayProjectilePhase,
};

use crate::{ApiError, ApiResult, ReplayPayload};

const MAX_BYTES: usize = 128 * 1024 * 1024;
const MAX_TEXT: usize = 512;
const MAX_STRINGS: usize = 16_384;

fn invalid(message: &str) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "invalid_replay", message)
}

struct Writer {
    bytes: Vec<u8>,
}
impl Writer {
    fn push(&mut self, bytes: &[u8]) -> ApiResult<()> {
        if self.bytes.len().saturating_add(bytes.len()) > MAX_BYTES {
            return Err(invalid("replay exceeds the 128 MiB wire budget"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    fn u8(&mut self, value: u8) -> ApiResult<()> {
        self.push(&[value])
    }
    fn u16(&mut self, value: u16) -> ApiResult<()> {
        self.push(&value.to_le_bytes())
    }
    fn tick(&mut self, value: u64) -> ApiResult<()> {
        self.push(
            &u32::try_from(value)
                .map_err(|_| invalid("replay tick exceeds Source range"))?
                .to_le_bytes(),
        )
    }
    fn count(&mut self, value: usize) -> ApiResult<()> {
        self.tick(u64::try_from(value).map_err(|_| invalid("replay count overflow"))?)
    }
    fn text(&mut self, value: &str) -> ApiResult<()> {
        if value.len() > MAX_TEXT {
            return Err(invalid("replay text exceeds its bound"));
        }
        self.u16(u16::try_from(value.len()).map_err(|_| invalid("replay string overflow"))?)?;
        self.push(value.as_bytes())
    }
    fn json(&mut self, value: &impl serde::Serialize) -> ApiResult<()> {
        let bytes = serde_json::to_vec(value)
            .map_err(|_| invalid("replay metadata serialization failed"))?;
        if bytes.len() > 64 * 1024 {
            return Err(invalid("replay metadata exceeds its bound"));
        }
        self.count(bytes.len())?;
        self.push(&bytes)
    }
    fn delta(&mut self, value: i32, previous: &mut i32) -> ApiResult<()> {
        let difference = i64::from(value) - i64::from(*previous);
        let mut encoded = u32::try_from((difference << 1) ^ (difference >> 63))
            .map_err(|_| invalid("replay coordinate delta overflow"))?;
        while encoded >= 128 {
            self.u8(u8::try_from(encoded & 127).expect("seven bits") | 128)?;
            encoded >>= 7;
        }
        self.u8(u8::try_from(encoded).expect("seven bits"))?;
        *previous = value;
        Ok(())
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "finite coordinates are bounded before 1/16-unit quantization"
    )]
    fn position(&mut self, position: [f64; 3], previous: &mut [i32; 3]) -> ApiResult<()> {
        for (value, previous) in position.into_iter().zip(previous) {
            if !value.is_finite() || value.abs() > 1_000_000.0 {
                return Err(invalid("replay contains an invalid coordinate"));
            }
            self.delta((value * 16.0).round() as i32, previous)?;
        }
        Ok(())
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "angle normalized to [-180,180] before fixed-point conversion"
    )]
    fn angle(&mut self, value: f64) -> ApiResult<()> {
        if !value.is_finite() || value.abs() > 360.0 {
            return Err(invalid("replay contains an invalid angle"));
        }
        let value = (value + 180.0).rem_euclid(360.0) - 180.0;
        self.push(&((value * 128.0).round() as i16).to_le_bytes())
    }
}

struct Strings<'a> {
    values: Vec<&'a str>,
    indices: HashMap<&'a str, u16>,
}
impl<'a> Strings<'a> {
    fn new() -> Self {
        Self {
            values: Vec::new(),
            indices: HashMap::new(),
        }
    }
    fn add(&mut self, value: &'a str) -> ApiResult<()> {
        if value.len() > MAX_TEXT {
            return Err(invalid("replay text exceeds its bound"));
        }
        if !self.indices.contains_key(value) {
            if self.values.len() >= MAX_STRINGS {
                return Err(invalid("replay string table exceeds its bound"));
            }
            let index = u16::try_from(self.values.len())
                .map_err(|_| invalid("replay string index overflow"))?;
            self.values.push(value);
            self.indices.insert(value, index);
        }
        Ok(())
    }
    fn index(&self, value: &str) -> u16 {
        self.indices[value]
    }
    fn optional_index(&self, value: Option<&str>) -> u16 {
        value.map_or(u16::MAX, |value| self.index(value))
    }
}

fn input_mask(input: Option<ReplayInputState>) -> u16 {
    input.map_or(u16::MAX, |input| {
        u16::from(input.forward)
            | (u16::from(input.left) << 1)
            | (u16::from(input.backward) << 2)
            | (u16::from(input.right) << 3)
            | (u16::from(input.jump) << 4)
            | (u16::from(input.crouch) << 5)
            | (u16::from(input.walk) << 6)
            | (u16::from(input.reload) << 7)
            | (u16::from(input.fire) << 8)
            | (u16::from(input.secondary_fire) << 9)
    })
}

pub(crate) fn encode_binary_replay(payload: &ReplayPayload) -> ApiResult<Vec<u8>> {
    if payload.frames.len() > REPLAY_MAX_FRAMES
        || payload.fidelity.frame_count != payload.frames.len() as u64
        || !payload.fidelity.tick_rate.is_finite()
        || !(8.0..=1024.0).contains(&payload.fidelity.tick_rate)
        || payload.fidelity.positioned_event_count > REPLAY_MAX_EFFECT_RECORDS as u64
        || payload.frames.first().map_or(0, |frame| frame.tick) != payload.fidelity.start_tick
        || payload.frames.last().map_or(0, |frame| frame.tick) != payload.fidelity.end_tick
    {
        return Err(invalid("replay fidelity or frame bounds are invalid"));
    }
    let mut roster = Vec::<&ReplayPlayer>::new();
    let mut identities = HashMap::<&str, usize>::new();
    let mut strings = Strings::new();
    let (mut players, mut effects, mut last_tick) = (0, 0, None);
    for frame in &payload.frames {
        if last_tick.is_some_and(|tick| frame.tick <= tick)
            || frame.players.len() > 64
            || frame.projectiles.len() > 512
        {
            return Err(invalid("replay frame limits or tick order are invalid"));
        }
        last_tick = Some(frame.tick);
        players += frame.players.len();
        effects += frame.projectiles.len();
        if players > REPLAY_MAX_PLAYER_RECORDS || effects > REPLAY_MAX_EFFECT_RECORDS {
            return Err(invalid("replay aggregate record limit exceeded"));
        }
        let mut unique = HashSet::new();
        for player in &frame.players {
            if !matches!(player.team.as_str(), "A" | "B") || !unique.insert(&player.id) {
                return Err(invalid("replay player identities are not canonical"));
            }
            if let Some(index) = identities.get(player.id.as_str()).copied() {
                if roster[index].name != player.name || roster[index].team != player.team {
                    return Err(invalid("replay identity changes within the player table"));
                }
            } else {
                if roster.len() == 64 {
                    return Err(invalid("replay roster exceeds its bound"));
                }
                strings.add(&player.id)?;
                strings.add(&player.name)?;
                identities.insert(&player.id, roster.len());
                roster.push(player);
            }
            strings.add(&player.weapon)?;
        }
        let mut unique = HashSet::new();
        for effect in &frame.projectiles {
            if !unique.insert(&effect.id) || effect.start_tick > effect.end_tick {
                return Err(invalid(
                    "replay projectile identities or lifetime are invalid",
                ));
            }
            strings.add(&effect.id)?;
            strings.add(&effect.kind)?;
            if let Some(owner) = &effect.owner_id {
                strings.add(owner)?;
            }
        }
        if let Some(bomb) = &frame.bomb {
            strings.add(&bomb.state)?;
            if let Some(carrier) = &bomb.carrier_id {
                strings.add(carrier)?;
            }
        }
    }
    let mut writer = Writer { bytes: Vec::new() };
    writer.json(&payload.cache)?;
    writer.json(&payload.fidelity)?;
    writer
        .u16(u16::try_from(strings.values.len()).map_err(|_| invalid("string table overflow"))?)?;
    for value in &strings.values {
        writer.text(value)?;
    }
    writer.u16(u16::try_from(roster.len()).map_err(|_| invalid("roster overflow"))?)?;
    for player in &roster {
        writer.u16(strings.index(&player.id))?;
        writer.u16(strings.index(&player.name))?;
        writer.u8(u8::from(player.team == "B"))?;
    }
    writer.count(payload.frames.len())?;
    let mut player_positions = vec![[0; 3]; roster.len()];
    let mut projectile_positions = HashMap::<u16, [i32; 3]>::new();
    let mut bomb_position = [0; 3];
    for frame in &payload.frames {
        writer.tick(frame.tick)?;
        writer
            .u8(u8::try_from(frame.players.len()).map_err(|_| invalid("player count overflow"))?)?;
        for player in &frame.players {
            let index = identities[player.id.as_str()];
            writer.u8(u8::try_from(index).map_err(|_| invalid("player index overflow"))?)?;
            writer.position(player.position, &mut player_positions[index])?;
            writer.angle(player.yaw)?;
            writer.angle(player.pitch)?;
            writer.u8(u8::try_from(player.health)
                .map_err(|_| invalid("replay health exceeds its bound"))?)?;
            writer.u8(u8::try_from(player.armor)
                .map_err(|_| invalid("replay armor exceeds its bound"))?)?;
            writer.u8(u8::from(player.alive))?;
            writer.u16(strings.index(&player.weapon))?;
            writer.u16(input_mask(player.input))?;
        }
        writer.u16(
            u16::try_from(frame.projectiles.len())
                .map_err(|_| invalid("projectile count overflow"))?,
        )?;
        for projectile in &frame.projectiles {
            let id = strings.index(&projectile.id);
            writer.u16(id)?;
            writer.u16(strings.index(&projectile.kind))?;
            writer.u16(strings.optional_index(projectile.owner_id.as_deref()))?;
            writer.u8(u8::from(projectile.active)
                | (u8::from(projectile.masks_vision) << 1)
                | (u8::from(projectile.phase == ReplayProjectilePhase::Effect) << 2))?;
            writer.position(
                projectile.position,
                projectile_positions.entry(id).or_insert([0; 3]),
            )?;
            if projectile
                .radius
                .is_some_and(|radius| !radius.is_finite() || !(0.0..=4096.0).contains(&radius))
            {
                return Err(invalid("replay effect radius is invalid"));
            }
            #[allow(
                clippy::cast_possible_truncation,
                reason = "bounded illustrative/evidence radius encoded as f32"
            )]
            let radius = projectile.radius.map_or(f32::NAN, |radius| radius as f32);
            writer.push(&radius.to_le_bytes())?;
            writer.tick(projectile.start_tick)?;
            writer.tick(projectile.end_tick)?;
        }
        writer.u8(u8::from(frame.bomb.is_some()))?;
        if let Some(bomb) = &frame.bomb {
            writer.position(bomb.position, &mut bomb_position)?;
            writer.u16(strings.index(&bomb.state))?;
            writer.u16(strings.optional_index(bomb.carrier_id.as_deref()))?;
        }
    }
    let mut header = b"ARPL\x02\0\x01\0".to_vec();
    header.extend_from_slice(
        &u32::try_from(writer.bytes.len())
            .map_err(|_| invalid("replay payload overflow"))?
            .to_le_bytes(),
    );
    header.extend_from_slice(&crc32fast::hash(&writer.bytes).to_le_bytes());
    let mut compressor = ZlibEncoder::new(header, Compression::best());
    compressor
        .write_all(&writer.bytes)
        .map_err(|_| invalid("replay compression failed"))?;
    compressor
        .finish()
        .map_err(|_| invalid("replay compression failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_cs_domain::{
        ReplayArtifact, ReplayBomb, ReplayFidelityMetadata, ReplayFidelityMode, ReplayFrame,
        ReplayProjectile,
    };

    fn payload(artifact: ReplayArtifact) -> ReplayPayload {
        ReplayPayload {
            frames: artifact.frames,
            fidelity: artifact.fidelity,
            cache: crate::ReplayCacheMetadata {
                state: crate::ReplayCacheState::Generated,
                key: None,
                bytes: 0,
                generated_at: None,
                repaired: false,
                reason: None,
            },
        }
    }

    fn fixture() -> ReplayPayload {
        let mut player = ReplayPlayer {
            id: "76561198000000001".to_owned(),
            name: "Player".to_owned(),
            team: "A".to_owned(),
            position: [-1000.0, 64.0, 32.0],
            yaw: 179.0,
            pitch: -32.0,
            health: 100,
            armor: 50,
            alive: true,
            weapon: "ak47".to_owned(),
            input: Some(ReplayInputState {
                forward: true,
                fire: true,
                ..ReplayInputState::default()
            }),
        };
        let flight = ReplayProjectile {
            id: "projectile:42:3".to_owned(),
            owner_id: Some(player.id.clone()),
            kind: "smoke".to_owned(),
            phase: ReplayProjectilePhase::Flying,
            start_tick: 8,
            end_tick: 15,
            position: [1.0, 2.0, 3.0],
            active: true,
            radius: None,
            masks_vision: false,
        };
        let effect = ReplayProjectile {
            id: "effect:smoke:id:42:16".to_owned(),
            phase: ReplayProjectilePhase::Effect,
            start_tick: 16,
            end_tick: 64,
            position: [4.0, 5.0, 0.0],
            radius: Some(144.0),
            masks_vision: true,
            ..flight.clone()
        };
        let mut frames = vec![ReplayFrame {
            tick: 8,
            players: vec![player.clone()],
            projectiles: vec![flight],
            bomb: None,
        }];
        player.position = [-999.9375, 65.0, 31.9375];
        player.yaw = -179.0;
        player.pitch = 45.0;
        let bomb = ReplayBomb {
            position: [4.0, 5.0, 0.0],
            state: "planted".to_owned(),
            carrier_id: None,
        };
        frames.push(ReplayFrame {
            tick: 16,
            players: vec![player.clone()],
            projectiles: vec![effect.clone()],
            bomb: Some(bomb.clone()),
        });
        frames.push(ReplayFrame {
            tick: 24,
            players: vec![player],
            projectiles: vec![effect],
            bomb: Some(bomb),
        });
        payload(ReplayArtifact {
            fidelity: ReplayFidelityMetadata {
                mode: ReplayFidelityMode::Hybrid,
                tick_rate: 64.0,
                frame_count: 3,
                positioned_event_count: 1,
                start_tick: 8,
                end_tick: 24,
            },
            frames,
        })
    }

    #[test]
    fn v2_contains_one_versioned_compressed_envelope() {
        let bytes = encode_binary_replay(&fixture()).unwrap();
        assert_eq!(&bytes[..8], b"ARPL\x02\0\x01\0");
        let expected = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let payload = {
            let mut out = Vec::with_capacity(expected + 1);
            let mut decoder = flate2::Decompress::new(true);
            assert_eq!(
                decoder
                    .decompress_vec(&bytes[16..], &mut out, flate2::FlushDecompress::Finish)
                    .unwrap(),
                flate2::Status::StreamEnd
            );
            out
        };
        assert_eq!(payload.len(), expected);
        assert_eq!(
            crc32fast::hash(&payload),
            u32::from_le_bytes(bytes[12..16].try_into().unwrap())
        );
        assert_eq!(
            payload
                .windows(17)
                .filter(|bytes| *bytes == b"76561198000000001")
                .count(),
            1,
            "identity reused by owner references"
        );
    }

    #[test]
    fn rejects_untrusted_pose_and_identity_changes() {
        let mut replay = fixture();
        replay.frames[1].players[0].pitch = f64::NAN;
        assert!(encode_binary_replay(&replay).is_err());
        let mut replay = fixture();
        replay.frames[1].players[0].team = "T".to_owned();
        assert!(encode_binary_replay(&replay).is_err());
        let mut replay = fixture();
        replay.frames[1].players[0].name = "changed".to_owned();
        assert!(encode_binary_replay(&replay).is_err());
        let mut replay = fixture();
        replay.frames[1].tick = 8;
        assert!(encode_binary_replay(&replay).is_err());
    }

    #[test]
    #[ignore = "explicit cross-language fixture regeneration"]
    fn export_v2_browser_fixture() {
        std::fs::write(
            std::env::var("VIBE_ARPL_FIXTURE").unwrap(),
            encode_binary_replay(&fixture()).unwrap(),
        )
        .unwrap();
    }

    #[test]
    #[ignore = "requires the real dense replay and pre-replacement baseline artifacts"]
    fn real_dense_v2_is_smaller_than_the_recorded_sparse_v1_baseline() {
        let replay: ReplayArtifact = serde_json::from_slice(
            &std::fs::read(std::env::var("VIBE_DENSE_REPLAY_JSON").unwrap()).unwrap(),
        )
        .unwrap();
        let bytes = encode_binary_replay(&payload(replay)).unwrap();
        let baseline = std::fs::metadata(std::env::var("VIBE_BASELINE_OUTPUT").unwrap())
            .unwrap()
            .len();
        eprintln!(
            "real replay: ARPL v2={} bytes, prior sparse v1={baseline} bytes",
            bytes.len()
        );
        assert!((bytes.len() as u64) < baseline);
        std::fs::write(std::env::var("VIBE_DENSE_REPLAY_BINARY").unwrap(), bytes).unwrap();
    }
}
