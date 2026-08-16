use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RewriteError;

/// Full serializer path for the stable item account identifier.
pub const ACCOUNT_ID_PATH: &str = "m_AttributeManager.m_Item.m_iAccountID";
/// Full serializer path for the item definition identifier.
pub const ITEM_DEFINITION_PATH: &str = "m_AttributeManager.m_Item.m_iItemDefinitionIndex";
/// Full serializer path for the low half of the original owner's Steam64 ID.
pub const ORIGINAL_OWNER_LOW_PATH: &str = "m_AttributeManager.m_Item.m_OriginalOwnerXuidLow";
/// Full serializer path for the high half of the original owner's Steam64 ID.
pub const ORIGINAL_OWNER_HIGH_PATH: &str = "m_AttributeManager.m_Item.m_OriginalOwnerXuidHigh";

/// Stable player identity used for ownership matching.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct StablePlayerIdentity {
    /// 64-bit Steam identity.
    ///
    /// A decimal **string** on the wire: `u64_string` serializes it that way
    /// because Steam64 values exceed JavaScript's safe integer range. ts-rs
    /// cannot read a `serde(with = ...)` module, so the wire type is restated
    /// here.
    #[serde(with = "u64_string")]
    #[ts(as = "String")]
    pub steam_id64: u64,
    /// Stable 32-bit account component. It must equal the low 32 bits of
    /// `steam_id64`.
    pub account_id: u32,
}

mod u64_string {
    use serde::{Deserialize, Deserializer, Serializer};

    #[allow(
        clippy::trivially_copy_pass_by_ref,
        reason = "serde with-module signature"
    )]
    pub(super) fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub(super) fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

impl StablePlayerIdentity {
    /// Constructs and validates a stable identity.
    ///
    /// # Errors
    ///
    /// Returns [`RewriteError::InvalidRequest`] when either component is zero
    /// or the account component is inconsistent with the Steam64 value.
    pub fn new(steam_id64: u64, account_id: u32) -> Result<Self, RewriteError> {
        let identity = Self {
            steam_id64,
            account_id,
        };
        identity.validate()?;
        Ok(identity)
    }

    pub(crate) fn validate(self) -> Result<(), RewriteError> {
        if self.steam_id64 >> 32 == 0 {
            return Err(RewriteError::invalid(
                "steam_id64 must contain a non-zero Steam identity prefix",
            ));
        }
        if self.account_id == 0 {
            return Err(RewriteError::invalid("account_id must be non-zero"));
        }
        if self.steam_id64 & u64::from(u32::MAX) != u64::from(self.account_id) {
            return Err(RewriteError::invalid(
                "account_id must equal the low 32 bits of steam_id64",
            ));
        }
        Ok(())
    }
}

/// Item selection for one cosmetic patch.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CosmeticTarget {
    /// Stable owner identity.
    pub owner: StablePlayerIdentity,
    /// Optional exact item definition filter. `None` selects any item owned by
    /// the player, so it cannot overlap another patch for that owner.
    pub item_definition_index: Option<u16>,
}

/// Values that may replace existing, recognized cosmetic fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CosmeticValues {
    /// Paint kit identifier. Zero is permitted to clear a fallback value.
    pub paint_kit: Option<u32>,
    /// Pattern seed in the game-supported range 0..=1000.
    pub seed: Option<u32>,
    /// Exterior wear in the normalized range 0.0..=1.0.
    pub wear: Option<f32>,
    /// `StatTrak` counter.
    pub stat_trak: Option<u32>,
}

impl CosmeticValues {
    pub(crate) fn is_empty(&self) -> bool {
        self.paint_kit.is_none()
            && self.seed.is_none()
            && self.wear.is_none()
            && self.stat_trak.is_none()
    }

    pub(crate) fn requested(&self, field: CosmeticField) -> bool {
        match field {
            CosmeticField::PaintKit => self.paint_kit.is_some(),
            CosmeticField::Seed => self.seed.is_some(),
            CosmeticField::Wear => self.wear.is_some(),
            CosmeticField::StatTrak => self.stat_trak.is_some(),
        }
    }
}

/// One stable-target cosmetic patch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CosmeticPatch {
    /// Stable owner and optional item filter.
    pub target: CosmeticTarget,
    /// Existing fields to replace.
    pub values: CosmeticValues,
}

/// Batch rewrite request. Non-overlapping patches are applied in one pass.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RewriteRequest {
    /// Patches to apply.
    pub patches: Vec<CosmeticPatch>,
}

impl RewriteRequest {
    /// Validates identity consistency, values, and non-overlapping targets.
    ///
    /// # Errors
    ///
    /// Returns [`RewriteError`] when the request is empty, ambiguous, outside
    /// a value range, or exceeds a configured limit.
    pub fn validate(&self, limits: &RewriteLimits) -> Result<(), RewriteError> {
        limits.validate()?;
        if self.patches.is_empty() {
            return Err(RewriteError::invalid("at least one patch is required"));
        }
        if self.patches.len() as u64 > limits.max_patches {
            return Err(RewriteError::LimitExceeded {
                kind: LimitKind::Patches,
                limit: limits.max_patches,
                observed: self.patches.len() as u64,
            });
        }

        for (index, patch) in self.patches.iter().enumerate() {
            patch.target.owner.validate()?;
            if patch.target.item_definition_index == Some(0) {
                return Err(RewriteError::invalid(format!(
                    "patch {index} item_definition_index must be non-zero"
                )));
            }
            if patch.values.is_empty() {
                return Err(RewriteError::invalid(format!(
                    "patch {index} does not request any cosmetic field"
                )));
            }
            if patch.values.seed.is_some_and(|seed| seed > 1000) {
                return Err(RewriteError::invalid(format!(
                    "patch {index} seed must be in 0..=1000"
                )));
            }
            if patch
                .values
                .wear
                .is_some_and(|wear| !wear.is_finite() || !(0.0..=1.0).contains(&wear))
            {
                return Err(RewriteError::invalid(format!(
                    "patch {index} wear must be finite and in 0.0..=1.0"
                )));
            }
        }

        for left in 0..self.patches.len() {
            for right in left + 1..self.patches.len() {
                let left_target = self.patches[left].target;
                let right_target = self.patches[right].target;
                if left_target.owner == right_target.owner
                    && (left_target.item_definition_index.is_none()
                        || right_target.item_definition_index.is_none()
                        || left_target.item_definition_index == right_target.item_definition_index)
                {
                    return Err(RewriteError::invalid(format!(
                        "patches {left} and {right} have overlapping targets"
                    )));
                }
            }
        }

        Ok(())
    }
}

/// Resource counter controlled by a rewrite limit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LimitKind {
    /// Input file bytes.
    InputBytes,
    /// Output file bytes.
    OutputBytes,
    /// Outer Source 2 demo messages.
    DemoMessages,
    /// Entity create/update/delete entries.
    EntityUpdates,
    /// Distinct entity handles observed while rewriting.
    DistinctEntities,
    /// Patches in one request.
    Patches,
}

/// Bounds for file handling and parser work.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RewriteLimits {
    /// Maximum input file size.
    pub max_input_bytes: u64,
    /// Maximum staged output size.
    pub max_output_bytes: u64,
    /// Maximum outer demo messages.
    pub max_demo_messages: u64,
    /// Maximum packet entity updates.
    pub max_entity_updates: u64,
    /// Maximum distinct entity handles.
    pub max_distinct_entities: u64,
    /// Maximum number of non-overlapping patches.
    pub max_patches: u64,
}

impl Default for RewriteLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: 8 * 1024 * 1024 * 1024,
            max_output_bytes: 8 * 1024 * 1024 * 1024,
            max_demo_messages: 10_000_000,
            max_entity_updates: 25_000_000,
            max_distinct_entities: 65_536,
            max_patches: 256,
        }
    }
}

impl RewriteLimits {
    /// Validates that every configured bound is usable.
    ///
    /// # Errors
    ///
    /// Returns [`RewriteError::InvalidRequest`] when a limit is zero or cannot
    /// accommodate the fixed demo header.
    pub fn validate(&self) -> Result<(), RewriteError> {
        if self.max_input_bytes < 16 {
            return Err(RewriteError::invalid("max_input_bytes must be at least 16"));
        }
        if self.max_output_bytes < 16 {
            return Err(RewriteError::invalid(
                "max_output_bytes must be at least 16",
            ));
        }
        for (name, value) in [
            ("max_demo_messages", self.max_demo_messages),
            ("max_entity_updates", self.max_entity_updates),
            ("max_distinct_entities", self.max_distinct_entities),
            ("max_patches", self.max_patches),
        ] {
            if value == 0 {
                return Err(RewriteError::invalid(format!("{name} must be non-zero")));
            }
        }
        Ok(())
    }
}

/// Cosmetic field names accepted by the writer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CosmeticField {
    /// Fallback paint kit.
    PaintKit,
    /// Fallback pattern seed.
    Seed,
    /// Fallback exterior wear.
    Wear,
    /// Fallback `StatTrak` counter.
    StatTrak,
}

impl CosmeticField {
    /// Every writable field in deterministic report order.
    pub const ALL: [Self; 4] = [Self::PaintKit, Self::Seed, Self::Wear, Self::StatTrak];

    /// Exact, full serializer path accepted for this field.
    pub const fn schema_path(self) -> &'static str {
        match self {
            Self::PaintKit => "m_AttributeManager.m_Item.m_nFallbackPaintKit",
            Self::Seed => "m_AttributeManager.m_Item.m_nFallbackSeed",
            Self::Wear => "m_AttributeManager.m_Item.m_flFallbackWear",
            Self::StatTrak => "m_AttributeManager.m_Item.m_nFallbackStatTrak",
        }
    }

    pub(crate) fn from_schema_path(path: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|field| field.schema_path() == path)
    }

    pub(crate) const fn index(self) -> usize {
        match self {
            Self::PaintKit => 0,
            Self::Seed => 1,
            Self::Wear => 2,
            Self::StatTrak => 3,
        }
    }
}

/// Numeric entity value retained by the pure inspection boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum CosmeticFieldValue {
    /// Signed 8-bit value.
    Signed8(i8),
    /// Signed 16-bit value.
    Signed16(i16),
    /// Signed 32-bit value.
    Signed32(i32),
    /// Signed 64-bit value.
    Signed64(i64),
    /// Unsigned 8-bit value.
    Unsigned8(u8),
    /// Unsigned 16-bit value.
    Unsigned16(u16),
    /// Unsigned 32-bit value.
    Unsigned32(u32),
    /// Unsigned 64-bit value.
    Unsigned64(u64),
    /// 32-bit float value.
    Float(f32),
    /// Decoded type cannot be safely rewritten as a cosmetic scalar.
    Unsupported(String),
}

impl CosmeticFieldValue {
    pub(crate) fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Signed8(value) => u64::try_from(*value).ok(),
            Self::Signed16(value) => u64::try_from(*value).ok(),
            Self::Signed32(value) => u64::try_from(*value).ok(),
            Self::Signed64(value) => u64::try_from(*value).ok(),
            Self::Unsigned8(value) => Some(u64::from(*value)),
            Self::Unsigned16(value) => Some(u64::from(*value)),
            Self::Unsigned32(value) => Some(u64::from(*value)),
            Self::Unsigned64(value) => Some(*value),
            Self::Float(_) | Self::Unsupported(_) => None,
        }
    }

    pub(crate) fn replace_unsigned_like(&self, replacement: u32) -> Option<Self> {
        match self {
            Self::Signed8(_) => i8::try_from(replacement).ok().map(Self::Signed8),
            Self::Signed16(_) => i16::try_from(replacement).ok().map(Self::Signed16),
            Self::Signed32(_) => i32::try_from(replacement).ok().map(Self::Signed32),
            Self::Signed64(_) => Some(Self::Signed64(i64::from(replacement))),
            Self::Unsigned8(_) => u8::try_from(replacement).ok().map(Self::Unsigned8),
            Self::Unsigned16(_) => u16::try_from(replacement).ok().map(Self::Unsigned16),
            Self::Unsigned32(_) => Some(Self::Unsigned32(replacement)),
            Self::Unsigned64(_) => Some(Self::Unsigned64(u64::from(replacement))),
            Self::Float(_) | Self::Unsupported(_) => None,
        }
    }
}

/// Bounded snapshot containing only explicitly inspected entity fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EntitySnapshot {
    /// Source 2 entity handle.
    pub handle: u32,
    /// Entity class name for diagnostics.
    pub class_name: String,
    /// Full serializer path to decoded value. Planning ignores every path not
    /// in the fixed identity/item/cosmetic allowlist.
    pub fields: BTreeMap<String, CosmeticFieldValue>,
}

/// Identity evidence used for a successful match.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MatchBasis {
    /// Item account ID matched.
    AccountId,
    /// Original-owner Steam64 halves matched.
    SteamId64,
    /// Both identifiers matched.
    Both,
}

/// One field replacement emitted by the pure planner.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PlannedFieldRewrite {
    /// Typed cosmetic field.
    pub field: CosmeticField,
    /// Exact full serializer path.
    pub schema_path: String,
    /// Existing value.
    pub current: CosmeticFieldValue,
    /// Type-preserving replacement.
    pub replacement: CosmeticFieldValue,
}

/// Pure plan for one entity snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EntityRewritePlan {
    /// Index into `RewriteRequest::patches`, when matched.
    pub patch_index: Option<usize>,
    /// Stable identity evidence, when matched.
    pub match_basis: Option<MatchBasis>,
    /// Existing fields that can be rewritten without changing wire types.
    pub replacements: Vec<PlannedFieldRewrite>,
    /// Requested existing fields whose decoded wire type is incompatible.
    pub incompatible_fields: BTreeSet<CosmeticField>,
}

impl EntityRewritePlan {
    /// Whether a stable owner and optional item definition matched.
    pub const fn matched(&self) -> bool {
        self.patch_index.is_some()
    }
}

/// Hit count for one requested field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct FieldHit {
    /// Field represented by this count.
    pub field: CosmeticField,
    /// Number of existing field occurrences replaced in the stream.
    pub hits: u64,
}

/// Per-patch rewrite result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct PatchRewriteReport {
    /// Request patch index.
    pub patch_index: usize,
    /// Distinct matching entity handles.
    pub matched_entities: u64,
    /// Counts for every field requested by the patch, including zero hits.
    pub field_hits: Vec<FieldHit>,
    /// Existing requested fields skipped due to an incompatible decoded type.
    pub incompatible_type_occurrences: u64,
}

impl PatchRewriteReport {
    /// Total rewritten field occurrences for this patch.
    pub fn total_hits(&self) -> u64 {
        self.field_hits
            .iter()
            .fold(0_u64, |total, hit| total.saturating_add(hit.hits))
    }
}

/// Backend counters returned before safe publication.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct BackendReport {
    /// Packet entity records examined.
    pub entity_updates: u64,
    /// Distinct entity handles examined.
    pub distinct_entities: u64,
    /// Per-patch result.
    pub patches: Vec<PatchRewriteReport>,
}

impl BackendReport {
    /// Total rewritten field occurrences.
    pub fn total_hits(&self) -> u64 {
        self.patches.iter().fold(0_u64, |total, patch| {
            total.saturating_add(patch.total_hits())
        })
    }
}

/// Successfully synchronized and atomically published rewrite result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct RewriteReport {
    /// Canonical input path.
    pub input_path: PathBuf,
    /// Resolved final output path.
    pub output_path: PathBuf,
    /// Input bytes inspected.
    pub input_bytes: u64,
    /// Published output bytes.
    pub output_bytes: u64,
    /// Outer demo messages validated before rewriting.
    pub demo_messages: u64,
    /// Backend counters and per-patch field hits.
    pub rewrite: BackendReport,
}

/// One stable, editable inventory target observed in a demo.
///
/// Repeated entity handles with the same owner and item definition are
/// intentionally grouped because the writer targets that stable pair rather
/// than a transient Source 2 entity handle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CosmeticInspectionItem {
    /// Stable owner identity accepted by [`CosmeticTarget`].
    pub owner: StablePlayerIdentity,
    /// Stable weapon/item definition identifier.
    pub item_definition_index: u16,
    /// Identity evidence found in the allow-listed item fields.
    pub match_basis: MatchBasis,
    /// Entity handles that represented this target during the demo.
    pub entity_handles: Vec<u32>,
    /// Entity class names retained for diagnostics only.
    pub class_names: Vec<String>,
    /// Existing fallback paint kit, when consistently decoded.
    pub paint_kit: Option<u32>,
    /// Existing fallback seed, when consistently decoded.
    pub seed: Option<u32>,
    /// Existing fallback wear, when consistently decoded.
    pub wear: Option<f32>,
    /// Existing fallback `StatTrak` value, when consistently decoded.
    pub stat_trak: Option<u32>,
    /// Allow-listed fields that existed with an unsupported wire type.
    pub incompatible_fields: BTreeSet<CosmeticField>,
    /// Allow-listed fields whose values differed across grouped handles.
    pub conflicting_fields: BTreeSet<CosmeticField>,
}

/// Bounded, read-only cosmetic inventory inspection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CosmeticInspectionReport {
    /// Canonical input path.
    pub input_path: PathBuf,
    /// Input bytes inspected.
    pub input_bytes: u64,
    /// Outer demo messages examined.
    pub demo_messages: u64,
    /// Packet entity records examined.
    pub entity_updates: u64,
    /// Distinct entity handles examined.
    pub distinct_entities: u64,
    /// Stable editable targets in deterministic owner/item order.
    pub items: Vec<CosmeticInspectionItem>,
}
