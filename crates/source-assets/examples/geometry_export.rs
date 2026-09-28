//! Export local world physics to VMAP and verify the exact persisted round trip.
use std::{error::Error, fs, path::Path, time::Instant};

use vibe_cs_source_assets::{
    VpkArchive, decode_map_geometry, encode_map_geometry, extract_world_geometry,
};

fn main() -> Result<(), Box<dyn Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("usage: geometry_export MAP.vpk OUTPUT.vmap".into());
    }
    let start = Instant::now();
    let map = Path::new(&args[0])
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("invalid map filename")?;
    let archive = VpkArchive::open(&args[0])?;
    let resource = archive.read(&format!("maps/{map}/world_physics.vmdl_c"))?;
    let geometry = extract_world_geometry(&resource)?;
    drop(resource);
    let encoded = encode_map_geometry(&geometry)?;
    let output = Path::new(&args[1]);
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, &encoded)?;
    let export_ms = start.elapsed().as_millis();
    let restored = decode_map_geometry(&fs::read(output)?)?;
    if restored != geometry {
        return Err("persisted geometry round trip differs".into());
    }
    println!(
        "{}",
        serde_json::json!({"map":map,"vertices":geometry.vertices.len(),"triangles":geometry.triangles.len(),"included_shapes":geometry.included_shapes,"excluded_shapes":geometry.excluded_shapes,"encoded_bytes":encoded.len(),"export_ms":export_ms,"roundtrip":"exact"})
    );
    Ok(())
}
