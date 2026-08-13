use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::ExitCode,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;
use vibe_cs_demo::{
    DemoEngine, DemoEngineConfig, DemoError, DemoParserBackend, ParseCancellation,
    heatmap_from_events, replay_frames_from_events,
};
use vibe_cs_domain::{MatchAnalysis, TimelineEvent};

const MAXIMUM_REQUEST_BYTES: u64 = 8 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES: usize = 256 * 1024 * 1024;

#[tokio::main]
async fn main() -> ExitCode {
    let arguments = match Arguments::parse(std::env::args_os().skip(1)) {
        Ok(arguments) => arguments,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let response = match read_request(&arguments.input).await {
        Ok(request) => {
            let task = tokio::spawn(execute(request));
            match task.await {
                Ok(Ok(result)) => WorkerResponse::success(result),
                Ok(Err(error)) => WorkerResponse::failure(error),
                Err(error) => WorkerResponse::failure(WorkerFailure {
                    code: "internal_error".to_owned(),
                    message: if error.is_panic() {
                        "worker operation panicked".to_owned()
                    } else {
                        "worker operation was cancelled".to_owned()
                    },
                }),
            }
        }
        Err(error) => WorkerResponse::failure(error),
    };
    match write_response(&arguments.output, &response).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Arguments {
    input: PathBuf,
    output: PathBuf,
}

impl Arguments {
    fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        let values = arguments.into_iter().collect::<Vec<_>>();
        let mut input = None;
        let mut output = None;
        let mut index = 0;
        while index < values.len() {
            match values[index].to_string_lossy().as_ref() {
                "--input" => {
                    index += 1;
                    input = Some(PathBuf::from(
                        values.get(index).ok_or("--input requires a path")?,
                    ));
                }
                "--output" => {
                    index += 1;
                    output = Some(PathBuf::from(
                        values.get(index).ok_or("--output requires a path")?,
                    ));
                }
                unknown => return Err(format!("unknown argument: {unknown}")),
            }
            index += 1;
        }
        let input = input.ok_or("--input is required")?;
        let output = output.ok_or("--output is required")?;
        if input == output {
            return Err("input and output paths must differ".to_owned());
        }
        Ok(Self { input, output })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum WorkerRequest {
    Analyze { demo_path: String, demo_id: Uuid },
    Replay { analysis: MatchAnalysis },
    Heatmap { analysis: MatchAnalysis },
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum WorkerResponse {
    Success { result: Value },
    Failure { error: WorkerFailure },
}

impl WorkerResponse {
    fn success(result: Value) -> Self {
        Self::Success { result }
    }

    fn failure(error: WorkerFailure) -> Self {
        Self::Failure { error }
    }
}

#[derive(Debug, Clone, Serialize)]
struct WorkerFailure {
    code: String,
    message: String,
}

async fn read_request(path: &Path) -> Result<WorkerRequest, WorkerFailure> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| invalid(format!("unable to read request metadata: {error}")))?;
    if !metadata.is_file() || metadata.len() > MAXIMUM_REQUEST_BYTES {
        return Err(invalid("worker request is not a bounded regular file"));
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| invalid(format!("unable to open request: {error}")))?;
    let mut bytes =
        Vec::with_capacity(usize::try_from(metadata.len().min(MAXIMUM_REQUEST_BYTES)).unwrap_or(0));
    file.take(MAXIMUM_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| invalid(format!("unable to read request: {error}")))?;
    if bytes.len() > usize::try_from(MAXIMUM_REQUEST_BYTES).unwrap_or(usize::MAX) {
        return Err(invalid("worker request exceeds the size limit"));
    }
    let request: WorkerRequest = serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("invalid request JSON: {error}")))?;
    Ok(request)
}

async fn execute(request: WorkerRequest) -> Result<Value, WorkerFailure> {
    match request {
        WorkerRequest::Analyze { demo_path, demo_id } => {
            if demo_path.trim().is_empty() {
                return Err(invalid("analyze requires a non-empty demo_path"));
            }
            let backend = worker_backend(std::env::var("VIBE_CS_DEMO_BACKEND").ok().as_deref());
            let analysis = DemoEngine::new(DemoEngineConfig {
                backend,
                ..DemoEngineConfig::default()
            })
            .analyze(demo_path, demo_id, ParseCancellation::default())
            .await
            .map_err(|error| demo_failure(&error))?;
            serde_json::to_value(analysis).map_err(|error| internal(&error))
        }
        WorkerRequest::Replay { analysis } => {
            let events = analysis_events(analysis);
            let replay =
                replay_frames_from_events(&events).map_err(|error| demo_failure(&error))?;
            serde_json::to_value(replay).map_err(|error| internal(&error))
        }
        WorkerRequest::Heatmap { analysis } => {
            let events = analysis_events(analysis);
            let heatmap = heatmap_from_events(&events).map_err(|error| demo_failure(&error))?;
            serde_json::to_value(heatmap).map_err(|error| internal(&error))
        }
    }
}

fn worker_backend(configured: Option<&str>) -> DemoParserBackend {
    DemoParserBackend::from_environment_value(configured)
}

fn analysis_events(analysis: MatchAnalysis) -> Vec<TimelineEvent> {
    analysis
        .rounds
        .into_iter()
        .flat_map(|round| round.events)
        .collect()
}

async fn write_response(path: &Path, response: &WorkerResponse) -> Result<(), String> {
    if path.exists() {
        return Err("refusing to replace an existing worker result".to_owned());
    }
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or("worker result parent directory does not exist")?;
    let bytes = serde_json::to_vec(response).map_err(|error| error.to_string())?;
    if bytes.len() > MAXIMUM_RESPONSE_BYTES {
        return Err("worker result exceeds the size limit".to_owned());
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("result.json");
    let temporary = parent.join(format!(
        ".{file_name}.partial.{}.{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .await
            .map_err(|error| error.to_string())?;
        file.flush().await.map_err(|error| error.to_string())?;
        file.sync_all().await.map_err(|error| error.to_string())?;
        if path.exists() {
            return Err("worker result appeared before publication".to_owned());
        }
        tokio::fs::rename(&temporary, path)
            .await
            .map_err(|error| error.to_string())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

fn invalid(message: impl Into<String>) -> WorkerFailure {
    WorkerFailure {
        code: "invalid_input".to_owned(),
        message: message.into(),
    }
}

fn internal(error: &serde_json::Error) -> WorkerFailure {
    WorkerFailure {
        code: "internal_error".to_owned(),
        message: error.to_string(),
    }
}

fn demo_failure(error: &DemoError) -> WorkerFailure {
    let code = match error {
        DemoError::NotFound(_) => "not_found",
        DemoError::Unavailable { .. } => "dependency_unavailable",
        DemoError::Cancelled => "cancelled",
        DemoError::EventLimitExceeded { .. } | DemoError::ParserResourceLimit { .. } => {
            "resource_limit"
        }
        DemoError::ParserPanicked | DemoError::Join(_) | DemoError::Io { .. } => "internal_error",
        _ => "parse_error",
    };
    WorkerFailure {
        code: code.to_owned(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_shape_requires_exact_operation_payloads() {
        assert!(
            serde_json::from_value::<WorkerRequest>(serde_json::json!({
                "operation": "analyze",
                "demo_id": Uuid::new_v4()
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<WorkerRequest>(serde_json::json!({
                "operation": "replay"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<WorkerRequest>(serde_json::json!({
                "operation": "heatmap",
                "analysis": null,
                "unexpected": true
            }))
            .is_err()
        );
    }

    #[test]
    fn argument_parser_rejects_in_place_output() {
        let error = Arguments::parse([
            OsString::from("--input"),
            OsString::from("same.json"),
            OsString::from("--output"),
            OsString::from("same.json"),
        ])
        .expect_err("same path must fail");
        assert!(error.contains("differ"));
    }

    #[test]
    fn parser_resource_limits_have_a_stable_worker_code() {
        let failure = demo_failure(&DemoError::ParserResourceLimit {
            resource: "game events".to_owned(),
            limit: 10,
            actual: 11,
        });

        assert_eq!(failure.code, "resource_limit");
        assert!(
            failure
                .message
                .starts_with("demo parser resource limit exceeded")
        );
        assert!(!failure.message.starts_with("demo parser failed:"));
    }

    #[test]
    fn isolated_worker_defaults_fast_and_allows_only_an_explicit_cooperative_override() {
        assert_eq!(worker_backend(None), DemoParserBackend::Fast);
        assert_eq!(
            worker_backend(Some("cooperative")),
            DemoParserBackend::Cooperative
        );
        assert_eq!(worker_backend(Some("unknown")), DemoParserBackend::Fast);
        assert_eq!(worker_backend(Some("fast")), DemoParserBackend::Fast);
    }

    #[test]
    fn worker_rejects_analysis_without_current_total_tick_field() {
        let mut analysis = serde_json::to_value(MatchAnalysis {
            demo_id: Uuid::nil(),
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 120.0,
            verified_total_ticks: None,
            teams: Vec::new(),
            players: Vec::new(),
            rounds: Vec::new(),
            highlights: Vec::new(),
        })
        .expect("current analysis JSON");
        analysis
            .as_object_mut()
            .expect("analysis is an object")
            .remove("verified_total_ticks");
        let request = serde_json::from_value::<WorkerRequest>(serde_json::json!({
            "operation": "replay",
            "analysis": analysis
        }));
        assert!(request.is_err());
    }

    #[test]
    fn worker_request_preserves_parser_observed_spectator_slot() {
        let analysis = MatchAnalysis {
            demo_id: Uuid::nil(),
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 120.0,
            verified_total_ticks: None,
            teams: Vec::new(),
            players: vec![vibe_cs_domain::PlayerStats {
                steam_id: "76561198000000001".to_owned(),
                spectator_slot: Some(8),
                name: "Player One".to_owned(),
                team: "T".to_owned(),
                kills: 1,
                deaths: 0,
                assists: 0,
                headshots: 1,
                damage: 100,
                adr: 100.0,
                kill_death_ratio: 1.0,
                score: 2,
            }],
            rounds: Vec::new(),
            highlights: Vec::new(),
        };
        let request: WorkerRequest = serde_json::from_value(serde_json::json!({
            "operation": "replay",
            "analysis": analysis
        }))
        .expect("worker request with spectator slot");

        let WorkerRequest::Replay { analysis } = request else {
            panic!("expected replay request");
        };
        assert_eq!(analysis.players[0].spectator_slot, Some(8));
    }
}
