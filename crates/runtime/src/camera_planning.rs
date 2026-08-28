use std::f64::consts::{PI, TAU};

use vibe_cs_domain::{HlaeCameraStyle, ReplayFrame, ReplayPlayer};
use vibe_cs_hlae::{CameraKeyframe, CameraPosition, CameraRotation};

pub(crate) fn sample_four_frames<T: Copy>(frames: &[(u64, T)]) -> Option<[(u64, T); 4]> {
    if frames.len() < 4 {
        return None;
    }
    let last = frames.len() - 1;
    let indexes = [0, last / 3, (last * 2) / 3, last];
    let samples = indexes.map(|index| frames[index]);
    if samples.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
        return None;
    }
    Some(samples)
}

pub(crate) fn camera_keyframe_for_scene(
    tick: u64,
    player: &ReplayPlayer,
    anchor: &ReplayPlayer,
    style: HlaeCameraStyle,
    index: usize,
    engagement_focus: Option<[f64; 3]>,
) -> CameraKeyframe {
    let phase = f64::from(u32::try_from(index).unwrap_or_default());
    let progress = phase / 3.0;
    let target = [
        player.position[0],
        player.position[1],
        player.position[2] + 64.0,
    ];
    let focus = engagement_focus.unwrap_or([
        target[0] + 256.0 * player.yaw.to_radians().cos(),
        target[1] + 256.0 * player.yaw.to_radians().sin(),
        target[2],
    ]);
    let interaction = [
        (target[0] + focus[0]) * 0.5,
        (target[1] + focus[1]) * 0.5,
        (target[2] + focus[2]) * 0.5,
    ];
    let offset = [focus[0] - target[0], focus[1] - target[1]];
    let distance = offset[0].hypot(offset[1]).clamp(96.0, 512.0);
    let angle = if offset[0].abs() + offset[1].abs() > f64::EPSILON {
        offset[1].atan2(offset[0])
    } else {
        player.yaw.to_radians()
    };
    let (position, rotation, fov) = match style {
        HlaeCameraStyle::Pov => (
            CameraPosition {
                x: target[0],
                y: target[1],
                z: target[2],
            },
            CameraRotation {
                pitch: 0.0,
                yaw: normalized_yaw(player.yaw),
                roll: 0.0,
            },
            90.0,
        ),
        HlaeCameraStyle::Orbit => {
            let orbit = angle + TAU * phase / 4.0;
            let radius = (distance * 0.32).clamp(72.0, 128.0);
            let camera = [
                interaction[0] + radius * orbit.cos(),
                interaction[1] + radius * orbit.sin(),
                player.position[2] + 80.0,
            ];
            (camera_position(camera), look_at(camera, interaction), 78.0)
        }
        HlaeCameraStyle::Dolly => {
            let offset = (distance * 0.46).clamp(112.0, 192.0) - 20.0 * phase;
            let camera = [
                interaction[0] - offset * angle.cos(),
                interaction[1] - offset * angle.sin(),
                player.position[2] + 56.0,
            ];
            (camera_position(camera), look_at(camera, interaction), 72.0)
        }
        HlaeCameraStyle::Static => {
            let lateral = (distance * 0.22).clamp(64.0, 96.0);
            let rear = (distance * 0.34).clamp(96.0, 160.0);
            let camera = [
                anchor.position[0] - rear * angle.cos() - lateral * angle.sin(),
                anchor.position[1] - rear * angle.sin() + lateral * angle.cos(),
                anchor.position[2] + 92.0,
            ];
            (camera_position(camera), look_at(camera, interaction), 76.0)
        }
        HlaeCameraStyle::Tracking => {
            let lateral = (distance * 0.24).clamp(72.0, 112.0);
            let camera = [
                player.position[0] - 40.0 * angle.cos() - lateral * angle.sin(),
                player.position[1] - 40.0 * angle.sin() + lateral * angle.cos(),
                player.position[2] + 72.0,
            ];
            (camera_position(camera), look_at(camera, interaction), 80.0)
        }
        HlaeCameraStyle::Crane => {
            let offset = (distance * 0.38).clamp(112.0, 176.0) - 32.0 * progress;
            let camera = [
                interaction[0] - offset * angle.cos(),
                interaction[1] - offset * angle.sin(),
                player.position[2] + 48.0 + 176.0 * progress,
            ];
            (camera_position(camera), look_at(camera, interaction), 74.0)
        }
        HlaeCameraStyle::Flyby => {
            let travel = (distance * 0.72).clamp(240.0, 440.0);
            let longitudinal = -travel * 0.5 + travel * progress;
            let span = (distance * 0.24).clamp(72.0, 120.0);
            let lateral = span - span * 2.0 * progress;
            let camera = [
                interaction[0] + longitudinal * angle.cos() - lateral * angle.sin(),
                interaction[1] + longitudinal * angle.sin() + lateral * angle.cos(),
                player.position[2] + 72.0 + 20.0 * (PI * progress).sin(),
            ];
            (camera_position(camera), look_at(camera, interaction), 82.0)
        }
    };
    CameraKeyframe {
        tick,
        position,
        rotation,
        fov,
    }
}

pub(crate) fn engagement_focus(frame: &ReplayFrame, player: &ReplayPlayer) -> Option<[f64; 3]> {
    frame
        .players
        .iter()
        .filter(|candidate| {
            candidate.id != player.id
                && candidate.alive
                && !candidate.team.is_empty()
                && candidate.team != player.team
        })
        .min_by(|left, right| {
            planar_distance_squared(left.position, player.position)
                .total_cmp(&planar_distance_squared(right.position, player.position))
        })
        .map(|opponent| {
            [
                opponent.position[0],
                opponent.position[1],
                opponent.position[2] + 56.0,
            ]
        })
}

fn planar_distance_squared(left: [f64; 3], right: [f64; 3]) -> f64 {
    (left[0] - right[0]).powi(2) + (left[1] - right[1]).powi(2)
}

const fn camera_position(value: [f64; 3]) -> CameraPosition {
    CameraPosition {
        x: value[0],
        y: value[1],
        z: value[2],
    }
}

fn look_at(camera: [f64; 3], target: [f64; 3]) -> CameraRotation {
    let dx = target[0] - camera[0];
    let dy = target[1] - camera[1];
    let dz = target[2] - camera[2];
    CameraRotation {
        pitch: -dz.atan2(dx.hypot(dy)).to_degrees(),
        yaw: normalized_yaw(dy.atan2(dx).to_degrees()),
        roll: 0.0,
    }
}

fn normalized_yaw(value: f64) -> f64 {
    (value + 180.0).rem_euclid(360.0) - 180.0
}
