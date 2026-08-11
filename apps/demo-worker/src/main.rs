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
    DemoEngine, DemoError, ParseCancellation, heatmap_from_events, replay_frames_from_events,
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
struct WorkerRequest {
    version: u32,
    operation: WorkerOperation,
    demo_path: Option<String>,
    demo_id: Option<Uuid>,
    analysis: Option<MatchAnalysis>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum WorkerOperation {
    Analyze,
    Replay,
    Heatmap,
}

impl WorkerRequest {
    fn validate(&self) -> Result<(), WorkerFailure> {
        if self.version != 1 {
            return Err(invalid("unsupported worker protocol version"));
        }
        match self.operation {
            WorkerOperation::Analyze => {
                if self
                    .demo_path
                    .as_deref()
                    .is_none_or(|path| path.trim().is_empty())
                    || self.demo_id.is_none()
                {
                    return Err(invalid("analyze requires demo_path and demo_id"));
                }
            }
            WorkerOperation::Replay | WorkerOperation::Heatmap => {
                if self.analysis.is_none() {
                    return Err(invalid("replay and heatmap require analysis"));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
struct WorkerResponse {
    version: u32,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<WorkerFailure>,
}

impl WorkerResponse {
    fn success(result: Value) -> Self {
        Self {
            version: 1,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn failure(error: WorkerFailure) -> Self {
        Self {
            version: 1,
            ok: false,
            result: None,
            error: Some(error),
        }
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
    request.validate()?;
    Ok(request)
}

async fn execute(request: WorkerRequest) -> Result<Value, WorkerFailure> {
    match request.operation {
        WorkerOperation::Analyze => {
            let analysis = DemoEngine::default()
                .analyze(
                    request.demo_path.expect("validated demo_path"),
                    request.demo_id.expect("validated demo_id"),
                    ParseCancellation::default(),
                )
                .await
                .map_err(|error| demo_failure(&error))?;
            serde_json::to_value(analysis).map_err(|error| internal(&error))
        }
        WorkerOperation::Replay => {
            let events = analysis_events(request.analysis.expect("validated analysis"));
            let replay =
                replay_frames_from_events(&events).map_err(|error| demo_failure(&error))?;
            serde_json::to_value(replay).map_err(|error| internal(&error))
        }
        WorkerOperation::Heatmap => {
            let events = analysis_events(request.analysis.expect("validated analysis"));
            let heatmap = heatmap_from_events(&events).map_err(|error| demo_failure(&error))?;
            serde_json::to_value(heatmap).map_err(|error| internal(&error))
        }
    }
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
    fn request_validation_requires_operation_payloads() {
        let analyze = WorkerRequest {
            version: 1,
            operation: WorkerOperation::Analyze,
            demo_path: None,
            demo_id: Some(Uuid::new_v4()),
            analysis: None,
        };
        assert!(analyze.validate().is_err());

        let replay = WorkerRequest {
            version: 1,
            operation: WorkerOperation::Replay,
            demo_path: None,
            demo_id: None,
            analysis: None,
        };
        assert!(replay.validate().is_err());
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
}
