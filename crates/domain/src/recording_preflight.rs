//! The closed pre-recording check contract.
//!
//! Before this module a recording plan reported readiness as
//! `RecordingPlanResponse.warnings: Vec<String>` - free text a client can only
//! print. That is enough for a log line and not enough for a list of checks
//! with states, because "is this the encoder row or the disk row" and "does
//! this one stop the recording" are both unanswerable from a sentence.
//!
//! So the check identity is a closed enum ([`RecordingPreflightCode`]), the
//! outcome is a closed enum ([`RecordingPreflightState`]), and everything that
//! genuinely cannot be enumerated - a byte count, a version, a file name -
//! stays in `detail`, in English, for the client to localize around.
//!
//! # Why exactly these codes
//!
//! Every member below is backed by a fact this application can already
//! observe. A check with no data source would have to answer "ok" forever,
//! and a row that is permanently green is worse than a missing row: it tells
//! the user something was verified when nothing was.
//!
//! | code | source |
//! | --- | --- |
//! | [`RecordingPreflightCode::GameReady`] | the CS2 executable found by `vibe_cs_integrations`' path discovery, the same fact `/api/setup/status` reports |
//! | [`RecordingPreflightCode::CaptureComponentReady`] | [`crate::HlaeStatus`] - `managed_release.prepared`, `available`, `launch_profile_ready` |
//! | [`RecordingPreflightCode::DemoContentMatches`] | the persisted [`crate::DemoRecord`] `content_sha256` / `file_size` against the file on disk, which is what runtime's `verify_recording_demo_content` re-checks before every take |
//! | [`RecordingPreflightCode::OutputDirectoryWritable`] | the managed data directory plus the filesystem byte counts behind `/api/storage/status` |
//! | [`RecordingPreflightCode::SpectatorEvidenceComplete`] | [`crate::PlayerStats::spectator_slot`], the parser-observed slot `build_player_pov_plan` refuses to invent |
//! | [`RecordingPreflightCode::EncoderAvailable`] | the Media Foundation H.264/AAC capability probe (`HlaeSequenceEncoderCapabilityReport`) |
//! | [`RecordingPreflightCode::TickRangeWithinDemo`] | [`crate::MatchAnalysis::verified_total_ticks`] against each item's tick window |
//! | [`RecordingPreflightCode::CameraCollisionUnverified`] | the fixed `HlaeNoticeCode::CameraCollisionNotChecked` notice the HLAE plan validator raises for every camera-path plan |
//!
//! The last one deserves its own sentence, because it is the one row that is
//! not a measurement. There is no map-geometry analysis anywhere in this
//! product; what exists is the validator's standing statement that camera
//! coordinates cannot be checked against map geometry before an in-game
//! preview. That statement is true of camera-path shots and vacuously false of
//! player-POV shots, which never carry invented coordinates. So this check is
//! [`RecordingPreflightState::Warning`] exactly when the plan contains at least
//! one observer shot and [`RecordingPreflightState::Ok`] when it does not - a
//! state that varies with the plan, listing the affected shots, never a
//! permanent green.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::DomainError;

/// Longest `detail` a check may carry. Long enough for a path plus a byte
/// count, short enough that no check can smuggle a report into the list.
pub const RECORDING_PREFLIGHT_MAX_DETAIL_CHARS: usize = 400;
/// Most shots one check may name. A plan cannot exceed the managed HLAE take
/// ceiling, so a check that named more than this would be naming something
/// other than the plan's shots.
pub const RECORDING_PREFLIGHT_MAX_AFFECTED_ITEMS: usize = 64;

/// The outcome of one check.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingPreflightState {
    /// The condition holds.
    Ok,
    /// The condition does not hold, but recording can still run and produce
    /// usable output. The user should read the row before starting.
    Warning,
    /// The condition does not hold and recording would certainly fail.
    Blocked,
}

/// The closed set of pre-recording checks.
///
/// Membership is decided by "does this application observe the fact", never by
/// the artboard. See the module documentation for the source of each member.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum RecordingPreflightCode {
    /// A CS2 executable is discoverable. Managed capture launches it for
    /// offline Demo playback, so a missing game cannot be worked around.
    GameReady,
    /// The reviewed managed HLAE release is prepared and its launch profile is
    /// complete.
    CaptureComponentReady,
    /// Every Demo referenced by the plan still matches the content that was
    /// indexed and analyzed.
    DemoContentMatches,
    /// The managed output directory exists, is writable, and has room.
    OutputDirectoryWritable,
    /// Every player-POV item has a parser-observed CS2 spectator slot.
    SpectatorEvidenceComplete,
    /// The native Media Foundation pipeline has registered H.264 and AAC
    /// encoders.
    EncoderAvailable,
    /// Every item's tick window lies inside the parser-verified Demo length.
    TickRangeWithinDemo,
    /// The plan contains camera-path shots whose coordinates cannot be checked
    /// against map geometry until an in-game preview runs.
    CameraCollisionUnverified,
}

impl RecordingPreflightCode {
    /// The canonical persisted discriminator for this check.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GameReady => "game_ready",
            Self::CaptureComponentReady => "capture_component_ready",
            Self::DemoContentMatches => "demo_content_matches",
            Self::OutputDirectoryWritable => "output_directory_writable",
            Self::SpectatorEvidenceComplete => "spectator_evidence_complete",
            Self::EncoderAvailable => "encoder_available",
            Self::TickRangeWithinDemo => "tick_range_within_demo",
            Self::CameraCollisionUnverified => "camera_collision_unverified",
        }
    }

    /// Parses the canonical persisted discriminator.
    #[must_use]
    pub fn from_str_exact(value: &str) -> Option<Self> {
        match value {
            "game_ready" => Some(Self::GameReady),
            "capture_component_ready" => Some(Self::CaptureComponentReady),
            "demo_content_matches" => Some(Self::DemoContentMatches),
            "output_directory_writable" => Some(Self::OutputDirectoryWritable),
            "spectator_evidence_complete" => Some(Self::SpectatorEvidenceComplete),
            "encoder_available" => Some(Self::EncoderAvailable),
            "tick_range_within_demo" => Some(Self::TickRangeWithinDemo),
            "camera_collision_unverified" => Some(Self::CameraCollisionUnverified),
            _ => None,
        }
    }

    /// Whether an unmet condition of this kind can ever stop a recording.
    ///
    /// The answer is decided by "would the capture certainly fail", never by
    /// how the row is coloured. Seven of the eight checks gate a step the
    /// pipeline cannot skip - no game, no capture component, changed Demo
    /// bytes, an unwritable output root, a missing spectator slot for a POV
    /// take, no registered encoder, or a tick window outside the Demo all end
    /// in a failed job. The eighth reports a limitation of the preview, not a
    /// missing prerequisite, so it may never be [`RecordingPreflightState::Blocked`].
    #[must_use]
    pub const fn can_block(self) -> bool {
        !matches!(self, Self::CameraCollisionUnverified)
    }

    /// Every member, in the order the check list is presented.
    #[must_use]
    pub const fn all() -> [Self; 8] {
        [
            Self::GameReady,
            Self::CaptureComponentReady,
            Self::DemoContentMatches,
            Self::OutputDirectoryWritable,
            Self::SpectatorEvidenceComplete,
            Self::EncoderAvailable,
            Self::TickRangeWithinDemo,
            Self::CameraCollisionUnverified,
        ]
    }
}

/// One row of the pre-recording check list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecordingPreflightCheck {
    pub code: RecordingPreflightCode,
    pub state: RecordingPreflightState,
    /// English facts the closed code cannot carry: remaining bytes, a release
    /// version, the name of the Demo that changed. Clients localize around it;
    /// the code is what they look up.
    pub detail: String,
    /// The plan items this check speaks about, when it speaks about only some
    /// of them. Empty means the check covers the whole plan - it is never a
    /// stand-in for "unknown".
    pub affected_item_ids: Vec<Uuid>,
}

impl RecordingPreflightCheck {
    /// Normalizes one check row.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the detail exceeds its bound,
    /// when the affected list is oversized or repeats an item, or when a check
    /// that can never stop a recording claims to be
    /// [`RecordingPreflightState::Blocked`].
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        let detail = self.detail.trim().to_owned();
        if detail.chars().count() > RECORDING_PREFLIGHT_MAX_DETAIL_CHARS {
            return Err(DomainError::InvalidInput(format!(
                "preflight detail must contain at most {RECORDING_PREFLIGHT_MAX_DETAIL_CHARS} characters"
            )));
        }
        self.detail = detail;
        if self.affected_item_ids.len() > RECORDING_PREFLIGHT_MAX_AFFECTED_ITEMS {
            return Err(DomainError::InvalidInput(format!(
                "a preflight check may name at most {RECORDING_PREFLIGHT_MAX_AFFECTED_ITEMS} items"
            )));
        }
        let mut seen = std::collections::HashSet::with_capacity(self.affected_item_ids.len());
        if !self.affected_item_ids.iter().all(|id| seen.insert(*id)) {
            return Err(DomainError::InvalidInput(
                "a preflight check must name each affected item once".to_owned(),
            ));
        }
        if self.state == RecordingPreflightState::Blocked && !self.code.can_block() {
            return Err(DomainError::InvalidInput(format!(
                "preflight check {} reports a preview limitation and can never block recording",
                self.code.as_str()
            )));
        }
        Ok(self)
    }
}

/// The whole pre-recording check list.
///
/// `blocking` is the number of [`RecordingPreflightState::Blocked`] rows and is
/// server-computed. Its contract for clients is exactly one sentence: **while
/// `blocking > 0` the "start recording" action is disabled.** Warnings never
/// disable it - they are things the user should read, not things the pipeline
/// cannot do. Publishing the count rather than making each client fold over
/// `checks` keeps that decision on the side that decided which codes can block
/// at all.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecordingPreflight {
    pub checks: Vec<RecordingPreflightCheck>,
    /// Number of `checks` whose state is [`RecordingPreflightState::Blocked`].
    pub blocking: usize,
}

impl RecordingPreflight {
    /// Builds a check list, normalizing every row and computing `blocking`.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when a row is invalid or a code
    /// appears twice. One code is one row: a second row for the same code would
    /// leave a client with two contradictory answers and no rule for choosing.
    pub fn new(checks: Vec<RecordingPreflightCheck>) -> Result<Self, DomainError> {
        let mut seen = std::collections::HashSet::with_capacity(checks.len());
        let checks = checks
            .into_iter()
            .map(|check| {
                let check = check.normalize()?;
                if seen.insert(check.code) {
                    Ok(check)
                } else {
                    Err(DomainError::InvalidInput(format!(
                        "preflight check {} appears more than once",
                        check.code.as_str()
                    )))
                }
            })
            .collect::<Result<Vec<_>, DomainError>>()?;
        let blocking = Self::count_blocking(&checks);
        Ok(Self { checks, blocking })
    }

    /// Validates a decoded check list against the same rules [`Self::new`]
    /// enforces, including that `blocking` matches the rows.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the document is not one this
    /// application could have produced.
    pub fn validate(&self) -> Result<(), DomainError> {
        let rebuilt = Self::new(self.checks.clone())?;
        if rebuilt.blocking == self.blocking {
            Ok(())
        } else {
            Err(DomainError::InvalidInput(
                "preflight blocking count does not match its checks".to_owned(),
            ))
        }
    }

    /// Whether the "start recording" action must stay disabled.
    #[must_use]
    pub const fn is_blocked(&self) -> bool {
        self.blocking > 0
    }

    fn count_blocking(checks: &[RecordingPreflightCheck]) -> usize {
        checks
            .iter()
            .filter(|check| check.state == RecordingPreflightState::Blocked)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(
        code: RecordingPreflightCode,
        state: RecordingPreflightState,
    ) -> RecordingPreflightCheck {
        RecordingPreflightCheck {
            code,
            state,
            detail: String::new(),
            affected_item_ids: Vec::new(),
        }
    }

    #[test]
    fn every_code_round_trips_through_its_persisted_text() {
        for code in RecordingPreflightCode::all() {
            assert_eq!(
                RecordingPreflightCode::from_str_exact(code.as_str()),
                Some(code)
            );
            assert_eq!(
                serde_json::to_value(code).expect("code wire"),
                serde_json::json!(code.as_str())
            );
        }
        // A check with no data source must not be spellable.
        assert_eq!(
            RecordingPreflightCode::from_str_exact("collision_geometry"),
            None
        );
        assert!(
            serde_json::from_value::<RecordingPreflightCode>(serde_json::json!(
                "network_reachable"
            ))
            .is_err()
        );
    }

    #[test]
    fn blocking_is_computed_from_the_rows_and_gates_the_start_action() {
        let preflight = RecordingPreflight::new(vec![
            check(
                RecordingPreflightCode::GameReady,
                RecordingPreflightState::Ok,
            ),
            check(
                RecordingPreflightCode::EncoderAvailable,
                RecordingPreflightState::Blocked,
            ),
            check(
                RecordingPreflightCode::TickRangeWithinDemo,
                RecordingPreflightState::Blocked,
            ),
            check(
                RecordingPreflightCode::CameraCollisionUnverified,
                RecordingPreflightState::Warning,
            ),
        ])
        .expect("a well-formed check list");

        assert_eq!(preflight.blocking, 2);
        assert!(preflight.is_blocked());
        preflight.validate().expect("self-consistent document");

        let warnings_only = RecordingPreflight::new(vec![
            check(
                RecordingPreflightCode::GameReady,
                RecordingPreflightState::Ok,
            ),
            check(
                RecordingPreflightCode::CameraCollisionUnverified,
                RecordingPreflightState::Warning,
            ),
        ])
        .expect("a warning-only check list");
        assert_eq!(warnings_only.blocking, 0);
        assert!(
            !warnings_only.is_blocked(),
            "a warning is something to read, not something the pipeline cannot do"
        );

        let mut tampered = preflight;
        tampered.blocking = 0;
        assert!(tampered.validate().is_err());
    }

    #[test]
    fn a_preview_limitation_can_never_be_reported_as_blocking() {
        assert!(
            check(
                RecordingPreflightCode::CameraCollisionUnverified,
                RecordingPreflightState::Blocked,
            )
            .normalize()
            .is_err()
        );
        for code in RecordingPreflightCode::all() {
            let blocked = check(code, RecordingPreflightState::Blocked).normalize();
            assert_eq!(
                blocked.is_ok(),
                code.can_block(),
                "{} must agree with can_block()",
                code.as_str()
            );
            check(code, RecordingPreflightState::Warning)
                .normalize()
                .expect("every check may warn");
        }
    }

    #[test]
    fn a_check_names_each_affected_item_once_and_stays_bounded() {
        let id = Uuid::new_v4();
        RecordingPreflightCheck {
            affected_item_ids: vec![id, Uuid::new_v4()],
            ..check(
                RecordingPreflightCode::SpectatorEvidenceComplete,
                RecordingPreflightState::Blocked,
            )
        }
        .normalize()
        .expect("a check may name a subset of the plan");

        assert!(
            RecordingPreflightCheck {
                affected_item_ids: vec![id, id],
                ..check(
                    RecordingPreflightCode::SpectatorEvidenceComplete,
                    RecordingPreflightState::Blocked,
                )
            }
            .normalize()
            .is_err()
        );
        assert!(
            RecordingPreflightCheck {
                affected_item_ids: (0..=RECORDING_PREFLIGHT_MAX_AFFECTED_ITEMS)
                    .map(|_| Uuid::new_v4())
                    .collect(),
                ..check(
                    RecordingPreflightCode::SpectatorEvidenceComplete,
                    RecordingPreflightState::Blocked,
                )
            }
            .normalize()
            .is_err()
        );
        assert!(
            RecordingPreflightCheck {
                detail: "x".repeat(RECORDING_PREFLIGHT_MAX_DETAIL_CHARS + 1),
                ..check(
                    RecordingPreflightCode::OutputDirectoryWritable,
                    RecordingPreflightState::Ok,
                )
            }
            .normalize()
            .is_err()
        );
        assert_eq!(
            RecordingPreflightCheck {
                detail: "  218 GB available  ".to_owned(),
                ..check(
                    RecordingPreflightCode::OutputDirectoryWritable,
                    RecordingPreflightState::Ok,
                )
            }
            .normalize()
            .expect("bounded detail")
            .detail,
            "218 GB available"
        );
    }

    #[test]
    fn one_code_is_one_row() {
        assert!(
            RecordingPreflight::new(vec![
                check(
                    RecordingPreflightCode::GameReady,
                    RecordingPreflightState::Ok
                ),
                check(
                    RecordingPreflightCode::GameReady,
                    RecordingPreflightState::Blocked
                ),
            ])
            .is_err()
        );
    }

    #[test]
    fn the_check_list_accepts_only_the_current_document() {
        let preflight = RecordingPreflight::new(vec![check(
            RecordingPreflightCode::GameReady,
            RecordingPreflightState::Ok,
        )])
        .expect("check list");
        let wire = serde_json::to_value(&preflight).expect("preflight wire");
        assert_eq!(
            serde_json::from_value::<RecordingPreflight>(wire.clone()).expect("current shape"),
            preflight
        );

        let mut unknown = wire.clone();
        unknown["ready"] = serde_json::json!(true);
        assert!(serde_json::from_value::<RecordingPreflight>(unknown).is_err());

        let mut unknown_row = wire;
        unknown_row["checks"][0]["label"] = serde_json::json!("CS2 已就绪");
        assert!(serde_json::from_value::<RecordingPreflight>(unknown_row).is_err());
    }
}
