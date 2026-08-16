use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub const MAX_ANALYSIS_RUN_EVENTS: u32 = 32;
pub const MAX_ANALYSIS_RUN_DETAIL_CHARS: usize = 2_000;

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AnalysisRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

impl AnalysisRunStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Interrupted | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AnalysisRunStage {
    ValidatingInput,
    ParserQueued,
    ParserRunning,
    VerifyingInputAfterParse,
    Projecting,
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

impl AnalysisRunStage {
    #[must_use]
    pub const fn status(self) -> AnalysisRunStatus {
        match self {
            Self::ValidatingInput | Self::ParserQueued => AnalysisRunStatus::Queued,
            Self::ParserRunning | Self::VerifyingInputAfterParse | Self::Projecting => {
                AnalysisRunStatus::Running
            }
            Self::Completed => AnalysisRunStatus::Completed,
            Self::Failed => AnalysisRunStatus::Failed,
            Self::Interrupted => AnalysisRunStatus::Interrupted,
            Self::Cancelled => AnalysisRunStatus::Cancelled,
        }
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Interrupted | Self::Cancelled
        )
    }

    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::ValidatingInput, Self::ParserQueued)
                | (Self::ParserQueued, Self::ParserRunning)
                | (Self::ParserRunning, Self::VerifyingInputAfterParse)
                | (Self::VerifyingInputAfterParse, Self::Projecting)
                | (Self::Projecting, Self::Completed)
        ) || (!self.is_terminal()
            && matches!(next, Self::Failed | Self::Interrupted | Self::Cancelled))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AnalysisRun {
    pub id: Uuid,
    pub demo_id: Uuid,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub input_sha256: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub input_size: Option<u64>,
    pub status: AnalysisRunStatus,
    pub stage: AnalysisRunStage,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub error: Option<String>,
    /// The classified reason beside the free-text one — see
    /// [`crate::JobFailureCode`].
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub error_code: Option<crate::JobFailureCode>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AnalysisRunEvent {
    pub run_id: Uuid,
    pub sequence: u32,
    pub stage: AnalysisRunStage,
    pub message_code: AnalysisRunEventCode,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub detail: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AnalysisRunEventCode {
    InputValidationStarted,
    InputVerified,
    ParserStarted,
    InputRevalidationStarted,
    ProjectionStarted,
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

impl AnalysisRunEventCode {
    #[must_use]
    pub const fn stage(self) -> AnalysisRunStage {
        match self {
            Self::InputValidationStarted => AnalysisRunStage::ValidatingInput,
            Self::InputVerified => AnalysisRunStage::ParserQueued,
            Self::ParserStarted => AnalysisRunStage::ParserRunning,
            Self::InputRevalidationStarted => AnalysisRunStage::VerifyingInputAfterParse,
            Self::ProjectionStarted => AnalysisRunStage::Projecting,
            Self::Completed => AnalysisRunStage::Completed,
            Self::Failed => AnalysisRunStage::Failed,
            Self::Interrupted => AnalysisRunStage::Interrupted,
            Self::Cancelled => AnalysisRunStage::Cancelled,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AnalysisRunDetail {
    pub run: AnalysisRun,
    pub events: Vec<AnalysisRunEvent>,
    pub result_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AnalysisInputFingerprint {
    pub sha256: String,
    pub size: u64,
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    use super::*;

    fn current_run() -> AnalysisRun {
        let now = Utc::now();
        AnalysisRun {
            id: Uuid::new_v4(),
            demo_id: Uuid::new_v4(),
            input_sha256: None,
            input_size: None,
            status: AnalysisRunStatus::Queued,
            stage: AnalysisRunStage::ValidatingInput,
            error: None,
            error_code: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn analysis_run_requires_the_complete_current_shape() {
        let current = serde_json::to_value(current_run()).expect("current analysis run");
        serde_json::from_value::<AnalysisRun>(current.clone()).expect("current run shape");

        for field in ["input_sha256", "input_size", "error"] {
            let mut missing = current.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<AnalysisRun>(missing).is_err(),
                "missing required nullable field {field} must be rejected"
            );
        }

        let mut retired = current;
        retired["progress_percent"] = json!(37);
        assert!(serde_json::from_value::<AnalysisRun>(retired).is_err());
    }

    #[test]
    fn analysis_run_stage_transitions_only_follow_proven_boundaries() {
        assert!(
            AnalysisRunStage::ValidatingInput.can_transition_to(AnalysisRunStage::ParserQueued)
        );
        assert!(AnalysisRunStage::ParserQueued.can_transition_to(AnalysisRunStage::ParserRunning));
        assert!(
            AnalysisRunStage::ParserRunning
                .can_transition_to(AnalysisRunStage::VerifyingInputAfterParse)
        );
        assert!(
            AnalysisRunStage::VerifyingInputAfterParse
                .can_transition_to(AnalysisRunStage::Projecting)
        );
        assert!(AnalysisRunStage::Projecting.can_transition_to(AnalysisRunStage::Completed));
        assert!(AnalysisRunStage::ParserQueued.can_transition_to(AnalysisRunStage::Failed));
        assert!(AnalysisRunStage::ParserRunning.can_transition_to(AnalysisRunStage::Interrupted));
        assert!(!AnalysisRunStage::ParserQueued.can_transition_to(AnalysisRunStage::Projecting));
        assert!(!AnalysisRunStage::Completed.can_transition_to(AnalysisRunStage::Failed));
    }

    #[test]
    fn every_non_terminal_analysis_stage_can_be_cancelled() {
        for stage in [
            AnalysisRunStage::ValidatingInput,
            AnalysisRunStage::ParserQueued,
            AnalysisRunStage::ParserRunning,
            AnalysisRunStage::VerifyingInputAfterParse,
            AnalysisRunStage::Projecting,
        ] {
            assert!(stage.can_transition_to(AnalysisRunStage::Cancelled));
        }

        assert_eq!(
            AnalysisRunStage::Cancelled.status(),
            AnalysisRunStatus::Cancelled
        );
        assert!(AnalysisRunStage::Cancelled.is_terminal());
        assert!(!AnalysisRunStage::Cancelled.can_transition_to(AnalysisRunStage::Failed));
        assert_eq!(
            AnalysisRunEventCode::Cancelled.stage(),
            AnalysisRunStage::Cancelled
        );
    }

    #[test]
    fn event_contract_has_a_fixed_per_run_bound() {
        assert_eq!(MAX_ANALYSIS_RUN_EVENTS, 32);
        assert_eq!(MAX_ANALYSIS_RUN_DETAIL_CHARS, 2_000);
        assert_eq!(
            AnalysisRunEventCode::ParserStarted.stage(),
            AnalysisRunStage::ParserRunning
        );
        assert_eq!(
            AnalysisRunStage::Interrupted.status(),
            AnalysisRunStatus::Interrupted
        );
    }
}
