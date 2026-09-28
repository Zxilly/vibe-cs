use serde::Deserialize;
use vibe_cs_hlae::{
    CameraKeyframe, CameraPosition, CameraRotation, CameraShot, PositionInterpolation,
    RotationInterpolation, sample_camera_shot,
};

#[derive(Deserialize)]
struct Golden {
    upstream: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    tick_rate: f64,
    ticks: Vec<u64>,
    keys: Vec<[f64; 7]>,
    linear: bool,
    samples: Vec<[f64; 8]>,
}

impl Case {
    fn shot(&self) -> CameraShot {
        CameraShot {
            id: self.name.clone(),
            start_tick: 1_000,
            end_tick: 1_000 + self.ticks.last().unwrap(),
            position_interpolation: if self.linear {
                PositionInterpolation::Linear
            } else {
                PositionInterpolation::Cubic
            },
            rotation_interpolation: if self.linear {
                RotationInterpolation::SphericalLinear
            } else {
                RotationInterpolation::SphericalCubic
            },
            keyframes: self
                .ticks
                .iter()
                .zip(&self.keys)
                .map(|(tick, key)| CameraKeyframe {
                    tick: 1_000 + tick,
                    position: CameraPosition {
                        x: key[0],
                        y: key[1],
                        z: key[2],
                    },
                    rotation: CameraRotation {
                        pitch: key[3],
                        yaw: key[4],
                        roll: key[5],
                    },
                    fov: key[6],
                })
                .collect(),
        }
    }
}

fn golden() -> Golden {
    serde_json::from_str(include_str!("fixtures/campath-upstream.json")).unwrap()
}

#[test]
fn samples_match_the_independently_compiled_hlae_math() {
    let golden = golden();
    assert_eq!(golden.upstream, "b97636852b8eecae09285b5a386192bb285638eb");
    let mut checked = 0;
    for case in golden.cases {
        let samples = sample_camera_shot(&case.shot(), case.tick_rate, 30).unwrap();
        assert_eq!(samples.len(), case.samples.len());
        for (index, (sample, expected)) in samples.iter().zip(&case.samples).enumerate() {
            let actual = [
                sample.position.x,
                sample.position.y,
                sample.position.z,
                sample.quaternion[0],
                sample.quaternion[1],
                sample.quaternion[2],
                sample.quaternion[3],
                sample.fov,
            ];
            for (axis, (actual, expected)) in actual.into_iter().zip(expected).enumerate() {
                assert!(
                    (actual - expected).abs() < 2.0e-9,
                    "{} sample {index} component {axis}: Rust {actual}, HLAE {expected}",
                    case.name
                );
            }
            assert!(
                (sample
                    .quaternion
                    .iter()
                    .map(|value| value * value)
                    .sum::<f64>()
                    - 1.0)
                    .abs()
                    < 1.0e-10
            );
            checked += 1;
        }
        assert!((samples.first().unwrap().tick - 1000.0).abs() < f64::EPSILON);
        assert!(
            (samples.last().unwrap().tick
                - f64::from(u32::try_from(case.shot().end_tick).unwrap()))
            .abs()
                < 1.0e-9
        );
        assert!(samples.windows(2).all(|pair| pair[0].tick < pair[1].tick));
    }
    eprintln!("Compared {checked} camera poses against upstream HLAE");
}

#[test]
fn clamped_cubic_starts_and_ends_at_rest_and_is_reentrant() {
    let cases = golden().cases;
    let shot = cases[0].shot();
    let samples = sample_camera_shot(&shot, cases[0].tick_rate, 240).unwrap();
    // The first step is much smaller than a linear interpolation's constant speed.
    assert!((samples[1].position.x - samples[0].position.x).abs() < 0.01);
    let last = samples.len() - 1;
    assert!((samples[last].position.x - samples[last - 1].position.x).abs() < 0.01);
    let expected = samples.clone();
    std::thread::scope(|scope| {
        for _ in 0..4 {
            let shot = &shot;
            let expected = &expected;
            scope
                .spawn(move || assert_eq!(sample_camera_shot(shot, 64.0, 240).unwrap(), *expected));
        }
    });
}

#[test]
fn validates_requests_before_allocating_samples() {
    let mut shot = golden().cases[0].shot();
    for (tick_rate, fps) in [
        (f64::NAN, 30),
        (0.0, 30),
        (257.0, 30),
        (64.0, 0),
        (64.0, 241),
    ] {
        assert!(sample_camera_shot(&shot, tick_rate, fps).is_err());
    }
    shot.keyframes[1].tick = shot.start_tick;
    assert!(sample_camera_shot(&shot, 64.0, 30).is_err());
    shot = golden().cases[0].shot();
    shot.keyframes[1].position.x = f64::INFINITY;
    assert!(sample_camera_shot(&shot, 64.0, 30).is_err());
    shot = golden().cases[0].shot();
    shot.end_tick = 10_000_000;
    shot.keyframes.last_mut().unwrap().tick = shot.end_tick;
    assert!(sample_camera_shot(&shot, 64.0, 30).is_err());
}
