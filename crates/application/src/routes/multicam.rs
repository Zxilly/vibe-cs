use std::{collections::HashSet, path::PathBuf};

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::post,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;
use vibe_cs_domain::{
    MediaAsset, Project, ProjectChangeAuthor, ProjectChangeGroup, ProjectEditOperation,
    ProjectPatch, ProjectPatchScope, TimelineClip, TimelineClipMaterial, TimelineClipTransitions,
    TimelinePlacement, TimelineTrack, TrackKind, Transform,
};

use crate::{ApiError, ApiJson, ApiResult, AppState};

const AUDIO_SYNC_SAMPLES_PER_SECOND: usize = 100;
const MAXIMUM_AUDIO_SYNC_SECONDS: usize = 30;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects/{id}/multicam", post(create_multicam))
        .route(
            "/api/projects/{id}/multicam/switch",
            post(switch_multicam_angle),
        )
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
enum MulticamSyncMethod {
    Timecode,
    Audio,
    Marker,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct CreateMulticamRequest {
    base_revision: u64,
    asset_ids: Vec<Uuid>,
    sync_method: MulticamSyncMethod,
    marker_label: Option<String>,
    switch_audio: bool,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct SwitchMulticamAngleRequest {
    base_revision: u64,
    group_id: Uuid,
    angle: u32,
    timeline_time: f64,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct MulticamEditResponse {
    project: Project,
    change_group: ProjectChangeGroup,
    group_id: Uuid,
}

#[derive(Debug, Clone)]
struct AngleAlignment {
    asset: MediaAsset,
    timeline_start: f64,
    source_in: f64,
}

async fn create_multicam(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<CreateMulticamRequest>,
) -> ApiResult<Json<MulticamEditResponse>> {
    let project = state
        .storage
        .get_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    if project.revision != request.base_revision {
        return Err(vibe_cs_domain::DomainError::Conflict(format!(
            "project is at revision {}, multicam creation expects {}",
            project.revision, request.base_revision
        ))
        .into());
    }
    let unique = request.asset_ids.iter().copied().collect::<HashSet<_>>();
    if unique.len() != request.asset_ids.len() || !(2..=9).contains(&unique.len()) {
        return Err(ApiError::invalid(
            "multicam requires 2 to 9 unique video assets",
        ));
    }
    let mut assets = Vec::with_capacity(request.asset_ids.len());
    for asset_id in request.asset_ids {
        let asset = state
            .storage
            .get_asset(asset_id)
            .await?
            .ok_or_else(|| ApiError::not_found("media asset"))?;
        if asset.project_id != Some(id)
            || (!asset.kind.eq_ignore_ascii_case("video")
                && !asset.kind.to_ascii_lowercase().starts_with("video/"))
            || asset
                .duration_seconds
                .is_none_or(|duration| !duration.is_finite() || duration <= 0.0)
        {
            return Err(ApiError::invalid(
                "multicam assets must be project video media with known duration",
            ));
        }
        assets.push(asset);
    }
    let alignments = align_assets(
        &state,
        assets,
        request.sync_method,
        request.marker_label.as_deref(),
    )
    .await?;
    let group_id = Uuid::new_v4();
    let (tracks, story_track) = multicam_tracks(
        &project,
        &alignments,
        group_id,
        request.sync_method,
        request.switch_audio,
    )?;
    let mut operations = vec![ProjectEditOperation::ReplaceTrack {
        track_id: project.document.story_track_id,
        track: Box::new(story_track),
    }];
    operations.extend(
        project
            .document
            .tracks
            .iter()
            .filter(|track| track.id != project.document.story_track_id)
            .map(|track| ProjectEditOperation::RemoveTrack { track_id: track.id }),
    );
    operations.extend(tracks.into_iter().enumerate().map(|(index, track)| {
        ProjectEditOperation::InsertTrack {
            index: index + 1,
            track: Box::new(track),
        }
    }));
    operations.push(ProjectEditOperation::ReplaceMarkers {
        markers: Vec::new(),
    });
    let patch = ProjectPatch {
        project_id: id,
        base_revision: project.revision,
        scope: ProjectPatchScope::Project,
        author: ProjectChangeAuthor::Human,
        reverts_change_group_id: None,
        summary: format!("Create {}-angle multicam", alignments.len()),
        operations,
    };
    let (project, change_group) = state
        .storage
        .apply_project_patch(patch, Uuid::new_v4(), chrono::Utc::now())
        .await?;
    state.events.publish("project", "edited", Some(id));
    Ok(Json(MulticamEditResponse {
        project,
        change_group,
        group_id,
    }))
}

async fn align_assets(
    state: &AppState,
    assets: Vec<MediaAsset>,
    method: MulticamSyncMethod,
    marker_label: Option<&str>,
) -> ApiResult<Vec<AngleAlignment>> {
    let raw_offsets = match method {
        MulticamSyncMethod::Timecode => {
            let mut starts = Vec::with_capacity(assets.len());
            for asset in &assets {
                let probe = state.media.probe(PathBuf::from(&asset.path)).await?;
                starts.push(probe.timecode_start_seconds.ok_or_else(|| {
                    ApiError::invalid(format!(
                        "asset {} has no embedded source timecode",
                        asset.name
                    ))
                })?);
            }
            let reference = starts[0];
            starts.into_iter().map(|start| start - reference).collect()
        }
        MulticamSyncMethod::Marker => {
            let label = marker_label
                .map(str::trim)
                .filter(|label| !label.is_empty())
                .ok_or_else(|| ApiError::invalid("marker sync requires one exact marker label"))?;
            let points = assets
                .iter()
                .map(|asset| {
                    asset
                        .markers
                        .iter()
                        .find(|marker| marker.label == label)
                        .map(|marker| marker.time)
                        .ok_or_else(|| {
                            ApiError::invalid(format!(
                                "asset {} has no marker named {label}",
                                asset.name
                            ))
                        })
                })
                .collect::<ApiResult<Vec<_>>>()?;
            let reference = points[0];
            points.into_iter().map(|point| reference - point).collect()
        }
        MulticamSyncMethod::Audio => {
            let mut waveforms = Vec::with_capacity(assets.len());
            for asset in &assets {
                if !asset.has_audio {
                    return Err(ApiError::invalid(format!(
                        "asset {} has no audio for synchronization",
                        asset.name
                    )));
                }
                let buckets = ((asset.duration_seconds.unwrap_or(0.0)
                    * AUDIO_SYNC_SAMPLES_PER_SECOND as f64)
                    .ceil() as usize)
                    .clamp(AUDIO_SYNC_SAMPLES_PER_SECOND, 10_000);
                waveforms.push(
                    state
                        .media
                        .waveform(PathBuf::from(&asset.path), buckets)
                        .await?,
                );
            }
            let reference = &waveforms[0];
            let mut offsets = vec![0.0];
            for waveform in waveforms.iter().skip(1) {
                offsets.push(audio_alignment_offset(
                    reference,
                    waveform,
                    AUDIO_SYNC_SAMPLES_PER_SECOND,
                )?);
            }
            offsets
        }
    };
    Ok(assets
        .into_iter()
        .zip(raw_offsets)
        .map(|(asset, offset)| AngleAlignment {
            asset,
            timeline_start: offset.max(0.0),
            source_in: (-offset).max(0.0),
        })
        .collect())
}

fn audio_alignment_offset(
    reference: &[f32],
    candidate: &[f32],
    sample_rate: usize,
) -> ApiResult<f64> {
    let maximum_lag = MAXIMUM_AUDIO_SYNC_SECONDS * sample_rate;
    let mut best: Option<(isize, f64)> = None;
    for lag in -(maximum_lag as isize)..=(maximum_lag as isize) {
        let mut count = 0_usize;
        let mut sum_reference = 0.0_f64;
        let mut sum_candidate = 0.0_f64;
        let mut sum_reference_sq = 0.0_f64;
        let mut sum_candidate_sq = 0.0_f64;
        let mut dot = 0.0_f64;
        for (index, left) in reference.iter().copied().enumerate() {
            let candidate_index = index as isize - lag;
            if candidate_index < 0 || candidate_index >= candidate.len() as isize {
                continue;
            }
            let right = candidate[candidate_index as usize];
            let left = f64::from(left);
            let right = f64::from(right);
            count += 1;
            sum_reference += left;
            sum_candidate += right;
            sum_reference_sq += left * left;
            sum_candidate_sq += right * right;
            dot += left * right;
        }
        if count < sample_rate {
            continue;
        }
        let count = count as f64;
        let covariance = dot - sum_reference * sum_candidate / count;
        let left_energy = sum_reference_sq - sum_reference * sum_reference / count;
        let right_energy = sum_candidate_sq - sum_candidate * sum_candidate / count;
        let score = covariance
            / (left_energy.max(0.0) * right_energy.max(0.0))
                .sqrt()
                .max(1e-9);
        if score.is_finite() && best.is_none_or(|(_, current)| score > current) {
            best = Some((lag, score));
        }
    }
    let (lag, score) =
        best.ok_or_else(|| ApiError::invalid("audio synchronization has no overlapping signal"))?;
    if score < 0.2 {
        return Err(ApiError::invalid(
            "audio synchronization confidence is too low",
        ));
    }
    Ok(lag as f64 / sample_rate as f64)
}

fn multicam_tracks(
    project: &Project,
    alignments: &[AngleAlignment],
    group_id: Uuid,
    method: MulticamSyncMethod,
    switch_audio: bool,
) -> ApiResult<(Vec<TimelineTrack>, TimelineTrack)> {
    let clips = alignments
        .iter()
        .enumerate()
        .map(|(index, alignment)| {
            multicam_clip(
                alignment,
                group_id,
                index as u32 + 1,
                method,
                switch_audio,
                index == 0,
            )
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let story = TimelineTrack {
        id: project.document.story_track_id,
        name: format!("Angle 1 · {}", alignments[0].asset.name),
        kind: TrackKind::Video,
        order: 0,
        muted: false,
        solo: false,
        volume: 1.0,
        pan: 0.0,
        keyframes: Vec::new(),
        locked: false,
        hidden: false,
        clips: vec![clips[0].clone()],
    };
    let mut tracks = clips
        .into_iter()
        .skip(1)
        .enumerate()
        .map(|(index, clip)| TimelineTrack {
            id: Uuid::new_v4(),
            name: format!("Angle {} · {}", index + 2, alignments[index + 1].asset.name),
            kind: TrackKind::Video,
            order: index as u32 + 1,
            muted: false,
            solo: false,
            volume: 1.0,
            pan: 0.0,
            keyframes: Vec::new(),
            locked: false,
            hidden: false,
            clips: vec![clip],
        })
        .collect::<Vec<_>>();
    if !switch_audio {
        let reference = &alignments[0];
        let mut audio = multicam_clip(reference, group_id, 1, method, false, true)?;
        audio.id = Uuid::new_v4();
        audio.name = format!("Multicam Audio · {}", reference.asset.name);
        audio.placement.volume = 1.0;
        tracks.push(TimelineTrack {
            id: Uuid::new_v4(),
            name: "Multicam Audio".to_owned(),
            kind: TrackKind::Audio,
            order: tracks.len() as u32 + 1,
            muted: false,
            solo: false,
            volume: 1.0,
            pan: 0.0,
            keyframes: Vec::new(),
            locked: false,
            hidden: false,
            clips: vec![audio],
        });
    }
    Ok((tracks, story))
}

fn multicam_clip(
    alignment: &AngleAlignment,
    group_id: Uuid,
    angle: u32,
    method: MulticamSyncMethod,
    switch_audio: bool,
    enabled: bool,
) -> ApiResult<TimelineClip> {
    let media_duration = alignment
        .asset
        .duration_seconds
        .ok_or_else(|| ApiError::invalid("multicam asset duration is unavailable"))?;
    let duration = media_duration - alignment.source_in;
    if duration <= 0.0 {
        return Err(ApiError::invalid(
            "multicam synchronization removes an entire angle",
        ));
    }
    Ok(TimelineClip {
        id: Uuid::new_v4(),
        name: format!("Angle {angle} · {}", alignment.asset.name),
        capture_intent: None,
        material: TimelineClipMaterial::Asset {
            asset_id: alignment.asset.id,
            media_duration_seconds: media_duration,
        },
        placement: TimelinePlacement {
            start: alignment.timeline_start,
            duration,
            source_in: alignment.source_in,
            source_out: media_duration,
            speed: 1.0,
            reverse: false,
            frame_hold_source_time: None,
            volume: if switch_audio { 1.0 } else { 0.0 },
            pan: 0.0,
            enabled,
        },
        transform: Transform::default(),
        effects: Vec::new(),
        transitions: TimelineClipTransitions::default(),
        text: None,
        metadata: serde_json::json!({"multicam":{"group_id":group_id,"angle":angle,"angle_name":alignment.asset.name,"sync_method":method,"switch_audio":switch_audio}}),
        group_id: None,
        link_group_id: None,
        keyframes: Vec::new(),
        speed_segments: Vec::new(),
    })
}

async fn switch_multicam_angle(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<SwitchMulticamAngleRequest>,
) -> ApiResult<Json<MulticamEditResponse>> {
    let project = state
        .storage
        .get_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    if project.revision != request.base_revision {
        return Err(vibe_cs_domain::DomainError::Conflict(format!(
            "project is at revision {}, multicam switch expects {}",
            project.revision, request.base_revision
        ))
        .into());
    }
    if !request.timeline_time.is_finite()
        || request.timeline_time < 0.0
        || request.timeline_time > project.document.duration_seconds
    {
        return Err(ApiError::invalid(
            "multicam switch time is outside the Project",
        ));
    }
    let mut selected_angle_available = false;
    let mut operations = Vec::new();
    for track in &project.document.tracks {
        if !matches!(track.kind, TrackKind::Video | TrackKind::Overlay) {
            continue;
        }
        let angle = track.clips.iter().find_map(|clip| {
            multicam_metadata(clip)
                .filter(|metadata| metadata.0 == request.group_id)
                .map(|metadata| metadata.1)
        });
        let Some(angle) = angle else {
            continue;
        };
        let mut changed = false;
        let mut clips = Vec::new();
        for clip in &track.clips {
            let belongs = multicam_metadata(clip)
                .is_some_and(|metadata| metadata.0 == request.group_id && metadata.1 == angle);
            if !belongs
                || request.timeline_time < clip.placement.start
                || request.timeline_time >= clip.placement.start + clip.placement.duration
            {
                clips.push(clip.clone());
                continue;
            }
            if angle == request.angle {
                selected_angle_available = true;
            }
            clips.extend(switch_clip_at(
                clip,
                request.timeline_time,
                angle == request.angle,
                project.document.fps,
            ));
            changed = true;
        }
        if changed {
            operations.push(ProjectEditOperation::ReplaceTrackClips {
                track_id: track.id,
                clips,
            });
        }
    }
    if !selected_angle_available {
        return Err(ApiError::invalid(
            "selected multicam angle has no media at the switch time",
        ));
    }
    if operations.is_empty() {
        return Err(ApiError::invalid("multicam group does not exist"));
    }
    let patch = ProjectPatch {
        project_id: id,
        base_revision: project.revision,
        scope: ProjectPatchScope::Project,
        author: ProjectChangeAuthor::Human,
        reverts_change_group_id: None,
        summary: format!("Switch multicam to angle {}", request.angle),
        operations,
    };
    let (project, change_group) = state
        .storage
        .apply_project_patch(patch, Uuid::new_v4(), chrono::Utc::now())
        .await?;
    state.events.publish("project", "edited", Some(id));
    Ok(Json(MulticamEditResponse {
        project,
        change_group,
        group_id: request.group_id,
    }))
}

fn multicam_metadata(clip: &TimelineClip) -> Option<(Uuid, u32, bool)> {
    let value = clip.metadata.get("multicam")?;
    let group_id = Uuid::parse_str(value.get("group_id")?.as_str()?).ok()?;
    let angle = u32::try_from(value.get("angle")?.as_u64()?).ok()?;
    let switch_audio = value.get("switch_audio")?.as_bool()?;
    Some((group_id, angle, switch_audio))
}

fn switch_clip_at(clip: &TimelineClip, time: f64, enabled: bool, fps: u32) -> Vec<TimelineClip> {
    let frame = 1.0 / f64::from(fps);
    let local = time - clip.placement.start;
    if local <= frame / 2.0 {
        let mut clip = clip.clone();
        clip.placement.enabled = enabled;
        return vec![clip];
    }
    if clip.placement.duration - local <= frame / 2.0 {
        return vec![clip.clone()];
    }
    let source_cut = clip.placement.source_in + local;
    let mut left = clip.clone();
    left.placement.duration = local;
    left.placement.source_out = source_cut;
    left.transitions.video_out = None;
    left.transitions.audio_out = None;
    let mut right = clip.clone();
    right.id = Uuid::new_v4();
    right.placement.start = time;
    right.placement.duration -= local;
    right.placement.source_in = source_cut;
    right.placement.enabled = enabled;
    right.transitions.video_in = None;
    right.transitions.audio_in = None;
    vec![left, right]
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;
    use vibe_cs_domain::{
        EditingDocument, EditingDocumentSettings, EditorMarker, EditorMarkerKind,
        MediaMetadataStatus, MediaProxyStatus,
    };

    fn asset(project_id: Uuid, id: Uuid, name: &str, marker_time: f64) -> MediaAsset {
        MediaAsset {
            id,
            project_id: Some(project_id),
            path: format!("C:/media/{id}.mp4"),
            name: name.to_owned(),
            kind: "video".to_owned(),
            duration_seconds: Some(10.0),
            width: Some(1920),
            height: Some(1080),
            file_size: 1,
            has_audio: true,
            proxy_path: None,
            proxy_status: MediaProxyStatus::NotRequested,
            waveform: None,
            metadata_status: MediaMetadataStatus::Ready,
            markers: vec![EditorMarker {
                id: Uuid::new_v4(),
                time: marker_time,
                duration: 0.0,
                label: "Clap".to_owned(),
                color: "#00AAFF".to_owned(),
                kind: EditorMarkerKind::Comment,
                comment: String::new(),
            }],
            created_at: DateTime::UNIX_EPOCH,
        }
    }

    #[test]
    fn audio_sync_recovers_positive_and_negative_offsets() {
        let mut reference = vec![0.0_f32; 500];
        reference[100] = 1.0;
        reference[240] = 0.7;
        let mut delayed = vec![0.0_f32; 500];
        delayed[150] = 1.0;
        delayed[290] = 0.7;
        assert!(
            (audio_alignment_offset(&reference, &delayed, 100).expect("delay") + 0.5).abs() < 1e-6
        );
        assert!(
            (audio_alignment_offset(&delayed, &reference, 100).expect("lead") - 0.5).abs() < 1e-6
        );
    }

    #[test]
    fn switching_splits_source_truth_and_changes_only_the_new_segment() {
        let clip = TimelineClip {
            id: Uuid::from_u128(1),
            name: "Angle 1".to_owned(),
            capture_intent: None,
            material: TimelineClipMaterial::Asset {
                asset_id: Uuid::from_u128(2),
                media_duration_seconds: 10.0,
            },
            placement: TimelinePlacement {
                start: 0.0,
                duration: 10.0,
                source_in: 0.0,
                source_out: 10.0,
                speed: 1.0,
                reverse: false,
                frame_hold_source_time: None,
                volume: 1.0,
                pan: 0.0,
                enabled: true,
            },
            transform: Transform::default(),
            effects: Vec::new(),
            transitions: TimelineClipTransitions::default(),
            text: None,
            metadata: serde_json::json!({"multicam":{"group_id":Uuid::from_u128(3),"angle":1,"angle_name":"One","sync_method":"marker","switch_audio":true}}),
            group_id: None,
            link_group_id: None,
            keyframes: Vec::new(),
            speed_segments: Vec::new(),
        };
        let switched = switch_clip_at(&clip, 4.0, false, 60);
        assert_eq!(switched.len(), 2);
        assert_eq!(
            (
                switched[0].placement.source_out,
                switched[1].placement.source_in
            ),
            (4.0, 4.0)
        );
        assert!(switched[0].placement.enabled);
        assert!(!switched[1].placement.enabled);
    }

    #[tokio::test]
    async fn marker_sync_and_live_switch_commit_one_project_change_each() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let data = tempfile::tempdir().expect("data");
        let project_id = Uuid::new_v4();
        let story_id = Uuid::new_v4();
        storage
            .create_project(Project {
                id: project_id,
                name: "Multicam".to_owned(),
                revision: 1,
                document: EditingDocument {
                    width: 1920,
                    height: 1080,
                    fps: 60,
                    duration_seconds: 0.0,
                    story_track_id: story_id,
                    tracks: vec![TimelineTrack {
                        id: story_id,
                        name: "Story".to_owned(),
                        kind: TrackKind::Video,
                        order: 0,
                        muted: false,
                        solo: false,
                        volume: 1.0,
                        pan: 0.0,
                        keyframes: Vec::new(),
                        locked: false,
                        hidden: false,
                        clips: Vec::new(),
                    }],
                    markers: Vec::new(),
                    settings: EditingDocumentSettings::default(),
                },
                created_at: DateTime::UNIX_EPOCH,
                updated_at: DateTime::UNIX_EPOCH,
            })
            .await
            .expect("project");
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        storage
            .put_asset(asset(project_id, first_id, "One", 2.0))
            .await
            .expect("first");
        storage
            .put_asset(asset(project_id, second_id, "Two", 3.0))
            .await
            .expect("second");
        let state = AppState::new(storage, data.path().to_path_buf());

        let created = create_multicam(
            State(state.clone()),
            Path(project_id),
            ApiJson(CreateMulticamRequest {
                base_revision: 1,
                asset_ids: vec![first_id, second_id],
                sync_method: MulticamSyncMethod::Marker,
                marker_label: Some("Clap".to_owned()),
                switch_audio: false,
            }),
        )
        .await
        .expect("create multicam")
        .0;
        assert_eq!(created.project.revision, 2);
        assert_eq!(created.project.document.tracks.len(), 3);
        assert_eq!(
            created.project.document.tracks[1].clips[0]
                .placement
                .source_in,
            1.0
        );
        assert!(
            !created.project.document.tracks[1].clips[0]
                .placement
                .enabled
        );
        assert_eq!(created.project.document.tracks[2].kind, TrackKind::Audio);

        let switched = switch_multicam_angle(
            State(state),
            Path(project_id),
            ApiJson(SwitchMulticamAngleRequest {
                base_revision: 2,
                group_id: created.group_id,
                angle: 2,
                timeline_time: 4.0,
            }),
        )
        .await
        .expect("switch angle")
        .0;
        assert_eq!(switched.project.revision, 3);
        let story = &switched.project.document.tracks[0];
        let angle_two = &switched.project.document.tracks[1];
        assert_eq!(story.clips.len(), 2);
        assert!(!story.clips[1].placement.enabled);
        assert_eq!(angle_two.clips.len(), 2);
        assert!(angle_two.clips[1].placement.enabled);
        assert_eq!(switched.project.document.tracks[2].clips.len(), 1);
    }
}
