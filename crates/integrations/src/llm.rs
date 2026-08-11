use std::{collections::HashSet, fmt};

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{IntegrationError, IntegrationResult};

const AGENT_PROBE_TOOL_NAME: &str = "vibe_cs_health_check";
const MAXIMUM_PROBE_TOOL_ARGUMENT_BYTES: usize = 4 * 1024;

#[derive(Clone, Default, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(if self.is_empty() {
            "SecretString(unset)"
        } else {
            "SecretString([REDACTED])"
        })
    }
}

#[derive(Clone)]
pub struct OpenAiConfig {
    pub provider: String,
    pub base_url: Url,
    pub model: String,
    pub api_key: SecretString,
    pub maximum_commentary_chars: usize,
}

impl fmt::Debug for OpenAiConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiConfig")
            .field("provider", &self.provider)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("api_key", &self.api_key)
            .field("maximum_commentary_chars", &self.maximum_commentary_chars)
            .finish()
    }
}

impl OpenAiConfig {
    /// Validates provider, endpoint, model, and response limits.
    ///
    /// # Errors
    ///
    /// Returns an error for missing or unsafe configuration.
    pub fn validate(&self) -> IntegrationResult<()> {
        if self.provider.trim().is_empty() {
            return Err(IntegrationError::NotConfigured {
                integration: "LLM",
                message: "provider is empty".to_owned(),
            });
        }
        if !matches!(self.base_url.scheme(), "http" | "https") || self.base_url.host_str().is_none()
        {
            return Err(IntegrationError::InvalidConfiguration(
                "LLM base URL must be an absolute HTTP(S) URL".to_owned(),
            ));
        }
        if !self.base_url.username().is_empty() || self.base_url.password().is_some() {
            return Err(IntegrationError::InvalidConfiguration(
                "credentials must not be embedded in the LLM URL".to_owned(),
            ));
        }
        if self.base_url.query().is_some() || self.base_url.fragment().is_some() {
            return Err(IntegrationError::InvalidConfiguration(
                "LLM base URL must not contain a query or fragment".to_owned(),
            ));
        }
        let host = self.base_url.host_str().unwrap_or_default();
        let loopback = host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback());
        if self.base_url.scheme() != "https" && !loopback {
            return Err(IntegrationError::InvalidConfiguration(
                "remote LLM endpoints must use HTTPS; HTTP is restricted to loopback".to_owned(),
            ));
        }
        if self.model.trim().is_empty() {
            return Err(IntegrationError::NotConfigured {
                integration: "LLM",
                message: "model is empty".to_owned(),
            });
        }
        if self.maximum_commentary_chars == 0 || self.maximum_commentary_chars > 16_000 {
            return Err(IntegrationError::InvalidConfiguration(
                "commentary character limit must be between 1 and 16000".to_owned(),
            ));
        }
        Ok(())
    }

    fn endpoint(&self) -> Url {
        let mut base = self.base_url.clone();
        base.set_query(None);
        base.set_fragment(None);
        let path = base.path().trim_end_matches('/');
        base.set_path(&format!("{path}/chat/completions"));
        base
    }

    fn uses_kimi_agent_protocol(&self) -> bool {
        self.provider.to_ascii_lowercase().contains("kimi")
            || self
                .base_url
                .host_str()
                .is_some_and(|host| host.eq_ignore_ascii_case("api.kimi.com"))
            || self.model.to_ascii_lowercase().starts_with("k3")
    }
}

#[derive(Debug, Clone)]
pub struct OpenAiClient {
    http: reqwest::Client,
    config: OpenAiConfig,
}

impl OpenAiClient {
    /// Creates a bounded OpenAI-compatible HTTP client.
    ///
    /// # Errors
    ///
    /// Returns an error when configuration validation or HTTP client setup fails.
    pub fn new(config: OpenAiConfig) -> IntegrationResult<Self> {
        config.validate()?;
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self { http, config })
    }

    /// Requests a short JSON commentary and returns its validated text field.
    ///
    /// # Errors
    ///
    /// Returns an error for missing credentials, oversized input/response,
    /// transport/status failures, or non-conforming JSON.
    pub async fn commentary(&self, system: &str, context: &str) -> IntegrationResult<String> {
        let payload = self.request_commentary(system, context).await?;
        validate_commentary(&payload.commentary, self.config.maximum_commentary_chars)?;
        Ok(payload.commentary.trim().to_owned())
    }

    /// Requests evidence-linked commentary for a server-constructed review.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid JSON shape, missing evidence identifiers,
    /// oversized fields, or any transport/configuration failure.
    pub async fn structured_review(
        &self,
        system: &str,
        context: &str,
    ) -> IntegrationResult<StructuredCommentary> {
        let payload = self.request_commentary(system, context).await?;
        validate_commentary(&payload.commentary, self.config.maximum_commentary_chars)?;
        validate_evidence_ids(&payload.evidence_ids)?;
        Ok(StructuredCommentary {
            commentary: payload.commentary.trim().to_owned(),
            evidence_ids: payload.evidence_ids,
        })
    }

    /// Exercises the same streamed Chat Completions + tools surface used by
    /// the local Mastra sidecar. The probe deliberately avoids structured
    /// response settings and sampling parameters rejected by Kimi K3.
    ///
    /// # Errors
    ///
    /// Returns an integration error when credentials or endpoint settings are
    /// invalid, the provider rejects the request, or its bounded SSE response
    /// does not implement the expected Chat Completions stream.
    pub async fn agent_capabilities(&self) -> IntegrationResult<AgentCapabilities> {
        if self.config.api_key.is_empty() {
            return Err(IntegrationError::NotConfigured {
                integration: "LLM",
                message: "API key is empty".to_owned(),
            });
        }
        let request = AgentProbeRequest {
            model: &self.config.model,
            messages: [ChatMessage {
                role: "user",
                content: "Call the vibe_cs_health_check tool exactly once with an empty object.",
            }],
            stream: true,
            // K3 may emit bounded reasoning before the required tool call.
            max_tokens: 128,
            tools: [AgentProbeTool {
                kind: "function",
                function: AgentProbeFunction {
                    name: AGENT_PROBE_TOOL_NAME,
                    description: "A no-op capability declaration for connection testing.",
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false,
                    }),
                },
            }],
            tool_choice: "required",
        };
        let response = self
            .http
            .post(self.config.endpoint())
            .bearer_auth(self.config.api_key.expose())
            .json(&request)
            .send()
            .await?;
        let status = response.status();
        let bytes = read_bounded_response(response, 1024 * 1024).await?;
        if !status.is_success() {
            return Err(IntegrationError::HttpStatus {
                status: status.as_u16(),
                message: "provider rejected the agent compatibility probe".to_owned(),
            });
        }
        validate_agent_stream(&bytes)?;
        Ok(AgentCapabilities {
            protocol: "openai_chat_completions",
            chat: true,
            stream: true,
            tools: true,
        })
    }

    async fn request_commentary(
        &self,
        system: &str,
        context: &str,
    ) -> IntegrationResult<CommentaryPayload> {
        if self.config.api_key.is_empty() {
            return Err(IntegrationError::NotConfigured {
                integration: "LLM",
                message: "API key is empty".to_owned(),
            });
        }
        if system.len() > 32 * 1024 {
            return Err(IntegrationError::InvalidInput(
                "LLM system prompt is too large".to_owned(),
            ));
        }
        if context.len() > 256 * 1024 {
            return Err(IntegrationError::InvalidInput(
                "LLM context is too large".to_owned(),
            ));
        }
        let kimi_agent_protocol = self.config.uses_kimi_agent_protocol();
        let request = ChatRequest {
            model: &self.config.model,
            messages: [
                ChatMessage {
                    role: "system",
                    content: system,
                },
                ChatMessage {
                    role: "user",
                    content: context,
                },
            ],
            temperature: (!kimi_agent_protocol).then_some(0.2),
            response_format: (!kimi_agent_protocol).then_some(ResponseFormat {
                kind: "json_object",
            }),
        };
        let response = self
            .http
            .post(self.config.endpoint())
            .bearer_auth(self.config.api_key.expose())
            .json(&request)
            .send()
            .await?;
        let status = response.status();
        let bytes = read_bounded_response(response, 1024 * 1024).await?;
        if !status.is_success() {
            return Err(IntegrationError::HttpStatus {
                status: status.as_u16(),
                message: String::from_utf8_lossy(&bytes).chars().take(500).collect(),
            });
        }
        let response: ChatResponse = serde_json::from_slice(&bytes)?;
        let response_content = response
            .choices
            .first()
            .ok_or_else(|| IntegrationError::Protocol("LLM response has no choices".to_owned()))?
            .message
            .content
            .trim();
        serde_json::from_str(response_content).map_err(|error| {
            IntegrationError::Protocol(format!(
                "LLM did not return the requested JSON commentary: {error}"
            ))
        })
    }
}

/// Validated structured response returned by an OpenAI-compatible endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuredCommentary {
    pub commentary: String,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentCapabilities {
    pub protocol: &'static str,
    pub chat: bool,
    pub stream: bool,
    pub tools: bool,
}

fn validate_agent_stream(bytes: &[u8]) -> IntegrationResult<()> {
    let body = std::str::from_utf8(bytes)
        .map_err(|_| IntegrationError::Protocol("LLM stream is not UTF-8".to_owned()))?;
    let mut saw_choice = false;
    let mut saw_done = false;
    let mut tool_call_id = String::new();
    let mut tool_name = String::new();
    let mut tool_arguments = String::new();
    let mut saw_function_type = false;
    for line in body.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            saw_done = true;
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(data).map_err(|_| {
            IntegrationError::Protocol("LLM returned an invalid event stream".to_owned())
        })?;
        let choices = value
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                IntegrationError::Protocol("LLM stream event has no choices".to_owned())
            })?;
        if !choices.is_empty() {
            saw_choice = true;
        }
        for choice in choices {
            let Some(tool_calls) = choice
                .get("delta")
                .and_then(|delta| delta.get("tool_calls"))
                .and_then(serde_json::Value::as_array)
            else {
                continue;
            };
            for tool_call in tool_calls {
                if tool_call.get("index").and_then(serde_json::Value::as_u64) != Some(0) {
                    return Err(IntegrationError::Protocol(
                        "LLM capability probe returned an unexpected tool call".to_owned(),
                    ));
                }
                if let Some(id) = tool_call.get("id").and_then(serde_json::Value::as_str) {
                    if id.is_empty()
                        || id.len() > 256
                        || (!tool_call_id.is_empty() && id != tool_call_id)
                    {
                        return Err(IntegrationError::Protocol(
                            "LLM capability probe returned an invalid tool call id".to_owned(),
                        ));
                    }
                    if tool_call_id.is_empty() {
                        tool_call_id.push_str(id);
                    }
                }
                if let Some(kind) = tool_call.get("type").and_then(serde_json::Value::as_str) {
                    if kind != "function" {
                        return Err(IntegrationError::Protocol(
                            "LLM capability probe returned a non-function tool call".to_owned(),
                        ));
                    }
                    saw_function_type = true;
                }
                if let Some(function) = tool_call.get("function") {
                    if let Some(name) = function.get("name").and_then(serde_json::Value::as_str) {
                        tool_name.push_str(name);
                        if tool_name.len() > AGENT_PROBE_TOOL_NAME.len()
                            || !AGENT_PROBE_TOOL_NAME.starts_with(&tool_name)
                        {
                            return Err(IntegrationError::Protocol(
                                "LLM capability probe called the wrong tool".to_owned(),
                            ));
                        }
                    }
                    if let Some(arguments) = function
                        .get("arguments")
                        .and_then(serde_json::Value::as_str)
                    {
                        let next_length = tool_arguments.len().checked_add(arguments.len()).ok_or(
                            IntegrationError::ResponseLimit(MAXIMUM_PROBE_TOOL_ARGUMENT_BYTES),
                        )?;
                        if next_length > MAXIMUM_PROBE_TOOL_ARGUMENT_BYTES {
                            return Err(IntegrationError::ResponseLimit(
                                MAXIMUM_PROBE_TOOL_ARGUMENT_BYTES,
                            ));
                        }
                        tool_arguments.push_str(arguments);
                    }
                }
            }
        }
    }
    let arguments: serde_json::Value = serde_json::from_str(&tool_arguments).map_err(|_| {
        IntegrationError::Protocol(
            "LLM capability probe returned invalid tool arguments".to_owned(),
        )
    })?;
    if !saw_choice
        || !saw_done
        || !saw_function_type
        || tool_call_id.is_empty()
        || tool_name != AGENT_PROBE_TOOL_NAME
        || arguments
            .as_object()
            .is_none_or(|object| !object.is_empty())
    {
        return Err(IntegrationError::Protocol(
            "LLM did not complete the required streamed tool call".to_owned(),
        ));
    }
    Ok(())
}

async fn read_bounded_response(
    response: reqwest::Response,
    maximum_bytes: usize,
) -> IntegrationResult<Vec<u8>> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        append_bounded(&mut bytes, &chunk, maximum_bytes)?;
    }
    Ok(bytes)
}

fn append_bounded(
    bytes: &mut Vec<u8>,
    chunk: &[u8],
    maximum_bytes: usize,
) -> IntegrationResult<()> {
    let next_len = bytes
        .len()
        .checked_add(chunk.len())
        .ok_or(IntegrationError::ResponseLimit(maximum_bytes))?;
    if next_len > maximum_bytes {
        return Err(IntegrationError::ResponseLimit(maximum_bytes));
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

fn validate_commentary(commentary: &str, maximum_chars: usize) -> IntegrationResult<()> {
    let commentary = commentary.trim();
    if commentary.is_empty() || commentary.chars().count() > maximum_chars {
        return Err(IntegrationError::Protocol(
            "LLM commentary is empty or too long".to_owned(),
        ));
    }
    Ok(())
}

fn validate_evidence_ids(evidence_ids: &[String]) -> IntegrationResult<()> {
    if evidence_ids.is_empty() || evidence_ids.len() > 32 {
        return Err(IntegrationError::Protocol(
            "LLM review must cite between 1 and 32 evidence identifiers".to_owned(),
        ));
    }
    let mut unique = HashSet::with_capacity(evidence_ids.len());
    for evidence_id in evidence_ids {
        if evidence_id.is_empty()
            || evidence_id.len() > 128
            || !evidence_id.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.')
            })
            || !unique.insert(evidence_id)
        {
            return Err(IntegrationError::Protocol(
                "LLM review contains an invalid or duplicate evidence identifier".to_owned(),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: [ChatMessage<'a>; 2],
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat<'a>>,
}

#[derive(Debug, Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Debug, Serialize)]
struct ResponseFormat<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
}

#[derive(Debug, Serialize)]
struct AgentProbeRequest<'a> {
    model: &'a str,
    messages: [ChatMessage<'a>; 1],
    stream: bool,
    max_tokens: u32,
    tools: [AgentProbeTool<'a>; 1],
    tool_choice: &'a str,
}

#[derive(Debug, Serialize)]
struct AgentProbeTool<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    function: AgentProbeFunction<'a>,
}

#[derive(Debug, Serialize)]
struct AgentProbeFunction<'a> {
    name: &'a str,
    description: &'a str,
    parameters: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CommentaryPayload {
    commentary: String,
    #[serde(default)]
    evidence_ids: Vec<String>,
}

#[cfg(test)]
mod tests {
    use tokio::{
        io::{AsyncReadExt as _, AsyncWriteExt as _},
        net::TcpListener,
        sync::oneshot,
    };

    use super::*;

    async fn provider_mock(response: String) -> (Url, oneshot::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let mut expected = None;
            loop {
                let read = socket.read(&mut buffer).await.expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if expected.is_none()
                    && let Some(header_end) =
                        request.windows(4).position(|value| value == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    expected = Some(header_end + 4 + content_length);
                }
                if expected.is_some_and(|length| request.len() >= length) {
                    break;
                }
            }
            let _ = sender.send(request);
            socket
                .write_all(response.as_bytes())
                .await
                .expect("response");
        });
        (
            Url::parse(&format!("http://{address}/v1")).expect("URL"),
            receiver,
        )
    }

    #[test]
    fn secrets_are_redacted() {
        let secret = SecretString::new("do-not-print");
        let rendered = format!("{secret:?}");
        assert!(!rendered.contains("do-not-print"));
        assert!(rendered.contains("REDACTED"));
    }

    #[test]
    fn builds_compatible_endpoint_without_discarding_v1() {
        let config = OpenAiConfig {
            provider: "compatible".to_owned(),
            base_url: Url::parse("https://example.test/v1/").unwrap(),
            model: "model".to_owned(),
            api_key: SecretString::new("secret"),
            maximum_commentary_chars: 400,
        };
        assert_eq!(
            config.endpoint().as_str(),
            "https://example.test/v1/chat/completions"
        );
    }

    #[test]
    fn remote_provider_requires_https_without_query_credentials() {
        let config = |base_url: &str| OpenAiConfig {
            provider: "compatible".to_owned(),
            base_url: Url::parse(base_url).expect("URL"),
            model: "model".to_owned(),
            api_key: SecretString::new("secret"),
            maximum_commentary_chars: 400,
        };
        assert!(config("http://example.test/v1").validate().is_err());
        assert!(
            config("https://example.test/v1?token=secret")
                .validate()
                .is_err()
        );
        assert!(config("http://127.0.0.1:11434/v1").validate().is_ok());
        assert!(config("https://example.test/v1").validate().is_ok());
    }

    #[test]
    fn structured_review_requires_unique_safe_evidence_ids() {
        assert!(validate_evidence_ids(&["round:12".to_owned()]).is_ok());
        assert!(validate_evidence_ids(&[]).is_err());
        assert!(validate_evidence_ids(&["round:12".to_owned(), "round:12".to_owned()]).is_err());
        assert!(validate_evidence_ids(&["round 12".to_owned()]).is_err());
    }

    #[test]
    fn commentary_payload_rejects_unrequested_fields() {
        let result = serde_json::from_str::<CommentaryPayload>(
            r#"{"commentary":"ok","evidence_ids":["demo:1"],"html":"<b>x</b>"}"#,
        );
        assert!(result.is_err());
    }

    #[test]
    fn response_and_commentary_limits_are_enforced_before_use() {
        let mut bytes = vec![1, 2];
        assert!(append_bounded(&mut bytes, &[3], 3).is_ok());
        assert!(append_bounded(&mut bytes, &[4], 3).is_err());
        assert!(validate_commentary("ok", 2).is_ok());
        assert!(validate_commentary("too long", 2).is_err());
    }

    #[tokio::test]
    async fn kimi_agent_probe_matches_stream_and_tools_protocol_without_unsupported_fields() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_health\",\"type\":\"function\",\"function\":{\"name\":\"vibe_cs_health_check\",\"arguments\":\"{\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"}\"}}]}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let (base_url, captured) = provider_mock(response).await;
        let client = OpenAiClient::new(OpenAiConfig {
            provider: "kimi-code".to_owned(),
            base_url,
            model: "k3".to_owned(),
            api_key: SecretString::new("unit-test-secret"),
            maximum_commentary_chars: 400,
        })
        .expect("client");
        let capabilities = client.agent_capabilities().await.expect("probe");
        assert_eq!(
            capabilities,
            AgentCapabilities {
                protocol: "openai_chat_completions",
                chat: true,
                stream: true,
                tools: true,
            }
        );
        let request = captured.await.expect("captured request");
        let body_start = request
            .windows(4)
            .position(|value| value == b"\r\n\r\n")
            .expect("headers")
            + 4;
        let payload: serde_json::Value =
            serde_json::from_slice(&request[body_start..]).expect("request JSON");
        assert_eq!(payload["model"], "k3");
        assert_eq!(payload["stream"], true);
        assert!(
            payload["tools"]
                .as_array()
                .is_some_and(|tools| tools.len() == 1)
        );
        assert_eq!(payload["tool_choice"], "required");
        assert!(payload.get("temperature").is_none());
        assert!(payload.get("response_format").is_none());
    }

    #[test]
    fn agent_probe_rejects_text_only_streams() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        assert!(validate_agent_stream(body.as_bytes()).is_err());
    }

    #[test]
    fn agent_probe_requires_the_function_tool_call_envelope() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_health\",\"function\":{\"name\":\"vibe_cs_health_check\",\"arguments\":\"{}\"}}]}}]}\n\n",
            "data: [DONE]\n\n"
        );
        assert!(validate_agent_stream(body.as_bytes()).is_err());
    }

    #[tokio::test]
    async fn provider_probe_rejection_does_not_echo_response_or_secret() {
        let response = "HTTP/1.1 400 Bad Request\r\nContent-Length: 37\r\nConnection: close\r\n\r\nrejected unit-test-secret temperature".to_owned();
        let (base_url, _captured) = provider_mock(response).await;
        let client = OpenAiClient::new(OpenAiConfig {
            provider: "kimi-code".to_owned(),
            base_url,
            model: "k3".to_owned(),
            api_key: SecretString::new("unit-test-secret"),
            maximum_commentary_chars: 400,
        })
        .expect("client");
        let error = client.agent_capabilities().await.expect_err("rejected");
        let rendered = error.to_string();
        assert!(!rendered.contains("unit-test-secret"));
        assert!(!rendered.contains("temperature"));
    }
}
