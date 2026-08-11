#![cfg(windows)]

use super::*;

use std::{collections::BTreeSet, fs, sync::Mutex as StdMutex, time::Duration};

use serde_json::json;
use sha2::Sha256;
use tauri::ipc::Channel;
use tokio::{
    io::AsyncReadExt as _,
    net::{TcpListener, TcpStream},
};
use vibe_cs_application::ProposalExecutionPort as _;
use vibe_cs_domain::{
    Highlight, HighlightKind, HlaeProposalEvidence, HlaeProposalIntent, HlaeProposalMode,
    ProposalConfirmation, ReplayFrame, ReplayPlayer,
};
use vibe_cs_hlae::{
    HLAE_BUNDLE_LAUNCH_PROFILE_FILE, HLAE_BUNDLE_MANIFEST_FILE, HLAE_BUNDLE_README_FILE,
    HlaeBundleLaunchHandoff, HlaeBundleLaunchInputs, HlaeDiscoverySource, HlaeInstallation,
    LaunchResolution,
};
use vibe_cs_runtime::RuntimeProposalExecutionPort;

const TEST_SECRET: &str = "vibe-cs-desktop-hlae-e2e-secret";
const MAXIMUM_HTTP_BYTES: usize = 2 * 1024 * 1024;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires `corepack pnpm agent:sidecar` before compiling the desktop crate"]
async fn sea_hlae_proposal_exports_a_revalidated_persistent_handoff() {
    let sidecar = AgentBridge::sidecar_path().expect("freshly built SEA sidecar");
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind loopback provider");
    let provider_address = listener.local_addr().expect("loopback provider address");
    let provider = tokio::spawn(serve_provider(listener));
    let demo_id = Uuid::parse_str("00000000-0000-4000-8000-0000000000d1").unwrap();
    let payload = json!({
        "requestId": "00000000-0000-4000-8000-0000000000e3",
        "mode": "hlae",
        "message": "请把 ace-1 做成 capture 模式的 HLAE 镜头方案。",
        "history": [],
        "config": {
            "provider": "vibe-cs-desktop-e2e",
            "model": "vibe-cs-desktop-e2e-model",
            "baseUrl": format!("http://{provider_address}/v1"),
            "apiKey": TEST_SECRET,
            "customInstructions": ""
        },
        "context": {
            "demo": { "id": demo_id, "file_name": "verified.dem" },
            "analysis": {
                "tick_rate": 64,
                "highlights": [{
                    "id": "ace-1", "kind": "multi_kill", "title": "Ace",
                    "player_id": "player-1", "round": 7,
                    "start_tick": 1000, "end_tick": 1500,
                    "description": "Five verified eliminations"
                }]
            },
            "editorProject": null,
            "selectedAudio": null,
            "audioAnalysis": null,
            "beatAlignmentDraft": null
        }
    });
    let received_events = Arc::new(StdMutex::new(Vec::<Value>::new()));
    let captured_events = Arc::clone(&received_events);
    let channel = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(encoded) = body {
            captured_events
                .lock()
                .expect("capture agent event")
                .push(serde_json::from_str(&encoded)?);
        }
        Ok(())
    });
    let cancellation = Cancellation::new();

    let response = tokio::time::timeout(
        Duration::from_secs(20),
        run_sidecar(&sidecar, &payload, &channel, &cancellation),
    )
    .await
    .expect("SEA tool loop timeout")
    .expect("SEA tool loop");
    let provider_requests = tokio::time::timeout(Duration::from_secs(20), provider)
        .await
        .expect("provider fixture timeout")
        .expect("provider task");
    assert_eq!(
        provider_requests.len(),
        2,
        "Mastra must complete the tool loop"
    );
    assert!(
        provider_requests[1]["messages"]
            .as_array()
            .is_some_and(|messages| messages.iter().any(|message| message["role"] == "tool"))
    );
    assert_eq!(response.plans.len(), 1);
    assert_eq!(response.plans[0].kind, "hlae");
    assert_eq!(response.tool_calls[0].name, "draft_hlae_plan");
    let intent: HlaeProposalIntent = serde_json::from_value(response.plans[0].payload.clone())
        .expect("sidecar proposal must preserve the typed Rust intent");
    assert_eq!(intent.demo_id, demo_id);
    assert_eq!(intent.highlight_ids, ["ace-1"]);
    assert_eq!(intent.mode, HlaeProposalMode::Capture);

    let temporary = tempfile::tempdir().expect("temporary desktop data");
    let evidence = evidence(temporary.path());
    let launch_inputs = launch_inputs(temporary.path());
    let execution = RuntimeProposalExecutionPort::new(temporary.path()).expect("proposal port");
    let preview = execution
        .preview_hlae(&intent, &evidence)
        .await
        .expect("real Rust HLAE preview");
    assert!(
        preview.ready,
        "preview prerequisites: {:?}",
        preview.prerequisites
    );
    let confirmation = ProposalConfirmation {
        base_fingerprint: preview.base_fingerprint.expect("base fingerprint"),
        proposal_fingerprint: preview.proposal_fingerprint.expect("proposal fingerprint"),
        confirmation_token: preview.confirmation_token.expect("confirmation token"),
        expected_revision: preview.proposal_revision,
        confirm: true,
    };
    let exported = execution
        .export_hlae(&intent, &evidence, &launch_inputs, &confirmation)
        .await
        .expect("confirmed real HLAE export");
    drop(execution);

    let managed_root = crate::hlae_output::ManagedHlaeRoot::new(temporary.path());
    let listed = crate::hlae_output::list_managed_hlae_bundles(&managed_root)
        .expect("production HLAE bundle listing after restart");
    assert_eq!(listed.len(), 1);
    assert_eq!(
        fs::canonicalize(&listed[0].directory).expect("listed bundle identity"),
        fs::canonicalize(&exported.directory).expect("exported bundle identity")
    );
    assert_eq!(
        fs::canonicalize(&listed[0].completion_marker).expect("listed marker identity"),
        fs::canonicalize(&exported.completion_marker).expect("exported marker identity")
    );
    let listed_names = listed[0]
        .files
        .iter()
        .filter_map(|path| std::path::Path::new(path).file_name())
        .collect::<BTreeSet<_>>();
    let mut exported_names = exported
        .files
        .iter()
        .filter_map(|path| std::path::Path::new(path).file_name())
        .collect::<BTreeSet<_>>();
    exported_names.insert(
        std::path::Path::new(&exported.completion_marker)
            .file_name()
            .expect("completion marker name"),
    );
    assert_eq!(listed_names, exported_names);
    let handoff: HlaeBundleLaunchHandoff = serde_json::from_slice(
        &fs::read(std::path::Path::new(&listed[0].directory).join(HLAE_BUNDLE_LAUNCH_PROFILE_FILE))
            .expect("launch profile"),
    )
    .expect("typed launch handoff");
    assert!(
        handoff
            .launch_profile
            .arguments
            .iter()
            .any(|value| value == "-insecure")
    );
    assert!(handoff.launch_profile.safety.vac_servers_prohibited);
    assert!(
        std::path::Path::new(&listed[0].directory)
            .join(HLAE_BUNDLE_README_FILE)
            .is_file()
    );
    assert!(
        std::path::Path::new(&listed[0].directory)
            .join(HLAE_BUNDLE_MANIFEST_FILE)
            .is_file()
    );
}

async fn serve_provider(listener: TcpListener) -> Vec<Value> {
    let mut requests = Vec::new();
    for index in 0..2 {
        let (mut stream, _) = listener.accept().await.expect("provider request");
        let body = read_http_json(&mut stream).await;
        assert_eq!(body["model"], "vibe-cs-desktop-e2e-model");
        requests.push(body);
        let chunks = if index == 0 {
            let arguments = serde_json::to_string(&json!({
                "highlightIds": ["ace-1"],
                "cameraStyle": "orbit",
                "mode": "capture",
                "leadSeconds": 2.0,
                "tailSeconds": 2.5
            }))
            .unwrap();
            vec![
                stream_chunk(
                    &json!({
                        "role": "assistant",
                        "tool_calls": [{
                            "index": 0, "id": "call-hlae-plan", "type": "function",
                            "function": { "name": "draft_hlae_plan", "arguments": arguments }
                        }]
                    }),
                    None,
                ),
                stream_chunk(&json!({}), Some("tool_calls")),
            ]
        } else {
            vec![
                stream_chunk(
                    &json!({
                        "role": "assistant",
                        "content": "已基于 ace-1 生成 capture 模式 HLAE 镜头草案。"
                    }),
                    None,
                ),
                stream_chunk(&json!({}), Some("stop")),
            ]
        };
        write_sse(&mut stream, &chunks).await;
    }
    requests
}

fn stream_chunk(delta: &Value, finish_reason: Option<&str>) -> Value {
    json!({
        "id": "chatcmpl-vibe-cs-desktop-e2e",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "vibe-cs-desktop-e2e-model",
        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }]
    })
}

async fn read_http_json(stream: &mut TcpStream) -> Value {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    let header_end = loop {
        let count = stream
            .read(&mut buffer)
            .await
            .expect("read provider request");
        assert!(count > 0, "provider request ended before headers");
        bytes.extend_from_slice(&buffer[..count]);
        assert!(
            bytes.len() <= MAXIMUM_HTTP_BYTES,
            "provider request too large"
        );
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
    assert!(
        headers
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {TEST_SECRET}"))
    );
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        })
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .expect("provider content length");
    while bytes.len() - header_end < content_length {
        let count = stream.read(&mut buffer).await.expect("read provider body");
        assert!(count > 0, "provider request body ended early");
        bytes.extend_from_slice(&buffer[..count]);
        assert!(
            bytes.len() <= MAXIMUM_HTTP_BYTES,
            "provider request too large"
        );
    }
    serde_json::from_slice(&bytes[header_end..header_end + content_length])
        .expect("provider JSON request")
}

async fn write_sse(stream: &mut TcpStream, chunks: &[Value]) {
    let mut body = String::new();
    for chunk in chunks {
        std::fmt::Write::write_fmt(&mut body, format_args!("data: {chunk}\n\n"))
            .expect("write SSE fixture");
    }
    body.push_str("data: [DONE]\n\n");
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream; charset=utf-8\r\ncache-control: no-cache\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .expect("write provider SSE");
    stream.shutdown().await.expect("close provider SSE");
}

fn evidence(root: &Path) -> HlaeProposalEvidence {
    let demo = root.join("verified.dem");
    fs::write(&demo, b"verified demo fixture").unwrap();
    let replay_frames = [872_u64, 1_124, 1_376, 1_660]
        .into_iter()
        .map(|tick| ReplayFrame {
            tick,
            players: vec![ReplayPlayer {
                id: "player-1".to_owned(),
                name: "Player".to_owned(),
                team: "CT".to_owned(),
                position: [f64::from(u32::try_from(tick).unwrap()) / 10.0, 20.0, 10.0],
                yaw: 45.0,
                health: 100,
                armor: 100,
                alive: true,
                weapon: "ak47".to_owned(),
                input: None,
            }],
            projectiles: Vec::new(),
            bomb: None,
        })
        .collect();
    HlaeProposalEvidence {
        demo_path: demo.to_string_lossy().into_owned(),
        demo_content_sha256: Some(hex::encode(Sha256::digest(b"verified demo fixture"))),
        tick_rate: 64.0,
        highlights: vec![Highlight {
            id: "ace-1".to_owned(),
            player_id: "player-1".to_owned(),
            round: 7,
            start_tick: 1_000,
            end_tick: 1_500,
            kind: HighlightKind::MultiKill,
            title: "Ace".to_owned(),
            description: "Five verified eliminations".to_owned(),
            score: 1.0,
            tags: Vec::new(),
            victims: Vec::new(),
        }],
        replay_frames,
    }
}

fn launch_inputs(root: &Path) -> HlaeBundleLaunchInputs {
    let installation_root = root.join("HLAE");
    let executable = installation_root.join("HLAE.exe");
    let source2_hook = installation_root.join("x64/AfxHookSource2.dll");
    let game_executable = root.join("game/bin/win64/cs2.exe");
    fs::create_dir_all(source2_hook.parent().unwrap()).unwrap();
    fs::create_dir_all(game_executable.parent().unwrap()).unwrap();
    fs::write(&executable, b"hlae fixture").unwrap();
    fs::write(&source2_hook, b"hook fixture").unwrap();
    fs::write(&game_executable, b"cs2 fixture").unwrap();
    HlaeBundleLaunchInputs {
        installation: HlaeInstallation {
            root: installation_root,
            executable,
            source2_hook,
            source: HlaeDiscoverySource::Configured,
        },
        game_executable,
        resolution: LaunchResolution {
            width: 1920,
            height: 1080,
        },
    }
}
