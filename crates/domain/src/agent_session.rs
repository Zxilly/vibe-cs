//! Records for the Agent session layer: independent conversation threads, the
//! bidirectional session/object reference, and the server-authoritative plan
//! revision that decides whether an Agent proposal still applies.
//!
//! Three lifecycles are deliberately independent. A session is one conversation
//! thread; an object (plan, recording task, edit project, output) exists outside
//! any session; a reference is the durable record of one touch between them.
//! Deleting a session removes the conversation only - never the plans, tasks or
//! outputs it touched.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DomainError, HlaeCameraStyle, RecordingPresentation, RecordingRequest};
use ts_rs::TS;

pub const AGENT_SESSION_MAX_TITLE_CHARS: usize = 200;
pub const AGENT_SESSION_MAX_CONTENT_CHARS: usize = 32_000;
pub const AGENT_SESSION_MAX_LABEL_CHARS: usize = 200;
pub const AGENT_SESSION_MAX_SUMMARY_CHARS: usize = 400;
pub const AGENT_SESSION_MAX_STATUS_CHARS: usize = 120;
pub const AGENT_SESSION_MAX_QUERY_CHARS: usize = 256;
pub const AGENT_SESSION_DEFAULT_LIMIT: u32 = 50;
pub const AGENT_SESSION_MAX_LIMIT: u32 = 200;
pub const AGENT_SESSION_MAX_TOOL_CALLS: usize = 64;
pub const AGENT_SESSION_MAX_PROPOSALS: usize = 32;
pub const AGENT_SESSION_MAX_REFS: usize = 64;
pub const AGENT_PLAN_MAX_SHOTS: usize = 64;
pub const AGENT_PLAN_MAX_RISKS: usize = 16;
pub const AGENT_PLAN_MAX_EVIDENCE_REFS: usize = 64;
pub const AGENT_PLAN_MAX_ORIGINS: usize = 200;
pub const WORKSPACE_EDIT_MAX_CHANGES: usize = 128;
pub const WORKSPACE_EDIT_MAX_NOTE_CHARS: usize = 2_000;
pub const WORKSPACE_EDIT_MAX_VALUE_CHARS: usize = 200;
pub const AGENT_TAKE_LIMIT_MIN: u32 = 1;
pub const AGENT_TAKE_LIMIT_MAX: u32 = 50;
pub const AGENT_TAKE_LIMIT_DEFAULT: u32 = 5;
/// 「默认成片时长」 — the artboard's own 「40 秒左右」.
pub const AGENT_VIDEO_SECONDS_DEFAULT: u32 = 40;
/// Five seconds is one shot; an hour is past what a highlight cut ever is, and
/// past it the number stops being a target and starts being a mistake.
pub const AGENT_VIDEO_SECONDS_MIN: u32 = 5;
pub const AGENT_VIDEO_SECONDS_MAX: u32 = 3_600;
pub const AGENT_SESSION_RETENTION_DEFAULT_COUNT: u32 = 50;
pub const AGENT_SESSION_RETENTION_DEFAULT_DAYS: u32 = 30;
pub const AGENT_SESSION_RETENTION_MAX_COUNT: u32 = 10_000;
pub const AGENT_SESSION_RETENTION_MAX_DAYS: u32 = 3_650;
pub const AGENT_PLAN_DEFAULT_LIMIT: u32 = 50;
pub const AGENT_PLAN_MAX_LIMIT: u32 = 200;

/// The four workspace object kinds a session can touch. Every kind keeps its own
/// lifecycle; a reference never implies ownership.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentObjectKind {
    Plan,
    RecordingTask,
    EditProject,
    Output,
}

impl AgentObjectKind {
    /// The canonical persisted discriminator for this kind.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::RecordingTask => "recording_task",
            Self::EditProject => "edit_project",
            Self::Output => "output",
        }
    }

    /// Parses the canonical persisted discriminator.
    #[must_use]
    pub fn from_str_exact(value: &str) -> Option<Self> {
        match value {
            "plan" => Some(Self::Plan),
            "recording_task" => Some(Self::RecordingTask),
            "edit_project" => Some(Self::EditProject),
            "output" => Some(Self::Output),
            _ => None,
        }
    }
}

/// One exact workspace object identity.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentObjectLocator {
    pub kind: AgentObjectKind,
    pub id: Uuid,
}

/// A session's durable record of one object it touched. `touch_count` is the
/// server-authoritative "changed it N times" fact behind the drawer label.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentObjectRef {
    pub kind: AgentObjectKind,
    pub id: Uuid,
    pub label: String,
    pub touched_at: DateTime<Utc>,
    pub touch_count: u32,
    pub summary: String,
    pub status: String,
}

/// The reverse direction of the same reference: which session touched an object.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentObjectSessionRef {
    pub session_id: Uuid,
    /// The current session title, or `None` when that session has been deleted
    /// while this historical reference row survived.
    pub session_title: Option<String>,
    pub kind: AgentObjectKind,
    pub id: Uuid,
    pub label: String,
    pub touched_at: DateTime<Utc>,
    pub touch_count: u32,
    pub summary: String,
    pub status: String,
}

/// Caller-supplied part of a reference. `touched_at` and `touch_count` stay
/// server-authoritative.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentObjectRefTouch {
    pub kind: AgentObjectKind,
    pub id: Uuid,
    pub label: String,
    pub summary: String,
    pub status: String,
}

impl AgentObjectRefTouch {
    /// Normalizes the presentation text of one reference touch.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the label, summary or status is
    /// outside the current contract.
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        self.label = required_text(&self.label, AGENT_SESSION_MAX_LABEL_CHARS, "label")?;
        self.summary = optional_text(&self.summary, AGENT_SESSION_MAX_SUMMARY_CHARS, "summary")?;
        self.status = optional_text(&self.status, AGENT_SESSION_MAX_STATUS_CHARS, "status")?;
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentToolCall {
    pub name: String,
    pub input: serde_json::Value,
    pub output: serde_json::Value,
}

/// An Agent proposal. `based_on_revision` is the plan revision the model saw;
/// an unhandled proposal whose base is older than the current plan revision is
/// stale and can no longer be applied.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentProposal {
    pub kind: String,
    pub title: String,
    /// The plan this proposal changes, when it targets one.
    pub plan_id: Option<Uuid>,
    /// The plan revision this proposal was generated from.
    pub based_on_revision: Option<i64>,
    pub payload: serde_json::Value,
}

impl AgentProposal {
    /// Whether this proposal was generated before the current plan revision and
    /// must therefore be presented as stale rather than applicable.
    ///
    /// Staleness is a readable state, not an error: the proposal body stays
    /// legible so the user can decide whether a recompute is worth it.
    #[must_use]
    pub fn is_stale(&self, plan_id: Uuid, current_revision: i64) -> bool {
        self.plan_id == Some(plan_id)
            && self
                .based_on_revision
                .is_some_and(|revision| revision < current_revision)
    }

    /// Validates the bounded proposal contract.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the kind or title is outside
    /// its bound, or when only one half of the plan revision base is present.
    pub fn validate(&self) -> Result<(), DomainError> {
        required_text(&self.kind, AGENT_SESSION_MAX_LABEL_CHARS, "proposal kind")?;
        required_text(&self.title, AGENT_SESSION_MAX_LABEL_CHARS, "proposal title")?;
        if self.plan_id.is_some() != self.based_on_revision.is_some() {
            return Err(DomainError::InvalidInput(
                "a plan proposal must carry both plan_id and based_on_revision".to_owned(),
            ));
        }
        if self.based_on_revision.is_some_and(|revision| revision < 1) {
            return Err(DomainError::InvalidInput(
                "based_on_revision must be greater than zero".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Who authored a workspace edit. A manual edit never needs Agent approval, so
/// the notice records the user as its author.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum WorkspaceEditAuthor {
    User,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum WorkspaceEditOperation {
    Updated,
    Removed,
    Inserted,
    Restored,
}

/// One field-level difference inside a workspace edit notice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceEditChange {
    /// One-based shot position inside the plan, matching the shot cards.
    pub shot: u32,
    pub op: WorkspaceEditOperation,
    pub field: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

impl WorkspaceEditChange {
    /// Normalizes and validates one difference.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the shot position is zero, a
    /// value exceeds its bound, or an `updated` difference has no field/target.
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        if self.shot == 0 {
            return Err(DomainError::InvalidInput(
                "workspace edit shot positions are one-based".to_owned(),
            ));
        }
        self.field = normalize_optional_value(self.field, "change field")?;
        self.from = normalize_optional_value(self.from, "change from")?;
        self.to = normalize_optional_value(self.to, "change to")?;
        if self.op == WorkspaceEditOperation::Updated && (self.field.is_none() || self.to.is_none())
        {
            return Err(DomainError::InvalidInput(
                "an updated workspace edit change requires a field and a new value".to_owned(),
            ));
        }
        Ok(self)
    }
}

/// The typed payload injected into the session after a manual edit. It is not a
/// chat message: it renders as one system line and can be expanded to this exact
/// document, which is also what the model receives.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceEditNotice {
    pub object: AgentObjectLocator,
    /// The plan revision produced by this edit. Server-authoritative.
    pub revision: i64,
    pub by: WorkspaceEditAuthor,
    pub at: DateTime<Utc>,
    pub changes: Vec<WorkspaceEditChange>,
    pub note: Option<String>,
}

/// One entry in a session. Only `user` and `assistant` are bubbles; a
/// `workspace_edit` entry is a system line that never enters the bubble stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentSessionEntry {
    User {
        id: Uuid,
        at: DateTime<Utc>,
        content: String,
    },
    Assistant {
        id: Uuid,
        at: DateTime<Utc>,
        content: String,
        tool_calls: Vec<AgentToolCall>,
        proposals: Vec<AgentProposal>,
    },
    WorkspaceEdit {
        id: Uuid,
        at: DateTime<Utc>,
        notice: WorkspaceEditNotice,
    },
}

impl AgentSessionEntry {
    #[must_use]
    pub const fn id(&self) -> Uuid {
        match self {
            Self::User { id, .. } | Self::Assistant { id, .. } | Self::WorkspaceEdit { id, .. } => {
                *id
            }
        }
    }

    #[must_use]
    pub const fn at(&self) -> DateTime<Utc> {
        match self {
            Self::User { at, .. } | Self::Assistant { at, .. } | Self::WorkspaceEdit { at, .. } => {
                *at
            }
        }
    }

    /// The canonical persisted entry discriminator.
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::User { .. } => "user",
            Self::Assistant { .. } => "assistant",
            Self::WorkspaceEdit { .. } => "workspace_edit",
        }
    }

    /// Lowercase text used by the session search contract.
    #[must_use]
    pub fn search_text(&self) -> String {
        match self {
            Self::User { content, .. } | Self::Assistant { content, .. } => content.to_lowercase(),
            Self::WorkspaceEdit { notice, .. } => {
                notice.note.as_deref().unwrap_or_default().to_lowercase()
            }
        }
    }
}

/// A caller-authored session entry. Workspace edit entries are never drafted by
/// a client: they are produced by the authoritative plan edit itself.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentSessionEntryDraft {
    User {
        content: String,
    },
    Assistant {
        content: String,
        tool_calls: Vec<AgentToolCall>,
        proposals: Vec<AgentProposal>,
    },
}

impl AgentSessionEntryDraft {
    /// Normalizes text and validates the bounded entry contract.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when content, tool calls or
    /// proposals are outside the current contract.
    pub fn normalize(self) -> Result<Self, DomainError> {
        match self {
            Self::User { content } => Ok(Self::User {
                content: required_text(&content, AGENT_SESSION_MAX_CONTENT_CHARS, "content")?,
            }),
            Self::Assistant {
                content,
                tool_calls,
                proposals,
            } => {
                if tool_calls.len() > AGENT_SESSION_MAX_TOOL_CALLS {
                    return Err(DomainError::InvalidInput(format!(
                        "an entry may carry at most {AGENT_SESSION_MAX_TOOL_CALLS} tool calls"
                    )));
                }
                if proposals.len() > AGENT_SESSION_MAX_PROPOSALS {
                    return Err(DomainError::InvalidInput(format!(
                        "an entry may carry at most {AGENT_SESSION_MAX_PROPOSALS} proposals"
                    )));
                }
                for proposal in &proposals {
                    proposal.validate()?;
                }
                Ok(Self::Assistant {
                    content: optional_text(&content, AGENT_SESSION_MAX_CONTENT_CHARS, "content")?,
                    tool_calls,
                    proposals,
                })
            }
        }
    }
}

/// One conversation thread. It neither inherits nor locks any task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSession {
    pub id: Uuid,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub entries: Vec<AgentSessionEntry>,
    pub refs: Vec<AgentObjectRef>,
}

/// The session drawer row: the thread plus the objects it touched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionSummary {
    pub id: Uuid,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub entry_count: u32,
    pub refs: Vec<AgentObjectRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionPage {
    pub items: Vec<AgentSessionSummary>,
    pub total: u64,
}

/// Bounded session list query used by the drawer's search field.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionQuery {
    #[ts(optional)]
    pub q: Option<String>,
    #[ts(optional)]
    pub limit: Option<u32>,
}

impl AgentSessionQuery {
    /// Validates the bounded search and limit contract.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the query text or limit is out
    /// of range.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.q.as_deref().is_some_and(|value| {
            value.trim().is_empty() || value.trim().chars().count() > AGENT_SESSION_MAX_QUERY_CHARS
        }) {
            return Err(DomainError::InvalidInput(format!(
                "q must contain 1 to {AGENT_SESSION_MAX_QUERY_CHARS} characters"
            )));
        }
        if self
            .limit
            .is_some_and(|limit| !(1..=AGENT_SESSION_MAX_LIMIT).contains(&limit))
        {
            return Err(DomainError::InvalidInput(format!(
                "limit must be between 1 and {AGENT_SESSION_MAX_LIMIT}"
            )));
        }
        Ok(())
    }

    #[must_use]
    pub fn effective_limit(&self) -> u32 {
        self.limit
            .unwrap_or(AGENT_SESSION_DEFAULT_LIMIT)
            .clamp(1, AGENT_SESSION_MAX_LIMIT)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentPlanStatus {
    Draft,
    AwaitingConfirmation,
    Confirmed,
    Archived,
}

impl AgentPlanStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::AwaitingConfirmation => "awaiting_confirmation",
            Self::Confirmed => "confirmed",
            Self::Archived => "archived",
        }
    }

    #[must_use]
    pub fn from_str_exact(value: &str) -> Option<Self> {
        match value {
            "draft" => Some(Self::Draft),
            "awaiting_confirmation" => Some(Self::AwaitingConfirmation),
            "confirmed" => Some(Self::Confirmed),
            "archived" => Some(Self::Archived),
            _ => None,
        }
    }
}

/// Who a shot came from. The badge distinguishes an Agent shot from one the user
/// edited; the Agent must never silently roll a user edit back.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentPlanAuthor {
    Agent,
    User,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentShotView {
    Observer,
    PlayerPov,
}

/// What binds one plan shot to real footage, so a plan can be turned into a
/// recording queue without guessing.
///
/// # Why this is typed and not `params`
///
/// `AgentPlanShot::params` is a free bag. Reading `demo_id` and `player_id`
/// back out of it to assemble a [`RecordingRequest`] would write the same
/// schema in two places - once where the Agent fills the bag, once where the
/// recording route empties it - with nothing to fail when the two drift. That
/// is the exact reason the reverse mapper was rejected once already
/// (design §10.6 deviation 3). Typed fields make the drift a compile error.
///
/// # Why the three remaining request fields are absent
///
/// `camera_style` comes from [`AgentPlanShot::kind`], the tick window from the
/// shot itself, and the title from [`AgentPlanShot::title`]. Storing a second
/// copy here is storing something that can disagree with the shot the user is
/// looking at, and nothing would notice which copy was stale.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentShotRecording {
    pub demo_id: Uuid,
    /// Canonical non-zero 17-digit `SteamID64`, checked during normalization
    /// because managed player-POV capture rejects anything else and doing it
    /// here means the rejection arrives while the plan is still on screen.
    pub player_id: String,
    pub highlight_id: Option<String>,
    pub victim_pov: bool,
    pub pre_roll_seconds: f64,
    pub post_roll_seconds: f64,
    /// Per-shot capture presentation. `None` follows the global
    /// [`crate::RecordingDefaults`], exactly as it does on a
    /// [`RecordingRequest`].
    pub presentation: Option<RecordingPresentation>,
}

impl AgentShotRecording {
    /// Normalizes the binding.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the player identifier is not
    /// a canonical `SteamID64`, the highlight reference exceeds its bound, or a
    /// roll value is out of range.
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        if self.player_id.len() != 17
            || !self.player_id.bytes().all(|byte| byte.is_ascii_digit())
            || !matches!(self.player_id.parse::<u64>(), Ok(value) if value != 0)
        {
            return Err(DomainError::InvalidInput(
                "player_id must be a canonical non-zero 17-digit SteamID64".to_owned(),
            ));
        }
        self.highlight_id = self
            .highlight_id
            .map(|value| {
                required_text(&value, AGENT_SESSION_MAX_LABEL_CHARS, "highlight reference")
            })
            .transpose()?;
        if !self.pre_roll_seconds.is_finite()
            || !self.post_roll_seconds.is_finite()
            || self.pre_roll_seconds < 0.0
            || self.post_roll_seconds < 0.0
            || self.pre_roll_seconds > 60.0
            || self.post_roll_seconds > 60.0
        {
            return Err(DomainError::InvalidInput(
                "pre-roll and post-roll must be finite values from 0 to 60 seconds".to_owned(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentPlanShot {
    pub id: Uuid,
    pub title: String,
    pub kind: HlaeCameraStyle,
    pub view: AgentShotView,
    pub start_tick: u64,
    pub end_tick: u64,
    pub duration_seconds: f64,
    pub rationale: String,
    pub evidence_refs: Vec<String>,
    pub risks: Vec<String>,
    pub source: AgentPlanAuthor,
    /// Present while a shot is soft-removed by the user; the removal stays
    /// undoable instead of dropping the shot from the plan.
    pub removed_by: Option<AgentPlanAuthor>,
    pub params: serde_json::Value,
    /// The footage this shot will be captured from, once it has one.
    ///
    /// Optional because a plan is meaningful before it is bound: the Agent
    /// designs the shots first and lands them on material afterwards, and an
    /// unbound plan must stay editable rather than being rejected at write
    /// time. `#[serde(default)]` is what lets every `shots_json` document
    /// written before this field existed keep decoding, which matters because
    /// the schema is a fingerprinted whole with no migration step.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub recording: Option<AgentShotRecording>,
}

impl AgentPlanShot {
    /// Normalizes shot text and validates its bounded window.
    ///
    /// A shot that carries a recording binding is additionally held to
    /// everything [`RecordingRequest::validate`] demands - notably a strictly
    /// positive tick window, where an unbound shot may still be a zero-length
    /// placeholder. A bound shot claims to be recordable, so it has to be.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the tick window, duration,
    /// text or reference lists are outside the current contract, or when the
    /// recording binding cannot produce a valid [`RecordingRequest`].
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        self.title = required_text(&self.title, AGENT_SESSION_MAX_LABEL_CHARS, "shot title")?;
        self.rationale = optional_text(
            &self.rationale,
            AGENT_SESSION_MAX_SUMMARY_CHARS,
            "shot rationale",
        )?;
        if self.end_tick < self.start_tick {
            return Err(DomainError::InvalidInput(
                "shot end_tick must not precede start_tick".to_owned(),
            ));
        }
        if !self.duration_seconds.is_finite() || self.duration_seconds < 0.0 {
            return Err(DomainError::InvalidInput(
                "shot duration_seconds must be a finite non-negative number".to_owned(),
            ));
        }
        if self.evidence_refs.len() > AGENT_PLAN_MAX_EVIDENCE_REFS {
            return Err(DomainError::InvalidInput(format!(
                "a shot may carry at most {AGENT_PLAN_MAX_EVIDENCE_REFS} evidence references"
            )));
        }
        if self.risks.len() > AGENT_PLAN_MAX_RISKS {
            return Err(DomainError::InvalidInput(format!(
                "a shot may carry at most {AGENT_PLAN_MAX_RISKS} risks"
            )));
        }
        if !self.params.is_object() {
            return Err(DomainError::InvalidInput(
                "shot params must be a JSON object".to_owned(),
            ));
        }
        self.evidence_refs = self
            .evidence_refs
            .iter()
            .map(|value| required_text(value, AGENT_SESSION_MAX_LABEL_CHARS, "evidence reference"))
            .collect::<Result<Vec<_>, _>>()?;
        self.risks = self
            .risks
            .iter()
            .map(|value| required_text(value, AGENT_SESSION_MAX_SUMMARY_CHARS, "risk"))
            .collect::<Result<Vec<_>, _>>()?;
        self.recording = self
            .recording
            .map(AgentShotRecording::normalize)
            .transpose()?;
        if let Some(recording) = &self.recording {
            self.to_recording_request(Uuid::nil(), recording)?;
        }
        Ok(self)
    }

    /// Assembles the recording request for this shot.
    ///
    /// This is the single place a plan becomes a capture queue item. It exists
    /// in the domain, next to both halves, so the mapping cannot be written a
    /// second time in a route: `camera_style` comes from [`Self::kind`], the
    /// tick window and title from the shot, and everything else from the typed
    /// binding.
    ///
    /// `request_id` is supplied by the caller because it is the durable
    /// identity a failed job proves its published prefix against
    /// ([`crate::RecordingJob::retryable_suffix`]); it belongs to the queue,
    /// not to the plan.
    ///
    /// Soft-removed shots are not filtered here - `removed_by` is a plan-level
    /// fact and the caller decides whether a removed shot belongs in the queue.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when this shot has no recording
    /// binding, or when the assembled request fails
    /// [`RecordingRequest::validate`].
    pub fn recording_request(&self, request_id: Uuid) -> Result<RecordingRequest, DomainError> {
        let recording = self.recording.as_ref().ok_or_else(|| {
            DomainError::InvalidInput(format!(
                "plan shot {} is not bound to a Demo and a player yet",
                self.id
            ))
        })?;
        self.to_recording_request(request_id, recording)
    }

    fn to_recording_request(
        &self,
        request_id: Uuid,
        recording: &AgentShotRecording,
    ) -> Result<RecordingRequest, DomainError> {
        let request = RecordingRequest {
            id: Some(request_id),
            demo_id: recording.demo_id,
            highlight_id: recording.highlight_id.clone(),
            player_id: recording.player_id.clone(),
            title: self.title.clone(),
            start_tick: self.start_tick,
            end_tick: self.end_tick,
            pre_roll_seconds: recording.pre_roll_seconds,
            post_roll_seconds: recording.post_roll_seconds,
            victim_pov: recording.victim_pov,
            camera_style: self.kind,
            presentation: recording.presentation,
        };
        request.validate()?;
        Ok(request)
    }
}

/// One entry of a plan's change-origin trail: which session changed it, when,
/// and what changed. Ordered newest first for presentation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentPlanOrigin {
    pub at: DateTime<Utc>,
    pub session_id: Uuid,
    /// The session title captured at edit time. It survives session deletion.
    pub session_title: String,
    pub summary: String,
}

/// The immutable Agent version of a plan, kept so a user edit can always be
/// reverted to what the Agent originally produced.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentPlanBaseline {
    pub revision: i64,
    pub captured_at: DateTime<Utc>,
    pub shots: Vec<AgentPlanShot>,
}

/// A plan. `revision` is server-authoritative and strictly increasing: it is the
/// only fact that decides whether an outstanding Agent proposal still applies.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentPlan {
    pub id: Uuid,
    pub title: String,
    pub status: AgentPlanStatus,
    pub revision: i64,
    /// When the user asked not to be shown this plan again until.
    ///
    /// 「稍后处理」 on the workbench. Distinct from `Archived`, which is the
    /// permanent 「不做了」 — a snoozed plan is still awaiting confirmation and
    /// comes back on its own.
    ///
    /// An instant rather than a flag, and computed by the client: 「今天不再
    /// 提醒」 means the user's next local midnight, and the service does not
    /// know their timezone. Storing the instant means a plan snoozed at 23:50
    /// is back ten minutes later, which is what the words say.
    #[ts(optional = nullable)]
    pub snoozed_until: Option<DateTime<Utc>>,
    pub shots: Vec<AgentPlanShot>,
    pub origin: Vec<AgentPlanOrigin>,
    pub agent_baseline: AgentPlanBaseline,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentPlanCreate {
    pub title: String,
    pub status: AgentPlanStatus,
    pub shots: Vec<AgentPlanShot>,
    /// The session that produced the first version, when the plan came from one.
    pub origin: Option<AgentPlanOriginDraft>,
}

impl AgentPlanCreate {
    /// Normalizes the initial plan.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the title, shots or origin are
    /// outside the current contract.
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        self.title = required_text(&self.title, AGENT_SESSION_MAX_LABEL_CHARS, "plan title")?;
        self.shots = normalize_shots(self.shots)?;
        self.origin = self
            .origin
            .map(AgentPlanOriginDraft::normalize)
            .transpose()?;
        Ok(self)
    }
}

/// The caller-supplied part of an origin entry; the timestamp is server-owned.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentPlanOriginDraft {
    pub session_id: Uuid,
    pub session_title: String,
    pub summary: String,
}

impl AgentPlanOriginDraft {
    /// Normalizes the origin presentation text.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the title or summary is out of
    /// bounds.
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        self.session_title = required_text(
            &self.session_title,
            AGENT_SESSION_MAX_TITLE_CHARS,
            "session title",
        )?;
        self.summary = required_text(&self.summary, AGENT_SESSION_MAX_SUMMARY_CHARS, "summary")?;
        Ok(self)
    }
}

/// One manual edit of a plan. `expected_revision` makes the write conditional so
/// two sessions editing the same plan cannot silently overwrite each other.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentPlanEdit {
    pub plan_id: Uuid,
    pub expected_revision: i64,
    pub status: AgentPlanStatus,
    pub shots: Vec<AgentPlanShot>,
    pub origin: AgentPlanOriginDraft,
    /// The differences reported to the Agent as one workspace edit notice.
    pub changes: Vec<WorkspaceEditChange>,
    pub note: Option<String>,
}

impl AgentPlanEdit {
    /// Normalizes the edit and its notice payload.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the revision, shots, origin,
    /// changes or note are outside the current contract.
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        if self.expected_revision < 1 {
            return Err(DomainError::InvalidInput(
                "expected_revision must be greater than zero".to_owned(),
            ));
        }
        self.shots = normalize_shots(self.shots)?;
        self.origin = self.origin.normalize()?;
        if self.changes.len() > WORKSPACE_EDIT_MAX_CHANGES {
            return Err(DomainError::InvalidInput(format!(
                "a workspace edit may report at most {WORKSPACE_EDIT_MAX_CHANGES} changes"
            )));
        }
        self.changes = self
            .changes
            .into_iter()
            .map(WorkspaceEditChange::normalize)
            .collect::<Result<Vec<_>, _>>()?;
        self.note = normalize_optional_note(self.note)?;
        Ok(self)
    }
}

/// A revert of the plan to its immutable Agent baseline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentPlanRestore {
    pub plan_id: Uuid,
    pub expected_revision: i64,
    pub origin: AgentPlanOriginDraft,
    pub note: Option<String>,
}

impl AgentPlanRestore {
    /// Normalizes the restore request.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the revision, origin or note
    /// is outside the current contract.
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        if self.expected_revision < 1 {
            return Err(DomainError::InvalidInput(
                "expected_revision must be greater than zero".to_owned(),
            ));
        }
        self.origin = self.origin.normalize()?;
        self.note = normalize_optional_note(self.note)?;
        Ok(self)
    }
}

/// Outcome of a conditional plan write.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub enum AgentPlanUpdate {
    Updated { plan: Box<AgentPlan> },
    Conflict { current_revision: i64 },
    NotFound,
}

/// How long Agent conversations are kept. Deleting a session by policy removes
/// the conversation only; generated videos and task records are untouched.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case", tag = "mode")]
#[ts(export)]
pub enum AgentSessionRetention {
    /// Keep every session.
    #[default]
    All,
    /// Keep the most recently updated `count` sessions.
    RecentCount { count: u32 },
    /// Keep sessions updated within the last `days` days.
    MaxAgeDays { days: u32 },
    /// Keep nothing.
    None,
}

impl AgentSessionRetention {
    /// Validates the bounded retention contract.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when a count or age is out of range.
    pub fn validate(&self) -> Result<(), DomainError> {
        match *self {
            Self::All | Self::None => Ok(()),
            Self::RecentCount { count } => {
                if (1..=AGENT_SESSION_RETENTION_MAX_COUNT).contains(&count) {
                    Ok(())
                } else {
                    Err(DomainError::InvalidInput(format!(
                        "retention count must be between 1 and {AGENT_SESSION_RETENTION_MAX_COUNT}"
                    )))
                }
            }
            Self::MaxAgeDays { days } => {
                if (1..=AGENT_SESSION_RETENTION_MAX_DAYS).contains(&days) {
                    Ok(())
                } else {
                    Err(DomainError::InvalidInput(format!(
                        "retention age must be between 1 and {AGENT_SESSION_RETENTION_MAX_DAYS} days"
                    )))
                }
            }
        }
    }
}

/// How the Agent writes its commentary. The 「点评语气」 row of the settings
/// artboard, which offers exactly these two.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CommentaryTone {
    /// Measured and factual — the default, because it is the one that does not
    /// put words in a player's mouth.
    #[default]
    Professional,
    /// Broadcast-style, the register a caster would use.
    Broadcast,
}

/// Agent workspace settings. Persisted separately from [`crate::AppConfig`] so
/// the existing configuration contract stays unchanged.
///
/// The five switches below are the ones the 「设置 · AI 与 Agent」 artboard draws
/// under 会话 and 行为边界. One thing it draws is deliberately *not* here:
/// 「录制前始终由你确认」 is documented on that board as 「不可关闭」, so it is a
/// constant of the product rather than a field. A boolean nobody may set to
/// false is a boolean that will eventually be set to false.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentWorkspaceSettings {
    pub session_retention: AgentSessionRetention,
    /// Takes retained per session. A take that was used in a composition is
    /// never discarded by this ceiling.
    pub take_limit: u32,
    /// Prefill a new session's context with whatever Demo and player are
    /// selected. 「影响：新建会话时上下文是否预填，随时可手动改」.
    pub auto_attach_context: bool,
    /// Show a preview before an accepted edit change is written to the project.
    /// 「关闭后，接受变更会直接改工程，仍可撤销」 — so this is about a
    /// confirmation step, not about whether the edit is reversible.
    pub preview_before_apply: bool,
    /// Expand which rounds and events the Agent read, inside 工作进度.
    pub show_evidence_reads: bool,
    /// The length the Agent aims a finished cut at, in seconds. A target, not a
    /// constraint: a plan that needs 44 seconds is not truncated to fit.
    pub default_video_seconds: u32,
    /// The view a shot starts with when nothing decided it.
    ///
    /// Shots are handed over from Agent proposals one at a time, and the view
    /// is a creative choice the proposal does not carry — so the handover has
    /// to pick one. It used to pick `observer` in the client's own code. This
    /// is the same decision, stored, which is what the settings row 「默认视角」
    /// describes: the fallback, not a per-shot setting. The shot inspector
    /// still changes it per shot.
    pub default_shot_view: AgentShotView,
    pub commentary_tone: CommentaryTone,
}

impl Default for AgentWorkspaceSettings {
    fn default() -> Self {
        Self {
            session_retention: AgentSessionRetention::default(),
            take_limit: AGENT_TAKE_LIMIT_DEFAULT,
            // Each default is the artboard's own drawn state.
            auto_attach_context: true,
            preview_before_apply: true,
            show_evidence_reads: true,
            default_video_seconds: AGENT_VIDEO_SECONDS_DEFAULT,
            // The artboard's drawn state, and what the handover hard-coded.
            default_shot_view: AgentShotView::Observer,
            commentary_tone: CommentaryTone::Professional,
        }
    }
}

impl AgentWorkspaceSettings {
    /// Validates the bounded settings contract.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the retention policy or take
    /// ceiling is out of range.
    pub fn validate(&self) -> Result<(), DomainError> {
        self.session_retention.validate()?;
        if !(AGENT_TAKE_LIMIT_MIN..=AGENT_TAKE_LIMIT_MAX).contains(&self.take_limit) {
            return Err(DomainError::InvalidInput(format!(
                "take_limit must be between {AGENT_TAKE_LIMIT_MIN} and {AGENT_TAKE_LIMIT_MAX}"
            )));
        }
        if !(AGENT_VIDEO_SECONDS_MIN..=AGENT_VIDEO_SECONDS_MAX)
            .contains(&self.default_video_seconds)
        {
            return Err(DomainError::InvalidInput(format!(
                "default_video_seconds must be between {AGENT_VIDEO_SECONDS_MIN} and {AGENT_VIDEO_SECONDS_MAX}"
            )));
        }
        Ok(())
    }
}

/// A plan row for list views: the head facts without the shot bodies. It is the
/// shape the "in progress" reference picker and the plan directory read.
// `Eq` is gone with the arrival of a duration: `f64` has no total equality, and
// a summary is compared in tests rather than used as a key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentPlanSummary {
    pub id: Uuid,
    pub title: String,
    pub status: AgentPlanStatus,
    pub revision: i64,
    /// Shots that are still in the plan, soft-removed ones excluded.
    ///
    /// A removed shot stays in the document so the removal can be undone, and
    /// each consumer decides whether it counts — the recording route excludes
    /// it, and so does the plan strip. This count is what a list row shows a
    /// person, so it has to agree with the page they open next.
    pub shot_count: u32,
    /// Mirrors [`AgentPlan::snoozed_until`], so a list can hide what the user
    /// pushed away without fetching every plan.
    #[ts(optional = nullable)]
    pub snoozed_until: Option<DateTime<Utc>>,
    /// The plan's length, as the sum of what `shot_count` counted.
    ///
    /// On the summary rather than derived by the client: the whole point of a
    /// summary is that it omits the shot bodies, so a list of ten plans would
    /// otherwise need ten more requests to print one number per row.
    pub total_duration_seconds: f64,
    pub origin_count: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Bounded plan list query.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentPlanQuery {
    #[ts(optional)]
    pub status: Option<AgentPlanStatus>,
    #[ts(optional)]
    pub limit: Option<u32>,
}

impl AgentPlanQuery {
    /// Validates the bounded limit contract.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the limit is out of range.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self
            .limit
            .is_some_and(|limit| !(1..=AGENT_PLAN_MAX_LIMIT).contains(&limit))
        {
            return Err(DomainError::InvalidInput(format!(
                "limit must be between 1 and {AGENT_PLAN_MAX_LIMIT}"
            )));
        }
        Ok(())
    }

    #[must_use]
    pub fn effective_limit(&self) -> u32 {
        self.limit
            .unwrap_or(AGENT_PLAN_DEFAULT_LIMIT)
            .clamp(1, AGENT_PLAN_MAX_LIMIT)
    }
}

/// What the Agent conversation layer occupies locally.
///
/// The byte figures cover the conversation rows only - the plans, recording
/// tasks, editor projects and outputs a session touched are counted separately
/// because clearing conversations never removes them.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionStorageStats {
    pub session_count: u64,
    pub entry_count: u64,
    pub object_ref_count: u64,
    pub plan_count: u64,
    pub plan_origin_count: u64,
    /// Bytes held by sessions, their entries and their reference rows.
    pub conversation_bytes: u64,
    /// Bytes held by plans and their origin trails. Not removed by a clear.
    pub plan_bytes: u64,
    pub oldest_session_at: Option<DateTime<Utc>>,
    pub newest_session_at: Option<DateTime<Utc>>,
}

/// A portable dump of the Agent conversation layer, used by the settings pane's
/// export action. Plans are excluded: they outlive the conversations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionExport {
    pub exported_at: DateTime<Utc>,
    pub settings: AgentWorkspaceSettings,
    pub sessions: Vec<AgentSession>,
}

/// Outcome of a retention sweep or a manual clear. Only conversations are
/// counted, because only conversations are removed.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionPurge {
    pub removed_sessions: u64,
}

/// Normalizes a session title, falling back to the untitled placeholder.
///
/// # Errors
///
/// Returns [`DomainError::InvalidInput`] when the title exceeds its bound.
pub fn normalize_session_title(value: &str) -> Result<String, DomainError> {
    let value = value.trim();
    if value.chars().count() > AGENT_SESSION_MAX_TITLE_CHARS {
        return Err(DomainError::InvalidInput(format!(
            "session title must contain at most {AGENT_SESSION_MAX_TITLE_CHARS} characters"
        )));
    }
    Ok(value.to_owned())
}

fn normalize_shots(shots: Vec<AgentPlanShot>) -> Result<Vec<AgentPlanShot>, DomainError> {
    if shots.len() > AGENT_PLAN_MAX_SHOTS {
        return Err(DomainError::InvalidInput(format!(
            "a plan may contain at most {AGENT_PLAN_MAX_SHOTS} shots"
        )));
    }
    let mut unique = HashSet::with_capacity(shots.len());
    let mut normalized = Vec::with_capacity(shots.len());
    for shot in shots {
        if !unique.insert(shot.id) {
            return Err(DomainError::InvalidInput(
                "plan shot identities must be unique".to_owned(),
            ));
        }
        normalized.push(shot.normalize()?);
    }
    Ok(normalized)
}

fn normalize_optional_note(note: Option<String>) -> Result<Option<String>, DomainError> {
    let Some(note) = note else {
        return Ok(None);
    };
    let note = note.trim();
    if note.is_empty() {
        return Ok(None);
    }
    if note.chars().count() > WORKSPACE_EDIT_MAX_NOTE_CHARS {
        return Err(DomainError::InvalidInput(format!(
            "note must contain at most {WORKSPACE_EDIT_MAX_NOTE_CHARS} characters"
        )));
    }
    Ok(Some(note.to_owned()))
}

fn normalize_optional_value(
    value: Option<String>,
    field: &str,
) -> Result<Option<String>, DomainError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > WORKSPACE_EDIT_MAX_VALUE_CHARS {
        return Err(DomainError::InvalidInput(format!(
            "{field} must contain at most {WORKSPACE_EDIT_MAX_VALUE_CHARS} characters"
        )));
    }
    Ok(Some(value.to_owned()))
}

fn required_text(value: &str, max: usize, field: &str) -> Result<String, DomainError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(DomainError::InvalidInput(format!(
            "{field} must contain 1 to {max} characters"
        )));
    }
    Ok(value.to_owned())
}

fn optional_text(value: &str, max: usize, field: &str) -> Result<String, DomainError> {
    let value = value.trim();
    if value.chars().count() > max {
        return Err(DomainError::InvalidInput(format!(
            "{field} must contain at most {max} characters"
        )));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shot(title: &str) -> AgentPlanShot {
        AgentPlanShot {
            id: Uuid::new_v4(),
            title: title.to_owned(),
            kind: HlaeCameraStyle::Tracking,
            view: AgentShotView::Observer,
            start_tick: 148_812,
            end_tick: 149_132,
            duration_seconds: 5.0,
            rationale: "Follow the entry".to_owned(),
            evidence_refs: vec!["demo:match/event:kill-7".to_owned()],
            risks: vec!["no collision geometry".to_owned()],
            source: AgentPlanAuthor::Agent,
            removed_by: None,
            params: serde_json::json!({}),
            recording: None,
        }
    }

    fn binding() -> AgentShotRecording {
        AgentShotRecording {
            demo_id: Uuid::new_v4(),
            player_id: "76561198000000000".to_owned(),
            highlight_id: Some("demo:match/event:kill-7".to_owned()),
            victim_pov: false,
            pre_roll_seconds: 1.5,
            post_roll_seconds: 1.0,
            presentation: None,
        }
    }

    #[test]
    fn session_entries_have_exactly_three_kinds_and_only_two_are_bubbles() {
        let user = AgentSessionEntry::User {
            id: Uuid::new_v4(),
            at: Utc::now(),
            content: "把它压到 30 秒以内".to_owned(),
        };
        let workspace_edit = AgentSessionEntry::WorkspaceEdit {
            id: Uuid::new_v4(),
            at: Utc::now(),
            notice: WorkspaceEditNotice {
                object: AgentObjectLocator {
                    kind: AgentObjectKind::Plan,
                    id: Uuid::new_v4(),
                },
                revision: 7,
                by: WorkspaceEditAuthor::User,
                at: Utc::now(),
                changes: vec![WorkspaceEditChange {
                    shot: 2,
                    op: WorkspaceEditOperation::Updated,
                    field: Some("duration".to_owned()),
                    from: Some("8.5s".to_owned()),
                    to: Some("5.0s".to_owned()),
                }],
                note: Some("起手那段留给建立镜头交代".to_owned()),
            },
        };

        assert_eq!(user.kind(), "user");
        assert_eq!(workspace_edit.kind(), "workspace_edit");

        let encoded = serde_json::to_value(&workspace_edit).expect("encode entry");
        assert_eq!(encoded["kind"], "workspace_edit");
        assert_eq!(encoded["notice"]["revision"], 7);
        assert_eq!(encoded["notice"]["by"], "user");
        assert_eq!(
            serde_json::from_value::<AgentSessionEntry>(encoded).expect("decode entry"),
            workspace_edit
        );

        // A client can never author a workspace edit entry.
        assert!(
            serde_json::from_value::<AgentSessionEntryDraft>(serde_json::json!({
                "kind": "workspace_edit",
                "notice": {}
            }))
            .is_err()
        );
    }

    #[test]
    fn proposal_is_stale_only_against_a_newer_revision_of_its_own_plan() {
        let plan_id = Uuid::new_v4();
        let proposal = AgentProposal {
            kind: "video_render".to_owned(),
            title: "压到 30 秒".to_owned(),
            plan_id: Some(plan_id),
            based_on_revision: Some(6),
            payload: serde_json::json!({}),
        };

        proposal.validate().expect("valid proposal");
        assert!(proposal.is_stale(plan_id, 7));
        assert!(!proposal.is_stale(plan_id, 6));
        assert!(!proposal.is_stale(Uuid::new_v4(), 7));

        let half_bound = AgentProposal {
            based_on_revision: None,
            ..proposal
        };
        assert!(half_bound.validate().is_err());
    }

    #[test]
    fn workspace_edit_changes_require_a_field_and_target_when_updating() {
        assert!(
            WorkspaceEditChange {
                shot: 2,
                op: WorkspaceEditOperation::Updated,
                field: None,
                from: None,
                to: Some("5.0s".to_owned()),
            }
            .normalize()
            .is_err()
        );
        assert!(
            WorkspaceEditChange {
                shot: 4,
                op: WorkspaceEditOperation::Removed,
                field: None,
                from: None,
                to: None,
            }
            .normalize()
            .is_ok()
        );
        assert!(
            WorkspaceEditChange {
                shot: 0,
                op: WorkspaceEditOperation::Removed,
                field: None,
                from: None,
                to: None,
            }
            .normalize()
            .is_err()
        );
    }

    #[test]
    fn plan_edits_reject_duplicate_shots_and_non_positive_revisions() {
        let duplicate = shot("02 跟随突破");
        let edit = AgentPlanEdit {
            plan_id: Uuid::new_v4(),
            expected_revision: 6,
            status: AgentPlanStatus::AwaitingConfirmation,
            shots: vec![duplicate.clone(), duplicate],
            origin: AgentPlanOriginDraft {
                session_id: Uuid::new_v4(),
                session_title: "Kael 的 1v3".to_owned(),
                summary: "镜头 02 由 8.5 秒改为 5.0 秒".to_owned(),
            },
            changes: Vec::new(),
            note: None,
        };
        assert!(edit.clone().normalize().is_err());

        let zero_revision = AgentPlanEdit {
            expected_revision: 0,
            shots: vec![shot("02 跟随突破")],
            ..edit
        };
        assert!(zero_revision.normalize().is_err());
    }

    #[test]
    fn retention_policy_and_take_ceiling_are_bounded() {
        for policy in [
            AgentSessionRetention::All,
            AgentSessionRetention::RecentCount {
                count: AGENT_SESSION_RETENTION_DEFAULT_COUNT,
            },
            AgentSessionRetention::MaxAgeDays {
                days: AGENT_SESSION_RETENTION_DEFAULT_DAYS,
            },
            AgentSessionRetention::None,
        ] {
            AgentWorkspaceSettings {
                session_retention: policy,
                take_limit: AGENT_TAKE_LIMIT_DEFAULT,
                ..AgentWorkspaceSettings::default()
            }
            .validate()
            .expect("current retention policy");
        }

        assert!(
            AgentWorkspaceSettings {
                session_retention: AgentSessionRetention::RecentCount { count: 0 },
                take_limit: AGENT_TAKE_LIMIT_DEFAULT,
                ..AgentWorkspaceSettings::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            AgentWorkspaceSettings {
                session_retention: AgentSessionRetention::All,
                take_limit: AGENT_TAKE_LIMIT_MAX + 1,
                ..AgentWorkspaceSettings::default()
            }
            .validate()
            .is_err()
        );

        let encoded = serde_json::to_value(AgentWorkspaceSettings::default()).expect("encode");
        assert_eq!(encoded["session_retention"]["mode"], "all");
        assert_eq!(encoded["take_limit"], AGENT_TAKE_LIMIT_DEFAULT);
    }

    #[test]
    fn an_unbound_plan_shot_stays_readable_and_decodable() {
        let shot = shot("01 建立地点");
        assert_eq!(shot.recording, None);

        let wire = serde_json::to_value(&shot).expect("shot wire");
        assert_eq!(wire["recording"], serde_json::Value::Null);

        // Documents written before the binding existed keep decoding: the
        // schema is a fingerprinted whole with no migration step.
        let mut legacy = wire;
        legacy
            .as_object_mut()
            .expect("shot object")
            .remove("recording");
        assert_eq!(
            serde_json::from_value::<AgentPlanShot>(legacy)
                .expect("a shot document written before the binding existed")
                .recording,
            None
        );

        assert!(
            shot.recording_request(Uuid::new_v4()).is_err(),
            "an unbound shot cannot name a Demo or a player"
        );
    }

    #[test]
    fn a_bound_shot_assembles_its_recording_request_from_the_shot_itself() {
        let bound = AgentPlanShot {
            recording: Some(binding()),
            ..shot("02 跟随突破")
        }
        .normalize()
        .expect("a valid binding");
        let recording = bound.recording.clone().expect("binding");
        let request_id = Uuid::new_v4();
        let request = bound
            .recording_request(request_id)
            .expect("bound shots become queue items");

        assert_eq!(request.id, Some(request_id));
        assert_eq!(request.demo_id, recording.demo_id);
        assert_eq!(request.player_id, recording.player_id);
        assert_eq!(request.highlight_id, recording.highlight_id);
        // The three fields the binding deliberately does not duplicate.
        assert_eq!(request.camera_style, bound.kind);
        assert_eq!(request.start_tick, bound.start_tick);
        assert_eq!(request.end_tick, bound.end_tick);
        assert_eq!(request.title, bound.title);
    }

    #[test]
    fn a_binding_is_rejected_before_it_can_reach_the_capture_pipeline() {
        for player_id in [
            String::new(),
            "7656119800000000".to_owned(),
            "765611980000000000".to_owned(),
            "STEAM_1:1:12345678".to_owned(),
            "0".repeat(17),
        ] {
            assert!(
                AgentShotRecording {
                    player_id,
                    ..binding()
                }
                .normalize()
                .is_err()
            );
        }
        for (pre, post) in [(-1.0, 0.0), (0.0, 60.1), (f64::NAN, 0.0)] {
            assert!(
                AgentShotRecording {
                    pre_roll_seconds: pre,
                    post_roll_seconds: post,
                    ..binding()
                }
                .normalize()
                .is_err()
            );
        }

        // A cinematic shot cannot be bound to a victim point of view, and the
        // shot's own kind is what decides that - not a second copy.
        assert!(
            AgentPlanShot {
                kind: HlaeCameraStyle::Tracking,
                recording: Some(AgentShotRecording {
                    victim_pov: true,
                    ..binding()
                }),
                ..shot("02 跟随突破")
            }
            .normalize()
            .is_err()
        );
        AgentPlanShot {
            kind: HlaeCameraStyle::Pov,
            recording: Some(AgentShotRecording {
                victim_pov: true,
                ..binding()
            }),
            ..shot("03 选手 POV · 三杀")
        }
        .normalize()
        .expect("victim POV belongs to a POV shot");

        // An observer shot cannot carry a field of view the camera path would
        // override, and that is checked while the plan is still on screen.
        assert!(
            AgentPlanShot {
                kind: HlaeCameraStyle::Crane,
                recording: Some(AgentShotRecording {
                    presentation: Some(crate::RecordingPresentation {
                        camera_fov: 110.0,
                        ..crate::RecordingPresentation::default()
                    }),
                    ..binding()
                }),
                ..shot("04 高潮后升起")
            }
            .normalize()
            .is_err()
        );

        // A bound shot must have a recordable window.
        assert!(
            AgentPlanShot {
                start_tick: 148_812,
                end_tick: 148_812,
                recording: Some(binding()),
                ..shot("00 零长度")
            }
            .normalize()
            .is_err()
        );
    }

    #[test]
    fn object_reference_kinds_round_trip_through_their_persisted_text() {
        for kind in [
            AgentObjectKind::Plan,
            AgentObjectKind::RecordingTask,
            AgentObjectKind::EditProject,
            AgentObjectKind::Output,
        ] {
            assert_eq!(AgentObjectKind::from_str_exact(kind.as_str()), Some(kind));
        }
        assert_eq!(AgentObjectKind::from_str_exact("demo"), None);
    }
}
