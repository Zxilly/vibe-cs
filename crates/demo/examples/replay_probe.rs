//! Read-only real Demo validation for dense replay production extraction.
use std::{error::Error, fs, path::PathBuf, time::Instant};

use vibe_cs_demo::{ParseCancellation, ValidationLimits, extract_replay, validate_demo};
use vibe_cs_domain::{
    AnalysisInputFingerprint, MatchAnalysis, ReplayProjectilePhase, ReplayRequest,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.len() != 3 {
        return Err("usage: replay_probe DEMO ANALYSIS.json OUTPUT.json".into());
    }
    let path = PathBuf::from(&arguments[0]);
    let analysis: MatchAnalysis = serde_json::from_slice(&fs::read(&arguments[1])?)?;
    let cancellation = ParseCancellation::default();
    let validated = validate_demo(&path, ValidationLimits::default(), &cancellation)?;
    let start = Instant::now();
    let request = ReplayRequest::from_analysis(
        AnalysisInputFingerprint {
            sha256: validated.sha256,
            size: validated.size,
        },
        &analysis,
    )?;
    let replay =
        tokio::task::spawn_blocking(move || extract_replay(&path, &request, &cancellation))
            .await??;
    println!(
        "frames={} players={} flying={} effects={} nonzero_pitch={} elapsed_ms={}",
        replay.frames.len(),
        replay
            .frames
            .iter()
            .map(|frame| frame.players.len())
            .sum::<usize>(),
        replay
            .frames
            .iter()
            .map(|frame| frame
                .projectiles
                .iter()
                .filter(|projectile| projectile.phase == ReplayProjectilePhase::Flying)
                .count())
            .sum::<usize>(),
        replay
            .frames
            .iter()
            .map(|frame| frame
                .projectiles
                .iter()
                .filter(|projectile| projectile.phase == ReplayProjectilePhase::Effect)
                .count())
            .sum::<usize>(),
        replay
            .frames
            .iter()
            .flat_map(|frame| &frame.players)
            .filter(|player| player.pitch.abs() > 0.01)
            .count(),
        start.elapsed().as_millis()
    );
    fs::write(&arguments[2], serde_json::to_vec(&replay)?)?;
    Ok(())
}
