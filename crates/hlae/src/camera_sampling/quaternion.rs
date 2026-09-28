//! Safe, per-shot qspline implementation. Adapted from HLAE `AfxMath` (MIT) and
//! James Mc Ennan's qspline CC0. No global coefficient buffers or C++ runtime.
use crate::CameraRotation;

const EPSILON: f64 = 1.0e-6;
type Vector = [f64; 3];
type Quaternion = [f64; 4];

fn dot(left: Vector, right: Vector) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}
pub(super) fn dot4(left: Quaternion, right: Quaternion) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2] + left[3] * right[3]
}
fn cross(left: Vector, right: Vector) -> Vector {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}
fn unit(vector: Vector) -> (f64, Vector) {
    let length = dot(vector, vector).sqrt();
    (
        length,
        if length > 0.0 {
            vector.map(|value| value / length)
        } else {
            [0.0; 3]
        },
    )
}
fn multiply(left: Quaternion, right: Quaternion) -> Quaternion {
    [
        left[3] * right[0] + left[0] * right[3] + left[1] * right[2] - left[2] * right[1],
        left[3] * right[1] - left[0] * right[2] + left[1] * right[3] + left[2] * right[0],
        left[3] * right[2] + left[0] * right[1] - left[1] * right[0] + left[2] * right[3],
        left[3] * right[3] - left[0] * right[0] - left[1] * right[1] - left[2] * right[2],
    ]
}
pub(super) fn from_angles(rotation: CameraRotation) -> Quaternion {
    let (pitch_sin, pitch_cos) = (rotation.pitch.to_radians() * 0.5).sin_cos();
    let (yaw_sin, yaw_cos) = (rotation.yaw.to_radians() * 0.5).sin_cos();
    let (roll_sin, roll_cos) = (rotation.roll.to_radians() * 0.5).sin_cos();
    multiply(
        multiply(
            [0.0, 0.0, yaw_sin, yaw_cos],
            [0.0, pitch_sin, 0.0, pitch_cos],
        ),
        [roll_sin, 0.0, 0.0, roll_cos],
    )
}
fn angle_axis(start: Quaternion, end: Quaternion) -> (f64, Vector) {
    let relative = multiply([-start[0], -start[1], -start[2], start[3]], end);
    let (sine, axis) = unit([relative[0], relative[1], relative[2]]);
    (2.0 * sine.atan2(dot4(start, end)), axis)
}
fn rotate(start: Quaternion, vector: Vector) -> Quaternion {
    let (angle, axis) = unit(vector);
    let (sine, cosine) = (angle * 0.5).sin_cos();
    multiply(
        start,
        [axis[0] * sine, axis[1] * sine, axis[2] * sine, cosine],
    )
}
pub(super) fn slerp(start: Quaternion, end: Quaternion, amount: f64) -> Quaternion {
    let (angle, axis) = angle_axis(start, end);
    rotate(start, axis.map(|value| value * angle * amount))
}

// Transformation between coefficient vectors and body angular rate vectors.
fn transform(axis: Vector, angle: f64, to_rate: bool, input: Vector) -> Vector {
    if angle <= EPSILON {
        return input;
    }
    let (sine, cosine) = angle.sin_cos();
    let (first, second) = if to_rate {
        (sine / angle, (cosine - 1.0) / angle)
    } else {
        (0.5 * angle * sine / (1.0 - cosine), 0.5 * angle)
    };
    let along = dot(input, axis);
    let perpendicular = cross(axis, input);
    let normal = cross(perpendicular, axis);
    std::array::from_fn(|index| {
        along * axis[index] + first * normal[index] + second * perpendicular[index]
    })
}
fn rate_correction(axis: Vector, angle: f64, input: Vector) -> Vector {
    if angle <= EPSILON {
        return [0.0; 3];
    }
    let (sine, cosine) = angle.sin_cos();
    let normal = cross(cross(axis, input), axis);
    let along = dot(input, axis);
    let first = 0.5 * (dot(input, input) - along * along) * (angle - sine) / (1.0 - cosine);
    let second = along * (angle * sine - 2.0 * (1.0 - cosine)) / (angle * (1.0 - cosine));
    std::array::from_fn(|index| first * axis[index] + second * normal[index])
}

pub(super) struct QuaternionSpline {
    intervals: Vec<f64>,
    angles: Vec<f64>,
    axes: Vec<Vector>,
    rates: Vec<Vector>,
}
impl QuaternionSpline {
    pub(super) fn new(times: &[f64], rotations: &[Quaternion]) -> Self {
        let intervals = times
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .collect::<Vec<_>>();
        let (angles, axes): (Vec<_>, Vec<_>) = rotations
            .windows(2)
            .map(|pair| angle_axis(pair[0], pair[1]))
            .unzip();
        let count = times.len();
        let mut rates = vec![[0.0; 3]; count];
        let mut diagonal = vec![0.0; count];
        let mut lower = vec![0.0; count];
        let mut upper = vec![0.0; count];
        // HLAE calls maxit=2 with a do/while post-increment: up to THREE passes.
        for _ in 0..3 {
            let previous = rates.clone();
            for index in 1..count - 1 {
                lower[index] = 2.0 / intervals[index - 1];
                diagonal[index] = 4.0 / intervals[index - 1] + 4.0 / intervals[index];
                upper[index] = 2.0 / intervals[index];
                let correction =
                    rate_correction(axes[index - 1], angles[index - 1], previous[index]);
                rates[index] = std::array::from_fn(|axis| {
                    6.0 * (angles[index - 1] * axes[index - 1][axis] / intervals[index - 1].powi(2)
                        + angles[index] * axes[index][axis] / intervals[index].powi(2))
                        - correction[axis]
                });
            }
            // Endpoint angular rates are zero, so their RHS terms vanish.
            for index in 1..count - 2 {
                let factor = lower[index + 1] / diagonal[index];
                diagonal[index + 1] -= upper[index] * factor;
                let transformed = transform(axes[index], angles[index], true, rates[index]);
                for (axis, value) in transformed.iter().enumerate() {
                    rates[index + 1][axis] -= value * factor;
                }
            }
            rates[count - 2] = rates[count - 2].map(|value| value / diagonal[count - 2]);
            for index in (1..count - 2).rev() {
                let transformed = transform(axes[index], angles[index], false, rates[index + 1]);
                rates[index] = std::array::from_fn(|axis| {
                    (rates[index][axis] - upper[index] * transformed[axis]) / diagonal[index]
                });
            }
            let change = rates
                .iter()
                .zip(&previous)
                .map(|(now, before)| {
                    let difference = std::array::from_fn(|axis| now[axis] - before[axis]);
                    dot(difference, difference)
                })
                .sum::<f64>()
                .sqrt();
            if change <= EPSILON {
                break;
            }
        }
        Self {
            intervals,
            angles,
            axes,
            rates,
        }
    }

    pub(super) fn at(&self, index: usize, amount: f64, start: Quaternion) -> Quaternion {
        let interval = self.intervals[index];
        let finish = transform(
            self.axes[index],
            self.angles[index],
            false,
            self.rates[index + 1],
        );
        let displacement = std::array::from_fn(|axis| {
            let end = self.axes[index][axis] * self.angles[index];
            let first = self.rates[index][axis] * interval;
            let second = finish[axis] * interval - 3.0 * end;
            let previous = amount - 1.0;
            ((amount * end + previous * second) * amount + previous * previous * first) * amount
        });
        rotate(start, displacement)
    }
}
