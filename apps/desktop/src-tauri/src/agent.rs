use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Weak},
    time::Duration,
};

use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{State, ipc::Channel};
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;
use vibe_cs_agent::{
    AgentConfig as EmbeddedAgentConfig, AgentContext as EmbeddedAgentContext,
    AgentMode as EmbeddedAgentMode, AgentProviderProtocol as EmbeddedAgentProviderProtocol,
    AgentRequest as EmbeddedAgentRequest, AgentStreamEvent as EmbeddedAgentStreamEvent,
    AgentToolHost, Cancellation, HistoryMessage,
};
use vibe_cs_domain::{
    AgentToolCall as DomainAgentToolCall, AgentToolCallStatus, AnalysisRunStatus, CaptureIntent,
    HlaeCameraStyle, LlmParameterStyle, ProjectChangeAuthor, ProjectEditLease,
    ProjectEditOperation, ProjectPatch, ProjectPatchScope, RoundReplayArtifact, TimelineClip,
    TimelineClipMaterial, TimelineClipTransitions, TimelinePlacement, Transform,
};
use vibe_cs_storage::ProjectLeaseAcquire;

use crate::bridge::{DesktopBridge, DesktopCall, DesktopMethod};

const MAXIMUM_THREAD_MESSAGES: usize = 80;
const MAXIMUM_THREAD_BYTES: usize = 1024 * 1024;
const TEXT_DELTA_BATCH_BYTES: usize = 256;
const MAXIMUM_STREAM_TEXT_EVENTS_BEFORE_FINAL: usize = 979;
const ROUND_REPLAY_ENVELOPE_BYTES: usize = 12;
const MAXIMUM_CINEMATIC_SAMPLES: usize = 16;

#[derive(Debug, Clone)]
struct CinematicHighlight {
    id: String,
    round: u32,
    start_tick: u64,
    end_tick: u64,
    player_id: String,
    engagements: Vec<CinematicEngagement>,
}

#[derive(Debug, Clone)]
struct CinematicEngagement {
    tick: u64,
    target_id: String,
    target_position: [f64; 3],
}

#[derive(Debug)]
struct CinematicReplayHost {
    storage: vibe_cs_storage::Storage,
    dispatcher: DesktopBridge,
    demo_id: Uuid,
    map_name: String,
    highlights: HashMap<String, CinematicHighlight>,
    replay_cache: Mutex<HashMap<u32, Arc<RoundReplayArtifact>>>,
}

impl CinematicReplayHost {
    fn new(
        storage: vibe_cs_storage::Storage,
        dispatcher: DesktopBridge,
        demo_id: Uuid,
        analysis: &Value,
        namespace_ids: bool,
    ) -> Self {
        let highlights = analysis
            .get("highlights")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|highlight| {
                let source_id = highlight.get("id")?.as_str()?.to_owned();
                let id = if namespace_ids {
                    format!("{demo_id}:{source_id}")
                } else {
                    source_id
                };
                let round = u32::try_from(highlight.get("round")?.as_u64()?).ok()?;
                let start_tick = highlight.get("start_tick")?.as_u64()?;
                let end_tick = highlight.get("end_tick")?.as_u64()?;
                let player_id = highlight.get("player_id")?.as_str()?.to_owned();
                let engagements = analysis
                    .get("rounds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|candidate| {
                        candidate.get("number").and_then(Value::as_u64) == Some(u64::from(round))
                    })
                    .and_then(|value| value.get("events"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|event| {
                        let tick = event.get("tick")?.as_u64()?;
                        (event.get("kind").and_then(Value::as_str) == Some("kill")
                            && event.get("actor").and_then(Value::as_str)
                                == Some(player_id.as_str())
                            && tick >= start_tick
                            && tick <= end_tick)
                            .then_some(())?;
                        Some(CinematicEngagement {
                            tick,
                            target_id: event.get("target")?.as_str()?.to_owned(),
                            target_position: json_position(event.get("position")?)?,
                        })
                    })
                    .collect();
                let descriptor = CinematicHighlight {
                    id,
                    round,
                    start_tick,
                    end_tick,
                    player_id,
                    engagements,
                };
                Some((descriptor.id.clone(), descriptor))
            })
            .collect();
        Self {
            storage,
            dispatcher,
            demo_id,
            map_name: analysis
                .get("map_name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
            highlights,
            replay_cache: Mutex::new(HashMap::new()),
        }
    }

    async fn round_replay(&self, round: u32) -> Result<Arc<RoundReplayArtifact>, String> {
        if let Some(cached) = self.replay_cache.lock().await.get(&round).cloned() {
            return Ok(cached);
        }
        let runs = self
            .storage
            .list_analysis_runs(self.demo_id)
            .await
            .map_err(|error| format!("unable to list analysis runs: {error}"))?;
        let run = runs
            .into_iter()
            .filter(|run| run.status == AnalysisRunStatus::Completed)
            .max_by_key(|run| run.created_at)
            .ok_or_else(|| {
                "no completed analysis run is available for replay evidence".to_owned()
            })?;
        let path = format!("/analysis-runs/{}/replay/rounds/{round}/replay.bin", run.id);
        let bytes = self
            .dispatcher
            .dispatch_binary(&path)
            .await
            .map_err(|error| format!("unable to read selected-round replay: {error:?}"))?;
        let artifact = decode_round_replay_envelope(&bytes)?;
        if artifact.metadata.producer_run_id != run.id
            || artifact.metadata.demo_id != self.demo_id
            || artifact.metadata.round != round
        {
            return Err("selected-round replay identity does not match the request".to_owned());
        }
        let artifact = Arc::new(artifact);
        self.replay_cache
            .lock()
            .await
            .insert(round, artifact.clone());
        Ok(artifact)
    }

    async fn validate_story_camera(&self, clip: &StoryClipInput) -> Result<(), String> {
        let highlight_id = clip.highlight_id.as_deref().ok_or_else(|| {
            format!(
                "clip '{}' requires highlightId before using a non-POV camera",
                clip.name
            )
        })?;
        let namespaced = format!("{}:{highlight_id}", self.demo_id);
        let highlight = self
            .highlights
            .get(highlight_id)
            .or_else(|| self.highlights.get(&namespaced))
            .ok_or_else(|| {
                format!(
                    "clip '{}' references highlightId that is not in the current Demo evidence",
                    clip.name
                )
            })?;
        if clip.player_id != highlight.player_id {
            return Err(format!(
                "clip '{}' playerId does not match the verified highlight player",
                clip.name
            ));
        }
        let artifact = self.round_replay(highlight.round).await?;
        let pre_roll_ticks =
            seconds_to_replay_ticks(clip.pre_roll_seconds, artifact.metadata.tick_rate)?;
        let post_roll_ticks =
            seconds_to_replay_ticks(clip.post_roll_seconds, artifact.metadata.tick_rate)?;
        let start_tick = clip
            .start_tick
            .saturating_sub(pre_roll_ticks)
            .max(artifact.metadata.start_tick);
        let end_tick = clip
            .end_tick
            .checked_add(post_roll_ticks)
            .ok_or_else(|| format!("clip '{}' post-roll exceeds the tick range", clip.name))?
            .min(artifact.metadata.end_tick);
        let samples = camera_spatial_sample_count(&artifact, &clip.player_id, start_tick, end_tick);
        validate_camera_sample_count(&clip.name, clip.camera_style, samples, start_tick, end_tick)
    }
}

#[async_trait]
impl AgentToolHost for CinematicReplayHost {
    async fn read_cinematic_context(&self, highlight_ids: &[String]) -> Result<Value, String> {
        let mut scenes = Vec::new();
        for id in highlight_ids {
            let Some(highlight) = self.highlights.get(id) else {
                continue;
            };
            match self.round_replay(highlight.round).await {
                Ok(artifact) => {
                    let mut scene = cinematic_scene_from_replay(highlight, &artifact);
                    if let Some(object) = scene.as_object_mut() {
                        object.insert("demoId".to_owned(), json!(self.demo_id));
                        object.insert("mapName".to_owned(), json!(self.map_name));
                    }
                    scenes.push(scene);
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        highlight_id = %highlight.id,
                        round = highlight.round,
                        "selected-round replay unavailable; Agent will fall back to persisted event evidence or player POV"
                    );
                }
            }
        }
        Ok(json!({ "scenes": scenes }))
    }
}

#[derive(Debug)]
struct DesktopAgentToolHost {
    cinematic: Vec<CinematicReplayHost>,
    evidence: Value,
    bridge: AgentBridge,
    project_id: Uuid,
    session_id: Uuid,
    turn_id: Uuid,
}

impl DesktopAgentToolHost {
    async fn validate_story_camera(&self, clip: &StoryClipInput) -> Result<(), String> {
        if matches!(clip.camera_style, HlaeCameraStyle::Pov) {
            return Ok(());
        }
        let cinematic = self
            .cinematic
            .iter()
            .find(|cinematic| cinematic.demo_id == clip.demo_id)
            .ok_or_else(|| {
                format!(
                    "clip '{}' has no cinematic evidence host for its Demo; use pov",
                    clip.name
                )
            })?;
        cinematic.validate_story_camera(clip).await
    }
}

#[async_trait]
impl AgentToolHost for DesktopAgentToolHost {
    async fn read_demo_evidence(&self, input: &Value) -> Result<Value, String> {
        vibe_cs_agent::query_demo_evidence(&self.evidence, input)
    }

    async fn read_cinematic_context(&self, highlight_ids: &[String]) -> Result<Value, String> {
        let mut scenes = Vec::new();
        for cinematic in &self.cinematic {
            let supplied = cinematic.read_cinematic_context(highlight_ids).await?;
            scenes.extend(
                supplied
                    .get("scenes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
        }
        Ok(json!({"scenes":scenes}))
    }

    async fn read_project_delivery(&self, input: &Value) -> Result<Value, String> {
        let requested_project_id = input
            .get("projectId")
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(|| "Project delivery requires one valid projectId".to_owned())?;
        if requested_project_id != self.project_id {
            return Err("Project delivery query targets another Project".to_owned());
        }
        let delivery_gate = self
            .bridge
            .dispatcher
            .dispatch(DesktopCall {
                method: DesktopMethod::Get,
                path: format!("/projects/{requested_project_id}/delivery-gate"),
                body: None,
            })
            .await
            .map_err(|error| format!("unable to read Project Delivery Gate: {error:?}"))?;
        let latest_export = self
            .bridge
            .storage
            .list_export_jobs_limited(Some(requested_project_id), 1)
            .await
            .map_err(|error| format!("unable to read Project exports: {error}"))?
            .into_iter()
            .next();
        let latest_export = match latest_export {
            None => Value::Null,
            Some(record) => {
                let export_id = record.job.id.to_string();
                let project_id = requested_project_id.to_string();
                let page = self
                    .bridge
                    .dispatcher
                    .dispatch(DesktopCall {
                        method: DesktopMethod::Get,
                        path: format!("/outputs?kind=export&search={}&page_size=1", record.job.id),
                        body: None,
                    })
                    .await
                    .map_err(|error| format!("unable to inspect latest export: {error:?}"))?;
                page.get("items")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|item| {
                        item.get("id").and_then(Value::as_str) == Some(export_id.as_str())
                            && item.get("project_id").and_then(Value::as_str)
                                == Some(project_id.as_str())
                    })
                    .cloned()
                    .unwrap_or_else(|| {
                        json!({
                            "id": record.job.id,
                            "project_id": record.job.project_id,
                            "status": record.job.status,
                            "progress": record.job.progress,
                            "path": record.job.output_path,
                            "error": record.job.error,
                            "availability": "unknown",
                            "media": null,
                        })
                    })
            }
        };
        Ok(json!({
            "projectId": requested_project_id,
            "deliveryGate": delivery_gate,
            "latestExport": latest_export,
        }))
    }

    async fn apply_project_patch(&self, input: Value) -> Result<Value, String> {
        let input: AgentProjectPatchInput = serde_json::from_value(input)
            .map_err(|error| format!("invalid Project Patch: {error}"))?;
        if input.project_id != self.project_id {
            return Err("Project Patch targets another Project".to_owned());
        }
        let patch = ProjectPatch {
            project_id: input.project_id,
            base_revision: input.base_revision,
            scope: input.scope,
            author: ProjectChangeAuthor::Agent {
                session_id: self.session_id,
                turn_id: self.turn_id,
            },
            reverts_change_group_id: None,
            summary: input.summary,
            operations: input.operations,
        };
        apply_agent_patch(&self.bridge.storage, patch).await
    }

    async fn replace_story_timeline(&self, input: Value) -> Result<Value, String> {
        let input: ReplaceStoryTimelineInput = serde_json::from_value(input)
            .map_err(|error| format!("invalid story timeline: {error}"))?;
        if input.project_id != self.project_id {
            return Err("story timeline targets another Project".to_owned());
        }
        let project = self
            .bridge
            .storage
            .get_project(input.project_id)
            .await
            .map_err(|error| format!("unable to read Project: {error}"))?
            .ok_or_else(|| "Project does not exist".to_owned())?;
        if project.revision != input.base_revision {
            return Err(format!(
                "Project revision changed: expected {}, current {}",
                input.base_revision, project.revision
            ));
        }
        let mut timeline_start = 0.0;
        let mut clips = Vec::with_capacity(input.clips.len());
        for mut clip in input.clips {
            self.validate_story_camera(&clip).await?;
            clip.highlight_id = clip
                .highlight_id
                .as_deref()
                .map(|id| canonical_highlight_id(clip.demo_id, id));
            let duration = clip.duration_seconds;
            let timeline_clip = clip.into_timeline_clip(timeline_start);
            timeline_start += duration;
            clips.push(timeline_clip);
        }
        let patch = ProjectPatch {
            project_id: project.id,
            base_revision: project.revision,
            scope: ProjectPatchScope::Track {
                track_id: project.document.story_track_id,
            },
            author: ProjectChangeAuthor::Agent {
                session_id: self.session_id,
                turn_id: self.turn_id,
            },
            reverts_change_group_id: None,
            summary: input.summary,
            operations: vec![ProjectEditOperation::ReplaceTrackClips {
                track_id: project.document.story_track_id,
                clips,
            }],
        };
        apply_agent_patch(&self.bridge.storage, patch).await
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentProjectPatchInput {
    project_id: Uuid,
    base_revision: u64,
    summary: String,
    scope: ProjectPatchScope,
    operations: Vec<ProjectEditOperation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplaceStoryTimelineInput {
    project_id: Uuid,
    base_revision: u64,
    summary: String,
    clips: Vec<StoryClipInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoryClipInput {
    name: String,
    demo_id: Uuid,
    #[serde(default)]
    highlight_id: Option<String>,
    player_id: String,
    start_tick: u64,
    end_tick: u64,
    #[serde(default)]
    pre_roll_seconds: f64,
    #[serde(default)]
    post_roll_seconds: f64,
    duration_seconds: f64,
    camera_style: HlaeCameraStyle,
    #[serde(default)]
    rationale: String,
}

impl StoryClipInput {
    fn into_timeline_clip(self, start: f64) -> TimelineClip {
        TimelineClip {
            id: Uuid::new_v4(),
            name: self.name,
            capture_intent: Some(CaptureIntent {
                demo_id: self.demo_id,
                highlight_id: self.highlight_id,
                player_id: self.player_id,
                start_tick: self.start_tick,
                end_tick: self.end_tick,
                pre_roll_seconds: self.pre_roll_seconds,
                post_roll_seconds: self.post_roll_seconds,
                victim_pov: false,
                camera_style: self.camera_style,
                presentation: None,
            }),
            material: TimelineClipMaterial::Planned,
            placement: TimelinePlacement {
                start,
                duration: self.duration_seconds,
                source_in: 0.0,
                source_out: self.duration_seconds,
                speed: 1.0,
                volume: 1.0,
                enabled: true,
            },
            transform: Transform::default(),
            effects: Vec::new(),
            transitions: TimelineClipTransitions::default(),
            text: None,
            metadata: json!({"rationale": self.rationale}),
            group_id: None,
            link_group_id: None,
            keyframes: Vec::new(),
            speed_segments: Vec::new(),
        }
    }
}

async fn apply_agent_patch(
    storage: &vibe_cs_storage::Storage,
    patch: ProjectPatch,
) -> Result<Value, String> {
    let (project, change_group) = storage
        .apply_project_patch(patch, Uuid::new_v4(), Utc::now())
        .await
        .map_err(|error| format!("unable to apply Project Patch: {error}"))?;
    Ok(json!({
        "status":"applied",
        "project":project,
        "changeGroup":change_group,
    }))
}

fn decode_round_replay_envelope(bytes: &[u8]) -> Result<RoundReplayArtifact, String> {
    if bytes.len() < ROUND_REPLAY_ENVELOPE_BYTES || &bytes[..4] != b"RRPL" {
        return Err("selected-round replay has an invalid envelope".to_owned());
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    let flags = u16::from_le_bytes([bytes[6], bytes[7]]);
    let payload_length = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    if version != 1 || flags != 0 || payload_length != bytes.len() - ROUND_REPLAY_ENVELOPE_BYTES {
        return Err("selected-round replay has an unsupported envelope".to_owned());
    }
    serde_json::from_slice(&bytes[ROUND_REPLAY_ENVELOPE_BYTES..])
        .map_err(|error| format!("invalid selected-round replay payload: {error}"))
}

fn cinematic_scene_from_replay(
    highlight: &CinematicHighlight,
    artifact: &RoundReplayArtifact,
) -> Value {
    let start_tick = highlight.start_tick.max(artifact.metadata.start_tick);
    let end_tick = highlight.end_tick.min(artifact.metadata.end_tick);
    let eligible = artifact
        .frames
        .iter()
        .filter(|frame| frame.tick >= start_tick && frame.tick <= end_tick)
        .filter(|frame| {
            frame
                .players
                .iter()
                .any(|player| player.steam_id == highlight.player_id)
        })
        .collect::<Vec<_>>();
    let spatial_frame_count = eligible.len();
    let selected_indices = evenly_spaced_indices(spatial_frame_count, MAXIMUM_CINEMATIC_SAMPLES);
    let positioned = selected_indices
        .into_iter()
        .filter_map(|index| {
            let frame = eligible.get(index)?;
            let player = frame
                .players
                .iter()
                .find(|player| player.steam_id == highlight.player_id)?;
            let opponent = frame
                .players
                .iter()
                .filter(|candidate| {
                    candidate.alive
                        && candidate.steam_id != player.steam_id
                        && candidate.team != player.team
                })
                .min_by(|left, right| {
                    horizontal_distance(player.position, left.position)
                        .total_cmp(&horizontal_distance(player.position, right.position))
                });
            Some(json!({
                "tick": frame.tick,
                "kind": "player_sample",
                "actor": player.steam_id,
                "position": player.position,
                "yaw": player.yaw,
                "alive": player.alive,
                "nearestOpponentPosition": opponent.map(|value| value.position),
                "nearestOpponentId": opponent.map(|value| value.steam_id.as_str()),
                "nearestOpponentDistanceUnits": opponent.map(|value| horizontal_distance(player.position, value.position)),
            }))
        })
        .collect::<Vec<_>>();
    let verified_engagements = highlight
        .engagements
        .iter()
        .filter_map(|engagement| {
            let frame = artifact
                .frames
                .iter()
                .min_by_key(|frame| frame.tick.abs_diff(engagement.tick))?;
            let player = frame
                .players
                .iter()
                .find(|player| player.steam_id == highlight.player_id)?;
            let axis = [
                engagement.target_position[0] - player.position[0],
                engagement.target_position[1] - player.position[1],
                engagement.target_position[2] - player.position[2],
            ];
            Some(json!({
                "tick": engagement.tick,
                "target": engagement.target_id,
                "playerPosition": player.position,
                "targetPosition": engagement.target_position,
                "axis": axis,
                "distanceUnits": horizontal_distance(player.position, engagement.target_position),
            }))
        })
        .collect::<Vec<_>>();
    json!({
        "highlightId": highlight.id,
        "positionedAction": positioned,
        "verifiedEngagements": verified_engagements,
        "cameraFeasibility": {
            "highlightSpatialFrameCount": spatial_frame_count,
            "minimumSpatialSamples": 4,
            "nonPovSupportedWithoutWiderHandles": spatial_frame_count >= 4,
            "recommendedCameraStyle": if spatial_frame_count >= 4 { "tracking" } else { "pov" },
            "roundStartTick": artifact.metadata.start_tick,
            "roundEndTick": artifact.metadata.end_tick,
        },
        "fidelity": {
            "source": "selected_round_replay",
            "round": artifact.metadata.round,
            "artifactStartTick": artifact.metadata.start_tick,
            "artifactEndTick": artifact.metadata.end_tick,
            "requestedStartTick": highlight.start_tick,
            "requestedEndTick": highlight.end_tick,
            "effectiveStartTick": start_tick,
            "effectiveEndTick": end_tick,
            "sampleIntervalTicks": artifact.metadata.sample_interval_ticks,
            "acceptedTickCount": artifact.metadata.accepted_tick_count,
            "targetFrameCount": eligible.len(),
            "returnedSampleCount": positioned.len(),
            "clampedToArtifactEnd": highlight.end_tick > artifact.metadata.end_tick,
        }
    })
}

fn camera_spatial_sample_count(
    artifact: &RoundReplayArtifact,
    player_id: &str,
    start_tick: u64,
    end_tick: u64,
) -> usize {
    artifact
        .frames
        .iter()
        .filter(|frame| frame.tick >= start_tick && frame.tick <= end_tick)
        .filter(|frame| {
            frame
                .players
                .iter()
                .any(|player| player.steam_id == player_id)
        })
        .count()
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]
fn seconds_to_replay_ticks(seconds: f64, tick_rate: f64) -> Result<u64, String> {
    let ticks = seconds * tick_rate;
    if !ticks.is_finite() || ticks < 0.0 || ticks > u64::MAX as f64 {
        return Err("capture handles are outside the supported tick range".to_owned());
    }
    Ok(ticks.ceil() as u64)
}

fn canonical_highlight_id(demo_id: Uuid, highlight_id: &str) -> String {
    highlight_id
        .strip_prefix(&format!("{demo_id}:"))
        .unwrap_or(highlight_id)
        .to_owned()
}

const fn camera_style_name(style: HlaeCameraStyle) -> &'static str {
    match style {
        HlaeCameraStyle::Pov => "pov",
        HlaeCameraStyle::Orbit => "orbit",
        HlaeCameraStyle::Dolly => "dolly",
        HlaeCameraStyle::Static => "static",
        HlaeCameraStyle::Tracking => "tracking",
        HlaeCameraStyle::Crane => "crane",
        HlaeCameraStyle::Flyby => "flyby",
    }
}

fn validate_camera_sample_count(
    clip_name: &str,
    camera_style: HlaeCameraStyle,
    samples: usize,
    start_tick: u64,
    end_tick: u64,
) -> Result<(), String> {
    if end_tick <= start_tick || samples < 4 {
        return Err(format!(
            "clip '{clip_name}' cameraStyle '{}' has {samples} spatial samples in its effective round-bounded capture range; use pov or widen the in-round handles to provide at least 4",
            camera_style_name(camera_style),
        ));
    }
    Ok(())
}

fn json_position(value: &Value) -> Option<[f64; 3]> {
    let values = value.as_array()?;
    Some([
        values.first()?.as_f64()?,
        values.get(1)?.as_f64()?,
        values.get(2)?.as_f64()?,
    ])
}

fn evenly_spaced_indices(length: usize, maximum: usize) -> Vec<usize> {
    if length <= maximum {
        return (0..length).collect();
    }
    (0..maximum)
        .map(|index| index * (length - 1) / (maximum - 1))
        .collect()
}

fn horizontal_distance(left: [f64; 3], right: [f64; 3]) -> f64 {
    (right[0] - left[0]).hypot(right[1] - left[1])
}

#[derive(Debug, Clone)]
pub(crate) struct AgentBridge {
    storage: vibe_cs_storage::Storage,
    data_dir: PathBuf,
    dispatcher: DesktopBridge,
    chat_gate: Arc<Semaphore>,
    thread_locks: Arc<Mutex<HashMap<Uuid, Weak<Mutex<()>>>>>,
    cancellations: Arc<Mutex<HashMap<Uuid, Arc<Cancellation>>>>,
}

impl AgentBridge {
    pub(crate) fn new(
        storage: vibe_cs_storage::Storage,
        data_dir: PathBuf,
        dispatcher: DesktopBridge,
    ) -> Self {
        Self {
            storage,
            data_dir,
            dispatcher,
            chat_gate: Arc::new(Semaphore::new(2)),
            thread_locks: Arc::new(Mutex::new(HashMap::new())),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn thread_path(&self, thread_id: Uuid) -> PathBuf {
        self.data_dir
            .join("agent")
            .join("threads")
            .join(format!("{thread_id}.json"))
    }

    async fn load_thread(&self, thread_id: Uuid) -> Result<AgentThread, AgentCommandError> {
        let path = self.thread_path(thread_id);
        match tokio::fs::read(&path).await {
            Ok(bytes) if bytes.len() <= MAXIMUM_THREAD_BYTES => serde_json::from_slice(&bytes)
                .map_err(|error| {
                    AgentCommandError::internal(format!("invalid local agent thread: {error}"))
                }),
            Ok(_) => Err(AgentCommandError::internal(
                "local agent thread is too large",
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AgentThread {
                id: thread_id,
                messages: Vec::new(),
                updated_at: Utc::now().to_rfc3339(),
            }),
            Err(error) => Err(AgentCommandError::internal(format!(
                "unable to read local agent thread: {error}"
            ))),
        }
    }

    async fn save_thread(&self, thread: &mut AgentThread) -> Result<(), AgentCommandError> {
        let path = self.thread_path(thread.id);
        let parent = path
            .parent()
            .ok_or_else(|| AgentCommandError::internal("invalid agent thread path"))?;
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            AgentCommandError::internal(format!("unable to create agent thread directory: {error}"))
        })?;
        let bytes = serialize_bounded_thread(thread)?;
        tokio::task::spawn_blocking(move || vibe_cs_platform_windows::atomic_write(&path, &bytes))
            .await
            .map_err(|error| {
                AgentCommandError::internal(format!(
                    "agent thread persistence task failed: {error}"
                ))
            })?
            .map_err(|error| {
                AgentCommandError::internal(format!("unable to persist agent thread: {error}"))
            })
    }

    async fn thread_lock(&self, thread_id: Uuid) -> Arc<Mutex<()>> {
        let mut locks = self.thread_locks.lock().await;
        if let Some(lock) = locks.get(&thread_id).and_then(Weak::upgrade) {
            return lock;
        }
        if locks.len() >= 256 {
            locks.retain(|_, lock| lock.strong_count() > 0);
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(thread_id, Arc::downgrade(&lock));
        lock
    }
}

fn serialize_bounded_thread(thread: &mut AgentThread) -> Result<Vec<u8>, AgentCommandError> {
    loop {
        let serialized = serde_json::to_vec(&thread).map_err(|error| {
            AgentCommandError::internal(format!("unable to serialize agent thread: {error}"))
        })?;
        if serialized.len() <= MAXIMUM_THREAD_BYTES {
            return Ok(serialized);
        }
        if thread.messages.len() <= 2 {
            return Err(AgentCommandError::invalid(
                "agent response exceeds the local thread size limit",
            ));
        }
        thread.messages.drain(..thread.messages.len().min(2));
    }
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DesktopAgentStatus")]
pub(crate) struct AgentStatus {
    runtime_available: bool,
    configured: bool,
    provider: String,
    model: String,
    streaming: bool,
}

/// Who wrote a message in the desktop chat transcript.
///
/// Two values. It was a `String` beside `HistoryMessage.role`, which is the
/// LLM API's own role field and genuinely open — that one carries `system` and
/// `tool` as well. This one is only ever the two the transcript renders, and
/// the renderer was already switching on exactly those.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "DesktopAgentRole")]
pub(crate) enum AgentRole {
    User,
    Assistant,
}

impl AgentRole {
    const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentMessage")]
pub(crate) struct AgentMessage {
    id: Uuid,
    role: AgentRole,
    content: String,
    created_at: String,
    tool_calls: Vec<DomainAgentToolCall>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentThread")]
pub(crate) struct AgentThread {
    id: Uuid,
    messages: Vec<AgentMessage>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentToolCallStarted")]
pub(crate) struct AgentToolCallStarted {
    id: String,
    name: String,
    input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentTurnMetadata")]
pub(crate) struct AgentTurnMetadata {
    provider: String,
    model: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
    estimated_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentChatHistoryMessage")]
pub(crate) struct AgentChatHistoryMessage {
    role: AgentRole,
    content: String,
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentChatInput")]
pub(crate) struct AgentChatInput {
    request_id: Uuid,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    thread_id: Option<Uuid>,
    project_id: Uuid,
    workspace_context: AgentWorkspaceContext,
    history: Vec<AgentChatHistoryMessage>,
    mode: EmbeddedAgentMode,
    #[serde(default)]
    auto_mode: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, rename = "DesktopAgentWorkspaceContext")]
pub(crate) struct AgentWorkspaceContext {
    pub(crate) project_id: Uuid,
    pub(crate) lens: AgentEditingLens,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) selected_clip_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "DesktopAgentEditingLens")]
pub(crate) enum AgentEditingLens {
    Quick,
    Multitrack,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
#[ts(export, rename = "DesktopAgentEvent")]
pub(crate) enum AgentEvent {
    Started {
        thread_id: Uuid,
    },
    TextDelta {
        delta: String,
    },
    ToolCallStarted {
        tool_call: AgentToolCallStarted,
    },
    ToolCallFinished {
        tool_call: DomainAgentToolCall,
    },
    Complete {
        thread: AgentThread,
        metadata: AgentTurnMetadata,
    },
    Error {
        message: String,
    },
}

fn domain_tool_call(value: vibe_cs_agent::CapturedToolCall) -> DomainAgentToolCall {
    DomainAgentToolCall {
        id: value.id,
        name: value.name,
        input: value.input,
        output: value.output,
        status: match value.status {
            vibe_cs_agent::CapturedToolCallStatus::Completed => AgentToolCallStatus::Completed,
            vibe_cs_agent::CapturedToolCallStatus::Failed => AgentToolCallStatus::Failed,
            vibe_cs_agent::CapturedToolCallStatus::AwaitingConfirmation => {
                AgentToolCallStatus::AwaitingConfirmation
            }
        },
    }
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export, rename = "DesktopAgentChatResult")]
pub(crate) struct AgentChatResult {
    thread_id: Uuid,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export, rename = "DesktopAgentCommandError")]
pub(crate) struct AgentCommandError {
    status: u16,
    code: String,
    message: String,
}

impl AgentCommandError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code: "invalid_agent_request".to_owned(),
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: 503,
            code: "agent_unavailable".to_owned(),
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 500,
            code: "agent_failed".to_owned(),
            message: message.into(),
        }
    }
}

#[tauri::command]
pub(crate) async fn agent_status(
    state: State<'_, AgentBridge>,
) -> Result<AgentStatus, AgentCommandError> {
    status(&state).await
}

async fn status(state: &AgentBridge) -> Result<AgentStatus, AgentCommandError> {
    let (config, api_key) = resolved_agent_config(state).await?;
    Ok(AgentStatus {
        runtime_available: true,
        configured: !api_key.is_empty()
            && !config.llm.model.is_empty()
            && !config.llm.base_url.is_empty(),
        provider: config.llm.provider,
        model: config.llm.model,
        streaming: true,
    })
}

async fn resolved_agent_config(
    state: &AgentBridge,
) -> Result<(vibe_cs_domain::AppConfig, String), AgentCommandError> {
    let config = state
        .storage
        .get_config()
        .await
        .map_err(|error| {
            AgentCommandError::internal(format!("unable to read agent configuration: {error}"))
        })?
        .unwrap_or_default();
    #[cfg(debug_assertions)]
    let mut config = config;
    #[cfg(debug_assertions)]
    let development_key = std::env::var("VIBE_CS_AGENT_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty());
    #[cfg(debug_assertions)]
    if development_key.is_some() {
        "kimi-for-coding".clone_into(&mut config.llm.provider);
        "k3".clone_into(&mut config.llm.model);
        "https://api.kimi.com/coding/v1".clone_into(&mut config.llm.base_url);
    }
    #[cfg(debug_assertions)]
    let api_key = development_key.unwrap_or_else(|| config.llm.api_key.clone());
    #[cfg(not(debug_assertions))]
    let api_key = config.llm.api_key.clone();
    Ok((config, api_key))
}

#[tauri::command]
pub(crate) async fn agent_thread(
    state: State<'_, AgentBridge>,
    thread_id: Uuid,
) -> Result<AgentThread, AgentCommandError> {
    state.load_thread(thread_id).await
}

#[tauri::command]
pub(crate) async fn agent_chat(
    state: State<'_, AgentBridge>,
    input: AgentChatInput,
    on_event: Channel<AgentEvent>,
) -> Result<AgentChatResult, AgentCommandError> {
    chat(&state, input, on_event).await
}

async fn chat(
    state: &AgentBridge,
    input: AgentChatInput,
    on_event: Channel<AgentEvent>,
) -> Result<AgentChatResult, AgentCommandError> {
    let message = input.message.trim();
    if message.is_empty() || message.chars().count() > 8_000 {
        return Err(AgentCommandError::invalid(
            "agent message must contain between 1 and 8000 characters",
        ));
    }
    validate_workspace_context(&input)?;
    let thread_id = input.thread_id.unwrap_or_else(Uuid::new_v4);
    let cancellation = Arc::new(Cancellation::new());
    {
        let mut cancellations = state.cancellations.lock().await;
        if cancellations.contains_key(&input.request_id) {
            return Err(AgentCommandError::invalid(
                "agent request identifier is already active",
            ));
        }
        cancellations.insert(input.request_id, Arc::clone(&cancellation));
    }
    let result = run_scheduled_agent_chat(state, &input, &on_event, thread_id, &cancellation).await;
    let mut cancellations = state.cancellations.lock().await;
    if cancellations
        .get(&input.request_id)
        .is_some_and(|current| Arc::ptr_eq(current, &cancellation))
    {
        cancellations.remove(&input.request_id);
    }
    result
}

fn validate_workspace_context(input: &AgentChatInput) -> Result<(), AgentCommandError> {
    if input.workspace_context.project_id != input.project_id {
        return Err(AgentCommandError::invalid(
            "agent workspace context targets another Project",
        ));
    }
    if input.history.len() > 40
        || input
            .history
            .iter()
            .any(|entry| entry.content.trim().is_empty() || entry.content.chars().count() > 16_000)
    {
        return Err(AgentCommandError::invalid(
            "agent history is outside the supported bounds",
        ));
    }
    Ok(())
}

async fn run_scheduled_agent_chat(
    state: &AgentBridge,
    input: &AgentChatInput,
    on_event: &Channel<AgentEvent>,
    thread_id: Uuid,
    cancellation: &Cancellation,
) -> Result<AgentChatResult, AgentCommandError> {
    let _chat_permit = tokio::select! {
        permit = state.chat_gate.acquire() => permit
            .map_err(|_| AgentCommandError::unavailable("agent scheduler is closed"))?,
        () = cancellation.cancelled() => return Err(AgentCommandError::unavailable("agent request was cancelled")),
    };
    let thread_lock = state.thread_lock(thread_id).await;
    let _thread_guard = tokio::select! {
        guard = thread_lock.lock() => guard,
        () = cancellation.cancelled() => return Err(AgentCommandError::unavailable("agent request was cancelled")),
    };
    run_agent_chat(state, input, on_event, thread_id, cancellation).await
}

#[tauri::command]
pub(crate) async fn agent_cancel(
    state: State<'_, AgentBridge>,
    request_id: Uuid,
) -> Result<bool, AgentCommandError> {
    let cancellation = state.cancellations.lock().await.get(&request_id).cloned();
    if let Some(cancellation) = cancellation {
        cancellation.cancel();
        return Ok(true);
    }
    Ok(false)
}

async fn run_agent_chat(
    state: &AgentBridge,
    input: &AgentChatInput,
    on_event: &Channel<AgentEvent>,
    thread_id: Uuid,
    cancellation: &Cancellation,
) -> Result<AgentChatResult, AgentCommandError> {
    let message = input.message.trim();
    let _ = on_event.send(AgentEvent::Started { thread_id });
    let mut thread = state.load_thread(thread_id).await?;
    let (config, api_key) = resolved_agent_config(state).await?;
    if api_key.is_empty() || config.llm.model.is_empty() || config.llm.base_url.is_empty() {
        return Err(AgentCommandError::unavailable(
            "configure an AI provider in Vibe CS settings first",
        ));
    }
    let project = state
        .storage
        .get_project(input.project_id)
        .await
        .map_err(|error| AgentCommandError::internal(format!("unable to read Project: {error}")))?
        .ok_or_else(|| AgentCommandError::invalid("Project does not exist"))?;
    let requested_demo_ids = project_demo_ids(&project);
    let mut series = Vec::with_capacity(requested_demo_ids.len());
    for id in requested_demo_ids.iter().copied() {
        let demo = serde_json::to_value(state.storage.get_demo(id).await.map_err(|error| {
            AgentCommandError::internal(format!("unable to read demo evidence: {error}"))
        })?)
        .map_err(|error| AgentCommandError::internal(error.to_string()))?;
        let analysis =
            serde_json::to_value(state.storage.get_analysis(id).await.map_err(|error| {
                AgentCommandError::internal(format!("unable to read demo analysis: {error}"))
            })?)
            .map_err(|error| AgentCommandError::internal(error.to_string()))?;
        series.push((id, demo, analysis));
    }
    let demo = series.first().map_or(Value::Null, |entry| entry.1.clone());
    let raw_analysis = series.first().map_or(Value::Null, |entry| entry.2.clone());
    let analysis = if series.len() > 1 {
        summarize_series_analysis(&series)
    } else {
        raw_analysis.clone()
    };
    let evidence = if series.len() > 1 {
        series_evidence_analysis(&series, None)
    } else {
        raw_analysis.clone()
    };
    let map_context = match analysis
        .get("map_name")
        .and_then(Value::as_str)
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 128
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        }) {
        Some(map_name) => state
            .dispatcher
            .dispatch(DesktopCall {
                method: DesktopMethod::Get,
                path: format!("/maps/{map_name}/radar/metadata"),
                body: None,
            })
            .await
            .unwrap_or_else(|_| {
                json!({
                    "map_name": map_name,
                    "transform": null,
                    "browser_displayable": false,
                })
            }),
        None => Value::Null,
    };
    let history = input
        .history
        .iter()
        .map(|entry| HistoryMessage {
            role: entry.role.as_str().to_owned(),
            content: entry.content.clone(),
        })
        .collect::<Vec<_>>();
    let summarized_analysis = if series.len() > 1 {
        summarize_series_inventory(&series)
    } else {
        summarize_analysis(&analysis)
    };
    let cinematic = series
        .iter()
        .map(|(demo_id, _, analysis)| {
            CinematicReplayHost::new(
                state.storage.clone(),
                state.dispatcher.clone(),
                *demo_id,
                analysis,
                series.len() > 1,
            )
        })
        .collect();
    let tool_host = Some(Arc::new(DesktopAgentToolHost {
        cinematic,
        evidence,
        bridge: state.clone(),
        project_id: project.id,
        session_id: thread_id,
        turn_id: input.request_id,
    }) as Arc<dyn AgentToolHost>);
    let mut workspace = serde_json::to_value(&input.workspace_context)
        .map_err(|error| AgentCommandError::internal(error.to_string()))?;
    if let Some(object) = workspace.as_object_mut() {
        object.insert(
            "resources".to_owned(),
            json!({
                "demoIds": requested_demo_ids,
                "projectId": project.id,
                "projectRevision": project.revision,
            }),
        );
    }
    let provider = config.llm.provider.clone();
    let model = config.llm.model.clone();
    let project_context = serde_json::to_value(&project)
        .map_err(|error| AgentCommandError::internal(error.to_string()))?;
    let context_bytes = serde_json::to_vec(&json!({
        "workspace": workspace,
        "demo": summarize_demo(&demo),
        "analysis": summarized_analysis,
        "mapContext": map_context,
        "project": project_context,
    }))
    .map_err(|error| AgentCommandError::internal(error.to_string()))?
    .len();
    tracing::info!(
        request_id = %input.request_id,
        project_id = %project.id,
        context_bytes,
        "Agent context assembled"
    );
    let lease = ProjectEditLease {
        id: Uuid::new_v4(),
        project_id: project.id,
        session_id: thread_id,
        turn_id: input.request_id,
        base_revision: project.revision,
        acquired_at: Utc::now(),
        heartbeat_at: Utc::now(),
    };
    let lease = match state
        .storage
        .acquire_project_edit_lease(lease)
        .await
        .map_err(|error| {
            AgentCommandError::internal(format!("unable to acquire Project edit lease: {error}"))
        })? {
        ProjectLeaseAcquire::Acquired(lease) => lease,
        ProjectLeaseAcquire::Held(lease) => {
            return Err(AgentCommandError::unavailable(format!(
                "Project is already being edited by Agent turn {}",
                lease.turn_id
            )));
        }
    };
    let heartbeat_storage = state.storage.clone();
    let heartbeat_project_id = project.id;
    let heartbeat_lease_id = lease.id;
    let lease_heartbeat = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        interval.tick().await;
        loop {
            interval.tick().await;
            match heartbeat_storage
                .heartbeat_project_edit_lease(heartbeat_project_id, heartbeat_lease_id, Utc::now())
                .await
            {
                Ok(true) => {}
                Ok(false) | Err(_) => break,
            }
        }
    });
    let request = EmbeddedAgentRequest {
        request_id: input.request_id.to_string(),
        mode: input.mode,
        message: message.to_owned(),
        history,
        config: EmbeddedAgentConfig {
            provider: config.llm.provider,
            model: config.llm.model,
            base_url: config.llm.base_url,
            api_key,
            provider_protocol: match config.llm.parameter_style {
                LlmParameterStyle::OpenAi => EmbeddedAgentProviderProtocol::OpenAi,
                LlmParameterStyle::Anthropic => EmbeddedAgentProviderProtocol::Anthropic,
            },
            custom_instructions: config.llm.prompt,
            provider_parameters: config.llm.parameters,
        },
        context: EmbeddedAgentContext {
            workspace,
            demo: summarize_demo(&demo),
            analysis: summarized_analysis,
            map_context,
            project: project_context,
        },
        tool_host,
        auto_mode: input.auto_mode,
    };
    let mut pending_text = String::new();
    let mut text_event_count = 0_usize;
    let turn_timeout = if input.auto_mode {
        Duration::from_secs(15 * 60)
    } else {
        Duration::from_secs(10 * 60)
    };
    let response = tokio::time::timeout(
        turn_timeout,
        vibe_cs_agent::run_agent(request, cancellation, |event| match event {
            EmbeddedAgentStreamEvent::TextDelta(delta) => {
                pending_text.push_str(&delta);
                if pending_text.len() >= TEXT_DELTA_BATCH_BYTES
                    && text_event_count < MAXIMUM_STREAM_TEXT_EVENTS_BEFORE_FINAL
                {
                    let _ = on_event.send(AgentEvent::TextDelta {
                        delta: std::mem::take(&mut pending_text),
                    });
                    text_event_count += 1;
                }
            }
            EmbeddedAgentStreamEvent::ToolCallStarted { id, name, input } => {
                let _ = on_event.send(AgentEvent::ToolCallStarted {
                    tool_call: AgentToolCallStarted { id, name, input },
                });
            }
            EmbeddedAgentStreamEvent::ToolCallFinished(tool_call) => {
                let _ = on_event.send(AgentEvent::ToolCallFinished {
                    tool_call: domain_tool_call(tool_call),
                });
            }
        }),
    )
    .await
    .map_err(|_| {
        AgentCommandError::unavailable(format!(
            "agent request timed out after {} minutes; completed tool checkpoints were preserved",
            turn_timeout.as_secs() / 60
        ))
    })
    .and_then(|response| {
        response.map_err(|error| match error {
            vibe_cs_agent::AgentError::Invalid(message) => AgentCommandError::invalid(message),
            vibe_cs_agent::AgentError::Cancelled => {
                AgentCommandError::unavailable(error.to_string())
            }
            vibe_cs_agent::AgentError::Provider(message) => AgentCommandError::unavailable(message),
        })
    });
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            if !pending_text.is_empty() {
                let _ = on_event.send(AgentEvent::TextDelta {
                    delta: std::mem::take(&mut pending_text),
                });
            }
            let _ = state
                .storage
                .release_project_edit_lease(project.id, lease.id)
                .await;
            lease_heartbeat.abort();
            let _ = on_event.send(AgentEvent::Error {
                message: error.message.clone(),
            });
            return Err(error);
        }
    };
    if !pending_text.is_empty() {
        let _ = on_event.send(AgentEvent::TextDelta {
            delta: std::mem::take(&mut pending_text),
        });
    }
    let tool_calls = response
        .tool_calls
        .into_iter()
        .map(domain_tool_call)
        .collect::<Vec<_>>();
    let usage = response.usage;
    let now = Utc::now().to_rfc3339();
    thread.messages.push(AgentMessage {
        id: Uuid::new_v4(),
        role: AgentRole::User,
        content: message.to_owned(),
        created_at: now.clone(),
        tool_calls: Vec::new(),
    });
    thread.messages.push(AgentMessage {
        id: Uuid::new_v4(),
        role: AgentRole::Assistant,
        content: response.content,
        created_at: now.clone(),
        tool_calls: tool_calls.clone(),
    });
    if thread.messages.len() > MAXIMUM_THREAD_MESSAGES {
        thread
            .messages
            .drain(..thread.messages.len() - MAXIMUM_THREAD_MESSAGES);
    }
    thread.updated_at = now;
    state.save_thread(&mut thread).await?;
    lease_heartbeat.abort();
    state
        .storage
        .release_project_edit_lease(project.id, lease.id)
        .await
        .map_err(|error| {
            AgentCommandError::internal(format!("unable to release Project edit lease: {error}"))
        })?;
    let _ = on_event.send(AgentEvent::Complete {
        thread: thread.clone(),
        metadata: AgentTurnMetadata {
            provider,
            model,
            input_tokens: usage.map(|item| item.input_tokens),
            output_tokens: usage.map(|item| item.output_tokens),
            total_tokens: usage.map(|item| item.total_tokens),
            cached_input_tokens: usage.map(|item| item.cached_input_tokens),
            reasoning_tokens: usage.map(|item| item.reasoning_tokens),
            // No provider pricing table is configured. Unknown is honest; zero
            // would claim the call was free.
            estimated_cost_usd: None,
        },
    });
    Ok(AgentChatResult { thread_id })
}

fn project_demo_ids(project: &vibe_cs_domain::Project) -> Vec<Uuid> {
    let mut requested = project.document.settings.source_demo_ids.clone();
    requested.extend(
        project
            .document
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .filter_map(|clip| {
                clip.capture_intent
                    .as_ref()
                    .map(|intent| intent.demo_id)
                    .or_else(|| {
                        clip.metadata
                            .get("demo_id")
                            .and_then(Value::as_str)
                            .and_then(|value| Uuid::parse_str(value).ok())
                    })
            }),
    );
    requested.sort_unstable();
    requested.dedup();
    requested.truncate(vibe_cs_domain::MAX_PROJECT_SOURCE_DEMOS);
    requested
}

fn summarize_demo(demo: &Value) -> Value {
    let Some(source) = demo.as_object() else {
        return Value::Null;
    };
    json!({
        "id": source.get("id"), "display_name": source.get("display_name"),
        "file_name": source.get("file_name"), "map_name": source.get("map_name"),
        "match_date": source.get("match_date"), "duration_seconds": source.get("duration_seconds"),
        "total_rounds": source.get("total_rounds"), "team_a_name": source.get("team_a_name"),
        "team_b_name": source.get("team_b_name"), "team_a_score": source.get("team_a_score"),
        "team_b_score": source.get("team_b_score"),
    })
}

fn capped_array(value: Option<&Value>, maximum: usize) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(maximum)
        .cloned()
        .collect()
}

fn highlight_kind_rank(highlight: &Value) -> u8 {
    match highlight.get("kind").and_then(Value::as_str) {
        Some("multi_kill") => 0,
        Some("clutch") => 1,
        Some("one_tap") => 2,
        Some("wallbang" | "no_scope" | "knife" | "taser" | "defuse") => 3,
        Some("fail") => 4,
        Some("timeline") => 5,
        _ => 6,
    }
}

fn summarize_highlights(value: Option<&Value>, maximum: usize) -> Vec<Value> {
    let highlights = value
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    if highlights.len() <= maximum {
        return highlights.to_vec();
    }

    let mut by_round = BTreeMap::<u64, Vec<(usize, &Value)>>::new();
    for (index, highlight) in highlights.iter().enumerate() {
        let round = highlight
            .get("round")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX);
        by_round.entry(round).or_default().push((index, highlight));
    }
    for candidates in by_round.values_mut() {
        candidates.sort_by(|(_, left), (_, right)| {
            highlight_kind_rank(left)
                .cmp(&highlight_kind_rank(right))
                .then_with(|| {
                    right
                        .get("score")
                        .and_then(Value::as_f64)
                        .unwrap_or_default()
                        .total_cmp(
                            &left
                                .get("score")
                                .and_then(Value::as_f64)
                                .unwrap_or_default(),
                        )
                })
                .then_with(|| {
                    left.get("start_tick")
                        .and_then(Value::as_u64)
                        .cmp(&right.get("start_tick").and_then(Value::as_u64))
                })
                .then_with(|| {
                    left.get("id")
                        .and_then(Value::as_str)
                        .cmp(&right.get("id").and_then(Value::as_str))
                })
        });
    }

    let mut selected = Vec::with_capacity(maximum);
    let mut rank = 0;
    while selected.len() < maximum {
        let before = selected.len();
        for candidates in by_round.values() {
            if let Some((index, _)) = candidates.get(rank) {
                selected.push(*index);
                if selected.len() == maximum {
                    break;
                }
            }
        }
        if selected.len() == before {
            break;
        }
        rank += 1;
    }
    selected.sort_unstable();
    selected
        .into_iter()
        .map(|index| highlights[index].clone())
        .collect()
}

fn summarize_round_event(event: &Value) -> Option<Value> {
    let source = event.as_object()?;
    Some(json!({
        "id": source.get("id"),
        "tick": source.get("tick"),
        "seconds": source.get("seconds"),
        "kind": source.get("kind"),
        "actor": source.get("actor"),
        "target": source.get("target"),
        "weapon": source.get("weapon"),
        "headshot": source.get("headshot"),
        "penetrated": source.get("penetrated"),
        "position": source.get("position"),
    }))
}

fn summarize_rounds(value: Option<&Value>, maximum: usize) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(maximum)
        .filter_map(|round| {
            let source = round.as_object()?;
            let events = source
                .get("events")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(128)
                .filter_map(summarize_round_event)
                .collect::<Vec<_>>();
            Some(json!({
                "number": source.get("number"),
                "start_tick": source.get("start_tick"),
                "end_tick": source.get("end_tick"),
                "winner": source.get("winner"),
                "reason": source.get("reason"),
                "team_a_score": source.get("team_a_score"),
                "team_b_score": source.get("team_b_score"),
                "events": events,
            }))
        })
        .collect()
}

fn summarize_analysis(analysis: &Value) -> Value {
    let Some(source) = analysis.as_object() else {
        return Value::Null;
    };
    let insights =
        source
            .get("insights")
            .and_then(Value::as_object)
            .map_or(Value::Null, |insights| {
                json!({
                    "round_economy": capped_array(insights.get("round_economy"), 64),
                    "matchups": capped_array(insights.get("matchups"), 512),
                    "availability": insights.get("availability"),
                })
            });
    json!({
        "demo_id": source.get("demo_id"), "map_name": source.get("map_name"),
        "tick_rate": source.get("tick_rate"), "duration_seconds": source.get("duration_seconds"),
        "teams": capped_array(source.get("teams"), 2), "players": capped_array(source.get("players"), 32),
        "rounds": summarize_rounds(source.get("rounds"), 64), "highlights": summarize_highlights(source.get("highlights"), 128),
        "insights": insights,
    })
}

fn summarize_series_analysis(series: &[(Uuid, Value, Value)]) -> Value {
    series_evidence_analysis(series, Some(128))
}

fn series_evidence_analysis(
    series: &[(Uuid, Value, Value)],
    maximum_highlights_per_demo: Option<usize>,
) -> Value {
    let mut highlights = Vec::new();
    let mut players = BTreeMap::<String, Value>::new();
    for (demo_id, _demo, analysis) in series {
        let map_name = analysis.get("map_name").cloned().unwrap_or(Value::Null);
        let tick_rate = analysis.get("tick_rate").cloned().unwrap_or(Value::Null);
        for player in analysis
            .get("players")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(32)
        {
            if let Some(id) = player.get("steam_id").and_then(Value::as_str) {
                players
                    .entry(id.to_owned())
                    .or_insert_with(|| player.clone());
            }
        }
        let selected_highlights = maximum_highlights_per_demo.map_or_else(
            || {
                analysis
                    .get("highlights")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
            },
            |maximum| summarize_highlights(analysis.get("highlights"), maximum),
        );
        for highlight in &selected_highlights {
            let Some(source_id) = highlight.get("id").and_then(Value::as_str) else {
                continue;
            };
            let mut item = highlight.as_object().cloned().unwrap_or_default();
            item.insert("id".to_owned(), json!(format!("{demo_id}:{source_id}")));
            item.insert("source_highlight_id".to_owned(), json!(source_id));
            item.insert("demo_id".to_owned(), json!(demo_id));
            item.insert("map_name".to_owned(), map_name.clone());
            item.insert("tick_rate".to_owned(), tick_rate.clone());
            highlights.push(Value::Object(item));
        }
    }
    json!({
        "demo_id": null,
        "map_name": null,
        "tick_rate": 64.0,
        "duration_seconds": null,
        "teams": [],
        "players": players.into_values().collect::<Vec<_>>(),
        "rounds": [],
        "highlights": highlights,
        "insights": {"round_economy":[],"matchups":[],"availability":null},
        "series_demo_count": series.len(),
    })
}

fn summarize_series_inventory(series: &[(Uuid, Value, Value)]) -> Value {
    let mut players = BTreeMap::<String, Value>::new();
    let demos = series
        .iter()
        .map(|(demo_id, _demo, analysis)| {
            for player in analysis
                .get("players")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(32)
            {
                if let Some(id) = player.get("steam_id").and_then(Value::as_str) {
                    players.entry(id.to_owned()).or_insert_with(|| player.clone());
                }
            }
            json!({
                "demo_id": demo_id,
                "map_name": analysis.get("map_name"),
                "tick_rate": analysis.get("tick_rate"),
                "duration_seconds": analysis.get("duration_seconds"),
                "highlight_count": analysis.get("highlights").and_then(Value::as_array).map_or(0, Vec::len),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "demo_id": null,
        "map_name": null,
        "tick_rate": null,
        "duration_seconds": null,
        "teams": [],
        "players": players.into_values().collect::<Vec<_>>(),
        "rounds": [],
        "highlights": [],
        "insights": null,
        "series_demo_count": series.len(),
        "demos": demos,
        "evidence_query_required": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_cs_domain::{
        RoundReplayFieldAvailability, RoundReplayFields, RoundReplayFrame, RoundReplayMetadata,
        RoundReplayPlayer,
    };

    fn replay_artifact(frame_count: usize) -> RoundReplayArtifact {
        RoundReplayArtifact {
            metadata: RoundReplayMetadata {
                producer_run_id: Uuid::from_u128(1),
                demo_id: Uuid::from_u128(2),
                input_sha256: "a".repeat(64),
                input_size: 1,
                round: 7,
                start_tick: 100,
                end_tick: 200,
                tick_rate: 64.0,
                sampling_contract_version: 1,
                sample_interval_ticks: 8,
                requested_tick_count: 101,
                accepted_tick_count: u32::try_from(frame_count).expect("bounded frames"),
                event_tick_count: 0,
                freeze_end_tick: None,
                players_per_frame: 1,
                fields: RoundReplayFields {
                    position: RoundReplayFieldAvailability::Required,
                    yaw: RoundReplayFieldAvailability::Required,
                    health: RoundReplayFieldAvailability::Required,
                    armor: RoundReplayFieldAvailability::Required,
                    life_state: RoundReplayFieldAvailability::Required,
                    money: RoundReplayFieldAvailability::Required,
                    current_equipment_value: RoundReplayFieldAvailability::Required,
                    round_start_equipment_value: RoundReplayFieldAvailability::Required,
                    has_helmet: RoundReplayFieldAvailability::Required,
                    active_weapon_name: RoundReplayFieldAvailability::Nullable,
                },
            },
            frames: (0..frame_count)
                .map(|index| RoundReplayFrame {
                    tick: 110 + u64::try_from(index).expect("bounded index") * 10,
                    players: vec![RoundReplayPlayer {
                        steam_id: "76561198041683378".to_owned(),
                        name: "NiKo".to_owned(),
                        team: "B".to_owned(),
                        side: "CT".to_owned(),
                        position: [
                            f64::from(u32::try_from(index).expect("bounded index")),
                            2.0,
                            3.0,
                        ],
                        yaw: 90.0,
                        health: 100,
                        armor: 100,
                        life_state: 0,
                        alive: true,
                        money: 1_000,
                        current_equipment_value: 4_000,
                        round_start_equipment_value: 4_000,
                        has_helmet: true,
                        active_weapon_name: Some("ak47".to_owned()),
                    }],
                })
                .collect(),
        }
    }

    #[test]
    fn cinematic_context_reports_non_pov_camera_feasibility() {
        let highlight = CinematicHighlight {
            id: "demo:highlight".to_owned(),
            round: 7,
            start_tick: 100,
            end_tick: 180,
            player_id: "76561198041683378".to_owned(),
            engagements: Vec::new(),
        };
        let scene = cinematic_scene_from_replay(&highlight, &replay_artifact(3));

        assert_eq!(
            scene.pointer("/cameraFeasibility/highlightSpatialFrameCount"),
            Some(&json!(3))
        );
        assert_eq!(
            scene.pointer("/cameraFeasibility/nonPovSupportedWithoutWiderHandles"),
            Some(&json!(false))
        );
        assert_eq!(
            scene.pointer("/cameraFeasibility/recommendedCameraStyle"),
            Some(&json!("pov"))
        );
    }

    #[test]
    fn story_camera_validation_requires_four_effective_samples() {
        let error = validate_camera_sample_count("R7", HlaeCameraStyle::Tracking, 3, 100, 180)
            .expect_err("three samples cannot drive a camera path");
        assert!(error.contains("has 3 spatial samples"));
        assert!(error.contains("use pov"));
        validate_camera_sample_count("R7", HlaeCameraStyle::Tracking, 4, 100, 180)
            .expect("four samples are executable");
    }

    #[test]
    fn series_highlight_id_is_canonicalized_before_capture() {
        let demo_id = Uuid::from_u128(42);
        assert_eq!(
            canonical_highlight_id(demo_id, &format!("{demo_id}:7:defuse")),
            "7:defuse"
        );
        assert_eq!(canonical_highlight_id(demo_id, "7:defuse"), "7:defuse");
    }

    #[test]
    fn targeted_series_evidence_filters_before_any_global_highlight_cap() {
        let demo_id = Uuid::from_u128(42);
        let highlights = (0..200)
            .map(|index| {
                json!({
                    "id":format!("h-{index}"),
                    "player_id":if index >= 190 { "niko" } else { "other" },
                    "kind":"one_tap",
                    "score":0.9,
                    "start_tick":index,
                })
            })
            .collect::<Vec<_>>();
        let series = vec![(
            demo_id,
            json!({"id":demo_id}),
            json!({
                "map_name":"de_mirage",
                "tick_rate":64.0,
                "duration_seconds":100.0,
                "players":[{"steam_id":"niko","name":"NiKo"},{"steam_id":"other","name":"Other"}],
                "highlights":highlights,
            }),
        )];

        let evidence = series_evidence_analysis(&series, None);
        let result = vibe_cs_agent::query_demo_evidence(
            &evidence,
            &json!({"playerName":"NiKo","kinds":["one_tap"],"maximumHighlights":64}),
        )
        .expect("targeted raw evidence");

        assert_eq!(result["highlights"].as_array().map(Vec::len), Some(10));
        assert_eq!(result["evidence_query"]["matched_highlight_count"], 10);
        assert!(
            result["highlights"]
                .as_array()
                .is_some_and(|items| items.iter().all(|item| item["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with(&demo_id.to_string()))))
        );
    }

    #[test]
    fn series_prompt_context_is_inventory_not_an_evidence_dump() {
        let demo_id = Uuid::from_u128(7);
        let series = vec![(
            demo_id,
            Value::Null,
            json!({
                "map_name":"de_anubis",
                "tick_rate":64.0,
                "duration_seconds":3000.0,
                "players":[{"steam_id":"niko","name":"NiKo"}],
                "highlights":[{"id":"h-1"},{"id":"h-2"}],
            }),
        )];

        let inventory = summarize_series_inventory(&series);
        assert_eq!(inventory["highlights"], json!([]));
        assert_eq!(inventory["demos"][0]["demo_id"], json!(demo_id));
        assert_eq!(inventory["demos"][0]["highlight_count"], 2);
        assert_eq!(inventory["evidence_query_required"], true);
    }
}
