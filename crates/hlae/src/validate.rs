use std::path::Path;

use crate::{
    CameraShot, HLAE_PLAN_SCHEMA_VERSION, HlaeError, HlaeNotice, HlaeNoticeCode, HlaePlan,
    HlaePlanMode,
};

const CS2_TICKS_PER_SECOND: u64 = 64;
const MAXIMUM_TICK: u64 = i32::MAX as u64;
const MAXIMUM_COORDINATE: f64 = 1_000_000.0;
const MAXIMUM_TOTAL_KEYFRAMES: usize = 32_768;

/// Validates an AI- or user-authored plan without compiling, writing, or executing it.
///
/// Successful validation includes non-blocking review notices for camera
/// spacing, capture behavior, and limitations that need an in-game preview.
///
/// # Errors
///
/// Returns [`HlaeError`] when any value is unsafe, unsupported, out of bounds,
/// or internally inconsistent.
pub fn validate_hlae_plan(plan: &HlaePlan) -> Result<Vec<HlaeNotice>, HlaeError> {
    if plan.schema_version != HLAE_PLAN_SCHEMA_VERSION {
        return invalid(format!(
            "unsupported schema version {}; expected {HLAE_PLAN_SCHEMA_VERSION}",
            plan.schema_version
        ));
    }
    validate_safe_path(&plan.demo_path, "demoPath", false)?;
    if !plan
        .demo_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("dem"))
    {
        return invalid("demoPath must have a .dem extension");
    }
    validate_safe_path(&plan.output_directory, "outputDirectory", true)?;
    if !(1..=1_000).contains(&plan.capture.fps) {
        return invalid("capture fps must be between 1 and 1000");
    }
    if !(320..=16_384).contains(&plan.capture.width)
        || !(240..=16_384).contains(&plan.capture.height)
    {
        return invalid("capture dimensions are outside the supported range");
    }
    if !plan.capture.layers.screen && !plan.capture.layers.world && !plan.capture.layers.depth {
        return invalid("at least one capture layer must be enabled");
    }
    if plan.shots.is_empty() || plan.shots.len() > 256 {
        return invalid("a plan must contain between 1 and 256 shots");
    }
    let total_keyframes = plan.shots.iter().try_fold(0_usize, |total, shot| {
        total.checked_add(shot.keyframes.len())
    });
    if total_keyframes.is_none_or(|total| total > MAXIMUM_TOTAL_KEYFRAMES) {
        return invalid(format!(
            "a plan may contain at most {MAXIMUM_TOTAL_KEYFRAMES} camera keyframes in total"
        ));
    }

    let mut notices = vec![HlaeNotice {
        code: HlaeNoticeCode::CameraCollisionNotChecked,
        message: "Camera coordinates cannot be checked against map geometry before HLAE preview"
            .to_owned(),
        shot_id: None,
    }];
    match plan.mode {
        HlaePlanMode::Preview => notices.push(HlaeNotice {
            code: HlaeNoticeCode::PreviewDoesNotRecord,
            message: "Preview mode draws camera paths but does not start recording".to_owned(),
            shot_id: None,
        }),
        HlaePlanMode::Capture => notices.push(HlaeNotice {
            code: HlaeNoticeCode::CaptureProducesImageSequences,
            message:
                "Capture mode uses the afxClassic image-sequence preset for native post-processing"
                    .to_owned(),
            shot_id: None,
        }),
    }

    let mut previous_end = None;
    for shot in &plan.shots {
        validate_shot(shot, &mut notices)?;
        if let Some(end) = previous_end {
            if shot.start_tick < end {
                return invalid("shots must be sorted and must not overlap");
            }
            if shot.start_tick > end {
                notices.push(HlaeNotice {
                    code: HlaeNoticeCode::ShotGap,
                    message: format!(
                        "Shot starts {} ticks after the previous shot; capture will retain the gap",
                        shot.start_tick - end
                    ),
                    shot_id: Some(shot.id.clone()),
                });
            }
        }
        previous_end = Some(shot.end_tick);
    }
    Ok(notices)
}

fn validate_shot(shot: &CameraShot, notices: &mut Vec<HlaeNotice>) -> Result<(), HlaeError> {
    if shot.id.is_empty()
        || shot.id.len() > 64
        || !shot
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return invalid("shot ids must be 1-64 ASCII letters, digits, '-' or '_'");
    }
    if shot.start_tick >= shot.end_tick || shot.end_tick > MAXIMUM_TICK {
        return invalid(format!("shot {} has an invalid tick range", shot.id));
    }
    if !(4..=4_096).contains(&shot.keyframes.len()) {
        return invalid(format!(
            "shot {} must contain between 4 and 4096 camera keyframes",
            shot.id
        ));
    }
    let mut previous_tick = None;
    for keyframe in &shot.keyframes {
        if keyframe.tick < shot.start_tick || keyframe.tick > shot.end_tick {
            return invalid(format!(
                "shot {} contains a keyframe outside its tick range",
                shot.id
            ));
        }
        if let Some(previous) = previous_tick {
            if keyframe.tick <= previous {
                return invalid(format!(
                    "shot {} keyframe ticks must be strictly increasing",
                    shot.id
                ));
            }
            if keyframe.tick - previous < CS2_TICKS_PER_SECOND {
                notices.push(HlaeNotice {
                    code: HlaeNoticeCode::ShortKeyframeGap,
                    message: format!(
                        "Adjacent camera keyframes are only {} ticks apart; HLAE recommends roughly 1-2 seconds",
                        keyframe.tick - previous
                    ),
                    shot_id: Some(shot.id.clone()),
                });
            }
        }
        previous_tick = Some(keyframe.tick);
        let values = [
            keyframe.position.x,
            keyframe.position.y,
            keyframe.position.z,
            keyframe.rotation.pitch,
            keyframe.rotation.yaw,
            keyframe.rotation.roll,
            keyframe.fov,
        ];
        if values.iter().any(|value| !value.is_finite()) {
            return invalid(format!(
                "shot {} contains a non-finite camera value",
                shot.id
            ));
        }
        if [
            keyframe.position.x,
            keyframe.position.y,
            keyframe.position.z,
        ]
        .iter()
        .any(|value| value.abs() > MAXIMUM_COORDINATE)
        {
            return invalid(format!(
                "shot {} contains an extreme camera position",
                shot.id
            ));
        }
        if !(1.0..=179.0).contains(&keyframe.fov) {
            return invalid(format!("shot {} fov must be between 1 and 179", shot.id));
        }
    }
    if shot.keyframes.first().map(|item| item.tick) != Some(shot.start_tick)
        || shot.keyframes.last().map(|item| item.tick) != Some(shot.end_tick)
    {
        return invalid(format!(
            "shot {} must have keyframes at its start and end ticks",
            shot.id
        ));
    }
    Ok(())
}

pub(crate) fn validate_safe_path(
    path: &Path,
    field: &'static str,
    require_absolute: bool,
) -> Result<(), HlaeError> {
    if path.as_os_str().is_empty() {
        return Err(HlaeError::UnsafePath {
            field,
            reason: "path is empty",
        });
    }
    if require_absolute && !path.is_absolute() {
        return Err(HlaeError::UnsafePath {
            field,
            reason: "path must be absolute",
        });
    }
    let rendered = path.to_string_lossy();
    if rendered
        .chars()
        .any(|character| character.is_control() || matches!(character, '"' | '\'' | ';' | '`'))
    {
        return Err(HlaeError::UnsafePath {
            field,
            reason: "quotes, command separators, backticks, and controls are forbidden",
        });
    }
    Ok(())
}

fn invalid<T>(message: impl Into<String>) -> Result<T, HlaeError> {
    Err(HlaeError::InvalidPlan(message.into()))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::{
        CameraKeyframe, CameraPosition, CameraRotation, CameraShot, CaptureSettings, HlaePlan,
        HlaePlanMode, PositionInterpolation, RotationInterpolation,
    };

    use super::*;

    fn valid_plan() -> HlaePlan {
        HlaePlan {
            schema_version: HLAE_PLAN_SCHEMA_VERSION,
            mode: HlaePlanMode::Preview,
            demo_path: PathBuf::from("match.dem"),
            output_directory: std::env::temp_dir().join("vibe-cs-hlae-output"),
            pre_roll_ticks: 128,
            capture: CaptureSettings::default(),
            shots: vec![CameraShot {
                id: "opening".to_owned(),
                start_tick: 1_000,
                end_tick: 1_300,
                position_interpolation: PositionInterpolation::Cubic,
                rotation_interpolation: RotationInterpolation::SphericalCubic,
                keyframes: [1_000, 1_100, 1_200, 1_300]
                    .into_iter()
                    .map(|tick| CameraKeyframe {
                        tick,
                        position: CameraPosition {
                            x: 1.0,
                            y: 2.0,
                            z: 3.0,
                        },
                        rotation: CameraRotation {
                            pitch: 1.0,
                            yaw: 2.0,
                            roll: 3.0,
                        },
                        fov: 90.0,
                    })
                    .collect(),
            }],
        }
    }

    #[test]
    fn accepts_a_bounded_typed_plan() {
        assert!(validate_hlae_plan(&valid_plan()).is_ok());
    }

    #[test]
    fn rejects_console_command_separators_in_paths() {
        let mut plan = valid_plan();
        plan.output_directory = PathBuf::from(r"C:\capture;quit");
        assert!(matches!(
            validate_hlae_plan(&plan),
            Err(HlaeError::UnsafePath { .. })
        ));
    }

    #[test]
    fn rejects_non_finite_ai_generated_values() {
        let mut plan = valid_plan();
        plan.shots[0].keyframes[0].fov = f64::NAN;
        assert!(validate_hlae_plan(&plan).is_err());
    }

    #[test]
    fn rejects_overlapping_shots() {
        let mut plan = valid_plan();
        let mut next = plan.shots[0].clone();
        next.id = "overlap".to_owned();
        next.start_tick = 1_200;
        next.end_tick = 1_500;
        for (keyframe, tick) in next.keyframes.iter_mut().zip([1_200, 1_300, 1_400, 1_500]) {
            keyframe.tick = tick;
        }
        plan.shots.push(next);
        assert!(validate_hlae_plan(&plan).is_err());
    }

    #[test]
    fn json_contract_rejects_ai_supplied_command_fields() {
        let mut value = serde_json::to_value(valid_plan()).unwrap();
        value["commands"] = serde_json::json!(["quit"]);
        assert!(serde_json::from_value::<HlaePlan>(value).is_err());
    }

    #[test]
    fn rejects_a_plan_that_exceeds_the_aggregate_keyframe_budget() {
        let mut plan = valid_plan();
        plan.shots.clear();
        for shot_index in 0..9_u64 {
            let start_tick = 1_000 + shot_index * 5_000;
            let end_tick = start_tick + 4_095;
            plan.shots.push(CameraShot {
                id: format!("shot_{shot_index}"),
                start_tick,
                end_tick,
                position_interpolation: PositionInterpolation::Cubic,
                rotation_interpolation: RotationInterpolation::SphericalCubic,
                keyframes: (start_tick..=end_tick)
                    .map(|tick| CameraKeyframe {
                        tick,
                        position: CameraPosition {
                            x: 1.0,
                            y: 2.0,
                            z: 3.0,
                        },
                        rotation: CameraRotation {
                            pitch: 1.0,
                            yaw: 2.0,
                            roll: 3.0,
                        },
                        fov: 90.0,
                    })
                    .collect(),
            });
        }

        assert!(matches!(
            validate_hlae_plan(&plan),
            Err(HlaeError::InvalidPlan(message)) if message.contains("at most 32768")
        ));
    }
}
