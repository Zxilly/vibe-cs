use std::path::{Path, PathBuf};

use axum::{
    Json,
    extract::{
        FromRequest, FromRequestParts, Multipart, Query,
        multipart::{Field, MultipartError},
        rejection::JsonRejection,
    },
    http::{Request, StatusCode, request::Parts},
};
use serde::de::DeserializeOwned;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::ApiError;

#[derive(Debug)]
pub(crate) struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(
        request: Request<axum::body::Body>,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error: JsonRejection| {
                if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    ApiError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "payload_too_large",
                        error.body_text(),
                    )
                } else {
                    ApiError::invalid(error.body_text())
                }
            })
    }
}

#[derive(Debug)]
pub(crate) struct ApiQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(|error| ApiError::invalid(error.body_text()))
    }
}

#[derive(Debug)]
pub(crate) struct ApiMultipart(pub Multipart);

impl<S> FromRequest<S> for ApiMultipart
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(
        request: Request<axum::body::Body>,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        Multipart::from_request(request, state)
            .await
            .map(Self)
            .map_err(|error| ApiError::invalid(error.body_text()))
    }
}

pub(crate) async fn persist_multipart_field(
    field: &mut Field<'_>,
    destination: &Path,
    maximum_bytes: u64,
) -> Result<u64, ApiError> {
    let parent = destination
        .parent()
        .ok_or_else(|| ApiError::invalid("upload destination has no parent directory"))?;
    let temporary = parent.join(format!(".upload-{}.part", Uuid::new_v4()));
    let mut cleanup = PendingUpload::new(temporary.clone());
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        let mut written = 0_u64;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|error| multipart_error(&error))?
        {
            written = written
                .checked_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
                .ok_or_else(|| ApiError::invalid("uploaded file is too large"))?;
            if written > maximum_bytes {
                return Err(ApiError::invalid(format!(
                    "uploaded file exceeds the {maximum_bytes} byte limit"
                )));
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, destination).await?;
        Ok(written)
    }
    .await;
    if result.is_ok() {
        cleanup.disarm();
    } else {
        cleanup.remove().await;
    }
    result
}

struct PendingUpload {
    path: PathBuf,
    armed: bool,
}

impl PendingUpload {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    async fn remove(&mut self) {
        remove_pending_upload(&self.path).await;
        self.armed = false;
    }
}

impl Drop for PendingUpload {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let path = self.path.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move { remove_pending_upload(&path).await });
        } else {
            match std::fs::remove_file(&path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    tracing::warn!(%error, path = %path.display(), "unable to remove cancelled upload");
                }
                _ => {}
            }
        }
    }
}

async fn remove_pending_upload(path: &Path) {
    match tokio::fs::remove_file(path).await {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            tracing::warn!(%error, path = %path.display(), "unable to remove pending upload");
        }
        _ => {}
    }
}

pub(crate) async fn read_multipart_text(
    field: &mut Field<'_>,
    maximum_bytes: usize,
) -> Result<String, ApiError> {
    let mut value = Vec::new();
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|error| multipart_error(&error))?
    {
        if value.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(ApiError::invalid(format!(
                "multipart text field exceeds the {maximum_bytes} byte limit"
            )));
        }
        value.extend_from_slice(&chunk);
    }
    String::from_utf8(value).map_err(|_| ApiError::invalid("multipart text field is not UTF-8"))
}

pub(crate) fn multipart_error(error: &MultipartError) -> ApiError {
    match error.status() {
        StatusCode::PAYLOAD_TOO_LARGE => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            error.body_text(),
        ),
        StatusCode::BAD_REQUEST => ApiError::invalid(error.body_text()),
        _ => {
            tracing::error!(%error, "multipart stream failed");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "multipart_error",
                "The multipart request could not be processed",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::header};

    use super::*;

    fn multipart_request(contents: &[u8]) -> Request<Body> {
        Request::builder()
            .header(
                header::CONTENT_TYPE,
                "multipart/form-data; boundary=vibe-cs-boundary",
            )
            .body(Body::from(contents.to_vec()))
            .expect("multipart request")
    }

    #[tokio::test]
    async fn oversized_field_removes_partial_file_before_returning() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let destination = directory.path().join("upload.bin");
        let body = b"--vibe-cs-boundary\r\nContent-Disposition: form-data; name=\"files\"; filename=\"upload.bin\"\r\n\r\n12345\r\n--vibe-cs-boundary--\r\n";
        let mut multipart = Multipart::from_request(multipart_request(body), &())
            .await
            .expect("multipart");
        let mut field = multipart
            .next_field()
            .await
            .expect("field result")
            .expect("field");

        persist_multipart_field(&mut field, &destination, 4)
            .await
            .expect_err("field must exceed limit");

        assert!(!destination.exists());
        let entries = std::fs::read_dir(directory.path())
            .expect("read upload directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("entries");
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn complete_field_is_published_without_a_partial_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let destination = directory.path().join("upload.bin");
        let body = b"--vibe-cs-boundary\r\nContent-Disposition: form-data; name=\"files\"; filename=\"upload.bin\"\r\n\r\n1234\r\n--vibe-cs-boundary--\r\n";
        let mut multipart = Multipart::from_request(multipart_request(body), &())
            .await
            .expect("multipart");
        let mut field = multipart
            .next_field()
            .await
            .expect("field result")
            .expect("field");

        let written = persist_multipart_field(&mut field, &destination, 4)
            .await
            .expect("persist field");

        assert_eq!(written, 4);
        assert_eq!(
            std::fs::read(&destination).expect("published file"),
            b"1234"
        );
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("read upload directory")
                .count(),
            1
        );
    }
}
