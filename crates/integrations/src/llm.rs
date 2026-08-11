use std::{collections::HashSet, fmt};

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{IntegrationError, IntegrationResult};

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
            temperature: 0.2,
            response_format: ResponseFormat {
                kind: "json_object",
            },
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
    temperature: f32,
    response_format: ResponseFormat<'a>,
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
    use super::*;

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
}
