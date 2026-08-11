//! Safe, bounded cosmetic inspection and rewriting for Source 2 demos.

mod backend;
mod error;
mod inspect;
mod model;
mod plan;
mod safe_file;
mod source2_backend;

pub use backend::{DemoRewriteBackend, ReadSeek, WriteSeek};
pub use error::{BackendError, RewriteError};
pub use inspect::inspect_demo;
pub use model::{
    ACCOUNT_ID_PATH, BackendReport, CosmeticField, CosmeticFieldValue, CosmeticInspectionItem,
    CosmeticInspectionReport, CosmeticPatch, CosmeticTarget, CosmeticValues, EntityRewritePlan,
    EntitySnapshot, FieldHit, ITEM_DEFINITION_PATH, LimitKind, MatchBasis,
    ORIGINAL_OWNER_HIGH_PATH, ORIGINAL_OWNER_LOW_PATH, PatchRewriteReport, PlannedFieldRewrite,
    RewriteLimits, RewriteReport, RewriteRequest, StablePlayerIdentity,
};
pub use plan::plan_entity_rewrite;
pub use safe_file::{rewrite_demo, rewrite_demo_with_backend};
pub use source2_backend::Source2RewriteBackend;
