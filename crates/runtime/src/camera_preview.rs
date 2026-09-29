use std::{collections::HashMap, path::Path, sync::Arc};

use async_trait::async_trait;
use vibe_cs_application::{
    AnalysisPort, CameraPlan, CameraPreview, CameraPreviewPort, CameraReplaySource,
};
use vibe_cs_domain::{DomainError, HlaeCameraStyle, RecordingRequest};
use vibe_cs_storage::Storage;

use crate::{
    RuntimeSourceAssetPort,
    camera_planning::{CameraScene, plan_camera_scene},
};

#[derive(Debug)]
pub struct RuntimeCameraPreviewPort {
    storage: Storage,
    analysis: Arc<dyn AnalysisPort>,
    source_assets: Arc<RuntimeSourceAssetPort>,
}

impl RuntimeCameraPreviewPort {
    pub fn new(
        storage: Storage,
        analysis: Arc<dyn AnalysisPort>,
        source_assets: Arc<RuntimeSourceAssetPort>,
    ) -> Self {
        Self {
            storage,
            analysis,
            source_assets,
        }
    }
}

/// The blocking planning work has the same ownership and geometry policy for
/// recording preflight and the read-only preview port.
pub(crate) async fn plan_with_local_geometry(
    scene: CameraScene,
    assets: Option<&RuntimeSourceAssetPort>,
) -> Result<CameraPlan, DomainError> {
    let geometry = if let Some(assets) = assets {
        assets
            .camera_geometry(&scene.map_name)
            .await
            .map_err(|error| error.to_string())
    } else {
        Err("local map geometry is unavailable".to_owned())
    };
    tokio::task::spawn_blocking(move || {
        plan_camera_scene(&scene, geometry.as_deref().map_err(Clone::clone))
    })
    .await
    .map_err(|error| DomainError::Internal(format!("camera planning task failed: {error}")))?
}

#[async_trait]
impl CameraPreviewPort for RuntimeCameraPreviewPort {
    async fn preview(&self, request: RecordingRequest) -> Result<CameraPreview, DomainError> {
        request.validate()?;
        let config = self
            .storage
            .get_config()
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?
            .unwrap_or_default();
        let capture = crate::HlaeRecordingBackend::capture_settings(&config)?;
        let aspect_ratio = f64::from(capture.width) / f64::from(capture.height);
        let demo = self
            .storage
            .get_demo(request.demo_id)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?
            .ok_or_else(|| DomainError::NotFound("camera Demo".to_owned()))?;
        let analysis = self
            .storage
            .get_analysis(demo.id)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        let tick_rate = crate::recording::authoritative_tick_rate(analysis.as_ref())?;
        let path = std::path::absolute(Path::new(&demo.path))
            .map_err(|error| DomainError::InvalidInput(error.to_string()))?;
        let segment = crate::recording::build_segment_plan(
            &request,
            &demo,
            analysis.as_ref(),
            path,
            tick_rate,
            uuid::Uuid::nil(),
        )?;
        let (producer_run_id, replay) = crate::recording::camera_replay_source(
            &self.storage,
            self.analysis.as_ref(),
            &demo,
            &mut HashMap::new(),
        )
        .await?;
        let mut preview = CameraPreview {
            replay: CameraReplaySource {
                demo_id: demo.id,
                producer_run_id,
            },
            map_name: demo.map_name.unwrap_or_default(),
            player_id: segment.player_id,
            start_tick: segment.start_tick,
            end_tick: segment.end_tick,
            tick_rate,
            aspect_ratio,
            plan: None,
        };
        if request.camera_style == HlaeCameraStyle::Pov {
            return Ok(preview);
        }
        let scene = CameraScene {
            id: "preview".to_owned(),
            map_name: preview.map_name.clone(),
            frames: crate::recording::capture_replay_frames(
                &replay,
                segment.start_tick,
                segment.end_tick,
            ),
            player_id: preview.player_id.clone(),
            start_tick: segment.start_tick,
            end_tick: segment.end_tick,
            tick_rate,
            style: request.camera_style,
            aspect_ratio,
        };
        preview.plan = Some(plan_with_local_geometry(scene, Some(&self.source_assets)).await?);
        Ok(preview)
    }
}
