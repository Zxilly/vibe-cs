//! Opt-in comparison against observations from the installed HLAE inside CS2.
use super::*;

fn quaternion_error_degrees(left: [f64; 4], right: [f64; 4]) -> f64 {
    let unit = |value: [f64; 4]| {
        let length = value.iter().map(|axis| axis * axis).sum::<f64>().sqrt();
        value.map(|axis| axis / length)
    };
    let left = unit(left);
    let mut right = unit(right);
    if quaternion::dot4(left, right) < 0.0 {
        right = right.map(|axis| -axis);
    }
    let distance = left
        .into_iter()
        .zip(right)
        .map(|(a, b)| (a - b).powi(2))
        .sum::<f64>()
        .sqrt();
    (4.0 * (distance / 2.0).min(1.0).asin()).to_degrees()
}

#[test]
#[ignore = "requires VIBE_CAMPATH_GAME_PLANS and VIBE_CAMPATH_GAME_EVENTS from a real CS2/HLAE run"]
fn native_hlae_evaluations_and_active_game_views_match_rust_sampling() {
    let root = std::path::PathBuf::from(std::env::var_os("VIBE_CAMPATH_GAME_PLANS").unwrap());
    let manifest: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let events =
        std::fs::read_to_string(std::env::var_os("VIBE_CAMPATH_GAME_EVENTS").unwrap()).unwrap();
    let events = events
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(events.iter().any(|event| event["kind"] == "all_done"));
    assert!(manifest.len() >= 2);
    for probe in manifest {
        let id = probe["id"].as_str().unwrap();
        let plan: crate::HlaePlan =
            serde_json::from_slice(&std::fs::read(root.join(id).join("plan.json")).unwrap())
                .unwrap();
        let shot = &plan.shots[0];
        let path = SamplePath::new(shot, plan.tick_rate);
        let mut counts = [0; 3]; // native evaluation, active game view, pre-activation view
        let mut maxima = [[0.0_f64; 3]; 2]; // Source position distance, quaternion degrees, FOV degrees
        for event in events.iter().filter(|event| event["id"] == id) {
            let (group, time, position, rotation, fov) = match event["kind"].as_str().unwrap() {
                "sample" => (
                    0,
                    event["time"].as_f64().unwrap(),
                    std::array::from_fn(|axis| event["pos"][axis].as_f64().unwrap()),
                    std::array::from_fn(|axis| event["quaternion"][axis].as_f64().unwrap()),
                    event["fov"].as_f64().unwrap(),
                ),
                "view" => {
                    // The QA recorder can start before mirv_cmd activates the
                    // path. Those frames are explicitly counted, never compared
                    // as if the spectator's previous view came from this curve.
                    let Some(time) = event["pathTime"]
                        .as_f64()
                        .filter(|time| (0.0..=*path.times.last().unwrap()).contains(time))
                    else {
                        counts[2] += 1;
                        continue;
                    };
                    let view = &event["view"];
                    (
                        1,
                        time,
                        ["x", "y", "z"].map(|axis| view[axis].as_f64().unwrap()),
                        from_angles(CameraRotation {
                            pitch: view["rX"].as_f64().unwrap(),
                            yaw: view["rY"].as_f64().unwrap(),
                            roll: view["rZ"].as_f64().unwrap(),
                        }),
                        view["fov"].as_f64().unwrap(),
                    )
                }
                _ => continue,
            };
            let expected = path.at(time, 0.0);
            let error = [
                position
                    .into_iter()
                    .zip([
                        expected.position.x,
                        expected.position.y,
                        expected.position.z,
                    ])
                    .map(|(a, b)| (a - b).powi(2))
                    .sum::<f64>()
                    .sqrt(),
                quaternion_error_degrees(rotation, expected.quaternion),
                (fov - expected.fov).abs(),
            ];
            let tolerance = if group == 0 {
                [1e-8, 1e-7, 1e-8]
            } else {
                [0.001, 0.0001, 0.0001]
            };
            for axis in 0..3 {
                assert!(
                    error[axis] <= tolerance[axis],
                    "{id} group={group} time={time} axis={axis} error={} event={event}",
                    error[axis]
                );
                maxima[group][axis] = maxima[group][axis].max(error[axis]);
            }
            counts[group] += 1;
        }
        assert_eq!(
            counts[0],
            sample_camera_shot(shot, plan.tick_rate, 30).unwrap().len()
        );
        assert!(
            counts[1] >= 230,
            "{id}: insufficient active view observations"
        );
        assert!(counts[2] <= 10, "{id}: excessive pre-activation frames");
        eprintln!(
            "{id}: evaluations={} active_views={} pre_activation={} native_max_errors={:?} rendered_max_errors={:?}",
            counts[0], counts[1], counts[2], maxima[0], maxima[1]
        );
    }
}
