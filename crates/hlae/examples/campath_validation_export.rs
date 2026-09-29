//! Export real camera probes through the production compiler and sampler.
//! This developer utility never launches the game or executes console commands.
use std::{error::Error, fs, path::PathBuf};
use vibe_cs_hlae::{
    CameraShot, CaptureSettings, HlaePlan, HlaePlanMode, compile_hlae_plan, sample_camera_shot,
};

#[derive(serde::Deserialize)]
struct Probe {
    shot: CameraShot,
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        return Err(
            "usage: campath_validation_export PROBES.json DEMO.dem TICK_RATE NEW_OUTPUT_DIRECTORY"
                .into(),
        );
    }
    let probes: Vec<Probe> = serde_json::from_slice(&fs::read(&args[0])?)?;
    let tick_rate = args[2].parse::<f64>()?;
    let output = PathBuf::from(&args[3]);
    fs::create_dir(&output)?;
    let mut manifest = Vec::new();
    for probe in probes {
        let samples = sample_camera_shot(&probe.shot, tick_rate, 30)?;
        let directory = output.join(&probe.shot.id);
        let plan = HlaePlan {
            mode: HlaePlanMode::Preview,
            tick_rate,
            demo_path: PathBuf::from(&args[1]),
            output_directory: directory.join("capture"),
            pre_roll_ticks: 64,
            capture: CaptureSettings {
                fps: 30,
                width: 960,
                height: 540,
                record_wav: false,
                ..CaptureSettings::default()
            },
            presentation: vibe_cs_hlae::HlaeScenePresentation::default(),
            shots: vec![probe.shot],
        };
        let compiled = compile_hlae_plan(&plan, &directory)?;
        fs::create_dir(&directory)?;
        for artifact in std::iter::once(&compiled.bootstrap_config)
            .chain(std::iter::once(&compiled.command_system))
            .chain(&compiled.camera_paths)
        {
            fs::write(&artifact.path, &artifact.contents)?;
        }
        fs::write(
            directory.join("expected.json"),
            serde_json::to_vec_pretty(&samples)?,
        )?;
        fs::write(
            directory.join("plan.json"),
            serde_json::to_vec_pretty(&plan)?,
        )?;
        manifest.push(serde_json::json!({"id":plan.shots[0].id,"path":compiled.camera_paths[0].path,
            "commands":compiled.command_system.path,"startTick":compiled.first_tick,"endTick":compiled.last_tick,
            "sampleTimes":samples.iter().map(|sample| sample.time_seconds).collect::<Vec<_>>() }));
    }
    fs::write(
        output.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    println!(
        "Exported {} production campaths and sample arrays to {}",
        manifest.len(),
        output.display()
    );
    Ok(())
}
