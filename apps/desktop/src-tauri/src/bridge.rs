use std::{fmt, sync::Arc};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Method, Request, Response, StatusCode, Uri, header, request::Builder},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tokio::sync::OnceCell;
use tower::ServiceExt;

const MAXIMUM_COMMAND_RESPONSE_BYTES: usize = 128 * 1024 * 1024;
const MAXIMUM_MEDIA_RESPONSE_BYTES: usize = 256 * 1024 * 1024;
const COMMAND_NAMESPACE: &str = "/api/v1/";
const UPLOAD_BOUNDARY: &str = "vibe-cs-tauri-upload";

#[derive(Clone)]
pub(crate) struct DesktopBridge {
    router: Arc<OnceCell<Router>>,
}

impl fmt::Debug for DesktopBridge {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DesktopBridge")
            .field("ready", &self.router.initialized())
            .finish()
    }
}

impl DesktopBridge {
    pub(crate) fn new(router: Arc<OnceCell<Router>>) -> Self {
        Self { router }
    }

    pub(crate) async fn dispatch(&self, call: DesktopCall) -> Result<Value, DesktopCommandError> {
        let router = self
            .router
            .get()
            .ok_or_else(|| {
                DesktopCommandError::service_unavailable("desktop services are starting")
            })?
            .clone();
        let method = call.method.as_http_method();
        let uri = call.internal_uri()?;
        let body = call
            .body
            .map_or_else(|| Ok(Vec::new()), |body| serde_json::to_vec(&body))
            .map_err(|error| DesktopCommandError::internal(error.to_string()))?;
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "tauri.localhost")
            .header(header::ORIGIN, "tauri://localhost");
        if !body.is_empty() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        let response = router
            .oneshot(
                request
                    .body(Body::from(body))
                    .map_err(|error| DesktopCommandError::internal(error.to_string()))?,
            )
            .await
            .map_err(|error| DesktopCommandError::internal(error.to_string()))?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), MAXIMUM_COMMAND_RESPONSE_BYTES)
            .await
            .map_err(|error| DesktopCommandError::internal(error.to_string()))?;
        if status.is_success() {
            if bytes.is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_slice(&bytes)
                .map_err(|error| DesktopCommandError::internal(error.to_string()));
        }
        let problem = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        Err(DesktopCommandError::from_problem(status.as_u16(), &problem))
    }

    pub(crate) async fn dispatch_media(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        match self.try_dispatch_media(request).await {
            Ok(response) => response,
            Err(error) => error.into_response(),
        }
    }

    async fn dispatch_binary(&self, path: &str) -> Result<Vec<u8>, DesktopCommandError> {
        let uri = internal_uri(path)?;
        let router = self
            .router
            .get()
            .ok_or_else(|| {
                DesktopCommandError::service_unavailable("desktop services are starting")
            })?
            .clone();
        let response = router
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(uri)
                    .header(header::HOST, "tauri.localhost")
                    .header(header::ORIGIN, "tauri://localhost")
                    .header(header::ACCEPT, "application/vnd.vibe-cs.replay-v1")
                    .body(Body::empty())
                    .map_err(|error| DesktopCommandError::internal(error.to_string()))?,
            )
            .await
            .map_err(|error| DesktopCommandError::internal(error.to_string()))?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), MAXIMUM_COMMAND_RESPONSE_BYTES)
            .await
            .map_err(|error| DesktopCommandError::internal(error.to_string()))?;
        if !status.is_success() {
            let problem = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
            return Err(DesktopCommandError::from_problem(status.as_u16(), &problem));
        }
        Ok(bytes.to_vec())
    }

    async fn dispatch_upload(
        &self,
        path: &str,
        file_name: &str,
        project_id: Option<&str>,
        bytes: Vec<u8>,
    ) -> Result<Value, DesktopCommandError> {
        validate_upload_path(path)?;
        let uri = internal_uri(path)?;
        let router = self
            .router
            .get()
            .ok_or_else(|| {
                DesktopCommandError::service_unavailable("desktop services are starting")
            })?
            .clone();
        let body = multipart_body(file_name, project_id, &bytes);
        let response = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(uri)
                    .header(header::HOST, "tauri.localhost")
                    .header(header::ORIGIN, "tauri://localhost")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={UPLOAD_BOUNDARY}"),
                    )
                    .body(Body::from(body))
                    .map_err(|error| DesktopCommandError::internal(error.to_string()))?,
            )
            .await
            .map_err(|error| DesktopCommandError::internal(error.to_string()))?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), MAXIMUM_COMMAND_RESPONSE_BYTES)
            .await
            .map_err(|error| DesktopCommandError::internal(error.to_string()))?;
        if status.is_success() {
            return serde_json::from_slice(&bytes)
                .map_err(|error| DesktopCommandError::internal(error.to_string()));
        }
        let problem = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        Err(DesktopCommandError::from_problem(status.as_u16(), &problem))
    }

    async fn try_dispatch_media(
        &self,
        request: Request<Vec<u8>>,
    ) -> Result<Response<Vec<u8>>, DesktopCommandError> {
        let router = self
            .router
            .get()
            .ok_or_else(|| {
                DesktopCommandError::service_unavailable("desktop services are starting")
            })?
            .clone();
        let uri = media_uri(request.uri())?;
        let (parts, body) = request.into_parts();
        let mut builder = Request::builder()
            .method(parts.method)
            .uri(uri)
            .header(header::HOST, "tauri.localhost")
            .header(header::ORIGIN, "tauri://localhost");
        copy_request_header(&mut builder, &parts.headers, header::RANGE);
        copy_request_header(&mut builder, &parts.headers, header::IF_NONE_MATCH);
        copy_request_header(&mut builder, &parts.headers, header::IF_MODIFIED_SINCE);
        let response = router
            .oneshot(
                builder
                    .body(Body::from(body))
                    .map_err(|error| DesktopCommandError::internal(error.to_string()))?,
            )
            .await
            .map_err(|error| DesktopCommandError::internal(error.to_string()))?;
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, MAXIMUM_MEDIA_RESPONSE_BYTES)
            .await
            .map_err(|error| DesktopCommandError::internal(error.to_string()))?;
        let mut response = Response::builder().status(parts.status);
        for name in [
            header::CONTENT_TYPE,
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
            header::CONTENT_DISPOSITION,
            header::ETAG,
            header::LAST_MODIFIED,
            header::CACHE_CONTROL,
        ] {
            if let Some(value) = parts.headers.get(&name) {
                response = response.header(name, value);
            }
        }
        response
            .body(bytes.to_vec())
            .map_err(|error| DesktopCommandError::internal(error.to_string()))
    }
}

fn copy_request_header(builder: &mut Builder, headers: &HeaderMap, name: header::HeaderName) {
    if let Some(value) = headers.get(&name) {
        *builder = std::mem::take(builder).header(name, value);
    }
}

fn media_uri(uri: &Uri) -> Result<Uri, DesktopCommandError> {
    let path_and_query = uri
        .path_and_query()
        .map_or_else(|| uri.path(), axum::http::uri::PathAndQuery::as_str);
    internal_uri(path_and_query)
}

fn validate_desktop_path(path: &str) -> Result<(), DesktopCommandError> {
    if !path.starts_with('/')
        || path.starts_with(COMMAND_NAMESPACE)
        || path.contains("//")
        || path
            .chars()
            .any(|value| matches!(value, '\r' | '\n' | '\0'))
    {
        return Err(DesktopCommandError::invalid(
            "invalid desktop resource path",
        ));
    }
    Ok(())
}

fn internal_uri(path: &str) -> Result<Uri, DesktopCommandError> {
    validate_desktop_path(path)?;
    format!("{}{}", COMMAND_NAMESPACE.trim_end_matches('/'), path)
        .parse()
        .map_err(|error| DesktopCommandError::invalid(format!("invalid resource URI: {error}")))
}

fn validate_upload_path(path: &str) -> Result<(), DesktopCommandError> {
    validate_desktop_path(path)?;
    let is_allowed = matches!(
        path,
        "/demo/upload-multiple" | "/media/assets" | "/editor/packages/upload"
    ) || path
        .strip_prefix("/media/assets/")
        .and_then(|tail| tail.strip_suffix("/replace"))
        .is_some_and(|id| !id.is_empty() && !id.contains('/'));
    if !is_allowed {
        return Err(DesktopCommandError::invalid(
            "desktop upload target is not allowed",
        ));
    }
    Ok(())
}

fn multipart_body(file_name: &str, project_id: Option<&str>, bytes: &[u8]) -> Vec<u8> {
    let safe_name = file_name.replace(['\r', '\n', '"'], "_");
    let mut body = Vec::with_capacity(bytes.len().saturating_add(512));
    if let Some(project_id) = project_id {
        body.extend_from_slice(format!("--{UPLOAD_BOUNDARY}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"project_id\"\r\n\r\n");
        body.extend_from_slice(project_id.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{UPLOAD_BOUNDARY}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"files\"; filename=\"{safe_name}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{UPLOAD_BOUNDARY}--\r\n").as_bytes());
    body
}

fn decode_hex(value: &str) -> Result<String, DesktopCommandError> {
    if !value.len().is_multiple_of(2) || value.len() > 2048 {
        return Err(DesktopCommandError::invalid("invalid upload file name"));
    }
    let bytes = value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair)
                .map_err(|_| DesktopCommandError::invalid("invalid upload file name"))?;
            u8::from_str_radix(pair, 16)
                .map_err(|_| DesktopCommandError::invalid("invalid upload file name"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    String::from_utf8(bytes)
        .map_err(|_| DesktopCommandError::invalid("invalid upload file name encoding"))
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl DesktopMethod {
    fn as_http_method(self) -> Method {
        match self {
            Self::Get => Method::GET,
            Self::Post => Method::POST,
            Self::Put => Method::PUT,
            Self::Patch => Method::PATCH,
            Self::Delete => Method::DELETE,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopCall {
    method: DesktopMethod,
    path: String,
    body: Option<Value>,
}

impl DesktopCall {
    fn internal_uri(&self) -> Result<Uri, DesktopCommandError> {
        internal_uri(&self.path)
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct DesktopCommandError {
    status: u16,
    code: String,
    message: String,
}

impl DesktopCommandError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code: "invalid_desktop_command".to_owned(),
            message: message.into(),
        }
    }

    fn service_unavailable(message: impl Into<String>) -> Self {
        Self {
            status: 503,
            code: "desktop_services_starting".to_owned(),
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 500,
            code: "desktop_command_failed".to_owned(),
            message: message.into(),
        }
    }

    fn from_problem(status: u16, problem: &Value) -> Self {
        let detail = problem.get("detail").unwrap_or(problem);
        let code = detail
            .get("code")
            .or_else(|| problem.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("desktop_command_rejected")
            .to_owned();
        let message = detail
            .get("message")
            .or_else(|| problem.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("The desktop command was rejected")
            .to_owned();
        Self {
            status,
            code,
            message,
        }
    }

    fn into_response(self) -> Response<Vec<u8>> {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body = serde_json::to_vec(&self).unwrap_or_default();
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CONTENT_LENGTH, body.len())
            .body(body)
            .unwrap_or_else(|_| Response::new(Vec::new()))
    }
}

#[tauri::command]
pub(crate) async fn desktop_call(
    state: State<'_, DesktopBridge>,
    call: DesktopCall,
) -> Result<Value, DesktopCommandError> {
    state.dispatch(call).await
}

#[tauri::command]
pub(crate) async fn desktop_binary(
    state: State<'_, DesktopBridge>,
    path: String,
) -> Result<tauri::ipc::Response, DesktopCommandError> {
    state
        .dispatch_binary(&path)
        .await
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub(crate) async fn desktop_upload(
    state: State<'_, DesktopBridge>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, DesktopCommandError> {
    let path = request
        .headers()
        .get("x-vibe-upload-path")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| DesktopCommandError::invalid("missing upload path"))?;
    let file_name = request
        .headers()
        .get("x-vibe-filename-hex")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| DesktopCommandError::invalid("missing upload file name"))?;
    let project_id = request
        .headers()
        .get("x-vibe-project-id")
        .and_then(|value| value.to_str().ok());
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(DesktopCommandError::invalid(
                "upload body must be raw bytes",
            ));
        }
    };
    state
        .dispatch_upload(path, &decode_hex(file_name)?, project_id, bytes)
        .await
}

#[cfg(test)]
mod tests {
    use axum::http::Uri;

    use super::{DesktopCall, DesktopCommandError, DesktopMethod, decode_hex, media_uri};

    #[test]
    fn command_paths_are_local_and_private() {
        let valid = DesktopCall {
            method: DesktopMethod::Get,
            path: "/health".to_owned(),
            body: None,
        };
        assert_eq!(valid.internal_uri().expect("valid path"), "/api/v1/health");

        for path in [
            "/api/v1/health",
            "https://example.test/health",
            "/demos//health",
        ] {
            let invalid = DesktopCall {
                method: DesktopMethod::Get,
                path: path.to_owned(),
                body: None,
            };
            assert!(matches!(
                invalid.internal_uri(),
                Err(DesktopCommandError { status: 400, .. })
            ));
        }
    }

    #[test]
    fn media_paths_cannot_escape_the_managed_namespace() {
        let valid: Uri = "http://vibe-cs-media.localhost/media/assets/id/stream?x=1"
            .parse()
            .expect("valid URI");
        assert_eq!(
            media_uri(&valid).expect("valid media URI"),
            "/api/v1/media/assets/id/stream?x=1"
        );
        let invalid: Uri = "http://vibe-cs-media.localhost/api/v1/external/file"
            .parse()
            .expect("valid URI");
        assert!(media_uri(&invalid).is_err());
    }

    #[test]
    fn upload_file_names_round_trip_utf8_hex() {
        assert_eq!(
            decode_hex("e6b58be8af952e64656d").expect("UTF-8 name"),
            "测试.dem"
        );
        assert!(decode_hex("not-hex").is_err());
    }
}
