//! Independent vertical-ray check over sampled, demo-proven grounded transitions.
use std::{error::Error, fs};

use vibe_cs_source_assets::{MapGeometry, VpkArchive, extract_world_geometry};

#[path = "support/ground_alignment.rs"]
mod alignment;
use alignment::ground_below;

fn main() -> Result<(), Box<dyn Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("usage: geometry_alignment MAP.vpk LANDINGS.json".into());
    }
    let evidence: serde_json::Value = serde_json::from_slice(&fs::read(&args[1])?)?;
    let map = evidence["map_name"].as_str().ok_or("missing map name")?;
    let archive = VpkArchive::open(&args[0])?;
    let geometry =
        extract_world_geometry(&archive.read(&format!("maps/{map}/world_physics.vmdl_c"))?)?;
    let samples = evidence["samples"].as_array().ok_or("missing samples")?;
    let mut errors = Vec::new();
    let mut maximum: f64 = 0.0;
    for sample in samples {
        let flags = sample["flags"].as_u64().ok_or("missing flags")?;
        let before = sample["flags_before"]
            .as_u64()
            .ok_or("missing prior flags")?;
        if flags & 1 == 0 || before & 1 != 0 {
            return Err("sample is not an airborne-to-grounded transition".into());
        }
        let mut point = [0.0; 3];
        for (axis, coordinate) in point.iter_mut().enumerate() {
            *coordinate = sample["position"][axis]
                .as_f64()
                .ok_or("missing position")?;
        }
        let ground = ground_below(&geometry, point, 16.0);
        let error = ground.map_or(f64::INFINITY, |height| (height - point[2]).abs());
        maximum = maximum.max(error);
        if error >= 2.0 {
            let mut trace = Vec::new();
            if let Some(observations) = sample["following_observations"].as_array() {
                for observation in observations {
                    let mut position = [0.0; 3];
                    for (axis, coordinate) in position.iter_mut().enumerate() {
                        *coordinate = observation["position"][axis]
                            .as_f64()
                            .ok_or("missing trace position")?;
                    }
                    let surface = ground_below(&geometry, position, 16.0);
                    trace.push(serde_json::json!({
                        "tick": observation["tick"], "position": position,
                        "flags": observation["flags"], "ground_entity": observation["ground_entity"],
                        "alive": observation["alive"], "ground_z": surface,
                        "signed_offset": surface.map(|height| position[2] - height),
                    }));
                }
            }
            errors.push(serde_json::json!({
                "tick": sample["tick"], "steam_id": sample["steam_id"],
                "position": point, "ground_z": ground, "error": error,
                "following_observations": trace,
            }));
        }
    }
    println!(
        "map={map} samples={} maximum_hull_ground_error={maximum:.5} failed={}",
        samples.len(),
        errors.len()
    );
    for error in &errors {
        println!("{error}");
    }
    if !errors.is_empty() {
        return Err("ground alignment exceeds two game units".into());
    }
    Ok(())
}
