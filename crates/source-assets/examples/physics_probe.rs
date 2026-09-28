//! Read-only inspection of the local map resource used by the 3D feasibility study.
use std::{error::Error, time::Instant};

use vibe_cs_source_assets::VpkArchive;

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
    }
    println!(
        "{} entries inspected in {:?}",
        archive.len(),
        start.elapsed()
    );
    Ok(())
}
