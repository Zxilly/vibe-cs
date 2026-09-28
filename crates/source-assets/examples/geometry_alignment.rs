//! Independent vertical-ray check over sampled, demo-proven grounded transitions.
use std::{error::Error, fs};

use vibe_cs_source_assets::{MapGeometry, VpkArchive, extract_world_geometry};

fn ground_below(geometry: &MapGeometry, point: [f64; 3], half_width: f64) -> Option<f64> {
    let mut highest: Option<f64> = None;
    for triangle in &geometry.triangles {
        let [a, b, c] = triangle.map(|index| geometry.vertices[index as usize].map(f64::from));
        let normal = [
            (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
            (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        ];
        let magnitude = normal.iter().map(|value| value * value).sum::<f64>().sqrt();
        if magnitude == 0.0 || normal[2].abs() / magnitude < 0.7 {
            continue;
        }
        let mut polygon = vec![a, b, c];
        for axis in 0..2 {
            for (boundary, sign) in [
                (point[axis] - half_width, 1.0),
                (point[axis] + half_width, -1.0),
            ] {
                if polygon.is_empty() {
                    break;
                }
                let mut clipped = Vec::new();
                let mut previous = *polygon.last().unwrap();
                for vertex in &polygon {
                    let before = (previous[axis] - boundary) * sign;
                    let after = (vertex[axis] - boundary) * sign;
                    if (before >= 0.0) != (after >= 0.0) {
                        let t = before / (before - after);
                        clipped.push(std::array::from_fn(|dimension| {
                            previous[dimension] + t * (vertex[dimension] - previous[dimension])
                        }));
                    }
                    if after >= 0.0 {
                        clipped.push(*vertex);
                    }
                    previous = *vertex;
                }
                polygon = clipped;
            }
        }
        let Some(z) = polygon
            .iter()
            .map(|vertex| vertex[2])
            .max_by(f64::total_cmp)
        else {
            continue;
        };
        if z <= point[2] + 16.0 && highest.is_none_or(|current| z > current) {
            highest = Some(z);
        }
    }
    highest
}

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
            errors.push(serde_json::json!({"sample": sample, "ground_z": ground, "error": error}));
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
