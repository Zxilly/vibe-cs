#![allow(
    clippy::missing_errors_doc,
    reason = "all repository methods consistently return the documented StorageError"
)]

mod activity;
mod agent_sessions;
mod analysis_runs;
mod lineups;
mod players;
mod projects;
mod review_metadata;

pub use activity::{
    ActivityKind, ActivityPage, ActivityQuery, ActivitySource, ActivityState, ActivitySummary,
};
pub use analysis_runs::{AnalysisReplaySource, AnalysisRunClaim};
pub use lineups::{
    LineupDirectoryItem, LineupDirectoryPage, LineupDirectoryQuery, LineupMapItem, LineupMapPage,
    LineupProjectionCoverage,
};
pub use players::{
    PlayerAggregateStats, PlayerComparisonProjection, PlayerDirectoryPage, PlayerDirectoryQuery,
    PlayerDirectorySort, PlayerHeatmapKind, PlayerHeatmapProjection, PlayerHeatmapQuery,
    PlayerMapPage, PlayerMapQuery, PlayerMatchPage, PlayerMatchQuery, PlayerProfile,
    PlayerProjectionCoverage, PlayerSortDirection, ProjectedPlayer, ProjectedPlayerHeatPoint,
    ProjectedPlayerMap, ProjectedPlayerMatch,
};
pub use projects::ProjectLeaseAcquire;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use ts_rs::TS;
use uuid::Uuid;
use vibe_cs_domain::{
    AppConfig, CosmeticPlan, DEMO_MAX_PAGE, DEMO_MAX_PAGE_SIZE, DemoMatchSource, DemoMetadata,
    DemoMetadataBatchUpdate, DemoMetadataUpdate, DemoPatch, DemoQuery, DemoRecord, DemoSort,
    DemoStatus, DemoTag, DemoTagCreate, EventKind, EvidenceAnnotation, EvidenceAnnotationQuery,
    EvidenceAnnotationReviewState, EvidenceEventFamily, EvidenceSearchAvailability,
    EvidenceSearchCapability, EvidenceSearchItem, EvidenceSearchPage, EvidenceSearchQuery,
    EvidenceSourceKind, ExportJob, HighlightKind, MatchAnalysis, MatchDownloadJob,
    MatchDownloadStatus, MatchHistoryQuery, MediaAsset, MediaProxyStatus, Page, RecordedClip,
    RecordingJob, SteamMatchRecord, TimelineEvent,
};

use crate::{Result, StorageError, schema};

/// Maximum number of editor project snapshots retained for restoration.
const MAX_EVIDENCE_ITEMS_PER_ANALYSIS: usize = 200_000;
const MAX_EVIDENCE_SOURCE_ID_CHARS: usize = 256;

#[cfg(windows)]
const LLM_API_KEY_ENVELOPE_PREFIX: &str = "dpapi:";
#[cfg(windows)]
const LLM_API_KEY_DPAPI_PURPOSE: &[u8] = b"Vibe CS app_config.llm.api_key";
#[cfg(windows)]
const MAX_LLM_API_KEY_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const MAX_LLM_API_KEY_ENVELOPE_HEX_BYTES: usize = (MAX_LLM_API_KEY_BYTES + 4 * 1024) * 2;

#[cfg(windows)]
fn llm_api_key_purpose(config: &AppConfig) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(LLM_API_KEY_DPAPI_PURPOSE);
    for component in [config.llm.provider.trim(), config.llm.base_url.trim()] {
        digest.update(component.len().to_le_bytes());
        digest.update(component.as_bytes());
    }
    digest.finalize().into()
}

#[cfg(windows)]
fn config_for_persistence(config: &AppConfig) -> Result<AppConfig> {
    let mut stored = config.clone();
    if stored.llm.api_key.is_empty() {
        return Ok(stored);
    }
    if stored.llm.api_key.len() > MAX_LLM_API_KEY_BYTES {
        return Err(StorageError::SecretProtection);
    }
    let ciphertext = vibe_cs_platform_windows::protect_user_secret(
        stored.llm.api_key.as_bytes(),
        &llm_api_key_purpose(&stored),
    )
    .map_err(|_| StorageError::SecretProtection)?;
    stored.llm.api_key = format!("{LLM_API_KEY_ENVELOPE_PREFIX}{}", hex::encode(ciphertext));
    Ok(stored)
}

#[cfg(not(windows))]
fn config_for_persistence(config: &AppConfig) -> Result<AppConfig> {
    if config.llm.api_key.is_empty() {
        Ok(config.clone())
    } else {
        Err(StorageError::SecretPersistenceUnsupported)
    }
}

#[cfg(windows)]
fn config_from_persistence(mut config: AppConfig) -> Result<AppConfig> {
    if config.llm.api_key.is_empty() {
        return Ok(config);
    }
    let Some(encoded) = config.llm.api_key.strip_prefix(LLM_API_KEY_ENVELOPE_PREFIX) else {
        return Err(StorageError::SecretRecovery);
    };
    if encoded.is_empty() || encoded.len() > MAX_LLM_API_KEY_ENVELOPE_HEX_BYTES {
        return Err(StorageError::SecretRecovery);
    }
    let ciphertext = hex::decode(encoded).map_err(|_| StorageError::SecretRecovery)?;
    let mut plaintext =
        vibe_cs_platform_windows::unprotect_user_secret(&ciphertext, &llm_api_key_purpose(&config))
            .map_err(|_| StorageError::SecretRecovery)?;
    if plaintext.len() > MAX_LLM_API_KEY_BYTES {
        plaintext.fill(0);
        return Err(StorageError::SecretRecovery);
    }
    let api_key = std::str::from_utf8(&plaintext)
        .map(str::to_owned)
        .map_err(|_| StorageError::SecretRecovery);
    plaintext.fill(0);
    config.llm.api_key = api_key?;
    Ok(config)
}

#[cfg(not(windows))]
fn config_from_persistence(config: AppConfig) -> Result<AppConfig> {
    if config.llm.api_key.is_empty() {
        Ok(config)
    } else {
        Err(StorageError::SecretPersistenceUnsupported)
    }
}

fn sql_u64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| StorageError::IntegerOutOfRange(value))
}

fn row_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(index)?;
    u64::try_from(value).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "negative SQLite integer cannot represent an unsigned value",
            )),
        )
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvidenceAnnotationCreate {
    Created(EvidenceAnnotation),
    EvidenceNotFound,
    EvidenceLocationMismatch,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MediaAssetUpdate {
    Updated(Box<MediaAsset>),
    NotFound,
    Busy,
    Conflict,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MediaProxyCleanupPlan {
    pub detached_paths: Vec<String>,
    pub generating_asset_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContentAddressedDemoPut {
    Inserted(DemoRecord),
    Existing(DemoRecord),
}

#[derive(Debug, Clone, PartialEq)]
pub enum MatchDownloadClaim {
    Claimed {
        job: MatchDownloadJob,
        record: Box<SteamMatchRecord>,
        linked_demo: Option<DemoCatalogIdentity>,
    },
    Existing(MatchDownloadJob),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DemoContentIdentity {
    pub id: Uuid,
    pub path: String,
    pub status: DemoStatus,
    pub content_sha256: String,
    pub file_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DemoCatalogIdentity {
    pub id: Uuid,
    pub path: String,
    pub status: DemoStatus,
    pub content_sha256: Option<String>,
    pub file_size: u64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DemoContentRecovery {
    pub expected: DemoContentIdentity,
    pub verified_path: String,
    pub verified_file_name: String,
    pub verified_size: u64,
    pub verified_sha256: String,
}

impl ContentAddressedDemoPut {
    pub fn demo(&self) -> &DemoRecord {
        match self {
            Self::Inserted(demo) | Self::Existing(demo) => demo,
        }
    }

    pub fn into_demo(self) -> DemoRecord {
        match self {
            Self::Inserted(demo) | Self::Existing(demo) => demo,
        }
    }

    pub const fn was_inserted(&self) -> bool {
        matches!(self, Self::Inserted(_))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ExportJobRecord {
    pub kind: String,
    pub job: ExportJob,
}

#[derive(Debug, Clone)]
pub struct Storage {
    connection: Arc<Mutex<Connection>>,
}

impl Storage {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        Self::open_with(move || Connection::open(path)).await
    }

    pub async fn open_in_memory() -> Result<Self> {
        Self::open_with(Connection::open_in_memory).await
    }

    async fn open_with<F>(open: F) -> Result<Self>
    where
        F: FnOnce() -> rusqlite::Result<Connection> + Send + 'static,
    {
        let connection = tokio::task::spawn_blocking(move || {
            let mut connection = open()?;
            schema::configure(&connection)?;
            schema::run(&mut connection)?;
            reconcile_evidence_projections(&mut connection)?;
            Ok::<_, StorageError>(connection)
        })
        .await??;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    async fn run<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let connection = Arc::clone(&self.connection);
        tokio::task::spawn_blocking(move || {
            let mut connection = connection.lock().map_err(|_| StorageError::LockPoisoned)?;
            operation(&mut connection)
        })
        .await?
    }

    pub async fn get_config(&self) -> Result<Option<AppConfig>> {
        self.run(|connection| {
            let Some(json) = connection
                .query_row(
                    "SELECT document_json FROM app_config WHERE key = 'app'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            else {
                return Ok(None);
            };
            let stored: AppConfig = decode(&json)?;
            let config = config_from_persistence(stored)?;
            Ok(Some(config))
        })
        .await
    }

    pub async fn put_config(&self, config: AppConfig) -> Result<AppConfig> {
        self.run(move |connection| {
            let stored = config_for_persistence(&config)?;
            connection.execute(
                "INSERT INTO app_config(key, document_json, updated_at) VALUES ('app', ?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET document_json = excluded.document_json, \
                 updated_at = excluded.updated_at",
                params![encode(&stored)?, Utc::now().to_rfc3339()],
            )?;
            Ok(config)
        })
        .await
    }

    pub async fn list_cosmetic_plans(&self, demo_id: Uuid) -> Result<Vec<CosmeticPlan>> {
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT document_json FROM cosmetic_plans WHERE demo_id = ?1 ORDER BY updated_at DESC",
            )?;
            let mut rows = statement.query([demo_id.to_string()])?;
            collect_documents(&mut rows)
        })
        .await
    }

    pub async fn get_cosmetic_plan(&self, id: Uuid) -> Result<Option<CosmeticPlan>> {
        self.run(move |connection| get_document(connection, "cosmetic_plans", id))
            .await
    }

    pub async fn put_cosmetic_plan(&self, plan: CosmeticPlan) -> Result<CosmeticPlan> {
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO cosmetic_plans(id, demo_id, name, updated_at, document_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, \
                 document_json = excluded.document_json",
                params![
                    plan.id.to_string(),
                    plan.demo_id.to_string(),
                    plan.name,
                    plan.updated_at.to_rfc3339(),
                    encode(&plan)?,
                ],
            )?;
            Ok(plan)
        })
        .await
    }

    pub async fn delete_cosmetic_plan(&self, id: Uuid) -> Result<bool> {
        self.delete_document("cosmetic_plans", id).await
    }

    pub async fn list_demos(&self, query: DemoQuery) -> Result<Page<DemoRecord>> {
        self.run(move |connection| {
            let page = query.page.unwrap_or(1);
            if !(1..=DEMO_MAX_PAGE).contains(&page) {
                return Err(vibe_cs_domain::DomainError::InvalidInput(
                    format!("demo page must be between 1 and {DEMO_MAX_PAGE}"),
                )
                .into());
            }
            let page_size = query.page_size.unwrap_or(50);
            if !(1..=DEMO_MAX_PAGE_SIZE).contains(&page_size) {
                return Err(vibe_cs_domain::DomainError::InvalidInput(
                    format!("demo page_size must be between 1 and {DEMO_MAX_PAGE_SIZE}"),
                )
                .into());
            }
            let search = query.search.filter(|value| !value.trim().is_empty());
            let source = query.source.filter(|value| !value.trim().is_empty());
            let match_source = query.match_source.map(match_source_text);
            let tag_id = query.tag_id.map(|id| id.to_string());
            let map_name = query.map_name.filter(|value| !value.trim().is_empty());
            let status = query.status.map(status_text);
            let order_sql = demo_order_sql(query.sort.unwrap_or_default());
            let values: [&dyn rusqlite::ToSql; 6] = [
                &search,
                &source,
                &map_name,
                &status,
                &match_source,
                &tag_id,
            ];
            let where_sql = " WHERE (?1 IS NULL OR display_name LIKE '%' || ?1 || '%' OR file_name LIKE '%' || ?1 || '%' \
                             OR EXISTS (SELECT 1 FROM json_each(demos.document_json, '$.player_names') AS player \
                                        WHERE CAST(player.value AS TEXT) LIKE '%' || ?1 || '%')) \
                             AND (?2 IS NULL OR source = ?2) \
                             AND (?3 IS NULL OR map_name = ?3) \
                             AND (?4 IS NULL OR status = ?4) \
                             AND (?5 IS NULL OR EXISTS (SELECT 1 FROM demo_metadata AS metadata \
                                                        WHERE metadata.demo_id = demos.id AND metadata.match_source = ?5)) \
                             AND (?6 IS NULL OR EXISTS (SELECT 1 FROM demo_tag_assignments AS assignment \
                                                        WHERE assignment.demo_id = demos.id AND assignment.tag_id = ?6))";
            let total = connection.query_row(
                &format!("SELECT COUNT(*) FROM demos{where_sql}"),
                values,
                |row| row_u64(row, 0),
            )?;

            let mut statement = connection.prepare(&format!(
                "SELECT document_json FROM demos{where_sql} \
                 ORDER BY {order_sql} LIMIT ?7 OFFSET ?8"
            ))?;
            let mut rows = statement.query(params![
                search,
                source,
                map_name,
                status,
                match_source,
                tag_id,
                page_size,
                sql_u64(u64::from(page - 1) * u64::from(page_size))?
            ])?;
            let mut items = Vec::new();
            while let Some(row) = rows.next()? {
                items.push(decode(&row.get::<_, String>(0)?)?);
            }
            Ok(Page {
                items,
                total,
                page,
                page_size,
            })
        })
        .await
    }

    pub async fn list_demo_metadata_export(
        &self,
        query: DemoQuery,
        maximum_rows: u32,
    ) -> Result<Vec<(DemoRecord, DemoMetadata)>> {
        if maximum_rows == 0 {
            return Err(StorageError::Domain(
                vibe_cs_domain::DomainError::InvalidInput(
                    "demo export maximum_rows must be positive".to_owned(),
                ),
            ));
        }
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let search = query.search.filter(|value| !value.trim().is_empty());
            let source = query.source.filter(|value| !value.trim().is_empty());
            let match_source = query.match_source.map(match_source_text);
            let tag_id = query.tag_id.map(|id| id.to_string());
            let map_name = query.map_name.filter(|value| !value.trim().is_empty());
            let status = query.status.map(status_text);
            let order_sql = demo_order_sql(query.sort.unwrap_or_default());
            let where_sql = " WHERE (?1 IS NULL OR display_name LIKE '%' || ?1 || '%' OR file_name LIKE '%' || ?1 || '%' \
                             OR EXISTS (SELECT 1 FROM json_each(demos.document_json, '$.player_names') AS player \
                                        WHERE CAST(player.value AS TEXT) LIKE '%' || ?1 || '%')) \
                             AND (?2 IS NULL OR source = ?2) \
                             AND (?3 IS NULL OR map_name = ?3) \
                             AND (?4 IS NULL OR status = ?4) \
                             AND (?5 IS NULL OR EXISTS (SELECT 1 FROM demo_metadata AS metadata \
                                                        WHERE metadata.demo_id = demos.id AND metadata.match_source = ?5)) \
                             AND (?6 IS NULL OR EXISTS (SELECT 1 FROM demo_tag_assignments AS assignment \
                                                        WHERE assignment.demo_id = demos.id AND assignment.tag_id = ?6))";
            let limit = i64::from(maximum_rows) + 1;
            let mut statement = transaction.prepare(&format!(
                "SELECT document_json FROM demos{where_sql} ORDER BY {order_sql} LIMIT ?7"
            ))?;
            let documents = statement
                .query_map(
                    params![search, source, map_name, status, match_source, tag_id, limit],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(statement);
            if documents.len() > usize::try_from(maximum_rows).unwrap_or(usize::MAX) {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::InvalidInput(
                    format!("demo export exceeds the {maximum_rows} row limit"),
                )));
            }
            let mut output = Vec::with_capacity(documents.len());
            for document in documents {
                let demo = decode::<DemoRecord>(&document)?;
                let metadata = read_demo_metadata(&transaction, demo.id)?.ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::Internal(
                        "demo disappeared during export snapshot".to_owned(),
                    ))
                })?;
                output.push((demo, metadata));
            }
            transaction.commit()?;
            Ok(output)
        })
        .await
    }

    pub async fn get_demo(&self, id: Uuid) -> Result<Option<DemoRecord>> {
        self.run(move |connection| get_document(connection, "demos", id))
            .await
    }

    pub async fn get_demo_by_path(&self, path: impl Into<String>) -> Result<Option<DemoRecord>> {
        let path = path.into();
        self.run(move |connection| {
            let json = connection
                .query_row(
                    "SELECT document_json FROM demos WHERE path = ?1",
                    [path],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            json.map(|json| decode(&json)).transpose()
        })
        .await
    }

    pub async fn get_demo_by_hash(&self, hash: impl Into<String>) -> Result<Option<DemoRecord>> {
        let hash = hash.into();
        self.run(move |connection| {
            let json = connection
                .query_row(
                    "SELECT document_json FROM demos WHERE content_sha256 = ?1 LIMIT 1",
                    [hash],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            json.map(|json| decode(&json)).transpose()
        })
        .await
    }

    pub async fn put_demo(&self, demo: DemoRecord) -> Result<DemoRecord> {
        let mut demos = self.put_demos(vec![demo]).await?;
        Ok(demos.remove(0))
    }

    /// Atomically claims a non-null content hash for one Demo. If the bytes are
    /// already cataloged, only a previously unknown trusted match date may be
    /// added; conflicting known dates are rejected without changing either row.
    pub async fn put_content_addressed_demo(
        &self,
        demo: DemoRecord,
    ) -> Result<ContentAddressedDemoPut> {
        self.put_content_addressed_demo_observed(demo, None).await
    }

    /// Content-addressed insertion with a claim-time identity guard for an
    /// existing Demo whose ID may be reused for repaired bytes.
    pub async fn put_content_addressed_demo_observed(
        &self,
        demo: DemoRecord,
        expected_same_id: Option<DemoCatalogIdentity>,
    ) -> Result<ContentAddressedDemoPut> {
        let hash = demo.content_sha256.clone().ok_or_else(|| {
            vibe_cs_domain::DomainError::InvalidInput(
                "content-addressed Demo requires a SHA-256 fingerprint".to_owned(),
            )
        })?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(expected) = expected_same_id.as_ref() {
                if expected.id != demo.id {
                    return Err(vibe_cs_domain::DomainError::InvalidInput(
                        "observed Demo identity does not match the replacement ID".to_owned(),
                    )
                    .into());
                }
                let Some(current) = get_document::<DemoRecord>(&transaction, "demos", expected.id)?
                else {
                    return Err(vibe_cs_domain::DomainError::Conflict(
                        "linked Demo disappeared after the download claim".to_owned(),
                    )
                    .into());
                };
                if !demo_catalog_identity_matches(expected, &current) {
                    return Err(vibe_cs_domain::DomainError::Conflict(
                        "linked Demo changed after the download claim".to_owned(),
                    )
                    .into());
                }
            }
            let existing_json = transaction
                .query_row(
                    "SELECT document_json FROM demos WHERE content_sha256 = ?1 LIMIT 1",
                    [hash],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(existing_json) = existing_json {
                let mut existing = decode::<DemoRecord>(&existing_json)?;
                let match_date_changed = merge_trusted_match_date(&mut existing, demo.match_date)?;
                let requested_recovery = existing.id == demo.id && existing.path != demo.path;
                let recovered_missing =
                    if existing.status == DemoStatus::Missing || requested_recovery {
                        existing.path = demo.path;
                        existing.file_name = demo.file_name;
                        existing.file_size = demo.file_size;
                        existing.status = if transaction
                            .query_row(
                                "SELECT 1 FROM analyses WHERE demo_id = ?1 LIMIT 1",
                                [existing.id.to_string()],
                                |_| Ok(()),
                            )
                            .optional()?
                            .is_some()
                        {
                            DemoStatus::Ready
                        } else {
                            DemoStatus::Discovered
                        };
                        existing.updated_at = Utc::now();
                        true
                    } else {
                        false
                    };
                if match_date_changed || recovered_missing {
                    put_demo_row(&transaction, &existing)?;
                }
                transaction.commit()?;
                return Ok(ContentAddressedDemoPut::Existing(existing));
            }
            let mut demo = demo;
            if let Some(current) = get_document::<DemoRecord>(&transaction, "demos", demo.id)? {
                if current.path == demo.path && expected_same_id.is_none() {
                    return Err(vibe_cs_domain::DomainError::Conflict(
                        "content-addressed Demo replacement requires the atomic replacement API"
                            .to_owned(),
                    )
                    .into());
                }
                transaction.execute(
                    "DELETE FROM analyses WHERE demo_id = ?1",
                    [demo.id.to_string()],
                )?;
                demo.created_at = current.created_at;
                demo.display_name = current.display_name;
                demo.remark = current.remark;
            }
            put_demo_row(&transaction, &demo)?;
            transaction.commit()?;
            Ok(ContentAddressedDemoPut::Inserted(demo))
        })
        .await
    }

    /// Atomically replaces the bytes represented by one Demo and invalidates
    /// its analysis only after the new content hash is proven unclaimed.
    pub async fn replace_demo_content(&self, demo: DemoRecord) -> Result<DemoRecord> {
        let hash = demo.content_sha256.clone().ok_or_else(|| {
            vibe_cs_domain::DomainError::InvalidInput(
                "Demo content replacement requires a SHA-256 fingerprint".to_owned(),
            )
        })?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) = get_document::<DemoRecord>(&transaction, "demos", demo.id)? else {
                return Err(vibe_cs_domain::DomainError::NotFound("Demo".to_owned()).into());
            };
            if current.path != demo.path {
                return Err(vibe_cs_domain::DomainError::Conflict(
                    "Demo content replacement cannot change its cataloged path".to_owned(),
                )
                .into());
            }
            let conflicting_id = transaction
                .query_row(
                    "SELECT id FROM demos WHERE content_sha256 = ?1 AND id <> ?2 LIMIT 1",
                    params![hash, demo.id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if conflicting_id.is_some() {
                return Err(vibe_cs_domain::DomainError::Conflict(
                    "Demo content is already cataloged at another path".to_owned(),
                )
                .into());
            }
            transaction.execute(
                "DELETE FROM analyses WHERE demo_id = ?1",
                [demo.id.to_string()],
            )?;
            put_demo_row(&transaction, &demo)?;
            transaction.commit()?;
            Ok(demo)
        })
        .await
    }

    /// Moves a content-addressed catalog row to a separately verified copy if
    /// and only if its database identity still matches the stale observation.
    pub async fn recover_content_addressed_demo(
        &self,
        recovery: DemoContentRecovery,
    ) -> Result<Option<DemoRecord>> {
        if recovery.expected.content_sha256 != recovery.verified_sha256 {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "Demo recovery bytes do not match the cataloged fingerprint".to_owned(),
            )
            .into());
        }
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut current) =
                get_document::<DemoRecord>(&transaction, "demos", recovery.expected.id)?
            else {
                transaction.commit()?;
                return Ok(None);
            };
            if current.path != recovery.expected.path
                || current.status != recovery.expected.status
                || current.content_sha256.as_deref()
                    != Some(recovery.expected.content_sha256.as_str())
                || current.file_size != recovery.expected.file_size
            {
                return Err(vibe_cs_domain::DomainError::Conflict(
                    "content-addressed Demo changed before recovery".to_owned(),
                )
                .into());
            }
            current.path = recovery.verified_path;
            current.file_name = recovery.verified_file_name;
            current.file_size = recovery.verified_size;
            current.status = if transaction
                .query_row(
                    "SELECT 1 FROM analyses WHERE demo_id = ?1 LIMIT 1",
                    [current.id.to_string()],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            {
                DemoStatus::Ready
            } else {
                DemoStatus::Discovered
            };
            current.updated_at = Utc::now();
            put_demo_row(&transaction, &current)?;
            transaction.commit()?;
            Ok(Some(current))
        })
        .await
    }

    /// Atomically invalidates a Demo whose observed file no longer validates,
    /// removing all byte-derived analysis and summary truth in the same write.
    pub async fn invalidate_demo_content(
        &self,
        expected: DemoRecord,
        observed_file_size: u64,
    ) -> Result<Option<DemoRecord>> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut current) = get_document::<DemoRecord>(&transaction, "demos", expected.id)?
            else {
                transaction.commit()?;
                return Ok(None);
            };
            if current.path != expected.path
                || current.status != expected.status
                || current.content_sha256 != expected.content_sha256
                || current.file_size != expected.file_size
                || current.updated_at != expected.updated_at
            {
                return Err(vibe_cs_domain::DomainError::Conflict(
                    "Demo changed before invalid content could be recorded".to_owned(),
                )
                .into());
            }
            transaction.execute(
                "DELETE FROM analyses WHERE demo_id = ?1",
                [current.id.to_string()],
            )?;
            current.status = DemoStatus::Failed;
            current.content_sha256 = None;
            current.file_size = observed_file_size;
            current.map_name = None;
            current.match_date = None;
            current.duration_seconds = None;
            current.total_rounds = None;
            current.team_a_name = None;
            current.team_b_name = None;
            current.team_a_score = None;
            current.team_b_score = None;
            current.player_names.clear();
            current.updated_at = Utc::now();
            put_demo_row(&transaction, &current)?;
            transaction.commit()?;
            Ok(Some(current))
        })
        .await
    }

    /// Reconciles a trusted match date with an existing Demo in one transaction.
    /// `None` never manufactures a date, and two different known dates conflict.
    pub async fn reconcile_demo_match_date(
        &self,
        id: Uuid,
        match_date: Option<DateTime<Utc>>,
    ) -> Result<Option<DemoRecord>> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut demo) = get_document::<DemoRecord>(&transaction, "demos", id)? else {
                transaction.commit()?;
                return Ok(None);
            };
            if merge_trusted_match_date(&mut demo, match_date)? {
                put_demo_row(&transaction, &demo)?;
            }
            transaction.commit()?;
            Ok(Some(demo))
        })
        .await
    }

    pub async fn put_demos(&self, demos: Vec<DemoRecord>) -> Result<Vec<DemoRecord>> {
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            for demo in &demos {
                put_demo_row(&transaction, demo)?;
            }
            transaction.commit()?;
            Ok(demos)
        })
        .await
    }

    /// Inserts a batch transactionally while rejecting records whose content
    /// hash is already present, including duplicates earlier in the same batch.
    pub async fn put_unique_demos(
        &self,
        demos: Vec<DemoRecord>,
    ) -> Result<(Vec<DemoRecord>, Vec<DemoRecord>)> {
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let mut inserted = Vec::new();
            let mut duplicates = Vec::new();
            for demo in demos {
                let duplicate = if let Some(hash) = demo.content_sha256.as_deref() {
                    transaction
                        .query_row(
                            "SELECT 1 FROM demos WHERE content_sha256 = ?1 LIMIT 1",
                            [hash],
                            |_| Ok(()),
                        )
                        .optional()?
                        .is_some()
                } else {
                    false
                };
                if duplicate {
                    duplicates.push(demo);
                } else {
                    put_demo_row(&transaction, &demo)?;
                    inserted.push(demo);
                }
            }
            transaction.commit()?;
            Ok((inserted, duplicates))
        })
        .await
    }

    pub async fn patch_demo(&self, id: Uuid, patch: DemoPatch) -> Result<Option<DemoRecord>> {
        self.run(move |connection| {
            let Some(mut demo) = get_document::<DemoRecord>(connection, "demos", id)? else {
                return Ok(None);
            };
            if let Some(display_name) = patch.display_name {
                demo.display_name = display_name;
            }
            if let Some(remark) = patch.remark {
                demo.remark = remark;
            }
            demo.updated_at = Utc::now();
            put_demo_row(connection, &demo)?;
            Ok(Some(demo))
        })
        .await
    }

    pub async fn create_demo_tag(&self, input: DemoTagCreate) -> Result<DemoTag> {
        let input = input.normalize()?;
        self.run(move |connection| {
            let now = Utc::now();
            let tag = DemoTag {
                id: Uuid::new_v4(),
                name: input.name,
                color: input.color,
                created_at: now,
                updated_at: now,
            };
            connection.execute(
                "INSERT INTO review_tags(id, name, name_key, color, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    tag.id.to_string(),
                    tag.name,
                    tag.name.to_lowercase(),
                    tag.color,
                    tag.created_at.to_rfc3339(),
                    tag.updated_at.to_rfc3339(),
                ],
            )?;
            Ok(tag)
        })
        .await
    }

    pub async fn list_demo_tags(&self) -> Result<Vec<DemoTag>> {
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT id, name, color, created_at, updated_at FROM review_tags \
                 ORDER BY name_key ASC, name ASC, id ASC",
            )?;
            let rows = statement.query_map([], read_demo_tag)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into)
        })
        .await
    }

    pub async fn update_demo_tag(&self, id: Uuid, input: DemoTagCreate) -> Result<Option<DemoTag>> {
        let input = input.normalize()?;
        self.run(move |connection| {
            let Some(created_at) = connection
                .query_row(
                    "SELECT created_at FROM review_tags WHERE id = ?1",
                    [id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            else {
                return Ok(None);
            };
            let updated_at = Utc::now();
            connection.execute(
                "UPDATE review_tags SET name = ?2, name_key = ?3, color = ?4, updated_at = ?5 WHERE id = ?1",
                params![
                    id.to_string(),
                    input.name,
                    input.name.to_lowercase(),
                    input.color,
                    updated_at.to_rfc3339(),
                ],
            )?;
            Ok(Some(DemoTag {
                id,
                name: input.name,
                color: input.color,
                created_at: parse_repository_datetime(&created_at)?,
                updated_at,
            }))
        })
        .await
    }

    pub async fn delete_demo_tag(&self, id: Uuid) -> Result<bool> {
        self.run(move |connection| {
            Ok(connection.execute("DELETE FROM review_tags WHERE id = ?1", [id.to_string()])? > 0)
        })
        .await
    }

    pub async fn get_demo_metadata(&self, id: Uuid) -> Result<Option<DemoMetadata>> {
        self.run(move |connection| read_demo_metadata(connection, id))
            .await
    }

    pub async fn update_demo_metadata(
        &self,
        id: Uuid,
        update: DemoMetadataUpdate,
    ) -> Result<Option<DemoMetadata>> {
        update.validate()?;
        self.run(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut demo) = get_document::<DemoRecord>(&transaction, "demos", id)? else {
                return Ok(None);
            };
            let tag_count = if update.tag_ids.is_empty() {
                0
            } else {
                let placeholders = std::iter::repeat_n("?", update.tag_ids.len())
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!("SELECT COUNT(*) FROM review_tags WHERE id IN ({placeholders})");
                let ids = update.tag_ids.iter().map(Uuid::to_string).collect::<Vec<_>>();
                transaction.query_row(
                    &sql,
                    rusqlite::params_from_iter(ids.iter()),
                    |row| row.get::<_, i64>(0),
                )?
            };
            let requested_tag_count = i64::try_from(update.tag_ids.len()).map_err(|_| {
                StorageError::Domain(vibe_cs_domain::DomainError::InvalidInput(
                    "demo tag assignment count is out of range".to_owned(),
                ))
            })?;
            if tag_count != requested_tag_count {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::InvalidInput(
                    "one or more assigned demo tags do not exist".to_owned(),
                )));
            }
            let now = Utc::now();
            demo.remark = update.comment;
            demo.updated_at = now;
            put_demo_row(&transaction, &demo)?;
            transaction.execute(
                "INSERT INTO demo_metadata(demo_id, match_source, updated_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(demo_id) DO UPDATE SET match_source = excluded.match_source, updated_at = excluded.updated_at",
                params![id.to_string(), update.match_source.map(match_source_text), now.to_rfc3339()],
            )?;
            transaction.execute(
                "DELETE FROM demo_tag_assignments WHERE demo_id = ?1",
                [id.to_string()],
            )?;
            for (position, tag_id) in update.tag_ids.iter().enumerate() {
                let position = i64::try_from(position).map_err(|_| {
                    StorageError::Domain(vibe_cs_domain::DomainError::InvalidInput(
                        "demo tag position is out of range".to_owned(),
                    ))
                })?;
                transaction.execute(
                    "INSERT INTO demo_tag_assignments(demo_id, tag_id, position) VALUES (?1, ?2, ?3)",
                    params![id.to_string(), tag_id.to_string(), position],
                )?;
            }
            let metadata = read_demo_metadata(&transaction, id)?.ok_or_else(|| {
                StorageError::Domain(vibe_cs_domain::DomainError::Internal(
                    "demo disappeared during its metadata transaction".to_owned(),
                ))
            })?;
            transaction.commit()?;
            Ok(Some(metadata))
        })
        .await
    }

    pub async fn update_demo_metadata_batch(
        &self,
        update: DemoMetadataBatchUpdate,
    ) -> Result<Vec<DemoMetadata>> {
        update.validate()?;
        self.run(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let requested_tags = update
                .add_tag_ids
                .iter()
                .chain(update.remove_tag_ids.iter())
                .copied()
                .collect::<std::collections::BTreeSet<_>>();
            for tag_id in &requested_tags {
                let exists = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM review_tags WHERE id = ?1)",
                    [tag_id.to_string()],
                    |row| row.get::<_, bool>(0),
                )?;
                if !exists {
                    return Err(StorageError::Domain(vibe_cs_domain::DomainError::InvalidInput(
                        "one or more batch demo tags do not exist".to_owned(),
                    )));
                }
            }

            let now = Utc::now();
            let removed = update.remove_tag_ids.iter().copied().collect::<std::collections::BTreeSet<_>>();
            let mut output = Vec::with_capacity(update.demo_ids.len());
            for demo_id in &update.demo_ids {
                let Some(mut demo) = get_document::<DemoRecord>(&transaction, "demos", *demo_id)? else {
                    return Err(StorageError::Domain(vibe_cs_domain::DomainError::NotFound(
                        format!("demo {demo_id}"),
                    )));
                };
                let current = read_demo_metadata(&transaction, *demo_id)?.ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::NotFound(format!("demo {demo_id}")))
                })?;
                let mut tag_ids = current.tags.iter().map(|tag| tag.id).collect::<Vec<_>>();
                tag_ids.retain(|tag_id| !removed.contains(tag_id));
                for tag_id in &update.add_tag_ids {
                    if !tag_ids.contains(tag_id) {
                        tag_ids.push(*tag_id);
                    }
                }
                if tag_ids.len() > vibe_cs_domain::DEMO_TAG_MAX_ASSIGNMENTS {
                    return Err(StorageError::Domain(vibe_cs_domain::DomainError::InvalidInput(
                        "a demo may have at most 32 tags".to_owned(),
                    )));
                }

                demo.updated_at = now;
                put_demo_row(&transaction, &demo)?;
                let match_source = if update.set_match_source {
                    update.match_source
                } else {
                    current.match_source
                };
                transaction.execute(
                    "INSERT INTO demo_metadata(demo_id, match_source, updated_at) VALUES (?1, ?2, ?3) \
                     ON CONFLICT(demo_id) DO UPDATE SET match_source = excluded.match_source, updated_at = excluded.updated_at",
                    params![demo_id.to_string(), match_source.map(match_source_text), now.to_rfc3339()],
                )?;
                transaction.execute(
                    "DELETE FROM demo_tag_assignments WHERE demo_id = ?1",
                    [demo_id.to_string()],
                )?;
                for (position, tag_id) in tag_ids.iter().enumerate() {
                    let position = i64::try_from(position).map_err(|_| {
                        StorageError::Domain(vibe_cs_domain::DomainError::InvalidInput(
                            "demo tag position is out of range".to_owned(),
                        ))
                    })?;
                    transaction.execute(
                        "INSERT INTO demo_tag_assignments(demo_id, tag_id, position) VALUES (?1, ?2, ?3)",
                        params![demo_id.to_string(), tag_id.to_string(), position],
                    )?;
                }
                output.push(read_demo_metadata(&transaction, *demo_id)?.ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::Internal(
                        "demo disappeared during its metadata batch transaction".to_owned(),
                    ))
                })?);
            }
            transaction.commit()?;
            Ok(output)
        })
        .await
    }

    pub async fn set_demo_status(
        &self,
        id: Uuid,
        status: DemoStatus,
    ) -> Result<Option<DemoRecord>> {
        self.run(move |connection| {
            let Some(mut demo) = get_document::<DemoRecord>(connection, "demos", id)? else {
                return Ok(None);
            };
            demo.status = status;
            demo.updated_at = Utc::now();
            put_demo_row(connection, &demo)?;
            Ok(Some(demo))
        })
        .await
    }

    pub async fn delete_demo(&self, id: Uuid) -> Result<bool> {
        self.run(move |connection| {
            Ok(connection.execute("DELETE FROM demos WHERE id = ?1", [id.to_string()])? > 0)
        })
        .await
    }

    pub async fn delete_analysis(&self, demo_id: Uuid) -> Result<bool> {
        self.run(move |connection| {
            Ok(connection.execute(
                "DELETE FROM analyses WHERE demo_id = ?1",
                [demo_id.to_string()],
            )? > 0)
        })
        .await
    }

    pub async fn get_analysis(&self, demo_id: Uuid) -> Result<Option<MatchAnalysis>> {
        self.run(move |connection| {
            let json = connection
                .query_row(
                    "SELECT document_json FROM analyses WHERE demo_id = ?1",
                    [demo_id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            json.map(|json| decode(&json)).transpose()
        })
        .await
    }

    pub async fn search_evidence(&self, query: EvidenceSearchQuery) -> Result<EvidenceSearchPage> {
        self.run(move |connection| search_evidence_rows(connection, &query))
            .await
    }

    pub async fn create_evidence_annotation(
        &self,
        draft: vibe_cs_domain::CreateEvidenceAnnotation,
    ) -> Result<EvidenceAnnotationCreate> {
        let draft = draft.normalize()?;
        self.run(move |connection| {
            let locator = connection
                .query_row(
                    "SELECT demo_id, round, tick FROM evidence_search_items WHERE evidence_id = ?1",
                    [draft.evidence_id.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, u32>(1)?,
                            row_u64(row, 2)?,
                        ))
                    },
                )
                .optional()?;
            let Some((demo_id, round, tick)) = locator else {
                return Ok(EvidenceAnnotationCreate::EvidenceNotFound);
            };
            if demo_id != draft.demo_id.to_string() || round != draft.round || tick != draft.tick {
                return Ok(EvidenceAnnotationCreate::EvidenceLocationMismatch);
            }

            let now = Utc::now();
            let annotation = EvidenceAnnotation {
                id: Uuid::new_v4(),
                demo_id: draft.demo_id,
                evidence_id: draft.evidence_id,
                round: draft.round,
                tick: draft.tick,
                body: draft.body,
                tags: draft.tags,
                review_state: EvidenceAnnotationReviewState::Open,
                created_at: now,
                updated_at: now,
            };
            connection.execute(
                "INSERT INTO evidence_annotations(
                    id, demo_id, evidence_id, round, tick, review_state,
                    created_at, updated_at, document_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    annotation.id.to_string(),
                    annotation.demo_id.to_string(),
                    annotation.evidence_id,
                    i64::from(annotation.round),
                    sql_u64(annotation.tick)?,
                    evidence_annotation_state_text(annotation.review_state),
                    annotation.created_at.to_rfc3339(),
                    annotation.updated_at.to_rfc3339(),
                    encode(&annotation)?,
                ],
            )?;
            Ok(EvidenceAnnotationCreate::Created(annotation))
        })
        .await
    }

    pub async fn list_evidence_annotations(
        &self,
        query: EvidenceAnnotationQuery,
    ) -> Result<Page<EvidenceAnnotation>> {
        query.validate()?;
        let page = query.page.unwrap_or(1);
        let page_size = query
            .page_size
            .unwrap_or(vibe_cs_domain::EVIDENCE_ANNOTATION_DEFAULT_PAGE_SIZE);
        let offset = u64::from(page - 1) * u64::from(page_size);
        let demo_id = query.demo_id.map(|id| id.to_string());
        let evidence_id = query.evidence_id.map(|value| value.trim().to_owned());
        let review_state = query.state.map(evidence_annotation_state_text);
        let q = query.q.map(|value| value.trim().to_lowercase());
        let tag = query.tag.map(|value| value.trim().to_lowercase());
        self.run(move |connection| {
            let total = connection.query_row(
                "SELECT COUNT(*) FROM evidence_annotations
                 WHERE (?1 IS NULL OR demo_id = ?1)
                   AND (?2 IS NULL OR evidence_id = ?2)
                   AND (?3 IS NULL OR review_state = ?3)
                   AND (?4 IS NULL OR instr(
                       lower(coalesce(json_extract(document_json, '$.body'), '')), ?4
                   ) > 0)
                   AND (?5 IS NULL OR EXISTS (
                       SELECT 1 FROM json_each(evidence_annotations.document_json, '$.tags') AS annotation_tag
                       WHERE lower(annotation_tag.value) = ?5
                   ))",
                params![demo_id, evidence_id, review_state, q, tag],
                |row| row_u64(row, 0),
            )?;
            let mut statement = connection.prepare(
                "SELECT document_json FROM evidence_annotations
                 WHERE (?1 IS NULL OR demo_id = ?1)
                   AND (?2 IS NULL OR evidence_id = ?2)
                   AND (?3 IS NULL OR review_state = ?3)
                   AND (?4 IS NULL OR instr(
                       lower(coalesce(json_extract(document_json, '$.body'), '')), ?4
                   ) > 0)
                   AND (?5 IS NULL OR EXISTS (
                       SELECT 1 FROM json_each(evidence_annotations.document_json, '$.tags') AS annotation_tag
                       WHERE lower(annotation_tag.value) = ?5
                   ))
                 ORDER BY updated_at DESC, id ASC LIMIT ?6 OFFSET ?7",
            )?;
            let mut rows = statement.query(params![
                demo_id,
                evidence_id,
                review_state,
                q,
                tag,
                i64::from(page_size),
                sql_u64(offset)?,
            ])?;
            Ok(Page {
                items: collect_documents(&mut rows)?,
                total,
                page,
                page_size,
            })
        })
        .await
    }

    pub async fn update_evidence_annotation(
        &self,
        id: Uuid,
        update: vibe_cs_domain::UpdateEvidenceAnnotation,
    ) -> Result<Option<EvidenceAnnotation>> {
        let update = update.normalize()?;
        self.run(move |connection| {
            let Some(mut annotation) =
                get_document::<EvidenceAnnotation>(connection, "evidence_annotations", id)?
            else {
                return Ok(None);
            };
            annotation.body = update.body;
            annotation.tags = update.tags;
            annotation.review_state = update.review_state;
            annotation.updated_at = Utc::now();
            connection.execute(
                "UPDATE evidence_annotations
                 SET review_state = ?1, updated_at = ?2, document_json = ?3
                 WHERE id = ?4",
                params![
                    evidence_annotation_state_text(annotation.review_state),
                    annotation.updated_at.to_rfc3339(),
                    encode(&annotation)?,
                    annotation.id.to_string(),
                ],
            )?;
            Ok(Some(annotation))
        })
        .await
    }

    pub async fn delete_evidence_annotation(&self, id: Uuid) -> Result<bool> {
        self.delete_document("evidence_annotations", id).await
    }

    pub async fn list_steam_matches(
        &self,
        query: MatchHistoryQuery,
    ) -> Result<Page<SteamMatchRecord>> {
        self.run(move |connection| {
            let page = query.page.unwrap_or(1).max(1);
            let page_size = query.page_size.unwrap_or(50).clamp(1, 200);
            let steam_id = query.steam_id.filter(|value| !value.trim().is_empty());
            let search = query.search.and_then(|value| {
                let value = value.trim();
                (!value.is_empty()).then(|| {
                    let escaped = value
                        .to_lowercase()
                        .replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_");
                    format!("%{escaped}%")
                })
            });
            let total = connection.query_row(
                "SELECT COUNT(*) FROM steam_matches \
                 WHERE (?1 IS NULL OR steam_id = ?1) \
                 AND (?2 IS NULL OR lower(document_json) LIKE ?2 ESCAPE '\\')",
                params![steam_id, search],
                |row| row_u64(row, 0),
            )?;
            let mut statement = connection.prepare(
                "SELECT document_json FROM steam_matches \
                 WHERE (?1 IS NULL OR steam_id = ?1) \
                 AND (?2 IS NULL OR lower(document_json) LIKE ?2 ESCAPE '\\') \
                 ORDER BY length(match_id) DESC, match_id DESC LIMIT ?3 OFFSET ?4",
            )?;
            let mut rows = statement.query(params![
                steam_id,
                search,
                page_size,
                sql_u64(u64::from(page - 1) * u64::from(page_size))?
            ])?;
            Ok(Page {
                items: collect_documents(&mut rows)?,
                total,
                page,
                page_size,
            })
        })
        .await
    }

    pub async fn get_steam_match(&self, id: impl Into<String>) -> Result<Option<SteamMatchRecord>> {
        let id = id.into();
        self.run(move |connection| {
            let json = connection
                .query_row(
                    "SELECT document_json FROM steam_matches WHERE id = ?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            json.map(|json| decode(&json)).transpose()
        })
        .await
    }

    pub async fn put_steam_match(&self, record: SteamMatchRecord) -> Result<SteamMatchRecord> {
        let mut records = self.put_steam_matches(vec![record]).await?;
        Ok(records.remove(0))
    }

    pub async fn put_steam_matches(
        &self,
        records: Vec<SteamMatchRecord>,
    ) -> Result<Vec<SteamMatchRecord>> {
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            for record in &records {
                put_steam_match_row(&transaction, record)?;
            }
            transaction.commit()?;
            Ok(records)
        })
        .await
    }

    /// Atomically merges Steam synchronization fields while preserving the
    /// current download/link workflow and any already-known trusted date.
    pub async fn merge_synced_steam_matches(
        &self,
        records: Vec<SteamMatchRecord>,
    ) -> Result<(Vec<SteamMatchRecord>, u64)> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut merged = Vec::with_capacity(records.len());
            let mut created = 0_u64;
            for incoming in records {
                let record = if let Some(mut current) =
                    get_steam_match_document(&transaction, &incoming.id)?
                {
                    if current.steam_id != incoming.steam_id
                        || current.match_id != incoming.match_id
                    {
                        return Err(vibe_cs_domain::DomainError::Conflict(
                            "Steam match identity changed during synchronization".to_owned(),
                        )
                        .into());
                    }
                    current.outcome_id = incoming.outcome_id;
                    current.token = incoming.token;
                    if incoming.map_name.is_some() {
                        current.map_name = incoming.map_name;
                    }
                    if incoming.score.is_some() {
                        current.score = incoming.score;
                    }
                    if incoming.result != vibe_cs_domain::MatchHistoryResult::Unknown {
                        current.result = incoming.result;
                    }
                    current.synced_at = incoming.synced_at;
                    current.updated_at = incoming.updated_at;
                    current.played_at =
                        merge_trusted_steam_match_date(current.played_at, incoming.played_at)?;
                    current
                } else {
                    created = created.saturating_add(1);
                    incoming
                };
                put_steam_match_row(&transaction, &record)?;
                merged.push(record);
            }
            transaction.commit()?;
            Ok((merged, created))
        })
        .await
    }

    pub async fn get_match_download_job(&self, id: Uuid) -> Result<Option<MatchDownloadJob>> {
        self.run(move |connection| get_document(connection, "match_download_jobs", id))
            .await
    }

    /// Atomically claims the only active download slot for a Steam match and
    /// transitions its current record to `Downloading` in the same transaction.
    pub async fn claim_match_download(
        &self,
        match_record_id: impl Into<String>,
        observed_demo_id: Option<Uuid>,
        job_id: Uuid,
    ) -> Result<Option<MatchDownloadClaim>> {
        let match_record_id = match_record_id.into();
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut record) = get_steam_match_document(&transaction, &match_record_id)? else {
                transaction.commit()?;
                return Ok(None);
            };
            let existing = transaction
                .query_row(
                    "SELECT document_json FROM match_download_jobs \
                     WHERE match_record_id = ?1 AND status NOT IN ('completed', 'cancelled', 'failed') \
                     LIMIT 1",
                    [&match_record_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                let existing = decode(&existing)?;
                transaction.commit()?;
                return Ok(Some(MatchDownloadClaim::Existing(existing)));
            }
            if record.demo_id != observed_demo_id {
                return Err(vibe_cs_domain::DomainError::Conflict(
                    "Steam match Demo link changed before the download claim".to_owned(),
                )
                .into());
            }
            let linked_demo = record
                .demo_id
                .map(|id| get_document::<DemoRecord>(&transaction, "demos", id))
                .transpose()?
                .flatten()
                .as_ref()
                .map(demo_catalog_identity);
            let now = Utc::now();
            let job = MatchDownloadJob {
                id: job_id,
                match_record_id: record.id.clone(),
                status: MatchDownloadStatus::Queued,
                downloaded_bytes: 0,
                total_bytes: None,
                progress: 0.0,
                demo_id: None,
                error: None,
                error_code: None,
                created_at: now,
                updated_at: now,
            };
            put_match_download_job_row(&transaction, &job)?;
            record.demo_status = vibe_cs_domain::MatchDemoStatus::Downloading;
            record.last_error = None;
            record.updated_at = now;
            put_steam_match_row(&transaction, &record)?;
            transaction.commit()?;
            Ok(Some(MatchDownloadClaim::Claimed {
                job,
                record: Box::new(record),
                linked_demo,
            }))
        })
        .await
    }

    /// Atomically records that an exact, already-cataloged Demo satisfies the
    /// match download. An existing active owner wins and is returned unchanged.
    pub async fn complete_existing_match_download(
        &self,
        match_record_id: impl Into<String>,
        observed_demo_id: Option<Uuid>,
        demo_id: Uuid,
        observed_demo: DemoContentIdentity,
        job_id: Uuid,
    ) -> Result<Option<MatchDownloadClaim>> {
        let match_record_id = match_record_id.into();
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut record) = get_steam_match_document(&transaction, &match_record_id)? else {
                transaction.commit()?;
                return Ok(None);
            };
            let existing = transaction
                .query_row(
                    "SELECT document_json FROM match_download_jobs \
                     WHERE match_record_id = ?1 AND status NOT IN ('completed', 'cancelled', 'failed') \
                     LIMIT 1",
                    [&match_record_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                let existing = decode(&existing)?;
                transaction.commit()?;
                return Ok(Some(MatchDownloadClaim::Existing(existing)));
            }
            if record.demo_id != observed_demo_id || record.demo_id != Some(demo_id) {
                return Err(vibe_cs_domain::DomainError::Conflict(
                    "Steam match Demo link changed before fast-path completion".to_owned(),
                )
                .into());
            }
            let Some(mut demo) = get_document::<DemoRecord>(&transaction, "demos", demo_id)? else {
                transaction.commit()?;
                return Ok(None);
            };
            if observed_demo.id != demo.id
                || observed_demo.path != demo.path
                || observed_demo.status != demo.status
                || demo.content_sha256.as_deref() != Some(observed_demo.content_sha256.as_str())
                || observed_demo.file_size != demo.file_size
            {
                return Err(vibe_cs_domain::DomainError::Conflict(
                    "downloaded Demo changed after fast-path validation".to_owned(),
                )
                .into());
            }
            if merge_trusted_match_date(&mut demo, record.played_at)? {
                put_demo_row(&transaction, &demo)?;
            }
            let now = Utc::now();
            let job = MatchDownloadJob {
                id: job_id,
                match_record_id: record.id.clone(),
                status: MatchDownloadStatus::Completed,
                downloaded_bytes: 0,
                total_bytes: None,
                progress: 1.0,
                demo_id: Some(demo_id),
                error: None,
                error_code: None,
                created_at: now,
                updated_at: now,
            };
            record.demo_id = Some(demo_id);
            record.demo_status = vibe_cs_domain::MatchDemoStatus::Downloaded;
            record.last_error = None;
            record.updated_at = now;
            put_match_download_job_row(&transaction, &job)?;
            put_steam_match_row(&transaction, &record)?;
            transaction.commit()?;
            Ok(Some(MatchDownloadClaim::Claimed {
                job,
                record: Box::new(record),
                linked_demo: Some(demo_catalog_identity(&demo)),
            }))
        })
        .await
    }

    pub async fn get_active_match_download_job(
        &self,
        match_record_id: impl Into<String>,
    ) -> Result<Option<MatchDownloadJob>> {
        let match_record_id = match_record_id.into();
        self.run(move |connection| {
            let json = connection
                .query_row(
                    "SELECT document_json FROM match_download_jobs \
                     WHERE match_record_id = ?1 AND status NOT IN ('completed', 'cancelled', 'failed') \
                     ORDER BY updated_at DESC LIMIT 1",
                    [match_record_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            json.map(|json| decode(&json)).transpose()
        })
        .await
    }

    pub async fn list_active_match_download_jobs(&self) -> Result<Vec<MatchDownloadJob>> {
        self.run(|connection| {
            let mut statement = connection.prepare(
                "SELECT document_json FROM match_download_jobs \
                 WHERE status NOT IN ('completed', 'cancelled', 'failed') \
                 ORDER BY updated_at ASC",
            )?;
            let mut rows = statement.query([])?;
            collect_documents(&mut rows)
        })
        .await
    }

    /// Lists every persisted match download job, including terminal history.
    ///
    /// The match-history polling endpoint intentionally exposes active jobs only. Cross-workflow
    /// activity views need stored terminal outcomes too, so this read model keeps that distinction
    /// explicit instead of treating a missing active job as a successful download.
    pub async fn list_match_download_jobs(&self) -> Result<Vec<MatchDownloadJob>> {
        self.list_documents("match_download_jobs", "updated_at DESC")
            .await
    }

    pub async fn put_match_download_job(&self, job: MatchDownloadJob) -> Result<MatchDownloadJob> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) =
                get_document::<MatchDownloadJob>(&transaction, "match_download_jobs", job.id)?
            else {
                put_match_download_job_row(&transaction, &job)?;
                transaction.commit()?;
                return Ok(job);
            };
            if current.match_record_id != job.match_record_id {
                return Err(vibe_cs_domain::DomainError::Conflict(
                    "match download job ownership changed".to_owned(),
                )
                .into());
            }
            if !match_download_update_is_monotonic(current.status, job.status) {
                transaction.commit()?;
                return Ok(current);
            }
            let job = merge_match_download_progress(job, &current);
            put_match_download_job_row(&transaction, &job)?;
            transaction.commit()?;
            Ok(job)
        })
        .await
    }

    /// Advances an owned download through its active stages without allowing
    /// stale progress or stage writers to undo cancellation or terminal truth.
    pub async fn advance_match_download(
        &self,
        job: MatchDownloadJob,
    ) -> Result<Option<MatchDownloadJob>> {
        if match_download_stage(job.status).is_none() {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "match download advancement requires an active worker stage".to_owned(),
            )
            .into());
        }
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) =
                get_document::<MatchDownloadJob>(&transaction, "match_download_jobs", job.id)?
            else {
                transaction.commit()?;
                return Ok(None);
            };
            if current.match_record_id != job.match_record_id {
                return Err(vibe_cs_domain::DomainError::Conflict(
                    "match download job ownership changed".to_owned(),
                )
                .into());
            }
            if !match_download_update_is_monotonic(current.status, job.status) {
                transaction.commit()?;
                return Ok(Some(current));
            }
            let job = merge_match_download_progress(job, &current);
            put_match_download_job_row(&transaction, &job)?;
            transaction.commit()?;
            Ok(Some(job))
        })
        .await
    }

    /// Requests cancellation without allowing a stale caller to move a
    /// terminal job back into the active state set.
    pub async fn request_match_download_cancel(
        &self,
        id: Uuid,
    ) -> Result<Option<MatchDownloadJob>> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut job) =
                get_document::<MatchDownloadJob>(&transaction, "match_download_jobs", id)?
            else {
                transaction.commit()?;
                return Ok(None);
            };
            if !job.status.is_terminal() && job.status != MatchDownloadStatus::Cancelling {
                job.status = MatchDownloadStatus::Cancelling;
                job.updated_at = Utc::now();
                put_match_download_job_row(&transaction, &job)?;
            }
            transaction.commit()?;
            Ok(Some(job))
        })
        .await
    }

    /// Commits a terminal download outcome together with the linked Steam
    /// match. Only the still-active owning job may change the record.
    pub async fn finalize_match_download(
        &self,
        mut job: MatchDownloadJob,
        expected_demo: Option<DemoContentIdentity>,
    ) -> Result<Option<MatchDownloadJob>> {
        if !job.status.is_terminal() {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "match download finalization requires a terminal status".to_owned(),
            )
            .into());
        }
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) =
                get_document::<MatchDownloadJob>(&transaction, "match_download_jobs", job.id)?
            else {
                transaction.commit()?;
                return Ok(None);
            };
            if current.match_record_id != job.match_record_id {
                return Err(vibe_cs_domain::DomainError::Conflict(
                    "match download job ownership changed".to_owned(),
                )
                .into());
            }
            if current.status.is_terminal() {
                transaction.commit()?;
                return Ok(Some(current));
            }
            if current.status == MatchDownloadStatus::Cancelling
                && job.status != MatchDownloadStatus::Cancelled
            {
                return Err(
                    vibe_cs_domain::DomainError::Conflict("download cancelled".to_owned()).into(),
                );
            }
            let Some(mut record) =
                get_steam_match_document(&transaction, &current.match_record_id)?
            else {
                return Err(vibe_cs_domain::DomainError::NotFound("Steam match".to_owned()).into());
            };
            job.created_at = current.created_at;
            record.updated_at = job.updated_at;
            match job.status {
                MatchDownloadStatus::Completed => {
                    let demo_id = job.demo_id.ok_or_else(|| {
                        vibe_cs_domain::DomainError::InvalidInput(
                            "completed match download requires a Demo".to_owned(),
                        )
                    })?;
                    let expected_demo = expected_demo.as_ref().ok_or_else(|| {
                        vibe_cs_domain::DomainError::InvalidInput(
                            "completed match download requires a verified Demo identity".to_owned(),
                        )
                    })?;
                    let Some(mut demo) =
                        get_document::<DemoRecord>(&transaction, "demos", demo_id)?
                    else {
                        return Err(vibe_cs_domain::DomainError::NotFound(
                            "downloaded Demo".to_owned(),
                        )
                        .into());
                    };
                    if expected_demo.id != demo_id
                        || expected_demo.path != demo.path
                        || expected_demo.status != demo.status
                        || demo.content_sha256.as_deref()
                            != Some(expected_demo.content_sha256.as_str())
                        || expected_demo.file_size != demo.file_size
                    {
                        return Err(vibe_cs_domain::DomainError::Conflict(
                            "downloaded Demo changed before completion".to_owned(),
                        )
                        .into());
                    }
                    if merge_trusted_match_date(&mut demo, record.played_at)? {
                        put_demo_row(&transaction, &demo)?;
                    }
                    record.demo_id = Some(demo_id);
                    record.demo_status = vibe_cs_domain::MatchDemoStatus::Downloaded;
                    record.last_error = None;
                }
                MatchDownloadStatus::Cancelled => {
                    record.demo_status = vibe_cs_domain::MatchDemoStatus::Available;
                    record.last_error = None;
                }
                MatchDownloadStatus::Failed => {
                    record.demo_status = vibe_cs_domain::MatchDemoStatus::Failed;
                    record.last_error.clone_from(&job.error);
                }
                _ => unreachable!("terminal status checked above"),
            }
            put_match_download_job_row(&transaction, &job)?;
            put_steam_match_row(&transaction, &record)?;
            transaction.commit()?;
            Ok(Some(job))
        })
        .await
    }

    /// Fails every active Steam download left without an in-process owner in
    /// one transaction so reservations and match truth cannot diverge.
    pub async fn recover_orphaned_match_downloads(&self, error: String) -> Result<u64> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut statement = transaction.prepare(
                "SELECT document_json FROM match_download_jobs \
                 WHERE status NOT IN ('completed', 'cancelled', 'failed') \
                 ORDER BY updated_at ASC",
            )?;
            let mut rows = statement.query([])?;
            let mut jobs = collect_documents::<MatchDownloadJob>(&mut rows)?;
            drop(rows);
            drop(statement);
            let now = Utc::now();
            for job in &mut jobs {
                let cancelled = job.status == MatchDownloadStatus::Cancelling;
                job.status = if cancelled {
                    MatchDownloadStatus::Cancelled
                } else {
                    MatchDownloadStatus::Failed
                };
                job.error = (!cancelled).then(|| error.clone());
                job.updated_at = now;
                let Some(mut record) =
                    get_steam_match_document(&transaction, &job.match_record_id)?
                else {
                    return Err(
                        vibe_cs_domain::DomainError::NotFound("Steam match".to_owned()).into(),
                    );
                };
                record.demo_status = if cancelled {
                    vibe_cs_domain::MatchDemoStatus::Available
                } else {
                    vibe_cs_domain::MatchDemoStatus::Failed
                };
                record.last_error = (!cancelled).then(|| error.clone());
                record.updated_at = now;
                put_match_download_job_row(&transaction, job)?;
                put_steam_match_row(&transaction, &record)?;
            }
            transaction.commit()?;
            u64::try_from(jobs.len()).map_err(|_| StorageError::IntegerOutOfRange(u64::MAX))
        })
        .await
    }

    pub async fn list_recorded_clips(&self) -> Result<Vec<RecordedClip>> {
        self.list_documents("recorded_clips", "created_at DESC")
            .await
    }

    pub async fn list_recorded_clips_limited(&self, limit: u32) -> Result<Vec<RecordedClip>> {
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT document_json FROM recorded_clips ORDER BY created_at DESC LIMIT ?1",
            )?;
            let mut rows = statement.query([limit])?;
            collect_documents(&mut rows)
        })
        .await
    }

    pub async fn get_recorded_clip(&self, id: Uuid) -> Result<Option<RecordedClip>> {
        self.run(move |connection| get_document(connection, "recorded_clips", id))
            .await
    }

    pub async fn put_recorded_clip(&self, clip: RecordedClip) -> Result<RecordedClip> {
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO recorded_clips(id, demo_id, title, category, path, created_at, document_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT(id) DO UPDATE SET demo_id = excluded.demo_id, title = excluded.title, \
                 category = excluded.category, path = excluded.path, document_json = excluded.document_json",
                params![
                    clip.id.to_string(),
                    clip.demo_id.map(|id| id.to_string()),
                    clip.title,
                    clip.category,
                    clip.path,
                    clip.created_at.to_rfc3339(),
                    encode(&clip)?
                ],
            )?;
            Ok(clip)
        })
        .await
    }

    pub async fn delete_recorded_clip(&self, id: Uuid) -> Result<bool> {
        self.delete_document("recorded_clips", id).await
    }

    pub async fn list_assets(
        &self,
        project_id: Option<Uuid>,
    ) -> Result<Vec<vibe_cs_domain::MediaAsset>> {
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT document_json FROM media_assets \
                 WHERE (?1 IS NULL OR project_id = ?1) ORDER BY created_at DESC",
            )?;
            let mut rows = statement.query([project_id.map(|id| id.to_string())])?;
            collect_documents(&mut rows)
        })
        .await
    }

    pub async fn get_asset(&self, id: Uuid) -> Result<Option<vibe_cs_domain::MediaAsset>> {
        self.run(move |connection| get_document(connection, "media_assets", id))
            .await
    }

    pub async fn put_asset(
        &self,
        asset: vibe_cs_domain::MediaAsset,
    ) -> Result<vibe_cs_domain::MediaAsset> {
        self.run(move |connection| {
            put_asset_row(connection, &asset)?;
            Ok(asset)
        })
        .await
    }

    pub async fn begin_media_proxy_generation(
        &self,
        id: Uuid,
        lease_id: Uuid,
        started_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    ) -> Result<MediaAssetUpdate> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut asset) = get_document::<MediaAsset>(&transaction, "media_assets", id)?
            else {
                return Ok(MediaAssetUpdate::NotFound);
            };
            if matches!(
                &asset.proxy_status,
                MediaProxyStatus::Generating {
                    lease_id: current_lease,
                    expires_at: current_expiry,
                    ..
                } if *current_lease != Uuid::nil() && *current_expiry > started_at
            ) {
                return Ok(MediaAssetUpdate::Busy);
            }
            asset.proxy_status = MediaProxyStatus::Generating {
                started_at,
                lease_id,
                expires_at,
            };
            put_asset_row(&transaction, &asset)?;
            transaction.commit()?;
            Ok(MediaAssetUpdate::Updated(Box::new(asset)))
        })
        .await
    }

    pub async fn finish_media_proxy_generation(
        &self,
        asset: MediaAsset,
        lease_id: Uuid,
    ) -> Result<MediaAssetUpdate> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) = get_document::<MediaAsset>(&transaction, "media_assets", asset.id)?
            else {
                return Ok(MediaAssetUpdate::NotFound);
            };
            let owns_generation = matches!(
                &current.proxy_status,
                MediaProxyStatus::Generating { lease_id: current_lease, .. }
                    if *current_lease == lease_id
            );
            if !owns_generation || current.path != asset.path {
                return Ok(MediaAssetUpdate::Conflict);
            }
            put_asset_row(&transaction, &asset)?;
            transaction.commit()?;
            Ok(MediaAssetUpdate::Updated(Box::new(asset)))
        })
        .await
    }

    /// Converts expired proxy leases into retryable failures.
    pub async fn recover_expired_media_proxy_generations(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Vec<MediaAsset>> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut statement = transaction.prepare("SELECT document_json FROM media_assets")?;
            let mut rows = statement.query([])?;
            let mut assets = collect_documents::<MediaAsset>(&mut rows)?;
            drop(rows);
            drop(statement);
            let mut recovered = Vec::new();
            for asset in &mut assets {
                let expired = matches!(
                    &asset.proxy_status,
                    MediaProxyStatus::Generating {
                        lease_id,
                        expires_at,
                        ..
                    } if *lease_id == Uuid::nil() || *expires_at <= now
                );
                if !expired {
                    continue;
                }
                asset.proxy_status = MediaProxyStatus::Failed {
                    message: "proxy generation lease expired and is safe to retry".to_owned(),
                    failed_at: now,
                };
                put_asset_row(&transaction, asset)?;
                recovered.push(asset.clone());
            }
            transaction.commit()?;
            Ok(recovered)
        })
        .await
    }

    pub async fn relink_media_asset(
        &self,
        id: Uuid,
        expected_path: String,
        mut replacement: MediaAsset,
    ) -> Result<MediaAssetUpdate> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) = get_document::<MediaAsset>(&transaction, "media_assets", id)?
            else {
                return Ok(MediaAssetUpdate::NotFound);
            };
            if matches!(&current.proxy_status, MediaProxyStatus::Generating { .. }) {
                return Ok(MediaAssetUpdate::Busy);
            }
            if current.path != expected_path {
                return Ok(MediaAssetUpdate::Conflict);
            }
            replacement.id = current.id;
            replacement.project_id = current.project_id;
            replacement.created_at = current.created_at;
            put_asset_row(&transaction, &replacement)?;
            transaction.commit()?;
            Ok(MediaAssetUpdate::Updated(Box::new(replacement)))
        })
        .await
    }

    /// Detaches reusable proxy files in one transaction. Callers can then
    /// delete the returned controlled paths; orphan scanning makes a failed
    /// deletion retryable without retaining a stale media reference.
    pub async fn prepare_media_proxy_cleanup(&self) -> Result<MediaProxyCleanupPlan> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut statement = transaction.prepare("SELECT document_json FROM media_assets")?;
            let mut rows = statement.query([])?;
            let mut assets = collect_documents::<MediaAsset>(&mut rows)?;
            drop(rows);
            drop(statement);
            let mut plan = MediaProxyCleanupPlan::default();
            for asset in &mut assets {
                if matches!(&asset.proxy_status, MediaProxyStatus::Generating { .. }) {
                    plan.generating_asset_ids.push(asset.id);
                    continue;
                }
                let Some(path) = asset.proxy_path.take() else {
                    continue;
                };
                plan.detached_paths.push(path);
                asset.proxy_status = MediaProxyStatus::NotRequested;
                put_asset_row(&transaction, asset)?;
            }
            transaction.commit()?;
            Ok(plan)
        })
        .await
    }

    pub async fn delete_asset(&self, id: Uuid) -> Result<bool> {
        self.delete_document("media_assets", id).await
    }

    pub async fn list_export_jobs(&self, project_id: Option<Uuid>) -> Result<Vec<ExportJobRecord>> {
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT document_json FROM export_jobs \
                 WHERE (?1 IS NULL OR project_id = ?1) ORDER BY updated_at DESC",
            )?;
            let mut rows = statement.query([project_id.map(|id| id.to_string())])?;
            collect_documents(&mut rows)
        })
        .await
    }

    pub async fn list_export_jobs_limited(
        &self,
        project_id: Option<Uuid>,
        limit: u32,
    ) -> Result<Vec<ExportJobRecord>> {
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT document_json FROM export_jobs \
                 WHERE (?1 IS NULL OR project_id = ?1) ORDER BY updated_at DESC LIMIT ?2",
            )?;
            let mut rows = statement.query(params![project_id.map(|id| id.to_string()), limit])?;
            collect_documents(&mut rows)
        })
        .await
    }

    pub async fn get_export_job(&self, id: Uuid) -> Result<Option<ExportJobRecord>> {
        self.run(move |connection| get_document(connection, "export_jobs", id))
            .await
    }

    pub async fn put_export_job(&self, record: ExportJobRecord) -> Result<ExportJobRecord> {
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO export_jobs(id, project_id, kind, status, updated_at, document_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, \
                 document_json = excluded.document_json",
                params![
                    record.job.id.to_string(),
                    record.job.project_id.to_string(),
                    record.kind,
                    job_status_text(record.job.status),
                    record.job.updated_at.to_rfc3339(),
                    encode(&record)?
                ],
            )?;
            Ok(record)
        })
        .await
    }

    pub async fn delete_export_job(&self, id: Uuid) -> Result<bool> {
        self.delete_document("export_jobs", id).await
    }

    pub async fn get_recording_job(&self, id: Uuid) -> Result<Option<RecordingJob>> {
        self.run(move |connection| get_document(connection, "recording_jobs", id))
            .await
    }

    /// Returns a structurally proven terminal recording attempt only when it
    /// is the latest leaf and no other persisted recording is active.
    pub async fn get_retryable_recording_job(&self, id: Uuid) -> Result<Option<RecordingJob>> {
        self.run(move |connection| {
            let document = connection
                .query_row(
                    "SELECT parent.document_json
                       FROM recording_jobs AS parent
                      WHERE parent.id = ?1
                        AND parent.status IN ('failed', 'cancelled')
                        AND NOT EXISTS (
                            SELECT 1 FROM recording_jobs AS child WHERE child.retry_of = parent.id
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM recording_jobs AS active
                             WHERE active.status NOT IN ('completed', 'failed', 'cancelled')
                        )",
                    params![id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(document) = document else {
                return Ok(None);
            };
            let job = decode::<RecordingJob>(&document)?;
            Ok(job.retryable_suffix().is_ok().then_some(job))
        })
        .await
    }

    pub async fn list_recording_jobs(&self) -> Result<Vec<RecordingJob>> {
        self.list_documents("recording_jobs", "updated_at DESC")
            .await
    }

    pub async fn put_recording_job(&self, job: RecordingJob) -> Result<RecordingJob> {
        self.run(move |connection| {
            let retry_of = job.retry_of;
            let result = connection.execute(
                "INSERT INTO recording_jobs(id, retry_of, status, updated_at, document_json) VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, \
                 document_json = excluded.document_json \
                 WHERE recording_jobs.retry_of IS excluded.retry_of",
                params![
                    job.id.to_string(),
                    job.retry_of.map(|id| id.to_string()),
                    job_status_text(job.status),
                    job.updated_at.to_rfc3339(),
                    encode(&job)?
                ],
            );
            let affected = match result {
                Ok(affected) => affected,
                Err(error) => {
                    let constraint_violation = matches!(
                        &error,
                        rusqlite::Error::SqliteFailure(failure, _)
                            if failure.code == rusqlite::ErrorCode::ConstraintViolation
                    );
                    if constraint_violation
                        && let Some(parent_id) = retry_of
                    {
                        let claimed = connection.query_row(
                            "SELECT EXISTS(
                                SELECT 1 FROM recording_jobs
                                 WHERE retry_of = ?1 AND id <> ?2
                             )",
                            params![parent_id.to_string(), job.id.to_string()],
                            |row| row.get::<_, bool>(0),
                        )?;
                        if claimed {
                            return Err(StorageError::RecordingRetryAlreadyClaimed(parent_id));
                        }
                    }
                    return Err(error.into());
                }
            };
            if affected == 0 {
                return Err(StorageError::RecordingRetryLineageImmutable(job.id));
            }
            Ok(job)
        })
        .await
    }

    async fn list_documents<T>(&self, table: &'static str, order: &'static str) -> Result<Vec<T>>
    where
        T: DeserializeOwned + Send + 'static,
    {
        self.run(move |connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT document_json FROM {table} ORDER BY {order}"
            ))?;
            let mut rows = statement.query([])?;
            collect_documents(&mut rows)
        })
        .await
    }

    async fn delete_document(&self, table: &'static str, id: Uuid) -> Result<bool> {
        self.run(move |connection| {
            Ok(connection.execute(
                &format!("DELETE FROM {table} WHERE id = ?1"),
                [id.to_string()],
            )? > 0)
        })
        .await
    }

    pub async fn database_path(&self) -> Result<Option<PathBuf>> {
        self.run(|connection| {
            let path =
                connection.query_row("PRAGMA database_list", [], |row| row.get::<_, String>(2))?;
            Ok((!path.is_empty()).then(|| PathBuf::from(path)))
        })
        .await
    }
}

fn put_demo_row(connection: &Connection, demo: &DemoRecord) -> Result<()> {
    connection.execute(
        "INSERT INTO demos(id, path, file_name, display_name, source, status, map_name, match_date, created_at, updated_at, content_sha256, document_json) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, file_name = excluded.file_name, \
         display_name = excluded.display_name, source = excluded.source, status = excluded.status, \
         map_name = excluded.map_name, match_date = excluded.match_date, created_at = excluded.created_at, \
         updated_at = excluded.updated_at, \
         content_sha256 = excluded.content_sha256, document_json = excluded.document_json",
        params![
            demo.id.to_string(),
            demo.path,
            demo.file_name,
            demo.display_name,
            demo.source,
            status_text(demo.status),
            demo.map_name,
            demo.match_date.map(|date| date.to_rfc3339()),
            demo.created_at.to_rfc3339(),
            demo.updated_at.to_rfc3339(),
            demo.content_sha256,
            encode(demo)?
        ],
    )?;
    Ok(())
}

fn get_steam_match_document(connection: &Connection, id: &str) -> Result<Option<SteamMatchRecord>> {
    let json = connection
        .query_row(
            "SELECT document_json FROM steam_matches WHERE id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    json.map(|json| decode(&json)).transpose()
}

fn put_steam_match_row(connection: &Connection, record: &SteamMatchRecord) -> Result<()> {
    connection.execute(
        "INSERT INTO steam_matches(id, steam_id, match_id, synced_at, updated_at, document_json) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(id) DO UPDATE SET steam_id = excluded.steam_id, \
         match_id = excluded.match_id, synced_at = excluded.synced_at, \
         updated_at = excluded.updated_at, document_json = excluded.document_json",
        params![
            record.id,
            record.steam_id,
            record.match_id,
            record.synced_at.to_rfc3339(),
            record.updated_at.to_rfc3339(),
            encode(record)?
        ],
    )?;
    Ok(())
}

fn put_match_download_job_row(connection: &Connection, job: &MatchDownloadJob) -> Result<()> {
    connection.execute(
        "INSERT INTO match_download_jobs(id, match_record_id, status, updated_at, document_json) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(id) DO UPDATE SET match_record_id = excluded.match_record_id, \
         status = excluded.status, updated_at = excluded.updated_at, \
         document_json = excluded.document_json",
        params![
            job.id.to_string(),
            job.match_record_id,
            match_download_status_text(job.status),
            job.updated_at.to_rfc3339(),
            encode(job)?
        ],
    )?;
    Ok(())
}

const fn match_download_stage(status: MatchDownloadStatus) -> Option<u8> {
    match status {
        MatchDownloadStatus::Queued => Some(0),
        MatchDownloadStatus::Downloading => Some(1),
        MatchDownloadStatus::Decompressing => Some(2),
        MatchDownloadStatus::Importing => Some(3),
        MatchDownloadStatus::Completed
        | MatchDownloadStatus::Cancelling
        | MatchDownloadStatus::Cancelled
        | MatchDownloadStatus::Failed => None,
    }
}

fn match_download_update_is_monotonic(
    current: MatchDownloadStatus,
    proposed: MatchDownloadStatus,
) -> bool {
    if current.is_terminal() || current == MatchDownloadStatus::Cancelling {
        return false;
    }
    match (
        match_download_stage(current),
        match_download_stage(proposed),
    ) {
        (Some(current), Some(proposed)) => proposed >= current,
        (Some(_), None) | (None, _) => false,
    }
}

fn merge_match_download_progress(
    mut proposed: MatchDownloadJob,
    current: &MatchDownloadJob,
) -> MatchDownloadJob {
    proposed.created_at = current.created_at;
    proposed.downloaded_bytes = proposed.downloaded_bytes.max(current.downloaded_bytes);
    proposed.total_bytes = proposed.total_bytes.or(current.total_bytes);
    proposed.progress = proposed.progress.max(current.progress);
    if proposed.updated_at < current.updated_at {
        proposed.updated_at = current.updated_at;
    }
    proposed
}

fn demo_catalog_identity(demo: &DemoRecord) -> DemoCatalogIdentity {
    DemoCatalogIdentity {
        id: demo.id,
        path: demo.path.clone(),
        status: demo.status,
        content_sha256: demo.content_sha256.clone(),
        file_size: demo.file_size,
        updated_at: demo.updated_at,
    }
}

fn demo_catalog_identity_matches(expected: &DemoCatalogIdentity, current: &DemoRecord) -> bool {
    expected.id == current.id
        && expected.path == current.path
        && expected.status == current.status
        && expected.content_sha256 == current.content_sha256
        && expected.file_size == current.file_size
        && expected.updated_at == current.updated_at
}

fn merge_trusted_match_date(
    demo: &mut DemoRecord,
    trusted_match_date: Option<DateTime<Utc>>,
) -> Result<bool> {
    match (demo.match_date.as_ref(), trusted_match_date) {
        (Some(existing), Some(trusted)) if existing != &trusted => {
            Err(vibe_cs_domain::DomainError::Conflict(
                "trusted match date conflicts with the cataloged Demo".to_owned(),
            )
            .into())
        }
        (None, Some(trusted)) => {
            demo.match_date = Some(trusted);
            demo.updated_at = Utc::now();
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn merge_trusted_steam_match_date(
    current: Option<DateTime<Utc>>,
    incoming: Option<DateTime<Utc>>,
) -> Result<Option<DateTime<Utc>>> {
    match (current, incoming) {
        (Some(current), Some(incoming)) if current != incoming => {
            Err(vibe_cs_domain::DomainError::Conflict(
                "Steam match already has a different trusted match date".to_owned(),
            )
            .into())
        }
        (Some(current), _) => Ok(Some(current)),
        (None, incoming) => Ok(incoming),
    }
}

fn put_asset_row(connection: &Connection, asset: &MediaAsset) -> Result<()> {
    connection.execute(
        "INSERT INTO media_assets(id, project_id, kind, name, path, created_at, document_json) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, kind = excluded.kind, \
         name = excluded.name, path = excluded.path, document_json = excluded.document_json",
        params![
            asset.id.to_string(),
            asset.project_id.map(|id| id.to_string()),
            asset.kind,
            asset.name,
            asset.path,
            asset.created_at.to_rfc3339(),
            encode(asset)?
        ],
    )?;
    Ok(())
}

fn reconcile_evidence_projections(connection: &mut Connection) -> Result<()> {
    let stale = {
        let mut statement = connection.prepare(
            "SELECT a.document_json, a.updated_at \
             FROM analyses AS a \
             LEFT JOIN evidence_search_projection_state AS s ON s.demo_id = a.demo_id \
             WHERE s.demo_id IS NULL \
                OR s.analysis_updated_at <> a.updated_at \
                OR s.indexed_items <> (\
                    SELECT COUNT(*) FROM evidence_search_items AS i WHERE i.demo_id = a.demo_id\
                )",
        )?;
        let mut rows = statement.query([])?;
        let mut stale = Vec::new();
        while let Some(row) = rows.next()? {
            stale.push((
                decode::<MatchAnalysis>(&row.get::<_, String>(0)?)?,
                row.get::<_, String>(1)?,
            ));
        }
        stale
    };
    if stale.is_empty() {
        return Ok(());
    }
    let transaction = connection.transaction()?;
    for (analysis, updated_at) in stale {
        replace_evidence_projection(&transaction, &analysis, &updated_at)?;
    }
    transaction.commit()?;
    Ok(())
}

fn replace_evidence_projection(
    transaction: &rusqlite::Transaction<'_>,
    analysis: &MatchAnalysis,
    analysis_updated_at: &str,
) -> Result<()> {
    let item_count = analysis
        .rounds
        .iter()
        .try_fold(analysis.highlights.len(), |count, round| {
            count.checked_add(round.events.len())
        })
        .ok_or_else(|| evidence_projection_error("analysis evidence count overflowed"))?;
    if item_count > MAX_EVIDENCE_ITEMS_PER_ANALYSIS {
        return Err(evidence_projection_error(format!(
            "analysis {} contains {item_count} evidence items; maximum is {MAX_EVIDENCE_ITEMS_PER_ANALYSIS}",
            analysis.demo_id
        )));
    }
    validate_projection_text("map name", &analysis.map_name, 128, false)?;
    let player_names = analysis
        .players
        .iter()
        .map(|player| (player.steam_id.as_str(), player.name.as_str()))
        .collect::<BTreeMap<_, _>>();
    let demo_id = analysis.demo_id.to_string();
    let map_key = search_key(&analysis.map_name);

    transaction.execute(
        "DELETE FROM evidence_search_items WHERE demo_id = ?1",
        [&demo_id],
    )?;
    let mut insert_item = transaction.prepare(
        "INSERT INTO evidence_search_items(\
             evidence_id, demo_id, source_kind, source_id, event_family, event_type, \
             map_name, map_key, round, tick, end_tick, actor_id, actor_name, actor_id_key, \
             actor_name_key, target_id, target_name, target_id_key, target_name_key, \
             actor_x, actor_y, actor_z, target_x, target_y, target_z, weapon, weapon_key, \
             headshot, penetrated, attributes_json, search_text\
         ) VALUES (\
             ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, \
             ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, \
             ?30, ?31\
         )",
    )?;
    let mut insert_victim = transaction.prepare(
        "INSERT INTO evidence_search_victims(\
             evidence_id, position, victim_id, victim_name, victim_id_key, victim_name_key\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;

    for round in &analysis.rounds {
        for event in &round.events {
            validate_source_id(&event.id)?;
            let event_type = event_kind_text(event.kind);
            let event_family = event_family_for_event(event.kind);
            let evidence_id = format!("demo:{demo_id}/event:{}", event.id);
            let actor_name = event
                .actor
                .as_deref()
                .and_then(|id| player_names.get(id).copied());
            let target_name = event
                .target
                .as_deref()
                .and_then(|id| player_names.get(id).copied());
            let attributes = event.position.map_or_else(
                || serde_json::json!({}),
                |position| serde_json::json!({ "position": position }),
            );
            let search_text = evidence_search_text([
                Some(analysis.map_name.as_str()),
                Some(event_type),
                event.actor.as_deref(),
                actor_name,
                event.target.as_deref(),
                target_name,
                event.weapon.as_deref(),
            ]);
            let is_kill = event.kind == EventKind::Kill;
            let (actor_position, target_position) = evidence_role_positions(event);
            insert_item.execute(params![
                evidence_id,
                demo_id,
                "event",
                event.id,
                event_family,
                event_type,
                analysis.map_name,
                map_key,
                i64::from(round.number),
                sql_u64(event.tick)?,
                sql_u64(event.tick)?,
                event.actor,
                actor_name,
                event.actor.as_deref().map(search_key),
                actor_name.map(search_key),
                event.target,
                target_name,
                event.target.as_deref().map(search_key),
                target_name.map(search_key),
                actor_position.map(|position| position[0]),
                actor_position.map(|position| position[1]),
                actor_position.map(|position| position[2]),
                target_position.map(|position| position[0]),
                target_position.map(|position| position[1]),
                target_position.map(|position| position[2]),
                event.weapon,
                event.weapon.as_deref().map(search_key),
                is_kill.then_some(i64::from(event.headshot)),
                is_kill.then_some(i64::from(event.penetrated)),
                encode(&attributes)?,
                search_text,
            ])?;
        }
    }

    for highlight in &analysis.highlights {
        validate_source_id(&highlight.id)?;
        validate_projection_text("highlight title", &highlight.title, 512, true)?;
        validate_projection_text("highlight description", &highlight.description, 2_048, true)?;
        if highlight.tags.len() > 64 || highlight.victims.len() > 64 {
            return Err(evidence_projection_error(format!(
                "highlight {} exceeds the 64 tag/victim projection limit",
                highlight.id
            )));
        }
        let evidence_id = format!("demo:{demo_id}/highlight:{}", highlight.id);
        let event_type = highlight_kind_text(highlight.kind);
        let event_family = event_family_for_highlight(highlight.kind);
        let actor_name = player_names.get(highlight.player_id.as_str()).copied();
        let victim_names = highlight
            .victims
            .iter()
            .map(|id| player_names.get(id.as_str()).copied())
            .collect::<Vec<_>>();
        let attributes = serde_json::json!({
            "title": highlight.title,
            "description": highlight.description,
            "score": highlight.score,
            "tags": highlight.tags,
            "victim_ids": highlight.victims,
            "victim_names": victim_names,
        });
        let mut search_parts = vec![
            analysis.map_name.as_str(),
            event_type,
            highlight.player_id.as_str(),
            highlight.title.as_str(),
            highlight.description.as_str(),
        ];
        search_parts.extend(actor_name);
        search_parts.extend(highlight.tags.iter().map(String::as_str));
        search_parts.extend(highlight.victims.iter().map(String::as_str));
        search_parts.extend(victim_names.iter().flatten().copied());
        insert_item.execute(params![
            evidence_id,
            demo_id,
            "highlight",
            highlight.id,
            event_family,
            event_type,
            analysis.map_name,
            map_key,
            i64::from(highlight.round),
            sql_u64(highlight.start_tick)?,
            sql_u64(highlight.end_tick)?,
            highlight.player_id,
            actor_name,
            search_key(&highlight.player_id),
            actor_name.map(search_key),
            Option::<String>::None,
            Option::<String>::None,
            Option::<f64>::None,
            Option::<f64>::None,
            Option::<f64>::None,
            Option::<f64>::None,
            Option::<f64>::None,
            Option::<f64>::None,
            Option::<String>::None,
            Option::<String>::None,
            Option::<String>::None,
            Option::<String>::None,
            Option::<i64>::None,
            Option::<i64>::None,
            encode(&attributes)?,
            evidence_search_text(search_parts.into_iter().map(Some)),
        ])?;
        for (position, (victim_id, victim_name)) in highlight
            .victims
            .iter()
            .zip(victim_names.iter())
            .enumerate()
        {
            insert_victim.execute(params![
                evidence_id,
                i64::try_from(position)
                    .map_err(|_| evidence_projection_error("victim position overflowed"))?,
                victim_id,
                victim_name,
                search_key(victim_id),
                victim_name.map(search_key),
            ])?;
        }
    }
    drop(insert_victim);
    drop(insert_item);
    transaction.execute(
        "INSERT INTO evidence_search_projection_state(\
             demo_id, analysis_updated_at, indexed_items\
         ) VALUES (?1, ?2, ?3) \
         ON CONFLICT(demo_id) DO UPDATE SET \
             analysis_updated_at = excluded.analysis_updated_at, \
             indexed_items = excluded.indexed_items",
        params![
            demo_id,
            analysis_updated_at,
            i64::try_from(item_count)
                .map_err(|_| evidence_projection_error("evidence item count overflowed"))?,
        ],
    )?;
    Ok(())
}

fn evidence_role_positions(event: &TimelineEvent) -> (Option<[f64; 3]>, Option<[f64; 3]>) {
    let actor = (event.kind == EventKind::Kill)
        .then(|| evidence_detail_position(event, "attacker"))
        .flatten();
    let target = matches!(event.kind, EventKind::Kill | EventKind::Damage)
        .then(|| {
            evidence_detail_position(event, "user").or_else(|| {
                let has_attacker_position = ["attacker_X", "attacker_Y", "attacker_Z"]
                    .into_iter()
                    .any(|key| event.detail.get(key).is_some());
                (!has_attacker_position)
                    .then_some(event.position)
                    .flatten()
                    .filter(|position| position.iter().all(|coordinate| coordinate.is_finite()))
            })
        })
        .flatten();
    (actor, target)
}

fn evidence_detail_position(event: &TimelineEvent, role: &str) -> Option<[f64; 3]> {
    let coordinate = |axis: char| {
        event
            .detail
            .get(format!("{role}_{axis}"))
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite())
    };
    Some([coordinate('X')?, coordinate('Y')?, coordinate('Z')?])
}

const EVIDENCE_SEARCH_WHERE_SQL: &str = " WHERE NOT EXISTS (\
        SELECT 1 FROM json_each(:q_tokens) AS q \
        WHERE instr(i.search_text, CAST(q.value AS TEXT)) = 0\
    ) \
    AND (:event_family IS NULL OR i.event_family = :event_family) \
    AND (:actor IS NULL OR i.actor_id_key = :actor OR i.actor_name_key = :actor) \
    AND (:victim IS NULL OR i.target_id_key = :victim OR i.target_name_key = :victim \
         OR EXISTS (SELECT 1 FROM evidence_search_victims AS v \
                    WHERE v.evidence_id = i.evidence_id \
                    AND (v.victim_id_key = :victim OR v.victim_name_key = :victim))) \
    AND (:player IS NULL OR i.actor_id_key = :player OR i.actor_name_key = :player \
         OR i.target_id_key = :player OR i.target_name_key = :player \
         OR EXISTS (SELECT 1 FROM evidence_search_victims AS v \
                    WHERE v.evidence_id = i.evidence_id \
                    AND (v.victim_id_key = :player OR v.victim_name_key = :player))) \
    AND (:weapon IS NULL OR i.weapon_key = :weapon) \
    AND (:map IS NULL OR i.map_key = :map) \
    AND (:source IS NULL OR lower(trim(d.source)) = :source) \
    AND (:headshot IS NULL OR i.headshot = :headshot) \
    AND (:round IS NULL OR i.round = :round) \
    AND (:match_date_from IS NULL OR d.match_date >= :match_date_from) \
    AND (:match_date_to IS NULL OR d.match_date <= :match_date_to) \
    AND (:source_kind IS NULL OR i.source_kind = :source_kind) \
    AND (:demo_id IS NULL OR i.demo_id = :demo_id)";

fn search_evidence_rows(
    connection: &Connection,
    query: &EvidenceSearchQuery,
) -> Result<EvidenceSearchPage> {
    query.validate()?;
    let page = query.page.unwrap_or(1);
    let page_size = query
        .page_size
        .unwrap_or(vibe_cs_domain::EVIDENCE_SEARCH_DEFAULT_PAGE_SIZE);
    let q_tokens = query
        .q
        .as_deref()
        .unwrap_or_default()
        .split_whitespace()
        .map(search_key)
        .collect::<Vec<_>>();
    let q_tokens = encode(&q_tokens)?;
    let event_family = query.event_family.map(event_family_text);
    let actor = query.actor.as_deref().map(search_key);
    let victim = query.victim.as_deref().map(search_key);
    let player = query.player.as_deref().map(search_key);
    let weapon = query.weapon.as_deref().map(search_key);
    let map = query.map.as_deref().map(search_key);
    let source = query.source.as_deref().map(search_key);
    let headshot = query.headshot.map(i64::from);
    let round = query.round.map(i64::from);
    let match_date_from = query.match_date_from.as_ref().map(DateTime::to_rfc3339);
    let match_date_to = query.match_date_to.as_ref().map(DateTime::to_rfc3339);
    let source_kind = query.source_kind.map(source_kind_text);
    let demo_id = query.demo_id.map(|id| id.to_string());
    let offset = u64::from(page - 1) * u64::from(page_size);
    let total = connection.query_row(
        &format!(
            "SELECT COUNT(*) FROM evidence_search_items AS i \
             INNER JOIN demos AS d ON d.id = i.demo_id{EVIDENCE_SEARCH_WHERE_SQL}"
        ),
        rusqlite::named_params! {
            ":q_tokens": q_tokens,
            ":event_family": event_family,
            ":actor": actor,
            ":victim": victim,
            ":player": player,
            ":weapon": weapon,
            ":map": map,
            ":source": source,
            ":headshot": headshot,
            ":round": round,
            ":match_date_from": match_date_from,
            ":match_date_to": match_date_to,
            ":source_kind": source_kind,
            ":demo_id": demo_id,
        },
        |row| row_u64(row, 0),
    )?;
    let mut statement = connection.prepare(&format!(
        "SELECT i.evidence_id, i.demo_id, d.display_name, i.map_name, d.match_date, \
                i.round, i.tick, i.end_tick, i.event_type, i.actor_id, i.actor_name, \
                i.target_id, i.target_name, i.weapon, i.headshot, i.penetrated, \
                i.source_kind, i.source_id, i.attributes_json \
         FROM evidence_search_items AS i \
         INNER JOIN demos AS d ON d.id = i.demo_id{EVIDENCE_SEARCH_WHERE_SQL} \
         ORDER BY (d.match_date IS NULL) ASC, d.match_date DESC, d.updated_at DESC, \
                  i.demo_id ASC, i.round ASC, i.tick ASC, i.source_kind ASC, i.source_id ASC \
         LIMIT :page_size OFFSET :offset"
    ))?;
    let mut rows = statement.query(rusqlite::named_params! {
        ":q_tokens": q_tokens,
        ":event_family": event_family,
        ":actor": actor,
        ":victim": victim,
        ":player": player,
        ":weapon": weapon,
        ":map": map,
        ":source": source,
        ":headshot": headshot,
        ":round": round,
        ":match_date_from": match_date_from,
        ":match_date_to": match_date_to,
        ":source_kind": source_kind,
        ":demo_id": demo_id,
        ":page_size": i64::from(page_size),
        ":offset": sql_u64(offset)?,
    })?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        let evidence_id = row.get::<_, String>(0)?;
        let demo_id_text = row.get::<_, String>(1)?;
        let item_demo_id = Uuid::parse_str(&demo_id_text).map_err(|error| {
            evidence_projection_error(format!("invalid projected demo id: {error}"))
        })?;
        let match_date = row
            .get::<_, Option<String>>(4)?
            .map(|date| {
                DateTime::parse_from_rfc3339(&date)
                    .map(|value| value.with_timezone(&Utc))
                    .map_err(|error| {
                        evidence_projection_error(format!("invalid projected match date: {error}"))
                    })
            })
            .transpose()?;
        let item_round_u64 = row_u64(row, 5)?;
        let item_round = u32::try_from(item_round_u64)
            .map_err(|_| StorageError::IntegerOutOfRange(item_round_u64))?;
        let tick = row_u64(row, 6)?;
        let end_tick = row_u64(row, 7)?;
        let actor_id = row.get::<_, Option<String>>(9)?;
        let source_kind_text = row.get::<_, String>(16)?;
        let source_kind = parse_source_kind(&source_kind_text)?;
        let attributes = decode(&row.get::<_, String>(18)?)?;
        let analysis_href = evidence_href(
            item_demo_id,
            "rounds",
            item_round,
            tick,
            &evidence_id,
            actor_id.as_deref(),
        );
        let replay_href = evidence_href(
            item_demo_id,
            "replay",
            item_round,
            tick,
            &evidence_id,
            actor_id.as_deref(),
        );
        items.push(EvidenceSearchItem {
            evidence_id,
            demo_id: item_demo_id,
            demo_display_name: row.get(2)?,
            map_name: row.get(3)?,
            match_date,
            round: item_round,
            tick,
            end_tick,
            event_type: row.get(8)?,
            actor_id,
            actor_name: row.get(10)?,
            target_id: row.get(11)?,
            target_name: row.get(12)?,
            weapon: row.get(13)?,
            headshot: row.get::<_, Option<i64>>(14)?.map(|value| value != 0),
            penetrated: row.get::<_, Option<i64>>(15)?.map(|value| value != 0),
            source_kind,
            source_id: row.get(17)?,
            attributes,
            analysis_href,
            replay_href,
        });
    }
    drop(rows);
    drop(statement);

    let indexed_items =
        connection.query_row("SELECT COUNT(*) FROM evidence_search_items", [], |row| {
            row_u64(row, 0)
        })?;
    let dated_items = connection.query_row(
        "SELECT COUNT(*) FROM evidence_search_items AS i \
         INNER JOIN demos AS d ON d.id = i.demo_id WHERE d.match_date IS NOT NULL",
        [],
        |row| row_u64(row, 0),
    )?;
    let sourced_items = connection.query_row(
        "SELECT COUNT(*) FROM evidence_search_items AS i \
         INNER JOIN demos AS d ON d.id = i.demo_id WHERE trim(d.source) <> ''",
        [],
        |row| row_u64(row, 0),
    )?;
    let total_analyses =
        connection.query_row("SELECT COUNT(*) FROM analyses", [], |row| row_u64(row, 0))?;
    let indexed_demos = connection.query_row(
        "SELECT COUNT(*) FROM analyses AS a \
         INNER JOIN evidence_search_projection_state AS s ON s.demo_id = a.demo_id \
         WHERE s.analysis_updated_at = a.updated_at \
           AND s.indexed_items = (\
               SELECT COUNT(*) FROM evidence_search_items AS i WHERE i.demo_id = a.demo_id\
           )",
        [],
        |row| row_u64(row, 0),
    )?;
    Ok(EvidenceSearchPage {
        items,
        total,
        page,
        page_size,
        availability: EvidenceSearchAvailability {
            indexed_items,
            indexed_demos,
            total_analyses,
            scan_complete: indexed_demos == total_analyses,
            match_date: evidence_capability(
                dated_items,
                "No indexed evidence is linked to a trusted match date",
            ),
            source: evidence_capability(
                sourced_items,
                "No indexed evidence is linked to a trusted demo source",
            ),
        },
    })
}

fn evidence_capability(indexed_items: u64, unavailable_reason: &str) -> EvidenceSearchCapability {
    EvidenceSearchCapability {
        available: indexed_items > 0,
        indexed_items,
        reason: (indexed_items == 0).then(|| unavailable_reason.to_owned()),
    }
}

fn evidence_href(
    demo_id: Uuid,
    tab: &str,
    round: u32,
    tick: u64,
    evidence_id: &str,
    actor_id: Option<&str>,
) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("demo", &demo_id.to_string());
    query.append_pair("tab", tab);
    query.append_pair("round", &round.to_string());
    query.append_pair("tick", &tick.to_string());
    query.append_pair("evidence", evidence_id);
    if let Some(actor_id) = actor_id {
        query.append_pair("player", actor_id);
    }
    format!("/analysis?{}", query.finish())
}

fn evidence_search_text<'a>(parts: impl IntoIterator<Item = Option<&'a str>>) -> String {
    parts
        .into_iter()
        .flatten()
        .map(search_key)
        .collect::<Vec<_>>()
        .join(" ")
}

fn search_key(value: &str) -> String {
    value.trim().to_lowercase()
}

fn validate_source_id(source_id: &str) -> Result<()> {
    validate_projection_text(
        "evidence source id",
        source_id,
        MAX_EVIDENCE_SOURCE_ID_CHARS,
        false,
    )?;
    if !source_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(evidence_projection_error(format!(
            "evidence source id {source_id:?} contains an unsafe character"
        )));
    }
    Ok(())
}

fn validate_projection_text(
    field: &str,
    value: &str,
    maximum_chars: usize,
    allow_empty: bool,
) -> Result<()> {
    let length = value.chars().count();
    if (!allow_empty && value.trim().is_empty()) || length > maximum_chars {
        return Err(evidence_projection_error(format!(
            "{field} must contain {} to {maximum_chars} characters",
            usize::from(!allow_empty)
        )));
    }
    Ok(())
}

fn evidence_projection_error(message: impl Into<String>) -> StorageError {
    StorageError::EvidenceProjection(message.into())
}

const fn event_kind_text(kind: EventKind) -> &'static str {
    match kind {
        EventKind::RoundStart => "round_start",
        EventKind::RoundEnd => "round_end",
        EventKind::Kill => "kill",
        EventKind::Damage => "damage",
        EventKind::BombPlant => "bomb_plant",
        EventKind::BombDefuse => "bomb_defuse",
        EventKind::BombExplode => "bomb_explode",
        EventKind::Grenade => "grenade",
        EventKind::Purchase => "purchase",
    }
}

const fn highlight_kind_text(kind: HighlightKind) -> &'static str {
    match kind {
        HighlightKind::MultiKill => "multi_kill",
        HighlightKind::Clutch => "clutch",
        HighlightKind::OneTap => "one_tap",
        HighlightKind::Wallbang => "wallbang",
        HighlightKind::NoScope => "no_scope",
        HighlightKind::Knife => "knife",
        HighlightKind::Taser => "taser",
        HighlightKind::Defuse => "defuse",
        HighlightKind::Fail => "fail",
        HighlightKind::Timeline => "timeline",
    }
}

const fn event_family_for_event(kind: EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Kill => Some("kill"),
        EventKind::BombPlant | EventKind::BombDefuse | EventKind::BombExplode => Some("objective"),
        EventKind::RoundStart => Some("round_start"),
        EventKind::RoundEnd | EventKind::Damage | EventKind::Grenade | EventKind::Purchase => None,
    }
}

const fn event_family_for_highlight(kind: HighlightKind) -> Option<&'static str> {
    match kind {
        HighlightKind::MultiKill => Some("multi_kill"),
        HighlightKind::Defuse => Some("objective"),
        HighlightKind::Clutch
        | HighlightKind::OneTap
        | HighlightKind::Wallbang
        | HighlightKind::NoScope
        | HighlightKind::Knife
        | HighlightKind::Taser
        | HighlightKind::Fail
        | HighlightKind::Timeline => None,
    }
}

const fn event_family_text(family: EvidenceEventFamily) -> &'static str {
    match family {
        EvidenceEventFamily::Kill => "kill",
        EvidenceEventFamily::MultiKill => "multi_kill",
        EvidenceEventFamily::Objective => "objective",
        EvidenceEventFamily::RoundStart => "round_start",
    }
}

const fn source_kind_text(kind: EvidenceSourceKind) -> &'static str {
    match kind {
        EvidenceSourceKind::Event => "event",
        EvidenceSourceKind::Highlight => "highlight",
    }
}

fn parse_source_kind(value: &str) -> Result<EvidenceSourceKind> {
    match value {
        "event" => Ok(EvidenceSourceKind::Event),
        "highlight" => Ok(EvidenceSourceKind::Highlight),
        _ => Err(evidence_projection_error(format!(
            "unknown projected evidence source kind {value:?}"
        ))),
    }
}

fn get_document<T: DeserializeOwned>(
    connection: &Connection,
    table: &str,
    id: Uuid,
) -> Result<Option<T>> {
    let json = connection
        .query_row(
            &format!("SELECT document_json FROM {table} WHERE id = ?1"),
            [id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    json.map(|json| decode(&json)).transpose()
}

fn collect_documents<T: DeserializeOwned>(rows: &mut rusqlite::Rows<'_>) -> Result<Vec<T>> {
    let mut documents = Vec::new();
    while let Some(row) = rows.next()? {
        documents.push(decode(&row.get::<_, String>(0)?)?);
    }
    Ok(documents)
}

fn encode<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn decode<T: DeserializeOwned>(value: &str) -> Result<T> {
    Ok(serde_json::from_str(value)?)
}

fn status_text(status: DemoStatus) -> &'static str {
    match status {
        DemoStatus::Discovered => "discovered",
        DemoStatus::Indexing => "indexing",
        DemoStatus::Ready => "ready",
        DemoStatus::Analyzing => "analyzing",
        DemoStatus::Failed => "failed",
        DemoStatus::Missing => "missing",
    }
}

fn match_source_text(source: DemoMatchSource) -> &'static str {
    match source {
        DemoMatchSource::Challengermode => "challengermode",
        DemoMatchSource::Ebot => "ebot",
        DemoMatchSource::Esl => "esl",
        DemoMatchSource::Esplay => "esplay",
        DemoMatchSource::Esportal => "esportal",
        DemoMatchSource::Esportligaen => "esportligaen",
        DemoMatchSource::Faceit => "faceit",
        DemoMatchSource::Fastcup => "fastcup",
        DemoMatchSource::FiveEplay => "five_eplay",
        DemoMatchSource::Matchzy => "matchzy",
        DemoMatchSource::PerfectWorld => "perfect_world",
        DemoMatchSource::Pracc => "pracc",
        DemoMatchSource::Renown => "renown",
        DemoMatchSource::Valve => "valve",
    }
}

fn parse_match_source(value: &str) -> rusqlite::Result<DemoMatchSource> {
    match value {
        "challengermode" => Ok(DemoMatchSource::Challengermode),
        "ebot" => Ok(DemoMatchSource::Ebot),
        "esl" => Ok(DemoMatchSource::Esl),
        "esplay" => Ok(DemoMatchSource::Esplay),
        "esportal" => Ok(DemoMatchSource::Esportal),
        "esportligaen" => Ok(DemoMatchSource::Esportligaen),
        "faceit" => Ok(DemoMatchSource::Faceit),
        "fastcup" => Ok(DemoMatchSource::Fastcup),
        "five_eplay" => Ok(DemoMatchSource::FiveEplay),
        "matchzy" => Ok(DemoMatchSource::Matchzy),
        "perfect_world" => Ok(DemoMatchSource::PerfectWorld),
        "pracc" => Ok(DemoMatchSource::Pracc),
        "renown" => Ok(DemoMatchSource::Renown),
        "valve" => Ok(DemoMatchSource::Valve),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("invalid demo match source {other}").into(),
        )),
    }
}

fn parse_repository_datetime(value: &str) -> rusqlite::Result<DateTime<Utc>> {
    value.parse().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn read_demo_tag(row: &rusqlite::Row<'_>) -> rusqlite::Result<DemoTag> {
    let id = row.get::<_, String>(0)?;
    Ok(DemoTag {
        id: Uuid::parse_str(&id).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: parse_repository_datetime(&row.get::<_, String>(3)?)?,
        updated_at: parse_repository_datetime(&row.get::<_, String>(4)?)?,
    })
}

fn read_demo_metadata(connection: &Connection, demo_id: Uuid) -> Result<Option<DemoMetadata>> {
    let Some(demo) = get_document::<DemoRecord>(connection, "demos", demo_id)? else {
        return Ok(None);
    };
    let stored = connection
        .query_row(
            "SELECT match_source, updated_at FROM demo_metadata WHERE demo_id = ?1",
            [demo_id.to_string()],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let (match_source, updated_at) = match stored {
        Some((source, updated_at)) => (
            source.as_deref().map(parse_match_source).transpose()?,
            parse_repository_datetime(&updated_at)?,
        ),
        None => (None, demo.updated_at),
    };
    let mut statement = connection.prepare(
        "SELECT tag.id, tag.name, tag.color, tag.created_at, tag.updated_at \
         FROM demo_tag_assignments AS assignment \
         INNER JOIN review_tags AS tag ON tag.id = assignment.tag_id \
         WHERE assignment.demo_id = ?1 ORDER BY assignment.position ASC",
    )?;
    let tags = statement
        .query_map([demo_id.to_string()], read_demo_tag)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Some(DemoMetadata {
        demo_id,
        match_source,
        comment: demo.remark,
        tags,
        updated_at,
    }))
}

const fn demo_order_sql(sort: DemoSort) -> &'static str {
    match sort {
        DemoSort::UpdatedDesc => "updated_at DESC, id ASC",
        DemoSort::UpdatedAsc => "updated_at ASC, id ASC",
        DemoSort::FileAsc => "file_name COLLATE NOCASE ASC, id ASC",
        DemoSort::FileDesc => "file_name COLLATE NOCASE DESC, id ASC",
        DemoSort::StatusAsc => "status COLLATE NOCASE ASC, id ASC",
        DemoSort::StatusDesc => "status COLLATE NOCASE DESC, id ASC",
        DemoSort::MapAsc => {
            "CASE WHEN map_name IS NULL OR trim(map_name) = '' THEN 1 ELSE 0 END ASC, map_name COLLATE NOCASE ASC, id ASC"
        }
        DemoSort::MapDesc => {
            "CASE WHEN map_name IS NULL OR trim(map_name) = '' THEN 1 ELSE 0 END ASC, map_name COLLATE NOCASE DESC, id ASC"
        }
        DemoSort::ScoreAsc => {
            "CASE WHEN status != 'ready' OR json_extract(document_json, '$.team_a_score') IS NULL OR json_extract(document_json, '$.team_b_score') IS NULL OR trim(coalesce(json_extract(document_json, '$.team_a_name'), '')) = '' OR trim(coalesce(json_extract(document_json, '$.team_b_name'), '')) = '' THEN 1 ELSE 0 END ASC, (json_extract(document_json, '$.team_a_score') + json_extract(document_json, '$.team_b_score')) ASC, id ASC"
        }
        DemoSort::ScoreDesc => {
            "CASE WHEN status != 'ready' OR json_extract(document_json, '$.team_a_score') IS NULL OR json_extract(document_json, '$.team_b_score') IS NULL OR trim(coalesce(json_extract(document_json, '$.team_a_name'), '')) = '' OR trim(coalesce(json_extract(document_json, '$.team_b_name'), '')) = '' THEN 1 ELSE 0 END ASC, (json_extract(document_json, '$.team_a_score') + json_extract(document_json, '$.team_b_score')) DESC, id ASC"
        }
        DemoSort::DurationAsc => {
            "CASE WHEN coalesce(json_extract(document_json, '$.duration_seconds'), 0) <= 0 THEN 1 ELSE 0 END ASC, json_extract(document_json, '$.duration_seconds') ASC, id ASC"
        }
        DemoSort::DurationDesc => {
            "CASE WHEN coalesce(json_extract(document_json, '$.duration_seconds'), 0) <= 0 THEN 1 ELSE 0 END ASC, json_extract(document_json, '$.duration_seconds') DESC, id ASC"
        }
        DemoSort::RoundsAsc => {
            "CASE WHEN coalesce(json_extract(document_json, '$.total_rounds'), 0) <= 0 THEN 1 ELSE 0 END ASC, json_extract(document_json, '$.total_rounds') ASC, id ASC"
        }
        DemoSort::RoundsDesc => {
            "CASE WHEN coalesce(json_extract(document_json, '$.total_rounds'), 0) <= 0 THEN 1 ELSE 0 END ASC, json_extract(document_json, '$.total_rounds') DESC, id ASC"
        }
    }
}

fn job_status_text(status: vibe_cs_domain::JobStatus) -> &'static str {
    use vibe_cs_domain::JobStatus;
    match status {
        JobStatus::Queued => "queued",
        JobStatus::Preparing => "preparing",
        JobStatus::Running => "running",
        JobStatus::Cancelling => "cancelling",
        JobStatus::Completed => "completed",
        JobStatus::Failed => "failed",
        JobStatus::Cancelled => "cancelled",
    }
}

fn match_download_status_text(status: MatchDownloadStatus) -> &'static str {
    match status {
        MatchDownloadStatus::Queued => "queued",
        MatchDownloadStatus::Downloading => "downloading",
        MatchDownloadStatus::Decompressing => "decompressing",
        MatchDownloadStatus::Importing => "importing",
        MatchDownloadStatus::Completed => "completed",
        MatchDownloadStatus::Cancelling => "cancelling",
        MatchDownloadStatus::Cancelled => "cancelled",
        MatchDownloadStatus::Failed => "failed",
    }
}

fn evidence_annotation_state_text(state: EvidenceAnnotationReviewState) -> &'static str {
    match state {
        EvidenceAnnotationReviewState::Open => "open",
        EvidenceAnnotationReviewState::Resolved => "resolved",
    }
}
