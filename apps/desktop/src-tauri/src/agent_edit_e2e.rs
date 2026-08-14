use std::{
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, Response, StatusCode, header},
    routing::post,
};
use chrono::Utc;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::{OnceCell, oneshot};
use uuid::Uuid;
use vibe_cs_domain::{
    AppConfig, DemoRecord, DemoStatus, Highlight, HighlightKind, LlmConfig, MatchAnalysis,
    RecordedClip,
};

use super::*;

const TEST_SECRET: &str = "vibe-cs-desktop-e2e-secret";

#[derive(Clone)]
struct ProviderFixture {
    requests: Arc<StdMutex<Vec<Value>>>,
}

impl ProviderFixture {
    fn new() -> Self {
        Self {
            requests: Arc::new(StdMutex::new(Vec::new())),
        }
    }
}

async fn openai_tool_loop(
    State(state): State<ProviderFixture>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(&format!("Bearer {TEST_SECRET}"))
    {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .expect("unauthorized response");
    }
    let request = match serde_json::from_slice::<Value>(&body) {
        Ok(request) => request,
        Err(error) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from(error.to_string()))
                .expect("bad request response");
        }
    };
    let request_number = {
        let mut requests = state.requests.lock().expect("provider requests");
        requests.push(request);
        requests.len()
    };
    let chunks = if request_number == 1 {
        let arguments = json!({
            "highlightIds": ["ace-1"],
            "pacing": "impact",
            "includeContextSeconds": 2,
            "transitionStyle": "flash"
        })
        .to_string();
        vec![
            json!({
                "id": "chatcmpl-desktop-e2e",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "desktop-e2e",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "role": "assistant",
                        "tool_calls": [{
                            "index": 0,
                            "id": "call-edit-plan",
                            "type": "function",
                            "function": { "name": "draft_edit_plan", "arguments": arguments }
                        }]
                    },
                    "finish_reason": null
                }]
            }),
            json!({
                "id": "chatcmpl-desktop-e2e",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "desktop-e2e",
                "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }]
            }),
        ]
    } else {
        vec![
            json!({
                "id": "chatcmpl-desktop-e2e",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "desktop-e2e",
                "choices": [{
                    "index": 0,
                    "delta": { "role": "assistant", "content": "已生成 ace-1 的剪辑草案。" },
                    "finish_reason": null
                }]
            }),
            json!({
                "id": "chatcmpl-desktop-e2e",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "desktop-e2e",
                "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
            }),
        ]
    };
    let mut stream = String::new();
    for chunk in chunks {
        stream.push_str("data: ");
        stream.push_str(&chunk.to_string());
        stream.push_str("\n\n");
    }
    stream.push_str("data: [DONE]\n\n");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .body(Body::from(stream))
        .expect("provider response")
}

async fn provider_server() -> (
    String,
    ProviderFixture,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let fixture = ProviderFixture::new();
    let router = Router::new()
        .route("/v1/chat/completions", post(openai_tool_loop))
        .with_state(fixture.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("provider listener");
    let address = listener.local_addr().expect("provider address");
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("provider fixture");
    });
    (format!("http://{address}/v1"), fixture, shutdown_tx, task)
}

fn demo(demo_id: Uuid, path: &std::path::Path) -> DemoRecord {
    DemoRecord {
        id: demo_id,
        path: path.to_string_lossy().into_owned(),
        file_name: "verified.dem".to_owned(),
        display_name: "Verified E2E Demo".to_owned(),
        source: "desktop-e2e".to_owned(),
        status: DemoStatus::Ready,
        map_name: Some("de_mirage".to_owned()),
        match_date: Some(Utc::now()),
        duration_seconds: Some(30.0),
        total_rounds: Some(1),
        team_a_name: Some("A".to_owned()),
        team_b_name: Some("B".to_owned()),
        team_a_score: Some(1),
        team_b_score: Some(0),
        player_names: vec!["Player One".to_owned()],
        remark: String::new(),
        content_sha256: Some(hex::encode(Sha256::digest(b"demo-e2e"))),
        file_size: 8,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

fn analysis(demo_id: Uuid) -> MatchAnalysis {
    MatchAnalysis {
        demo_id,
        map_name: "de_mirage".to_owned(),
        tick_rate: 64.0,
        duration_seconds: 30.0,
        verified_total_ticks: None,
        teams: Vec::new(),
        players: Vec::new(),
        rounds: Vec::new(),
        highlights: vec![Highlight {
            id: "ace-1".to_owned(),
            player_id: "player-1".to_owned(),
            round: 1,
            start_tick: 1_000,
            end_tick: 1_500,
            kind: HighlightKind::MultiKill,
            title: "Ace".to_owned(),
            description: "Five verified eliminations".to_owned(),
            score: 1.0,
            tags: Vec::new(),
            victims: Vec::new(),
        }],
    }
}

async fn persist_completed_analysis(
    storage: &vibe_cs_storage::Storage,
    analysis: MatchAnalysis,
) -> vibe_cs_storage::Result<()> {
    let demo = storage
        .get_demo(analysis.demo_id)
        .await?
        .expect("fixture demo");
    let fingerprint = vibe_cs_domain::AnalysisInputFingerprint {
        sha256: demo.content_sha256.expect("fixture fingerprint"),
        size: demo.file_size,
    };
    let run_id = storage.start_analysis_run(demo.id).await?.run.id;
    storage
        .bind_analysis_run_input(run_id, fingerprint.clone())
        .await?;
    storage.mark_analysis_parser_started(run_id).await?;
    storage
        .mark_analysis_input_revalidation_started(run_id)
        .await?;
    storage.mark_analysis_projection_started(run_id).await?;
    storage
        .complete_analysis_run(run_id, analysis, fingerprint)
        .await
        .map(|_| ())
}

#[cfg(windows)]
#[tokio::test]
async fn saved_credentials_drive_embedded_rig_edit_and_survive_restart() {
    let directory = tempfile::tempdir().expect("data directory");
    let data_dir = directory.path().to_path_buf();
    let database = data_dir.join("vibe-cs.db");
    let storage = vibe_cs_storage::Storage::open(&database)
        .await
        .expect("storage");
    let router_cell = Arc::new(OnceCell::new());
    let dispatcher = crate::bridge::DesktopBridge::new(Arc::clone(&router_cell));
    let state = vibe_cs_runtime::build_app_state(storage.clone(), data_dir.clone())
        .await
        .expect("runtime state");
    router_cell
        .set(vibe_cs_application::build_dispatcher(state))
        .expect("desktop router");
    let agent = AgentBridge::new(storage.clone(), data_dir.clone(), dispatcher.clone());

    let demo_id = Uuid::parse_str("00000000-0000-4000-8000-0000000000d1").expect("demo id");
    let demo_path = data_dir.join("verified.dem");
    tokio::fs::write(&demo_path, b"demo-e2e")
        .await
        .expect("demo fixture");
    storage
        .put_demo(demo(demo_id, &demo_path))
        .await
        .expect("demo");
    persist_completed_analysis(&storage, analysis(demo_id))
        .await
        .expect("analysis");
    let recordings = data_dir.join("recordings");
    tokio::fs::create_dir_all(&recordings)
        .await
        .expect("recording directory");
    let recording_path = recordings.join("ace-1.mp4");
    tokio::fs::write(&recording_path, b"managed-recording-evidence")
        .await
        .expect("recording fixture");
    storage
        .put_recorded_clip(RecordedClip {
            id: Uuid::new_v4(),
            path: recording_path.to_string_lossy().into_owned(),
            title: "Ace recording".to_owned(),
            duration_seconds: 14.0625,
            demo_id: Some(demo_id),
            player_name: Some("player-1".to_owned()),
            category: "highlight".to_owned(),
            tags: Vec::new(),
            metadata: json!({
                "highlight_id": "ace-1",
                "effective_start_tick": 800,
                "effective_end_tick": 1700
            }),
            created_at: Utc::now(),
        })
        .await
        .expect("recorded clip");

    let (base_url, provider, shutdown, provider_task) = provider_server().await;
    let config = AppConfig {
        data_dir: data_dir.to_string_lossy().into_owned(),
        llm: LlmConfig {
            provider: "desktop-e2e".to_owned(),
            model: "desktop-e2e".to_owned(),
            base_url,
            api_key: TEST_SECRET.to_owned(),
            prompt: String::new(),
        },
        ..AppConfig::default()
    };
    let mut config_payload = serde_json::to_value(config).expect("config JSON");
    config_payload["steam_has_web_api_key"] = serde_json::json!(false);
    config_payload["steam_has_authentication_code"] = serde_json::json!(false);
    config_payload["steam_has_share_code"] = serde_json::json!(false);
    config_payload["llm_has_api_key"] = serde_json::json!(true);
    config_payload["clear_llm_api_key"] = serde_json::json!(false);
    dispatcher
        .dispatch(crate::bridge::DesktopCall {
            method: crate::bridge::DesktopMethod::Put,
            path: "/config".to_owned(),
            body: Some(config_payload),
        })
        .await
        .expect("save config through desktop bridge");
    let status = status(&agent).await.expect("agent status");
    assert!(status.configured);
    assert!(status.runtime_available);

    let events = Arc::new(StdMutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&events);
    let channel = Channel::new(move |body| {
        let InvokeResponseBody::Json(encoded) = body else {
            panic!("agent channel must remain JSON");
        };
        captured
            .lock()
            .expect("event capture")
            .push(serde_json::from_str(&encoded)?);
        Ok(())
    });
    let thread_id = Uuid::new_v4();
    let input = AgentChatInput {
        request_id: Uuid::new_v4(),
        thread_id: Some(thread_id),
        demo_id: Some(demo_id),
        editor_project_id: None,
        audio_asset_id: None,
        workspace_context: AgentWorkspaceContext {
            workflow: AgentWorkspaceWorkflow::Edit,
            destination: AgentWorkspaceDestination::Edit,
            demo_id: Some(demo_id),
            project_id: None,
            player_id: None,
            round_number: None,
            tick: None,
        },
        mode: AgentMode::Edit,
        message: "Create an impact edit from ace-1 with two seconds of context.".to_owned(),
    };
    let result = tokio::time::timeout(Duration::from_secs(20), chat(&agent, input, channel))
        .await
        .expect("desktop chat timeout")
        .expect("embedded Rig chat through command implementation");
    assert_eq!(result.thread_id, thread_id);
    let thread = agent.load_thread(thread_id).await.expect("saved thread");
    let proposal = thread
        .messages
        .last()
        .and_then(|message| message.proposals.first())
        .expect("Rig-generated proposal")
        .clone();
    assert_eq!(proposal.kind, "highlight_edit");
    assert_eq!(proposal.payload["highlight_ids"][0], "ace-1");

    let preview = dispatcher
        .dispatch(crate::bridge::DesktopCall {
            method: crate::bridge::DesktopMethod::Post,
            path: "/agent/proposals/highlight-edit/preview".to_owned(),
            body: Some(proposal.payload.clone()),
        })
        .await
        .expect("preview proposal");
    assert_eq!(preview["ready"], true);
    for field in [
        "base_fingerprint",
        "proposal_fingerprint",
        "confirmation_token",
    ] {
        assert!(
            preview[field]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
    }
    let apply = dispatcher
        .dispatch(crate::bridge::DesktopCall {
            method: crate::bridge::DesktopMethod::Post,
            path: "/agent/proposals/highlight-edit/apply".to_owned(),
            body: Some(json!({
                "request": proposal.payload,
                "plan": preview["plan"],
                "base_fingerprint": preview["base_fingerprint"],
                "proposal_fingerprint": preview["proposal_fingerprint"],
                "confirmation_token": preview["confirmation_token"],
                "expected_revision": preview["expected_revision"],
                "confirm": true
            })),
        })
        .await
        .expect("apply proposal");
    let project_id =
        Uuid::parse_str(apply["project_id"].as_str().expect("project id")).expect("project UUID");
    assert_eq!(apply["project_created"], true);

    {
        let requests = provider.requests.lock().expect("provider requests");
        assert_eq!(requests.len(), 2);
        assert!(
            requests[0].to_string().contains("draft_edit_plan"),
            "provider request must expose the real local edit tool"
        );
        assert!(
            requests[1]["messages"].as_array().is_some_and(|messages| {
                messages.iter().any(|message| message["role"] == "tool")
            })
        );
    }
    {
        let emitted = events.lock().expect("event capture");
        for expected in ["started", "toolCall", "proposal", "complete"] {
            assert!(emitted.iter().any(|event| event["type"] == expected));
        }
    }
    assert!(
        !tokio::fs::read(&database)
            .await
            .expect("database bytes")
            .windows(TEST_SECRET.len())
            .any(|window| window == TEST_SECRET.as_bytes())
    );
    let thread_path = agent.thread_path(thread_id);
    assert!(
        !tokio::fs::read(&thread_path)
            .await
            .expect("thread bytes")
            .windows(TEST_SECRET.len())
            .any(|window| window == TEST_SECRET.as_bytes())
    );

    let _ = shutdown.send(());
    provider_task.await.expect("provider task");
    drop(agent);
    drop(dispatcher);
    drop(router_cell);
    drop(storage);

    let reopened = vibe_cs_storage::Storage::open(&database)
        .await
        .expect("reopened storage");
    let project = reopened
        .get_editor_project(project_id)
        .await
        .expect("reopened project")
        .expect("persisted project");
    assert_eq!(project.tracks[0].clips.len(), 1);
    let restarted_agent = AgentBridge::new(
        reopened,
        data_dir,
        crate::bridge::DesktopBridge::new(Arc::new(OnceCell::new())),
    );
    assert_eq!(
        restarted_agent
            .load_thread(thread_id)
            .await
            .expect("reopened thread")
            .messages
            .last()
            .and_then(|message| message.proposals.first())
            .map(|proposal| proposal.kind.as_str()),
        Some("highlight_edit")
    );
}
