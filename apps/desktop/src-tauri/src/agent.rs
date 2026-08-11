use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{State, ipc::Channel};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex, Notify, Semaphore},
};
use uuid::Uuid;

use crate::bridge::{DesktopBridge, DesktopCall, DesktopMethod};

const EVENT_PREFIX: &str = "VIBE_CS_AGENT_EVENT:";
const MAXIMUM_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAXIMUM_STREAM_BYTES: usize = 2 * 1024 * 1024;
const MAXIMUM_CHANNEL_EVENTS: usize = 1_020;
const TEXT_DELTA_BATCH_BYTES: usize = 8 * 1024;
const MAXIMUM_THREAD_MESSAGES: usize = 80;
const MAXIMUM_THREAD_BYTES: usize = 1024 * 1024;

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

#[derive(Debug)]
struct Cancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Cancellation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    async fn cancelled(&self) {
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        let notified = self.notify.notified();
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        notified.await;
    }
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

    fn sidecar_path() -> Option<PathBuf> {
        if cfg!(debug_assertions)
            && let Some(configured) = std::env::var_os("VIBE_CS_AGENT_SIDECAR")
        {
            let path = PathBuf::from(configured);
            if trusted_sidecar_path(&path) {
                return Some(path);
            }
        }
        let installed = std::env::current_exe()
            .ok()?
            .with_file_name("vibe-cs-agent.exe");
        if trusted_sidecar_path(&installed) {
            return Some(installed);
        }
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "vibe-cs-agent-{}.exe",
                env!("VIBE_CS_TARGET_TRIPLE")
            ));
        trusted_sidecar_path(&development).then_some(development)
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
            Ok(bytes) if bytes.len() <= MAXIMUM_EVENT_BYTES => serde_json::from_slice(&bytes)
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
            "{asset_id}:{}:{}:{modified}:default-v1",
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

fn trusted_sidecar_path(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if !(name.eq_ignore_ascii_case("vibe-cs-agent.exe")
        || name.to_ascii_lowercase().starts_with("vibe-cs-agent-")
            && name.to_ascii_lowercase().ends_with(".exe"))
    {
        return false;
    }
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(parent_metadata) = std::fs::symlink_metadata(parent) else {
        return false;
    };
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        if metadata.file_attributes() & 0x0000_0400 != 0
            || parent_metadata.file_attributes() & 0x0000_0400 != 0
        {
            return false;
        }
    }
    true
}

fn is_debug_sidecar_override(path: &Path) -> bool {
    cfg!(debug_assertions)
        && std::env::var_os("VIBE_CS_AGENT_SIDECAR")
            .is_some_and(|configured| configured == path.as_os_str())
}

struct VerifiedSidecar {
    _file: std::fs::File,
    _parent: std::fs::File,
}

impl std::fmt::Debug for VerifiedSidecar {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VerifiedSidecar")
            .finish_non_exhaustive()
    }
}

async fn verify_bundled_sidecar(path: &Path) -> Result<Option<VerifiedSidecar>, AgentCommandError> {
    if is_debug_sidecar_override(path) {
        return Ok(None);
    }
    let expected = env!("VIBE_CS_AGENT_SIDECAR_SHA256");
    if expected.is_empty() {
        if cfg!(debug_assertions) {
            return Ok(None);
        }
        return Err(AgentCommandError::unavailable(
            "bundled agent integrity manifest is unavailable",
        ));
    }
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || verify_bundled_sidecar_sync(&path, expected))
        .await
        .map_err(|error| {
            AgentCommandError::internal(format!("agent integrity task failed: {error}"))
        })?
}

fn verify_bundled_sidecar_sync(
    path: &Path,
    expected: &str,
) -> Result<Option<VerifiedSidecar>, AgentCommandError> {
    let (mut file, parent) = open_locked_sidecar(path).map_err(|error| {
        AgentCommandError::unavailable(format!("unable to lock bundled agent: {error}"))
    })?;
    let metadata = file.metadata().map_err(|error| {
        AgentCommandError::unavailable(format!("unable to inspect bundled agent: {error}"))
    })?;
    if metadata.len() > 256 * 1024 * 1024 {
        return Err(AgentCommandError::unavailable(
            "bundled agent exceeds its integrity size limit",
        ));
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    let mut read_bytes = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            AgentCommandError::unavailable(format!("unable to verify bundled agent: {error}"))
        })?;
        if read == 0 {
            break;
        }
        read_bytes = read_bytes.saturating_add(read as u64);
        hash.update(&buffer[..read]);
    }
    if read_bytes != metadata.len() || !hex::encode(hash.finalize()).eq_ignore_ascii_case(expected)
    {
        return Err(AgentCommandError::unavailable(
            "bundled agent failed its integrity check",
        ));
    }
    let open_handle = same_file::Handle::from_file(file.try_clone().map_err(|error| {
        AgentCommandError::unavailable(format!("unable to clone bundled agent handle: {error}"))
    })?)
    .map_err(|error| {
        AgentCommandError::unavailable(format!("unable to identify bundled agent: {error}"))
    })?;
    let named_handle = same_file::Handle::from_path(path).map_err(|error| {
        AgentCommandError::unavailable(format!("unable to re-open bundled agent: {error}"))
    })?;
    if open_handle != named_handle || !trusted_sidecar_path(path) {
        return Err(AgentCommandError::unavailable(
            "bundled agent changed during integrity verification",
        ));
    }
    Ok(Some(VerifiedSidecar {
        _file: file,
        _parent: parent,
    }))
}

fn open_locked_sidecar(path: &Path) -> std::io::Result<(std::fs::File, std::fs::File)> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("sidecar has no parent"))?;
    let mut file_options = std::fs::OpenOptions::new();
    file_options.read(true);
    let mut parent_options = std::fs::OpenOptions::new();
    parent_options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        file_options.share_mode(FILE_SHARE_READ);
        parent_options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    Ok((file_options.open(path)?, parent_options.open(parent)?))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentStatus {
    sidecar_available: bool,
    configured: bool,
    provider: String,
    model: String,
    streaming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentMessage {
    id: Uuid,
    role: String,
    content: String,
    created_at: String,
    #[serde(default)]
    tool_calls: Vec<AgentToolCall>,
    #[serde(default)]
    proposals: Vec<AgentProposal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentThread {
    id: Uuid,
    messages: Vec<AgentMessage>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentToolCall {
    name: String,
    input: Value,
    output: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProposal {
    kind: String,
    title: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentChatInput {
    request_id: Uuid,
    thread_id: Option<Uuid>,
    demo_id: Option<Uuid>,
    editor_project_id: Option<Uuid>,
    audio_asset_id: Option<Uuid>,
    mode: AgentMode,
    message: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum SidecarEvent {
    TextDelta { delta: String },
    Complete { response: SidecarResponse },
    Error { error: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarResponse {
    content: String,
    tool_calls: Vec<AgentToolCall>,
    plans: Vec<AgentProposal>,
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
    let sidecar_available = if let Some(path) = AgentBridge::sidecar_path() {
        verify_bundled_sidecar(&path).await.is_ok()
    } else {
        false
    };
    Ok(AgentStatus {
        sidecar_available,
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
    let message = input.message.trim();
    if message.is_empty() || message.chars().count() > 8_000 {
        return Err(AgentCommandError::invalid(
            "agent message must contain between 1 and 8000 characters",
        ));
    }
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
    let result =
        run_scheduled_agent_chat(&state, &input, &on_event, thread_id, &cancellation).await;
    let mut cancellations = state.cancellations.lock().await;
    if cancellations
        .get(&input.request_id)
        .is_some_and(|current| Arc::ptr_eq(current, &cancellation))
    {
        cancellations.remove(&input.request_id);
    }
    result
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
        .map(|entry| json!({ "role": entry.role, "content": entry.content }))
        .collect::<Vec<_>>();
    let payload = json!({
        "requestId": input.request_id,
        "mode": input.mode,
        "message": message,
        "history": history,
        "config": {
            "provider": config.llm.provider,
            "model": config.llm.model,
            "baseUrl": config.llm.base_url,
            "apiKey": api_key,
            "customInstructions": config.llm.prompt,
        },
        "context": {
            "demo": summarize_demo(&demo),
            "analysis": summarize_analysis(&analysis),
            "editorProject": summarize_editor_project(&editor_project),
            "audioAnalysis": audio_analysis,
            "beatAlignmentDraft": beat_alignment_draft,
        },
    });
    let sidecar = AgentBridge::sidecar_path().ok_or_else(|| {
        AgentCommandError::unavailable("the local Mastra sidecar is not installed")
    })?;
    let response = run_sidecar(&sidecar, &payload, on_event, cancellation)
        .await
        .inspect_err(|error| {
            let _ = on_event.send(AgentEvent::Error {
                message: error.message.clone(),
            });
        })?;
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
        tool_calls: response.tool_calls,
        proposals: response.plans,
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
        "rounds": capped_array(source.get("rounds"), 64), "highlights": capped_array(source.get("highlights"), 128),
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

async fn run_sidecar(
    executable: &Path,
    payload: &Value,
    on_event: &Channel<AgentEvent>,
    cancellation: &Cancellation,
) -> Result<SidecarResponse, AgentCommandError> {
    let request = serde_json::to_vec(payload)
        .map_err(|error| AgentCommandError::internal(error.to_string()))?;
    if request.len() > MAXIMUM_EVENT_BYTES {
        return Err(AgentCommandError::invalid(
            "selected agent context exceeds 2 MiB after evidence limits",
        ));
    }
    let _verified_sidecar = verify_bundled_sidecar(executable).await?;
    let mut child = Command::new(executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            AgentCommandError::unavailable(format!("unable to start local agent sidecar: {error}"))
        })?;
    let transaction = async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AgentCommandError::internal("agent sidecar stdin is unavailable"))?;
        stdin.write_all(&request).await.map_err(|error| {
            AgentCommandError::internal(format!("unable to send agent request: {error}"))
        })?;
        stdin.shutdown().await.map_err(|error| {
            AgentCommandError::internal(format!("unable to close agent request: {error}"))
        })?;
        drop(stdin);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentCommandError::internal("agent sidecar stdout is unavailable"))?;
        let response = read_sidecar_events(BufReader::new(stdout), on_event).await?;
        let status = child.wait().await.map_err(|error| {
            AgentCommandError::internal(format!("unable to wait for agent sidecar: {error}"))
        })?;
        if !status.success() {
            return Err(AgentCommandError::unavailable(
                "local agent sidecar rejected the request",
            ));
        }
        response.ok_or_else(|| {
            AgentCommandError::internal("agent sidecar returned no completion event")
        })
    };
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(180), transaction) => if let Ok(result) = result {
            result
        } else {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err(AgentCommandError::unavailable("agent request timed out"))
        },
        () = cancellation.cancelled() => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(AgentCommandError::unavailable("agent request was cancelled"))
        }
    }
}

async fn read_sidecar_events<R: AsyncBufRead + Unpin>(
    mut stdout: R,
    on_event: &Channel<AgentEvent>,
) -> Result<Option<SidecarResponse>, AgentCommandError> {
    let mut response = None;
    let mut total_bytes = 0_usize;
    let mut input_event_count = 0_usize;
    let mut output_event_count = 0_usize;
    let mut total_text_bytes = 0_usize;
    let mut frame = Vec::new();
    let mut pending_text = String::new();
    loop {
        let line = if pending_text.is_empty() {
            read_bounded_line(&mut stdout, &mut frame).await?
        } else {
            tokio::select! {
                line = read_bounded_line(&mut stdout, &mut frame) => line?,
                () = tokio::time::sleep(Duration::from_millis(16)) => {
                    flush_text_delta(on_event, &mut pending_text, &mut output_event_count)?;
                    continue;
                }
            }
        };
        let Some(line) = line else { break };
        total_bytes = total_bytes.saturating_add(line.len());
        input_event_count = input_event_count.saturating_add(1);
        if total_bytes > MAXIMUM_STREAM_BYTES || input_event_count > 4_096 {
            return Err(AgentCommandError::internal(
                "agent stream exceeds its cumulative budget",
            ));
        }
        let text = String::from_utf8_lossy(&line);
        let Some(encoded) = text.trim().strip_prefix(EVENT_PREFIX) else {
            continue;
        };
        match serde_json::from_str::<SidecarEvent>(encoded).map_err(|error| {
            AgentCommandError::internal(format!("invalid agent stream event: {error}"))
        })? {
            SidecarEvent::TextDelta { delta } => {
                append_text_delta(&mut pending_text, &mut total_text_bytes, &delta)?;
                if pending_text.len() >= TEXT_DELTA_BATCH_BYTES {
                    flush_text_delta(on_event, &mut pending_text, &mut output_event_count)?;
                }
            }
            SidecarEvent::Complete {
                response: completed,
            } => {
                flush_text_delta(on_event, &mut pending_text, &mut output_event_count)?;
                validate_sidecar_response(&completed)?;
                for tool_call in &completed.tool_calls {
                    reserve_channel_event(&mut output_event_count)?;
                    let _ = on_event.send(AgentEvent::ToolCall {
                        tool_call: tool_call.clone(),
                    });
                }
                for proposal in &completed.plans {
                    reserve_channel_event(&mut output_event_count)?;
                    let _ = on_event.send(AgentEvent::Proposal {
                        proposal: proposal.clone(),
                    });
                }
                response = Some(completed);
            }
            SidecarEvent::Error { error } => return Err(AgentCommandError::unavailable(error)),
        }
    }
    flush_text_delta(on_event, &mut pending_text, &mut output_event_count)?;
    Ok(response)
}

fn append_text_delta(
    pending: &mut String,
    total_bytes: &mut usize,
    delta: &str,
) -> Result<(), AgentCommandError> {
    *total_bytes = total_bytes.saturating_add(delta.len());
    if *total_bytes > 64_000 {
        return Err(AgentCommandError::internal(
            "agent text stream exceeds its response limit",
        ));
    }
    pending.push_str(delta);
    Ok(())
}

fn reserve_channel_event(count: &mut usize) -> Result<(), AgentCommandError> {
    *count = count.saturating_add(1);
    if *count > MAXIMUM_CHANNEL_EVENTS {
        return Err(AgentCommandError::internal(
            "agent channel exceeds its event budget",
        ));
    }
    Ok(())
}

fn flush_text_delta(
    on_event: &Channel<AgentEvent>,
    pending: &mut String,
    count: &mut usize,
) -> Result<(), AgentCommandError> {
    if pending.is_empty() {
        return Ok(());
    }
    reserve_channel_event(count)?;
    let delta = std::mem::take(pending);
    let _ = on_event.send(AgentEvent::TextDelta { delta });
    Ok(())
}

async fn read_bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> Result<Option<Vec<u8>>, AgentCommandError> {
    loop {
        let buffer = reader.fill_buf().await.map_err(|error| {
            AgentCommandError::internal(format!("unable to read agent stream: {error}"))
        })?;
        if buffer.is_empty() {
            return Ok((!line.is_empty()).then(|| std::mem::take(line)));
        }
        let consumed = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        if line.len().saturating_add(consumed) > MAXIMUM_EVENT_BYTES {
            return Err(AgentCommandError::internal(
                "agent stream event exceeds 2 MiB",
            ));
        }
        let found_newline = buffer.get(consumed.saturating_sub(1)) == Some(&b'\n');
        line.extend_from_slice(&buffer[..consumed]);
        reader.consume(consumed);
        if found_newline {
            return Ok(Some(std::mem::take(line)));
        }
    }
}

fn validate_sidecar_response(response: &SidecarResponse) -> Result<(), AgentCommandError> {
    if response.content.is_empty() || response.content.chars().count() > 64_000 {
        return Err(AgentCommandError::internal(
            "agent response text violates its size contract",
        ));
    }
    if response.tool_calls.len() > 32 || response.plans.len() > 8 {
        return Err(AgentCommandError::internal(
            "agent response contains too many tool calls or proposals",
        ));
    }
    for proposal in &response.plans {
        validate_proposal(proposal)?;
    }
    Ok(())
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
    use tokio::io::BufReader;

    #[test]
    fn status_never_serializes_a_key() {
        let status = AgentStatus {
            sidecar_available: true,
            configured: true,
            provider: "local".to_owned(),
            model: "test-model".to_owned(),
            streaming: true,
        };
        let encoded = serde_json::to_string(&status).expect("status");
        assert!(!encoded.contains("api_key"));
        assert!(!encoded.contains("apiKey"));
    }

    #[tokio::test]
    async fn bounded_line_rejects_an_oversized_unterminated_frame() {
        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
        let write = tokio::spawn(async move {
            let _ = writer.write_all(&vec![b'x'; MAXIMUM_EVENT_BYTES + 1]).await;
        });
        let error = read_bounded_line(&mut BufReader::new(reader), &mut Vec::new())
            .await
            .expect_err("oversized frame");
        assert_eq!(error.code, "agent_failed");
        write.abort();
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
    fn text_delta_limit_is_cumulative_across_batches() {
        let mut total = 0;
        for _ in 0..7 {
            let mut batch = String::new();
            append_text_delta(&mut batch, &mut total, &"x".repeat(8 * 1024)).expect("within limit");
        }
        let mut final_batch = String::new();
        append_text_delta(&mut final_batch, &mut total, &"x".repeat(8 * 1024))
            .expect_err("over 64 KiB");
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

    #[cfg(windows)]
    #[test]
    fn locked_sidecar_handle_rejects_write_and_replace() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("vibe-cs-agent-test.exe");
        std::fs::write(&path, b"test sidecar").expect("fixture");
        let (_file, _parent) = open_locked_sidecar(&path).expect("lock sidecar");
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
        assert!(std::fs::rename(&path, directory.path().join("replacement.exe")).is_err());
    }
}
