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
const COMMAND_NAMESPACE: &str = "/api/";
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

    fn router(&self) -> Router {
        self.router
            .get()
            .expect("desktop router is initialized before the main window")
            .clone()
    }

    pub(crate) async fn dispatch(&self, call: DesktopCall) -> Result<Value, DesktopCommandError> {
        let router = self.router();
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

    pub(crate) async fn dispatch_binary(&self, path: &str) -> Result<Vec<u8>, DesktopCommandError> {
        let uri = internal_uri(path)?;
        let router = self.router();
        let response = router
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(uri)
                    .header(header::HOST, "tauri.localhost")
                    .header(header::ORIGIN, "tauri://localhost")
                    .header(header::ACCEPT, "application/vnd.vibe-cs.replay")
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
        let router = self.router();
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
        validate_media_method(request.method())?;
        let router = self.router();
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
    validate_media_path(uri.path())?;
    let path_and_query = uri
        .path_and_query()
        .map_or_else(|| uri.path(), axum::http::uri::PathAndQuery::as_str);
    internal_uri(path_and_query)
}

fn validate_media_method(method: &Method) -> Result<(), DesktopCommandError> {
    if method == Method::GET || method == Method::HEAD {
        return Ok(());
    }
    Err(DesktopCommandError::invalid(
        "desktop media protocol is read-only",
    ))
}

fn validate_media_path(path: &str) -> Result<(), DesktopCommandError> {
    let segments = path
        .strip_prefix('/')
        .map(|path| path.split('/').collect::<Vec<_>>())
        .unwrap_or_default();
    let is_uuid = |value: &str| uuid::Uuid::parse_str(value).is_ok();
    let is_decimal =
        |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
    let is_map_name = |value: &str| {
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    };
    let allowed = match segments.as_slice() {
        ["recorded-clips", id, "stream"]
        | ["media", "assets", id, "stream" | "thumbnail"]
        | ["editor", "packages", id, "download"]
        | ["media", "assets", id, "proxy", "stream"] => is_uuid(id),
        // 「11 输出与任务记录」's 「播放」. The kind is one of the two the
        // outputs route knows, spelled out rather than matched loosely: this
        // list is what keeps the media protocol from becoming a way to read
        // arbitrary service paths.
        ["outputs", kind, id, "stream"] => matches!(*kind, "recording" | "export") && is_uuid(id),
        ["players", steam_id, "avatar"] => is_decimal(steam_id),
        [
            "cosmetics",
            "catalog",
            "items",
            item,
            "paint-kits",
            paint_kit,
            "image",
        ] => is_decimal(item) && is_decimal(paint_kit),
        ["maps", map_name, "radar"] => is_map_name(map_name),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(DesktopCommandError::invalid(
            "desktop media resource is not allowed",
        ))
    }
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

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
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
    pub(crate) method: DesktopMethod,
    pub(crate) path: String,
    pub(crate) body: Option<Value>,
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
    use axum::http::{Method, Uri};

    use super::{
        DesktopCall, DesktopCommandError, DesktopMethod, decode_hex, media_uri,
        validate_media_method,
    };

    #[test]
    fn command_paths_are_local_and_private() {
        let valid = DesktopCall {
            method: DesktopMethod::Get,
            path: "/config".to_owned(),
            body: None,
        };
        assert_eq!(valid.internal_uri().expect("valid path"), "/api/config");

        for path in [
            "/api/health",
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
        const ID: &str = "2f872494-53ca-46c4-967a-f7e63ec60116";
        let valid: Uri = format!("http://vibe-cs-media.localhost/media/assets/{ID}/stream?x=1")
            .parse()
            .expect("valid URI");
        assert_eq!(
            media_uri(&valid).expect("valid media URI").to_string(),
            format!("/api/media/assets/{ID}/stream?x=1")
        );
        for path in [
            format!("/recorded-clips/{ID}/stream"),
            format!("/media/assets/{ID}/thumbnail?time=1&width=320&height=180"),
            format!("/media/assets/{ID}/proxy/stream"),
            format!("/editor/packages/{ID}/download"),
            format!("/outputs/recording/{ID}/stream"),
            format!("/outputs/export/{ID}/stream"),
            "/players/76561198000000001/avatar".to_owned(),
            "/cosmetics/catalog/items/7/paint-kits/600/image".to_owned(),
            "/maps/de_mirage/radar".to_owned(),
        ] {
            let valid: Uri = format!("http://vibe-cs-media.localhost{path}")
                .parse()
                .expect("valid URI");
            assert!(media_uri(&valid).is_ok(), "unexpectedly blocked {path}");
        }
        for invalid in [
            // A kind outside the two the outputs route knows: the allowlist
            // matches the exact words, not "some segment here".
            "http://vibe-cs-media.localhost/outputs/anything/2f872494-53ca-46c4-967a-f7e63ec60116/stream",
            "http://vibe-cs-media.localhost/api/external/file",
            "http://vibe-cs-media.localhost/recording/plans/2f872494-53ca-46c4-967a-f7e63ec60116/execute",
            "http://vibe-cs-media.localhost/config",
            "http://vibe-cs-media.localhost/media/assets/not-a-uuid/stream",
            "http://vibe-cs-media.localhost/maps/../radar",
        ] {
            let invalid: Uri = invalid.parse().expect("valid URI");
            assert!(
                media_uri(&invalid).is_err(),
                "unexpectedly allowed {invalid}"
            );
        }
    }

    #[test]
    fn media_protocol_is_read_only() {
        assert!(validate_media_method(&Method::GET).is_ok());
        assert!(validate_media_method(&Method::HEAD).is_ok());
        assert!(validate_media_method(&Method::POST).is_err());
        assert!(validate_media_method(&Method::DELETE).is_err());
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
