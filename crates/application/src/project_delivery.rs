//! Resolves one Project Head into delivery evidence and immutable render inputs.
//!
//! Readiness and execution use the same source selection. The render Adapter never
//! reopens the Project Head after human confirmation.

use std::{collections::HashMap, path::PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;
use vibe_cs_domain::{
    JobStatus, MediaAsset, MediaMetadataStatus, Project, TimelineClipMaterial,
    TimelineClipMaterializationState,
};
use vibe_cs_storage::Storage;

use crate::{ApiError, ApiResult};

#[derive(Debug, Clone)]
pub struct ProjectRenderSource {
    pub path: PathBuf,
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectRenderOptions {
    pub encoder: String,
    pub quality: u8,
    #[serde(default)]
    pub range_start_seconds: Option<f64>,
    #[serde(default)]
    pub range_end_seconds: Option<f64>,
}

/// A checked snapshot, including the exact media chosen for nested sequences.
#[derive(Debug)]
pub struct PreparedProjectRender {
    project: Project,
    sources: HashMap<Uuid, ProjectRenderSource>,
}

impl PreparedProjectRender {
    pub fn project(&self) -> &Project {
        &self.project
    }

    pub fn into_parts(self) -> (Project, HashMap<Uuid, ProjectRenderSource>) {
        (self.project, self.sources)
    }
}

#[derive(Debug)]
pub struct ProjectDelivery {
    project: Project,
    sources: HashMap<Uuid, ProjectRenderSource>,
    pub(crate) blockers: Vec<(Uuid, TimelineClipMaterializationState)>,
}

impl ProjectDelivery {
    pub async fn resolve(storage: &Storage, project: Project) -> ApiResult<Self> {
        let mut blockers = project.delivery_blockers()?;
        let mut sources: HashMap<Uuid, ProjectRenderSource> = HashMap::new();
        for clip in project
            .document
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .filter(|clip| clip.placement.enabled)
        {
            if blockers.iter().any(|(id, _)| *id == clip.id) {
                continue;
            }
            let dependency = if let Some(text) = &clip.text {
                text.font_asset_id.map(|id| (id, false))
            } else {
                match clip.material {
                    TimelineClipMaterial::Take { asset_id, .. }
                    | TimelineClipMaterial::Asset { asset_id, .. } => Some((asset_id, false)),
                    TimelineClipMaterial::Sequence { project_id, .. } => Some((project_id, true)),
                    TimelineClipMaterial::Planned => None,
                }
            };
            let Some((source_id, sequence)) = dependency else {
                continue;
            };
            let source = if sequence {
                let TimelineClipMaterial::Sequence {
                    project_id,
                    project_revision,
                    media_duration_seconds,
                } = clip.material
                else {
                    unreachable!()
                };
                resolve_sequence_media(
                    storage,
                    clip.id,
                    project_id,
                    project_revision,
                    media_duration_seconds,
                )
                .await?
                .1
            } else if let Some(source) = sources.get(&source_id) {
                Some(source.clone())
            } else {
                resolve_asset(storage, source_id).await?
            };
            if let Some(source) = source {
                sources.insert(source_id, source);
            } else {
                blockers.push((clip.id, TimelineClipMaterializationState::Stale));
            }
        }
        Ok(Self {
            project,
            sources,
            blockers,
        })
    }

    pub fn into_render(self, code: &'static str) -> ApiResult<PreparedProjectRender> {
        if !self.blockers.is_empty() {
            return Err(ApiError::new(
                axum::http::StatusCode::PRECONDITION_FAILED,
                code,
                format!(
                    "{} enabled clips do not have compatible media",
                    self.blockers.len()
                ),
            ));
        }
        Ok(PreparedProjectRender {
            project: self.project,
            sources: self.sources,
        })
    }
}

async fn resolve_asset(
    storage: &Storage,
    asset_id: Uuid,
) -> ApiResult<Option<ProjectRenderSource>> {
    if let Some(asset) = storage.get_asset(asset_id).await? {
        let asset = project_media_availability(asset).await;
        return Ok((!matches!(
            asset.metadata_status,
            MediaMetadataStatus::Unavailable { .. }
        ))
        .then(|| ProjectRenderSource {
            path: asset.path.into(),
            kind: asset.kind,
        }));
    }
    // Recorded media retains its identity; no video copy is needed.
    let Some(clip) = storage.get_recorded_clip(asset_id).await? else {
        return Ok(None);
    };
    Ok(source_file_exists(&clip.path)
        .await
        .then(|| ProjectRenderSource {
            path: clip.path.into(),
            kind: "video".to_owned(),
        }))
}

#[derive(Debug, Clone, Copy, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub(crate) enum NestedSequenceMediaStatus {
    Ready,
    Rendering,
    Stale,
    Failed,
    Missing,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub(crate) struct NestedSequenceMedia {
    pub(crate) clip_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) expected_revision: u64,
    pub(crate) current_revision: u64,
    pub(crate) status: NestedSequenceMediaStatus,
    pub(crate) preview_job_id: Option<Uuid>,
}

pub(crate) async fn resolve_sequence_media(
    storage: &Storage,
    clip_id: Uuid,
    project_id: Uuid,
    expected_revision: u64,
    media_duration_seconds: f64,
) -> ApiResult<(NestedSequenceMedia, Option<ProjectRenderSource>)> {
    let nested = storage.get_project(project_id).await?;
    let current_revision = nested.as_ref().map_or(0, |project| project.revision);
    let previews = storage
        .list_export_jobs(Some(project_id))
        .await?
        .into_iter()
        .filter(|record| {
            record.kind == "project_preview"
                && record.job.project_revision == expected_revision
                && record.job.range_start_seconds <= 0.001
                && record.job.range_end_seconds + 0.001 >= media_duration_seconds
        })
        .collect::<Vec<_>>();
    let mut chosen = previews.first();
    let mut source = None;
    let status = if nested.is_none() {
        NestedSequenceMediaStatus::Missing
    } else if current_revision != expected_revision {
        NestedSequenceMediaStatus::Stale
    } else {
        // An existing successful preview remains usable while a newer attempt
        // renders or fails. Every caller receives this exact same choice.
        for preview in &previews {
            if preview.job.status == JobStatus::Completed
                && source_file_exists(&preview.job.output_path).await
            {
                chosen = Some(preview);
                source = Some(ProjectRenderSource {
                    path: preview.job.output_path.clone().into(),
                    kind: "video".to_owned(),
                });
                break;
            }
        }
        if source.is_some() {
            NestedSequenceMediaStatus::Ready
        } else {
            match chosen.map(|preview| preview.job.status) {
                Some(
                    JobStatus::Queued
                    | JobStatus::Preparing
                    | JobStatus::Running
                    | JobStatus::Cancelling,
                ) => NestedSequenceMediaStatus::Rendering,
                Some(JobStatus::Failed | JobStatus::Cancelled) => NestedSequenceMediaStatus::Failed,
                Some(JobStatus::Completed) | None => NestedSequenceMediaStatus::Missing,
            }
        }
    };
    Ok((
        NestedSequenceMedia {
            clip_id,
            project_id,
            expected_revision,
            current_revision,
            status,
            preview_job_id: chosen.map(|preview| preview.job.id),
        },
        source,
    ))
}

async fn source_file_exists(path: &str) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|metadata| metadata.is_file())
}

/// Overlays current source-file availability without changing the stored asset.
pub(crate) async fn project_media_availability(mut asset: MediaAsset) -> MediaAsset {
    let unavailable = match tokio::fs::metadata(&asset.path).await {
        Ok(metadata) if metadata.is_file() => None,
        Ok(_) => Some("source media path is not a regular file".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Some("source media file is missing; relink it to continue editing".to_owned())
        }
        Err(_) => {
            Some("source media file is unavailable; relink it to continue editing".to_owned())
        }
    };
    if let Some(message) = unavailable {
        asset.metadata_status = MediaMetadataStatus::Unavailable { message };
    }
    asset
}
