//! Owns published Take attachment through completion, contention and restart.
//! Recording and Activity reads do not repair the Project Head.

use crate::AppState;
use chrono::Utc;
use serde_json::Value;
use std::collections::HashMap;
use tokio::time::Duration;
use uuid::Uuid;
use vibe_cs_domain::{
    DomainError, MediaAsset, MediaMetadataStatus, MediaProxyStatus, ProjectChangeAuthor,
    ProjectEditOperation, ProjectPatch, ProjectPatchScope, TimelineClipMaterial,
};
use vibe_cs_storage::StorageError;

const POLL_INTERVAL: Duration = Duration::from_millis(400);
const MAXIMUM_RETRY_DELAY: Duration = Duration::from_secs(5);
const MISSING_POLL_LIMIT: u32 = 15;

/// Restores ownership after runtime job recovery, including already-published
/// terminal output that had not reached the Project Head when the host stopped.
pub(crate) async fn recover(state: &AppState) -> vibe_cs_storage::Result<()> {
    for job in state.storage.list_recording_jobs().await? {
        if !job.outputs.is_empty() || !job.status.is_terminal() {
            observe_recording(state.clone(), job.id).await;
        }
    }
    Ok(())
}

/// Performs an initial attachment now, then retains one owner until all current
/// published outputs are reconciled and the recording is terminal.
pub(crate) async fn observe_recording(state: AppState, id: Uuid) {
    if !state.recording_materializations.lock().await.insert(id) {
        return;
    }
    let (initial_done, initial_result) = tokio::sync::oneshot::channel();
    // Spawn before awaiting attachment: cancelling an initiating IPC call must
    // not leave a registered job without its materialization owner.
    tokio::spawn(async move {
        let mut owner = MaterializationOwner {
            id,
            missing_polls: 0,
            terminal_announced: false,
            retry_delay: POLL_INTERVAL,
        };
        let complete = owner.poll(&state).await;
        let _ = initial_done.send(());
        if !complete {
            loop {
                tokio::time::sleep(owner.retry_delay).await;
                if owner.poll(&state).await {
                    break;
                }
            }
        }
        state.recording_materializations.lock().await.remove(&id);
    });
    let _ = initial_result.await;
}

struct MaterializationOwner {
    id: Uuid,
    missing_polls: u32,
    terminal_announced: bool,
    retry_delay: Duration,
}

impl MaterializationOwner {
    async fn poll(&mut self, state: &AppState) -> bool {
        let job = match state.storage.get_recording_job(self.id).await {
            Ok(Some(job)) => {
                self.missing_polls = 0;
                job
            }
            Ok(None) => {
                self.missing_polls += 1;
                if self.missing_polls < MISSING_POLL_LIMIT {
                    return false;
                }
                state.release_recording_session(self.id).await;
                return true;
            }
            Err(error) => return self.failed(&error),
        };
        if job.status.is_terminal() && !self.terminal_announced {
            // Capture ownership ends independently of a contended Project edit.
            state.release_recording_session(self.id).await;
            state
                .events
                .publish("recording_job", "finished", Some(self.id));
            self.terminal_announced = true;
        }
        match reconcile_project_recording(state, self.id).await {
            Ok(()) => {
                self.retry_delay = POLL_INTERVAL;
                job.status.is_terminal()
            }
            Err(error) => self.failed(&error) && job.status.is_terminal(),
        }
    }

    fn failed(&mut self, error: &StorageError) -> bool {
        let retry =
            error.is_transient() || matches!(error, StorageError::Domain(DomainError::Conflict(_)));
        if retry {
            self.retry_delay = (self.retry_delay * 2).min(MAXIMUM_RETRY_DELAY);
            tracing::warn!(%error, job_id = %self.id, "Take attachment remains owned and will retry");
        } else {
            tracing::error!(%error, job_id = %self.id, "unable to materialize published Take");
        }
        !retry
    }
}

async fn reconcile_project_recording(
    state: &AppState,
    job_id: Uuid,
) -> vibe_cs_storage::Result<()> {
    let Some(project_id) = state.storage.get_project_recording_run(job_id).await? else {
        return Ok(());
    };
    let job = state
        .storage
        .get_recording_job(job_id)
        .await?
        .ok_or_else(|| DomainError::NotFound("recording job".to_owned()))?;
    let project = state
        .storage
        .get_project(project_id)
        .await?
        .ok_or_else(|| DomainError::NotFound("project".to_owned()))?;
    // Read receipts after the Head: any concurrent attachment after this read
    // is rejected by the revision check and retried by the owning task.
    let reconciled_clips = state
        .storage
        .reconciled_recording_clip_ids(project_id, job_id)
        .await?;
    let mut replacements = HashMap::new();
    for output in &job.outputs {
        let Some(clip_id) = output
            .metadata
            .get("request_id")
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
        else {
            continue;
        };
        if reconciled_clips.contains(&clip_id) {
            continue;
        }
        let Some(clip) = project
            .document
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .find(|clip| clip.id == clip_id)
        else {
            continue;
        };
        if matches!(clip.material, TimelineClipMaterial::Take { take_id, .. } if take_id == output.id)
        {
            continue;
        }
        let Some(request) = job.items.iter().find(|item| item.id == Some(clip_id)) else {
            continue;
        };
        let Some(intent) = &clip.capture_intent else {
            continue;
        };
        // The recorder executed the job's immutable request, not the current
        // Capture Intent. An intervening capture edit cannot bless old footage.
        if request.spec_fingerprint()? != intent.fingerprint()? {
            continue;
        }
        let metadata = tokio::fs::metadata(&output.path).await.map_err(|error| {
            DomainError::InvalidInput(format!(
                "recorded media {} is unavailable: {error}",
                output.path
            ))
        })?;
        let asset_id = output.id;
        state
            .storage
            .put_asset(MediaAsset {
                id: asset_id,
                project_id: Some(project.id),
                path: output.path.clone(),
                name: output.title.clone(),
                kind: "video".to_owned(),
                duration_seconds: Some(output.duration_seconds),
                width: None,
                height: None,
                file_size: metadata.len(),
                has_audio: true,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Ready,
                markers: Vec::new(),
                created_at: output.created_at,
            })
            .await?;
        let recorded = clip.with_recorded_take(output.id, asset_id, output.duration_seconds)?;
        replacements.insert(clip_id, recorded);
    }
    if replacements.is_empty() {
        return Ok(());
    }
    let replacement_count = replacements.len();
    let operations = project
        .document
        .tracks
        .iter()
        .flat_map(|track| &track.clips)
        .filter_map(|clip| {
            replacements.get(&clip.id).cloned().map(|replacement| {
                ProjectEditOperation::ReplaceClip {
                    clip_id: clip.id,
                    clip: Box::new(replacement),
                }
            })
        })
        .collect();
    state
        .storage
        .apply_project_patch(
            ProjectPatch {
                project_id,
                base_revision: project.revision,
                scope: ProjectPatchScope::Project,
                author: ProjectChangeAuthor::System {
                    operation_id: job_id,
                },
                reverts_change_group_id: None,
                summary: format!("Attach {replacement_count} recorded Take(s)"),
                operations,
            },
            Uuid::new_v4(),
            Utc::now(),
        )
        .await?;
    state.events.publish("project", "edited", Some(project_id));
    Ok(())
}

#[cfg(test)]
mod recorded_take_operation_tests {
    use super::*;
    use serde_json::json;
    use vibe_cs_domain::{
        JobStatus, Project, ProjectEditLease, RecordedClip, RecordingJob, TimelineClip,
        TimelineClipMaterializationState,
    };

    async fn recording_fixture(storage: &vibe_cs_storage::Storage) -> Project {
        let story_id = Uuid::new_v4();
        let project = serde_json::from_value(json!({
            "id":Uuid::new_v4(),"name":"Recording reconciliation","revision":1,
            "document":{"width":1920,"height":1080,"fps":60,"duration_seconds":6.0,
                "story_track_id":story_id,"tracks":[{"id":story_id,"name":"Story","kind":"video","order":0,
                    "muted":false,"solo":false,"volume":1.0,"pan":0.0,"keyframes":[],"locked":false,"hidden":false,
                    "clips":[{"id":Uuid::new_v4(),"name":"NiKo","capture_intent":{
                        "demo_id":Uuid::new_v4(),"highlight_id":null,"player_id":"76561198041683378",
                        "start_tick":171_405,"end_tick":171_789,"pre_roll_seconds":0.0,
                        "post_roll_seconds":0.0,"victim_pov":false,"camera_style":"pov","presentation":null},
                    "material":{"kind":"planned"},
                    "placement":{"start":0.0,"duration":6.0,"source_in":0.0,"source_out":6.0,
                        "speed":1.0,"reverse":false,"frame_hold_source_time":null,"volume":1.0,"pan":0.0,"enabled":true},
                    "transform":{"x":0.0,"y":0.0,"scale_x":1.0,"scale_y":1.0,"rotation":0.0,"opacity":1.0},
                    "effects":[],"transitions":{"video_in":null,"video_out":null,"audio_in":null,"audio_out":null},
                    "text":null,"metadata":{},"group_id":null,"link_group_id":null,"keyframes":[],"speed_segments":[]}]}],
                "markers":[],"settings":{"source_demo_ids":[],"ripple_sequence_markers":false,"use_media_proxies":false}},
            "created_at":Utc::now(),"updated_at":Utc::now()
        })).expect("Project");
        storage.create_project(project).await.unwrap()
    }

    async fn completed_recording(
        state: &AppState,
        directory: &std::path::Path,
        project: &Project,
    ) -> RecordingJob {
        let clip = &project.document.tracks[0].clips[0];
        let id = Uuid::new_v4();
        let path = directory.join(format!("{id}.mp4"));
        std::fs::write(&path, b"published recorder output").unwrap();
        let job = RecordingJob {
            id,
            retry_of: None,
            status: JobStatus::Completed,
            items: vec![
                clip.capture_intent
                    .clone()
                    .unwrap()
                    .into_recording_request(clip.id, &clip.name),
            ],
            current_index: 1,
            progress: 1.0,
            message: "Complete".to_owned(),
            outputs: vec![RecordedClip {
                id: Uuid::new_v4(),
                path: path.to_string_lossy().into_owned(),
                title: clip.name.clone(),
                duration_seconds: 6.0,
                demo_id: Some(clip.capture_intent.as_ref().unwrap().demo_id),
                player_name: None,
                category: "pov".to_owned(),
                tags: Vec::new(),
                metadata: json!({"request_id":clip.id}),
                created_at: Utc::now(),
            }],
            error_code: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        state.storage.put_recording_job(job.clone()).await.unwrap();
        state
            .storage
            .bind_project_recording_run(id, project.id)
            .await
            .unwrap();
        job
    }

    async fn hide_capture_hud(state: &AppState, project: Project) -> Project {
        let mut clip = project.document.tracks[0].clips[0].clone();
        clip.capture_intent.as_mut().unwrap().presentation =
            Some(vibe_cs_domain::RecordingPresentation {
                show_hud: false,
                ..Default::default()
            });
        state
            .storage
            .apply_project_patch(
                ProjectPatch {
                    project_id: project.id,
                    base_revision: project.revision,
                    scope: ProjectPatchScope::Project,
                    author: ProjectChangeAuthor::Human,
                    reverts_change_group_id: None,
                    summary: "Hide capture HUD".to_owned(),
                    operations: vec![ProjectEditOperation::ReplaceClip {
                        clip_id: clip.id,
                        clip: Box::new(clip),
                    }],
                },
                Uuid::new_v4(),
                Utc::now(),
            )
            .await
            .unwrap()
            .0
    }

    async fn wait_for_owner(state: &AppState, id: Uuid) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while state.recording_materializations.lock().await.contains(&id) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("materialization owner completes");
    }

    #[tokio::test]
    async fn terminal_attachment_retries_edit_lease_contention_without_an_activity_reader() {
        let directory = tempfile::tempdir().unwrap();
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let state = AppState::new(storage.clone(), directory.path().to_owned());
        let project = recording_fixture(&storage).await;
        let job = completed_recording(&state, directory.path(), &project).await;
        let lease_id = Uuid::new_v4();
        storage
            .acquire_project_edit_lease(ProjectEditLease {
                id: lease_id,
                project_id: project.id,
                session_id: Uuid::new_v4(),
                turn_id: Uuid::new_v4(),
                base_revision: project.revision,
                acquired_at: Utc::now(),
                heartbeat_at: Utc::now(),
            })
            .await
            .unwrap();
        state
            .reserve_recording_session(job.id, false)
            .await
            .unwrap();
        observe_recording(state.clone(), job.id).await;
        assert_eq!(
            *state.active_recording.lock().await,
            None,
            "capture ends even while attachment waits"
        );
        assert!(
            state
                .recording_materializations
                .lock()
                .await
                .contains(&job.id)
        );
        assert_eq!(
            storage
                .get_project(project.id)
                .await
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        storage
            .release_project_edit_lease(project.id, lease_id)
            .await
            .unwrap();
        storage
            .apply_project_patch(
                ProjectPatch {
                    project_id: project.id,
                    base_revision: 1,
                    scope: ProjectPatchScope::Project,
                    author: ProjectChangeAuthor::Human,
                    reverts_change_group_id: None,
                    summary: "Rename while attachment is waiting".to_owned(),
                    operations: vec![ProjectEditOperation::RenameProject {
                        name: "Human name".to_owned(),
                    }],
                },
                Uuid::new_v4(),
                Utc::now(),
            )
            .await
            .unwrap();
        wait_for_owner(&state, job.id).await;
        let attached = storage.get_project(project.id).await.unwrap().unwrap();
        assert_eq!(attached.revision, 3);
        assert_eq!(attached.name, "Human name");
        assert!(
            matches!(attached.document.tracks[0].clips[0].material, TimelineClipMaterial::Take { take_id, .. } if take_id == job.outputs[0].id)
        );
        observe_recording(state, job.id).await;
        assert_eq!(
            storage
                .get_project(project.id)
                .await
                .unwrap()
                .unwrap()
                .revision,
            3
        );
    }

    #[tokio::test]
    async fn publication_owner_attaches_running_outputs_and_finishes_without_reads() {
        let directory = tempfile::tempdir().unwrap();
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let state = AppState::new(storage.clone(), directory.path().to_owned());
        let project = recording_fixture(&storage).await;
        let mut job = completed_recording(&state, directory.path(), &project).await;
        job.status = JobStatus::Running;
        storage.put_recording_job(job.clone()).await.unwrap();
        observe_recording(state.clone(), job.id).await;
        assert_eq!(
            storage
                .get_project(project.id)
                .await
                .unwrap()
                .unwrap()
                .revision,
            2
        );
        assert!(
            state
                .recording_materializations
                .lock()
                .await
                .contains(&job.id)
        );
        job.status = JobStatus::Failed;
        storage.put_recording_job(job.clone()).await.unwrap();
        wait_for_owner(&state, job.id).await;
        assert_eq!(
            storage
                .get_project(project.id)
                .await
                .unwrap()
                .unwrap()
                .revision,
            2
        );
    }

    #[tokio::test]
    async fn startup_recovers_published_take_once_without_recording_or_activity_reads() {
        let directory = tempfile::tempdir().unwrap();
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let old_state = AppState::new(storage.clone(), directory.path().to_owned());
        let project = recording_fixture(&storage).await;
        let job = completed_recording(&old_state, directory.path(), &project).await;
        drop(old_state);
        let restarted = AppState::new(storage.clone(), directory.path().to_owned());
        restarted
            .recover_recording_materializations()
            .await
            .unwrap();
        wait_for_owner(&restarted, job.id).await;
        let attached = storage.get_project(project.id).await.unwrap().unwrap();
        assert_eq!(attached.revision, 2);
        assert!(
            matches!(attached.document.tracks[0].clips[0].material, TimelineClipMaterial::Take { take_id, .. } if take_id == job.outputs[0].id)
        );
        restarted
            .recover_recording_materializations()
            .await
            .unwrap();
        assert_eq!(
            storage
                .get_project(project.id)
                .await
                .unwrap()
                .unwrap()
                .revision,
            2
        );
    }

    #[tokio::test]
    async fn old_recording_completion_cannot_replace_a_new_take() {
        // Cover both an edited Capture Intent and explicit same-intent re-recording,
        // including an old completion that was not reconciled before the new one.
        for edit_intent in [true, false] {
            for attach_old_first in [true, false] {
                let directory = tempfile::tempdir().unwrap();
                let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
                let state = AppState::new(storage.clone(), directory.path().to_owned());
                let mut project = recording_fixture(&storage).await;
                let old = completed_recording(&state, directory.path(), &project).await;
                if attach_old_first {
                    reconcile_project_recording(&state, old.id).await.unwrap();
                    project = storage.get_project(project.id).await.unwrap().unwrap();
                }
                if edit_intent {
                    project = hide_capture_hud(&state, project).await;
                }
                let new = completed_recording(&state, directory.path(), &project).await;
                reconcile_project_recording(&state, new.id).await.unwrap();
                let recorded = storage.get_project(project.id).await.unwrap().unwrap();
                assert!(matches!(recorded.document.tracks[0].clips[0].material,
                    TimelineClipMaterial::Take {take_id, ..} if take_id == new.outputs[0].id));

                reconcile_project_recording(&state, old.id).await.unwrap();
                let replayed = storage.get_project(project.id).await.unwrap().unwrap();
                assert_eq!(
                    replayed, recorded,
                    "old completion overwrote new Take: edit={edit_intent}, attached={attach_old_first}"
                );

                let group = storage
                    .list_project_change_groups(project.id, 1)
                    .await
                    .unwrap()
                    .remove(0);
                let (undone, _) = storage
                    .revert_project_change_group(
                        project.id,
                        group.id,
                        recorded.revision,
                        ProjectChangeAuthor::Human,
                        Uuid::new_v4(),
                        Utc::now(),
                    )
                    .await
                    .unwrap();
                reconcile_project_recording(&state, new.id).await.unwrap();
                reconcile_project_recording(&state, old.id).await.unwrap();
                assert_eq!(
                    storage.get_project(project.id).await.unwrap().unwrap(),
                    undone,
                    "reading a completed recording must not undo the user's revert"
                );
            }
        }
    }

    #[tokio::test]
    async fn completion_after_capture_edit_does_not_claim_the_new_intent() {
        let directory = tempfile::tempdir().unwrap();
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let state = AppState::new(storage.clone(), directory.path().to_owned());
        let project = recording_fixture(&storage).await;
        let old = completed_recording(&state, directory.path(), &project).await;
        let edited = hide_capture_hud(&state, project).await;

        reconcile_project_recording(&state, old.id).await.unwrap();
        assert_eq!(
            storage.get_project(edited.id).await.unwrap().unwrap(),
            edited
        );
    }

    #[tokio::test]
    async fn running_and_failed_recordings_attach_each_successful_clip_once() {
        let directory = tempfile::tempdir().unwrap();
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let state = AppState::new(storage.clone(), directory.path().to_owned());
        let mut project = recording_fixture(&storage).await;
        let mut second = project.document.tracks[0].clips[0].clone();
        second.placement.start = 6.0;
        project = storage
            .apply_project_patch(
                ProjectPatch {
                    project_id: project.id,
                    base_revision: project.revision,
                    scope: ProjectPatchScope::Project,
                    author: ProjectChangeAuthor::Human,
                    reverts_change_group_id: None,
                    summary: "Add second shot".to_owned(),
                    operations: vec![ProjectEditOperation::InsertClip {
                        track_id: project.document.story_track_id,
                        index: 1,
                        clip: Box::new(second),
                    }],
                },
                Uuid::new_v4(),
                Utc::now(),
            )
            .await
            .unwrap()
            .0;
        let second = &project.document.tracks[0].clips[1];
        let mut job = completed_recording(&state, directory.path(), &project).await;
        job.items.push(
            second
                .capture_intent
                .clone()
                .unwrap()
                .into_recording_request(second.id, &second.name),
        );
        job.status = JobStatus::Running;
        job.progress = 0.5;
        storage.put_recording_job(job.clone()).await.unwrap();
        reconcile_project_recording(&state, job.id).await.unwrap();
        let partial = storage.get_project(project.id).await.unwrap().unwrap();
        assert_eq!(partial.revision, project.revision + 1);
        assert!(matches!(
            partial.document.tracks[0].clips[0].material,
            TimelineClipMaterial::Take { .. }
        ));
        assert!(matches!(
            partial.document.tracks[0].clips[1].material,
            TimelineClipMaterial::Planned
        ));

        // The first output is still in the snapshot when a later output arrives,
        // and a subsequent recorder failure must not discard either success.
        let mut output = job.outputs[0].clone();
        output.id = Uuid::new_v4();
        output.metadata = json!({"request_id":second.id});
        job.outputs.push(output);
        job.status = JobStatus::Failed;
        job.message = "Recorder failed after publishing its outputs".to_owned();
        storage.put_recording_job(job.clone()).await.unwrap();
        reconcile_project_recording(&state, job.id).await.unwrap();
        let failed = storage.get_project(project.id).await.unwrap().unwrap();
        assert_eq!(failed.revision, partial.revision + 1);
        assert_eq!(
            failed.document.tracks[0].clips[0],
            partial.document.tracks[0].clips[0]
        );
        assert!(matches!(failed.document.tracks[0].clips[1].material,
            TimelineClipMaterial::Take {take_id, ..} if take_id == job.outputs[1].id));
        reconcile_project_recording(&state, job.id).await.unwrap();
        assert_eq!(
            storage.get_project(project.id).await.unwrap().unwrap(),
            failed
        );
    }

    #[tokio::test]
    async fn short_take_reconciliation_keeps_the_twenty_second_edit_and_blocks_delivery() {
        let directory = tempfile::tempdir().expect("recording fixture");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage.clone(), directory.path().to_owned());
        let story_id = Uuid::new_v4();
        let demo_id = Uuid::new_v4();
        let clips: Vec<TimelineClip> = [(0.0, 6.0, 171_405_u64, 171_789_u64), (6.0, 14.0, 173_326, 174_222)]
            .into_iter().map(|(start, duration, start_tick, end_tick)| {
                serde_json::from_value(json!({
                    "id":Uuid::new_v4(),"name":"NiKo","capture_intent":{
                        "demo_id":demo_id,"highlight_id":null,"player_id":"76561198041683378",
                        "start_tick":start_tick,"end_tick":end_tick,"pre_roll_seconds":0.0,
                        "post_roll_seconds":0.0,"victim_pov":false,"camera_style":"pov","presentation":null},
                    "material":{"kind":"planned"},
                    "placement":{"start":start,"duration":duration,"source_in":0.0,"source_out":duration,
                        "speed":1.0,"reverse":false,"frame_hold_source_time":null,"volume":1.0,"pan":0.0,"enabled":true},
                    "transform":{"x":0.0,"y":0.0,"scale_x":1.0,"scale_y":1.0,"rotation":0.0,"opacity":1.0},
                    "effects":[],"transitions":{"video_in":null,"video_out":null,"audio_in":null,"audio_out":null},
                    "text":null,"metadata":{},"group_id":null,"link_group_id":null,"keyframes":[],"speed_segments":[]
                })).expect("Timeline Clip")
            }).collect();
        let original_placements = clips
            .iter()
            .map(|clip| clip.placement.clone())
            .collect::<Vec<_>>();
        let requests = clips
            .iter()
            .map(|clip| {
                clip.capture_intent
                    .clone()
                    .unwrap()
                    .into_recording_request(clip.id, &clip.name)
            })
            .collect::<Vec<_>>();
        let project: Project = serde_json::from_value(json!({
            "id":Uuid::new_v4(),"name":"Twenty second intent","revision":1,
            "document":{"width":1920,"height":1080,"fps":60,"duration_seconds":20.0,
                "story_track_id":story_id,"tracks":[{"id":story_id,"name":"Story","kind":"video","order":0,
                    "muted":false,"solo":false,"volume":1.0,"pan":0.0,"keyframes":[],"locked":false,"hidden":false,"clips":clips}],
                "markers":[],"settings":{"source_demo_ids":[demo_id],"ripple_sequence_markers":false,"use_media_proxies":false}},
            "created_at":Utc::now(),"updated_at":Utc::now()
        })).expect("Project");
        let project_id = project.id;
        storage
            .create_project(project)
            .await
            .expect("store project");
        let job_id = Uuid::new_v4();
        let mut outputs = Vec::new();
        for (index, duration) in [5.955_946, 9.740_746_3].into_iter().enumerate() {
            let path = directory.path().join(format!("published-{index}.mp4"));
            // Reconciliation consumes already verified recorder results; no encoder or
            // game is involved in this fixture.
            std::fs::write(&path, b"published recorder output").expect("published output");
            outputs.push(RecordedClip {
                id: Uuid::new_v4(),
                path: path.to_string_lossy().into_owned(),
                title: "NiKo".to_owned(),
                duration_seconds: duration,
                demo_id: Some(demo_id),
                player_name: Some("NiKo".to_owned()),
                category: "pov".to_owned(),
                tags: Vec::new(),
                metadata: json!({"request_id":requests[index].id}),
                created_at: Utc::now(),
            });
        }
        storage
            .put_recording_job(RecordingJob {
                id: job_id,
                retry_of: None,
                status: JobStatus::Completed,
                items: requests,
                current_index: 2,
                progress: 1.0,
                message: "Capture complete".to_owned(),
                outputs: outputs.clone(),
                error_code: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            })
            .await
            .expect("recording job");
        storage
            .bind_project_recording_run(job_id, project_id)
            .await
            .expect("bind project");

        reconcile_project_recording(&state, job_id)
            .await
            .expect("attach media evidence");
        let updated = storage.get_project(project_id).await.unwrap().unwrap();
        assert!((updated.document.duration_seconds - 20.0).abs() < f64::EPSILON);
        assert_eq!(
            updated.document.tracks[0]
                .clips
                .iter()
                .map(|clip| clip.placement.clone())
                .collect::<Vec<_>>(),
            original_placements
        );
        assert_eq!(updated.unresolved_delivery_clips().unwrap().len(), 2);
        for (clip, output) in updated.document.tracks[0].clips.iter().zip(&outputs) {
            assert_eq!(
                clip.materialization_state().unwrap(),
                TimelineClipMaterializationState::Stale
            );
            assert!(
                matches!(clip.material, TimelineClipMaterial::Take{take_id,media_duration_seconds,..}
                if take_id == output.id && (media_duration_seconds - output.duration_seconds).abs() < f64::EPSILON)
            );
            assert!(std::path::Path::new(&output.path).is_file());
        }
        reconcile_project_recording(&state, job_id)
            .await
            .expect("repeat reconciliation");
        assert_eq!(
            storage
                .get_project(project_id)
                .await
                .unwrap()
                .unwrap()
                .revision,
            updated.revision
        );
    }
}
