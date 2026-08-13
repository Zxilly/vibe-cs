use std::path::{Path, PathBuf};

use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use uuid::Uuid;
use vibe_cs_domain::{
    AgentProposalAction, AudioAnalysisOptions, BeatAlignmentApplyRequest, BeatAlignmentApplyResult,
    BeatAlignmentAudioBinding, BeatAlignmentAudioPlacement, BeatAlignmentAudioPlacementIntent,
    BeatAlignmentProposalPreview, BeatAlignmentProposalRequest, EditorProject, Highlight,
    HighlightAssetMapping, HighlightEditApplyRequest, HighlightEditApplyResult,
    HighlightEditClipInsert, HighlightEditPlan, HighlightEditProposalPreview,
    HighlightEditProposalRequest, HighlightEditTransition, HlaeProposalEvidence,
    HlaeProposalExportRequest, HlaeProposalExportResult, HlaeProposalIntent, HlaeProposalPreview,
    ProposalPrerequisite, RecordedClip, TrackKind,
};
use vibe_cs_storage::{BeatAlignmentUpdate, HighlightEditUpdate};

use crate::{ApiError, ApiJson, ApiResult, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/agent/proposals/hlae/preview",
            post(preview_hlae_proposal),
        )
        .route(
            "/api/agent/proposals/hlae/export",
            post(export_hlae_proposal),
        )
        .route(
            "/api/agent/proposals/beat-alignment/preview",
            post(preview_beat_alignment),
        )
        .route(
            "/api/agent/proposals/beat-alignment/apply",
            post(apply_beat_alignment),
        )
        .route(
            "/api/agent/proposals/highlight-edit/preview",
            post(preview_highlight_edit),
        )
        .route(
            "/api/agent/proposals/highlight-edit/apply",
            post(apply_highlight_edit),
        )
}

async fn preview_hlae_proposal(
    State(state): State<AppState>,
    ApiJson(intent): ApiJson<HlaeProposalIntent>,
) -> ApiResult<Json<HlaeProposalPreview>> {
    validate_hlae_intent(&intent)?;
    let installation_status = super::system::current_hlae_status(&state).await?;
    let evidence = match load_hlae_evidence(&state, &intent).await? {
        EvidenceLoad::Ready(evidence) => evidence,
        EvidenceLoad::Prerequisites(items) => {
            let mut preview = HlaeProposalPreview::prerequisites(items);
            preview.installation_status = Some(installation_status);
            return Ok(Json(preview));
        }
    };
    let mut preview = state
        .proposal_execution
        .preview_hlae(&intent, &evidence)
        .await?;
    preview.installation_status = Some(installation_status);
    Ok(Json(preview))
}

async fn export_hlae_proposal(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<HlaeProposalExportRequest>,
) -> ApiResult<Json<HlaeProposalExportResult>> {
    validate_hlae_intent(&request.intent)?;
    require_confirmation(request.confirmation.confirm)?;
    let evidence = match load_hlae_evidence(&state, &request.intent).await? {
        EvidenceLoad::Ready(evidence) => evidence,
        EvidenceLoad::Prerequisites(_) => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "proposal_prerequisites_changed",
                "HLAE proposal prerequisites changed; preview it again",
            ));
        }
    };
    let launch_inputs = super::system::current_hlae_launch_inputs(&state)
        .await?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                "hlae_launch_profile_unavailable",
                "Prepare the app-managed movie engine and verify the CS2 installation before exporting a consumable bundle",
            )
        })?;
    let _mutation = state.output_mutations.lock().await;
    let exported = state
        .proposal_execution
        .export_hlae(
            &request.intent,
            &evidence,
            &launch_inputs,
            &request.confirmation,
        )
        .await?;
    state
        .events
        .publish("hlae_proposal", "exported", Some(request.intent.demo_id));
    Ok(Json(exported))
}

async fn preview_beat_alignment(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<BeatAlignmentProposalRequest>,
) -> ApiResult<Json<BeatAlignmentProposalPreview>> {
    let project = state
        .storage
        .get_editor_project(request.project_id)
        .await?
        .ok_or_else(|| ApiError::not_found("editor project"))?;
    if project.revision != request.expected_revision {
        return Err(revision_conflict(project.revision));
    }
    validate_audio_placement_intent(&request.audio_placement)?;
    let verified_audio = verify_beat_audio(&state, request.audio_asset_id).await?;
    let audio_placement =
        plan_beat_audio_placement(&project, &verified_audio.binding, &request.audio_placement)?;
    let mut preview_project = project.clone();
    if let Err(error) = preview_project.apply_beat_alignment_with_audio(
        &request.draft,
        &verified_audio.binding,
        &audio_placement,
    ) {
        return Ok(Json(BeatAlignmentProposalPreview {
            ready: false,
            prerequisites: vec![ProposalPrerequisite {
                code: "invalid_editor_mapping".to_owned(),
                message: error.to_string(),
            }],
            project_id: request.project_id,
            expected_revision: request.expected_revision,
            base_fingerprint: None,
            proposal_fingerprint: None,
            confirmation_token: None,
            audio: Some(verified_audio.binding),
            audio_placement: Some(audio_placement),
            changes: request.draft.clips,
        }));
    }
    let base_fingerprint = fingerprint(b"vibe-cs-editor-project\0", &project)?;
    let proposal_fingerprint = fingerprint(
        b"vibe-cs-beat-alignment-proposal\0",
        &(
            request.project_id,
            request.expected_revision,
            &base_fingerprint,
            &verified_audio.binding,
            &audio_placement,
            &request.draft,
        ),
    )?;
    let confirmation_token = state.proposal_execution.confirmation_token(
        AgentProposalAction::ApplyBeatAlignment,
        &base_fingerprint,
        &proposal_fingerprint,
        request.expected_revision,
    )?;
    Ok(Json(BeatAlignmentProposalPreview {
        ready: true,
        prerequisites: Vec::new(),
        project_id: request.project_id,
        expected_revision: request.expected_revision,
        base_fingerprint: Some(base_fingerprint),
        proposal_fingerprint: Some(proposal_fingerprint),
        confirmation_token: Some(confirmation_token),
        audio: Some(verified_audio.binding),
        audio_placement: Some(audio_placement),
        changes: request.draft.clips,
    }))
}

async fn apply_beat_alignment(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<BeatAlignmentApplyRequest>,
) -> ApiResult<Json<BeatAlignmentApplyResult>> {
    require_confirmation(request.confirmation.confirm)?;
    let expected_revision = request.confirmation.expected_revision;
    let project = state
        .storage
        .get_editor_project(request.project_id)
        .await?
        .ok_or_else(|| ApiError::not_found("editor project"))?;
    if project.revision != expected_revision {
        return Err(revision_conflict(project.revision));
    }
    validate_audio_placement_intent(&request.audio_placement)?;
    let verified_audio = verify_beat_audio(&state, request.audio_asset_id).await?;
    let audio_placement =
        plan_beat_audio_placement(&project, &verified_audio.binding, &request.audio_placement)?;
    let mut validated = project.clone();
    validated.apply_beat_alignment_with_audio(
        &request.draft,
        &verified_audio.binding,
        &audio_placement,
    )?;
    let current_base = fingerprint(b"vibe-cs-editor-project\0", &project)?;
    let current_proposal = fingerprint(
        b"vibe-cs-beat-alignment-proposal\0",
        &(
            request.project_id,
            expected_revision,
            &current_base,
            &verified_audio.binding,
            &audio_placement,
            &request.draft,
        ),
    )?;
    if current_base != request.confirmation.base_fingerprint
        || current_proposal != request.confirmation.proposal_fingerprint
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "proposal_fingerprint_conflict",
            "Editor evidence or beat-alignment proposal changed; preview it again",
        ));
    }
    state.proposal_execution.verify_confirmation(
        AgentProposalAction::ApplyBeatAlignment,
        &current_base,
        &current_proposal,
        expected_revision,
        &request.confirmation.confirmation_token,
    )?;
    match state
        .storage
        .apply_beat_alignment(
            request.project_id,
            expected_revision,
            request.draft,
            verified_audio.binding,
            audio_placement,
        )
        .await?
    {
        BeatAlignmentUpdate::Applied {
            project,
            applied_clip_ids,
            audio_track_id,
            audio_clip_id,
            audio_clip_inserted,
        } => {
            state
                .events
                .publish("editor_project", "beat_alignment_applied", Some(project.id));
            Ok(Json(BeatAlignmentApplyResult {
                project_id: project.id,
                previous_revision: expected_revision,
                revision: project.revision,
                applied_clip_ids,
                audio_track_id,
                audio_clip_id,
                audio_clip_inserted,
                snapshot_created: true,
            }))
        }
        BeatAlignmentUpdate::ProjectNotFound => Err(ApiError::not_found("editor project")),
        BeatAlignmentUpdate::Conflict { current_revision } => {
            Err(revision_conflict(current_revision))
        }
    }
}

const MAXIMUM_BGM_BYTES: u64 = 1024 * 1024 * 1024;
const BGM_HASH_BUFFER_BYTES: usize = 256 * 1024;

struct VerifiedBeatAudio {
    binding: BeatAlignmentAudioBinding,
    _file: std::fs::File,
}

fn validate_audio_placement_intent(intent: &BeatAlignmentAudioPlacementIntent) -> ApiResult<()> {
    if !intent.timeline_start_seconds.is_finite()
        || !intent.source_in_seconds.is_finite()
        || !intent.volume.is_finite()
        || intent.timeline_start_seconds < 0.0
        || intent.source_in_seconds < 0.0
        || !(0.0..=4.0).contains(&intent.volume)
    {
        return Err(ApiError::invalid(
            "BGM placement must contain finite timeline/source offsets and volume",
        ));
    }
    Ok(())
}

async fn verify_beat_audio(state: &AppState, asset_id: Uuid) -> ApiResult<VerifiedBeatAudio> {
    let asset = state
        .storage
        .get_asset(asset_id)
        .await?
        .ok_or_else(|| ApiError::not_found("selected BGM asset"))?;
    if !asset.has_audio && !asset.kind.starts_with("audio") {
        return Err(ApiError::invalid(
            "beat alignment requires a selected asset with an audio stream",
        ));
    }
    let duration_seconds = asset
        .duration_seconds
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| ApiError::invalid("selected BGM duration is unavailable"))?;
    let path = PathBuf::from(&asset.path);
    let link_metadata = tokio::fs::symlink_metadata(&path).await.map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "bgm_unavailable",
            "The selected BGM is unavailable; select or import it again",
        )
    })?;
    if !link_metadata.is_file()
        || link_metadata.file_type().is_symlink()
        || is_reparse_point(&link_metadata)
        || link_metadata.len() == 0
        || link_metadata.len() > MAXIMUM_BGM_BYTES
        || link_metadata.len() != asset.file_size
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "bgm_identity_changed",
            "The selected BGM identity changed; preview the proposal again",
        ));
    }
    let canonical_path = tokio::fs::canonicalize(&path).await.map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "bgm_unavailable",
            "The selected BGM could not be resolved",
        )
    })?;
    let file = open_recording_read_locked(&canonical_path).map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "bgm_unavailable",
            "The selected BGM could not be locked for verification",
        )
    })?;
    let open_handle = same_file::Handle::from_file(file).map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "bgm_identity_unavailable",
            "The selected BGM identity could not be verified",
        )
    })?;
    let mut async_file =
        tokio::fs::File::from_std(open_handle.as_file().try_clone().map_err(|_| {
            ApiError::new(
                StatusCode::CONFLICT,
                "bgm_unavailable",
                "The selected BGM could not be read",
            )
        })?);
    let mut content_hash = Sha256::new();
    let mut buffer = vec![0_u8; BGM_HASH_BUFFER_BYTES];
    let mut read_bytes = 0_u64;
    loop {
        let read = async_file.read(&mut buffer).await.map_err(|_| {
            ApiError::new(
                StatusCode::CONFLICT,
                "bgm_verification_failed",
                "The selected BGM could not be verified",
            )
        })?;
        if read == 0 {
            break;
        }
        read_bytes = read_bytes.saturating_add(read as u64);
        if read_bytes > asset.file_size || read_bytes > MAXIMUM_BGM_BYTES {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "bgm_identity_changed",
                "The selected BGM changed during verification",
            ));
        }
        content_hash.update(&buffer[..read]);
    }
    if read_bytes != asset.file_size {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "bgm_identity_changed",
            "The selected BGM changed during verification",
        ));
    }
    let analysis = state
        .media
        .analyze_audio(canonical_path.clone(), AudioAnalysisOptions::default())
        .await?;
    if same_file::Handle::from_path(&canonical_path).map_or(true, |named| named != open_handle) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "bgm_identity_changed",
            "The selected BGM changed during analysis",
        ));
    }
    let file = open_handle.as_file().try_clone().map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "bgm_unavailable",
            "The selected BGM verification handle could not be retained",
        )
    })?;
    Ok(VerifiedBeatAudio {
        binding: BeatAlignmentAudioBinding {
            asset_id,
            name: asset.name.clone(),
            kind: asset.kind.clone(),
            file_size: asset.file_size,
            duration_seconds,
            asset_fingerprint: fingerprint(b"vibe-cs-media-asset\0", &asset)?,
            content_sha256: hex::encode(content_hash.finalize()),
            analysis_sha256: fingerprint(b"vibe-cs-audio-analysis\0", &analysis)?,
        },
        _file: file,
    })
}

fn plan_beat_audio_placement(
    project: &EditorProject,
    audio: &BeatAlignmentAudioBinding,
    intent: &BeatAlignmentAudioPlacementIntent,
) -> ApiResult<BeatAlignmentAudioPlacement> {
    if intent.timeline_start_seconds >= project.duration_seconds
        || intent.source_in_seconds >= audio.duration_seconds
    {
        return Err(ApiError::invalid(
            "BGM placement starts outside the selected project or audio asset",
        ));
    }
    let duration = (project.duration_seconds - intent.timeline_start_seconds)
        .min(audio.duration_seconds - intent.source_in_seconds);
    if !duration.is_finite() || duration <= 0.0 {
        return Err(ApiError::invalid("selected BGM has no placeable duration"));
    }
    let timeline_end_seconds = intent.timeline_start_seconds + duration;
    let source_out_seconds = intent.source_in_seconds + duration;
    let matching = project.tracks.iter().find_map(|track| {
        if track.kind != TrackKind::Audio || track.locked || track.muted || track.hidden {
            return None;
        }
        track.clips.iter().find_map(|clip| {
            (clip.asset_id == Some(audio.asset_id)
                && (clip.start - intent.timeline_start_seconds).abs() <= 0.000_001
                && (clip.duration - duration).abs() <= 0.000_001
                && (clip.source_in - intent.source_in_seconds).abs() <= 0.000_001
                && (clip.source_out - source_out_seconds).abs() <= 0.000_001
                && (clip.volume - intent.volume).abs() <= 0.000_001)
                .then_some((track.id, clip.id))
        })
    });
    if let Some((track_id, clip_id)) = matching {
        return Ok(BeatAlignmentAudioPlacement {
            track_id,
            clip_id,
            timeline_start_seconds: intent.timeline_start_seconds,
            timeline_end_seconds,
            source_in_seconds: intent.source_in_seconds,
            source_out_seconds,
            volume: intent.volume,
            insert_audio_track: false,
            insert_audio_clip: false,
        });
    }
    let available_track = project
        .tracks
        .iter()
        .find(|track| {
            track.kind == TrackKind::Audio && !track.locked && !track.muted && !track.hidden
        })
        .map(|track| track.id);
    let track_id = match available_track {
        Some(id) => id,
        None => deterministic_proposal_uuid(
            b"vibe-cs-beat-audio-track\0",
            &(project.id, project.revision, audio.asset_id),
        )?,
    };
    let clip_id = deterministic_proposal_uuid(
        b"vibe-cs-beat-audio-clip\0",
        &(
            project.id,
            project.revision,
            audio.asset_id,
            &audio.asset_fingerprint,
            &audio.analysis_sha256,
            intent,
        ),
    )?;
    Ok(BeatAlignmentAudioPlacement {
        track_id,
        clip_id,
        timeline_start_seconds: intent.timeline_start_seconds,
        timeline_end_seconds,
        source_in_seconds: intent.source_in_seconds,
        source_out_seconds,
        volume: intent.volume,
        insert_audio_track: available_track.is_none(),
        insert_audio_clip: true,
    })
}

fn deterministic_proposal_uuid<T: Serialize>(domain: &[u8], value: &T) -> ApiResult<Uuid> {
    let encoded = serde_json::to_vec(value).map_err(|error| {
        tracing::error!(%error, "unable to serialize deterministic proposal id");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "proposal_identifier_failed",
            "Unable to construct proposal identifiers",
        )
    })?;
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update(encoded);
    let digest = hash.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(Uuid::from_bytes(bytes))
}

async fn preview_highlight_edit(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<HighlightEditProposalRequest>,
) -> ApiResult<Json<HighlightEditProposalPreview>> {
    validate_highlight_ids(&request.highlight_ids)?;
    validate_highlight_target(&request)?;
    validate_highlight_intent(&request)?;
    let analysis = state
        .storage
        .get_analysis(request.demo_id)
        .await?
        .ok_or_else(|| ApiError::not_found("demo analysis"))?;
    let selected_highlights = selected_highlights(&analysis.highlights, &request.highlight_ids)?;
    let recorded = state
        .storage
        .list_recorded_clips()
        .await?
        .into_iter()
        .filter(|clip| clip.demo_id == Some(request.demo_id))
        .collect::<Vec<_>>();
    if recorded.is_empty() {
        return Ok(Json(unready_highlight_preview(vec![
            ProposalPrerequisite {
                code: "record_highlights_first".to_owned(),
                message: "Record the selected demo highlights before creating an edit draft."
                    .to_owned(),
            },
        ])));
    }

    let mut mappings = Vec::new();
    let mut prerequisites = Vec::new();
    let mut aggregate_bytes = 0_u64;
    for highlight_id in &request.highlight_ids {
        let mapped = recorded.iter().find(|clip| {
            trusted_highlight_id(&clip.metadata).as_deref() == Some(highlight_id.as_str())
        });
        match mapped {
            Some(clip) => match verify_managed_recording(&state, clip, analysis.tick_rate).await {
                Ok(verified) => {
                    let highlight = selected_highlights
                        .iter()
                        .find(|highlight| &highlight.id == highlight_id)
                        .expect("selected highlight ids were validated");
                    if let Err(item) = verify_requested_context(
                        &verified.mapping,
                        highlight,
                        request.intent.include_context_seconds,
                    ) {
                        prerequisites.push(item);
                    } else {
                        aggregate_bytes =
                            aggregate_bytes.saturating_add(verified.mapping.file_size);
                        mappings.push(verified.mapping);
                    }
                }
                Err(item) => prerequisites.push(item),
            },
            None => prerequisites.push(ProposalPrerequisite {
                code: "missing_recording_mapping".to_owned(),
                message: format!(
                    "Record or reconnect an asset with verified highlight metadata for {highlight_id}."
                ),
            }),
        }
    }
    if aggregate_bytes > MAXIMUM_HIGHLIGHT_EDIT_BYTES {
        prerequisites.push(ProposalPrerequisite {
            code: "recording_set_too_large".to_owned(),
            message: "The selected recordings exceed the bounded proposal verification limit."
                .to_owned(),
        });
    }
    if !prerequisites.is_empty() {
        let mut preview = unready_highlight_preview(prerequisites);
        preview.mappings = mappings;
        return Ok(Json(preview));
    }

    let existing = if let Some(project_id) = request.target_project_id {
        let project = state
            .storage
            .get_editor_project(project_id)
            .await?
            .ok_or_else(|| ApiError::not_found("editor project"))?;
        let expected_revision = request
            .expected_revision
            .expect("validated target revision");
        if project.revision != expected_revision {
            return Err(revision_conflict(project.revision));
        }
        Some(project)
    } else {
        None
    };
    let plan = build_highlight_edit_plan(
        &request,
        existing.as_ref(),
        &selected_highlights,
        mappings.clone(),
    )?;
    let mut validation_project = existing
        .clone()
        .unwrap_or_else(|| new_highlight_project(&plan));
    validation_project.apply_highlight_edit_plan(&plan)?;
    let base_fingerprint =
        highlight_base_fingerprint(&request, &selected_highlights, &mappings, existing.as_ref())?;
    let proposal_fingerprint = fingerprint(
        b"vibe-cs-highlight-edit-proposal\0",
        &(&request, &base_fingerprint, &plan),
    )?;
    let confirmation_token = state.proposal_execution.confirmation_token(
        AgentProposalAction::ApplyHighlightEdit,
        &base_fingerprint,
        &proposal_fingerprint,
        plan.expected_revision,
    )?;
    Ok(Json(HighlightEditProposalPreview {
        ready: true,
        prerequisites: Vec::new(),
        mappings,
        insertions: plan.insertions.clone(),
        target_project_id: Some(plan.project_id),
        creates_new_project: plan.create_project,
        expected_revision: plan.expected_revision,
        base_fingerprint: Some(base_fingerprint),
        proposal_fingerprint: Some(proposal_fingerprint),
        confirmation_token: Some(confirmation_token),
        plan: Some(plan),
    }))
}

async fn apply_highlight_edit(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<HighlightEditApplyRequest>,
) -> ApiResult<Json<HighlightEditApplyResult>> {
    require_confirmation(request.confirmation.confirm)?;
    validate_highlight_ids(&request.request.highlight_ids)?;
    validate_highlight_target(&request.request)?;
    validate_highlight_intent(&request.request)?;
    validate_highlight_plan_binding(&request.request, &request.plan)?;
    if request.confirmation.expected_revision != request.plan.expected_revision {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "proposal_revision_conflict",
            "Highlight edit confirmation is bound to another project revision",
        ));
    }
    state.proposal_execution.verify_confirmation(
        AgentProposalAction::ApplyHighlightEdit,
        &request.confirmation.base_fingerprint,
        &request.confirmation.proposal_fingerprint,
        request.confirmation.expected_revision,
        &request.confirmation.confirmation_token,
    )?;

    let analysis = state
        .storage
        .get_analysis(request.request.demo_id)
        .await?
        .ok_or_else(|| ApiError::not_found("demo analysis"))?;
    let selected = selected_highlights(&analysis.highlights, &request.request.highlight_ids)?;
    let mut verified_assets = Vec::with_capacity(request.plan.mappings.len());
    let mut aggregate_bytes = 0_u64;
    for expected in &request.plan.mappings {
        let recorded = state
            .storage
            .get_recorded_clip(expected.recorded_clip_id)
            .await?
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::CONFLICT,
                    "recorded_clip_changed",
                    "A recorded clip is no longer available; preview the proposal again",
                )
            })?;
        let verified = verify_managed_recording(&state, &recorded, analysis.tick_rate)
            .await
            .map_err(|item| ApiError::new(StatusCode::CONFLICT, item.code, item.message))?;
        aggregate_bytes = aggregate_bytes.saturating_add(verified.mapping.file_size);
        if &verified.mapping != expected {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "recorded_clip_changed",
                "A recorded clip changed after proposal preview; preview it again",
            ));
        }
        verified_assets.push(verified);
    }
    if aggregate_bytes > MAXIMUM_HIGHLIGHT_EDIT_BYTES {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "recording_set_too_large",
            "The selected recordings exceed the bounded proposal verification limit",
        ));
    }
    let current_project = state
        .storage
        .get_editor_project(request.plan.project_id)
        .await?;
    let already_applied = current_project.as_ref().is_some_and(|project| {
        project_has_highlight_proposal(project, &request.confirmation.proposal_fingerprint)
    });
    if !already_applied {
        match (&current_project, request.plan.create_project) {
            (Some(project), true) => return Err(revision_conflict(project.revision)),
            (None, false) => return Err(ApiError::not_found("editor project")),
            (Some(project), false) if project.revision != request.plan.expected_revision => {
                return Err(revision_conflict(project.revision));
            }
            _ => {}
        }
        let current_base = highlight_base_fingerprint(
            &request.request,
            &selected,
            &request.plan.mappings,
            current_project.as_ref(),
        )?;
        let current_proposal = fingerprint(
            b"vibe-cs-highlight-edit-proposal\0",
            &(&request.request, &current_base, &request.plan),
        )?;
        if current_base != request.confirmation.base_fingerprint
            || current_proposal != request.confirmation.proposal_fingerprint
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "proposal_fingerprint_conflict",
                "Editor or recorded highlight evidence changed; preview it again",
            ));
        }
    }

    let _mutation = state.output_mutations.lock().await;
    // Keep the read-only, no-write/no-delete file handles alive through the
    // SQLite transaction so the verified recordings cannot be replaced.
    let _verified_assets = verified_assets;
    let update = state
        .storage
        .apply_highlight_edit(request.plan, request.confirmation.proposal_fingerprint)
        .await?;
    match update {
        HighlightEditUpdate::Applied {
            project,
            inserted_clip_ids,
            project_created,
        } => {
            state
                .events
                .publish("editor_project", "highlight_edit_applied", Some(project.id));
            Ok(Json(HighlightEditApplyResult {
                project_id: project.id,
                previous_revision: if project_created {
                    0
                } else {
                    project.revision - 1
                },
                revision: project.revision,
                inserted_clip_ids,
                project_created,
                snapshot_created: !project_created,
                already_applied: false,
            }))
        }
        HighlightEditUpdate::AlreadyApplied {
            project,
            inserted_clip_ids,
            project_created,
        } => Ok(Json(HighlightEditApplyResult {
            project_id: project.id,
            previous_revision: if project_created {
                0
            } else {
                request.confirmation.expected_revision
            },
            revision: project.revision,
            inserted_clip_ids,
            project_created,
            snapshot_created: !project_created,
            already_applied: true,
        })),
        HighlightEditUpdate::ProjectNotFound => Err(ApiError::not_found("editor project")),
        HighlightEditUpdate::Conflict { current_revision } => {
            Err(revision_conflict(current_revision))
        }
    }
}

const MAXIMUM_HIGHLIGHT_EDIT_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const HIGHLIGHT_HASH_BUFFER_BYTES: usize = 1024 * 1024;

struct VerifiedManagedRecording {
    mapping: HighlightAssetMapping,
    _file: std::fs::File,
}

fn unready_highlight_preview(
    prerequisites: Vec<ProposalPrerequisite>,
) -> HighlightEditProposalPreview {
    HighlightEditProposalPreview {
        ready: false,
        prerequisites,
        mappings: Vec::new(),
        insertions: Vec::new(),
        target_project_id: None,
        creates_new_project: false,
        expected_revision: 0,
        base_fingerprint: None,
        proposal_fingerprint: None,
        confirmation_token: None,
        plan: None,
    }
}

fn validate_highlight_target(request: &HighlightEditProposalRequest) -> ApiResult<()> {
    match (request.target_project_id, request.expected_revision) {
        (Some(_), Some(revision)) if revision > 0 && request.new_project_name.is_none() => Ok(()),
        (None, None) => {
            if let Some(name) = &request.new_project_name
                && (name.trim().is_empty()
                    || name.chars().count() > 200
                    || name.chars().any(char::is_control))
            {
                return Err(ApiError::invalid(
                    "new highlight edit project name must be bounded printable text",
                ));
            }
            Ok(())
        }
        _ => Err(ApiError::invalid(
            "existing highlight edits require target_project_id and expected_revision; new projects require neither",
        )),
    }
}

fn validate_highlight_intent(request: &HighlightEditProposalRequest) -> ApiResult<()> {
    if !request.intent.include_context_seconds.is_finite()
        || !(0.0..=8.0).contains(&request.intent.include_context_seconds)
    {
        return Err(ApiError::invalid(
            "highlight edit context must be between 0 and 8 seconds",
        ));
    }
    Ok(())
}

fn validate_highlight_plan_binding(
    request: &HighlightEditProposalRequest,
    plan: &HighlightEditPlan,
) -> ApiResult<()> {
    let plan_highlights = plan
        .insertions
        .iter()
        .map(|insertion| insertion.highlight_id.as_str())
        .collect::<Vec<_>>();
    if plan.demo_id != request.demo_id
        || plan.intent != request.intent
        || plan_highlights
            != request
                .highlight_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        || match request.target_project_id {
            Some(id) => {
                plan.create_project
                    || plan.project_id != id
                    || Some(plan.expected_revision) != request.expected_revision
            }
            None => !plan.create_project || plan.expected_revision != 0,
        }
    {
        return Err(ApiError::invalid(
            "highlight edit plan is not bound to its proposal request",
        ));
    }
    Ok(())
}

fn selected_highlights(highlights: &[Highlight], ids: &[String]) -> ApiResult<Vec<Highlight>> {
    let mut selected = Vec::with_capacity(ids.len());
    let mut missing = Vec::new();
    for id in ids {
        match highlights.iter().find(|highlight| &highlight.id == id) {
            Some(highlight) => selected.push(highlight.clone()),
            None => missing.push(id.clone()),
        }
    }
    if missing.is_empty() {
        Ok(selected)
    } else {
        Err(ApiError::new(
            StatusCode::CONFLICT,
            "missing_highlight_evidence",
            format!(
                "The current analysis is missing highlights: {}",
                missing.join(", ")
            ),
        ))
    }
}

fn build_highlight_edit_plan(
    request: &HighlightEditProposalRequest,
    existing: Option<&EditorProject>,
    highlights: &[Highlight],
    mappings: Vec<HighlightAssetMapping>,
) -> ApiResult<HighlightEditPlan> {
    let (
        project_id,
        project_name,
        create_project,
        expected_revision,
        target_track_id,
        create_track,
        mut cursor,
    ) = if let Some(project) = existing {
        let target = project
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Video && !track.locked);
        (
            project.id,
            project.name.clone(),
            false,
            project.revision,
            target.map_or_else(Uuid::new_v4, |track| track.id),
            target.is_none(),
            project.duration_seconds,
        )
    } else {
        (
            Uuid::new_v4(),
            request
                .new_project_name
                .as_deref()
                .unwrap_or("AI 精选剪辑")
                .trim()
                .to_owned(),
            true,
            0,
            Uuid::new_v4(),
            true,
            0.0,
        )
    };
    let mut insertions = Vec::with_capacity(mappings.len());
    for (index, (mapping, highlight)) in mappings.iter().zip(highlights).enumerate() {
        if mapping.highlight_id != highlight.id {
            return Err(ApiError::invalid(
                "highlight mappings are not in the requested evidence order",
            ));
        }
        let context_ticks =
            seconds_to_highlight_ticks(request.intent.include_context_seconds, mapping.tick_rate)?;
        let selected_start_tick = highlight.start_tick.saturating_sub(context_ticks);
        let selected_end_tick = highlight
            .end_tick
            .checked_add(context_ticks)
            .ok_or_else(|| ApiError::invalid("highlight context exceeds the demo tick range"))?;
        if selected_start_tick < mapping.capture_start_tick
            || selected_end_tick > mapping.capture_end_tick
        {
            return Err(ApiError::new(
                StatusCode::PRECONDITION_FAILED,
                "recording_context_insufficient",
                format!(
                    "Recorded highlight {} does not contain the requested context window",
                    highlight.id
                ),
            ));
        }
        let source_start_delta = u32::try_from(selected_start_tick - mapping.capture_start_tick)
            .map_err(|_| {
                ApiError::invalid("highlight source tick span exceeds the editor limit")
            })?;
        let source_end_delta = u32::try_from(selected_end_tick - mapping.capture_start_tick)
            .map_err(|_| {
                ApiError::invalid("highlight source tick span exceeds the editor limit")
            })?;
        let source_in =
            f64::from(source_start_delta) / mapping.tick_rate / mapping.capture_playback_speed;
        let source_out =
            f64::from(source_end_delta) / mapping.tick_rate / mapping.capture_playback_speed;
        let playback_speed = request.intent.pacing.playback_speed();
        let timeline_duration = (source_out - source_in) / playback_speed;
        let end = cursor + timeline_duration;
        if !end.is_finite() || end > vibe_cs_domain::MAX_EDITOR_PROJECT_DURATION_SECONDS {
            return Err(ApiError::invalid(
                "highlight sequence exceeds the maximum editor project duration",
            ));
        }
        insertions.push(HighlightEditClipInsert {
            highlight_id: mapping.highlight_id.clone(),
            recorded_clip_id: mapping.recorded_clip_id,
            editor_clip_id: Uuid::new_v4(),
            timeline_start_seconds: cursor,
            timeline_end_seconds: end,
            source_start_tick: selected_start_tick,
            source_end_tick: selected_end_tick,
            source_in_seconds: source_in,
            source_out_seconds: source_out,
            playback_speed,
            transition_in: (index > 0 && request.intent.transition != HighlightEditTransition::Cut)
                .then_some(request.intent.transition),
            transition_duration_seconds: (index > 0
                && request.intent.transition != HighlightEditTransition::Cut)
                .then(|| {
                    request
                        .intent
                        .pacing
                        .transition_duration_seconds()
                        .min(timeline_duration / 2.0)
                }),
        });
        cursor = end;
    }
    Ok(HighlightEditPlan {
        demo_id: request.demo_id,
        intent: request.intent.clone(),
        project_id,
        project_name,
        create_project,
        expected_revision,
        target_track_id,
        create_track,
        mappings,
        insertions,
    })
}

fn new_highlight_project(plan: &HighlightEditPlan) -> EditorProject {
    let now = Utc::now();
    EditorProject {
        id: plan.project_id,
        name: plan.project_name.clone(),
        width: 1920,
        height: 1080,
        fps: 60,
        duration_seconds: 0.0,
        tracks: Vec::new(),
        markers: Vec::new(),
        settings: serde_json::json!({}),
        revision: 1,
        created_at: now,
        updated_at: now,
    }
}

fn highlight_base_fingerprint(
    request: &HighlightEditProposalRequest,
    highlights: &[Highlight],
    mappings: &[HighlightAssetMapping],
    project: Option<&EditorProject>,
) -> ApiResult<String> {
    fingerprint(
        b"vibe-cs-highlight-edit-base\0",
        &(request, highlights, mappings, project),
    )
}

fn project_has_highlight_proposal(project: &EditorProject, fingerprint: &str) -> bool {
    project
        .settings
        .get("last_agent_highlight_edit")
        .and_then(|value| value.get("proposal_fingerprint"))
        .and_then(serde_json::Value::as_str)
        == Some(fingerprint)
}

async fn verify_managed_recording(
    state: &AppState,
    clip: &RecordedClip,
    tick_rate: f64,
) -> Result<VerifiedManagedRecording, ProposalPrerequisite> {
    if !clip.duration_seconds.is_finite()
        || clip.duration_seconds <= 0.0
        || trusted_highlight_id(&clip.metadata).is_none()
        || !tick_rate.is_finite()
        || !(1.0..=256.0).contains(&tick_rate)
    {
        return Err(recording_prerequisite(
            "invalid_recording_metadata",
            "A selected recording has invalid duration or highlight metadata.",
        ));
    }
    let capture_start_tick = trusted_metadata_tick(&clip.metadata, "effective_start_tick")
        .ok_or_else(|| {
            recording_prerequisite(
                "recording_timeline_missing",
                "A selected recording is missing its trusted capture start tick.",
            )
        })?;
    let capture_end_tick = trusted_metadata_tick(&clip.metadata, "effective_end_tick")
        .filter(|end| *end > capture_start_tick)
        .ok_or_else(|| {
            recording_prerequisite(
                "recording_timeline_missing",
                "A selected recording is missing its trusted capture end tick.",
            )
        })?;
    let capture_tick_span = u32::try_from(capture_end_tick - capture_start_tick).map_err(|_| {
        recording_prerequisite(
            "recording_timeline_invalid",
            "A selected recording exceeds the supported capture tick span.",
        )
    })?;
    let capture_duration_at_normal_speed = f64::from(capture_tick_span) / tick_rate;
    let capture_playback_speed = capture_duration_at_normal_speed / clip.duration_seconds;
    if !capture_playback_speed.is_finite() || !(0.05..=16.0).contains(&capture_playback_speed) {
        return Err(recording_prerequisite(
            "recording_timeline_invalid",
            "A selected recording has inconsistent capture timing metadata.",
        ));
    }
    let root = state.data_dir().join("recordings");
    let root_metadata = tokio::fs::symlink_metadata(&root).await.map_err(|_| {
        recording_prerequisite(
            "recording_store_unavailable",
            "The managed recording store is unavailable.",
        )
    })?;
    if !root_metadata.is_dir()
        || root_metadata.file_type().is_symlink()
        || is_reparse_point(&root_metadata)
    {
        return Err(recording_prerequisite(
            "unsafe_recording_store",
            "The managed recording store must be a regular local directory.",
        ));
    }
    let canonical_root = tokio::fs::canonicalize(&root).await.map_err(|_| {
        recording_prerequisite(
            "recording_store_unavailable",
            "The managed recording store could not be resolved.",
        )
    })?;
    let path = PathBuf::from(&clip.path);
    let metadata = tokio::fs::symlink_metadata(&path).await.map_err(|_| {
        recording_prerequisite(
            "recording_file_missing",
            "A selected recording is no longer available.",
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(recording_prerequisite(
            "unsafe_recording_file",
            "Selected recordings must be regular files, not links or reparse points.",
        ));
    }
    if metadata.len() == 0 || metadata.len() > MAXIMUM_HIGHLIGHT_EDIT_BYTES {
        return Err(recording_prerequisite(
            "recording_file_too_large",
            "A selected recording is empty or exceeds the bounded verification limit.",
        ));
    }
    let canonical_path = tokio::fs::canonicalize(&path).await.map_err(|_| {
        recording_prerequisite(
            "recording_file_missing",
            "A selected recording could not be resolved.",
        )
    })?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(recording_prerequisite(
            "recording_not_managed",
            "A selected recording is outside the managed recording store.",
        ));
    }
    let file = open_recording_read_locked(&canonical_path).map_err(|_| {
        recording_prerequisite(
            "recording_file_unavailable",
            "A selected recording could not be locked for verification.",
        )
    })?;
    let open_handle = same_file::Handle::from_file(file).map_err(|_| {
        recording_prerequisite(
            "recording_identity_unavailable",
            "A selected recording identity could not be verified.",
        )
    })?;
    let mut async_file =
        tokio::fs::File::from_std(open_handle.as_file().try_clone().map_err(|_| {
            recording_prerequisite(
                "recording_file_unavailable",
                "A selected recording could not be read for verification.",
            )
        })?);
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; HIGHLIGHT_HASH_BUFFER_BYTES];
    let mut read_bytes = 0_u64;
    loop {
        let read = async_file.read(&mut buffer).await.map_err(|_| {
            recording_prerequisite(
                "recording_verification_failed",
                "A selected recording could not be read for verification.",
            )
        })?;
        if read == 0 {
            break;
        }
        read_bytes = read_bytes.saturating_add(read as u64);
        if read_bytes > metadata.len() || read_bytes > MAXIMUM_HIGHLIGHT_EDIT_BYTES {
            return Err(recording_prerequisite(
                "recording_changed",
                "A selected recording changed during verification.",
            ));
        }
        hash.update(&buffer[..read]);
    }
    if read_bytes != metadata.len()
        || same_file::Handle::from_path(&canonical_path).map_or(true, |named| named != open_handle)
    {
        return Err(recording_prerequisite(
            "recording_changed",
            "A selected recording changed during verification.",
        ));
    }
    let file = open_handle.as_file().try_clone().map_err(|_| {
        recording_prerequisite(
            "recording_file_unavailable",
            "A selected recording verification handle could not be retained.",
        )
    })?;
    Ok(VerifiedManagedRecording {
        mapping: HighlightAssetMapping {
            highlight_id: trusted_highlight_id(&clip.metadata).expect("validated highlight id"),
            recorded_clip_id: clip.id,
            path: clip.path.clone(),
            duration_seconds: clip.duration_seconds,
            file_size: read_bytes,
            content_sha256: hex::encode(hash.finalize()),
            capture_start_tick,
            capture_end_tick,
            tick_rate,
            capture_playback_speed,
        },
        _file: file,
    })
}

fn trusted_metadata_tick(metadata: &serde_json::Value, key: &str) -> Option<u64> {
    metadata.get(key).and_then(serde_json::Value::as_u64)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the rounded value is checked finite and within the tiny 8s × 256Hz proposal bound"
)]
fn seconds_to_highlight_ticks(seconds: f64, tick_rate: f64) -> ApiResult<u64> {
    let ticks = (seconds * tick_rate).round();
    if !ticks.is_finite() || !(0.0..=2_048.0).contains(&ticks) {
        return Err(ApiError::invalid(
            "highlight context cannot be represented in demo ticks",
        ));
    }
    Ok(ticks as u64)
}

fn verify_requested_context(
    mapping: &HighlightAssetMapping,
    highlight: &Highlight,
    include_context_seconds: f64,
) -> Result<(), ProposalPrerequisite> {
    let context_ticks = seconds_to_highlight_ticks(include_context_seconds, mapping.tick_rate)
        .map_err(|_| {
            recording_prerequisite(
                "recording_context_invalid",
                "The requested highlight context cannot be represented in demo ticks.",
            )
        })?;
    let selected_start_tick = highlight.start_tick.saturating_sub(context_ticks);
    let selected_end_tick = highlight
        .end_tick
        .checked_add(context_ticks)
        .ok_or_else(|| {
            recording_prerequisite(
                "recording_context_invalid",
                "The requested highlight context exceeds the demo tick range.",
            )
        })?;
    if selected_start_tick < mapping.capture_start_tick
        || selected_end_tick > mapping.capture_end_tick
    {
        return Err(recording_prerequisite(
            "recording_context_insufficient",
            &format!(
                "Recorded highlight {} does not contain {:.2} seconds of requested context on both sides.",
                highlight.id, include_context_seconds
            ),
        ));
    }
    Ok(())
}

fn recording_prerequisite(code: &str, message: &str) -> ProposalPrerequisite {
    ProposalPrerequisite {
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

fn open_recording_read_locked(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        options.share_mode(FILE_SHARE_READ);
    }
    options.open(path)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

enum EvidenceLoad {
    Ready(HlaeProposalEvidence),
    Prerequisites(Vec<ProposalPrerequisite>),
}

async fn load_hlae_evidence(
    state: &AppState,
    intent: &HlaeProposalIntent,
) -> ApiResult<EvidenceLoad> {
    let demo = state
        .storage
        .get_demo(intent.demo_id)
        .await?
        .ok_or_else(|| ApiError::not_found("demo"))?;
    let Some(analysis) = state.storage.get_analysis(intent.demo_id).await? else {
        return Ok(EvidenceLoad::Prerequisites(vec![ProposalPrerequisite {
            code: "analyze_demo_first".to_owned(),
            message: "Analyze the demo before generating camera paths.".to_owned(),
        }]));
    };
    let Ok(replay) = state.analysis.replay(demo.clone()).await else {
        return Ok(EvidenceLoad::Prerequisites(vec![ProposalPrerequisite {
            code: "replay_evidence_unavailable".to_owned(),
            message: "Generate replay evidence before creating an HLAE camera proposal.".to_owned(),
        }]));
    };
    Ok(EvidenceLoad::Ready(HlaeProposalEvidence {
        demo_path: demo.path,
        demo_content_sha256: demo.content_sha256,
        tick_rate: analysis.tick_rate,
        highlights: analysis.highlights,
        replay_frames: replay.frames,
    }))
}

fn validate_hlae_intent(intent: &HlaeProposalIntent) -> ApiResult<()> {
    validate_highlight_ids(&intent.highlight_ids)?;
    if !intent.lead_seconds.is_finite()
        || !(0.5..=8.0).contains(&intent.lead_seconds)
        || !intent.tail_seconds.is_finite()
        || !(0.5..=8.0).contains(&intent.tail_seconds)
    {
        return Err(ApiError::invalid(
            "HLAE lead and tail context must each be between 0.5 and 8 seconds",
        ));
    }
    Ok(())
}

fn validate_highlight_ids(ids: &[String]) -> ApiResult<()> {
    use std::collections::HashSet;

    if ids.is_empty() || ids.len() > 16 {
        return Err(ApiError::invalid(
            "proposal requires between 1 and 16 highlight ids",
        ));
    }
    let mut unique = HashSet::new();
    if ids.iter().any(|id| {
        id.is_empty()
            || id.chars().count() > 200
            || id.chars().any(char::is_control)
            || !unique.insert(id)
    }) {
        return Err(ApiError::invalid(
            "proposal highlight ids must be unique, bounded text",
        ));
    }
    Ok(())
}

fn require_confirmation(confirm: bool) -> ApiResult<()> {
    if confirm {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "explicit_confirmation_required",
            "Set confirm=true after reviewing the exact proposal",
        ))
    }
}

fn revision_conflict(current_revision: u64) -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "revision_conflict",
        format!("Editor project is at revision {current_revision}"),
    )
}

fn fingerprint<T: Serialize>(domain: &[u8], value: &T) -> ApiResult<String> {
    let encoded = serde_json::to_vec(value).map_err(|error| {
        tracing::error!(%error, "unable to serialize proposal fingerprint");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "proposal_fingerprint_failed",
            "Unable to fingerprint the proposal",
        )
    })?;
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update(encoded);
    Ok(hex::encode(hash.finalize()))
}

fn trusted_highlight_id(metadata: &serde_json::Value) -> Option<String> {
    metadata
        .get("highlight_id")
        .or_else(|| metadata.get("source_highlight_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty() && value.chars().count() <= 200)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use chrono::Utc;
    use vibe_cs_domain::{
        AudioAnalysis, HighlightEditPacing, HighlightEditProposalIntent, HighlightKind, MediaAsset,
        MediaMetadataStatus, MediaProxyStatus,
    };

    use super::*;
    use crate::{MediaPort, ProbedMediaMetadata};

    #[derive(Debug)]
    struct FixedAudioAnalysis;

    #[async_trait]
    impl MediaPort for FixedAudioAnalysis {
        async fn probe(
            &self,
            _path: PathBuf,
        ) -> Result<ProbedMediaMetadata, vibe_cs_domain::DomainError> {
            unreachable!("probe is not used by beat proposal verification")
        }

        async fn waveform(
            &self,
            _path: PathBuf,
            _buckets: usize,
        ) -> Result<Vec<f32>, vibe_cs_domain::DomainError> {
            unreachable!("waveform is not used by beat proposal verification")
        }

        async fn analyze_audio(
            &self,
            _path: PathBuf,
            _options: AudioAnalysisOptions,
        ) -> Result<AudioAnalysis, vibe_cs_domain::DomainError> {
            Ok(AudioAnalysis {
                duration_seconds: 4.0,
                analysis_sample_rate: 11_025,
                bpm: Some(120.0),
                tempo_confidence: 1.0,
                beats: Vec::new(),
                onsets: Vec::new(),
                energy: Vec::new(),
                sections: Vec::new(),
                limitations: Vec::new(),
            })
        }
    }

    #[test]
    fn highlight_mapping_requires_explicit_metadata() {
        assert_eq!(
            trusted_highlight_id(&serde_json::json!({"highlight_id":"h-1"})).as_deref(),
            Some("h-1")
        );
        assert!(trusted_highlight_id(&serde_json::json!({"title":"h-1"})).is_none());
    }

    #[test]
    fn fingerprint_is_domain_separated_and_stable() {
        let first = fingerprint(b"one\0", &serde_json::json!({"a":1})).unwrap();
        let same = fingerprint(b"one\0", &serde_json::json!({"a":1})).unwrap();
        let other = fingerprint(b"two\0", &serde_json::json!({"a":1})).unwrap();
        assert_eq!(first, same);
        assert_ne!(first, other);
    }

    #[tokio::test]
    async fn replacing_selected_bgm_changes_signed_content_identity() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("bgm.wav");
        tokio::fs::write(&path, b"first-audio").await.expect("BGM");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let asset_id = Uuid::new_v4();
        storage
            .put_asset(MediaAsset {
                id: asset_id,
                project_id: None,
                path: path.to_string_lossy().into_owned(),
                name: "BGM".to_owned(),
                kind: "audio/wav".to_owned(),
                duration_seconds: Some(4.0),
                width: None,
                height: None,
                file_size: 11,
                has_audio: true,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Ready,
                created_at: Utc::now(),
            })
            .await
            .expect("asset");
        let state = AppState::new(storage, directory.path().to_path_buf())
            .with_media(Arc::new(FixedAudioAnalysis));
        let first = verify_beat_audio(&state, asset_id)
            .await
            .expect("first verification");
        let first_binding = first.binding.clone();
        drop(first);
        tokio::fs::write(&path, b"other-audio")
            .await
            .expect("replace BGM");
        let second = verify_beat_audio(&state, asset_id)
            .await
            .expect("second verification");
        assert_eq!(
            first_binding.asset_fingerprint,
            second.binding.asset_fingerprint
        );
        assert_eq!(
            first_binding.analysis_sha256,
            second.binding.analysis_sha256
        );
        assert_ne!(first_binding.content_sha256, second.binding.content_sha256);
        let first_proposal = fingerprint(
            b"vibe-cs-beat-alignment-proposal\0",
            &(first_binding.content_sha256, first_binding.analysis_sha256),
        )
        .expect("first proposal");
        let second_proposal = fingerprint(
            b"vibe-cs-beat-alignment-proposal\0",
            &(
                second.binding.content_sha256,
                second.binding.analysis_sha256,
            ),
        )
        .expect("second proposal");
        assert_ne!(first_proposal, second_proposal);
    }

    fn highlight(id: &str, start_tick: u64, end_tick: u64) -> Highlight {
        Highlight {
            id: id.to_owned(),
            player_id: "player-1".to_owned(),
            round: 1,
            start_tick,
            end_tick,
            kind: HighlightKind::MultiKill,
            title: id.to_owned(),
            description: String::new(),
            score: 1.0,
            tags: Vec::new(),
            victims: Vec::new(),
        }
    }

    fn highlight_mapping(
        id: &str,
        capture_start_tick: u64,
        capture_end_tick: u64,
    ) -> HighlightAssetMapping {
        HighlightAssetMapping {
            highlight_id: id.to_owned(),
            recorded_clip_id: Uuid::new_v4(),
            path: format!("{id}.mp4"),
            duration_seconds: 10.0,
            file_size: 100,
            content_sha256: "00".repeat(32),
            capture_start_tick,
            capture_end_tick,
            tick_rate: 64.0,
            capture_playback_speed: 1.0,
        }
    }

    #[test]
    fn highlight_plan_materializes_context_pacing_and_supported_transition() {
        let request = HighlightEditProposalRequest {
            demo_id: Uuid::new_v4(),
            highlight_ids: vec!["h-1".to_owned(), "h-2".to_owned()],
            intent: HighlightEditProposalIntent {
                pacing: HighlightEditPacing::Energetic,
                include_context_seconds: 1.0,
                transition: HighlightEditTransition::Slide,
            },
            target_project_id: None,
            expected_revision: None,
            new_project_name: None,
        };
        let highlights = vec![highlight("h-1", 192, 320), highlight("h-2", 832, 960)];
        let mappings = vec![
            highlight_mapping("h-1", 0, 640),
            highlight_mapping("h-2", 640, 1_280),
        ];

        let plan = build_highlight_edit_plan(&request, None, &highlights, mappings)
            .expect("typed highlight plan");
        let first = &plan.insertions[0];
        assert_eq!((first.source_start_tick, first.source_end_tick), (128, 384));
        assert!((first.source_in_seconds - 2.0).abs() < 0.000_001);
        assert!((first.source_out_seconds - 6.0).abs() < 0.000_001);
        assert!((first.playback_speed - 1.15).abs() < 0.000_001);
        assert!((first.timeline_end_seconds - 4.0 / 1.15).abs() < 0.000_001);
        assert_eq!(first.transition_in, None);
        assert_eq!(first.transition_duration_seconds, None);
        let second = &plan.insertions[1];
        assert_eq!(second.transition_in, Some(HighlightEditTransition::Slide));
        assert_eq!(second.transition_duration_seconds, Some(0.20));

        let mut project = new_highlight_project(&plan);
        project
            .apply_highlight_edit_plan(&plan)
            .expect("plan applies to editor timeline");
        let clips = &project.tracks[0].clips;
        assert_eq!(clips[1].transition_in.as_deref(), Some("slide"));
        assert!((clips[0].source_in - 2.0).abs() < 0.000_001);
        assert!((clips[0].speed - 1.15).abs() < 0.000_001);
        assert_eq!(clips[1].metadata["transition_duration"], 0.20);
    }

    #[test]
    fn highlight_context_is_never_silently_truncated() {
        let mapping = highlight_mapping("h-1", 192, 320);
        let error = verify_requested_context(&mapping, &highlight("h-1", 192, 320), 1.0)
            .expect_err("recording lacks requested context");
        assert_eq!(error.code, "recording_context_insufficient");
    }

    #[tokio::test]
    async fn managed_recording_drift_changes_evidence_and_locked_file_cannot_be_replaced() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let recordings = directory.path().join("recordings");
        tokio::fs::create_dir_all(&recordings)
            .await
            .expect("recording directory");
        let path = recordings.join("highlight.mp4");
        tokio::fs::write(&path, b"first").await.expect("recording");
        let state = AppState::new(
            vibe_cs_storage::Storage::open_in_memory()
                .await
                .expect("storage"),
            directory.path().to_path_buf(),
        );
        let clip = RecordedClip {
            id: Uuid::new_v4(),
            path: path.to_string_lossy().into_owned(),
            title: "Highlight".to_owned(),
            duration_seconds: 2.0,
            demo_id: Some(Uuid::new_v4()),
            player_name: None,
            category: "highlight".to_owned(),
            tags: Vec::new(),
            metadata: serde_json::json!({
                "highlight_id":"h-1",
                "effective_start_tick": 0,
                "effective_end_tick": 128
            }),
            created_at: Utc::now(),
        };
        let first = verify_managed_recording(&state, &clip, 64.0)
            .await
            .expect("first evidence");
        #[cfg(windows)]
        assert!(tokio::fs::write(&path, b"blocked").await.is_err());
        let first_hash = first.mapping.content_sha256.clone();
        drop(first);
        tokio::fs::write(&path, b"second")
            .await
            .expect("replace after release");
        let second = verify_managed_recording(&state, &clip, 64.0)
            .await
            .expect("second evidence");
        assert_ne!(first_hash, second.mapping.content_sha256);
    }
}
