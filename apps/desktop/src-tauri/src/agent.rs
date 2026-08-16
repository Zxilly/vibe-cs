use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Weak},
    time::Duration,
};

use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{State, ipc::Channel};
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;
use vibe_cs_agent::{
    AgentConfig as EmbeddedAgentConfig, AgentContext as EmbeddedAgentContext,
    AgentMode as EmbeddedAgentMode, AgentRequest as EmbeddedAgentRequest,
    AgentStreamEvent as EmbeddedAgentStreamEvent, AgentToolHost, Cancellation, CapturedPlanKind,
    HistoryMessage,
};
use vibe_cs_domain::{AnalysisRunStatus, RoundReplayArtifact};

use crate::bridge::{DesktopBridge, DesktopCall, DesktopMethod};

const MAXIMUM_THREAD_MESSAGES: usize = 80;
const MAXIMUM_THREAD_BYTES: usize = 1024 * 1024;
const TEXT_DELTA_BATCH_BYTES: usize = 256;
const MAXIMUM_STREAM_TEXT_EVENTS_BEFORE_FINAL: usize = 979;
const ROUND_REPLAY_ENVELOPE_BYTES: usize = 12;
const MAXIMUM_CINEMATIC_SAMPLES: usize = 16;

#[derive(Debug, Clone)]
struct CinematicHighlight {
    id: String,
    round: u32,
    start_tick: u64,
    end_tick: u64,
    player_id: String,
    engagements: Vec<CinematicEngagement>,
}

#[derive(Debug, Clone)]
struct CinematicEngagement {
    tick: u64,
    target_id: String,
    target_position: [f64; 3],
}

#[derive(Debug)]
struct CinematicReplayHost {
    storage: vibe_cs_storage::Storage,
    dispatcher: DesktopBridge,
    demo_id: Uuid,
    highlights: HashMap<String, CinematicHighlight>,
    replay_cache: Mutex<HashMap<u32, Arc<RoundReplayArtifact>>>,
}

impl CinematicReplayHost {
    fn new(
        storage: vibe_cs_storage::Storage,
        dispatcher: DesktopBridge,
        demo_id: Uuid,
        analysis: &Value,
    ) -> Self {
        let highlights = analysis
            .get("highlights")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|highlight| {
                let id = highlight.get("id")?.as_str()?.to_owned();
                let round = u32::try_from(highlight.get("round")?.as_u64()?).ok()?;
                let start_tick = highlight.get("start_tick")?.as_u64()?;
                let end_tick = highlight.get("end_tick")?.as_u64()?;
                let player_id = highlight.get("player_id")?.as_str()?.to_owned();
                let engagements = analysis
                    .get("rounds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|candidate| {
                        candidate.get("number").and_then(Value::as_u64) == Some(u64::from(round))
                    })
                    .and_then(|value| value.get("events"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|event| {
                        let tick = event.get("tick")?.as_u64()?;
                        (event.get("kind").and_then(Value::as_str) == Some("kill")
                            && event.get("actor").and_then(Value::as_str)
                                == Some(player_id.as_str())
                            && tick >= start_tick
                            && tick <= end_tick)
                            .then_some(())?;
                        Some(CinematicEngagement {
                            tick,
                            target_id: event.get("target")?.as_str()?.to_owned(),
                            target_position: json_position(event.get("position")?)?,
                        })
                    })
                    .collect();
                let descriptor = CinematicHighlight {
                    id,
                    round,
                    start_tick,
                    end_tick,
                    player_id,
                    engagements,
                };
                Some((descriptor.id.clone(), descriptor))
            })
            .collect();
        Self {
            storage,
            dispatcher,
            demo_id,
            highlights,
            replay_cache: Mutex::new(HashMap::new()),
        }
    }

    async fn round_replay(&self, round: u32) -> Result<Arc<RoundReplayArtifact>, String> {
        if let Some(cached) = self.replay_cache.lock().await.get(&round).cloned() {
            return Ok(cached);
        }
        let runs = self
            .storage
            .list_analysis_runs(self.demo_id)
            .await
            .map_err(|error| format!("unable to list analysis runs: {error}"))?;
        let run = runs
            .into_iter()
            .filter(|run| run.status == AnalysisRunStatus::Completed)
            .max_by_key(|run| run.created_at)
            .ok_or_else(|| {
                "no completed analysis run is available for replay evidence".to_owned()
            })?;
        let path = format!("/analysis-runs/{}/replay/rounds/{round}/replay.bin", run.id);
        let bytes = self
            .dispatcher
            .dispatch_binary(&path)
            .await
            .map_err(|error| format!("unable to read selected-round replay: {error:?}"))?;
        let artifact = decode_round_replay_envelope(&bytes)?;
        if artifact.metadata.producer_run_id != run.id
            || artifact.metadata.demo_id != self.demo_id
            || artifact.metadata.round != round
        {
            return Err("selected-round replay identity does not match the request".to_owned());
        }
        let artifact = Arc::new(artifact);
        self.replay_cache
            .lock()
            .await
            .insert(round, artifact.clone());
        Ok(artifact)
    }
}

#[async_trait]
impl AgentToolHost for CinematicReplayHost {
    async fn read_cinematic_context(&self, highlight_ids: &[String]) -> Result<Value, String> {
        let mut scenes = Vec::new();
        for id in highlight_ids {
            let Some(highlight) = self.highlights.get(id) else {
                continue;
            };
            let artifact = self.round_replay(highlight.round).await?;
            scenes.push(cinematic_scene_from_replay(highlight, &artifact));
        }
        Ok(json!({ "scenes": scenes }))
    }
}

fn decode_round_replay_envelope(bytes: &[u8]) -> Result<RoundReplayArtifact, String> {
    if bytes.len() < ROUND_REPLAY_ENVELOPE_BYTES || &bytes[..4] != b"RRPL" {
        return Err("selected-round replay has an invalid envelope".to_owned());
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    let flags = u16::from_le_bytes([bytes[6], bytes[7]]);
    let payload_length = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    if version != 1 || flags != 0 || payload_length != bytes.len() - ROUND_REPLAY_ENVELOPE_BYTES {
        return Err("selected-round replay has an unsupported envelope".to_owned());
    }
    serde_json::from_slice(&bytes[ROUND_REPLAY_ENVELOPE_BYTES..])
        .map_err(|error| format!("invalid selected-round replay payload: {error}"))
}

fn cinematic_scene_from_replay(
    highlight: &CinematicHighlight,
    artifact: &RoundReplayArtifact,
) -> Value {
    let start_tick = highlight.start_tick.max(artifact.metadata.start_tick);
    let end_tick = highlight.end_tick.min(artifact.metadata.end_tick);
    let eligible = artifact
        .frames
        .iter()
        .filter(|frame| frame.tick >= start_tick && frame.tick <= end_tick)
        .filter(|frame| {
            frame
                .players
                .iter()
                .any(|player| player.steam_id == highlight.player_id)
        })
        .collect::<Vec<_>>();
    let selected_indices = evenly_spaced_indices(eligible.len(), MAXIMUM_CINEMATIC_SAMPLES);
    let positioned = selected_indices
        .into_iter()
        .filter_map(|index| {
            let frame = eligible.get(index)?;
            let player = frame
                .players
                .iter()
                .find(|player| player.steam_id == highlight.player_id)?;
            let opponent = frame
                .players
                .iter()
                .filter(|candidate| {
                    candidate.alive
                        && candidate.steam_id != player.steam_id
                        && candidate.team != player.team
                })
                .min_by(|left, right| {
                    horizontal_distance(player.position, left.position)
                        .total_cmp(&horizontal_distance(player.position, right.position))
                });
            Some(json!({
                "tick": frame.tick,
                "kind": "player_sample",
                "actor": player.steam_id,
                "position": player.position,
                "yaw": player.yaw,
                "alive": player.alive,
                "nearestOpponentPosition": opponent.map(|value| value.position),
                "nearestOpponentId": opponent.map(|value| value.steam_id.as_str()),
                "nearestOpponentDistanceUnits": opponent.map(|value| horizontal_distance(player.position, value.position)),
            }))
        })
        .collect::<Vec<_>>();
    let verified_engagements = highlight
        .engagements
        .iter()
        .filter_map(|engagement| {
            let frame = artifact
                .frames
                .iter()
                .min_by_key(|frame| frame.tick.abs_diff(engagement.tick))?;
            let player = frame
                .players
                .iter()
                .find(|player| player.steam_id == highlight.player_id)?;
            let axis = [
                engagement.target_position[0] - player.position[0],
                engagement.target_position[1] - player.position[1],
                engagement.target_position[2] - player.position[2],
            ];
            Some(json!({
                "tick": engagement.tick,
                "target": engagement.target_id,
                "playerPosition": player.position,
                "targetPosition": engagement.target_position,
                "axis": axis,
                "distanceUnits": horizontal_distance(player.position, engagement.target_position),
            }))
        })
        .collect::<Vec<_>>();
    json!({
        "highlightId": highlight.id,
        "positionedAction": positioned,
        "verifiedEngagements": verified_engagements,
        "fidelity": {
            "source": "selected_round_replay",
            "round": artifact.metadata.round,
            "artifactStartTick": artifact.metadata.start_tick,
            "artifactEndTick": artifact.metadata.end_tick,
            "requestedStartTick": highlight.start_tick,
            "requestedEndTick": highlight.end_tick,
            "effectiveStartTick": start_tick,
            "effectiveEndTick": end_tick,
            "sampleIntervalTicks": artifact.metadata.sample_interval_ticks,
            "acceptedTickCount": artifact.metadata.accepted_tick_count,
            "targetFrameCount": eligible.len(),
            "returnedSampleCount": positioned.len(),
            "clampedToArtifactEnd": highlight.end_tick > artifact.metadata.end_tick,
        }
    })
}

fn json_position(value: &Value) -> Option<[f64; 3]> {
    let values = value.as_array()?;
    Some([
        values.first()?.as_f64()?,
        values.get(1)?.as_f64()?,
        values.get(2)?.as_f64()?,
    ])
}

fn evenly_spaced_indices(length: usize, maximum: usize) -> Vec<usize> {
    if length <= maximum {
        return (0..length).collect();
    }
    (0..maximum)
        .map(|index| index * (length - 1) / (maximum - 1))
        .collect()
}

fn horizontal_distance(left: [f64; 3], right: [f64; 3]) -> f64 {
    (right[0] - left[0]).hypot(right[1] - left[1])
}

#[derive(Debug, Clone)]
pub(crate) struct AgentBridge {
    storage: vibe_cs_storage::Storage,
    data_dir: PathBuf,
    dispatcher: DesktopBridge,
    audio_cache: Arc<Mutex<HashMap<String, Value>>>,
    audio_gate: Arc<Semaphore>,
    chat_gate: Arc<Semaphore>,
    thread_locks: Arc<Mutex<HashMap<Uuid, Weak<Mutex<()>>>>>,
    cancellations: Arc<Mutex<HashMap<Uuid, Arc<Cancellation>>>>,
}

impl AgentBridge {
    pub(crate) fn new(
        storage: vibe_cs_storage::Storage,
        data_dir: PathBuf,
        dispatcher: DesktopBridge,
    ) -> Self {
        Self {
            storage,
            data_dir,
            dispatcher,
            audio_cache: Arc::new(Mutex::new(HashMap::new())),
            audio_gate: Arc::new(Semaphore::new(1)),
            chat_gate: Arc::new(Semaphore::new(2)),
            thread_locks: Arc::new(Mutex::new(HashMap::new())),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn thread_path(&self, thread_id: Uuid) -> PathBuf {
        self.data_dir
            .join("agent")
            .join("threads")
            .join(format!("{thread_id}.json"))
    }

    async fn load_thread(&self, thread_id: Uuid) -> Result<AgentThread, AgentCommandError> {
        let path = self.thread_path(thread_id);
        match tokio::fs::read(&path).await {
            Ok(bytes) if bytes.len() <= MAXIMUM_THREAD_BYTES => serde_json::from_slice(&bytes)
                .map_err(|error| {
                    AgentCommandError::internal(format!("invalid local agent thread: {error}"))
                }),
            Ok(_) => Err(AgentCommandError::internal(
                "local agent thread is too large",
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AgentThread {
                id: thread_id,
                messages: Vec::new(),
                updated_at: Utc::now().to_rfc3339(),
            }),
            Err(error) => Err(AgentCommandError::internal(format!(
                "unable to read local agent thread: {error}"
            ))),
        }
    }

    async fn save_thread(&self, thread: &mut AgentThread) -> Result<(), AgentCommandError> {
        let path = self.thread_path(thread.id);
        let parent = path
            .parent()
            .ok_or_else(|| AgentCommandError::internal("invalid agent thread path"))?;
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            AgentCommandError::internal(format!("unable to create agent thread directory: {error}"))
        })?;
        let bytes = serialize_bounded_thread(thread)?;
        tokio::task::spawn_blocking(move || vibe_cs_platform_windows::atomic_write(&path, &bytes))
            .await
            .map_err(|error| {
                AgentCommandError::internal(format!(
                    "agent thread persistence task failed: {error}"
                ))
            })?
            .map_err(|error| {
                AgentCommandError::internal(format!("unable to persist agent thread: {error}"))
            })
    }

    async fn analyze_audio(&self, asset_id: Uuid) -> Result<Value, AgentCommandError> {
        let asset = self
            .storage
            .get_asset(asset_id)
            .await
            .map_err(|error| {
                AgentCommandError::internal(format!("unable to read selected BGM: {error}"))
            })?
            .ok_or_else(|| AgentCommandError::invalid("selected BGM asset does not exist"))?;
        let metadata = tokio::fs::metadata(&asset.path).await.map_err(|error| {
            AgentCommandError::invalid(format!("selected BGM is unavailable: {error}"))
        })?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |value| value.as_nanos());
        let key = format!(
            "{asset_id}:{}:{}:{modified}:default",
            asset.path,
            metadata.len()
        );
        if let Some(cached) = self.audio_cache.lock().await.get(&key).cloned() {
            return Ok(cached);
        }
        let _permit =
            self.audio_gate.acquire().await.map_err(|_| {
                AgentCommandError::unavailable("audio analysis scheduler is closed")
            })?;
        if let Some(cached) = self.audio_cache.lock().await.get(&key).cloned() {
            return Ok(cached);
        }
        let analysis = self
            .dispatcher
            .dispatch(DesktopCall {
                method: DesktopMethod::Get,
                path: format!("/media/assets/{asset_id}/audio-analysis"),
                body: None,
            })
            .await
            .map_err(|error| {
                AgentCommandError::invalid(format!("unable to analyze selected BGM: {error:?}"))
            })?;
        let mut cache = self.audio_cache.lock().await;
        if cache.len() >= 16 {
            cache.clear();
        }
        cache.insert(key, analysis.clone());
        Ok(analysis)
    }

    async fn thread_lock(&self, thread_id: Uuid) -> Arc<Mutex<()>> {
        let mut locks = self.thread_locks.lock().await;
        if let Some(lock) = locks.get(&thread_id).and_then(Weak::upgrade) {
            return lock;
        }
        if locks.len() >= 256 {
            locks.retain(|_, lock| lock.strong_count() > 0);
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(thread_id, Arc::downgrade(&lock));
        lock
    }
}

fn serialize_bounded_thread(thread: &mut AgentThread) -> Result<Vec<u8>, AgentCommandError> {
    loop {
        let serialized = serde_json::to_vec(&thread).map_err(|error| {
            AgentCommandError::internal(format!("unable to serialize agent thread: {error}"))
        })?;
        if serialized.len() <= MAXIMUM_THREAD_BYTES {
            return Ok(serialized);
        }
        if thread.messages.len() <= 2 {
            return Err(AgentCommandError::invalid(
                "agent response exceeds the local thread size limit",
            ));
        }
        thread.messages.drain(..thread.messages.len().min(2));
    }
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DesktopAgentStatus")]
pub(crate) struct AgentStatus {
    runtime_available: bool,
    configured: bool,
    provider: String,
    model: String,
    streaming: bool,
}

/// Who wrote a message in the desktop chat transcript.
///
/// Two values. It was a `String` beside `HistoryMessage.role`, which is the
/// LLM API's own role field and genuinely open — that one carries `system` and
/// `tool` as well. This one is only ever the two the transcript renders, and
/// the renderer was already switching on exactly those.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "DesktopAgentRole")]
pub(crate) enum AgentRole {
    User,
    Assistant,
}

impl AgentRole {
    const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentMessage")]
pub(crate) struct AgentMessage {
    id: Uuid,
    role: AgentRole,
    content: String,
    created_at: String,
    tool_calls: Vec<AgentToolCall>,
    proposals: Vec<AgentProposal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentThread")]
pub(crate) struct AgentThread {
    id: Uuid,
    messages: Vec<AgentMessage>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentToolCall")]
pub(crate) struct AgentToolCall {
    name: String,
    input: Value,
    output: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentProposal")]
pub(crate) struct AgentProposal {
    kind: CapturedPlanKind,
    title: String,
    payload: Value,
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentChatInput")]
pub(crate) struct AgentChatInput {
    request_id: Uuid,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    thread_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    demo_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    editor_project_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    audio_asset_id: Option<Uuid>,
    workspace_context: AgentWorkspaceContext,
    mode: EmbeddedAgentMode,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentWorkspaceContext")]
pub(crate) struct AgentWorkspaceContext {
    pub(crate) workflow: AgentWorkspaceWorkflow,
    pub(crate) destination: AgentWorkspaceDestination,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) demo_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) project_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) player_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) round_number: Option<u16>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) tick: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "DesktopAgentWorkspaceWorkflow")]
pub(crate) enum AgentWorkspaceWorkflow {
    Review,
    Edit,
    Neutral,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "DesktopAgentWorkspaceDestination")]
pub(crate) enum AgentWorkspaceDestination {
    Review,
    Players,
    Evidence,
    Replay,
    Heatmap,
    Edit,
    Queue,
    Studio,
    Outputs,
    Neutral,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
#[ts(export, rename = "DesktopAgentEvent")]
pub(crate) enum AgentEvent {
    Started { thread_id: Uuid },
    TextDelta { delta: String },
    ToolCall { tool_call: AgentToolCall },
    Proposal { proposal: AgentProposal },
    Complete { thread: AgentThread },
    Error { message: String },
}

impl From<vibe_cs_agent::CapturedToolCall> for AgentToolCall {
    fn from(value: vibe_cs_agent::CapturedToolCall) -> Self {
        Self {
            name: value.name,
            input: value.input,
            output: value.output,
        }
    }
}

impl From<vibe_cs_agent::CapturedPlan> for AgentProposal {
    fn from(value: vibe_cs_agent::CapturedPlan) -> Self {
        Self {
            kind: value.kind,
            title: value.title,
            payload: value.payload,
        }
    }
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export, rename = "DesktopAgentChatResult")]
pub(crate) struct AgentChatResult {
    thread_id: Uuid,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export, rename = "DesktopAgentCommandError")]
pub(crate) struct AgentCommandError {
    status: u16,
    code: String,
    message: String,
}

impl AgentCommandError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code: "invalid_agent_request".to_owned(),
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: 503,
            code: "agent_unavailable".to_owned(),
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 500,
            code: "agent_failed".to_owned(),
            message: message.into(),
        }
    }
}

#[tauri::command]
pub(crate) async fn agent_status(
    state: State<'_, AgentBridge>,
) -> Result<AgentStatus, AgentCommandError> {
    status(&state).await
}

async fn status(state: &AgentBridge) -> Result<AgentStatus, AgentCommandError> {
    let (config, api_key) = resolved_agent_config(state).await?;
    Ok(AgentStatus {
        runtime_available: true,
        configured: !api_key.is_empty()
            && !config.llm.model.is_empty()
            && !config.llm.base_url.is_empty(),
        provider: config.llm.provider,
        model: config.llm.model,
        streaming: true,
    })
}

async fn resolved_agent_config(
    state: &AgentBridge,
) -> Result<(vibe_cs_domain::AppConfig, String), AgentCommandError> {
    let config = state
        .storage
        .get_config()
        .await
        .map_err(|error| {
            AgentCommandError::internal(format!("unable to read agent configuration: {error}"))
        })?
        .unwrap_or_default();
    #[cfg(debug_assertions)]
    let mut config = config;
    #[cfg(debug_assertions)]
    let development_key = std::env::var("VIBE_CS_AGENT_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty());
    #[cfg(debug_assertions)]
    if development_key.is_some() {
        "kimi-code".clone_into(&mut config.llm.provider);
        "k3".clone_into(&mut config.llm.model);
        "https://api.kimi.com/coding/v1".clone_into(&mut config.llm.base_url);
    }
    #[cfg(debug_assertions)]
    let api_key = development_key.unwrap_or_else(|| config.llm.api_key.clone());
    #[cfg(not(debug_assertions))]
    let api_key = config.llm.api_key.clone();
    Ok((config, api_key))
}

#[tauri::command]
pub(crate) async fn agent_thread(
    state: State<'_, AgentBridge>,
    thread_id: Uuid,
) -> Result<AgentThread, AgentCommandError> {
    state.load_thread(thread_id).await
}

#[tauri::command]
pub(crate) async fn agent_chat(
    state: State<'_, AgentBridge>,
    input: AgentChatInput,
    on_event: Channel<AgentEvent>,
) -> Result<AgentChatResult, AgentCommandError> {
    chat(&state, input, on_event).await
}

async fn chat(
    state: &AgentBridge,
    input: AgentChatInput,
    on_event: Channel<AgentEvent>,
) -> Result<AgentChatResult, AgentCommandError> {
    let message = input.message.trim();
    if message.is_empty() || message.chars().count() > 8_000 {
        return Err(AgentCommandError::invalid(
            "agent message must contain between 1 and 8000 characters",
        ));
    }
    validate_workspace_context(&input)?;
    let thread_id = input.thread_id.unwrap_or_else(Uuid::new_v4);
    let cancellation = Arc::new(Cancellation::new());
    {
        let mut cancellations = state.cancellations.lock().await;
        if cancellations.contains_key(&input.request_id) {
            return Err(AgentCommandError::invalid(
                "agent request identifier is already active",
            ));
        }
        cancellations.insert(input.request_id, Arc::clone(&cancellation));
    }
    let result = run_scheduled_agent_chat(state, &input, &on_event, thread_id, &cancellation).await;
    let mut cancellations = state.cancellations.lock().await;
    if cancellations
        .get(&input.request_id)
        .is_some_and(|current| Arc::ptr_eq(current, &cancellation))
    {
        cancellations.remove(&input.request_id);
    }
    result
}

fn validate_workspace_context(input: &AgentChatInput) -> Result<(), AgentCommandError> {
    let context = &input.workspace_context;
    if context
        .player_id
        .as_deref()
        .is_some_and(|value| value.len() != 17 || !value.bytes().all(|byte| byte.is_ascii_digit()))
        || context.round_number == Some(0)
        || context.demo_id.is_some_and(|id| Some(id) != input.demo_id)
        || context
            .project_id
            .is_some_and(|id| Some(id) != input.editor_project_id)
    {
        return Err(AgentCommandError::invalid(
            "agent workspace context is outside the supported bounds",
        ));
    }
    let review_destination = matches!(
        context.destination,
        AgentWorkspaceDestination::Review
            | AgentWorkspaceDestination::Players
            | AgentWorkspaceDestination::Evidence
            | AgentWorkspaceDestination::Replay
            | AgentWorkspaceDestination::Heatmap
    );
    let edit_destination = matches!(
        context.destination,
        AgentWorkspaceDestination::Edit
            | AgentWorkspaceDestination::Queue
            | AgentWorkspaceDestination::Studio
            | AgentWorkspaceDestination::Outputs
    );
    if (review_destination && !matches!(context.workflow, AgentWorkspaceWorkflow::Review))
        || (edit_destination && !matches!(context.workflow, AgentWorkspaceWorkflow::Edit))
        || (matches!(
            context.destination,
            AgentWorkspaceDestination::Replay | AgentWorkspaceDestination::Heatmap
        ) && context.demo_id.is_none())
        || ((context.round_number.is_some() || context.tick.is_some()) && context.demo_id.is_none())
        || (context.player_id.is_some()
            && !matches!(context.workflow, AgentWorkspaceWorkflow::Review))
    {
        return Err(AgentCommandError::invalid(
            "agent workspace context is inconsistent with the selected workflow",
        ));
    }
    Ok(())
}

async fn run_scheduled_agent_chat(
    state: &AgentBridge,
    input: &AgentChatInput,
    on_event: &Channel<AgentEvent>,
    thread_id: Uuid,
    cancellation: &Cancellation,
) -> Result<AgentChatResult, AgentCommandError> {
    let _chat_permit = tokio::select! {
        permit = state.chat_gate.acquire() => permit
            .map_err(|_| AgentCommandError::unavailable("agent scheduler is closed"))?,
        () = cancellation.cancelled() => return Err(AgentCommandError::unavailable("agent request was cancelled")),
    };
    let thread_lock = state.thread_lock(thread_id).await;
    let _thread_guard = tokio::select! {
        guard = thread_lock.lock() => guard,
        () = cancellation.cancelled() => return Err(AgentCommandError::unavailable("agent request was cancelled")),
    };
    run_agent_chat(state, input, on_event, thread_id, cancellation).await
}

#[tauri::command]
pub(crate) async fn agent_cancel(
    state: State<'_, AgentBridge>,
    request_id: Uuid,
) -> Result<bool, AgentCommandError> {
    let cancellation = state.cancellations.lock().await.get(&request_id).cloned();
    if let Some(cancellation) = cancellation {
        cancellation.cancel();
        return Ok(true);
    }
    Ok(false)
}

async fn run_agent_chat(
    state: &AgentBridge,
    input: &AgentChatInput,
    on_event: &Channel<AgentEvent>,
    thread_id: Uuid,
    cancellation: &Cancellation,
) -> Result<AgentChatResult, AgentCommandError> {
    let message = input.message.trim();
    let _ = on_event.send(AgentEvent::Started { thread_id });
    let mut thread = state.load_thread(thread_id).await?;
    let (config, api_key) = resolved_agent_config(state).await?;
    if api_key.is_empty() || config.llm.model.is_empty() || config.llm.base_url.is_empty() {
        return Err(AgentCommandError::unavailable(
            "configure an AI provider in Vibe CS settings first",
        ));
    }
    let demo = match input.demo_id {
        Some(id) => serde_json::to_value(state.storage.get_demo(id).await.map_err(|error| {
            AgentCommandError::internal(format!("unable to read demo evidence: {error}"))
        })?)
        .map_err(|error| AgentCommandError::internal(error.to_string()))?,
        None => Value::Null,
    };
    let analysis = match input.demo_id {
        Some(id) => {
            serde_json::to_value(state.storage.get_analysis(id).await.map_err(|error| {
                AgentCommandError::internal(format!("unable to read demo analysis: {error}"))
            })?)
            .map_err(|error| AgentCommandError::internal(error.to_string()))?
        }
        None => Value::Null,
    };
    let map_context = match analysis
        .get("map_name")
        .and_then(Value::as_str)
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 128
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        }) {
        Some(map_name) => state
            .dispatcher
            .dispatch(DesktopCall {
                method: DesktopMethod::Get,
                path: format!("/maps/{map_name}/radar/metadata"),
                body: None,
            })
            .await
            .unwrap_or_else(|_| {
                json!({
                    "map_name": map_name,
                    "transform": null,
                    "browser_displayable": false,
                })
            }),
        None => Value::Null,
    };
    let editor_project = match input.editor_project_id {
        Some(id) => serde_json::to_value(state.storage.get_editor_project(id).await.map_err(
            |error| AgentCommandError::internal(format!("unable to read editor project: {error}")),
        )?)
        .map_err(|error| AgentCommandError::internal(error.to_string()))?,
        None => Value::Null,
    };
    let selected_audio = match input.audio_asset_id {
        Some(id) => {
            let asset = state.storage.get_asset(id).await.map_err(|error| {
                AgentCommandError::internal(format!("unable to read selected BGM: {error}"))
            })?;
            asset.map_or(Value::Null, |asset| {
                json!({
                    "assetId": asset.id,
                    "name": asset.name,
                    "kind": asset.kind,
                    "durationSeconds": asset.duration_seconds,
                    "fileSize": asset.file_size,
                    "placement": {
                        "timeline_start_seconds": 0.0,
                        "source_in_seconds": 0.0,
                        "volume": 1.0,
                    },
                })
            })
        }
        None => Value::Null,
    };
    let audio_analysis = match input.audio_asset_id {
        Some(id) => tokio::select! {
            analysis = state.analyze_audio(id) => analysis?,
            () = cancellation.cancelled() => return Err(AgentCommandError::unavailable("agent request was cancelled")),
        },
        None => Value::Null,
    };
    let alignment_clips = beat_alignment_clips(&editor_project, &analysis);
    let beat_alignment_draft = if audio_analysis
        .get("beats")
        .and_then(Value::as_array)
        .is_some_and(|beats| !beats.is_empty())
        && !alignment_clips.is_empty()
    {
        state
            .dispatcher
            .dispatch(DesktopCall {
                method: DesktopMethod::Post,
                path: "/media/audio/align-clips".to_owned(),
                body: Some(json!({ "beats": audio_analysis["beats"], "clips": alignment_clips })),
            })
            .await
            .map_err(|error| {
                AgentCommandError::invalid(format!(
                    "unable to create native beat-alignment draft: {error:?}"
                ))
            })?
    } else {
        Value::Null
    };
    let history = thread
        .messages
        .iter()
        .rev()
        .take(40)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|entry| HistoryMessage {
            role: entry.role.as_str().to_owned(),
            content: entry.content.clone(),
        })
        .collect::<Vec<_>>();
    let summarized_analysis = summarize_analysis(&analysis);
    let tool_host = input.demo_id.map(|demo_id| {
        Arc::new(CinematicReplayHost::new(
            state.storage.clone(),
            state.dispatcher.clone(),
            demo_id,
            &analysis,
        )) as Arc<dyn AgentToolHost>
    });
    let request = EmbeddedAgentRequest {
        request_id: input.request_id.to_string(),
        mode: input.mode,
        message: message.to_owned(),
        history,
        config: EmbeddedAgentConfig {
            provider: config.llm.provider,
            model: config.llm.model,
            base_url: config.llm.base_url,
            api_key,
            custom_instructions: config.llm.prompt,
        },
        context: EmbeddedAgentContext {
            workspace: serde_json::to_value(&input.workspace_context)
                .map_err(|error| AgentCommandError::internal(error.to_string()))?,
            demo: summarize_demo(&demo),
            analysis: summarized_analysis,
            map_context,
            editor_project: summarize_editor_project(&editor_project),
            selected_audio,
            audio_analysis,
            beat_alignment_draft,
        },
        tool_host,
    };
    let mut pending_text = String::new();
    let mut text_event_count = 0_usize;
    let response = tokio::time::timeout(
        Duration::from_secs(180),
        vibe_cs_agent::run_agent(request, cancellation, |event| {
            if let EmbeddedAgentStreamEvent::TextDelta(delta) = event {
                pending_text.push_str(&delta);
                if pending_text.len() >= TEXT_DELTA_BATCH_BYTES
                    && text_event_count < MAXIMUM_STREAM_TEXT_EVENTS_BEFORE_FINAL
                {
                    let _ = on_event.send(AgentEvent::TextDelta {
                        delta: std::mem::take(&mut pending_text),
                    });
                    text_event_count += 1;
                }
            }
        }),
    )
    .await
    .map_err(|_| AgentCommandError::unavailable("agent request timed out"))?
    .map_err(|error| match error {
        vibe_cs_agent::AgentError::Invalid(message) => AgentCommandError::invalid(message),
        vibe_cs_agent::AgentError::Cancelled => AgentCommandError::unavailable(error.to_string()),
        vibe_cs_agent::AgentError::Provider(message) => AgentCommandError::unavailable(message),
    })
    .inspect_err(|error| {
        let _ = on_event.send(AgentEvent::Error {
            message: error.message.clone(),
        });
    })?;
    if !pending_text.is_empty() {
        let _ = on_event.send(AgentEvent::TextDelta {
            delta: std::mem::take(&mut pending_text),
        });
    }
    let tool_calls = response
        .tool_calls
        .into_iter()
        .map(AgentToolCall::from)
        .collect::<Vec<_>>();
    let proposals = response
        .plans
        .into_iter()
        .map(AgentProposal::from)
        .collect::<Vec<_>>();
    for proposal in &proposals {
        validate_proposal(proposal)?;
    }
    for tool_call in &tool_calls {
        let _ = on_event.send(AgentEvent::ToolCall {
            tool_call: tool_call.clone(),
        });
    }
    for proposal in &proposals {
        let _ = on_event.send(AgentEvent::Proposal {
            proposal: proposal.clone(),
        });
    }
    let now = Utc::now().to_rfc3339();
    thread.messages.push(AgentMessage {
        id: Uuid::new_v4(),
        role: AgentRole::User,
        content: message.to_owned(),
        created_at: now.clone(),
        tool_calls: Vec::new(),
        proposals: Vec::new(),
    });
    thread.messages.push(AgentMessage {
        id: Uuid::new_v4(),
        role: AgentRole::Assistant,
        content: response.content,
        created_at: now.clone(),
        tool_calls,
        proposals,
    });
    if thread.messages.len() > MAXIMUM_THREAD_MESSAGES {
        thread
            .messages
            .drain(..thread.messages.len() - MAXIMUM_THREAD_MESSAGES);
    }
    thread.updated_at = now;
    state.save_thread(&mut thread).await?;
    let _ = on_event.send(AgentEvent::Complete {
        thread: thread.clone(),
    });
    Ok(AgentChatResult { thread_id })
}

fn summarize_demo(demo: &Value) -> Value {
    let Some(source) = demo.as_object() else {
        return Value::Null;
    };
    json!({
        "id": source.get("id"), "display_name": source.get("display_name"),
        "file_name": source.get("file_name"), "map_name": source.get("map_name"),
        "match_date": source.get("match_date"), "duration_seconds": source.get("duration_seconds"),
        "total_rounds": source.get("total_rounds"), "team_a_name": source.get("team_a_name"),
        "team_b_name": source.get("team_b_name"), "team_a_score": source.get("team_a_score"),
        "team_b_score": source.get("team_b_score"),
    })
}

fn capped_array(value: Option<&Value>, maximum: usize) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(maximum)
        .cloned()
        .collect()
}

fn highlight_kind_rank(highlight: &Value) -> u8 {
    match highlight.get("kind").and_then(Value::as_str) {
        Some("multi_kill") => 0,
        Some("clutch") => 1,
        Some("one_tap") => 2,
        Some("wallbang" | "no_scope" | "knife" | "taser" | "defuse") => 3,
        Some("fail") => 4,
        Some("timeline") => 5,
        _ => 6,
    }
}

fn summarize_highlights(value: Option<&Value>, maximum: usize) -> Vec<Value> {
    let highlights = value
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    if highlights.len() <= maximum {
        return highlights.to_vec();
    }

    let mut by_round = BTreeMap::<u64, Vec<(usize, &Value)>>::new();
    for (index, highlight) in highlights.iter().enumerate() {
        let round = highlight
            .get("round")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX);
        by_round.entry(round).or_default().push((index, highlight));
    }
    for candidates in by_round.values_mut() {
        candidates.sort_by(|(_, left), (_, right)| {
            highlight_kind_rank(left)
                .cmp(&highlight_kind_rank(right))
                .then_with(|| {
                    right
                        .get("score")
                        .and_then(Value::as_f64)
                        .unwrap_or_default()
                        .total_cmp(
                            &left
                                .get("score")
                                .and_then(Value::as_f64)
                                .unwrap_or_default(),
                        )
                })
                .then_with(|| {
                    left.get("start_tick")
                        .and_then(Value::as_u64)
                        .cmp(&right.get("start_tick").and_then(Value::as_u64))
                })
                .then_with(|| {
                    left.get("id")
                        .and_then(Value::as_str)
                        .cmp(&right.get("id").and_then(Value::as_str))
                })
        });
    }

    let mut selected = Vec::with_capacity(maximum);
    let mut rank = 0;
    while selected.len() < maximum {
        let before = selected.len();
        for candidates in by_round.values() {
            if let Some((index, _)) = candidates.get(rank) {
                selected.push(*index);
                if selected.len() == maximum {
                    break;
                }
            }
        }
        if selected.len() == before {
            break;
        }
        rank += 1;
    }
    selected.sort_unstable();
    selected
        .into_iter()
        .map(|index| highlights[index].clone())
        .collect()
}

fn summarize_round_event(event: &Value) -> Option<Value> {
    let source = event.as_object()?;
    Some(json!({
        "id": source.get("id"),
        "tick": source.get("tick"),
        "seconds": source.get("seconds"),
        "kind": source.get("kind"),
        "actor": source.get("actor"),
        "target": source.get("target"),
        "weapon": source.get("weapon"),
        "headshot": source.get("headshot"),
        "penetrated": source.get("penetrated"),
        "position": source.get("position"),
    }))
}

fn summarize_rounds(value: Option<&Value>, maximum: usize) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(maximum)
        .filter_map(|round| {
            let source = round.as_object()?;
            let events = source
                .get("events")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(128)
                .filter_map(summarize_round_event)
                .collect::<Vec<_>>();
            Some(json!({
                "number": source.get("number"),
                "start_tick": source.get("start_tick"),
                "end_tick": source.get("end_tick"),
                "winner": source.get("winner"),
                "reason": source.get("reason"),
                "team_a_score": source.get("team_a_score"),
                "team_b_score": source.get("team_b_score"),
                "events": events,
            }))
        })
        .collect()
}

fn summarize_analysis(analysis: &Value) -> Value {
    let Some(source) = analysis.as_object() else {
        return Value::Null;
    };
    let insights =
        source
            .get("insights")
            .and_then(Value::as_object)
            .map_or(Value::Null, |insights| {
                json!({
                    "round_economy": capped_array(insights.get("round_economy"), 64),
                    "matchups": capped_array(insights.get("matchups"), 512),
                    "availability": insights.get("availability"),
                })
            });
    json!({
        "demo_id": source.get("demo_id"), "map_name": source.get("map_name"),
        "tick_rate": source.get("tick_rate"), "duration_seconds": source.get("duration_seconds"),
        "teams": capped_array(source.get("teams"), 2), "players": capped_array(source.get("players"), 32),
        "rounds": summarize_rounds(source.get("rounds"), 64), "highlights": summarize_highlights(source.get("highlights"), 128),
        "insights": insights,
    })
}

fn summarize_editor_project(project: &Value) -> Value {
    let Some(source) = project.as_object() else {
        return Value::Null;
    };
    let tracks = capped_array(source.get("tracks"), 16).into_iter().map(|track| {
        let Some(track) = track.as_object() else { return Value::Null };
        json!({
            "id": track.get("id"), "name": track.get("name"), "kind": track.get("kind"),
            "order": track.get("order"), "muted": track.get("muted"), "locked": track.get("locked"),
            "hidden": track.get("hidden"), "clips": capped_array(track.get("clips"), 128),
        })
    }).collect::<Vec<_>>();
    json!({
        "id": source.get("id"), "name": source.get("name"), "width": source.get("width"),
        "height": source.get("height"), "fps": source.get("fps"),
        "duration_seconds": source.get("duration_seconds"), "revision": source.get("revision"),
        "markers": capped_array(source.get("markers"), 256), "tracks": tracks,
    })
}

fn beat_alignment_clips(editor_project: &Value, analysis: &Value) -> Vec<Value> {
    let mut clips = Vec::new();
    if let Some(tracks) = editor_project.get("tracks").and_then(Value::as_array) {
        for track in tracks {
            if !matches!(
                track.get("kind").and_then(Value::as_str),
                Some("video" | "overlay")
            ) {
                continue;
            }
            for clip in track
                .get("clips")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(id) = clip.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(duration) = clip
                    .get("duration")
                    .and_then(Value::as_f64)
                    .filter(|value| *value > 0.0)
                else {
                    continue;
                };
                clips.push(json!({ "clip_id": id, "source_duration_seconds": duration }));
            }
        }
    }
    if !clips.is_empty() {
        return clips;
    }
    let tick_rate = analysis
        .get("tick_rate")
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .unwrap_or(64.0);
    for highlight in analysis
        .get("highlights")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = highlight.get("id").and_then(Value::as_str) else {
            continue;
        };
        let start = highlight.get("start_tick").and_then(Value::as_u64);
        let end = highlight.get("end_tick").and_then(Value::as_u64);
        let Some(duration) = start.zip(end).and_then(|(start, end)| {
            let duration_ticks = u32::try_from(end.checked_sub(start)?).ok()?;
            (duration_ticks > 0).then_some(f64::from(duration_ticks) / tick_rate)
        }) else {
            continue;
        };
        clips.push(json!({ "clip_id": id, "source_duration_seconds": duration }));
    }
    clips
}

fn validate_proposal(proposal: &AgentProposal) -> Result<(), AgentCommandError> {
    // Exhaustive over the enum, so the arm that used to answer
    // 「unknown proposal kind」 is gone: a fifth kind is a compile error here,
    // which is where the decision about how to validate it belongs.
    match proposal.kind {
        CapturedPlanKind::VideoRender => {
            let payload = proposal.payload.as_object().ok_or_else(|| {
                AgentCommandError::internal("agent returned an invalid video task")
            })?;
            if payload
                .get("requires_user_confirmation")
                .and_then(Value::as_bool)
                != Some(true)
            {
                return Err(AgentCommandError::internal(
                    "agent video task must require explicit user confirmation",
                ));
            }
            if payload
                .get("output")
                .and_then(Value::as_object)
                .and_then(|output| output.get("container"))
                .and_then(Value::as_str)
                != Some("mp4")
            {
                return Err(AgentCommandError::internal(
                    "agent video task must deliver an MP4",
                ));
            }
            let items = payload
                .get("items")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty() && items.len() <= 16)
                .ok_or_else(|| {
                    AgentCommandError::internal(
                        "agent video task violates its recording-item bounds",
                    )
                })?;
            let shot_designs = payload
                .get("shot_designs")
                .and_then(Value::as_array)
                .filter(|designs| designs.len() == items.len())
                .ok_or_else(|| {
                    AgentCommandError::internal(
                        "agent video task must explain one map-aware design per recording item",
                    )
                })?;
            for item in items {
                let request =
                    serde_json::from_value::<vibe_cs_domain::RecordingRequest>(item.clone())
                        .map_err(|error| {
                            AgentCommandError::internal(format!(
                                "agent returned an invalid video recording item: {error}"
                            ))
                        })?;
                if request.id.is_none() {
                    return Err(AgentCommandError::internal(
                        "agent video recording item has no persistent identifier",
                    ));
                }
                request.validate().map_err(|error| {
                    AgentCommandError::internal(format!(
                        "agent returned an invalid video recording item: {error}"
                    ))
                })?;
            }
            for (item, design) in items.iter().zip(shot_designs) {
                let highlight_id = item.get("highlight_id").and_then(Value::as_str);
                let rationale = design.get("rationale").and_then(Value::as_str);
                if design.get("highlight_id").and_then(Value::as_str) != highlight_id
                    || design
                        .get("camera_intent")
                        .and_then(Value::as_str)
                        .is_none()
                    || design.get("camera_style").and_then(Value::as_str)
                        != item
                            .get("camera_style")
                            .and_then(Value::as_str)
                            .or(Some("pov"))
                    || rationale.is_none_or(|value| value.trim().chars().count() < 8)
                    || design.get("requires_user_review").and_then(Value::as_bool) != Some(true)
                {
                    return Err(AgentCommandError::internal(
                        "agent video shot design is missing its evidence, intent, or rationale",
                    ));
                }
            }
        }
        CapturedPlanKind::Hlae => {
            let intent = serde_json::from_value::<vibe_cs_domain::HlaeProposalIntent>(
                proposal.payload.clone(),
            )
            .map_err(|error| {
                AgentCommandError::internal(format!(
                    "agent returned an invalid HLAE intent: {error}"
                ))
            })?;
            if intent.highlight_ids.is_empty() || intent.highlight_ids.len() > 16 {
                return Err(AgentCommandError::internal(
                    "agent HLAE intent violates its highlight bounds",
                ));
            }
        }
        CapturedPlanKind::BeatAlignment => {
            let request = serde_json::from_value::<vibe_cs_domain::BeatAlignmentProposalRequest>(
                proposal.payload.clone(),
            )
            .map_err(|error| {
                AgentCommandError::internal(format!(
                    "agent returned an invalid beat-alignment proposal: {error}"
                ))
            })?;
            if !request.draft.advisory_only {
                return Err(AgentCommandError::internal(
                    "beat-alignment proposal must remain advisory",
                ));
            }
        }
        CapturedPlanKind::HighlightEdit => {
            let request = serde_json::from_value::<vibe_cs_domain::HighlightEditProposalRequest>(
                proposal.payload.clone(),
            )
            .map_err(|error| {
                AgentCommandError::internal(format!(
                    "agent returned an invalid highlight-edit proposal: {error}"
                ))
            })?;
            if request.highlight_ids.is_empty() || request.highlight_ids.len() > 16 {
                return Err(AgentCommandError::internal(
                    "agent highlight-edit proposal violates its bounds",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cinematic_host_keeps_exact_kill_events_from_unsummarized_analysis() {
        let demo_id = Uuid::new_v4();
        let highlight_id = "21:76561198041683378:173550-multikill";
        let analysis = json!({
            "highlights": [{
                "id": highlight_id,
                "round": 21,
                "start_tick": 173_422,
                "end_tick": 174_142,
                "player_id": "76561198041683378"
            }],
            "rounds": [{
                "number": 21,
                "events": [
                    {"tick":173_550,"kind":"kill","actor":"76561198041683378","target":"YEKINDAR","position":[-1921.4,-255.9,-127.9]},
                    {"tick":173_671,"kind":"damage","actor":"yuurih","target":"TeSeS","position":[-2530.4,244.3,-167.9]},
                    {"tick":173_950,"kind":"kill","actor":"76561198041683378","target":"yuurih","position":[-1550.8,130.4,-167.9]}
                ]
            }]
        });
        let host = CinematicReplayHost::new(
            vibe_cs_storage::Storage::open_in_memory()
                .await
                .expect("in-memory storage"),
            DesktopBridge::new(Arc::new(tokio::sync::OnceCell::new())),
            demo_id,
            &analysis,
        );

        let highlight = host
            .highlights
            .get(highlight_id)
            .expect("highlight binding");
        assert_eq!(highlight.engagements.len(), 2);
        assert_eq!(highlight.engagements[0].tick, 173_550);
        assert_eq!(highlight.engagements[0].target_id, "YEKINDAR");
        assert_eq!(highlight.engagements[1].tick, 173_950);
        assert_eq!(highlight.engagements[1].target_id, "yuurih");
    }

    #[test]
    fn replay_scene_uses_steam_id_and_clamps_highlight_to_artifact() {
        let run_id = Uuid::new_v4();
        let demo_id = Uuid::new_v4();
        let artifact: RoundReplayArtifact = serde_json::from_value(json!({
            "metadata": {
                "producer_run_id": run_id,
                "demo_id": demo_id,
                "input_sha256": "a".repeat(64),
                "input_size": 1024,
                "round": 21,
                "start_tick": 161_630,
                "end_tick": 173_950,
                "tick_rate": 64.0,
                "sampling_contract_version": 1,
                "sample_interval_ticks": 16,
                "requested_tick_count": 900,
                "accepted_tick_count": 900,
                "event_tick_count": 12,
                "freeze_end_tick": 162_000,
                "players_per_frame": 10,
                "fields": {
                    "position": "required", "yaw": "required", "health": "required",
                    "armor": "required", "life_state": "required", "money": "required",
                    "current_equipment_value": "required",
                    "round_start_equipment_value": "required", "has_helmet": "required",
                    "active_weapon_name": "nullable"
                }
            },
            "frames": [
                {
                    "tick": 173_422,
                    "players": [
                        replay_player("76561198041683378", "A", [-1552.0, -190.0, -161.0]),
                        replay_player("enemy-1", "B", [-1250.0, -100.0, -160.0])
                    ]
                },
                {
                    "tick": 173_950,
                    "players": [
                        replay_player("76561198041683378", "A", [-1714.0, -232.0, -167.0]),
                        replay_player("enemy-1", "B", [-1400.0, -120.0, -165.0])
                    ]
                }
            ]
        }))
        .expect("round replay fixture");
        let highlight = CinematicHighlight {
            id: "21:76561198041683378:173550-multikill".to_owned(),
            round: 21,
            start_tick: 173_422,
            end_tick: 174_142,
            player_id: "76561198041683378".to_owned(),
            engagements: vec![CinematicEngagement {
                tick: 173_550,
                target_id: "enemy-1".to_owned(),
                target_position: [-1250.0, -100.0, -160.0],
            }],
        };

        let scene = cinematic_scene_from_replay(&highlight, &artifact);

        assert_eq!(scene["positionedAction"].as_array().map(Vec::len), Some(2));
        assert_eq!(scene["positionedAction"][0]["actor"], highlight.player_id);
        assert_eq!(scene["positionedAction"][0]["nearestOpponentId"], "enemy-1");
        assert_eq!(scene["verifiedEngagements"][0]["target"], "enemy-1");
        assert_eq!(scene["fidelity"]["effectiveEndTick"], 173_950);
        assert_eq!(scene["fidelity"]["clampedToArtifactEnd"], true);
    }

    fn replay_player(steam_id: &str, team: &str, position: [f64; 3]) -> Value {
        json!({
            "steam_id": steam_id,
            "name": steam_id,
            "team": team,
            "side": if team == "A" { "T" } else { "CT" },
            "position": position,
            "yaw": 20.0,
            "health": 100,
            "armor": 100,
            "life_state": 0,
            "alive": true,
            "money": 1000,
            "current_equipment_value": 4000,
            "round_start_equipment_value": 4000,
            "has_helmet": true,
            "active_weapon_name": "ak47"
        })
    }

    #[test]
    fn status_never_serializes_a_key() {
        let status = AgentStatus {
            runtime_available: true,
            configured: true,
            provider: "local".to_owned(),
            model: "test-model".to_owned(),
            streaming: true,
        };
        let encoded = serde_json::to_string(&status).expect("status");
        assert!(!encoded.contains("api_key"));
        assert!(!encoded.contains("apiKey"));
        assert_eq!(
            serde_json::from_str::<Value>(&encoded).expect("JSON")["runtimeAvailable"],
            true
        );
    }

    #[test]
    fn streamed_agent_event_fields_use_the_frontend_camel_case_contract() {
        let thread_id = Uuid::new_v4();
        let started =
            serde_json::to_value(AgentEvent::Started { thread_id }).expect("started event JSON");
        assert_eq!(started["threadId"], thread_id.to_string());
        assert!(started.get("thread_id").is_none());

        let tool_call = serde_json::to_value(AgentEvent::ToolCall {
            tool_call: AgentToolCall {
                name: "draft_hlae_plan".to_owned(),
                input: json!({}),
                output: json!({}),
            },
        })
        .expect("tool event JSON");
        assert_eq!(tool_call["toolCall"]["name"], "draft_hlae_plan");
        assert!(tool_call.get("tool_call").is_none());
    }

    #[test]
    fn video_render_proposal_requires_executable_mp4_items() {
        let proposal = AgentProposal {
            kind: CapturedPlanKind::VideoRender,
            title: "NiKo highlight".to_owned(),
            payload: json!({
                "items": [{
                    "id": "00000000-0000-4000-8000-0000000000a1",
                    "demo_id": "00000000-0000-4000-8000-0000000000d1",
                    "highlight_id": "round-21-niko",
                    "player_id": "76561198041683378",
                    "title": "NiKo round 21",
                    "start_tick": 173_422,
                    "end_tick": 174_142,
                    "pre_roll_seconds": 2.5,
                    "post_roll_seconds": 2.0,
                    "victim_pov": false,
                    "camera_style": "tracking"
                }],
                "shot_designs": [{
                    "highlight_id": "round-21-niko",
                    "map_name": "de_mirage",
                    "camera_intent": "follow_entry",
                    "camera_style": "tracking",
                    "rationale": "Follow the proven route and keep the engagement lane readable.",
                    "spatial_evidence": null,
                    "requires_user_review": true
                }],
                "output": {"container": "mp4"},
                "source_highlight_ids": ["round-21-niko"],
                "requires_user_confirmation": true
            }),
        };
        validate_proposal(&proposal).expect("valid video task");

        let mut invalid = proposal;
        invalid.payload["output"]["container"] = json!("hlae_bundle");
        assert!(validate_proposal(&invalid).is_err());

        invalid.payload["output"]["container"] = json!("mp4");
        invalid.payload["requires_user_confirmation"] = json!(false);
        assert!(validate_proposal(&invalid).is_err());
    }

    #[test]
    fn context_summaries_cap_untrusted_collections() {
        let analysis = json!({
            "rounds": (0..100).map(|number| json!({ "number": number })).collect::<Vec<_>>(),
            "highlights": (0..200).map(|number| json!({ "id": number })).collect::<Vec<_>>(),
            "players": (0..50).map(|number| json!({ "id": number })).collect::<Vec<_>>(),
        });
        let summary = summarize_analysis(&analysis);
        assert_eq!(summary["rounds"].as_array().map(Vec::len), Some(64));
        assert_eq!(summary["highlights"].as_array().map(Vec::len), Some(128));
        assert_eq!(summary["players"].as_array().map(Vec::len), Some(32));
    }

    #[test]
    fn analysis_summary_keeps_high_value_highlights_from_every_round() {
        let mut highlights = Vec::new();
        for round in 1..=21 {
            for index in 0..8 {
                highlights.push(json!({
                    "id": format!("round-{round}-timeline-{index}"),
                    "round": round,
                    "kind": "timeline",
                    "score": 0.5,
                    "start_tick": round * 10_000 + index * 100,
                }));
            }
        }
        highlights.push(json!({
            "id": "round-20-fallen-4k",
            "round": 20,
            "kind": "multi_kill",
            "score": 0.93,
            "start_tick": 160_986,
        }));
        highlights.push(json!({
            "id": "round-21-niko-3k",
            "round": 21,
            "kind": "multi_kill",
            "score": 0.91,
            "start_tick": 171_501,
        }));

        let summary = summarize_analysis(&json!({ "highlights": highlights }));
        let selected = summary["highlights"].as_array().expect("highlights");
        assert_eq!(selected.len(), 128);
        assert!(
            selected
                .iter()
                .any(|item| item["id"] == "round-20-fallen-4k")
        );
        assert!(selected.iter().any(|item| item["id"] == "round-21-niko-3k"));
        for round in 1..=21 {
            assert!(selected.iter().any(|item| item["round"] == round));
        }
    }

    #[test]
    fn analysis_summary_bounds_round_event_payloads_for_agent_context() {
        let rounds = (1..=21)
            .map(|round| {
                json!({
                    "number": round,
                    "start_tick": round * 10_000,
                    "end_tick": round * 10_000 + 9_999,
                    "winner": "CT",
                    "reason": "elimination",
                    "team_a_score": round / 2,
                    "team_b_score": round - round / 2,
                    "events": (0..160).map(|event| json!({
                        "id": format!("event-{round}-{event}"),
                        "tick": round * 10_000 + event,
                        "seconds": event,
                        "kind": "player_death",
                        "actor": "76561198041683378",
                        "target": "76561198000000001",
                        "weapon": "ak47",
                        "headshot": true,
                        "unbounded_parser_payload": "x".repeat(2_048),
                    })).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>();

        let summary = summarize_analysis(&json!({ "rounds": rounds }));
        let encoded = serde_json::to_vec(&summary).expect("summary JSON");
        assert!(
            encoded.len() < 1024 * 1024,
            "bounded Agent analysis context, got {} bytes",
            encoded.len()
        );
        assert_eq!(summary["rounds"].as_array().map(Vec::len), Some(21));
        assert_eq!(
            summary["rounds"][0]["events"].as_array().map(Vec::len),
            Some(128)
        );
        assert!(
            summary["rounds"][0]["events"][0]
                .get("unbounded_parser_payload")
                .is_none()
        );
    }

    #[test]
    fn persisted_agent_messages_require_the_complete_current_shape() {
        let value = json!({
            "id": Uuid::new_v4(),
            "role": "assistant",
            "content": "done",
            "createdAt": Utc::now().to_rfc3339(),
            "proposals": []
        });

        assert!(serde_json::from_value::<AgentMessage>(value).is_err());
    }

    #[test]
    fn agent_chat_requires_explicit_nullable_context_fields() {
        let current = json!({
            "requestId": Uuid::new_v4(),
            "threadId": null,
            "demoId": null,
            "editorProjectId": null,
            "audioAssetId": null,
            "workspaceContext": {
                "workflow": "review",
                "destination": "review",
                "demoId": null,
                "projectId": null,
                "playerId": null,
                "roundNumber": null,
                "tick": null
            },
            "mode": "guide",
            "message": "Review this match"
        });
        serde_json::from_value::<AgentChatInput>(current.clone())
            .expect("current explicit agent chat request");

        for field in [
            "threadId",
            "demoId",
            "editorProjectId",
            "audioAssetId",
            "workspaceContext",
        ] {
            let mut missing = current.clone();
            missing
                .as_object_mut()
                .expect("agent chat object")
                .remove(field);
            assert!(
                serde_json::from_value::<AgentChatInput>(missing).is_err(),
                "missing {field} must not select an implicit context default"
            );
        }

        for field in ["demoId", "projectId", "playerId", "roundNumber", "tick"] {
            let mut missing = current.clone();
            missing["workspaceContext"]
                .as_object_mut()
                .expect("workspace context")
                .remove(field);
            assert!(
                serde_json::from_value::<AgentChatInput>(missing).is_err(),
                "missing workspace {field} must not select an implicit context default"
            );
        }
    }

    #[test]
    fn agent_workspace_context_rejects_cross_selection_and_impossible_surfaces() {
        let demo_id = Uuid::new_v4();
        let other_demo_id = Uuid::new_v4();
        let request = AgentChatInput {
            request_id: Uuid::new_v4(),
            thread_id: None,
            demo_id: Some(demo_id),
            editor_project_id: None,
            audio_asset_id: None,
            workspace_context: AgentWorkspaceContext {
                workflow: AgentWorkspaceWorkflow::Review,
                destination: AgentWorkspaceDestination::Replay,
                demo_id: Some(other_demo_id),
                project_id: None,
                player_id: Some("76561198000000001".to_owned()),
                round_number: Some(7),
                tick: Some(640),
            },
            mode: EmbeddedAgentMode::Guide,
            message: "Explain this frame".to_owned(),
        };
        assert!(validate_workspace_context(&request).is_err());

        let mut impossible = request;
        impossible.workspace_context.demo_id = Some(demo_id);
        impossible.workspace_context.workflow = AgentWorkspaceWorkflow::Edit;
        assert!(validate_workspace_context(&impossible).is_err());
    }

    #[test]
    fn thread_serialization_drops_oldest_pairs_to_fit_its_byte_budget() {
        let mut thread = AgentThread {
            id: Uuid::new_v4(),
            messages: (0..40)
                .map(|index| AgentMessage {
                    id: Uuid::new_v4(),
                    role: if index % 2 == 0 {
                        AgentRole::User
                    } else {
                        AgentRole::Assistant
                    },
                    content: format!("{index}:{}", "x".repeat(40_000)),
                    created_at: Utc::now().to_rfc3339(),
                    tool_calls: Vec::new(),
                    proposals: Vec::new(),
                })
                .collect(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let bytes = serialize_bounded_thread(&mut thread).expect("bounded thread");
        assert!(bytes.len() <= MAXIMUM_THREAD_BYTES);
        assert!(thread.messages.len() < 40);
        assert_eq!(thread.messages.len() % 2, 0);
        assert!(!thread.messages[0].content.starts_with("0:"));
    }
}

#[cfg(test)]
#[path = "agent_edit_e2e.rs"]
mod edit_e2e;

#[cfg(test)]
#[path = "agent_e2e.rs"]
mod agent_e2e;
