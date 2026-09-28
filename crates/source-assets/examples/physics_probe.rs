//! Read-only inspection of the local map resource used by the 3D feasibility study.
use std::{error::Error, time::Instant};

use vibe_cs_source_assets::{Kv3Value, VpkArchive, decode_physics_kv3, extract_world_geometry};

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: physics_probe MAP.vpk")?;
    let start = Instant::now();
    let archive = VpkArchive::open(path)?;
    for entry in archive
        .entries()
        .filter(|entry| entry.path().contains("physics") || entry.path().ends_with(".vphys_c"))
    {
        let bytes = archive.read(entry.path())?;
        println!(
            "{}: {} bytes, header {:02x?}",
            entry.path(),
            bytes.len(),
            &bytes[..bytes.len().min(96)]
        );
        if entry.path().ends_with(".vmdl_c") || entry.path().ends_with(".vphys_c") {
            let geometry = extract_world_geometry(&bytes)?;
            println!(
                "geometry: {} vertices, {} triangles, {} included / {} excluded shapes, {} bytes uncompressed",
                geometry.vertices.len(),
                geometry.triangles.len(),
                geometry.included_shapes,
                geometry.excluded_shapes,
                (geometry.vertices.len() + geometry.triangles.len()) * 12
            );
            let value = decode_physics_kv3(&bytes)?;
            if let Kv3Value::Object(fields) = value {
                for (name, value) in fields {
                    match value {
                        Kv3Value::Array(values) => {
                            println!("  {name}: {} entries", values.len());
                            if name == "m_collisionAttributes" {
                                for (index, value) in values.iter().enumerate() {
                                    if let Kv3Value::Object(attribute) = value {
                                        println!(
                                            "    {index}: group={:?} tags={:?}",
                                            attribute.get("m_CollisionGroupString"),
                                            attribute.get("m_InteractAsStrings")
                                        );
                                    }
                                }
                            }
                        }
                        value => println!("  {name}: {value:?}"),
                    }
                }
            }
        }
    }
    println!(
        "{} entries inspected in {:?}",
        archive.len(),
        start.elapsed()
    );
    Ok(())
}
