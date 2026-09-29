//! The sampling authority for HLAE preview and geometric diagnostics.
//! Spherical cubic follows advancedfx v2.191.1's qspline CC0 algorithm;
//! see `licenses/` and the fixture provenance in `tests/fixtures/`.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    CameraPosition, CameraRotation, CameraShot, HlaeError, PositionInterpolation,
    RotationInterpolation,
};

mod quaternion;
use quaternion::{QuaternionSpline, from_angles, slerp};

#[cfg(test)]
mod native_game_validation;

pub const CAMERA_PREVIEW_FPS: u32 = 30;
const MAXIMUM_SAMPLES: u32 = 100_000;

/// One Rust-sampled camera pose. Quaternion order is x, y, z, w, in Source axes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct CameraSample {
    pub time_seconds: f64,
    pub tick: f64,
    pub position: CameraPosition,
    pub quaternion: [f64; 4],
    pub fov: f64,
}

/// A validated shot sampled at a fixed presentation rate, including its endpoint.
/// Both diagnostic and display callers consume these poses, without resampling
/// the campath in JavaScript.
///
/// # Errors
/// Rejects invalid shots, tick rates, frame rates and oversized sample requests.
pub fn sample_camera_shot(
    shot: &CameraShot,
    tick_rate: f64,
    fps: u32,
) -> Result<Vec<CameraSample>, HlaeError> {
    if !tick_rate.is_finite() || !(1.0..=256.0).contains(&tick_rate) || !(1..=240).contains(&fps) {
        return Err(HlaeError::InvalidPlan(
            "camera sampling requires a valid tick rate and 1-240 fps".to_owned(),
        ));
    }
    crate::validate::validate_shot(shot, tick_rate, &mut Vec::new())?;
    let duration =
        f64::from(u32::try_from(shot.end_tick - shot.start_tick).unwrap_or(u32::MAX)) / tick_rate;
    let intervals = (duration * f64::from(fps)).ceil();
    if intervals >= f64::from(MAXIMUM_SAMPLES) {
        return Err(HlaeError::InvalidPlan(
            "camera preview exceeds its 100000 sample limit".to_owned(),
        ));
    }
    let path = SamplePath::new(shot, tick_rate);
    // The requested count is bounded above before this conversion.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let intervals = intervals as u32;
    let mut result = Vec::with_capacity(intervals as usize + 1);
    for index in 0..=intervals {
        let time = (f64::from(index) / f64::from(fps)).min(duration);
        result.push(path.at(
            time,
            f64::from(u32::try_from(shot.start_tick).unwrap_or(u32::MAX)) + time * tick_rate,
        ));
    }
    Ok(result)
}

/// The XML writer uses six decimal places. Share that quantization with the
/// sampler so non-power-of-two tick rates use the same knots as HLAE's loader.
pub(crate) fn serialized_camera_value(value: f64) -> f64 {
    value.trunc() + (value.fract() * 1_000_000.0).round() / 1_000_000.0
}

struct SamplePath {
    times: Vec<f64>,
    values: Vec<[f64; 4]>,
    slopes: Vec<[f64; 4]>,
    rotations: Vec<[f64; 4]>,
    spline: QuaternionSpline,
    position_mode: PositionInterpolation,
    rotation_mode: RotationInterpolation,
}

impl SamplePath {
    fn new(shot: &CameraShot, tick_rate: f64) -> Self {
        let times = shot
            .keyframes
            .iter()
            .map(|key| {
                serialized_camera_value(
                    f64::from(u32::try_from(key.tick - shot.start_tick).unwrap_or(u32::MAX))
                        / tick_rate,
                )
            })
            .collect::<Vec<_>>();
        let values = shot
            .keyframes
            .iter()
            .map(|key| {
                [key.position.x, key.position.y, key.position.z, key.fov]
                    .map(serialized_camera_value)
            })
            .collect::<Vec<_>>();
        let mut rotations = Vec::with_capacity(shot.keyframes.len());
        for key in &shot.keyframes {
            let mut quaternion = from_angles(CameraRotation {
                pitch: serialized_camera_value(key.rotation.pitch),
                yaw: serialized_camera_value(key.rotation.yaw),
                roll: serialized_camera_value(key.rotation.roll),
            });
            if rotations
                .last()
                .is_some_and(|previous| quaternion::dot4(*previous, quaternion) < 0.0)
            {
                quaternion = quaternion.map(|value| -value);
            }
            rotations.push(quaternion);
        }
        let slopes = clamped_slopes(&times, &values);
        let spline = QuaternionSpline::new(&times, &rotations);
        Self {
            times,
            values,
            slopes,
            rotations,
            spline,
            position_mode: shot.position_interpolation,
            rotation_mode: shot.rotation_interpolation,
        }
    }

    fn at(&self, time: f64, tick: f64) -> CameraSample {
        let end = self.times.len() - 1;
        let time = time.clamp(self.times[0], self.times[end]);
        let left = self
            .times
            .partition_point(|value| *value <= time)
            .saturating_sub(1)
            .min(end - 1);
        let interval = self.times[left + 1] - self.times[left];
        let amount = (time - self.times[left]) / interval;
        let mut values = [0.0; 4];
        for (axis, value) in values.iter_mut().enumerate() {
            *value = if axis < 3 && self.position_mode == PositionInterpolation::Linear {
                self.values[left][axis] * (1.0 - amount) + self.values[left + 1][axis] * amount
            } else {
                hermite(
                    self.values[left][axis],
                    self.values[left + 1][axis],
                    self.slopes[left][axis] * interval,
                    self.slopes[left + 1][axis] * interval,
                    amount,
                )
            };
        }
        let quaternion = match self.rotation_mode {
            RotationInterpolation::SphericalLinear => {
                slerp(self.rotations[left], self.rotations[left + 1], amount)
            }
            RotationInterpolation::SphericalCubic => {
                self.spline.at(left, amount, self.rotations[left])
            }
        };
        CameraSample {
            time_seconds: time,
            tick,
            position: CameraPosition {
                x: values[0],
                y: values[1],
                z: values[2],
            },
            quaternion,
            fov: values[3],
        }
    }
}

// Solve for first derivatives of the clamped C2 cubic spline. HLAE uses zero
// endpoint velocity for both position and FOV; it is not a natural spline or a
// Catmull-Rom curve. The tridiagonal system is evaluated once per shot.
fn clamped_slopes(times: &[f64], values: &[[f64; 4]]) -> Vec<[f64; 4]> {
    let count = times.len();
    let mut diagonal = vec![1.0; count];
    let mut upper = vec![0.0; count];
    let mut rhs = vec![[0.0; 4]; count];
    for index in 1..count - 1 {
        let before = times[index] - times[index - 1];
        let after = times[index + 1] - times[index];
        let factor = after / diagonal[index - 1];
        diagonal[index] = 2.0 * (before + after) - factor * upper[index - 1];
        upper[index] = before;
        for axis in 0..4 {
            rhs[index][axis] = 3.0
                * (after * (values[index][axis] - values[index - 1][axis]) / before
                    + before * (values[index + 1][axis] - values[index][axis]) / after)
                - factor * rhs[index - 1][axis];
        }
    }
    for index in (1..count - 1).rev() {
        rhs[index] = std::array::from_fn(|axis| {
            (rhs[index][axis] - upper[index] * rhs[index + 1][axis]) / diagonal[index]
        });
    }
    rhs
}

fn hermite(start: f64, end: f64, start_slope: f64, end_slope: f64, amount: f64) -> f64 {
    let square = amount * amount;
    let cube = square * amount;
    (2.0 * cube - 3.0 * square + 1.0) * start
        + (cube - 2.0 * square + amount) * start_slope
        + (-2.0 * cube + 3.0 * square) * end
        + (cube - square) * end_slope
}
