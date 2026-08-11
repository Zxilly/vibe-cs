use std::path::{Path, PathBuf};

use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use uuid::Uuid;
use vibe_cs_domain::{
    AgentProposalAction, BeatAlignmentApplyRequest, BeatAlignmentApplyResult,
    BeatAlignmentProposalPreview, BeatAlignmentProposalRequest, EditorProject, Highlight,
    HighlightAssetMapping, HighlightEditApplyRequest, HighlightEditApplyResult,
    HighlightEditClipInsert, HighlightEditPlan, HighlightEditProposalPreview,
    HighlightEditProposalRequest, HlaeProposalEvidence, HlaeProposalExportRequest,
    HlaeProposalExportResult, HlaeProposalIntent, HlaeProposalPreview, ProposalPrerequisite,
    RecordedClip, TrackKind,
};
use vibe_cs_storage::{BeatAlignmentUpdate, HighlightEditUpdate};

use crate::{ApiError, ApiJson, ApiResult, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/agent/proposals/hlae/preview",
            post(preview_hlae_proposal),
        )
        .route(
            "/api/v1/agent/proposals/hlae/export",
            post(export_hlae_proposal),
        )
        .route(
            "/api/v1/agent/proposals/beat-alignment/preview",
            post(preview_beat_alignment),
        )
        .route(
            "/api/v1/agent/proposals/beat-alignment/apply",
            post(apply_beat_alignment),
        )
        .route(
            "/api/v1/agent/proposals/highlight-edit/preview",
            post(preview_highlight_edit),
        )
        .route(
            "/api/v1/agent/proposals/highlight-edit/apply",
            post(apply_highlight_edit),
        )
}

async fn preview_hlae_proposal(
    State(state): State<AppState>,
    ApiJson(intent): ApiJson<HlaeProposalIntent>,
) -> ApiResult<Json<HlaeProposalPreview>> {
    validate_hlae_intent(&intent)?;
    let evidence = match load_hlae_evidence(&state, &intent).await? {
        EvidenceLoad::Ready(evidence) => evidence,
        EvidenceLoad::Prerequisites(items) => {
            return Ok(Json(HlaeProposalPreview::prerequisites(items)));
        }
    };
    Ok(Json(
        state
            .proposal_execution
            .preview_hlae(&intent, &evidence)
            .await?,
    ))
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
    let _mutation = state.output_mutations.lock().await;
    let exported = state
        .proposal_execution
        .export_hlae(
            &request.intent,
            &evidence,
            request.confirmation.expected_revision,
            &request.confirmation.base_fingerprint,
            &request.confirmation.proposal_fingerprint,
            &request.confirmation.confirmation_token,
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
    let mut preview_project = project.clone();
    if let Err(error) = preview_project.apply_beat_alignment_draft(&request.draft) {
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
            changes: request.draft.clips,
        }));
    }
    let base_fingerprint = fingerprint(b"vibe-cs-editor-project-v1\0", &project)?;
    let proposal_fingerprint = fingerprint(
        b"vibe-cs-beat-alignment-proposal-v1\0",
        &(
            request.project_id,
            request.expected_revision,
            &base_fingerprint,
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
    let mut validated = project.clone();
    validated.apply_beat_alignment_draft(&request.draft)?;
    let current_base = fingerprint(b"vibe-cs-editor-project-v1\0", &project)?;
    let current_proposal = fingerprint(
        b"vibe-cs-beat-alignment-proposal-v1\0",
        &(
            request.project_id,
            expected_revision,
            &current_base,
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
        .apply_beat_alignment(request.project_id, expected_revision, request.draft)
        .await?
    {
        BeatAlignmentUpdate::Applied {
            project,
            applied_clip_ids,
        } => {
            state
                .events
                .publish("editor_project", "beat_alignment_applied", Some(project.id));
            Ok(Json(BeatAlignmentApplyResult {
                project_id: project.id,
                previous_revision: expected_revision,
                revision: project.revision,
                applied_clip_ids,
                snapshot_created: true,
            }))
        }
        BeatAlignmentUpdate::ProjectNotFound => Err(ApiError::not_found("editor project")),
        BeatAlignmentUpdate::Conflict { current_revision } => {
            Err(revision_conflict(current_revision))
        }
    }
}

async fn preview_highlight_edit(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<HighlightEditProposalRequest>,
) -> ApiResult<Json<HighlightEditProposalPreview>> {
    validate_highlight_ids(&request.highlight_ids)?;
    validate_highlight_target(&request)?;
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
            Some(clip) => match verify_managed_recording(&state, clip).await {
                Ok(verified) => {
                    aggregate_bytes = aggregate_bytes.saturating_add(verified.mapping.file_size);
                    mappings.push(verified.mapping);
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
    let plan = build_highlight_edit_plan(&request, existing.as_ref(), mappings.clone())?;
    let mut validation_project = existing
        .clone()
        .unwrap_or_else(|| new_highlight_project(&plan));
    validation_project.apply_highlight_edit_plan(&plan)?;
    let base_fingerprint =
        highlight_base_fingerprint(&request, &selected_highlights, &mappings, existing.as_ref())?;
    let proposal_fingerprint = fingerprint(
        b"vibe-cs-highlight-edit-proposal-v1\0",
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
        let verified = verify_managed_recording(&state, &recorded)
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
            b"vibe-cs-highlight-edit-proposal-v1\0",
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
    for (index, mapping) in mappings.iter().enumerate() {
        let end = cursor + mapping.duration_seconds;
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
            source_in_seconds: 0.0,
            source_out_seconds: mapping.duration_seconds,
            transition_in: (index > 0).then(|| "fade".to_owned()),
        });
        cursor = end;
    }
    Ok(HighlightEditPlan {
        demo_id: request.demo_id,
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
        b"vibe-cs-highlight-edit-base-v1\0",
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
) -> Result<VerifiedManagedRecording, ProposalPrerequisite> {
    if !clip.duration_seconds.is_finite()
        || clip.duration_seconds <= 0.0
        || trusted_highlight_id(&clip.metadata).is_none()
    {
        return Err(recording_prerequisite(
            "invalid_recording_metadata",
            "A selected recording has invalid duration or highlight metadata.",
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
        },
        _file: file,
    })
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
    validate_highlight_ids(&intent.highlight_ids)
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
    use chrono::Utc;

    use super::*;

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
            metadata: serde_json::json!({"highlight_id":"h-1"}),
            created_at: Utc::now(),
        };
        let first = verify_managed_recording(&state, &clip)
            .await
            .expect("first evidence");
        #[cfg(windows)]
        assert!(tokio::fs::write(&path, b"blocked").await.is_err());
        let first_hash = first.mapping.content_sha256.clone();
        drop(first);
        tokio::fs::write(&path, b"second")
            .await
            .expect("replace after release");
        let second = verify_managed_recording(&state, &clip)
            .await
            .expect("second evidence");
        assert_ne!(first_hash, second.mapping.content_sha256);
    }
}
