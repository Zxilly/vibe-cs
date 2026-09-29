use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use vibe_cs_domain::{DomainError, HlaeCameraStyle, RecordingRequest};
use vibe_cs_hlae::{CameraSample, CameraShot};

/// Per-pose evidence. An absent observation is unknown, never an unobstructed view.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct CameraPoseDiagnostic {
    pub time_seconds: f64,
    pub tick: f64,
    pub wall_distance: f64,
    pub near_wall: bool,
    /// Contained by an original convex physics solid, never inferred from an open mesh.
    pub inside_solid: bool,
    pub crossed_surface: bool,
    pub head_occluded: Option<bool>,
    pub chest_occluded: Option<bool>,
    pub target_in_view: Option<bool>,
}

/// Read projection of the same camera plan compiled for recording.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct CameraPlan {
    pub requested_style: HlaeCameraStyle,
    pub effective_style: HlaeCameraStyle,
    pub adjusted: bool,
    pub shot: CameraShot,
    pub samples: Vec<CameraSample>,
    pub original_diagnostics: Vec<CameraPoseDiagnostic>,
    pub diagnostics: Vec<CameraPoseDiagnostic>,
    pub geometry_unavailable: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CameraIssueKind {
    InsideSolid,
    NearWall,
    SurfaceCrossing,
    TargetOccluded,
    TargetOutOfView,
    TargetUnobserved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CameraIssueInterval {
    pub kind: CameraIssueKind,
    pub start_seconds: f64,
    pub end_seconds: f64,
    /// Fraction of tested head/chest points obscured in an occlusion interval;
    /// other issue kinds have fraction 1.0. This is sampled geometric evidence.
    pub affected_fraction: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CameraInspection {
    pub requested_style: HlaeCameraStyle,
    pub effective_style: HlaeCameraStyle,
    pub adjusted: bool,
    pub geometry_unavailable: Option<String>,
    pub original_issues: Vec<CameraIssueInterval>,
    pub issues: Vec<CameraIssueInterval>,
}

impl CameraPlan {
    pub fn inspection(&self) -> CameraInspection {
        CameraInspection {
            requested_style: self.requested_style,
            effective_style: self.effective_style,
            adjusted: self.adjusted,
            geometry_unavailable: self.geometry_unavailable.clone(),
            original_issues: camera_issue_intervals(&self.original_diagnostics),
            issues: camera_issue_intervals(&self.diagnostics),
        }
    }
}

/// Exact binary replay source used by the planner, not the latest UI analysis.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct CameraReplaySource {
    pub demo_id: uuid::Uuid,
    pub producer_run_id: uuid::Uuid,
}

/// A read-only viewport projection. POV uses observed player poses and has no
/// generated campath. Both modes load actors through the existing ARPL source.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct CameraPreview {
    pub replay: CameraReplaySource,
    pub map_name: String,
    pub player_id: String,
    pub start_tick: u64,
    pub end_tick: u64,
    pub tick_rate: f64,
    pub aspect_ratio: f64,
    pub plan: Option<CameraPlan>,
}

/// Compact Agent/tool projection; rendering consumes the original per-pose data.
pub fn camera_issue_intervals(samples: &[CameraPoseDiagnostic]) -> Vec<CameraIssueInterval> {
    use CameraIssueKind::{
        InsideSolid, NearWall, SurfaceCrossing, TargetOccluded, TargetOutOfView, TargetUnobserved,
    };
    let mut result = Vec::new();
    for kind in [
        InsideSolid,
        NearWall,
        SurfaceCrossing,
        TargetOccluded,
        TargetOutOfView,
        TargetUnobserved,
    ] {
        let value = |sample: &CameraPoseDiagnostic| match kind {
            InsideSolid => f64::from(u8::from(sample.inside_solid)),
            NearWall => f64::from(u8::from(sample.near_wall)),
            SurfaceCrossing => f64::from(u8::from(sample.crossed_surface)),
            TargetOccluded => {
                (f64::from(u8::from(sample.head_occluded == Some(true)))
                    + f64::from(u8::from(sample.chest_occluded == Some(true))))
                    * 0.5
            }
            TargetOutOfView => f64::from(u8::from(sample.target_in_view == Some(false))),
            TargetUnobserved => f64::from(u8::from(sample.target_in_view.is_none())),
        };
        let mut start = 0;
        while start < samples.len() {
            if value(&samples[start]) == 0.0 {
                start += 1;
                continue;
            }
            let mut end = start + 1;
            let mut sum = value(&samples[start]);
            let mut count = 1.0;
            while end < samples.len() && value(&samples[end]) > 0.0 {
                sum += value(&samples[end]);
                count += 1.0;
                end += 1;
            }
            result.push(CameraIssueInterval {
                kind,
                start_seconds: samples[start].time_seconds,
                end_seconds: samples.get(end).unwrap_or(&samples[end - 1]).time_seconds,
                affected_fraction: sum / count,
            });
            start = end;
        }
    }
    result.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    result
}

#[async_trait]
pub trait CameraPreviewPort: Send + Sync + std::fmt::Debug {
    async fn preview(&self, request: RecordingRequest) -> Result<CameraPreview, DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledCameraPreviewPort;

#[async_trait]
impl CameraPreviewPort for DisabledCameraPreviewPort {
    async fn preview(&self, _request: RecordingRequest) -> Result<CameraPreview, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "camera preview adapter".to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_intervals_keep_partial_occlusion_and_missing_evidence_distinct() {
        let mut poses = (0..4)
            .map(|index| CameraPoseDiagnostic {
                time_seconds: f64::from(index),
                tick: f64::from(index * 64),
                wall_distance: 100.0,
                near_wall: false,
                inside_solid: false,
                crossed_surface: false,
                head_occluded: Some(false),
                chest_occluded: Some(false),
                target_in_view: Some(true),
            })
            .collect::<Vec<_>>();
        poses[0].head_occluded = Some(true);
        poses[1].head_occluded = Some(true);
        poses[1].chest_occluded = Some(true);
        poses[2].head_occluded = None;
        poses[2].chest_occluded = None;
        poses[2].target_in_view = None;
        poses[3].inside_solid = true;
        let intervals = camera_issue_intervals(&poses);
        assert_eq!(
            intervals,
            vec![
                CameraIssueInterval {
                    kind: CameraIssueKind::TargetOccluded,
                    start_seconds: 0.0,
                    end_seconds: 2.0,
                    affected_fraction: 0.75
                },
                CameraIssueInterval {
                    kind: CameraIssueKind::TargetUnobserved,
                    start_seconds: 2.0,
                    end_seconds: 3.0,
                    affected_fraction: 1.0
                },
                CameraIssueInterval {
                    kind: CameraIssueKind::InsideSolid,
                    start_seconds: 3.0,
                    end_seconds: 3.0,
                    affected_fraction: 1.0
                },
            ]
        );
    }
}
