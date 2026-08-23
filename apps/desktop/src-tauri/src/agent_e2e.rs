#![cfg(windows)]

use super::*;

use std::time::Duration;

use serde_json::json;
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
};

const TEST_SECRET: &str = "vibe-cs-desktop-hlae-e2e-secret";
const MAXIMUM_HTTP_BYTES: usize = 2 * 1024 * 1024;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rig_video_proposal_emits_an_executable_recording_request() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind loopback provider");
    let provider_address = listener.local_addr().expect("loopback provider address");
    let provider = tokio::spawn(serve_provider(listener));
    let demo_id = Uuid::parse_str("00000000-0000-4000-8000-0000000000d1").unwrap();
    let request = EmbeddedAgentRequest {
        request_id: "00000000-0000-4000-8000-0000000000e3".to_owned(),
        mode: EmbeddedAgentMode::Hlae,
        message: "请把 ace-1 做成完整的 MP4 高光视频。".to_owned(),
        history: Vec::new(),
        config: EmbeddedAgentConfig {
            provider: "vibe-cs-desktop-e2e".to_owned(),
            model: "vibe-cs-desktop-e2e-model".to_owned(),
            base_url: format!("http://{provider_address}/v1"),
            api_key: TEST_SECRET.to_owned(),
            custom_instructions: String::new(),
        },
        context: EmbeddedAgentContext {
            demo: json!({ "id": demo_id, "file_name": "verified.dem" }),
            analysis: json!({
                "tick_rate": 64,
                "highlights": [{
                    "id": "ace-1", "kind": "multi_kill", "title": "Ace",
                    "player_id": "player-1", "round": 7,
                    "start_tick": 1000, "end_tick": 1500,
                    "description": "Five verified eliminations"
                }]
            }),
            ..EmbeddedAgentContext::default()
        },
        tool_host: None,
        auto_mode: true,
    };
    let cancellation = Cancellation::new();

    let response = tokio::time::timeout(
        Duration::from_secs(20),
        vibe_cs_agent::run_agent(request, &cancellation, |_| {}),
    )
    .await
    .expect("Rig tool loop timeout")
    .expect("Rig tool loop");
    let provider_requests = tokio::time::timeout(Duration::from_secs(20), provider)
        .await
        .expect("provider fixture timeout")
        .expect("provider task");
    assert_eq!(
        provider_requests.len(),
        3,
        "Rig must complete the tool loop"
    );
    assert!(
        provider_requests[2]["messages"]
            .as_array()
            .is_some_and(|messages| messages.iter().any(|message| message["role"] == "tool"))
    );
    assert_eq!(response.plans.len(), 1);
    assert_eq!(
        response.plans[0].kind,
        vibe_cs_agent::CapturedPlanKind::VideoRender
    );
    assert_eq!(response.tool_calls[0].name, "draft_video_plan");
    assert_eq!(response.tool_calls[1].name, "confirm_video_plan");
    let payload = &response.plans[0].payload;
    assert_eq!(payload["output"]["container"], "mp4");
    assert_eq!(payload["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(payload["items"][0]["demo_id"], demo_id.to_string());
    assert_eq!(payload["items"][0]["highlight_id"], "ace-1");
    assert_eq!(payload["items"][0]["player_id"], "player-1");
    assert!(
        Uuid::parse_str(
            payload["items"][0]["id"]
                .as_str()
                .expect("recording item id")
        )
        .is_ok()
    );
}

async fn serve_provider(listener: TcpListener) -> Vec<Value> {
    let mut requests = Vec::new();
    for index in 0..3 {
        let (mut stream, _) = listener.accept().await.expect("provider request");
        let body = read_http_json(&mut stream).await;
        assert_eq!(body["model"], "vibe-cs-desktop-e2e-model");
        requests.push(body);
        let chunks = if index == 0 {
            let arguments = serde_json::to_string(&json!({
                "highlightIds": ["ace-1"],
                "leadSeconds": 2.0,
                "tailSeconds": 2.5,
                "cameraIntents": ["player_pov"],
                "cameraRationales": ["Replay spatial evidence is unavailable, so preserve the verified player view."]
            }))
            .unwrap();
            vec![
                stream_chunk(
                    &json!({
                        "role": "assistant",
                        "tool_calls": [{
                            "index": 0, "id": "call-video-plan", "type": "function",
                            "function": { "name": "draft_video_plan", "arguments": arguments }
                        }]
                    }),
                    None,
                ),
                stream_chunk(&json!({}), Some("tool_calls")),
            ]
        } else if index == 1 {
            let arguments = serde_json::to_string(&json!({
                "title": "Generate the selected highlight video",
                "summary": "Record ace-1 and export a bounded MP4",
                "risks": ["Starts the managed offline capture workflow"]
            }))
            .unwrap();
            vec![
                stream_chunk(
                    &json!({
                        "role": "assistant",
                        "tool_calls": [{
                            "index": 0, "id": "call-hitl", "type": "function",
                            "function": { "name": "confirm_video_plan", "arguments": arguments }
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
                        "content": "已基于 ace-1 生成完整 MP4 视频任务，确认后将开始录制。"
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
