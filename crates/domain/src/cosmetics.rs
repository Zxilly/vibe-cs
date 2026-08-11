use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CosmeticPlan {
    pub id: Uuid,
    pub demo_id: Uuid,
    pub name: String,
    pub patches: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
