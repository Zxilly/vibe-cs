use std::f64::consts::{PI, TAU};

use vibe_cs_domain::{HlaeCameraStyle, ReplayFrame, ReplayPlayer};
use vibe_cs_hlae::{CameraKeyframe, CameraPosition, CameraRotation};

use vibe_cs_application::{CameraPoseDiagnostic, CameraPreview};
use vibe_cs_domain::DomainError;
use vibe_cs_hlae::{
    CAMERA_PREVIEW_FPS, CameraShot, PositionInterpolation, RotationInterpolation,
    sample_camera_shot,
};

#[derive(Debug)]
pub(crate) struct CameraScene {
    pub id: String,
    pub map_name: String,
    pub frames: Vec<ReplayFrame>,
    pub player_id: String,
    pub start_tick: u64,
    pub end_tick: u64,
    pub tick_rate: f64,
    pub style: HlaeCameraStyle,
    pub aspect_ratio: f64,
}

/// One planning authority for preview and recording. Geometry is advisory:
/// unavailable data leaves the requested shot intact and reports why.
pub(crate) fn plan_camera_scene(
    scene: &CameraScene,
    geometry: Result<&crate::CameraGeometry, String>,
) -> Result<CameraPreview, DomainError> {
    let shot = build_shot(scene, scene.style, 1.0, false)?;
    let samples = sample_camera_shot(&shot, scene.tick_rate, CAMERA_PREVIEW_FPS)
        .map_err(|error| DomainError::InvalidInput(error.to_string()))?;
    let mut result = CameraPreview {
        map_name: scene.map_name.clone(),
        tick_rate: scene.tick_rate,
        aspect_ratio: scene.aspect_ratio,
        requested_style: scene.style,
        effective_style: scene.style,
        adjusted: false,
        shot,
        samples,
        original_diagnostics: Vec::new(),
        diagnostics: Vec::new(),
        geometry_unavailable: None,
    };
    let geometry = match geometry {
        Ok(geometry) => geometry,
        Err(reason) => {
            result.geometry_unavailable = Some(reason);
            return Ok(result);
        }
    };
    result.diagnostics = geometry.diagnose(
        &result.samples,
        &scene.frames,
        &scene.player_id,
        scene.aspect_ratio,
    )?;
    result.original_diagnostics.clone_from(&result.diagnostics);
    // Retain the requested style when it already has no known issues. Otherwise
    // test a bounded, deterministic set, preferring the first equal-score plan.
    for (style, contraction) in [
        (scene.style, 0.6),
        (scene.style, 0.3),
        (scene.style, 0.1),
        (HlaeCameraStyle::Tracking, 0.6),
        (HlaeCameraStyle::Static, 0.3),
        (HlaeCameraStyle::Dolly, 0.3),
    ] {
        if diagnostic_score(&result.diagnostics) == (0, 0, 0, 0) {
            break;
        }
        consider_candidate(
            scene,
            geometry,
            &mut result,
            build_shot(scene, style, contraction, true)?,
            style,
        )?;
    }
    // Four dramatic control points can cut a corner traversed by the player.
    // A tracking alternative follows all observed waypoints instead of merely
    // shrinking that same unsafe spline. Every alternative is still sampled
    // and checked using the actual HLAE spline before it can be selected.
    for offset in [
        [-96.0, 0.0, 32.0],
        [0.0, -64.0, 32.0],
        [0.0, 64.0, 32.0],
        [64.0, 0.0, 32.0],
        [-32.0, 0.0, 16.0],
        [32.0, 0.0, 16.0],
        [0.0, -32.0, 16.0],
        [0.0, 32.0, 16.0],
        [-32.0, -32.0, 16.0],
        [-32.0, 32.0, 16.0],
        [32.0, -32.0, 16.0],
        [32.0, 32.0, 16.0],
    ] {
        if diagnostic_score(&result.diagnostics) == (0, 0, 0, 0) {
            break;
        }
        consider_candidate(
            scene,
            geometry,
            &mut result,
            tracking_shot(scene, offset),
            HlaeCameraStyle::Tracking,
        )?;
    }
    Ok(result)
}

fn consider_candidate(
    scene: &CameraScene,
    geometry: &crate::CameraGeometry,
    result: &mut CameraPreview,
    candidate: CameraShot,
    style: HlaeCameraStyle,
) -> Result<(), DomainError> {
    let samples = sample_camera_shot(&candidate, scene.tick_rate, CAMERA_PREVIEW_FPS)
        .map_err(|error| DomainError::InvalidInput(error.to_string()))?;
    let diagnostics = geometry.diagnose(
        &samples,
        &scene.frames,
        &scene.player_id,
        scene.aspect_ratio,
    )?;
    let candidate_score = diagnostic_score(&diagnostics);
    let current_score = diagnostic_score(&result.diagnostics);
    // Do not "fix" clearance by making visibility worse, or vice versa.
    if candidate_score != current_score
        && candidate_score.0 <= current_score.0
        && candidate_score.1 <= current_score.1
        && candidate_score.2 <= current_score.2
        && candidate_score.3 <= current_score.3
    {
        result.shot = candidate;
        result.samples = samples;
        result.diagnostics = diagnostics;
        result.effective_style = style;
        result.adjusted = true;
    }
    Ok(())
}

fn tracking_shot(scene: &CameraScene, offset: [f64; 3]) -> CameraShot {
    let mut keys = scene
        .frames
        .iter()
        .filter(|frame| (scene.start_tick..=scene.end_tick).contains(&frame.tick))
        .filter_map(|frame| {
            frame
                .players
                .iter()
                .find(|player| player.id == scene.player_id)
                .map(|player| (frame.tick, player))
        })
        .map(|(tick, player)| {
            let head = [
                player.position[0],
                player.position[1],
                player.position[2] + 64.0,
            ];
            let camera = [
                head[0] + offset[0],
                head[1] + offset[1],
                head[2] + offset[2],
            ];
            CameraKeyframe {
                tick,
                position: camera_position(camera),
                rotation: look_at(camera, head),
                fov: 80.0,
            }
        })
        .collect::<Vec<_>>();
    // The initial four-point planner already established at least four ordered observations.
    keys.first_mut()
        .expect("validated spatial observations")
        .tick = scene.start_tick;
    keys.last_mut()
        .expect("validated spatial observations")
        .tick = scene.end_tick;
    CameraShot {
        id: scene.id.clone(),
        start_tick: scene.start_tick,
        end_tick: scene.end_tick,
        position_interpolation: PositionInterpolation::Cubic,
        rotation_interpolation: RotationInterpolation::SphericalCubic,
        keyframes: keys,
    }
}

fn diagnostic_score(samples: &[CameraPoseDiagnostic]) -> (usize, usize, usize, usize) {
    // Crossing a surface takes precedence over clearance, then visibility.
    // These are counts on the same fixed-rate time samples, not probabilities.
    (
        samples.iter().filter(|item| item.crossed_surface).count(),
        samples.iter().filter(|item| item.near_wall).count(),
        samples
            .iter()
            .filter(|item| item.head_occluded == Some(true) && item.chest_occluded == Some(true))
            .count(),
        samples
            .iter()
            .filter(|item| item.target_in_view != Some(true))
            .count(),
    )
}

fn build_shot(
    scene: &CameraScene,
    style: HlaeCameraStyle,
    contraction: f64,
    target_framing: bool,
) -> Result<CameraShot, DomainError> {
    let candidates = scene
        .frames
        .iter()
        .filter(|frame| (scene.start_tick..=scene.end_tick).contains(&frame.tick))
        .filter_map(|frame| {
            frame
                .players
                .iter()
                .find(|player| player.id == scene.player_id)
                .map(|player| (frame.tick, (player, frame)))
        })
        .collect::<Vec<_>>();
    let selected = sample_four_frames(&candidates).ok_or_else(|| {
        DomainError::DependencyUnavailable(
            "this shot needs at least four spatial replay samples for camera movement".to_owned(),
        )
    })?;
    let duration = scene
        .end_tick
        .checked_sub(scene.start_tick)
        .ok_or_else(|| DomainError::InvalidInput("invalid camera tick range".to_owned()))?;
    let ticks = [
        scene.start_tick,
        scene.start_tick + duration / 3,
        scene.start_tick + duration.saturating_mul(2) / 3,
        scene.end_tick,
    ];
    let keyframes = selected
        .iter()
        .zip(ticks)
        .enumerate()
        .map(|(index, ((_, (player, frame)), tick))| {
            let mut key = camera_keyframe_for_scene(
                tick,
                player,
                selected[0].1.0,
                style,
                index,
                engagement_focus(frame, player),
            );
            if target_framing {
                let head = [
                    player.position[0],
                    player.position[1],
                    player.position[2] + 64.0,
                ];
                key.position = camera_position([
                    head[0] + (key.position.x - head[0]) * contraction,
                    head[1] + (key.position.y - head[1]) * contraction,
                    head[2] + (key.position.z - head[2]) * contraction,
                ]);
                key.rotation = look_at([key.position.x, key.position.y, key.position.z], head);
            }
            key
        })
        .collect();
    Ok(CameraShot {
        id: scene.id.clone(),
        start_tick: scene.start_tick,
        end_tick: scene.end_tick,
        position_interpolation: PositionInterpolation::Cubic,
        rotation_interpolation: RotationInterpolation::SphericalCubic,
        keyframes,
    })
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn simple_scene() -> CameraScene {
        CameraScene {
            id: "test".to_owned(),
            map_name: "synthetic".to_owned(),
            player_id: "target".to_owned(),
            start_tick: 100,
            end_tick: 148,
            tick_rate: 64.0,
            style: HlaeCameraStyle::Flyby,
            aspect_ratio: 16.0 / 9.0,
            frames: [100, 116, 132, 148]
                .into_iter()
                .map(|tick| ReplayFrame {
                    tick,
                    players: vec![ReplayPlayer {
                        id: "target".to_owned(),
                        name: "Target".to_owned(),
                        team: "T".to_owned(),
                        position: [0.0, 0.0, 0.0],
                        yaw: 0.0,
                        pitch: 0.0,
                        alive: true,
                        health: 100,
                        armor: 0,
                        weapon: String::new(),
                        input: None,
                    }],
                    projectiles: vec![],
                    bomb: None,
                })
                .collect(),
        }
    }

    #[test]
    fn correction_is_deterministic_and_preview_samples_belong_to_the_selected_recording_shot() {
        let geometry = crate::CameraGeometry::new(vibe_cs_source_assets::MapGeometry {
            vertices: vec![
                [-1024.0, -1024.0, 0.0],
                [1024.0, -1024.0, 0.0],
                [1024.0, 1024.0, 0.0],
                [-1024.0, 1024.0, 0.0],
            ],
            triangles: vec![[0, 1, 2], [0, 2, 3]],
            ..vibe_cs_source_assets::MapGeometry::default()
        })
        .unwrap();
        let scene = simple_scene();
        let planned = plan_camera_scene(&scene, Ok(&geometry)).unwrap();
        assert_eq!(planned, plan_camera_scene(&scene, Ok(&geometry)).unwrap());
        assert!(
            diagnostic_score(&planned.diagnostics)
                < diagnostic_score(&planned.original_diagnostics)
        );
        assert!(planned.adjusted);
        assert_eq!(
            planned.samples,
            sample_camera_shot(&planned.shot, scene.tick_rate, CAMERA_PREVIEW_FPS).unwrap()
        );
        if let Ok(path) = std::env::var("VIBE_CAMERA_SYNTHETIC_FIXTURE_OUTPUT") {
            let fixture = serde_json::to_string_pretty(&serde_json::json!({
                "preview": planned, "inspection": planned.inspection(),
            }))
            .unwrap();
            std::fs::write(
                path,
                format!("// Generated by the Rust camera planner; see README.md.\nimport type {{ CameraPreview, CameraInspection }} from '../../shared/desktop/dto';\n\nexport default {fixture} satisfies {{ preview: CameraPreview; inspection: CameraInspection }};\n"),
            )
            .unwrap();
        }
        let without_map = plan_camera_scene(&scene, Err("CS2 not installed".to_owned())).unwrap();
        assert!(!without_map.adjusted);
        assert_eq!(
            without_map.geometry_unavailable.as_deref(),
            Some("CS2 not installed")
        );
        assert!(without_map.diagnostics.is_empty());
        assert_eq!(
            without_map.shot,
            build_shot(&scene, scene.style, 1.0, false).unwrap()
        );
    }

    #[test]
    fn all_planning_callers_require_four_observed_camera_positions() {
        let mut scene = simple_scene();
        scene.frames.pop();
        assert!(
            plan_camera_scene(&scene, Err("no map".to_owned()))
                .unwrap_err()
                .to_string()
                .contains("four spatial")
        );
    }

    #[test]
    #[ignore = "requires VIBE_DENSE_REPLAY_JSON and VIBE_MAP_GEOMETRY"]
    fn real_major_camera_planning_repairs_flyby_and_crane() {
        let replay: vibe_cs_domain::ReplayArtifact = serde_json::from_slice(
            &std::fs::read(std::env::var("VIBE_DENSE_REPLAY_JSON").unwrap()).unwrap(),
        )
        .unwrap();
        let map = crate::CameraGeometry::new(
            vibe_cs_source_assets::decode_map_geometry(
                &std::fs::read(std::env::var("VIBE_MAP_GEOMETRY").unwrap()).unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        let player_id = replay
            .frames
            .iter()
            .flat_map(|frame| &frame.players)
            .find(|player| player.name == "FalleN")
            .unwrap()
            .id
            .clone();
        let mut results = Vec::new();
        for style in [HlaeCameraStyle::Flyby, HlaeCameraStyle::Crane] {
            let scene = CameraScene {
                id: format!("real_{style:?}"),
                map_name: "de_mirage".to_owned(),
                frames: replay.frames.clone(),
                player_id: player_id.clone(),
                start_tick: 160_800,
                end_tick: 161_310,
                tick_rate: replay.fidelity.tick_rate,
                style,
                aspect_ratio: 16.0 / 9.0,
            };
            let planned = plan_camera_scene(&scene, Ok(&map)).unwrap();
            let original = diagnostic_score(&planned.original_diagnostics);
            let corrected = diagnostic_score(&planned.diagnostics);
            eprintln!(
                "real {style:?}: original={original:?}, corrected={corrected:?}, effective={:?}",
                planned.effective_style
            );
            assert!(planned.adjusted);
            assert!(corrected < original);
            assert_eq!(
                corrected,
                (0, 0, 0, 0),
                "real corrected shot must pass all sampled geometric checks"
            );
            results.push(planned);
        }
        if let Ok(path) = std::env::var("VIBE_CAMERA_CORRECTIONS_OUTPUT") {
            std::fs::write(path, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
        }
    }

    #[test]
    #[ignore = "requires VIBE_DENSE_REPLAY_JSON from the real Major M1 extraction"]
    fn real_major_flyby_and_crane_use_the_hlae_camera_sampler() {
        use vibe_cs_hlae::{
            CameraShot, PositionInterpolation, RotationInterpolation, sample_camera_shot,
        };
        let replay: vibe_cs_domain::ReplayArtifact = serde_json::from_slice(
            &std::fs::read(std::env::var("VIBE_DENSE_REPLAY_JSON").unwrap()).unwrap(),
        )
        .unwrap();
        let start_tick = 160_800;
        let end_tick = 161_310;
        let candidates = replay
            .frames
            .iter()
            .filter(|frame| (start_tick..=end_tick).contains(&frame.tick))
            .filter_map(|frame| {
                frame
                    .players
                    .iter()
                    .find(|player| player.name == "FalleN")
                    .map(|player| (frame.tick, (player, frame)))
            })
            .collect::<Vec<_>>();
        let selected = sample_four_frames(&candidates).unwrap();
        let ticks = [start_tick, start_tick + 170, start_tick + 340, end_tick];
        let mut output = Vec::new();
        for style in [HlaeCameraStyle::Flyby, HlaeCameraStyle::Crane] {
            let shot = CameraShot {
                id: format!("real_{style:?}"),
                start_tick,
                end_tick,
                position_interpolation: PositionInterpolation::Cubic,
                rotation_interpolation: RotationInterpolation::SphericalCubic,
                keyframes: selected
                    .iter()
                    .zip(ticks)
                    .enumerate()
                    .map(|(index, ((_, (player, frame)), tick))| {
                        camera_keyframe_for_scene(
                            tick,
                            player,
                            selected[0].1.0,
                            style,
                            index,
                            engagement_focus(frame, player),
                        )
                    })
                    .collect(),
            };
            let samples = sample_camera_shot(&shot, replay.fidelity.tick_rate, 30).unwrap();
            assert_eq!(samples.len(), 241);
            assert!(
                samples
                    .iter()
                    .all(|sample| sample.quaternion.iter().all(|value| value.is_finite()))
            );
            assert!(samples.iter().all(|sample| sample.position.x.is_finite()
                && sample.position.y.is_finite()
                && sample.position.z.is_finite()));
            eprintln!(
                "real {:?}: {} samples, first={:?}, last={:?}",
                style,
                samples.len(),
                samples.first().unwrap().position,
                samples.last().unwrap().position
            );
            output.push(serde_json::json!({ "shot": shot, "samples": samples }));
        }
        if let Ok(path) = std::env::var("VIBE_CAMERA_PROBE_OUTPUT") {
            std::fs::write(path, serde_json::to_vec(&output).unwrap()).unwrap();
        }
    }
}
