use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Weak},
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{State, ipc::Channel};
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;
use vibe_cs_agent::{
    AgentConfig as EmbeddedAgentConfig, AgentContext as EmbeddedAgentContext,
    AgentMode as EmbeddedAgentMode, AgentRequest as EmbeddedAgentRequest,
    AgentStreamEvent as EmbeddedAgentStreamEvent, Cancellation, HistoryMessage,
};

use crate::bridge::{DesktopBridge, DesktopCall, DesktopMethod};

const MAXIMUM_THREAD_MESSAGES: usize = 80;
const MAXIMUM_THREAD_BYTES: usize = 1024 * 1024;
const TEXT_DELTA_BATCH_BYTES: usize = 256;
const MAXIMUM_STREAM_TEXT_EVENTS_BEFORE_FINAL: usize = 979;

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentStatus {
    runtime_available: bool,
    configured: bool,
    provider: String,
    model: String,
    streaming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentMessage {
    id: Uuid,
    role: String,
    content: String,
    created_at: String,
    tool_calls: Vec<AgentToolCall>,
    proposals: Vec<AgentProposal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentThread {
    id: Uuid,
    messages: Vec<AgentMessage>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentToolCall {
    name: String,
    input: Value,
    output: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentProposal {
    kind: String,
    title: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    mode: AgentMode,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentWorkspaceWorkflow {
    Review,
    Edit,
    Neutral,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AgentMode {
    Guide,
    Edit,
    Hlae,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
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

#[derive(Debug, Serialize)]
pub(crate) struct AgentChatResult {
    thread_id: Uuid,
}

#[derive(Debug, Serialize)]
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
            role: entry.role.clone(),
            content: entry.content.clone(),
        })
        .collect::<Vec<_>>();
    let request = EmbeddedAgentRequest {
        request_id: input.request_id.to_string(),
        mode: match input.mode {
            AgentMode::Guide => EmbeddedAgentMode::Guide,
            AgentMode::Edit => EmbeddedAgentMode::Edit,
            AgentMode::Hlae => EmbeddedAgentMode::Hlae,
        },
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
            analysis: summarize_analysis(&analysis),
            editor_project: summarize_editor_project(&editor_project),
            selected_audio,
            audio_analysis,
            beat_alignment_draft,
        },
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
        role: "user".to_owned(),
        content: message.to_owned(),
        created_at: now.clone(),
        tool_calls: Vec::new(),
        proposals: Vec::new(),
    });
    thread.messages.push(AgentMessage {
        id: Uuid::new_v4(),
        role: "assistant".to_owned(),
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
        "rounds": capped_array(source.get("rounds"), 64), "highlights": summarize_highlights(source.get("highlights"), 128),
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
    match proposal.kind.as_str() {
        "hlae" => {
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
        "beat_alignment" => {
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
        "highlight_edit" => {
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
        _ => {
            return Err(AgentCommandError::internal(
                "agent returned an unknown proposal kind",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            mode: AgentMode::Guide,
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
                    role: if index % 2 == 0 { "user" } else { "assistant" }.to_owned(),
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
