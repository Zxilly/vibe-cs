#![allow(
    clippy::missing_errors_doc,
    reason = "all repository methods consistently return the documented StorageError"
)]

mod activity;
mod agent_sessions;
mod analysis_runs;
mod lineups;
mod players;
mod recording_presets;
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

use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions as CapabilityOpenOptions},
};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use ts_rs::TS;
use uuid::Uuid;
use vibe_cs_domain::{
    AppConfig, BeatAlignmentAudioBinding, BeatAlignmentAudioPlacement, BeatAlignmentDraft,
    CosmeticPlan, DEMO_MAX_PAGE, DEMO_MAX_PAGE_SIZE, DemoMatchSource, DemoMetadata,
    DemoMetadataBatchUpdate, DemoMetadataUpdate, DemoPatch, DemoQuery, DemoRecord, DemoSort,
    DemoStatus, DemoTag, DemoTagCreate, EditorAudioSeparation, EditorPresetDocument, EditorProject,
    EditorProjectSnapshot, EventKind, EvidenceAnnotation, EvidenceAnnotationQuery,
    EvidenceAnnotationReviewState, EvidenceEventFamily, EvidenceSearchAvailability,
    EvidenceSearchCapability, EvidenceSearchItem, EvidenceSearchPage, EvidenceSearchQuery,
    EvidenceSourceKind, ExportJob, HighlightEditPlan, HighlightKind, MatchAnalysis,
    MatchDownloadJob, MatchDownloadStatus, MatchHistoryQuery, MediaAsset, MediaProxyStatus,
    MontageProject, Page, RecordedClip, RecordingJob, SteamMatchRecord, TimelineEvent,
};

use crate::{Result, StorageError, schema};

/// Maximum number of editor project snapshots retained for restoration.
pub const EDITOR_PROJECT_SNAPSHOT_LIMIT: usize = 20;

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

#[derive(Debug, Clone, PartialEq)]
pub enum EditorProjectUpdate {
    Updated(EditorProject),
    NotFound,
    Conflict { current_revision: u64 },
}

#[derive(Debug, Clone, PartialEq)]
pub enum BeatAlignmentUpdate {
    Applied {
        project: Box<EditorProject>,
        applied_clip_ids: Vec<Uuid>,
        audio_track_id: Uuid,
        audio_clip_id: Uuid,
        audio_clip_inserted: bool,
    },
    ProjectNotFound,
    Conflict {
        current_revision: u64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum HighlightEditUpdate {
    Applied {
        project: EditorProject,
        inserted_clip_ids: Vec<Uuid>,
        project_created: bool,
    },
    AlreadyApplied {
        project: EditorProject,
        inserted_clip_ids: Vec<Uuid>,
        project_created: bool,
    },
    ProjectNotFound,
    Conflict {
        current_revision: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvidenceAnnotationCreate {
    Created(EvidenceAnnotation),
    EvidenceNotFound,
    EvidenceLocationMismatch,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EditorAudioSeparationResult {
    pub project: EditorProject,
    pub asset: MediaAsset,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EditorAudioSeparationUpdate {
    Applied(Box<EditorAudioSeparationResult>),
    ProjectNotFound,
    ClipNotFound,
    AssetAlreadyExists,
    AlreadySeparated { audio_clip_id: Uuid },
    Conflict { current_revision: u64 },
}

#[derive(Debug, Clone, PartialEq)]
pub enum PresetUpdate {
    Updated(PresetRecord),
    NotFound,
    Conflict { current_revision: u64 },
}

#[derive(Debug, Clone, PartialEq)]
pub enum PresetDelete {
    Deleted(PresetRecord),
    NotFound,
    Conflict { current_revision: u64 },
}

#[derive(Debug, Clone, PartialEq)]
pub enum PresetApply {
    Applied(EditorProject),
    ProjectNotFound,
    PresetNotFound,
    ClipNotFound,
    ProjectConflict { current_revision: u64 },
    PresetConflict { current_revision: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EditorProjectRevision {
    pub id: Uuid,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EditorProjectDeletion {
    Deleted(Box<EditorProjectDeletionResult>),
    NotFound { id: Uuid },
    Conflict { id: Uuid, current_revision: u64 },
    ActiveExport { id: Uuid },
    BusyAsset { project_id: Uuid, asset_id: Uuid },
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EditorProjectDeletionResult {
    pub project_ids: Vec<Uuid>,
    pub deleted_assets: Vec<MediaAsset>,
    pub preserved_shared_asset_ids: Vec<Uuid>,
    pub protected_paths: Vec<String>,
    pub file_quarantine: Option<ManagedFileQuarantine>,
    pub preserved_external_files: usize,
}

#[derive(Debug, Clone)]
pub struct ManagedFileStaging {
    pub managed_roots: Vec<PathBuf>,
    /// Trusted parent that must directly contain `quarantine_root` after
    /// resolving the path on disk.
    pub cleanup_root: PathBuf,
    pub quarantine_root: PathBuf,
}

/// Durable ownership record for files moved out of their live managed paths
/// before the corresponding database transaction committed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedFileQuarantine {
    pub id: Uuid,
    pub project_ids: Vec<Uuid>,
    pub directory: PathBuf,
    pub journal_path: PathBuf,
    pub entries: Vec<ManagedFileQuarantineEntry>,
    pub preserved_external_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedFileQuarantineEntry {
    pub original_path: PathBuf,
    pub staged_path: PathBuf,
}

struct StagedManagedFiles {
    quarantine: ManagedFileQuarantine,
    quarantine_root_dir: Dir,
    directory: Dir,
    entries: Vec<CapabilityMoveEntry>,
}

struct CapabilityMoveEntry {
    source_dir: Dir,
    source_name: OsString,
    staged_name: OsString,
}

struct CapabilityRoot {
    canonical_path: PathBuf,
    directory: Dir,
}

struct ManagedFileCapabilities {
    canonical_quarantine_root: PathBuf,
    quarantine_root_dir: Dir,
    managed_roots: Vec<CapabilityRoot>,
}

struct OpenQuarantine {
    quarantine_root_dir: Dir,
    directory: Dir,
    directory_name: OsString,
    managed_roots: Vec<CapabilityRoot>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct PresetRecord {
    pub id: Uuid,
    pub name: String,
    pub revision: u64,
    pub document: EditorPresetDocument,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorProjectDocument {
    project: EditorProject,
    snapshots: Vec<StoredEditorProjectSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredEditorProjectSnapshot {
    summary: EditorProjectSnapshot,
    project: EditorProject,
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

    pub async fn list_montage_projects(&self) -> Result<Vec<MontageProject>> {
        self.list_documents("montage_projects", "updated_at DESC")
            .await
    }

    pub async fn get_montage_project(&self, id: Uuid) -> Result<Option<MontageProject>> {
        self.run(move |connection| get_document(connection, "montage_projects", id))
            .await
    }

    pub async fn put_montage_project(&self, project: MontageProject) -> Result<MontageProject> {
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO montage_projects(id, name, updated_at, document_json) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, \
                 document_json = excluded.document_json",
                params![
                    project.id.to_string(),
                    project.name,
                    project.updated_at.to_rfc3339(),
                    encode(&project)?
                ],
            )?;
            Ok(project)
        })
        .await
    }

    pub async fn delete_montage_project(&self, id: Uuid) -> Result<bool> {
        self.delete_document("montage_projects", id).await
    }

    pub async fn list_editor_projects(&self) -> Result<Vec<EditorProject>> {
        self.run(|connection| {
            let mut statement = connection
                .prepare("SELECT document_json FROM editor_projects ORDER BY updated_at DESC")?;
            let mut rows = statement.query([])?;
            let mut projects = Vec::new();
            while let Some(row) = rows.next()? {
                projects.push(decode_editor_project_document(&row.get::<_, String>(0)?)?.project);
            }
            Ok(projects)
        })
        .await
    }

    pub async fn get_editor_project(&self, id: Uuid) -> Result<Option<EditorProject>> {
        self.run(move |connection| {
            Ok(get_editor_project_document(connection, id)?.map(|document| document.project))
        })
        .await
    }

    pub async fn put_editor_project(&self, project: EditorProject) -> Result<EditorProject> {
        self.run(move |connection| {
            let snapshots = get_editor_project_document(connection, project.id)?.map_or_else(
                Vec::new,
                |mut document| {
                    retain_snapshot(&mut document.snapshots, document.project, Utc::now());
                    document.snapshots
                },
            );
            let document = EditorProjectDocument {
                project: project.clone(),
                snapshots,
            };
            put_editor_project_row(connection, &document)?;
            Ok(project)
        })
        .await
    }

    /// Atomically saves an editor document when its persisted revision still
    /// matches the caller's base revision.
    pub async fn update_editor_project(
        &self,
        mut project: EditorProject,
        expected_revision: u64,
    ) -> Result<EditorProjectUpdate> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut document) = get_editor_project_document(&transaction, project.id)? else {
                return Ok(EditorProjectUpdate::NotFound);
            };
            if document.project.revision != expected_revision {
                return Ok(EditorProjectUpdate::Conflict {
                    current_revision: document.project.revision,
                });
            }

            let previous = document.project;
            project.revision = previous
                .revision
                .checked_add(1)
                .ok_or(StorageError::EditorProjectRevisionOverflow(project.id))?;
            project.created_at = previous.created_at;
            project.updated_at = Utc::now();
            retain_snapshot(&mut document.snapshots, previous, project.updated_at);
            document.project = project.clone();

            let changed = update_editor_project_row(&transaction, &document, expected_revision)?;
            if changed != 1 {
                let current_revision = transaction
                    .query_row(
                        "SELECT revision FROM editor_projects WHERE id = ?1",
                        [project.id.to_string()],
                        |row| row_u64(row, 0),
                    )
                    .optional()?
                    .unwrap_or(expected_revision);
                return Ok(EditorProjectUpdate::Conflict { current_revision });
            }
            transaction.commit()?;
            Ok(EditorProjectUpdate::Updated(project))
        })
        .await
    }

    /// Applies a bounded beat-alignment draft and retains the previous editor
    /// document as one snapshot in the same `SQLite` transaction.
    pub async fn apply_beat_alignment(
        &self,
        project_id: Uuid,
        expected_revision: u64,
        draft: BeatAlignmentDraft,
        audio: BeatAlignmentAudioBinding,
        placement: BeatAlignmentAudioPlacement,
    ) -> Result<BeatAlignmentUpdate> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut document) = get_editor_project_document(&transaction, project_id)? else {
                return Ok(BeatAlignmentUpdate::ProjectNotFound);
            };
            if document.project.revision != expected_revision {
                return Ok(BeatAlignmentUpdate::Conflict {
                    current_revision: document.project.revision,
                });
            }

            let Some(stored_audio) =
                get_document::<MediaAsset>(&transaction, "media_assets", audio.asset_id)?
            else {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "the selected BGM asset was removed; preview it again".to_owned(),
                )));
            };
            let stored_audio_bytes = serde_json::to_vec(&stored_audio)?;
            let mut asset_hash = Sha256::new();
            asset_hash.update(b"vibe-cs-media-asset\0");
            asset_hash.update(stored_audio_bytes);
            let stored_asset_fingerprint = hex::encode(asset_hash.finalize());
            if stored_audio.id != audio.asset_id
                || stored_audio.name != audio.name
                || stored_audio.kind != audio.kind
                || stored_audio.file_size != audio.file_size
                || stored_audio.duration_seconds != Some(audio.duration_seconds)
                || stored_asset_fingerprint != audio.asset_fingerprint
            {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "the selected BGM asset changed; preview it again".to_owned(),
                )));
            }

            let previous = document.project.clone();
            let (applied_clip_ids, audio_clip_inserted) = document
                .project
                .apply_beat_alignment_with_audio(&draft, &audio, &placement)?;
            document.project.revision = previous
                .revision
                .checked_add(1)
                .ok_or(StorageError::EditorProjectRevisionOverflow(project_id))?;
            document.project.created_at = previous.created_at;
            document.project.updated_at = Utc::now();
            retain_snapshot(
                &mut document.snapshots,
                previous,
                document.project.updated_at,
            );
            let changed = update_editor_project_row(&transaction, &document, expected_revision)?;
            if changed != 1 {
                let current_revision = transaction
                    .query_row(
                        "SELECT revision FROM editor_projects WHERE id = ?1",
                        [project_id.to_string()],
                        |row| row_u64(row, 0),
                    )
                    .optional()?
                    .unwrap_or(expected_revision);
                return Ok(BeatAlignmentUpdate::Conflict { current_revision });
            }
            transaction.commit()?;
            Ok(BeatAlignmentUpdate::Applied {
                project: Box::new(document.project),
                applied_clip_ids,
                audio_track_id: placement.track_id,
                audio_clip_id: placement.clip_id,
                audio_clip_inserted,
            })
        })
        .await
    }

    /// Applies a confirmed highlight sequence with its recorded-source checks,
    /// project compare-and-swap, and before-snapshot in one `SQLite` transaction.
    /// The create-new branch inserts the complete project without an
    /// intermediate empty document.
    pub async fn apply_highlight_edit(
        &self,
        plan: HighlightEditPlan,
        proposal_fingerprint: String,
    ) -> Result<HighlightEditUpdate> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            verify_highlight_recordings(&transaction, &plan)?;
            let existing = get_editor_project_document(&transaction, plan.project_id)?;
            if let Some(mut document) = existing {
                if highlight_edit_already_applied(&document.project, &plan, &proposal_fingerprint) {
                    return Ok(HighlightEditUpdate::AlreadyApplied {
                        project: document.project,
                        inserted_clip_ids: plan
                            .insertions
                            .iter()
                            .map(|insertion| insertion.editor_clip_id)
                            .collect(),
                        project_created: plan.create_project,
                    });
                }
                if plan.create_project || document.project.revision != plan.expected_revision {
                    return Ok(HighlightEditUpdate::Conflict {
                        current_revision: document.project.revision,
                    });
                }

                let previous = document.project.clone();
                let inserted_clip_ids = document.project.apply_highlight_edit_plan(&plan)?;
                document.project.revision = previous
                    .revision
                    .checked_add(1)
                    .ok_or(StorageError::EditorProjectRevisionOverflow(plan.project_id))?;
                document.project.created_at = previous.created_at;
                document.project.updated_at = Utc::now();
                mark_highlight_edit_applied(
                    &mut document.project,
                    &proposal_fingerprint,
                    &inserted_clip_ids,
                );
                retain_snapshot(
                    &mut document.snapshots,
                    previous,
                    document.project.updated_at,
                );
                let changed =
                    update_editor_project_row(&transaction, &document, plan.expected_revision)?;
                if changed != 1 {
                    let current_revision = transaction
                        .query_row(
                            "SELECT revision FROM editor_projects WHERE id = ?1",
                            [plan.project_id.to_string()],
                            |row| row_u64(row, 0),
                        )
                        .optional()?
                        .unwrap_or(plan.expected_revision);
                    return Ok(HighlightEditUpdate::Conflict { current_revision });
                }
                transaction.commit()?;
                return Ok(HighlightEditUpdate::Applied {
                    project: document.project,
                    inserted_clip_ids,
                    project_created: false,
                });
            }

            if !plan.create_project || plan.expected_revision != 0 {
                return Ok(HighlightEditUpdate::ProjectNotFound);
            }
            let now = Utc::now();
            let mut project = EditorProject {
                id: plan.project_id,
                name: plan.project_name.clone(),
                width: 1920,
                height: 1080,
                fps: 60,
                duration_seconds: 0.0,
                tracks: Vec::new(),
                markers: Vec::new(),
                settings: serde_json::json!({}),
                revision: 1,
                created_at: now,
                updated_at: now,
            };
            let inserted_clip_ids = project.apply_highlight_edit_plan(&plan)?;
            mark_highlight_edit_applied(&mut project, &proposal_fingerprint, &inserted_clip_ids);
            let document = EditorProjectDocument {
                project: project.clone(),
                snapshots: Vec::new(),
            };
            put_editor_project_row(&transaction, &document)?;
            transaction.commit()?;
            Ok(HighlightEditUpdate::Applied {
                project,
                inserted_clip_ids,
                project_created: true,
            })
        })
        .await
    }

    /// Atomically registers extracted audio and applies the corresponding
    /// timeline edit under the editor project's revision compare-and-swap.
    pub async fn separate_editor_audio(
        &self,
        project_id: Uuid,
        expected_revision: u64,
        separation: EditorAudioSeparation,
        asset: MediaAsset,
    ) -> Result<EditorAudioSeparationUpdate> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut document) = get_editor_project_document(&transaction, project_id)? else {
                return Ok(EditorAudioSeparationUpdate::ProjectNotFound);
            };
            if let Some(audio_clip_id) = document
                .project
                .separated_audio_clip_id(separation.source_clip_id)
            {
                return Ok(EditorAudioSeparationUpdate::AlreadySeparated { audio_clip_id });
            }
            if document.project.revision != expected_revision {
                return Ok(EditorAudioSeparationUpdate::Conflict {
                    current_revision: document.project.revision,
                });
            }
            if !document
                .project
                .tracks
                .iter()
                .flat_map(|track| &track.clips)
                .any(|clip| clip.id == separation.source_clip_id)
            {
                return Ok(EditorAudioSeparationUpdate::ClipNotFound);
            }
            if get_document::<MediaAsset>(&transaction, "media_assets", asset.id)?.is_some() {
                return Ok(EditorAudioSeparationUpdate::AssetAlreadyExists);
            }
            if asset.project_id != Some(project_id)
                || asset.id != separation.audio_asset_id
                || !asset.kind.starts_with("audio")
            {
                return Err(StorageError::Domain(
                    vibe_cs_domain::DomainError::InvalidInput(
                        "separated media asset does not belong to the editor project".to_owned(),
                    ),
                ));
            }

            let previous = document.project.clone();
            document.project.separate_audio(separation)?;
            document.project.revision = previous
                .revision
                .checked_add(1)
                .ok_or(StorageError::EditorProjectRevisionOverflow(project_id))?;
            document.project.created_at = previous.created_at;
            document.project.updated_at = Utc::now();
            retain_snapshot(
                &mut document.snapshots,
                previous,
                document.project.updated_at,
            );
            put_asset_row(&transaction, &asset)?;
            let changed = update_editor_project_row(&transaction, &document, expected_revision)?;
            if changed != 1 {
                let current_revision = transaction
                    .query_row(
                        "SELECT revision FROM editor_projects WHERE id = ?1",
                        [project_id.to_string()],
                        |row| row_u64(row, 0),
                    )
                    .optional()?
                    .unwrap_or(expected_revision);
                return Ok(EditorAudioSeparationUpdate::Conflict { current_revision });
            }
            transaction.commit()?;
            Ok(EditorAudioSeparationUpdate::Applied(Box::new(
                EditorAudioSeparationResult {
                    project: document.project,
                    asset,
                },
            )))
        })
        .await
    }

    /// Inserts a portable project's document and its reconnected assets in a
    /// single database transaction.
    pub async fn import_editor_project_package(
        &self,
        project: EditorProject,
        assets: Vec<MediaAsset>,
    ) -> Result<(EditorProject, Vec<MediaAsset>)> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if get_editor_project_document(&transaction, project.id)?.is_some() {
                return Err(StorageError::EditorProjectAlreadyExists(project.id));
            }
            for asset in &assets {
                if get_document::<MediaAsset>(&transaction, "media_assets", asset.id)?.is_some() {
                    return Err(StorageError::MediaAssetAlreadyExists(asset.id));
                }
            }
            let document = EditorProjectDocument {
                project: project.clone(),
                snapshots: Vec::new(),
            };
            put_editor_project_row(&transaction, &document)?;
            for asset in &assets {
                put_asset_row(&transaction, asset)?;
            }
            transaction.commit()?;
            Ok((project, assets))
        })
        .await
    }

    /// Lists retained project versions from newest to oldest.
    pub async fn list_editor_project_snapshots(
        &self,
        project_id: Uuid,
    ) -> Result<Vec<EditorProjectSnapshot>> {
        self.run(move |connection| {
            Ok(get_editor_project_document(connection, project_id)?
                .map(|document| {
                    document
                        .snapshots
                        .into_iter()
                        .map(|snapshot| snapshot.summary)
                        .collect()
                })
                .unwrap_or_default())
        })
        .await
    }

    /// Restores a retained snapshot while keeping revisions monotonically increasing.
    ///
    /// Returns `None` when either the project or snapshot does not exist.
    pub async fn restore_editor_project_snapshot(
        &self,
        project_id: Uuid,
        snapshot_id: Uuid,
    ) -> Result<Option<EditorProject>> {
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let Some(mut document) = get_editor_project_document(&transaction, project_id)? else {
                return Ok(None);
            };
            let Some(mut restored) = document
                .snapshots
                .iter()
                .find(|snapshot| snapshot.summary.id == snapshot_id)
                .map(|snapshot| snapshot.project.clone())
            else {
                return Ok(None);
            };

            let current = document.project;
            restored.id = current.id;
            restored.revision = current
                .revision
                .checked_add(1)
                .ok_or(StorageError::EditorProjectRevisionOverflow(project_id))?;
            restored.created_at = current.created_at;
            restored.updated_at = Utc::now();

            retain_snapshot(&mut document.snapshots, current, restored.updated_at);
            document.project = restored.clone();
            put_editor_project_row(&transaction, &document)?;
            transaction.commit()?;
            Ok(Some(restored))
        })
        .await
    }

    /// Atomically deletes one or more revision-matched projects and detaches
    /// their unshared media records. Active exports block the whole batch.
    #[cfg(test)]
    async fn delete_editor_projects(
        &self,
        revisions: Vec<EditorProjectRevision>,
    ) -> Result<EditorProjectDeletion> {
        self.delete_editor_projects_inner(revisions, None, || Ok(()))
            .await
    }

    /// Moves owned managed files into a durable same-volume quarantine before
    /// committing their project and asset row deletion.
    pub async fn delete_editor_projects_staged(
        &self,
        revisions: Vec<EditorProjectRevision>,
        staging: ManagedFileStaging,
    ) -> Result<EditorProjectDeletion> {
        self.delete_editor_projects_inner(revisions, Some(staging), || Ok(()))
            .await
    }

    async fn delete_editor_projects_inner<F>(
        &self,
        revisions: Vec<EditorProjectRevision>,
        staging: Option<ManagedFileStaging>,
        after_staging: F,
    ) -> Result<EditorProjectDeletion>
    where
        F: FnOnce() -> Result<()> + Send + 'static,
    {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let requested = revisions
                .iter()
                .map(|item| item.id)
                .collect::<std::collections::HashSet<_>>();
            for item in &revisions {
                let Some(document) = get_editor_project_document(&transaction, item.id)? else {
                    return Ok(EditorProjectDeletion::NotFound { id: item.id });
                };
                if document.project.revision != item.expected_revision {
                    return Ok(EditorProjectDeletion::Conflict {
                        id: item.id,
                        current_revision: document.project.revision,
                    });
                }
                let has_active_export = transaction
                    .query_row(
                        "SELECT 1 FROM export_jobs WHERE project_id = ?1 \
                         AND status IN ('queued', 'preparing', 'running', 'cancelling') LIMIT 1",
                        [item.id.to_string()],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if has_active_export {
                    return Ok(EditorProjectDeletion::ActiveExport { id: item.id });
                }
            }

            let mut project_statement =
                transaction.prepare("SELECT document_json FROM editor_projects")?;
            let mut project_rows = project_statement.query([])?;
            let surviving_references = collect_editor_project_documents(&mut project_rows)?
                .into_iter()
                .filter(|document| !requested.contains(&document.project.id))
                .flat_map(|document| {
                    document
                        .project
                        .tracks
                        .into_iter()
                        .flat_map(|track| track.clips)
                        .filter_map(|clip| clip.asset_id)
                })
                .collect::<std::collections::HashSet<_>>();
            drop(project_rows);
            drop(project_statement);

            let mut asset_statement =
                transaction.prepare("SELECT document_json FROM media_assets")?;
            let mut asset_rows = asset_statement.query([])?;
            let all_assets = collect_documents::<MediaAsset>(&mut asset_rows)?;
            drop(asset_rows);
            drop(asset_statement);

            if let Some(asset) = all_assets.iter().find(|asset| {
                asset.project_id.is_some_and(|id| requested.contains(&id))
                    && matches!(asset.proxy_status, MediaProxyStatus::Generating { .. })
            }) {
                return Ok(EditorProjectDeletion::BusyAsset {
                    project_id: asset.project_id.expect("matched project id"),
                    asset_id: asset.id,
                });
            }

            let mut result = EditorProjectDeletionResult {
                project_ids: revisions.iter().map(|item| item.id).collect(),
                ..EditorProjectDeletionResult::default()
            };
            let mut retained_assets = Vec::new();
            for mut asset in all_assets {
                if !asset.project_id.is_some_and(|id| requested.contains(&id)) {
                    retained_assets.push(asset);
                    continue;
                }
                if surviving_references.contains(&asset.id) {
                    asset.project_id = None;
                    put_asset_row(&transaction, &asset)?;
                    result.preserved_shared_asset_ids.push(asset.id);
                    retained_assets.push(asset);
                    continue;
                }
                transaction.execute(
                    "DELETE FROM media_assets WHERE id = ?1",
                    [asset.id.to_string()],
                )?;
                result.deleted_assets.push(asset);
            }
            result.protected_paths = retained_assets
                .into_iter()
                .flat_map(|asset| [Some(asset.path), asset.proxy_path])
                .flatten()
                .collect();
            let staged_files = staging
                .as_ref()
                .map(|staging| {
                    stage_managed_files(
                        staging,
                        &result.project_ids,
                        &result.deleted_assets,
                        &result.protected_paths,
                    )
                })
                .transpose()?;
            if let Some(staged_files) = &staged_files {
                result.preserved_external_files = staged_files.quarantine.preserved_external_files;
            }
            let database_result = (|| {
                after_staging()?;
                for item in &revisions {
                    transaction.execute(
                        "DELETE FROM editor_projects WHERE id = ?1 AND revision = ?2",
                        params![item.id.to_string(), sql_u64(item.expected_revision)?],
                    )?;
                }
                transaction.commit()?;
                Ok(())
            })();
            if let Err(error) = database_result {
                if let Some(staged_files) = staged_files
                    && let Err(rollback_error) = restore_staged_managed_files(staged_files)
                {
                    return Err(StorageError::ManagedFile(format!(
                        "{error}; quarantine rollback also failed: {rollback_error}"
                    )));
                }
                return Err(error);
            }
            result.file_quarantine = staged_files.map(|staged_files| staged_files.quarantine);
            Ok(EditorProjectDeletion::Deleted(Box::new(result)))
        })
        .await
    }

    /// Deletes files owned by a committed project-deletion quarantine using
    /// only paths relative to opened capability directories.
    pub async fn finalize_editor_project_quarantine(
        &self,
        staging: ManagedFileStaging,
        quarantine: ManagedFileQuarantine,
    ) -> Result<(usize, Vec<String>)> {
        tokio::task::spawn_blocking(move || finalize_managed_file_quarantine(&staging, &quarantine))
            .await?
    }

    /// Reconciles durable project-deletion journals after interruption.
    pub async fn recover_editor_project_quarantines(
        &self,
        staging: ManagedFileStaging,
    ) -> Result<(usize, Vec<String>)> {
        let scan_staging = staging.clone();
        let scan =
            tokio::task::spawn_blocking(move || scan_managed_file_quarantines(&scan_staging))
                .await?;
        let Ok((quarantines, mut failed_files)) = scan else {
            return Ok((0, vec!["unsafe-cleanup-root".to_owned()]));
        };
        let mut removed_files = 0_usize;
        for quarantine in quarantines {
            let mut project_survives = false;
            let mut ownership_failed = false;
            for project_id in &quarantine.project_ids {
                match self.get_editor_project(*project_id).await {
                    Ok(Some(_)) => {
                        project_survives = true;
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        ownership_failed = true;
                        break;
                    }
                }
            }
            if ownership_failed {
                failed_files.push("cleanup-ownership".to_owned());
                continue;
            }
            let operation_staging = staging.clone();
            let operation = if project_survives {
                tokio::task::spawn_blocking(move || {
                    restore_managed_file_quarantine(&operation_staging, &quarantine)
                        .map(|()| (0, Vec::new()))
                })
                .await?
            } else {
                tokio::task::spawn_blocking(move || {
                    finalize_managed_file_quarantine(&operation_staging, &quarantine)
                })
                .await?
            };
            match operation {
                Ok((removed, failures)) => {
                    removed_files += removed;
                    failed_files.extend(failures);
                }
                Err(_) => {
                    failed_files.push("cleanup-journal".to_owned());
                }
            }
        }
        Ok((removed_files, failed_files))
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

    pub async fn list_presets(&self) -> Result<Vec<PresetRecord>> {
        self.list_documents("editor_presets", "updated_at DESC")
            .await
    }

    pub async fn get_preset(&self, id: Uuid) -> Result<Option<PresetRecord>> {
        self.run(move |connection| get_document(connection, "editor_presets", id))
            .await
    }

    pub async fn create_preset(&self, mut preset: PresetRecord) -> Result<PresetRecord> {
        preset.document.validate()?;
        preset.revision = 1;
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO editor_presets(id, name, revision, created_at, updated_at, document_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    preset.id.to_string(),
                    preset.name,
                    sql_u64(preset.revision)?,
                    preset.created_at.to_rfc3339(),
                    preset.updated_at.to_rfc3339(),
                    encode(&preset)?
                ],
            )?;
            Ok(preset)
        })
        .await
    }

    pub async fn update_preset(
        &self,
        mut preset: PresetRecord,
        expected_revision: u64,
    ) -> Result<PresetUpdate> {
        preset.document.validate()?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) =
                get_document::<PresetRecord>(&transaction, "editor_presets", preset.id)?
            else {
                return Ok(PresetUpdate::NotFound);
            };
            if current.revision != expected_revision {
                return Ok(PresetUpdate::Conflict {
                    current_revision: current.revision,
                });
            }
            preset.revision = current
                .revision
                .checked_add(1)
                .ok_or(StorageError::EditorPresetRevisionOverflow(preset.id))?;
            preset.created_at = current.created_at;
            preset.updated_at = Utc::now();
            let changed = transaction.execute(
                "UPDATE editor_presets SET name = ?2, revision = ?3, updated_at = ?4, \
                 document_json = ?5 WHERE id = ?1 AND revision = ?6",
                params![
                    preset.id.to_string(),
                    preset.name,
                    sql_u64(preset.revision)?,
                    preset.updated_at.to_rfc3339(),
                    encode(&preset)?,
                    sql_u64(expected_revision)?,
                ],
            )?;
            if changed != 1 {
                let current_revision = transaction
                    .query_row(
                        "SELECT revision FROM editor_presets WHERE id = ?1",
                        [preset.id.to_string()],
                        |row| row_u64(row, 0),
                    )
                    .optional()?
                    .unwrap_or(expected_revision);
                return Ok(PresetUpdate::Conflict { current_revision });
            }
            transaction.commit()?;
            Ok(PresetUpdate::Updated(preset))
        })
        .await
    }

    pub async fn delete_preset(&self, id: Uuid, expected_revision: u64) -> Result<PresetDelete> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) = get_document::<PresetRecord>(&transaction, "editor_presets", id)?
            else {
                return Ok(PresetDelete::NotFound);
            };
            if current.revision != expected_revision {
                return Ok(PresetDelete::Conflict {
                    current_revision: current.revision,
                });
            }
            transaction.execute(
                "DELETE FROM editor_presets WHERE id = ?1 AND revision = ?2",
                params![id.to_string(), sql_u64(expected_revision)?],
            )?;
            transaction.commit()?;
            Ok(PresetDelete::Deleted(current))
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn apply_editor_preset(
        &self,
        project_id: Uuid,
        clip_id: Uuid,
        preset_id: Uuid,
        expected_project_revision: u64,
        expected_preset_revision: u64,
    ) -> Result<PresetApply> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(preset) =
                get_document::<PresetRecord>(&transaction, "editor_presets", preset_id)?
            else {
                return Ok(PresetApply::PresetNotFound);
            };
            if preset.revision != expected_preset_revision {
                return Ok(PresetApply::PresetConflict {
                    current_revision: preset.revision,
                });
            }
            let Some(mut document) = get_editor_project_document(&transaction, project_id)? else {
                return Ok(PresetApply::ProjectNotFound);
            };
            if document.project.revision != expected_project_revision {
                return Ok(PresetApply::ProjectConflict {
                    current_revision: document.project.revision,
                });
            }
            let Some((track_kind, clip)) = document.project.tracks.iter_mut().find_map(|track| {
                track
                    .clips
                    .iter_mut()
                    .find(|clip| clip.id == clip_id)
                    .map(|clip| (track.kind, clip))
            }) else {
                return Ok(PresetApply::ClipNotFound);
            };
            preset.document.validate_for_target(track_kind, clip)?;
            preset.document.apply_to_clip(clip);
            document.project.validate()?;
            let previous = document.project.clone();
            document.project.revision = previous
                .revision
                .checked_add(1)
                .ok_or(StorageError::EditorProjectRevisionOverflow(project_id))?;
            document.project.updated_at = Utc::now();
            retain_snapshot(
                &mut document.snapshots,
                previous,
                document.project.updated_at,
            );
            let changed =
                update_editor_project_row(&transaction, &document, expected_project_revision)?;
            if changed != 1 {
                let current_revision = transaction
                    .query_row(
                        "SELECT revision FROM editor_projects WHERE id = ?1",
                        [project_id.to_string()],
                        |row| row_u64(row, 0),
                    )
                    .optional()?
                    .unwrap_or(expected_project_revision);
                return Ok(PresetApply::ProjectConflict { current_revision });
            }
            transaction.commit()?;
            Ok(PresetApply::Applied(document.project))
        })
        .await
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

fn stage_managed_files(
    staging: &ManagedFileStaging,
    project_ids: &[Uuid],
    assets: &[MediaAsset],
    protected_paths: &[String],
) -> Result<StagedManagedFiles> {
    let capabilities = open_managed_file_capabilities(staging, true)?;
    let canonical_roots = capabilities
        .managed_roots
        .iter()
        .map(|root| root.canonical_path.clone())
        .collect::<Vec<_>>();
    let protected_lexical = protected_paths
        .iter()
        .map(PathBuf::from)
        .collect::<std::collections::HashSet<_>>();
    let protected_canonical = protected_lexical
        .iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .collect::<std::collections::HashSet<_>>();
    let candidates = assets
        .iter()
        .flat_map(|asset| [Some(asset.path.as_str()), asset.proxy_path.as_deref()])
        .flatten()
        .map(PathBuf::from)
        .collect::<std::collections::HashSet<_>>();
    let id = Uuid::new_v4();
    let mut original_paths = Vec::new();
    let mut canonical_candidates = std::collections::HashSet::new();
    let mut preserved_external_files = 0_usize;
    for candidate in candidates {
        if protected_lexical.contains(&candidate) {
            continue;
        }
        let metadata = match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(StorageError::ManagedFile(format!(
                    "cannot inspect {}: {error}",
                    candidate.display()
                )));
            }
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            preserved_external_files += 1;
            continue;
        }
        let canonical = std::fs::canonicalize(&candidate).map_err(|error| {
            StorageError::ManagedFile(format!("cannot resolve {}: {error}", candidate.display()))
        })?;
        if protected_canonical.contains(&canonical) {
            continue;
        }
        if !canonical_roots
            .iter()
            .any(|root| canonical.starts_with(root))
        {
            preserved_external_files += 1;
            continue;
        }
        if canonical_candidates.insert(canonical.clone()) {
            original_paths.push(canonical);
        }
    }

    let directory_name = id.to_string();
    capabilities
        .quarantine_root_dir
        .create_dir(&directory_name)
        .map_err(|error| managed_file_error("cannot create quarantine directory", error))?;
    validate_capability_plain_directory(
        &capabilities.quarantine_root_dir,
        OsStr::new(&directory_name),
    )?;
    let directory = capabilities
        .quarantine_root_dir
        .open_dir(&directory_name)
        .map_err(|error| managed_file_error("cannot open quarantine directory", error))?;
    let directory_path = capabilities.canonical_quarantine_root.join(&directory_name);
    let journal_path = directory_path.join("journal.json");
    let mut entries = Vec::with_capacity(original_paths.len());
    let mut capability_entries = Vec::with_capacity(original_paths.len());
    for (index, original_path) in original_paths.into_iter().enumerate() {
        let (source_dir, source_name) =
            open_managed_source(&capabilities.managed_roots, &original_path)?;
        let staged_name = OsString::from(format!("{index:04}-{}", Uuid::new_v4()));
        entries.push(ManagedFileQuarantineEntry {
            original_path,
            staged_path: directory_path.join(&staged_name),
        });
        capability_entries.push(CapabilityMoveEntry {
            source_dir,
            source_name,
            staged_name,
        });
    }
    let quarantine = ManagedFileQuarantine {
        id,
        project_ids: project_ids.to_vec(),
        directory: directory_path,
        journal_path: journal_path.clone(),
        entries,
        preserved_external_files,
    };
    let journal = serde_json::to_vec_pretty(&quarantine)?;
    let journal_result = write_capability_journal(&directory, &journal);
    if let Err(error) = journal_result {
        drop(directory);
        let _ = capabilities.quarantine_root_dir.remove_dir(&directory_name);
        return Err(StorageError::ManagedFile(format!(
            "cannot persist quarantine journal {}: {error}",
            journal_path.display()
        )));
    }

    for (moved, entry) in capability_entries.iter().enumerate() {
        if let Err(error) = capability_move_to_quarantine(entry, &directory) {
            let rollback = restore_capability_entries(&directory, &capability_entries[..moved]);
            if rollback.is_ok() {
                let _ = directory.remove_file("journal.json");
            }
            drop(directory);
            if rollback.is_ok() {
                let _ = capabilities.quarantine_root_dir.remove_dir(&directory_name);
            }
            return Err(StorageError::ManagedFile(match rollback {
                Ok(()) => format!("cannot stage managed file: {error}"),
                Err(rollback_error) => {
                    format!("{error}; quarantine rollback failed: {rollback_error}")
                }
            }));
        }
    }
    Ok(StagedManagedFiles {
        quarantine,
        quarantine_root_dir: capabilities.quarantine_root_dir,
        directory,
        entries: capability_entries,
    })
}

fn open_managed_file_capabilities(
    staging: &ManagedFileStaging,
    create_cleanup: bool,
) -> Result<ManagedFileCapabilities> {
    let Some(data_root) = staging.cleanup_root.parent() else {
        return Err(StorageError::ManagedFile(
            "cleanup root must have a data-directory parent".to_owned(),
        ));
    };
    if staging.quarantine_root.parent() != Some(staging.cleanup_root.as_path()) {
        return Err(StorageError::ManagedFile(
            "quarantine root must be a direct child of the configured cleanup root".to_owned(),
        ));
    }
    let cleanup_name = staging.cleanup_root.file_name().ok_or_else(|| {
        StorageError::ManagedFile("cleanup root must have a directory name".to_owned())
    })?;
    let quarantine_name = staging.quarantine_root.file_name().ok_or_else(|| {
        StorageError::ManagedFile("quarantine root must have a directory name".to_owned())
    })?;

    let canonical_data_root = canonicalize_plain_directory(data_root)?;
    let data_dir = Dir::open_ambient_dir(data_root, ambient_authority())
        .map_err(|error| managed_file_error("cannot open data directory capability", error))?;
    let cleanup_dir = open_or_create_capability_directory(
        &data_dir,
        cleanup_name,
        create_cleanup,
        "cleanup root",
    )?;
    let quarantine_root_dir = open_or_create_capability_directory(
        &cleanup_dir,
        quarantine_name,
        create_cleanup,
        "quarantine root",
    )?;
    let canonical_quarantine_root = canonicalize_plain_directory(&staging.quarantine_root)?;
    let canonical_cleanup_root = canonicalize_plain_directory(&staging.cleanup_root)?;
    if canonical_cleanup_root.parent() != Some(canonical_data_root.as_path())
        || canonical_quarantine_root.parent() != Some(canonical_cleanup_root.as_path())
    {
        return Err(StorageError::ManagedFile(
            "quarantine capability resolves outside the configured data directory".to_owned(),
        ));
    }

    let mut managed_roots = Vec::new();
    for root in &staging.managed_roots {
        match std::fs::symlink_metadata(root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(managed_file_error(
                    "cannot inspect managed media root",
                    error,
                ));
            }
            Ok(_) => {}
        }
        let canonical_path = canonicalize_plain_directory(root)?;
        let relative = canonical_path
            .strip_prefix(&canonical_data_root)
            .map_err(|_| {
                StorageError::ManagedFile(format!(
                    "managed media root {} is outside the data directory",
                    root.display()
                ))
            })?;
        let directory = open_capability_directory_path(&data_dir, relative)?;
        managed_roots.push(CapabilityRoot {
            canonical_path,
            directory,
        });
    }
    Ok(ManagedFileCapabilities {
        canonical_quarantine_root,
        quarantine_root_dir,
        managed_roots,
    })
}

fn open_or_create_capability_directory(
    parent: &Dir,
    name: &OsStr,
    create: bool,
    label: &str,
) -> Result<Dir> {
    if create {
        match parent.create_dir(name) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(managed_file_error(&format!("cannot create {label}"), error));
            }
        }
    }
    validate_capability_plain_directory(parent, name)?;
    parent
        .open_dir(name)
        .map_err(|error| managed_file_error(&format!("cannot open {label}"), error))
}

fn open_capability_directory_path(root: &Dir, path: &Path) -> Result<Dir> {
    let mut directory = root
        .try_clone()
        .map_err(|error| managed_file_error("cannot clone directory capability", error))?;
    for component in path.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(StorageError::ManagedFile(
                "managed relative path contains a non-normal component".to_owned(),
            ));
        };
        validate_capability_plain_directory(&directory, name)?;
        directory = directory.open_dir(name).map_err(|error| {
            managed_file_error("cannot open managed directory capability", error)
        })?;
    }
    Ok(directory)
}

fn validate_capability_plain_directory(parent: &Dir, name: &OsStr) -> Result<()> {
    let metadata = parent
        .symlink_metadata(name)
        .map_err(|error| managed_file_error("cannot inspect capability directory", error))?;
    if !metadata.is_dir() || metadata.is_symlink() || capability_metadata_is_reparse(&metadata) {
        return Err(StorageError::ManagedFile(format!(
            "capability path component {} is not a plain directory",
            name.to_string_lossy()
        )));
    }
    Ok(())
}

fn open_managed_source(roots: &[CapabilityRoot], path: &Path) -> Result<(Dir, OsString)> {
    let (directory, name) = open_managed_destination(roots, path)?;
    validate_capability_plain_file(&directory, &name)?;
    Ok((directory, name))
}

fn open_managed_destination(roots: &[CapabilityRoot], path: &Path) -> Result<(Dir, OsString)> {
    let root = roots
        .iter()
        .filter(|root| path.starts_with(&root.canonical_path))
        .max_by_key(|root| root.canonical_path.components().count())
        .ok_or_else(|| {
            StorageError::ManagedFile(format!(
                "managed file {} is outside every capability root",
                path.display()
            ))
        })?;
    let relative = path.strip_prefix(&root.canonical_path).map_err(|_| {
        StorageError::ManagedFile(format!("cannot relativize managed file {}", path.display()))
    })?;
    let name = relative.file_name().ok_or_else(|| {
        StorageError::ManagedFile(format!("managed file {} has no file name", path.display()))
    })?;
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let directory = open_capability_directory_path(&root.directory, parent)?;
    Ok((directory, name.to_os_string()))
}

fn validate_capability_plain_file(parent: &Dir, name: &OsStr) -> Result<()> {
    let metadata = parent
        .symlink_metadata(name)
        .map_err(|error| managed_file_error("cannot inspect capability file", error))?;
    if !metadata.is_file() || metadata.is_symlink() || capability_metadata_is_reparse(&metadata) {
        return Err(StorageError::ManagedFile(format!(
            "capability path {} is not a plain file",
            name.to_string_lossy()
        )));
    }
    Ok(())
}

fn write_capability_journal(directory: &Dir, journal: &[u8]) -> Result<()> {
    let mut options = CapabilityOpenOptions::new();
    options.write(true).create_new(true);
    let mut file = directory
        .open_with("journal.json", &options)
        .map_err(|error| managed_file_error("cannot create quarantine journal", error))?;
    file.write_all(journal)
        .map_err(|error| managed_file_error("cannot write quarantine journal", error))?;
    file.sync_all()
        .map_err(|error| managed_file_error("cannot sync quarantine journal", error))
}

fn capability_move_to_quarantine(entry: &CapabilityMoveEntry, directory: &Dir) -> Result<()> {
    validate_capability_plain_file(&entry.source_dir, &entry.source_name)?;
    match directory.symlink_metadata(&entry.staged_name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(StorageError::ManagedFile(
                "refusing to replace an existing staged file".to_owned(),
            ));
        }
        Err(error) => {
            return Err(managed_file_error(
                "cannot inspect staged destination",
                error,
            ));
        }
    }
    entry
        .source_dir
        .rename(&entry.source_name, directory, &entry.staged_name)
        .map_err(|error| managed_file_error("cannot move file into quarantine", error))
}

fn restore_capability_entries(directory: &Dir, entries: &[CapabilityMoveEntry]) -> Result<()> {
    for entry in entries.iter().rev() {
        match directory.symlink_metadata(&entry.staged_name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.is_symlink()
                    && !capability_metadata_is_reparse(&metadata) => {}
            Ok(_) | Err(_) => {
                return Err(StorageError::ManagedFile(
                    "refusing to restore an unsafe staged file".to_owned(),
                ));
            }
        }
        restore_capability_file(
            directory,
            &entry.staged_name,
            &entry.source_dir,
            &entry.source_name,
        )?;
    }
    Ok(())
}

fn restore_staged_managed_files(staged: StagedManagedFiles) -> Result<()> {
    restore_capability_entries(&staged.directory, &staged.entries)?;
    match staged.directory.remove_file("journal.json") {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(managed_file_error(
                "cannot remove quarantine journal",
                error,
            ));
        }
    }
    let directory_name = staged.quarantine.id.to_string();
    drop(staged.directory);
    staged
        .quarantine_root_dir
        .remove_dir(directory_name)
        .map_err(|error| managed_file_error("cannot remove quarantine directory", error))
}

fn scan_managed_file_quarantines(
    staging: &ManagedFileStaging,
) -> Result<(Vec<ManagedFileQuarantine>, Vec<String>)> {
    let capabilities = open_managed_file_capabilities(staging, true)?;
    let mut quarantines = Vec::new();
    let mut failed_files = Vec::new();
    let entries = capabilities
        .quarantine_root_dir
        .entries()
        .map_err(|error| managed_file_error("cannot enumerate quarantine root", error))?;
    for entry in entries {
        let Ok(entry) = entry else {
            failed_files.push("cleanup-entry".to_owned());
            continue;
        };
        let directory_name = entry.file_name();
        let Some(directory_name_text) = directory_name.to_str() else {
            failed_files.push("unsafe-cleanup-entry".to_owned());
            continue;
        };
        if Uuid::parse_str(directory_name_text).is_err()
            || validate_capability_plain_directory(
                &capabilities.quarantine_root_dir,
                &directory_name,
            )
            .is_err()
        {
            failed_files.push("unsafe-cleanup-entry".to_owned());
            continue;
        }
        let Ok(directory) = entry.open_dir() else {
            failed_files.push("unsafe-cleanup-entry".to_owned());
            continue;
        };
        let Ok(quarantine) = read_capability_journal(&directory) else {
            failed_files.push("invalid-cleanup-journal".to_owned());
            continue;
        };
        if validate_quarantine_record(&capabilities, &directory_name, &quarantine).is_err() {
            failed_files.push("unsafe-cleanup-journal".to_owned());
            continue;
        }
        quarantines.push(quarantine);
    }
    Ok((quarantines, failed_files))
}

fn open_existing_quarantine(
    staging: &ManagedFileStaging,
    quarantine: &ManagedFileQuarantine,
) -> Result<OpenQuarantine> {
    let capabilities = open_managed_file_capabilities(staging, true)?;
    let directory_name = OsString::from(quarantine.id.to_string());
    validate_quarantine_record(&capabilities, &directory_name, quarantine)?;
    validate_capability_plain_directory(&capabilities.quarantine_root_dir, &directory_name)?;
    let directory = capabilities
        .quarantine_root_dir
        .open_dir(&directory_name)
        .map_err(|error| managed_file_error("cannot open quarantine capability", error))?;
    let persisted = read_capability_journal(&directory)?;
    if persisted != *quarantine {
        return Err(StorageError::ManagedFile(
            "quarantine journal changed after it was scanned".to_owned(),
        ));
    }
    Ok(OpenQuarantine {
        quarantine_root_dir: capabilities.quarantine_root_dir,
        directory,
        directory_name,
        managed_roots: capabilities.managed_roots,
    })
}

fn validate_quarantine_record(
    capabilities: &ManagedFileCapabilities,
    directory_name: &OsStr,
    quarantine: &ManagedFileQuarantine,
) -> Result<()> {
    let directory_name_text = directory_name.to_str().ok_or_else(|| {
        StorageError::ManagedFile("quarantine directory name is not Unicode".to_owned())
    })?;
    if Uuid::parse_str(directory_name_text).ok() != Some(quarantine.id) {
        return Err(StorageError::ManagedFile(
            "quarantine identifier does not match its directory".to_owned(),
        ));
    }
    let directory = capabilities.canonical_quarantine_root.join(directory_name);
    if quarantine.directory != directory
        || quarantine.journal_path != directory.join("journal.json")
        || quarantine.entries.iter().any(|entry| {
            entry.staged_path.parent() != Some(directory.as_path())
                || entry.staged_path.file_name().is_none()
                || entry.original_path.file_name().is_none()
        })
    {
        return Err(StorageError::ManagedFile(
            "quarantine journal contains a path outside its capability directory".to_owned(),
        ));
    }
    Ok(())
}

fn read_capability_journal(directory: &Dir) -> Result<ManagedFileQuarantine> {
    const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;

    let metadata = directory
        .symlink_metadata("journal.json")
        .map_err(|error| managed_file_error("cannot inspect quarantine journal", error))?;
    if !metadata.is_file()
        || metadata.is_symlink()
        || capability_metadata_is_reparse(&metadata)
        || metadata.len() > MAX_JOURNAL_BYTES
    {
        return Err(StorageError::ManagedFile(
            "quarantine journal is not a bounded plain file".to_owned(),
        ));
    }
    let file = directory
        .open("journal.json")
        .map_err(|error| managed_file_error("cannot open quarantine journal", error))?;
    let mut bytes = Vec::new();
    file.take(MAX_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| managed_file_error("cannot read quarantine journal", error))?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(StorageError::ManagedFile(
            "quarantine journal exceeds its size limit".to_owned(),
        ));
    }
    serde_json::from_slice(&bytes).map_err(StorageError::from)
}

fn finalize_managed_file_quarantine(
    staging: &ManagedFileStaging,
    quarantine: &ManagedFileQuarantine,
) -> Result<(usize, Vec<String>)> {
    let opened = open_existing_quarantine(staging, quarantine)?;
    let mut removed_files = 0_usize;
    let mut failed_files = Vec::new();
    for entry in &quarantine.entries {
        let staged_name = entry.staged_path.file_name().ok_or_else(|| {
            StorageError::ManagedFile("staged file has no relative name".to_owned())
        })?;
        match opened.directory.symlink_metadata(staged_name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.is_symlink()
                    && !capability_metadata_is_reparse(&metadata) => {}
            Ok(_) | Err(_) => {
                failed_files.push(safe_managed_file_name(&entry.original_path));
                continue;
            }
        }
        match opened.directory.remove_file(staged_name) {
            Ok(()) => removed_files += 1,
            Err(_) => failed_files.push(safe_managed_file_name(&entry.original_path)),
        }
    }
    if !failed_files.is_empty() {
        return Ok((removed_files, failed_files));
    }
    opened
        .directory
        .remove_file("journal.json")
        .map_err(|error| managed_file_error("cannot remove quarantine journal", error))?;
    drop(opened.directory);
    if let Err(error) = opened
        .quarantine_root_dir
        .remove_dir(&opened.directory_name)
    {
        failed_files.push(format!("cleanup-directory: {error}"));
    }
    Ok((removed_files, failed_files))
}

fn restore_managed_file_quarantine(
    staging: &ManagedFileStaging,
    quarantine: &ManagedFileQuarantine,
) -> Result<()> {
    let opened = open_existing_quarantine(staging, quarantine)?;
    for entry in quarantine.entries.iter().rev() {
        let staged_name = entry.staged_path.file_name().ok_or_else(|| {
            StorageError::ManagedFile("staged file has no relative name".to_owned())
        })?;
        match opened.directory.symlink_metadata(staged_name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.is_symlink()
                    && !capability_metadata_is_reparse(&metadata) => {}
            Ok(_) | Err(_) => {
                return Err(StorageError::ManagedFile(
                    "refusing to restore an unsafe staged file".to_owned(),
                ));
            }
        }
        let (source_dir, source_name) =
            open_managed_destination(&opened.managed_roots, &entry.original_path)?;
        restore_capability_file(&opened.directory, staged_name, &source_dir, &source_name)?;
    }
    opened
        .directory
        .remove_file("journal.json")
        .map_err(|error| managed_file_error("cannot remove restored quarantine journal", error))?;
    drop(opened.directory);
    opened
        .quarantine_root_dir
        .remove_dir(opened.directory_name)
        .map_err(|error| managed_file_error("cannot remove restored quarantine directory", error))
}

fn restore_capability_file(
    quarantine_dir: &Dir,
    staged_name: &OsStr,
    source_dir: &Dir,
    source_name: &OsStr,
) -> Result<()> {
    match source_dir.symlink_metadata(source_name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            quarantine_dir
                .hard_link(staged_name, source_dir, source_name)
                .map_err(|error| {
                    managed_file_error("cannot create restored file without replacement", error)
                })?;
        }
        Ok(metadata)
            if metadata.is_file()
                && !metadata.is_symlink()
                && !capability_metadata_is_reparse(&metadata)
                && capability_files_are_same(
                    quarantine_dir,
                    staged_name,
                    source_dir,
                    source_name,
                )? => {}
        Ok(_) | Err(_) => {
            return Err(StorageError::ManagedFile(format!(
                "refusing to overwrite restored path {}",
                source_name.to_string_lossy()
            )));
        }
    }
    quarantine_dir
        .remove_file(staged_name)
        .map_err(|error| managed_file_error("cannot unlink restored quarantine file", error))
}

fn capability_files_are_same(
    first_dir: &Dir,
    first_name: &OsStr,
    second_dir: &Dir,
    second_name: &OsStr,
) -> Result<bool> {
    let first = first_dir
        .open(first_name)
        .map_err(|error| managed_file_error("cannot open first file identity", error))?;
    let second = second_dir
        .open(second_name)
        .map_err(|error| managed_file_error("cannot open second file identity", error))?;
    let first = same_file::Handle::from_file(first.into_std())
        .map_err(|error| managed_file_error("cannot identify first file", error))?;
    let second = same_file::Handle::from_file(second.into_std())
        .map_err(|error| managed_file_error("cannot identify second file", error))?;
    Ok(first == second)
}

fn safe_managed_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("managed-file")
        .to_owned()
}

fn managed_file_error(context: &str, error: impl std::fmt::Display) -> StorageError {
    StorageError::ManagedFile(format!("{context}: {error}"))
}

#[cfg(windows)]
fn capability_metadata_is_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn capability_metadata_is_reparse(_metadata: &cap_std::fs::Metadata) -> bool {
    false
}

fn canonicalize_plain_directory(path: &Path) -> Result<PathBuf> {
    validate_existing_directory_chain_without_links(path)?;
    std::fs::canonicalize(path).map_err(|error| {
        StorageError::ManagedFile(format!(
            "cannot resolve quarantine directory {}: {error}",
            path.display()
        ))
    })
}

fn validate_existing_directory_chain_without_links(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        #[cfg(windows)]
        if matches!(component, std::path::Component::Prefix(_)) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&current).map_err(|error| {
            StorageError::ManagedFile(format!(
                "cannot inspect quarantine path component {}: {error}",
                current.display()
            ))
        })?;
        validate_plain_directory_metadata(&current, &metadata)?;
    }
    Ok(())
}

fn validate_plain_directory_metadata(path: &Path, metadata: &std::fs::Metadata) -> Result<()> {
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(metadata)
    {
        return Err(StorageError::ManagedFile(format!(
            "cleanup path component {} is not a plain directory",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
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

fn get_editor_project_document(
    connection: &Connection,
    id: Uuid,
) -> Result<Option<EditorProjectDocument>> {
    let json = connection
        .query_row(
            "SELECT document_json FROM editor_projects WHERE id = ?1",
            [id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    json.map(|json| decode_editor_project_document(&json))
        .transpose()
}

fn decode_editor_project_document(value: &str) -> Result<EditorProjectDocument> {
    decode(value)
}

fn put_editor_project_row(connection: &Connection, document: &EditorProjectDocument) -> Result<()> {
    let project = &document.project;
    connection.execute(
        "INSERT INTO editor_projects(id, name, revision, updated_at, document_json) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, revision = excluded.revision, \
         updated_at = excluded.updated_at, document_json = excluded.document_json",
        params![
            project.id.to_string(),
            project.name,
            sql_u64(project.revision)?,
            project.updated_at.to_rfc3339(),
            encode(document)?
        ],
    )?;
    Ok(())
}

fn update_editor_project_row(
    connection: &Connection,
    document: &EditorProjectDocument,
    expected_revision: u64,
) -> Result<usize> {
    let project = &document.project;
    connection
        .execute(
            "UPDATE editor_projects SET name = ?1, revision = ?2, updated_at = ?3, \
             document_json = ?4 WHERE id = ?5 AND revision = ?6",
            params![
                project.name,
                sql_u64(project.revision)?,
                project.updated_at.to_rfc3339(),
                encode(document)?,
                project.id.to_string(),
                sql_u64(expected_revision)?,
            ],
        )
        .map_err(Into::into)
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

fn retain_snapshot(
    snapshots: &mut Vec<StoredEditorProjectSnapshot>,
    project: EditorProject,
    created_at: DateTime<Utc>,
) {
    snapshots.retain(|snapshot| snapshot.summary.revision != project.revision);
    snapshots.insert(
        0,
        StoredEditorProjectSnapshot {
            summary: EditorProjectSnapshot {
                id: Uuid::new_v4(),
                project_id: project.id,
                revision: project.revision,
                name: project.name.clone(),
                created_at,
            },
            project,
        },
    );
    snapshots.truncate(EDITOR_PROJECT_SNAPSHOT_LIMIT);
}

fn verify_highlight_recordings(connection: &Connection, plan: &HighlightEditPlan) -> Result<()> {
    if plan.mappings.len() != plan.insertions.len() {
        return Err(StorageError::Domain(
            vibe_cs_domain::DomainError::InvalidInput(
                "highlight edit mappings no longer match their insertions".to_owned(),
            ),
        ));
    }
    for mapping in &plan.mappings {
        let Some(recorded) =
            get_document::<RecordedClip>(connection, "recorded_clips", mapping.recorded_clip_id)?
        else {
            return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                format!(
                    "recorded clip {} is no longer available",
                    mapping.recorded_clip_id
                ),
            )));
        };
        let highlight_id = recorded
            .metadata
            .get("highlight_id")
            .or_else(|| recorded.metadata.get("source_highlight_id"))
            .and_then(serde_json::Value::as_str);
        let capture_start_tick = recorded
            .metadata
            .get("effective_start_tick")
            .and_then(serde_json::Value::as_u64);
        let capture_end_tick = recorded
            .metadata
            .get("effective_end_tick")
            .and_then(serde_json::Value::as_u64);
        if recorded.demo_id != Some(plan.demo_id)
            || highlight_id != Some(mapping.highlight_id.as_str())
            || capture_start_tick != Some(mapping.capture_start_tick)
            || capture_end_tick != Some(mapping.capture_end_tick)
            || recorded.path != mapping.path
            || !recorded.duration_seconds.is_finite()
            || (recorded.duration_seconds - mapping.duration_seconds).abs() > 0.001
        {
            return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                format!(
                    "recorded clip {} changed after proposal preview",
                    mapping.recorded_clip_id
                ),
            )));
        }
    }
    Ok(())
}

fn mark_highlight_edit_applied(
    project: &mut EditorProject,
    proposal_fingerprint: &str,
    inserted_clip_ids: &[Uuid],
) {
    if !project.settings.is_object() {
        project.settings = serde_json::json!({});
    }
    project
        .settings
        .as_object_mut()
        .expect("settings was normalized to an object")
        .insert(
            "last_agent_highlight_edit".to_owned(),
            serde_json::json!({
                "proposal_fingerprint": proposal_fingerprint,
                "inserted_clip_ids": inserted_clip_ids,
            }),
        );
}

fn highlight_edit_already_applied(
    project: &EditorProject,
    plan: &HighlightEditPlan,
    proposal_fingerprint: &str,
) -> bool {
    let marker = project
        .settings
        .get("last_agent_highlight_edit")
        .and_then(serde_json::Value::as_object);
    if marker
        .and_then(|value| value.get("proposal_fingerprint"))
        .and_then(serde_json::Value::as_str)
        != Some(proposal_fingerprint)
    {
        return false;
    }
    let planned_ids = plan
        .insertions
        .iter()
        .map(|insertion| insertion.editor_clip_id)
        .collect::<Vec<_>>();
    let Some(marker_ids) = marker
        .and_then(|value| value.get("inserted_clip_ids"))
        .and_then(serde_json::Value::as_array)
        .and_then(|values| {
            values
                .iter()
                .map(|value| value.as_str().and_then(|id| Uuid::parse_str(id).ok()))
                .collect::<Option<Vec<_>>>()
        })
    else {
        return false;
    };
    if marker_ids != planned_ids {
        return false;
    }
    plan.insertions.iter().all(|insertion| {
        project
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .any(|clip| {
                clip.id == insertion.editor_clip_id
                    && clip.asset_id == Some(insertion.recorded_clip_id)
                    && clip
                        .metadata
                        .get("highlight_id")
                        .and_then(serde_json::Value::as_str)
                        == Some(insertion.highlight_id.as_str())
            })
    })
}

const MAX_EVIDENCE_ITEMS_PER_ANALYSIS: usize = 200_000;
const MAX_EVIDENCE_SOURCE_ID_CHARS: usize = 256;

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

fn collect_editor_project_documents(
    rows: &mut rusqlite::Rows<'_>,
) -> Result<Vec<EditorProjectDocument>> {
    let mut documents = Vec::new();
    while let Some(row) = rows.next()? {
        documents.push(decode_editor_project_document(&row.get::<_, String>(0)?)?);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    fn demo(path: &str) -> DemoRecord {
        let now = Utc::now();
        DemoRecord {
            id: Uuid::new_v4(),
            path: path.to_owned(),
            file_name: "match.dem".to_owned(),
            display_name: "Match".to_owned(),
            source: "manual".to_owned(),
            status: DemoStatus::Discovered,
            map_name: Some("de_nuke".to_owned()),
            match_date: None,
            duration_seconds: None,
            total_rounds: None,
            team_a_name: None,
            team_b_name: None,
            team_a_score: None,
            team_b_score: None,
            player_names: Vec::new(),
            remark: String::new(),
            content_sha256: Some(hex::encode(Sha256::digest(path.as_bytes()))),
            file_size: 42,
            created_at: now,
            updated_at: now,
        }
    }

    #[tokio::test]
    async fn demo_metadata_persists_provider_comment_and_catalog_tags() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo("C:/demos/metadata.dem");
        storage.put_demo(record.clone()).await.expect("put demo");

        let review = storage
            .create_demo_tag(DemoTagCreate {
                name: "Review".to_owned(),
                color: "#2563eb".to_owned(),
            })
            .await
            .expect("create tag");
        let major = storage
            .create_demo_tag(DemoTagCreate {
                name: "Major".to_owned(),
                color: "#dc2626".to_owned(),
            })
            .await
            .expect("create tag");

        let updated = storage
            .update_demo_metadata(
                record.id,
                DemoMetadataUpdate {
                    match_source: Some(DemoMatchSource::Faceit),
                    comment: "Recheck round 12".to_owned(),
                    tag_ids: vec![review.id, major.id],
                },
            )
            .await
            .expect("update metadata")
            .expect("demo exists");

        assert_eq!(updated.demo_id, record.id);
        assert_eq!(updated.match_source, Some(DemoMatchSource::Faceit));
        assert_eq!(updated.comment, "Recheck round 12");
        assert_eq!(updated.tags, vec![review.clone(), major.clone()]);
        assert_eq!(
            storage
                .get_demo(record.id)
                .await
                .expect("read demo")
                .expect("demo exists")
                .remark,
            "Recheck round 12"
        );

        let replaced = storage
            .update_demo_metadata(
                record.id,
                DemoMetadataUpdate {
                    match_source: Some(DemoMatchSource::Valve),
                    comment: String::new(),
                    tag_ids: vec![major.id],
                },
            )
            .await
            .expect("replace metadata")
            .expect("demo exists");
        assert_eq!(replaced.tags, vec![major]);
        assert_eq!(replaced.match_source, Some(DemoMatchSource::Valve));

        assert!(storage.delete_demo(record.id).await.expect("delete demo"));
        assert!(
            storage
                .get_demo_metadata(record.id)
                .await
                .expect("read deleted metadata")
                .is_none()
        );
    }

    #[tokio::test]
    async fn demo_directory_filters_catalog_metadata_before_pagination() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let faceit = demo("C:/demos/faceit.dem");
        let valve = demo("C:/demos/valve.dem");
        storage
            .put_demos(vec![faceit.clone(), valve.clone()])
            .await
            .expect("put demos");
        let major = storage
            .create_demo_tag(DemoTagCreate {
                name: "Major".to_owned(),
                color: "#dc2626".to_owned(),
            })
            .await
            .expect("create tag");
        storage
            .update_demo_metadata(
                faceit.id,
                DemoMetadataUpdate {
                    match_source: Some(DemoMatchSource::Faceit),
                    comment: String::new(),
                    tag_ids: vec![major.id],
                },
            )
            .await
            .expect("faceit metadata");
        storage
            .update_demo_metadata(
                valve.id,
                DemoMetadataUpdate {
                    match_source: Some(DemoMatchSource::Valve),
                    comment: String::new(),
                    tag_ids: Vec::new(),
                },
            )
            .await
            .expect("valve metadata");

        let filtered = storage
            .list_demos(DemoQuery {
                match_source: Some(DemoMatchSource::Faceit),
                tag_id: Some(major.id),
                page: Some(1),
                page_size: Some(1),
                ..DemoQuery::default()
            })
            .await
            .expect("filtered directory");
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.items.len(), 1);
        assert_eq!(filtered.items[0].id, faceit.id);
    }

    #[tokio::test]
    async fn demo_tag_catalog_rename_and_delete_updates_assigned_metadata() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo("C:/demos/tag-catalog.dem");
        storage.put_demo(record.clone()).await.expect("put demo");
        let tag = storage
            .create_demo_tag(DemoTagCreate {
                name: "Review".to_owned(),
                color: "#2563eb".to_owned(),
            })
            .await
            .expect("create tag");
        storage
            .update_demo_metadata(
                record.id,
                DemoMetadataUpdate {
                    match_source: None,
                    comment: String::new(),
                    tag_ids: vec![tag.id],
                },
            )
            .await
            .expect("assign tag");

        let renamed = storage
            .update_demo_tag(
                tag.id,
                DemoTagCreate {
                    name: "Needs review".to_owned(),
                    color: "#dc2626".to_owned(),
                },
            )
            .await
            .expect("rename tag")
            .expect("tag exists");
        assert_eq!(renamed.id, tag.id);
        assert_eq!(renamed.created_at, tag.created_at);
        assert_eq!(renamed.name, "Needs review");
        assert_eq!(renamed.color, "#dc2626");
        assert_eq!(
            storage
                .get_demo_metadata(record.id)
                .await
                .expect("metadata")
                .expect("demo exists")
                .tags,
            vec![renamed]
        );

        assert!(storage.delete_demo_tag(tag.id).await.expect("delete tag"));
        assert!(
            storage
                .get_demo_metadata(record.id)
                .await
                .expect("metadata")
                .expect("demo exists")
                .tags
                .is_empty()
        );
        assert!(
            !storage
                .delete_demo_tag(tag.id)
                .await
                .expect("delete missing tag")
        );
    }

    #[tokio::test]
    async fn demo_metadata_batch_is_atomic_across_explicit_demo_ids() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let first = demo("C:/demos/batch-first.dem");
        let second = demo("C:/demos/batch-second.dem");
        storage
            .put_demos(vec![first.clone(), second.clone()])
            .await
            .expect("put demos");
        let tag = storage
            .create_demo_tag(DemoTagCreate {
                name: "Major".to_owned(),
                color: "#dc2626".to_owned(),
            })
            .await
            .expect("create tag");

        let updated = storage
            .update_demo_metadata_batch(DemoMetadataBatchUpdate {
                demo_ids: vec![first.id, second.id],
                set_match_source: true,
                match_source: Some(DemoMatchSource::Esl),
                add_tag_ids: vec![tag.id],
                remove_tag_ids: Vec::new(),
            })
            .await
            .expect("batch update");
        assert_eq!(updated.len(), 2);
        assert!(
            updated
                .iter()
                .all(|item| item.match_source == Some(DemoMatchSource::Esl))
        );
        assert!(
            updated.iter().all(
                |item| item.tags.iter().map(|item| item.id).collect::<Vec<_>>() == vec![tag.id]
            )
        );

        let missing = Uuid::new_v4();
        assert!(
            storage
                .update_demo_metadata_batch(DemoMetadataBatchUpdate {
                    demo_ids: vec![first.id, missing],
                    set_match_source: true,
                    match_source: Some(DemoMatchSource::Valve),
                    add_tag_ids: Vec::new(),
                    remove_tag_ids: vec![tag.id],
                })
                .await
                .is_err()
        );
        let unchanged = storage
            .get_demo_metadata(first.id)
            .await
            .expect("metadata")
            .expect("demo");
        assert_eq!(unchanged.match_source, Some(DemoMatchSource::Esl));
        assert_eq!(
            unchanged
                .tags
                .iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            vec![tag.id]
        );
    }

    #[tokio::test]
    async fn demo_metadata_export_uses_the_full_filtered_snapshot_and_a_hard_bound() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let first = demo("C:/demos/export-first.dem");
        let second = demo("C:/demos/export-second.dem");
        storage
            .put_demos(vec![first.clone(), second.clone()])
            .await
            .expect("put demos");
        storage
            .update_demo_metadata(
                first.id,
                DemoMetadataUpdate {
                    match_source: Some(DemoMatchSource::Faceit),
                    comment: "Final".to_owned(),
                    tag_ids: Vec::new(),
                },
            )
            .await
            .expect("metadata");

        let rows = storage
            .list_demo_metadata_export(
                DemoQuery {
                    match_source: Some(DemoMatchSource::Faceit),
                    page: Some(99),
                    page_size: Some(1),
                    ..DemoQuery::default()
                },
                10,
            )
            .await
            .expect("export");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0.id, first.id);
        assert_eq!(rows[0].1.comment, "Final");

        assert!(
            storage
                .list_demo_metadata_export(DemoQuery::default(), 1)
                .await
                .is_err()
        );
    }

    async fn persist_completed_analysis(storage: &Storage, analysis: MatchAnalysis) {
        let demo = storage
            .get_demo(analysis.demo_id)
            .await
            .expect("read analysis demo")
            .expect("analysis demo exists");
        let fingerprint = vibe_cs_domain::AnalysisInputFingerprint {
            sha256: demo.content_sha256.clone().expect("demo fingerprint"),
            size: demo.file_size,
        };
        let run_id = storage
            .start_analysis_run(demo.id)
            .await
            .expect("start analysis run")
            .run
            .id;
        storage
            .bind_analysis_run_input(run_id, fingerprint.clone())
            .await
            .expect("bind analysis input");
        storage
            .mark_analysis_parser_started(run_id)
            .await
            .expect("mark parser started");
        storage
            .mark_analysis_input_revalidation_started(run_id)
            .await
            .expect("mark input revalidation");
        storage
            .mark_analysis_projection_started(run_id)
            .await
            .expect("mark projection started");
        storage
            .complete_analysis_run(run_id, analysis, fingerprint)
            .await
            .expect("complete analysis run");
    }

    async fn put_annotation_evidence(storage: &Storage, path: &str) -> (Uuid, String) {
        let record = demo(path);
        let demo_id = record.id;
        storage.put_demo(record).await.expect("put demo");
        persist_completed_analysis(
            storage,
            MatchAnalysis {
                demo_id,
                map_name: "de_anubis".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 10.0,
                verified_total_ticks: Some(640),
                teams: vec![],
                players: vec![],
                rounds: vec![vibe_cs_domain::RoundSummary {
                    number: 1,
                    start_tick: 1,
                    end_tick: 640,
                    winner: String::new(),
                    reason: String::new(),
                    team_a_score: 0,
                    team_b_score: 0,
                    events: vec![vibe_cs_domain::TimelineEvent {
                        id: "player_death-320-1".to_owned(),
                        tick: 320,
                        seconds: 5.0,
                        kind: vibe_cs_domain::EventKind::Kill,
                        actor: None,
                        target: None,
                        weapon: None,
                        headshot: false,
                        penetrated: false,
                        position: None,
                        detail: serde_json::json!({}),
                    }],
                }],
                highlights: vec![],
            },
        )
        .await;
        (demo_id, format!("demo:{demo_id}/event:player_death-320-1"))
    }

    #[tokio::test]
    async fn cosmetic_plans_round_trip_and_follow_demo_deletion() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let demo = demo("C:/matches/cosmetics.dem");
        storage.put_demo(demo.clone()).await.expect("demo");
        let now = Utc::now();
        let plan = CosmeticPlan {
            id: Uuid::new_v4(),
            demo_id: demo.id,
            name: "Loadout".to_owned(),
            patches: serde_json::json!([{"values":{"paint_kit":600}}]),
            created_at: now,
            updated_at: now,
        };
        storage.put_cosmetic_plan(plan.clone()).await.expect("plan");
        assert_eq!(
            storage.list_cosmetic_plans(demo.id).await.expect("list"),
            vec![plan]
        );

        assert!(storage.delete_demo(demo.id).await.expect("delete demo"));
        assert!(
            storage
                .list_cosmetic_plans(demo.id)
                .await
                .expect("list after delete")
                .is_empty()
        );
    }

    fn editor_project(name: &str, revision: u64) -> EditorProject {
        let now = Utc::now();
        EditorProject {
            id: Uuid::new_v4(),
            name: name.to_owned(),
            width: 1920,
            height: 1080,
            fps: 60,
            duration_seconds: 12.5,
            tracks: Vec::new(),
            markers: Vec::new(),
            settings: serde_json::Value::Object(serde_json::Map::new()),
            revision,
            created_at: now,
            updated_at: now,
        }
    }

    fn editor_project_with_asset(name: &str, revision: u64, asset_id: Uuid) -> EditorProject {
        let mut project = editor_project(name, revision);
        project.duration_seconds = 4.0;
        project.tracks = vec![vibe_cs_domain::EditorTrack {
            id: Uuid::new_v4(),
            name: "Video".to_owned(),
            kind: vibe_cs_domain::TrackKind::Video,
            order: 0,
            muted: false,
            locked: false,
            hidden: false,
            clips: vec![vibe_cs_domain::EditorClip {
                id: Uuid::new_v4(),
                asset_id: Some(asset_id),
                name: "Source".to_owned(),
                start: 0.0,
                duration: 4.0,
                source_in: 0.0,
                source_out: 4.0,
                speed: 1.0,
                volume: 1.0,
                transform: vibe_cs_domain::Transform::default(),
                effects: vec![vibe_cs_domain::EditorEffect {
                    id: "future-effect".to_owned(),
                    kind: "future_effect".to_owned(),
                    enabled: true,
                    parameters: serde_json::json!({"kept": true}),
                }],
                transition_in: None,
                transition_out: None,
                text: None,
                metadata: serde_json::json!({}),
                group_id: None,
                link_group_id: None,
                keyframes: vec![vibe_cs_domain::EditorKeyframe {
                    id: Uuid::new_v4(),
                    time: 1.0,
                    property: vibe_cs_domain::EditorKeyframeProperty::Opacity,
                    value: 0.75,
                }],
                speed_segments: Vec::new(),
            }],
        }];
        project
    }

    fn preset_document(volume: f64) -> EditorPresetDocument {
        EditorPresetDocument {
            transform: vibe_cs_domain::Transform {
                x: 42.0,
                opacity: 0.6,
                ..vibe_cs_domain::Transform::default()
            },
            volume,
            color_adjust: Some(vibe_cs_domain::EditorColorAdjustPreset {
                brightness: 0.1,
                contrast: 1.2,
                saturation: 0.8,
            }),
            grayscale: true,
            blur_radius: Some(3.0),
            transition_in: Some(vibe_cs_domain::EditorTransitionPreset::Fade),
            transition_out: None,
        }
    }

    fn media_asset(id: Uuid, project_id: Uuid, path: &str) -> MediaAsset {
        MediaAsset {
            id,
            project_id: Some(project_id),
            path: path.to_owned(),
            name: "Asset".to_owned(),
            kind: "video/mp4".to_owned(),
            duration_seconds: Some(4.0),
            width: Some(320),
            height: Some(180),
            file_size: 100,
            has_audio: true,
            proxy_path: Some(format!("{path}.proxy.mp4")),
            proxy_status: MediaProxyStatus::NotRequested,
            waveform: None,
            metadata_status: vibe_cs_domain::MediaMetadataStatus::Ready,
            created_at: Utc::now(),
        }
    }

    async fn committed_file_quarantine(
        root: &Path,
    ) -> (Storage, ManagedFileStaging, PathBuf, ManagedFileQuarantine) {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let managed_root = root.join("uploads").join("assets");
        std::fs::create_dir_all(&managed_root).expect("managed root");
        let source = managed_root.join("owned.mp4");
        std::fs::write(&source, b"owned-by-project").expect("source file");
        let asset_id = Uuid::new_v4();
        let project = editor_project_with_asset("Committed quarantine", 1, asset_id);
        storage
            .put_editor_project(project.clone())
            .await
            .expect("put project");
        storage
            .put_asset(media_asset(asset_id, project.id, &source.to_string_lossy()))
            .await
            .expect("put asset");
        let staging = ManagedFileStaging {
            managed_roots: vec![managed_root],
            cleanup_root: root.join("cleanup"),
            quarantine_root: root.join("cleanup").join("editor-projects"),
        };
        let deleted = storage
            .delete_editor_projects_staged(
                vec![EditorProjectRevision {
                    id: project.id,
                    expected_revision: 1,
                }],
                staging.clone(),
            )
            .await
            .expect("delete project");
        let EditorProjectDeletion::Deleted(deleted) = deleted else {
            panic!("project should be deleted");
        };
        let quarantine = deleted.file_quarantine.expect("quarantine");
        (storage, staging, source, quarantine)
    }

    #[tokio::test]
    async fn config_and_demo_round_trip() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let config = AppConfig {
            locale: "en-US".to_owned(),
            ..AppConfig::default()
        };
        storage
            .put_config(config.clone())
            .await
            .expect("put config");
        assert_eq!(
            storage.get_config().await.expect("get config"),
            Some(config)
        );

        let mut record = demo("C:/matches/match.dem");
        record.content_sha256 = Some("a".repeat(64));
        storage.put_demo(record.clone()).await.expect("put demo");
        assert_eq!(
            storage.get_demo(record.id).await.expect("get demo"),
            Some(record.clone())
        );
        assert_eq!(
            storage
                .get_demo_by_hash("a".repeat(64))
                .await
                .expect("get demo by hash"),
            Some(record)
        );
    }

    #[tokio::test]
    async fn completing_analysis_atomically_populates_the_demo_summary() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo("C:/matches/major-final.dem");
        storage.put_demo(record.clone()).await.expect("put demo");
        let team_a = ["a1", "a2", "a3", "a4", "a5"];
        let team_b = ["b1", "b2", "b3", "b4", "b5"];
        let player = |id: &&str, side: &str| vibe_cs_domain::PlayerStats {
            steam_id: (*id).to_owned(),
            spectator_slot: None,
            name: (*id).to_owned(),
            team: side.to_owned(),
            kills: 0,
            deaths: 0,
            assists: 0,
            headshots: 0,
            damage: 0,
            adr: 0.0,
            kill_death_ratio: 0.0,
            score: 0,
        };
        let roster = |team_a_side: &str, team_b_side: &str| {
            team_a
                .iter()
                .map(|id| ((*id).to_owned(), team_a_side.to_owned()))
                .chain(
                    team_b
                        .iter()
                        .map(|id| ((*id).to_owned(), team_b_side.to_owned())),
                )
                .collect::<std::collections::BTreeMap<_, _>>()
        };
        let round = |number: u32, winner: &str, roster| vibe_cs_domain::RoundSummary {
            number,
            start_tick: u64::from(number) * 100,
            end_tick: u64::from(number) * 100 + 99,
            winner: winner.to_owned(),
            reason: "target_bombed".to_owned(),
            team_a_score: 0,
            team_b_score: 0,
            events: vec![vibe_cs_domain::TimelineEvent {
                id: format!("round-{number}-start"),
                tick: u64::from(number) * 100,
                seconds: f64::from(number),
                kind: vibe_cs_domain::EventKind::RoundStart,
                actor: None,
                target: None,
                weapon: None,
                headshot: false,
                penetrated: false,
                position: None,
                detail: serde_json::json!({ "_round_roster": roster }),
            }],
        };
        let analysis = MatchAnalysis {
            demo_id: record.id,
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 2_958.062_5,
            verified_total_ticks: None,
            teams: vec![
                vibe_cs_domain::TeamSummary {
                    name: "T".to_owned(),
                    side: "T".to_owned(),
                    score: 3,
                    players: team_b.iter().map(|id| (*id).to_owned()).collect(),
                },
                vibe_cs_domain::TeamSummary {
                    name: "CT".to_owned(),
                    side: "CT".to_owned(),
                    score: 1,
                    players: team_a.iter().map(|id| (*id).to_owned()).collect(),
                },
            ],
            players: team_a
                .iter()
                .map(|id| player(id, "CT"))
                .chain(team_b.iter().map(|id| player(id, "T")))
                .collect(),
            rounds: vec![
                round(1, "CT", roster("T", "CT")),
                round(2, "T", roster("T", "CT")),
                round(3, "T", roster("CT", "T")),
                round(4, "T", roster("CT", "T")),
            ],
            highlights: vec![],
        };
        let mut normalized = analysis.clone();
        assert!(normalized.normalize_team_continuity());

        persist_completed_analysis(&storage, analysis).await;

        let completed = storage
            .get_demo(record.id)
            .await
            .expect("get demo")
            .expect("demo exists");
        assert_eq!(completed.status, DemoStatus::Ready);
        assert_eq!(completed.map_name.as_deref(), Some("de_mirage"));
        assert_eq!(completed.duration_seconds, Some(2_958.062_5));
        assert_eq!(completed.total_rounds, Some(4));
        assert_eq!(completed.team_a_name.as_deref(), Some("Team A"));
        assert_eq!(completed.team_b_name.as_deref(), Some("Team B"));
        assert_eq!(completed.team_a_score, Some(1));
        assert_eq!(completed.team_b_score, Some(3));
        assert_eq!(
            completed.player_names,
            vec!["a1", "a2", "a3", "a4", "a5", "b1", "b2", "b3", "b4", "b5"]
        );
        assert_eq!(
            storage.get_analysis(record.id).await.expect("get analysis"),
            Some(normalized)
        );
    }

    #[tokio::test]
    async fn evidence_search_crosses_matches_with_stable_canonical_evidence() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let player = |id: &str, name: &str| vibe_cs_domain::PlayerStats {
            steam_id: id.to_owned(),
            spectator_slot: None,
            name: name.to_owned(),
            team: "A".to_owned(),
            kills: 0,
            deaths: 0,
            assists: 0,
            headshots: 0,
            damage: 0,
            adr: 0.0,
            kill_death_ratio: 0.0,
            score: 0,
        };

        let mut fallen_demo = demo("C:/matches/fallen-major.dem");
        fallen_demo.display_name = "Major FalleN 4K".to_owned();
        fallen_demo.match_date = Some("2024-03-30T12:00:00Z".parse().expect("date"));
        let fallen_id = fallen_demo.id;
        storage
            .put_demo(fallen_demo)
            .await
            .expect("put FalleN demo");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id: fallen_id,
                map_name: "de_mirage".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 100.0,
                verified_total_ticks: Some(6_400),
                teams: vec![],
                players: vec![
                    player("fallen-id", "FalleN"),
                    player("victim-a", "Victim A"),
                    player("victim-b", "Victim B"),
                    player("victim-c", "Victim C"),
                    player("victim-d", "Victim D"),
                ],
                rounds: vec![vibe_cs_domain::RoundSummary {
                    number: 12,
                    start_tick: 1_000,
                    end_tick: 2_000,
                    winner: "A".to_owned(),
                    reason: String::new(),
                    team_a_score: 7,
                    team_b_score: 5,
                    events: vec![],
                }],
                highlights: vec![vibe_cs_domain::Highlight {
                    id: "fallen-4k-r12".to_owned(),
                    player_id: "fallen-id".to_owned(),
                    round: 12,
                    start_tick: 1_200,
                    end_tick: 1_500,
                    kind: vibe_cs_domain::HighlightKind::MultiKill,
                    title: "FalleN 4K".to_owned(),
                    description: "Four kills".to_owned(),
                    score: 0.95,
                    tags: vec!["4k".to_owned(), "awp".to_owned()],
                    victims: vec![
                        "victim-a".to_owned(),
                        "victim-b".to_owned(),
                        "victim-c".to_owned(),
                        "victim-d".to_owned(),
                    ],
                }],
            },
        )
        .await;

        let mut niko_demo = demo("C:/matches/niko-major.dem");
        niko_demo.display_name = "Major NiKo opener".to_owned();
        niko_demo.match_date = Some("2024-04-01T12:00:00Z".parse().expect("date"));
        let niko_id = niko_demo.id;
        storage.put_demo(niko_demo).await.expect("put NiKo demo");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id: niko_id,
                map_name: "de_nuke".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 100.0,
                verified_total_ticks: Some(6_400),
                teams: vec![],
                players: vec![player("niko-id", "NiKo"), player("target-id", "ropz")],
                rounds: vec![vibe_cs_domain::RoundSummary {
                    number: 3,
                    start_tick: 100,
                    end_tick: 900,
                    winner: "A".to_owned(),
                    reason: String::new(),
                    team_a_score: 2,
                    team_b_score: 1,
                    events: vec![vibe_cs_domain::TimelineEvent {
                        id: "player_death-640-7".to_owned(),
                        tick: 640,
                        seconds: 10.0,
                        kind: vibe_cs_domain::EventKind::Kill,
                        actor: Some("niko-id".to_owned()),
                        target: Some("target-id".to_owned()),
                        weapon: Some("ak47".to_owned()),
                        headshot: true,
                        penetrated: false,
                        position: Some([10.0, 20.0, 30.0]),
                        detail: serde_json::json!({"untrusted_extra": "not projected"}),
                    }],
                }],
                highlights: vec![],
            },
        )
        .await;

        let all = storage
            .search_evidence(vibe_cs_domain::EvidenceSearchQuery::default())
            .await
            .expect("search across matches");
        assert_eq!(all.total, 2);
        assert_eq!(all.items.len(), 2);
        assert_eq!(all.availability.indexed_demos, 2);
        assert_eq!(all.availability.total_analyses, 2);
        assert!(all.availability.scan_complete);
        assert_eq!(
            all.items
                .iter()
                .map(|item| item.evidence_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                format!("demo:{niko_id}/event:player_death-640-7"),
                format!("demo:{fallen_id}/highlight:fallen-4k-r12"),
            ]
        );
        assert_eq!(all.items[0].actor_name.as_deref(), Some("NiKo"));
        assert_eq!(all.items[0].target_name.as_deref(), Some("ropz"));
        assert!(all.items[0].analysis_href.contains("evidence=demo%3A"));
        assert!(!all.items[0].analysis_href.contains("event="));
        assert!(all.items[0].replay_href.contains("tab=replay"));
        assert_eq!(
            all.items[0].attributes,
            serde_json::json!({"position": [10.0, 20.0, 30.0]})
        );

        let fallen = storage
            .search_evidence(vibe_cs_domain::EvidenceSearchQuery {
                q: Some("FalleN 4K".to_owned()),
                event_family: Some(vibe_cs_domain::EvidenceEventFamily::MultiKill),
                ..vibe_cs_domain::EvidenceSearchQuery::default()
            })
            .await
            .expect("search FalleN multi-kill");
        assert_eq!(fallen.total, 1);
        assert_eq!(fallen.items[0].source_id, "fallen-4k-r12");

        let niko = storage
            .search_evidence(vibe_cs_domain::EvidenceSearchQuery {
                q: Some("NiKo kill".to_owned()),
                event_family: Some(vibe_cs_domain::EvidenceEventFamily::Kill),
                ..vibe_cs_domain::EvidenceSearchQuery::default()
            })
            .await
            .expect("search NiKo kill");
        assert_eq!(niko.total, 1);
        assert_eq!(niko.items[0].source_id, "player_death-640-7");

        let niko_player = storage
            .search_evidence(vibe_cs_domain::EvidenceSearchQuery {
                player: Some("niko-id".to_owned()),
                ..vibe_cs_domain::EvidenceSearchQuery::default()
            })
            .await
            .expect("search all evidence involving NiKo");
        assert_eq!(niko_player.total, 1);
        assert_eq!(niko_player.items[0].source_id, "player_death-640-7");

        let highlight_victim = storage
            .search_evidence(vibe_cs_domain::EvidenceSearchQuery {
                player: Some("victim-a".to_owned()),
                ..vibe_cs_domain::EvidenceSearchQuery::default()
            })
            .await
            .expect("search all evidence involving a highlight victim");
        assert_eq!(highlight_victim.total, 1);
        assert_eq!(highlight_victim.items[0].source_id, "fallen-4k-r12");
    }

    #[tokio::test]
    async fn evidence_annotations_bind_to_projected_evidence_and_survive_reopen() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = directory.path().join("annotations.sqlite3");
        let storage = Storage::open(&database).await.expect("open storage");
        let record = demo("C:/matches/annotated.dem");
        let demo_id = record.id;
        storage.put_demo(record).await.expect("put demo");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id,
                map_name: "de_mirage".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 20.0,
                verified_total_ticks: Some(1_280),
                teams: vec![],
                players: vec![],
                rounds: vec![vibe_cs_domain::RoundSummary {
                    number: 2,
                    start_tick: 100,
                    end_tick: 900,
                    winner: String::new(),
                    reason: String::new(),
                    team_a_score: 1,
                    team_b_score: 1,
                    events: vec![vibe_cs_domain::TimelineEvent {
                        id: "player_death-640-7".to_owned(),
                        tick: 640,
                        seconds: 10.0,
                        kind: vibe_cs_domain::EventKind::Kill,
                        actor: Some("fallen".to_owned()),
                        target: Some("target".to_owned()),
                        weapon: Some("awp".to_owned()),
                        headshot: false,
                        penetrated: false,
                        position: None,
                        detail: serde_json::json!({}),
                    }],
                }],
                highlights: vec![],
            },
        )
        .await;
        let evidence_id = format!("demo:{demo_id}/event:player_death-640-7");

        let created = storage
            .create_evidence_annotation(vibe_cs_domain::CreateEvidenceAnnotation {
                demo_id,
                evidence_id: evidence_id.clone(),
                round: 2,
                tick: 640,
                body: "Hold this crossfire".to_owned(),
                tags: vec!["retake".to_owned()],
            })
            .await
            .expect("create annotation");
        let annotation = match created {
            EvidenceAnnotationCreate::Created(annotation) => annotation,
            other => panic!("unexpected create result: {other:?}"),
        };
        drop(storage);

        let reopened = Storage::open(&database).await.expect("reopen storage");
        let page = reopened
            .list_evidence_annotations(vibe_cs_domain::EvidenceAnnotationQuery {
                evidence_id: Some(evidence_id),
                ..vibe_cs_domain::EvidenceAnnotationQuery::default()
            })
            .await
            .expect("list annotation");
        assert_eq!(page.total, 1);
        assert_eq!(page.items, vec![annotation.clone()]);

        let updated = reopened
            .update_evidence_annotation(
                annotation.id,
                vibe_cs_domain::UpdateEvidenceAnnotation {
                    body: "Resolved after the team review".to_owned(),
                    tags: vec!["retake".to_owned(), "reviewed".to_owned()],
                    review_state: vibe_cs_domain::EvidenceAnnotationReviewState::Resolved,
                },
            )
            .await
            .expect("update annotation")
            .expect("annotation exists");
        assert_eq!(
            updated.review_state,
            EvidenceAnnotationReviewState::Resolved
        );
        assert_eq!(updated.body, "Resolved after the team review");
        assert!(updated.updated_at >= annotation.updated_at);

        assert!(
            reopened
                .delete_evidence_annotation(annotation.id)
                .await
                .expect("delete annotation")
        );
        assert_eq!(
            reopened
                .list_evidence_annotations(vibe_cs_domain::EvidenceAnnotationQuery::default())
                .await
                .expect("list after annotation deletion")
                .total,
            0
        );

        let recreated = reopened
            .create_evidence_annotation(vibe_cs_domain::CreateEvidenceAnnotation {
                demo_id,
                evidence_id: updated.evidence_id,
                round: updated.round,
                tick: updated.tick,
                body: updated.body,
                tags: updated.tags,
            })
            .await
            .expect("recreate annotation");
        assert!(matches!(recreated, EvidenceAnnotationCreate::Created(_)));

        assert!(reopened.delete_demo(demo_id).await.expect("delete demo"));
        assert_eq!(
            reopened
                .list_evidence_annotations(vibe_cs_domain::EvidenceAnnotationQuery::default())
                .await
                .expect("list after demo deletion")
                .total,
            0
        );
    }

    #[tokio::test]
    async fn evidence_annotations_reject_unknown_or_mismatched_evidence_locators() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo("C:/matches/annotation-contract.dem");
        let demo_id = record.id;
        storage.put_demo(record).await.expect("put demo");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id,
                map_name: "de_nuke".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 10.0,
                verified_total_ticks: Some(640),
                teams: vec![],
                players: vec![],
                rounds: vec![vibe_cs_domain::RoundSummary {
                    number: 1,
                    start_tick: 1,
                    end_tick: 640,
                    winner: String::new(),
                    reason: String::new(),
                    team_a_score: 0,
                    team_b_score: 0,
                    events: vec![vibe_cs_domain::TimelineEvent {
                        id: "player_death-320-1".to_owned(),
                        tick: 320,
                        seconds: 5.0,
                        kind: vibe_cs_domain::EventKind::Kill,
                        actor: None,
                        target: None,
                        weapon: None,
                        headshot: false,
                        penetrated: false,
                        position: None,
                        detail: serde_json::json!({}),
                    }],
                }],
                highlights: vec![],
            },
        )
        .await;
        let valid_id = format!("demo:{demo_id}/event:player_death-320-1");
        let draft =
            |evidence_id: String, round: u32, tick: u64| vibe_cs_domain::CreateEvidenceAnnotation {
                demo_id,
                evidence_id,
                round,
                tick,
                body: "Review this event".to_owned(),
                tags: vec![],
            };

        assert_eq!(
            storage
                .create_evidence_annotation(draft(valid_id.clone(), 2, 320))
                .await
                .expect("mismatched round"),
            EvidenceAnnotationCreate::EvidenceLocationMismatch
        );
        assert_eq!(
            storage
                .create_evidence_annotation(draft(valid_id, 1, 321))
                .await
                .expect("mismatched tick"),
            EvidenceAnnotationCreate::EvidenceLocationMismatch
        );
        assert_eq!(
            storage
                .create_evidence_annotation(draft("demo:missing/event:nope".to_owned(), 1, 320))
                .await
                .expect("unknown evidence"),
            EvidenceAnnotationCreate::EvidenceNotFound
        );
        assert_eq!(
            storage
                .list_evidence_annotations(EvidenceAnnotationQuery::default())
                .await
                .expect("list annotations")
                .total,
            0
        );
    }

    #[tokio::test]
    async fn evidence_annotation_body_search_filters_before_pagination() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let (demo_id, evidence_id) =
            put_annotation_evidence(&storage, "C:/matches/annotation-search.dem").await;
        let create = |body: &str| vibe_cs_domain::CreateEvidenceAnnotation {
            demo_id,
            evidence_id: evidence_id.clone(),
            round: 1,
            tick: 320,
            body: body.to_owned(),
            tags: vec![],
        };

        let matching = storage
            .create_evidence_annotation(create("Review the late B retake"))
            .await
            .expect("create matching annotation");
        let matching = match matching {
            EvidenceAnnotationCreate::Created(annotation) => annotation,
            other => panic!("unexpected create result: {other:?}"),
        };
        std::thread::sleep(std::time::Duration::from_millis(2));
        let newer = storage
            .create_evidence_annotation(create("Check the opening path"))
            .await
            .expect("create newer annotation");
        let newer = match newer {
            EvidenceAnnotationCreate::Created(annotation) => annotation,
            other => panic!("unexpected create result: {other:?}"),
        };
        let unfiltered = storage
            .list_evidence_annotations(EvidenceAnnotationQuery {
                page: Some(1),
                page_size: Some(1),
                ..EvidenceAnnotationQuery::default()
            })
            .await
            .expect("list unfiltered page");
        assert_eq!(unfiltered.items[0].id, newer.id);

        let filtered = storage
            .list_evidence_annotations(EvidenceAnnotationQuery {
                q: Some("  LATE b RETAKE ".to_owned()),
                page: Some(1),
                page_size: Some(1),
                ..EvidenceAnnotationQuery::default()
            })
            .await
            .expect("search annotation body");

        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.items.len(), 1);
        assert_eq!(filtered.items[0].id, matching.id);
    }

    #[tokio::test]
    async fn evidence_annotation_tag_filter_is_exact_case_insensitive_and_precedes_pagination() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let (demo_id, evidence_id) =
            put_annotation_evidence(&storage, "C:/matches/annotation-tags.dem").await;
        let create = |body: &str, tag: &str| vibe_cs_domain::CreateEvidenceAnnotation {
            demo_id,
            evidence_id: evidence_id.clone(),
            round: 1,
            tick: 320,
            body: body.to_owned(),
            tags: vec![tag.to_owned()],
        };

        let matching = storage
            .create_evidence_annotation(create("Review the retake", "Retake"))
            .await
            .expect("create matching annotation");
        let matching = match matching {
            EvidenceAnnotationCreate::Created(annotation) => annotation,
            other => panic!("unexpected create result: {other:?}"),
        };
        std::thread::sleep(std::time::Duration::from_millis(2));
        let newer = storage
            .create_evidence_annotation(create("Review the setup", "retake-plan"))
            .await
            .expect("create newer annotation");
        let newer = match newer {
            EvidenceAnnotationCreate::Created(annotation) => annotation,
            other => panic!("unexpected create result: {other:?}"),
        };
        let unfiltered = storage
            .list_evidence_annotations(EvidenceAnnotationQuery {
                page: Some(1),
                page_size: Some(1),
                ..EvidenceAnnotationQuery::default()
            })
            .await
            .expect("list unfiltered page");
        assert_eq!(unfiltered.items[0].id, newer.id);

        let filtered = storage
            .list_evidence_annotations(EvidenceAnnotationQuery {
                tag: Some("  RETAKE ".to_owned()),
                page: Some(1),
                page_size: Some(1),
                ..EvidenceAnnotationQuery::default()
            })
            .await
            .expect("filter annotations by tag");

        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.items.len(), 1);
        assert_eq!(filtered.items[0].id, matching.id);
    }

    #[tokio::test]
    async fn evidence_annotation_state_and_locator_filters_precede_pagination() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let (demo_id, evidence_id) =
            put_annotation_evidence(&storage, "C:/matches/annotation-state-a.dem").await;
        let (other_demo_id, other_evidence_id) =
            put_annotation_evidence(&storage, "C:/matches/annotation-state-b.dem").await;
        let create =
            |demo_id, evidence_id: String, body: &str| vibe_cs_domain::CreateEvidenceAnnotation {
                demo_id,
                evidence_id,
                round: 1,
                tick: 320,
                body: body.to_owned(),
                tags: vec![],
            };

        let matching = storage
            .create_evidence_annotation(create(
                demo_id,
                evidence_id.clone(),
                "Resolved evidence review",
            ))
            .await
            .expect("create matching annotation");
        let matching = match matching {
            EvidenceAnnotationCreate::Created(annotation) => annotation,
            other => panic!("unexpected create result: {other:?}"),
        };
        let matching = storage
            .update_evidence_annotation(
                matching.id,
                vibe_cs_domain::UpdateEvidenceAnnotation {
                    body: matching.body,
                    tags: matching.tags,
                    review_state: EvidenceAnnotationReviewState::Resolved,
                },
            )
            .await
            .expect("resolve matching annotation")
            .expect("matching annotation exists");
        std::thread::sleep(std::time::Duration::from_millis(2));
        storage
            .create_evidence_annotation(create(
                other_demo_id,
                other_evidence_id,
                "Newer resolved review from another demo",
            ))
            .await
            .expect("create other annotation");
        let other = storage
            .list_evidence_annotations(EvidenceAnnotationQuery {
                demo_id: Some(other_demo_id),
                ..EvidenceAnnotationQuery::default()
            })
            .await
            .expect("list other annotation")
            .items
            .into_iter()
            .next()
            .expect("other annotation");
        storage
            .update_evidence_annotation(
                other.id,
                vibe_cs_domain::UpdateEvidenceAnnotation {
                    body: other.body,
                    tags: other.tags,
                    review_state: EvidenceAnnotationReviewState::Resolved,
                },
            )
            .await
            .expect("resolve other annotation");

        let filtered = storage
            .list_evidence_annotations(EvidenceAnnotationQuery {
                demo_id: Some(demo_id),
                evidence_id: Some(format!("  {evidence_id}  ")),
                state: Some(EvidenceAnnotationReviewState::Resolved),
                page: Some(1),
                page_size: Some(1),
                ..EvidenceAnnotationQuery::default()
            })
            .await
            .expect("filter by state and canonical locator");

        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.items, vec![matching]);
    }

    #[tokio::test]
    #[ignore = "requires VIBE_CS_REAL_APP_DATA_DIR with the imported Major M1 analysis"]
    async fn real_major_m1_projection_finds_fallen_4k_and_stable_niko_kills() {
        let source_path = PathBuf::from(
            std::env::var("VIBE_CS_REAL_APP_DATA_DIR").expect("real app data directory"),
        )
        .join("vibe-cs.db");
        let source = Connection::open_with_flags(
            source_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("open real database read-only");
        let temporary = tempfile::tempdir().expect("temporary directory");
        let copied_database = temporary.path().join("major-m1.sqlite3");
        source
            .backup(rusqlite::MAIN_DB, &copied_database, None)
            .expect("copy real database with SQLite backup");
        drop(source);

        let storage = Storage::open(copied_database)
            .await
            .expect("open copied real database");
        let fallen = storage
            .search_evidence(EvidenceSearchQuery {
                q: Some("FalleN 4K".to_owned()),
                event_family: Some(EvidenceEventFamily::MultiKill),
                actor: Some("FalleN".to_owned()),
                round: Some(20),
                ..EvidenceSearchQuery::default()
            })
            .await
            .expect("query real FalleN 4K");
        assert_eq!(fallen.total, 1);
        assert_eq!(
            fallen.items[0].source_id,
            "20:76561197960690195:161114-multikill"
        );
        assert_eq!(fallen.items[0].tick, 160_986);
        assert_eq!(fallen.items[0].end_tick, 161_502);
        assert_eq!(fallen.items[0].actor_name.as_deref(), Some("FalleN"));

        let niko = storage
            .search_evidence(EvidenceSearchQuery {
                q: Some("NiKo kill".to_owned()),
                event_family: Some(EvidenceEventFamily::Kill),
                actor: Some("NiKo".to_owned()),
                ..EvidenceSearchQuery::default()
            })
            .await
            .expect("query real NiKo kills");
        assert_eq!(niko.total, 15);
        assert_eq!(niko.items[0].source_id, "player_death-30392-646");
        assert_eq!(niko.items[0].actor_name.as_deref(), Some("NiKo"));
        assert_eq!(niko.availability.indexed_demos, 1);
        assert_eq!(niko.availability.total_analyses, 1);
        assert!(niko.availability.scan_complete);
    }

    #[tokio::test]
    async fn reopening_storage_rebuilds_a_missing_evidence_projection() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = directory.path().join("evidence.sqlite3");
        let storage = Storage::open(&database).await.expect("open storage");
        let record = demo("C:/matches/rebuild.dem");
        let demo_id = record.id;
        storage.put_demo(record).await.expect("put demo");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id,
                map_name: "de_anubis".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 10.0,
                verified_total_ticks: Some(640),
                teams: vec![],
                players: vec![],
                rounds: vec![vibe_cs_domain::RoundSummary {
                    number: 1,
                    start_tick: 1,
                    end_tick: 10,
                    winner: String::new(),
                    reason: String::new(),
                    team_a_score: 0,
                    team_b_score: 0,
                    events: vec![vibe_cs_domain::TimelineEvent {
                        id: "round_start-1-0".to_owned(),
                        tick: 1,
                        seconds: 1.0 / 64.0,
                        kind: vibe_cs_domain::EventKind::RoundStart,
                        actor: None,
                        target: None,
                        weapon: None,
                        headshot: false,
                        penetrated: false,
                        position: None,
                        detail: serde_json::json!({}),
                    }],
                }],
                highlights: vec![],
            },
        )
        .await;
        storage
            .run(|connection| {
                let transaction = connection.transaction()?;
                transaction.execute("DELETE FROM evidence_search_items", [])?;
                transaction.execute("DELETE FROM evidence_search_projection_state", [])?;
                transaction.commit()?;
                Ok(())
            })
            .await
            .expect("simulate missing projection");
        drop(storage);

        let reopened = Storage::open(&database).await.expect("reopen storage");
        let page = reopened
            .search_evidence(EvidenceSearchQuery::default())
            .await
            .expect("search rebuilt projection");
        assert_eq!(page.total, 1);
        assert_eq!(
            page.items[0].evidence_id,
            format!("demo:{demo_id}/event:round_start-1-0")
        );
    }

    #[tokio::test]
    async fn evidence_search_rejects_out_of_range_pages_instead_of_clamping_them() {
        let storage = Storage::open_in_memory().await.expect("open storage");

        let error = storage
            .search_evidence(EvidenceSearchQuery {
                page_size: Some(vibe_cs_domain::EVIDENCE_SEARCH_MAX_PAGE_SIZE + 1),
                ..EvidenceSearchQuery::default()
            })
            .await
            .expect_err("oversized page must be rejected");

        assert!(matches!(
            error,
            StorageError::Domain(vibe_cs_domain::DomainError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn replacing_and_deleting_analysis_replaces_and_removes_search_evidence() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo("C:/matches/replace-search.dem");
        let demo_id = record.id;
        storage.put_demo(record).await.expect("put demo");
        let analysis = |event_id: &str, weapon: &str| MatchAnalysis {
            demo_id,
            map_name: "de_vertigo".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 10.0,
            verified_total_ticks: Some(640),
            teams: vec![],
            players: vec![],
            rounds: vec![vibe_cs_domain::RoundSummary {
                number: 1,
                start_tick: 1,
                end_tick: 10,
                winner: String::new(),
                reason: String::new(),
                team_a_score: 0,
                team_b_score: 0,
                events: vec![vibe_cs_domain::TimelineEvent {
                    id: event_id.to_owned(),
                    tick: 8,
                    seconds: 0.125,
                    kind: vibe_cs_domain::EventKind::Kill,
                    actor: None,
                    target: None,
                    weapon: Some(weapon.to_owned()),
                    headshot: false,
                    penetrated: false,
                    position: None,
                    detail: serde_json::json!({}),
                }],
            }],
            highlights: vec![],
        };

        persist_completed_analysis(&storage, analysis("old-event", "ak47")).await;
        assert!(
            storage
                .delete_analysis(demo_id)
                .await
                .expect("invalidate first analysis")
        );
        persist_completed_analysis(&storage, analysis("replacement-event", "awp")).await;
        let replacement = storage
            .search_evidence(EvidenceSearchQuery::default())
            .await
            .expect("replacement search");
        assert_eq!(replacement.total, 1);
        assert_eq!(replacement.items[0].source_id, "replacement-event");
        assert_eq!(replacement.items[0].weapon.as_deref(), Some("awp"));

        assert!(
            storage
                .delete_analysis(demo_id)
                .await
                .expect("delete analysis")
        );
        let deleted = storage
            .search_evidence(EvidenceSearchQuery::default())
            .await
            .expect("search after deletion");
        assert_eq!(deleted.total, 0);
        assert_eq!(deleted.availability.indexed_demos, 0);
        assert_eq!(deleted.availability.total_analyses, 0);
        assert!(deleted.availability.scan_complete);
    }

    #[cfg(windows)]
    async fn raw_config_document(storage: &Storage) -> String {
        storage
            .run(|connection| {
                connection
                    .query_row(
                        "SELECT document_json FROM app_config WHERE key = 'app'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(StorageError::from)
            })
            .await
            .expect("raw config document")
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn llm_api_key_is_dpapi_protected_at_rest_and_round_trips() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let mut config = AppConfig::default();
        config.llm.api_key = "storage-test-llm-secret-unique".to_owned();

        storage
            .put_config(config.clone())
            .await
            .expect("put protected config");

        let raw = raw_config_document(&storage).await;
        assert!(!raw.contains("storage-test-llm-secret-unique"));
        assert!(raw.contains(LLM_API_KEY_ENVELOPE_PREFIX));
        assert_eq!(
            storage.get_config().await.expect("get protected config"),
            Some(config)
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn tampered_llm_api_key_envelope_fails_closed() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let mut config = AppConfig::default();
        config.llm.api_key = "tamper-test-secret".to_owned();
        storage.put_config(config).await.expect("put config");

        storage
            .run(|connection| {
                let raw: String = connection.query_row(
                    "SELECT document_json FROM app_config WHERE key = 'app'",
                    [],
                    |row| row.get(0),
                )?;
                let mut document: serde_json::Value = serde_json::from_str(&raw)?;
                let envelope = document["llm"]["api_key"]
                    .as_str()
                    .expect("stored envelope");
                let mut tampered = envelope.as_bytes().to_vec();
                let last = tampered.last_mut().expect("non-empty envelope");
                *last = if *last == b'0' { b'1' } else { b'0' };
                document["llm"]["api_key"] =
                    serde_json::Value::String(String::from_utf8(tampered).expect("ASCII envelope"));
                connection.execute(
                    "UPDATE app_config SET document_json = ?1 WHERE key = 'app'",
                    [serde_json::to_string(&document)?],
                )?;
                Ok(())
            })
            .await
            .expect("tamper stored envelope");

        assert!(matches!(
            storage.get_config().await,
            Err(StorageError::SecretRecovery)
        ));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn stored_llm_key_is_bound_to_its_provider_scope() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let mut config = AppConfig::default();
        config.llm.provider = "openai-compatible".to_owned();
        config.llm.base_url = "https://provider.example/v1".to_owned();
        config.llm.api_key = "scope-bound-secret".to_owned();
        storage.put_config(config).await.expect("put config");

        storage
            .run(|connection| {
                let raw: String = connection.query_row(
                    "SELECT document_json FROM app_config WHERE key = 'app'",
                    [],
                    |row| row.get(0),
                )?;
                let mut document: serde_json::Value = serde_json::from_str(&raw)?;
                document["llm"]["base_url"] =
                    serde_json::Value::String("https://attacker.example/v1".to_owned());
                connection.execute(
                    "UPDATE app_config SET document_json = ?1 WHERE key = 'app'",
                    [serde_json::to_string(&document)?],
                )?;
                Ok(())
            })
            .await
            .expect("tamper stored provider scope");

        assert!(matches!(
            storage.get_config().await,
            Err(StorageError::SecretRecovery)
        ));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn plaintext_llm_key_is_rejected() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let mut plaintext = AppConfig::default();
        plaintext.llm.api_key = "plaintext-llm-secret".to_owned();
        let plaintext_json = encode(&plaintext).expect("encode plaintext config");
        storage
            .run(move |connection| {
                connection.execute(
                    "INSERT INTO app_config(key, document_json, updated_at) VALUES ('app', ?1, ?2)",
                    params![plaintext_json, Utc::now().to_rfc3339()],
                )?;
                Ok(())
            })
            .await
            .expect("insert plaintext config");

        assert!(matches!(
            storage.get_config().await,
            Err(StorageError::SecretRecovery)
        ));
    }

    #[tokio::test]
    async fn analysis_total_ticks_round_trip_and_missing_current_field_is_rejected() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo("C:/matches/verified-ticks.dem");
        let demo_id = record.id;
        storage.put_demo(record).await.expect("put demo");
        let analysis = MatchAnalysis {
            demo_id,
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 120.0,
            verified_total_ticks: Some(7_680),
            teams: vec![],
            players: vec![],
            rounds: vec![],
            highlights: vec![],
        };
        persist_completed_analysis(&storage, analysis.clone()).await;
        assert_eq!(
            storage.get_analysis(demo_id).await.expect("get analysis"),
            Some(analysis)
        );

        storage
            .run(move |connection| {
                let raw: String = connection.query_row(
                    "SELECT document_json FROM analyses WHERE demo_id = ?1",
                    [demo_id.to_string()],
                    |row| row.get(0),
                )?;
                let mut document: serde_json::Value = serde_json::from_str(&raw)?;
                document
                    .as_object_mut()
                    .expect("analysis object")
                    .remove("verified_total_ticks");
                connection.execute(
                    "UPDATE analyses SET document_json = ?1 WHERE demo_id = ?2",
                    params![serde_json::to_string(&document)?, demo_id.to_string()],
                )?;
                Ok(())
            })
            .await
            .expect("remove required current field");

        assert!(matches!(
            storage.get_analysis(demo_id).await,
            Err(StorageError::Serialization(_))
        ));
    }

    #[tokio::test]
    async fn analysis_spectator_slot_round_trips_through_storage() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo("C:/matches/spectator-slot.dem");
        let demo_id = record.id;
        storage.put_demo(record).await.expect("put demo");
        let analysis = MatchAnalysis {
            demo_id,
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 120.0,
            verified_total_ticks: Some(7_680),
            teams: vec![],
            players: vec![vibe_cs_domain::PlayerStats {
                steam_id: "76561198000000001".to_owned(),
                spectator_slot: Some(8),
                name: "Player One".to_owned(),
                team: "T".to_owned(),
                kills: 1,
                deaths: 0,
                assists: 0,
                headshots: 1,
                damage: 100,
                adr: 100.0,
                kill_death_ratio: 1.0,
                score: 2,
            }],
            rounds: vec![],
            highlights: vec![],
        };
        persist_completed_analysis(&storage, analysis.clone()).await;

        assert_eq!(
            storage.get_analysis(demo_id).await.expect("get analysis"),
            Some(analysis)
        );

        storage
            .run(move |connection| {
                let raw: String = connection.query_row(
                    "SELECT document_json FROM analyses WHERE demo_id = ?1",
                    [demo_id.to_string()],
                    |row| row.get(0),
                )?;
                let mut document: serde_json::Value = serde_json::from_str(&raw)?;
                document["players"][0]
                    .as_object_mut()
                    .expect("player object")
                    .remove("spectator_slot");
                connection.execute(
                    "UPDATE analyses SET document_json = ?1 WHERE demo_id = ?2",
                    params![serde_json::to_string(&document)?, demo_id.to_string()],
                )?;
                Ok(())
            })
            .await
            .expect("remove required current player field");

        assert!(matches!(
            storage.get_analysis(demo_id).await,
            Err(StorageError::Serialization(_))
        ));
    }

    #[tokio::test]
    async fn deleting_demo_cascades_analysis() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo("C:/matches/cascade.dem");
        storage.put_demo(record.clone()).await.expect("put demo");
        let analysis = MatchAnalysis {
            demo_id: record.id,
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 0.0,
            verified_total_ticks: None,
            teams: vec![],
            players: vec![],
            rounds: vec![],
            highlights: vec![],
        };
        persist_completed_analysis(&storage, analysis).await;
        assert!(storage.delete_demo(record.id).await.expect("delete demo"));
        assert!(
            storage
                .get_analysis(record.id)
                .await
                .expect("get analysis")
                .is_none()
        );
    }

    #[tokio::test]
    async fn analysis_can_be_invalidated_without_removing_the_demo() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo("C:/matches/changed.dem");
        storage.put_demo(record.clone()).await.expect("put demo");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id: record.id,
                map_name: "de_dust2".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 1.0,
                verified_total_ticks: None,
                teams: vec![],
                players: vec![],
                rounds: vec![],
                highlights: vec![],
            },
        )
        .await;

        assert!(
            storage
                .delete_analysis(record.id)
                .await
                .expect("delete analysis")
        );
        assert!(storage.get_demo(record.id).await.expect("demo").is_some());
        assert!(
            storage
                .get_analysis(record.id)
                .await
                .expect("analysis")
                .is_none()
        );
    }

    #[tokio::test]
    async fn batch_insert_is_transactional() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let first = demo("C:/matches/duplicate.dem");
        let mut second = demo("C:/matches/duplicate.dem");
        second.id = Uuid::new_v4();
        assert!(storage.put_demos(vec![first, second]).await.is_err());
        let page = storage
            .list_demos(DemoQuery::default())
            .await
            .expect("list demos");
        assert_eq!(page.total, 0);
    }

    #[tokio::test]
    async fn demo_search_matches_persisted_player_summaries() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let mut major = demo("C:/matches/major-final.dem");
        major.player_names = vec!["FalleN".to_owned(), "m0NESY".to_owned()];
        storage.put_demo(major.clone()).await.expect("put demo");

        let page = storage
            .list_demos(DemoQuery {
                search: Some("m0nesy".to_owned()),
                ..DemoQuery::default()
            })
            .await
            .expect("search demos");

        assert_eq!(page.total, 1);
        assert_eq!(page.items, vec![major]);
    }

    #[tokio::test]
    async fn demo_listing_applies_stable_map_sort_and_strict_page_bounds() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let mut ancient = demo("C:/matches/ancient.dem");
        ancient.id = Uuid::parse_str("00000000-0000-0000-0000-000000000002").unwrap();
        ancient.file_name = "ancient.dem".to_owned();
        ancient.map_name = Some("de_ancient".to_owned());
        let mut ancient_first = demo("C:/matches/ancient-first.dem");
        ancient_first.id = Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
        ancient_first.file_name = "ancient-first.dem".to_owned();
        ancient_first.map_name = Some("de_ancient".to_owned());
        let mut inferno = demo("C:/matches/inferno.dem");
        inferno.id = Uuid::parse_str("00000000-0000-0000-0000-000000000003").unwrap();
        inferno.file_name = "inferno.dem".to_owned();
        inferno.map_name = Some("de_inferno".to_owned());
        let mut unknown = demo("C:/matches/unknown.dem");
        unknown.id = Uuid::parse_str("00000000-0000-0000-0000-000000000004").unwrap();
        unknown.file_name = "unknown.dem".to_owned();

        storage
            .put_demos(vec![
                unknown.clone(),
                inferno.clone(),
                ancient.clone(),
                ancient_first.clone(),
            ])
            .await
            .expect("put demos");

        let first_page = storage
            .list_demos(DemoQuery {
                sort: Some(vibe_cs_domain::DemoSort::MapAsc),
                page: Some(1),
                page_size: Some(2),
                ..DemoQuery::default()
            })
            .await
            .expect("sorted page");
        assert_eq!(first_page.total, 4);
        assert_eq!(first_page.page, 1);
        assert_eq!(first_page.page_size, 2);
        assert_eq!(first_page.items, vec![ancient_first, ancient]);

        let second_page = storage
            .list_demos(DemoQuery {
                sort: Some(vibe_cs_domain::DemoSort::MapAsc),
                page: Some(2),
                page_size: Some(2),
                ..DemoQuery::default()
            })
            .await
            .expect("second sorted page");
        assert_eq!(second_page.items, vec![inferno, unknown]);

        for query in [
            DemoQuery {
                page: Some(0),
                ..DemoQuery::default()
            },
            DemoQuery {
                page_size: Some(0),
                ..DemoQuery::default()
            },
            DemoQuery {
                page_size: Some(201),
                ..DemoQuery::default()
            },
            DemoQuery {
                page: Some(100_001),
                ..DemoQuery::default()
            },
        ] {
            assert!(matches!(
                storage.list_demos(query).await,
                Err(StorageError::Domain(
                    vibe_cs_domain::DomainError::InvalidInput(_)
                ))
            ));
        }
    }

    #[tokio::test]
    async fn unique_batch_deduplicates_against_storage_and_itself() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let mut existing = demo("C:/matches/existing.dem");
        existing.content_sha256 = Some("a".repeat(64));
        storage.put_demo(existing).await.expect("put existing");

        let mut duplicate_existing = demo("C:/matches/duplicate-existing.dem");
        duplicate_existing.content_sha256 = Some("a".repeat(64));
        let mut first_new = demo("C:/matches/first-new.dem");
        first_new.content_sha256 = Some("b".repeat(64));
        let mut duplicate_new = demo("C:/matches/duplicate-new.dem");
        duplicate_new.content_sha256 = Some("b".repeat(64));

        let (inserted, duplicates) = storage
            .put_unique_demos(vec![duplicate_existing, first_new, duplicate_new])
            .await
            .expect("put unique demos");
        assert_eq!(inserted.len(), 1);
        assert_eq!(duplicates.len(), 2);
        assert_eq!(
            storage
                .list_demos(DemoQuery::default())
                .await
                .expect("list demos")
                .total,
            2
        );
    }

    #[tokio::test]
    async fn concurrent_content_addressed_demo_puts_keep_one_hash_and_report_date_conflict() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = directory.path().join("concurrent-demo.sqlite3");
        let first_storage = Storage::open(&database).await.expect("first storage");
        let second_storage = Storage::open(&database).await.expect("second storage");
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let mut first = demo("C:/matches/first-copy.dem");
        first.content_sha256 = Some("a".repeat(64));
        first.match_date = Some(
            "2025-06-19T20:15:42Z"
                .parse()
                .expect("first trusted match date"),
        );
        let mut second = demo("C:/matches/second-copy.dem");
        second.content_sha256 = Some("a".repeat(64));
        second.match_date = Some(
            "2025-06-20T20:15:42Z"
                .parse()
                .expect("second trusted match date"),
        );
        let first_barrier = Arc::clone(&barrier);
        let first_put = tokio::spawn(async move {
            first_barrier.wait().await;
            first_storage.put_content_addressed_demo(first).await
        });
        let second_barrier = Arc::clone(&barrier);
        let second_put = tokio::spawn(async move {
            second_barrier.wait().await;
            second_storage.put_content_addressed_demo(second).await
        });

        let outcomes = [
            first_put.await.expect("first task"),
            second_put.await.expect("second task"),
        ];

        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(
                    outcome,
                    Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(message)))
                        if message.contains("match date")
                ))
                .count(),
            1
        );
        let verifier = Storage::open(&database)
            .await
            .expect("verification storage");
        let page = verifier
            .list_demos(DemoQuery::default())
            .await
            .expect("list demos");
        assert_eq!(page.total, 1);
        let expected_hash = "a".repeat(64);
        assert_eq!(
            page.items[0].content_sha256.as_deref(),
            Some(expected_hash.as_str())
        );
    }

    #[tokio::test]
    async fn content_replacement_conflict_preserves_the_original_demo_and_analysis() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut original = demo("C:/matches/original.dem");
        original.content_sha256 = Some("1".repeat(64));
        let mut occupied = demo("C:/matches/occupied.dem");
        occupied.content_sha256 = Some("2".repeat(64));
        storage
            .put_demos(vec![original.clone(), occupied])
            .await
            .expect("demos");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id: original.id,
                map_name: "de_nuke".to_owned(),
                duration_seconds: 1.0,
                tick_rate: 64.0,
                verified_total_ticks: Some(64),
                teams: Vec::new(),
                players: Vec::new(),
                rounds: Vec::new(),
                highlights: Vec::new(),
            },
        )
        .await;
        let before = storage
            .get_demo(original.id)
            .await
            .expect("Demo lookup")
            .expect("Demo");
        let mut replacement = before.clone();
        replacement.content_sha256 = Some("2".repeat(64));
        replacement.file_size = 99;
        replacement.status = DemoStatus::Discovered;

        let result = storage.replace_demo_content(replacement).await;

        assert!(matches!(
            result,
            Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                _
            )))
        ));
        assert_eq!(
            storage.get_demo(original.id).await.expect("Demo lookup"),
            Some(before)
        );
        assert!(
            storage
                .get_analysis(original.id)
                .await
                .expect("analysis lookup")
                .is_some()
        );
    }

    #[tokio::test]
    async fn content_addressed_same_id_new_hash_atomically_invalidates_old_analysis() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut original = demo("C:/matches/old-bytes.dem");
        original.content_sha256 = Some("1".repeat(64));
        original.display_name = "User title".to_owned();
        original.remark = "User note".to_owned();
        storage
            .put_demo(original.clone())
            .await
            .expect("original Demo");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id: original.id,
                map_name: "de_nuke".to_owned(),
                duration_seconds: 1.0,
                tick_rate: 64.0,
                verified_total_ticks: Some(64),
                teams: Vec::new(),
                players: Vec::new(),
                rounds: Vec::new(),
                highlights: Vec::new(),
            },
        )
        .await;
        let mut replacement = demo("C:/matches/new-bytes.dem");
        replacement.id = original.id;
        replacement.content_sha256 = Some("2".repeat(64));
        replacement.file_size = 99;

        let replaced = storage
            .put_content_addressed_demo(replacement)
            .await
            .expect("atomic content replacement")
            .into_demo();

        assert_eq!(replaced.id, original.id);
        assert_eq!(
            replaced.content_sha256.as_deref(),
            Some("2222222222222222222222222222222222222222222222222222222222222222")
        );
        assert_eq!(replaced.display_name, "User title");
        assert_eq!(replaced.remark, "User note");
        assert_eq!(replaced.created_at, original.created_at);
        assert!(
            storage
                .get_analysis(original.id)
                .await
                .expect("analysis")
                .is_none()
        );
    }

    #[tokio::test]
    async fn claimed_download_cannot_overwrite_a_concurrently_replaced_linked_demo() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut linked = demo("C:/matches/linked-before-claim.dem");
        linked.content_sha256 = Some("1".repeat(64));
        storage.put_demo(linked.clone()).await.expect("linked Demo");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:88".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "88".to_owned(),
            outcome_id: "880".to_owned(),
            token: 88,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: Some(linked.id),
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let claim = storage
            .claim_match_download(record.id, Some(linked.id), Uuid::new_v4())
            .await
            .expect("claim")
            .expect("match exists");
        let MatchDownloadClaim::Claimed {
            linked_demo: Some(claimed_identity),
            ..
        } = claim
        else {
            panic!("claim must bind the linked Demo identity");
        };
        let mut concurrent = linked.clone();
        concurrent.content_sha256 = Some("2".repeat(64));
        concurrent.file_size = 84;
        concurrent.updated_at = Utc::now();
        storage
            .replace_demo_content(concurrent.clone())
            .await
            .expect("concurrent replacement");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id: linked.id,
                map_name: "de_nuke".to_owned(),
                duration_seconds: 1.0,
                tick_rate: 64.0,
                verified_total_ticks: Some(64),
                teams: Vec::new(),
                players: Vec::new(),
                rounds: Vec::new(),
                highlights: Vec::new(),
            },
        )
        .await;
        let current = storage
            .get_demo(linked.id)
            .await
            .expect("Demo")
            .expect("Demo");
        let mut stale_download = demo("C:/matches/stale-download.dem");
        stale_download.id = linked.id;
        stale_download.content_sha256 = Some("3".repeat(64));
        stale_download.file_size = 96;

        let result = storage
            .put_content_addressed_demo_observed(stale_download, Some(claimed_identity))
            .await;

        assert!(matches!(
            result,
            Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(message)))
                if message.contains("after the download claim")
        ));
        assert_eq!(
            storage.get_demo(linked.id).await.expect("Demo"),
            Some(current)
        );
        assert!(
            storage
                .get_analysis(linked.id)
                .await
                .expect("analysis")
                .is_some()
        );
    }

    #[tokio::test]
    async fn invalid_content_atomically_clears_analysis_and_all_byte_derived_demo_truth() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut original = demo("C:/matches/invalidated.dem");
        original.status = DemoStatus::Ready;
        original.map_name = Some("de_nuke".to_owned());
        original.match_date = Some(Utc::now() - chrono::Duration::days(1));
        original.duration_seconds = Some(120.0);
        original.total_rounds = Some(12);
        original.team_a_name = Some("Alpha".to_owned());
        original.team_b_name = Some("Bravo".to_owned());
        original.team_a_score = Some(7);
        original.team_b_score = Some(5);
        original.player_names = vec!["Player One".to_owned()];
        original.display_name = "User title".to_owned();
        original.remark = "User note".to_owned();
        storage.put_demo(original.clone()).await.expect("Demo");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id: original.id,
                map_name: "de_nuke".to_owned(),
                duration_seconds: 120.0,
                tick_rate: 64.0,
                verified_total_ticks: Some(7_680),
                teams: Vec::new(),
                players: Vec::new(),
                rounds: Vec::new(),
                highlights: Vec::new(),
            },
        )
        .await;
        let expected = storage
            .get_demo(original.id)
            .await
            .expect("Demo lookup")
            .expect("Demo");

        let invalidated = storage
            .invalidate_demo_content(expected, 17)
            .await
            .expect("invalidation")
            .expect("Demo");

        assert_eq!(invalidated.id, original.id);
        assert_eq!(invalidated.path, original.path);
        assert_eq!(invalidated.display_name, "User title");
        assert_eq!(invalidated.remark, "User note");
        assert_eq!(invalidated.created_at, original.created_at);
        assert_eq!(invalidated.status, DemoStatus::Failed);
        assert_eq!(invalidated.content_sha256, None);
        assert_eq!(invalidated.file_size, 17);
        assert_eq!(invalidated.map_name, None);
        assert_eq!(invalidated.match_date, None);
        assert_eq!(invalidated.duration_seconds, None);
        assert_eq!(invalidated.total_rounds, None);
        assert_eq!(invalidated.team_a_name, None);
        assert_eq!(invalidated.team_b_name, None);
        assert_eq!(invalidated.team_a_score, None);
        assert_eq!(invalidated.team_b_score, None);
        assert!(invalidated.player_names.is_empty());
        assert!(
            storage
                .get_analysis(original.id)
                .await
                .expect("analysis")
                .is_none()
        );
    }

    #[tokio::test]
    async fn concurrent_match_download_claims_create_one_active_job_and_one_downloading_transition()
    {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = directory.path().join("concurrent-download.sqlite3");
        let first_storage = Storage::open(&database).await.expect("first storage");
        let second_storage = Storage::open(&database).await.expect("second storage");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:77".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "77".to_owned(),
            outcome_id: "770".to_owned(),
            token: 77,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        first_storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let first_barrier = Arc::clone(&barrier);
        let record_id = record.id.clone();
        let first_claim = tokio::spawn(async move {
            first_barrier.wait().await;
            first_storage
                .claim_match_download(record_id, None, Uuid::new_v4())
                .await
        });
        let second_barrier = Arc::clone(&barrier);
        let record_id = record.id.clone();
        let second_claim = tokio::spawn(async move {
            second_barrier.wait().await;
            second_storage
                .claim_match_download(record_id, None, Uuid::new_v4())
                .await
        });

        let claims = [
            first_claim
                .await
                .expect("first claim task")
                .expect("first claim"),
            second_claim
                .await
                .expect("second claim task")
                .expect("second claim"),
        ];

        assert_eq!(
            claims
                .iter()
                .filter(|claim| matches!(claim, Some(MatchDownloadClaim::Claimed { .. })))
                .count(),
            1
        );
        assert_eq!(
            claims
                .iter()
                .filter(|claim| matches!(claim, Some(MatchDownloadClaim::Existing(_))))
                .count(),
            1
        );
        let verifier = Storage::open(&database)
            .await
            .expect("verification storage");
        assert_eq!(
            verifier
                .list_active_match_download_jobs()
                .await
                .expect("active jobs")
                .len(),
            1
        );
        assert_eq!(
            verifier
                .get_steam_match(record.id)
                .await
                .expect("Steam match lookup")
                .expect("Steam match")
                .demo_status,
            vibe_cs_domain::MatchDemoStatus::Downloading
        );
    }

    #[tokio::test]
    async fn stale_download_claim_cannot_replace_a_newly_completed_demo_link() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:78".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "78".to_owned(),
            outcome_id: "780".to_owned(),
            token: 78,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let linked_demo = demo("C:/matches/completed-between-read-and-claim.dem");
        storage
            .put_demo(linked_demo.clone())
            .await
            .expect("linked Demo");
        let mut completed_record = record.clone();
        completed_record.demo_id = Some(linked_demo.id);
        completed_record.demo_status = vibe_cs_domain::MatchDemoStatus::Downloaded;
        completed_record.updated_at = Utc::now();
        storage
            .put_steam_match(completed_record.clone())
            .await
            .expect("completed match");

        let result = storage
            .claim_match_download(record.id.clone(), record.demo_id, Uuid::new_v4())
            .await;

        assert!(matches!(
            result,
            Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                _
            )))
        ));
        assert_eq!(
            storage
                .get_steam_match(record.id)
                .await
                .expect("Steam match lookup"),
            Some(completed_record)
        );
        assert!(
            storage
                .list_active_match_download_jobs()
                .await
                .expect("active jobs")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn stale_sync_snapshot_preserves_concurrent_download_and_trusted_match_truth() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let trusted = now - chrono::Duration::days(2);
        let record = SteamMatchRecord {
            id: "76561198000000000:83".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "83".to_owned(),
            outcome_id: "830".to_owned(),
            token: 83,
            map_name: Some("de_nuke".to_owned()),
            played_at: Some(trusted),
            score: Some("13:10".to_owned()),
            result: vibe_cs_domain::MatchHistoryResult::Win,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let mut stale_sync = record.clone();
        stale_sync.played_at = None;
        stale_sync.map_name = None;
        stale_sync.score = None;
        stale_sync.result = vibe_cs_domain::MatchHistoryResult::Unknown;
        stale_sync.outcome_id = "831".to_owned();
        stale_sync.token = 84;
        stale_sync.synced_at = now + chrono::Duration::minutes(1);
        stale_sync.updated_at = stale_sync.synced_at;
        let claim = storage
            .claim_match_download(record.id.clone(), None, Uuid::new_v4())
            .await
            .expect("claim")
            .expect("match exists");
        let MatchDownloadClaim::Claimed { mut job, .. } = claim else {
            panic!("first owner must claim");
        };
        job.status = MatchDownloadStatus::Failed;
        job.error = Some("download ticket expired".to_owned());
        job.updated_at = Utc::now();
        storage
            .finalize_match_download(job, None)
            .await
            .expect("finalize")
            .expect("job");

        let (merged, created) = storage
            .merge_synced_steam_matches(vec![stale_sync])
            .await
            .expect("merge stale sync snapshot");

        assert_eq!(created, 0);
        assert_eq!(merged[0].outcome_id, "831");
        assert_eq!(merged[0].token, 84);
        assert_eq!(merged[0].map_name.as_deref(), Some("de_nuke"));
        assert_eq!(merged[0].score.as_deref(), Some("13:10"));
        assert_eq!(merged[0].result, vibe_cs_domain::MatchHistoryResult::Win);
        assert_eq!(merged[0].played_at, Some(trusted));
        assert_eq!(
            merged[0].demo_status,
            vibe_cs_domain::MatchDemoStatus::Failed
        );
        assert_eq!(
            merged[0].last_error.as_deref(),
            Some("download ticket expired")
        );
    }

    #[tokio::test]
    async fn terminal_download_owner_updates_job_and_match_once_without_stale_overwrite() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:79".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "79".to_owned(),
            outcome_id: "790".to_owned(),
            token: 79,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let claim = storage
            .claim_match_download(record.id.clone(), None, Uuid::new_v4())
            .await
            .expect("claim")
            .expect("match exists");
        let MatchDownloadClaim::Claimed { mut job, .. } = claim else {
            panic!("first owner must claim");
        };
        job.status = MatchDownloadStatus::Failed;
        job.error = Some("network failed".to_owned());
        job.updated_at = Utc::now();
        let failed = storage
            .finalize_match_download(job.clone(), None)
            .await
            .expect("failure finalization")
            .expect("owned job");
        assert_eq!(failed.status, MatchDownloadStatus::Failed);
        let mut stale_cancel = job;
        stale_cancel.status = MatchDownloadStatus::Cancelled;
        stale_cancel.error = None;
        stale_cancel.updated_at = Utc::now();

        let observed = storage
            .finalize_match_download(stale_cancel, None)
            .await
            .expect("stale finalization reads terminal truth")
            .expect("job");

        assert_eq!(observed, failed);
        let stored_record = storage
            .get_steam_match(record.id)
            .await
            .expect("Steam match lookup")
            .expect("Steam match");
        assert_eq!(
            stored_record.demo_status,
            vibe_cs_domain::MatchDemoStatus::Failed
        );
        assert_eq!(stored_record.last_error.as_deref(), Some("network failed"));
    }

    #[tokio::test]
    async fn completed_download_cas_binds_latest_trusted_date_to_the_verified_demo() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let trusted = now - chrono::Duration::hours(3);
        let record = SteamMatchRecord {
            id: "76561198000000000:85".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "85".to_owned(),
            outcome_id: "850".to_owned(),
            token: 85,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let claim = storage
            .claim_match_download(record.id.clone(), None, Uuid::new_v4())
            .await
            .expect("claim")
            .expect("match exists");
        let MatchDownloadClaim::Claimed { mut job, .. } = claim else {
            panic!("first owner must claim");
        };
        let imported = demo("C:/matches/latest-trusted-date.dem");
        storage
            .put_demo(imported.clone())
            .await
            .expect("imported Demo");
        let mut sync = record;
        sync.played_at = Some(trusted);
        sync.synced_at = Utc::now();
        sync.updated_at = sync.synced_at;
        storage
            .merge_synced_steam_matches(vec![sync])
            .await
            .expect("trusted date sync");
        job.status = MatchDownloadStatus::Completed;
        job.demo_id = Some(imported.id);
        job.progress = 1.0;
        job.updated_at = Utc::now();

        let completed = storage
            .finalize_match_download(
                job,
                Some(DemoContentIdentity {
                    id: imported.id,
                    path: imported.path.clone(),
                    status: imported.status,
                    content_sha256: imported.content_sha256.clone().expect("hash"),
                    file_size: imported.file_size,
                }),
            )
            .await
            .expect("completion")
            .expect("job");

        assert_eq!(completed.status, MatchDownloadStatus::Completed);
        assert_eq!(
            storage
                .get_demo(imported.id)
                .await
                .expect("Demo lookup")
                .expect("Demo")
                .match_date,
            Some(trusted)
        );
    }

    #[tokio::test]
    async fn completed_download_rejects_a_demo_replaced_after_import_validation() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:86".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "86".to_owned(),
            outcome_id: "860".to_owned(),
            token: 86,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let claim = storage
            .claim_match_download(record.id.clone(), None, Uuid::new_v4())
            .await
            .expect("claim")
            .expect("match exists");
        let MatchDownloadClaim::Claimed { mut job, .. } = claim else {
            panic!("first owner must claim");
        };
        let imported = demo("C:/matches/replaced-before-finalize.dem");
        storage
            .put_demo(imported.clone())
            .await
            .expect("imported Demo");
        let expected = DemoContentIdentity {
            id: imported.id,
            path: imported.path.clone(),
            status: imported.status,
            content_sha256: imported.content_sha256.clone().expect("hash"),
            file_size: imported.file_size,
        };
        let mut replacement = imported.clone();
        replacement.content_sha256 = Some("f".repeat(64));
        replacement.file_size = replacement.file_size.saturating_add(1);
        replacement.updated_at = Utc::now();
        storage
            .replace_demo_content(replacement)
            .await
            .expect("concurrent Demo replacement");
        job.status = MatchDownloadStatus::Completed;
        job.demo_id = Some(imported.id);
        job.progress = 1.0;
        job.updated_at = Utc::now();

        let result = storage
            .finalize_match_download(job.clone(), Some(expected))
            .await;

        assert!(matches!(
            result,
            Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                _
            )))
        ));
        assert_eq!(
            storage
                .get_match_download_job(job.id)
                .await
                .expect("job")
                .expect("job")
                .status,
            MatchDownloadStatus::Queued
        );
        assert_eq!(
            storage
                .get_steam_match(record.id)
                .await
                .expect("Steam match")
                .expect("Steam match")
                .demo_status,
            vibe_cs_domain::MatchDemoStatus::Downloading
        );
    }

    #[tokio::test]
    async fn cancellation_before_the_first_stage_cannot_resurrect_a_download() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:81".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "81".to_owned(),
            outcome_id: "810".to_owned(),
            token: 81,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let claim = storage
            .claim_match_download(record.id.clone(), None, Uuid::new_v4())
            .await
            .expect("claim")
            .expect("match exists");
        let MatchDownloadClaim::Claimed { mut job, .. } = claim else {
            panic!("first owner must claim");
        };
        storage
            .request_match_download_cancel(job.id)
            .await
            .expect("cancel request")
            .expect("job");

        job.status = MatchDownloadStatus::Downloading;
        job.progress = 0.1;
        job.updated_at = Utc::now();
        let observed = storage
            .advance_match_download(job.clone())
            .await
            .expect("stale first stage")
            .expect("job");

        assert_eq!(observed.status, MatchDownloadStatus::Cancelling);
        job.status = MatchDownloadStatus::Decompressing;
        let observed = storage
            .put_match_download_job(job)
            .await
            .expect("generic stale write reads current truth");
        assert_eq!(observed.status, MatchDownloadStatus::Cancelling);
    }

    #[tokio::test]
    async fn cancellation_between_download_and_decompression_is_monotonic() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:82".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "82".to_owned(),
            outcome_id: "820".to_owned(),
            token: 82,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let claim = storage
            .claim_match_download(record.id, None, Uuid::new_v4())
            .await
            .expect("claim")
            .expect("match exists");
        let MatchDownloadClaim::Claimed { mut job, .. } = claim else {
            panic!("first owner must claim");
        };
        job.status = MatchDownloadStatus::Downloading;
        job.updated_at = Utc::now();
        job = storage
            .advance_match_download(job)
            .await
            .expect("download stage")
            .expect("job");
        assert_eq!(job.status, MatchDownloadStatus::Downloading);
        storage
            .request_match_download_cancel(job.id)
            .await
            .expect("cancel request")
            .expect("job");

        job.status = MatchDownloadStatus::Decompressing;
        job.progress = 0.9;
        job.updated_at = Utc::now();
        let observed = storage
            .advance_match_download(job)
            .await
            .expect("stale decompression stage")
            .expect("job");

        assert_eq!(observed.status, MatchDownloadStatus::Cancelling);
        assert!(observed.progress.abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn cancellation_during_import_wins_over_a_stale_completed_finalize() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:87".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "87".to_owned(),
            outcome_id: "870".to_owned(),
            token: 87,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let claim = storage
            .claim_match_download(record.id.clone(), None, Uuid::new_v4())
            .await
            .expect("claim")
            .expect("match exists");
        let MatchDownloadClaim::Claimed { mut job, .. } = claim else {
            panic!("first owner must claim");
        };
        job.status = MatchDownloadStatus::Importing;
        job.progress = 0.97;
        job.updated_at = Utc::now();
        job = storage
            .advance_match_download(job)
            .await
            .expect("import stage")
            .expect("job");
        let imported = demo("C:/matches/cancelled-during-import.dem");
        storage
            .put_demo(imported.clone())
            .await
            .expect("imported Demo");
        storage
            .request_match_download_cancel(job.id)
            .await
            .expect("cancel request")
            .expect("job");
        job.status = MatchDownloadStatus::Completed;
        job.progress = 1.0;
        job.demo_id = Some(imported.id);
        job.updated_at = Utc::now();

        let result = storage
            .finalize_match_download(
                job.clone(),
                Some(DemoContentIdentity {
                    id: imported.id,
                    path: imported.path.clone(),
                    status: imported.status,
                    content_sha256: imported.content_sha256.clone().expect("hash"),
                    file_size: imported.file_size,
                }),
            )
            .await;

        assert!(matches!(
            result,
            Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(message)))
                if message == "download cancelled"
        ));
        assert_eq!(
            storage
                .get_match_download_job(job.id)
                .await
                .expect("job")
                .expect("job")
                .status,
            MatchDownloadStatus::Cancelling
        );
        assert_eq!(
            storage
                .get_steam_match(record.id)
                .await
                .expect("Steam match")
                .expect("Steam match")
                .demo_status,
            vibe_cs_domain::MatchDemoStatus::Downloading
        );
    }

    #[tokio::test]
    async fn orphaned_download_recovery_atomically_fails_job_and_match() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:80".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "80".to_owned(),
            outcome_id: "800".to_owned(),
            token: 80,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let claim = storage
            .claim_match_download(record.id.clone(), None, Uuid::new_v4())
            .await
            .expect("claim")
            .expect("match exists");
        let MatchDownloadClaim::Claimed { job, .. } = claim else {
            panic!("first owner must claim");
        };

        assert_eq!(
            storage
                .recover_orphaned_match_downloads("owner stopped".to_owned())
                .await
                .expect("recovery"),
            1
        );

        assert_eq!(
            storage
                .get_match_download_job(job.id)
                .await
                .expect("job lookup")
                .expect("job")
                .status,
            MatchDownloadStatus::Failed
        );
        let stored_record = storage
            .get_steam_match(record.id)
            .await
            .expect("Steam match lookup")
            .expect("Steam match");
        assert_eq!(
            stored_record.demo_status,
            vibe_cs_domain::MatchDemoStatus::Failed
        );
        assert_eq!(stored_record.last_error.as_deref(), Some("owner stopped"));
    }

    #[tokio::test]
    async fn orphaned_cancellation_recovers_as_cancelled_instead_of_failed() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:84".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "84".to_owned(),
            outcome_id: "840".to_owned(),
            token: 84,
            map_name: None,
            played_at: None,
            score: None,
            result: vibe_cs_domain::MatchHistoryResult::Unknown,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let claim = storage
            .claim_match_download(record.id.clone(), None, Uuid::new_v4())
            .await
            .expect("claim")
            .expect("match exists");
        let MatchDownloadClaim::Claimed { job, .. } = claim else {
            panic!("first owner must claim");
        };
        storage
            .request_match_download_cancel(job.id)
            .await
            .expect("cancel request")
            .expect("job");

        assert_eq!(
            storage
                .recover_orphaned_match_downloads("owner stopped".to_owned())
                .await
                .expect("recovery"),
            1
        );

        let recovered = storage
            .get_match_download_job(job.id)
            .await
            .expect("job lookup")
            .expect("job");
        assert_eq!(recovered.status, MatchDownloadStatus::Cancelled);
        assert_eq!(recovered.error, None);
        let stored_record = storage
            .get_steam_match(record.id)
            .await
            .expect("Steam match lookup")
            .expect("Steam match");
        assert_eq!(
            stored_record.demo_status,
            vibe_cs_domain::MatchDemoStatus::Available
        );
        assert_eq!(stored_record.last_error, None);
    }

    #[tokio::test]
    async fn steam_matches_and_download_jobs_are_paged_and_persisted() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let records = (1_u16..=3)
            .map(|token| SteamMatchRecord {
                id: format!("76561198000000000:{token}"),
                steam_id: "76561198000000000".to_owned(),
                match_id: token.to_string(),
                outcome_id: (u32::from(token) * 10).to_string(),
                token,
                map_name: None,
                played_at: None,
                score: None,
                result: vibe_cs_domain::MatchHistoryResult::Unknown,
                demo_status: vibe_cs_domain::MatchDemoStatus::Available,
                demo_id: None,
                last_error: None,
                synced_at: now,
                updated_at: now,
            })
            .collect::<Vec<_>>();
        storage
            .put_steam_matches(records.clone())
            .await
            .expect("put matches");

        let page = storage
            .list_steam_matches(MatchHistoryQuery {
                steam_id: Some("76561198000000000".to_owned()),
                search: None,
                page: Some(2),
                page_size: Some(2),
            })
            .await
            .expect("list matches");
        assert_eq!(page.total, 3);
        assert_eq!(page.items.len(), 1);

        let job = MatchDownloadJob {
            id: Uuid::new_v4(),
            match_record_id: records[0].id.clone(),
            status: MatchDownloadStatus::Downloading,
            downloaded_bytes: 1024,
            total_bytes: Some(4096),
            progress: 0.25,
            demo_id: None,
            error: None,
            error_code: None,
            created_at: now,
            updated_at: now,
        };
        storage
            .put_match_download_job(job.clone())
            .await
            .expect("put job");
        assert_eq!(
            storage
                .get_active_match_download_job(records[0].id.clone())
                .await
                .expect("active job"),
            Some(job.clone())
        );
        let downloaded = demo("C:/matches/persisted-download.dem");
        storage
            .put_demo(downloaded.clone())
            .await
            .expect("downloaded Demo");
        let mut completed = job;
        completed.status = MatchDownloadStatus::Completed;
        completed.demo_id = Some(downloaded.id);
        let completed = storage
            .finalize_match_download(
                completed,
                Some(DemoContentIdentity {
                    id: downloaded.id,
                    path: downloaded.path.clone(),
                    status: downloaded.status,
                    content_sha256: downloaded.content_sha256.clone().expect("hash"),
                    file_size: downloaded.file_size,
                }),
            )
            .await
            .expect("complete job")
            .expect("job");
        assert!(
            storage
                .get_active_match_download_job(records[0].id.clone())
                .await
                .expect("no active job")
                .is_none()
        );
        assert_eq!(
            storage
                .get_match_download_job(completed.id)
                .await
                .expect("job by id"),
            Some(completed.clone())
        );
        assert_eq!(
            storage
                .list_match_download_jobs()
                .await
                .expect("all persisted download jobs"),
            vec![completed]
        );
    }

    #[tokio::test]
    async fn steam_match_search_filters_the_complete_history_before_paging() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let record = |token: u16, map_name: &str, score: &str, result| SteamMatchRecord {
            id: format!("76561198000000000:{token}"),
            steam_id: "76561198000000000".to_owned(),
            match_id: format!("match-{token}"),
            outcome_id: token.to_string(),
            token,
            map_name: Some(map_name.to_owned()),
            played_at: None,
            score: Some(score.to_owned()),
            result,
            demo_status: vibe_cs_domain::MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_matches(vec![
                record(
                    1,
                    "de_mirage",
                    "13:7",
                    vibe_cs_domain::MatchHistoryResult::Win,
                ),
                record(
                    2,
                    "de_nuke",
                    "7:13",
                    vibe_cs_domain::MatchHistoryResult::Loss,
                ),
                record(
                    3,
                    "de_nuke",
                    "13:11",
                    vibe_cs_domain::MatchHistoryResult::Win,
                ),
            ])
            .await
            .expect("put matches");

        let page = storage
            .list_steam_matches(MatchHistoryQuery {
                steam_id: Some("76561198000000000".to_owned()),
                search: Some("NUKE".to_owned()),
                page: Some(2),
                page_size: Some(1),
            })
            .await
            .expect("search history");

        assert_eq!(page.total, 2);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.page, 2);
        assert_eq!(page.items[0].map_name.as_deref(), Some("de_nuke"));

        let literal_wildcard = storage
            .list_steam_matches(MatchHistoryQuery {
                steam_id: Some("76561198000000000".to_owned()),
                search: Some("%".to_owned()),
                page: Some(1),
                page_size: Some(20),
            })
            .await
            .expect("search literal wildcard");
        assert_eq!(literal_wildcard.total, 0);
    }

    #[tokio::test]
    async fn activity_query_sorts_and_pages_the_complete_cross_type_projection() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let recording_id =
            Uuid::parse_str("00000000-0000-0000-0000-000000000002").expect("recording id");
        let completed_export_id =
            Uuid::parse_str("00000000-0000-0000-0000-000000000001").expect("export id");
        let failed_export_id =
            Uuid::parse_str("00000000-0000-0000-0000-000000000003").expect("export id");
        storage
            .put_recording_job(RecordingJob {
                id: recording_id,
                retry_of: None,
                status: vibe_cs_domain::JobStatus::Running,
                items: vec![],
                current_index: 0,
                progress: 0.0,
                message: "recording.stage.launching".to_owned(),
                outputs: vec![],
                error_code: None,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("put recording");
        for (id, status, updated_at) in [
            (
                completed_export_id,
                vibe_cs_domain::JobStatus::Completed,
                now,
            ),
            (
                failed_export_id,
                vibe_cs_domain::JobStatus::Failed,
                now - chrono::Duration::seconds(1),
            ),
        ] {
            storage
                .put_export_job(ExportJobRecord {
                    kind: "editor".to_owned(),
                    job: ExportJob {
                        id,
                        project_id: Uuid::new_v4(),
                        status,
                        progress: 0.0,
                        output_path: format!("C:/exports/{id}.mp4"),
                        error: None,
                        error_code: None,
                        created_at: updated_at,
                        updated_at,
                    },
                })
                .await
                .expect("put export");
        }

        let first = storage
            .query_activities(ActivityQuery {
                search: None,
                kind: None,
                state: None,
                page: 1,
                page_size: 1,
            })
            .await
            .expect("first activity page");
        assert_eq!(first.total, 3);
        assert_eq!(first.summary.total, 3);
        assert_eq!(first.summary.active, 1);
        assert_eq!(first.summary.failed, 1);
        assert_eq!(first.summary.completed, 1);
        assert!(matches!(
            first.items.as_slice(),
            [ActivitySource::Export(record)] if record.job.id == completed_export_id
        ));

        let second = storage
            .query_activities(ActivityQuery {
                page: 2,
                ..ActivityQuery {
                    search: None,
                    kind: None,
                    state: None,
                    page: 1,
                    page_size: 1,
                }
            })
            .await
            .expect("second activity page");
        assert!(matches!(
            second.items.as_slice(),
            [ActivitySource::Recording { job, .. }] if job.id == recording_id
        ));

        let failed = storage
            .query_activities(ActivityQuery {
                search: None,
                kind: Some(ActivityKind::Export),
                state: Some(ActivityState::Failed),
                page: 1,
                page_size: 1,
            })
            .await
            .expect("failed export page");
        assert_eq!(failed.total, 1);
        assert_eq!(failed.summary, first.summary);
        assert!(matches!(
            failed.items.as_slice(),
            [ActivitySource::Export(record)] if record.job.id == failed_export_id
        ));
    }

    #[tokio::test]
    async fn recording_retry_lineage_atomically_allows_only_one_child() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let parent_id = Uuid::new_v4();
        let request = vibe_cs_domain::RecordingRequest {
            id: Some(Uuid::new_v4()),
            demo_id: Uuid::new_v4(),
            highlight_id: None,
            player_id: "76561198000000000".to_owned(),
            title: "Retryable capture".to_owned(),
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
            camera_style: vibe_cs_domain::HlaeCameraStyle::default(),
            presentation: None,
        };
        let parent = RecordingJob {
            id: parent_id,
            retry_of: None,
            status: vibe_cs_domain::JobStatus::Failed,
            items: vec![request.clone()],
            current_index: 0,
            progress: 0.0,
            error_code: None,
            message: "capture interrupted".to_owned(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        storage
            .put_recording_job(parent.clone())
            .await
            .expect("parent job");
        let child = |id| RecordingJob {
            id,
            retry_of: Some(parent_id),
            status: vibe_cs_domain::JobStatus::Queued,
            items: vec![request.clone()],
            current_index: 0,
            progress: 0.0,
            message: "Queued retry".to_owned(),
            outputs: Vec::new(),
            error_code: None,
            created_at: now,
            updated_at: now,
        };
        let first_id = Uuid::new_v4();
        storage
            .put_recording_job(child(first_id))
            .await
            .expect("first retry child");
        let second_id = Uuid::new_v4();

        let second = storage.put_recording_job(child(second_id)).await;

        assert!(matches!(
            second,
            Err(StorageError::RecordingRetryAlreadyClaimed(id)) if id == parent_id
        ));
        assert!(
            storage
                .get_recording_job(first_id)
                .await
                .expect("first child")
                .is_some()
        );
        assert!(
            storage
                .get_recording_job(second_id)
                .await
                .expect("second child")
                .is_none()
        );
        assert_eq!(
            storage.get_recording_job(parent_id).await.expect("parent"),
            Some(parent),
            "claiming retry lineage must not mutate the parent fact",
        );
    }

    #[tokio::test]
    async fn recording_retry_lineage_is_immutable_after_insert() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let parent_id = Uuid::new_v4();
        let request = vibe_cs_domain::RecordingRequest {
            id: Some(Uuid::new_v4()),
            demo_id: Uuid::new_v4(),
            highlight_id: None,
            player_id: "76561198000000000".to_owned(),
            title: "Retryable capture".to_owned(),
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
            camera_style: vibe_cs_domain::HlaeCameraStyle::default(),
            presentation: None,
        };
        let parent = RecordingJob {
            id: parent_id,
            retry_of: None,
            status: vibe_cs_domain::JobStatus::Failed,
            items: vec![request.clone()],
            current_index: 0,
            progress: 0.0,
            error_code: None,
            message: "capture interrupted".to_owned(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        storage.put_recording_job(parent).await.expect("parent job");
        let child_id = Uuid::new_v4();
        let child = RecordingJob {
            id: child_id,
            retry_of: Some(parent_id),
            status: vibe_cs_domain::JobStatus::Queued,
            items: vec![request],
            current_index: 0,
            progress: 0.0,
            message: "Queued retry".to_owned(),
            outputs: Vec::new(),
            error_code: None,
            created_at: now,
            updated_at: now,
        };
        storage
            .put_recording_job(child.clone())
            .await
            .expect("child job");
        let mut rewritten = child.clone();
        rewritten.retry_of = None;
        rewritten.message = "rewritten lineage".to_owned();

        let error = storage
            .put_recording_job(rewritten)
            .await
            .expect_err("retry lineage cannot be rewritten");

        assert!(matches!(
            error,
            StorageError::RecordingRetryLineageImmutable(id) if id == child_id
        ));
        assert_eq!(
            storage
                .get_recording_job(child_id)
                .await
                .expect("child lookup"),
            Some(child)
        );
    }

    #[tokio::test]
    async fn recording_retry_child_requires_an_existing_parent() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let child_id = Uuid::new_v4();
        let missing_parent_id = Uuid::new_v4();
        let child = RecordingJob {
            id: child_id,
            retry_of: Some(missing_parent_id),
            status: vibe_cs_domain::JobStatus::Queued,
            items: vec![vibe_cs_domain::RecordingRequest {
                id: Some(Uuid::new_v4()),
                demo_id: Uuid::new_v4(),
                highlight_id: None,
                player_id: "76561198000000000".to_owned(),
                title: "Retry child".to_owned(),
                start_tick: 100,
                end_tick: 200,
                pre_roll_seconds: 0.0,
                post_roll_seconds: 0.0,
                victim_pov: false,
                camera_style: vibe_cs_domain::HlaeCameraStyle::default(),
                presentation: None,
            }],
            current_index: 0,
            progress: 0.0,
            message: "Queued retry".to_owned(),
            outputs: Vec::new(),
            error_code: None,
            created_at: now,
            updated_at: now,
        };

        let error = storage
            .put_recording_job(child)
            .await
            .expect_err("retry child cannot reference a missing parent");

        assert!(matches!(error, StorageError::Database(_)));
        assert!(
            storage
                .get_recording_job(child_id)
                .await
                .expect("child lookup")
                .is_none()
        );
    }

    #[tokio::test]
    async fn retryable_recording_lookup_follows_the_latest_terminal_attempt() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let demo_id = Uuid::new_v4();
        let request = vibe_cs_domain::RecordingRequest {
            id: Some(Uuid::new_v4()),
            demo_id,
            highlight_id: None,
            player_id: "76561198000000000".to_owned(),
            title: "Retryable capture".to_owned(),
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
            camera_style: vibe_cs_domain::HlaeCameraStyle::default(),
            presentation: None,
        };
        let parent_id = Uuid::new_v4();
        let attempt = |id, retry_of| RecordingJob {
            id,
            retry_of,
            status: vibe_cs_domain::JobStatus::Failed,
            items: vec![request.clone()],
            current_index: 0,
            progress: 0.0,
            error_code: None,
            message: "capture interrupted".to_owned(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        storage
            .put_recording_job(attempt(parent_id, None))
            .await
            .expect("parent job");

        assert_eq!(
            storage
                .get_retryable_recording_job(parent_id)
                .await
                .expect("parent eligibility")
                .expect("parent retryable")
                .id,
            parent_id,
        );

        let child_id = Uuid::new_v4();
        storage
            .put_recording_job(attempt(child_id, Some(parent_id)))
            .await
            .expect("child job");

        assert!(
            storage
                .get_retryable_recording_job(parent_id)
                .await
                .expect("superseded parent eligibility")
                .is_none(),
        );
        assert_eq!(
            storage
                .get_retryable_recording_job(child_id)
                .await
                .expect("child eligibility")
                .expect("latest child retryable")
                .id,
            child_id,
        );
    }

    #[tokio::test]
    async fn recording_retry_lineage_and_eligibility_survive_reopen() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("recording-retry.sqlite3");
        let now = Utc::now();
        let request = vibe_cs_domain::RecordingRequest {
            id: Some(Uuid::new_v4()),
            demo_id: Uuid::new_v4(),
            highlight_id: None,
            player_id: "76561198000000000".to_owned(),
            title: "Retryable capture".to_owned(),
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
            camera_style: vibe_cs_domain::HlaeCameraStyle::default(),
            presentation: None,
        };
        let parent_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let attempt = |id, retry_of| RecordingJob {
            id,
            retry_of,
            status: vibe_cs_domain::JobStatus::Failed,
            items: vec![request.clone()],
            current_index: 0,
            progress: 0.0,
            error_code: None,
            message: "capture interrupted".to_owned(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        {
            let storage = Storage::open(&database_path).await.expect("open storage");
            storage
                .put_recording_job(attempt(parent_id, None))
                .await
                .expect("parent job");
            storage
                .put_recording_job(attempt(child_id, Some(parent_id)))
                .await
                .expect("child job");
        }

        let reopened = Storage::open(&database_path).await.expect("reopen storage");

        assert!(
            reopened
                .get_retryable_recording_job(parent_id)
                .await
                .expect("parent eligibility")
                .is_none()
        );
        let child = reopened
            .get_retryable_recording_job(child_id)
            .await
            .expect("child eligibility")
            .expect("latest child retryable");
        assert_eq!(child.retry_of, Some(parent_id));
        let duplicate = reopened
            .put_recording_job(attempt(Uuid::new_v4(), Some(parent_id)))
            .await;
        assert!(matches!(
            duplicate,
            Err(StorageError::RecordingRetryAlreadyClaimed(id)) if id == parent_id
        ));
    }

    #[tokio::test]
    async fn retryable_recording_lookup_rejects_unproven_published_prefix() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let demo_id = Uuid::new_v4();
        let request_id = Uuid::new_v4();
        let job = RecordingJob {
            id: Uuid::new_v4(),
            retry_of: None,
            status: vibe_cs_domain::JobStatus::Failed,
            items: vec![
                vibe_cs_domain::RecordingRequest {
                    id: Some(request_id),
                    demo_id,
                    highlight_id: None,
                    player_id: "76561198000000000".to_owned(),
                    title: "Published capture".to_owned(),
                    start_tick: 100,
                    end_tick: 200,
                    pre_roll_seconds: 0.0,
                    post_roll_seconds: 0.0,
                    victim_pov: false,
                    camera_style: vibe_cs_domain::HlaeCameraStyle::default(),
                    presentation: None,
                },
                vibe_cs_domain::RecordingRequest {
                    id: Some(Uuid::new_v4()),
                    demo_id,
                    highlight_id: None,
                    player_id: "76561198000000000".to_owned(),
                    title: "Unpublished capture".to_owned(),
                    start_tick: 300,
                    end_tick: 400,
                    pre_roll_seconds: 0.0,
                    post_roll_seconds: 0.0,
                    victim_pov: false,
                    camera_style: vibe_cs_domain::HlaeCameraStyle::default(),
                    presentation: None,
                },
            ],
            current_index: 1,
            progress: 0.5,
            error_code: None,
            message: "capture interrupted".to_owned(),
            outputs: vec![vibe_cs_domain::RecordedClip {
                id: Uuid::new_v4(),
                path: "C:/recordings/first.mp4".to_owned(),
                title: "Published capture".to_owned(),
                duration_seconds: 2.0,
                demo_id: Some(demo_id),
                player_name: Some("Player".to_owned()),
                category: "highlight".to_owned(),
                tags: Vec::new(),
                metadata: serde_json::json!({ "request_id": Uuid::new_v4() }),
                created_at: now,
            }],
            created_at: now,
            updated_at: now,
        };
        storage
            .put_recording_job(job.clone())
            .await
            .expect("failed recording job");

        assert!(
            storage
                .get_retryable_recording_job(job.id)
                .await
                .expect("retry eligibility")
                .is_none()
        );
    }

    #[tokio::test]
    async fn active_recording_blocks_retry_until_it_is_terminal() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let request = vibe_cs_domain::RecordingRequest {
            id: Some(Uuid::new_v4()),
            demo_id: Uuid::new_v4(),
            highlight_id: None,
            player_id: "76561198000000000".to_owned(),
            title: "Retryable capture".to_owned(),
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
            camera_style: vibe_cs_domain::HlaeCameraStyle::default(),
            presentation: None,
        };
        let parent_id = Uuid::new_v4();
        let attempt = |id, status| RecordingJob {
            id,
            retry_of: None,
            status,
            items: vec![request.clone()],
            current_index: 0,
            progress: 0.0,
            message: "recording state".to_owned(),
            outputs: Vec::new(),
            error_code: None,
            created_at: now,
            updated_at: now,
        };
        storage
            .put_recording_job(attempt(parent_id, vibe_cs_domain::JobStatus::Failed))
            .await
            .expect("failed parent");
        let active_id = Uuid::new_v4();
        let mut active = attempt(active_id, vibe_cs_domain::JobStatus::Queued);
        storage
            .put_recording_job(active.clone())
            .await
            .expect("active recording");

        assert!(
            storage
                .get_retryable_recording_job(parent_id)
                .await
                .expect("blocked eligibility")
                .is_none()
        );

        active.status = vibe_cs_domain::JobStatus::Failed;
        active.updated_at += chrono::Duration::seconds(1);
        storage
            .put_recording_job(active)
            .await
            .expect("terminal recording");
        assert_eq!(
            storage
                .get_retryable_recording_job(parent_id)
                .await
                .expect("restored eligibility")
                .expect("parent retryable")
                .id,
            parent_id
        );
    }

    #[tokio::test]
    async fn activity_query_batches_download_owner_and_retry_readiness_on_the_final_page() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let match_record_id = "76561198000000000:retry";
        storage
            .put_steam_matches(vec![SteamMatchRecord {
                id: match_record_id.to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "retry".to_owned(),
                outcome_id: "retry-outcome".to_owned(),
                token: 7,
                map_name: Some("de_mirage".to_owned()),
                played_at: Some(now),
                score: Some("11:13".to_owned()),
                result: vibe_cs_domain::MatchHistoryResult::Loss,
                demo_status: vibe_cs_domain::MatchDemoStatus::Failed,
                demo_id: None,
                last_error: Some("download failed".to_owned()),
                synced_at: now,
                updated_at: now,
            }])
            .await
            .expect("put match record");
        let job_id = Uuid::new_v4();
        storage
            .put_match_download_job(MatchDownloadJob {
                id: job_id,
                match_record_id: match_record_id.to_owned(),
                status: vibe_cs_domain::MatchDownloadStatus::Failed,
                downloaded_bytes: 0,
                total_bytes: None,
                progress: 0.0,
                demo_id: None,
                error: Some("network".to_owned()),
                error_code: None,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("put download job");

        let page = storage
            .query_activities(ActivityQuery {
                search: None,
                kind: Some(ActivityKind::Download),
                state: None,
                page: 1,
                page_size: 1,
            })
            .await
            .expect("download activity page");

        assert!(matches!(
            page.items.as_slice(),
            [ActivitySource::Download {
                job,
                retryable: true,
                owner_steam_id: Some(owner),
            }] if job.id == job_id && owner == "76561198000000000"
        ));
    }

    #[tokio::test]
    async fn activity_query_tracks_authoritative_updates_and_deletes_without_rebuilding() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = Utc::now();
        let export_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let export = |status, updated_at| ExportJobRecord {
            kind: "editor".to_owned(),
            job: ExportJob {
                id: export_id,
                project_id,
                status,
                progress: 0.0,
                output_path: "C:/exports/live.mp4".to_owned(),
                error: None,
                error_code: None,
                created_at: now,
                updated_at,
            },
        };
        storage
            .put_export_job(export(vibe_cs_domain::JobStatus::Running, now))
            .await
            .expect("put running export");
        let query = || ActivityQuery {
            search: Some("LIVE.MP4".to_owned()),
            kind: Some(ActivityKind::Export),
            state: None,
            page: 1,
            page_size: 10,
        };

        let running = storage
            .query_activities(query())
            .await
            .expect("running projection");
        assert_eq!(running.total, 1);
        assert_eq!(running.summary.active, 1);
        assert!(matches!(
            running.items.as_slice(),
            [ActivitySource::Export(record)]
                if record.job.status == vibe_cs_domain::JobStatus::Running
        ));

        storage
            .put_export_job(export(
                vibe_cs_domain::JobStatus::Completed,
                now + chrono::Duration::seconds(1),
            ))
            .await
            .expect("complete export");
        let completed = storage
            .query_activities(query())
            .await
            .expect("completed projection");
        assert_eq!(completed.summary.active, 0);
        assert_eq!(completed.summary.completed, 1);
        assert!(matches!(
            completed.items.as_slice(),
            [ActivitySource::Export(record)]
                if record.job.status == vibe_cs_domain::JobStatus::Completed
        ));

        assert!(
            storage
                .delete_export_job(export_id)
                .await
                .expect("delete export")
        );
        let deleted = storage
            .query_activities(query())
            .await
            .expect("projection after delete");
        assert_eq!(deleted.total, 0);
        assert_eq!(deleted.summary, ActivitySummary::default());
        assert!(deleted.items.is_empty());
    }

    #[tokio::test]
    async fn activity_projection_is_available_after_reopening_without_a_rebuild_step() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("activity.sqlite3");
        let now = Utc::now();
        let recording_id = Uuid::new_v4();
        {
            let storage = Storage::open(&database_path).await.expect("open storage");
            storage
                .put_recording_job(RecordingJob {
                    id: recording_id,
                    retry_of: None,
                    status: vibe_cs_domain::JobStatus::Running,
                    items: vec![],
                    current_index: 0,
                    progress: 0.0,
                    message: "recording.stage.capturing".to_owned(),
                    outputs: vec![],
                    error_code: None,
                    created_at: now,
                    updated_at: now,
                })
                .await
                .expect("put recording");
        }

        let reopened = Storage::open(&database_path).await.expect("reopen storage");
        let page = reopened
            .query_activities(ActivityQuery {
                search: Some("capturing".to_owned()),
                kind: Some(ActivityKind::Recording),
                state: Some(ActivityState::Active),
                page: 1,
                page_size: 10,
            })
            .await
            .expect("query reopened projection");
        assert_eq!(page.total, 1);
        assert_eq!(page.summary.total, 1);
        assert!(matches!(
            page.items.as_slice(),
            [ActivitySource::Recording { job, .. }] if job.id == recording_id
        ));
    }

    #[test]
    fn persisted_wrapper_documents_reject_unknown_fields() {
        let now = Utc::now();
        let export = ExportJobRecord {
            kind: "editor".to_owned(),
            job: ExportJob {
                id: Uuid::new_v4(),
                project_id: Uuid::new_v4(),
                status: vibe_cs_domain::JobStatus::Queued,
                progress: 0.0,
                output_path: "output.mp4".to_owned(),
                error: None,
                error_code: None,
                created_at: now,
                updated_at: now,
            },
        };
        let mut export_json = serde_json::to_value(export).expect("serialize export wrapper");
        export_json
            .as_object_mut()
            .expect("export wrapper object")
            .insert("unexpected".to_owned(), serde_json::Value::Bool(true));
        assert!(serde_json::from_value::<ExportJobRecord>(export_json).is_err());

        let preset = PresetRecord {
            id: Uuid::new_v4(),
            name: "Current preset".to_owned(),
            revision: 1,
            document: preset_document(0.5),
            created_at: now,
            updated_at: now,
        };
        let mut preset_json = serde_json::to_value(preset).expect("serialize preset wrapper");
        preset_json
            .as_object_mut()
            .expect("preset wrapper object")
            .insert("unexpected".to_owned(), serde_json::Value::Bool(true));
        assert!(serde_json::from_value::<PresetRecord>(preset_json).is_err());
    }

    #[test]
    fn editor_project_documents_require_the_complete_current_shape() {
        let project = editor_project("Current cut", 1);
        let document = EditorProjectDocument {
            project,
            snapshots: Vec::new(),
        };
        let mut json = serde_json::to_value(document).expect("serialize current document");
        json.as_object_mut()
            .expect("editor project document object")
            .remove("snapshots");

        assert!(decode_editor_project_document(&json.to_string()).is_err());
    }

    #[tokio::test]
    async fn editor_project_snapshot_restore_is_monotonic_and_preserves_current() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let original = editor_project("First cut", 1);
        storage
            .put_editor_project(original.clone())
            .await
            .expect("put original project");

        let mut edited = original.clone();
        edited.name = "Second cut".to_owned();
        edited.width = 2560;
        edited.revision = 2;
        edited.updated_at = Utc::now();
        storage
            .put_editor_project(edited.clone())
            .await
            .expect("put edited project");

        let snapshots = storage
            .list_editor_project_snapshots(original.id)
            .await
            .expect("list snapshots");
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].revision, 1);
        assert_eq!(snapshots[0].name, "First cut");

        let restored = storage
            .restore_editor_project_snapshot(original.id, snapshots[0].id)
            .await
            .expect("restore snapshot")
            .expect("snapshot exists");
        assert_eq!(restored.name, "First cut");
        assert_eq!(restored.width, 1920);
        assert_eq!(restored.revision, 3);
        assert_eq!(restored.created_at, original.created_at);
        assert!(restored.updated_at >= edited.updated_at);
        assert_eq!(
            storage
                .get_editor_project(original.id)
                .await
                .expect("get restored project"),
            Some(restored)
        );

        let snapshots = storage
            .list_editor_project_snapshots(original.id)
            .await
            .expect("list snapshots after restore");
        assert_eq!(
            snapshots
                .iter()
                .map(|snapshot| snapshot.revision)
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert_eq!(snapshots[0].name, "Second cut");
    }

    #[tokio::test]
    async fn editor_project_snapshots_are_bounded() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let project = editor_project("Current cut", 1);
        storage
            .put_editor_project(project.clone())
            .await
            .expect("insert current project document");

        for revision in 2..=u64::try_from(EDITOR_PROJECT_SNAPSHOT_LIMIT).unwrap() + 5 {
            let mut updated = project.clone();
            updated.name = format!("Cut {revision}");
            updated.revision = revision;
            updated.updated_at = Utc::now();
            storage
                .put_editor_project(updated)
                .await
                .expect("put project revision");
        }

        let snapshots = storage
            .list_editor_project_snapshots(project.id)
            .await
            .expect("list bounded snapshots");
        assert_eq!(snapshots.len(), EDITOR_PROJECT_SNAPSHOT_LIMIT);
        assert_eq!(
            snapshots.first().expect("newest snapshot").revision,
            u64::try_from(EDITOR_PROJECT_SNAPSHOT_LIMIT).unwrap() + 4
        );
        assert_eq!(snapshots.last().expect("oldest snapshot").revision, 5);
    }

    #[tokio::test]
    async fn editor_project_revision_check_and_write_are_atomic() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let original = editor_project("Base", 1);
        storage
            .put_editor_project(original.clone())
            .await
            .expect("put original");

        let mut first = original.clone();
        first.name = "First writer".to_owned();
        let mut second = original.clone();
        second.name = "Second writer".to_owned();
        let (first_result, second_result) = tokio::join!(
            storage.update_editor_project(first, 1),
            storage.update_editor_project(second, 1),
        );
        let outcomes = [
            first_result.expect("first update"),
            second_result.expect("second update"),
        ];
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, EditorProjectUpdate::Updated(_)))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, EditorProjectUpdate::Conflict { .. }))
                .count(),
            1
        );
        assert_eq!(
            storage
                .get_editor_project(original.id)
                .await
                .expect("get winner")
                .expect("project")
                .revision,
            2
        );
        assert_eq!(
            storage
                .list_editor_project_snapshots(original.id)
                .await
                .expect("snapshots")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn beat_alignment_is_one_revision_transaction_with_one_snapshot() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let original = editor_project_with_asset("Beat edit", 1, Uuid::new_v4());
        let clip_id = original.tracks[0].clips[0].id;
        let audio_asset_id = Uuid::new_v4();
        let mut audio_asset = media_asset(audio_asset_id, original.id, "C:/music/bgm.wav");
        audio_asset.name = "BGM".to_owned();
        audio_asset.kind = "audio/wav".to_owned();
        let mut asset_hash = Sha256::new();
        asset_hash.update(b"vibe-cs-media-asset\0");
        asset_hash.update(serde_json::to_vec(&audio_asset).expect("asset json"));
        let audio = BeatAlignmentAudioBinding {
            asset_id: audio_asset.id,
            name: audio_asset.name.clone(),
            kind: audio_asset.kind.clone(),
            file_size: audio_asset.file_size,
            duration_seconds: audio_asset.duration_seconds.expect("duration"),
            asset_fingerprint: hex::encode(asset_hash.finalize()),
            content_sha256: "11".repeat(32),
            analysis_sha256: "22".repeat(32),
        };
        let placement = BeatAlignmentAudioPlacement {
            track_id: Uuid::new_v4(),
            clip_id: Uuid::new_v4(),
            timeline_start_seconds: 0.0,
            timeline_end_seconds: 4.0,
            source_in_seconds: 0.0,
            source_out_seconds: 4.0,
            volume: 1.0,
            insert_audio_track: true,
            insert_audio_clip: true,
        };
        storage
            .put_editor_project(original.clone())
            .await
            .expect("put project");
        storage.put_asset(audio_asset).await.expect("put BGM asset");
        let draft = BeatAlignmentDraft {
            advisory_only: true,
            clips: vec![vibe_cs_domain::BeatAlignedClip {
                clip_id: clip_id.to_string(),
                timeline_start_seconds: 0.5,
                timeline_end_seconds: 3.5,
                planned_duration_seconds: 3.0,
                source_duration_seconds: 4.0,
                duration_change_ratio: -0.25,
                start_beat_index: 0,
                end_beat_index: 4,
                rationale: Vec::new(),
            }],
            unplaced_clip_ids: Vec::new(),
            constraints: Vec::new(),
        };
        let (first, second) = tokio::join!(
            storage.apply_beat_alignment(
                original.id,
                1,
                draft.clone(),
                audio.clone(),
                placement.clone(),
            ),
            storage.apply_beat_alignment(original.id, 1, draft, audio, placement),
        );
        let outcomes = [first.expect("first"), second.expect("second")];
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, BeatAlignmentUpdate::Applied { .. }))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, BeatAlignmentUpdate::Conflict { .. }))
                .count(),
            1
        );
        let current = storage
            .get_editor_project(original.id)
            .await
            .expect("get project")
            .expect("project");
        assert_eq!(current.revision, 2);
        assert!((current.tracks[0].clips[0].start - 0.5).abs() < 0.000_001);
        assert!(current.tracks.iter().any(|track| {
            track.kind == vibe_cs_domain::TrackKind::Audio
                && track
                    .clips
                    .iter()
                    .any(|clip| clip.asset_id == Some(audio_asset_id))
        }));
        assert_eq!(
            storage
                .list_editor_project_snapshots(original.id)
                .await
                .expect("snapshots")
                .len(),
            1
        );
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "test plan fixture keeps every signed field explicit"
    )]
    fn highlight_edit_plan(
        demo_id: Uuid,
        project_id: Uuid,
        create_project: bool,
        expected_revision: u64,
        target_track_id: Uuid,
        create_track: bool,
        recorded_clip_id: Uuid,
        editor_clip_id: Uuid,
        start: f64,
    ) -> HighlightEditPlan {
        HighlightEditPlan {
            demo_id,
            intent: vibe_cs_domain::HighlightEditProposalIntent {
                pacing: vibe_cs_domain::HighlightEditPacing::Measured,
                include_context_seconds: 0.0,
                transition: vibe_cs_domain::HighlightEditTransition::Cut,
            },
            project_id,
            project_name: "AI highlights".to_owned(),
            create_project,
            expected_revision,
            target_track_id,
            create_track,
            mappings: vec![vibe_cs_domain::HighlightAssetMapping {
                highlight_id: "h-1".to_owned(),
                recorded_clip_id,
                path: "C:/managed/recording.mp4".to_owned(),
                duration_seconds: 2.0,
                file_size: 5,
                content_sha256: "00".repeat(32),
                capture_start_tick: 0,
                capture_end_tick: 128,
                tick_rate: 64.0,
                capture_playback_speed: 1.0,
            }],
            insertions: vec![vibe_cs_domain::HighlightEditClipInsert {
                highlight_id: "h-1".to_owned(),
                recorded_clip_id,
                editor_clip_id,
                timeline_start_seconds: start,
                timeline_end_seconds: start + 2.0,
                source_start_tick: 0,
                source_end_tick: 128,
                source_in_seconds: 0.0,
                source_out_seconds: 2.0,
                playback_speed: 1.0,
                transition_in: None,
                transition_duration_seconds: None,
            }],
        }
    }

    async fn put_highlight_recording(storage: &Storage, demo_id: Uuid, clip_id: Uuid) {
        storage
            .put_recorded_clip(RecordedClip {
                id: clip_id,
                path: "C:/managed/recording.mp4".to_owned(),
                title: "Highlight".to_owned(),
                duration_seconds: 2.0,
                demo_id: Some(demo_id),
                player_name: None,
                category: "highlight".to_owned(),
                tags: Vec::new(),
                metadata: serde_json::json!({
                    "highlight_id":"h-1",
                    "effective_start_tick": 0,
                    "effective_end_tick": 128
                }),
                created_at: Utc::now(),
            })
            .await
            .expect("recording");
    }

    #[tokio::test]
    async fn highlight_edit_create_update_snapshot_and_retry_are_atomic() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_record = demo("C:/matches/highlight.dem");
        let demo_id = demo_record.id;
        storage.put_demo(demo_record).await.expect("demo");
        let recorded_clip_id = Uuid::new_v4();
        put_highlight_recording(&storage, demo_id, recorded_clip_id).await;

        let existing = editor_project_with_asset("Existing", 1, Uuid::new_v4());
        storage
            .put_editor_project(existing.clone())
            .await
            .expect("existing project");
        let existing_plan = highlight_edit_plan(
            demo_id,
            existing.id,
            false,
            1,
            existing.tracks[0].id,
            false,
            recorded_clip_id,
            Uuid::new_v4(),
            existing.duration_seconds,
        );
        let applied = storage
            .apply_highlight_edit(existing_plan.clone(), "proposal-existing".to_owned())
            .await
            .expect("apply existing");
        assert!(matches!(
            applied,
            HighlightEditUpdate::Applied {
                project_created: false,
                ..
            }
        ));
        let retry = storage
            .apply_highlight_edit(existing_plan.clone(), "proposal-existing".to_owned())
            .await
            .expect("retry existing");
        assert!(matches!(retry, HighlightEditUpdate::AlreadyApplied { .. }));
        let stale = storage
            .apply_highlight_edit(existing_plan, "different-proposal".to_owned())
            .await
            .expect("stale existing");
        assert!(matches!(
            stale,
            HighlightEditUpdate::Conflict {
                current_revision: 2
            }
        ));
        assert_eq!(
            storage
                .list_editor_project_snapshots(existing.id)
                .await
                .expect("snapshots")
                .len(),
            1
        );

        let new_project_id = Uuid::new_v4();
        let new_plan = highlight_edit_plan(
            demo_id,
            new_project_id,
            true,
            0,
            Uuid::new_v4(),
            true,
            recorded_clip_id,
            Uuid::new_v4(),
            0.0,
        );
        let created = storage
            .apply_highlight_edit(new_plan.clone(), "proposal-new".to_owned())
            .await
            .expect("create project");
        assert!(matches!(
            created,
            HighlightEditUpdate::Applied {
                project_created: true,
                ..
            }
        ));
        let created_retry = storage
            .apply_highlight_edit(new_plan, "proposal-new".to_owned())
            .await
            .expect("retry create");
        assert!(matches!(
            created_retry,
            HighlightEditUpdate::AlreadyApplied {
                project_created: true,
                ..
            }
        ));
        assert!(
            storage
                .list_editor_project_snapshots(new_project_id)
                .await
                .expect("new snapshots")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn separated_audio_asset_and_timeline_edit_share_one_revision_transaction() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let source_asset_id = Uuid::new_v4();
        let original = editor_project_with_asset("Separation", 1, source_asset_id);
        let source_clip_id = original.tracks[0].clips[0].id;
        storage
            .put_editor_project(original.clone())
            .await
            .expect("put project");
        storage
            .put_asset(media_asset(
                source_asset_id,
                original.id,
                "C:/media/source.mp4",
            ))
            .await
            .expect("put source asset");

        let build = |suffix: &str| {
            let audio_asset_id = Uuid::new_v4();
            let mut asset = media_asset(
                audio_asset_id,
                original.id,
                &format!("C:/media/{suffix}.m4a"),
            );
            asset.kind = "audio/mp4".to_owned();
            asset.width = None;
            asset.height = None;
            asset.has_audio = true;
            (
                EditorAudioSeparation {
                    source_clip_id,
                    source_asset_id,
                    audio_asset_id,
                    audio_clip_id: Uuid::new_v4(),
                    audio_track_id: Uuid::new_v4(),
                    link_group_id: Uuid::new_v4(),
                    audio_name: format!("{suffix} audio"),
                    mute_source: true,
                },
                asset,
            )
        };
        let (first_separation, first_asset) = build("first");
        let first_asset_id = first_asset.id;
        let (second_separation, second_asset) = build("second");
        let second_asset_id = second_asset.id;
        let (first, second) = tokio::join!(
            storage.separate_editor_audio(original.id, 1, first_separation, first_asset,),
            storage.separate_editor_audio(original.id, 1, second_separation, second_asset,),
        );
        let outcomes = [first.expect("first writer"), second.expect("second writer")];
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, EditorAudioSeparationUpdate::Applied(_)))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(
                    outcome,
                    EditorAudioSeparationUpdate::AlreadySeparated { .. }
                ))
                .count(),
            1
        );

        let project = storage
            .get_editor_project(original.id)
            .await
            .expect("load project")
            .expect("stored project");
        assert_eq!(project.revision, 2);
        assert!(project.tracks[0].clips[0].volume.abs() < f64::EPSILON);
        assert_eq!(
            project
                .tracks
                .iter()
                .filter(|track| track.kind == vibe_cs_domain::TrackKind::Audio)
                .flat_map(|track| &track.clips)
                .count(),
            1
        );
        let stored_asset_ids = storage
            .list_assets(Some(original.id))
            .await
            .expect("list assets")
            .into_iter()
            .map(|asset| asset.id)
            .collect::<std::collections::HashSet<_>>();
        assert!(stored_asset_ids.contains(&source_asset_id));
        assert_eq!(
            usize::from(stored_asset_ids.contains(&first_asset_id))
                + usize::from(stored_asset_ids.contains(&second_asset_id)),
            1
        );
        assert_eq!(
            storage
                .list_editor_project_snapshots(original.id)
                .await
                .expect("snapshots")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn preset_updates_and_application_are_revision_safe_and_preserve_other_fields() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let asset_id = Uuid::new_v4();
        let project = editor_project_with_asset("Preset target", 1, asset_id);
        let clip_id = project.tracks[0].clips[0].id;
        storage
            .put_editor_project(project.clone())
            .await
            .expect("put project");
        let now = Utc::now();
        let created = storage
            .create_preset(PresetRecord {
                id: Uuid::new_v4(),
                name: "Look".to_owned(),
                revision: 99,
                document: preset_document(0.5),
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("create preset");
        assert_eq!(created.revision, 1);

        let mut first = created.clone();
        first.name = "First writer".to_owned();
        let mut second = created.clone();
        second.name = "Second writer".to_owned();
        let (first, second) = tokio::join!(
            storage.update_preset(first, 1),
            storage.update_preset(second, 1),
        );
        let outcomes = [first.expect("first update"), second.expect("second update")];
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, PresetUpdate::Updated(_)))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(
                    outcome,
                    PresetUpdate::Conflict {
                        current_revision: 2
                    }
                ))
                .count(),
            1
        );
        let winner = storage
            .get_preset(created.id)
            .await
            .expect("get preset")
            .expect("preset exists");

        let applied = storage
            .apply_editor_preset(project.id, clip_id, winner.id, 1, winner.revision)
            .await
            .expect("apply preset");
        let PresetApply::Applied(applied) = applied else {
            panic!("preset should apply");
        };
        assert_eq!(applied.revision, 2);
        let clip = &applied.tracks[0].clips[0];
        assert!((clip.transform.x - 42.0).abs() < f64::EPSILON);
        assert!((clip.volume - 0.5).abs() < f64::EPSILON);
        assert_eq!(clip.keyframes, project.tracks[0].clips[0].keyframes);
        assert!(
            clip.effects
                .iter()
                .any(|effect| effect.kind == "future_effect")
        );
        assert!(
            clip.effects
                .iter()
                .any(|effect| effect.kind == "color_adjust")
        );
        assert!(matches!(
            storage
                .apply_editor_preset(project.id, clip_id, winner.id, 1, winner.revision)
                .await
                .expect("stale apply"),
            PresetApply::ProjectConflict {
                current_revision: 2
            }
        ));
        assert!(matches!(
            storage
                .delete_preset(winner.id, 1)
                .await
                .expect("stale delete"),
            PresetDelete::Conflict {
                current_revision: 2
            }
        ));
        assert!(matches!(
            storage
                .delete_preset(winner.id, winner.revision)
                .await
                .expect("delete current preset"),
            PresetDelete::Deleted(_)
        ));
    }

    #[tokio::test]
    async fn preset_application_rejects_rotation_for_a_text_target_before_mutation() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let asset_id = Uuid::new_v4();
        let mut project = editor_project_with_asset("Text preset target", 1, asset_id);
        project.tracks[0].kind = vibe_cs_domain::TrackKind::Text;
        project.tracks[0].clips[0].asset_id = None;
        project.tracks[0].clips[0].text = Some(vibe_cs_domain::TextStyle {
            content: "Title".to_owned(),
            font_family: "Arial".to_owned(),
            font_asset_id: None,
            font_size: 48.0,
            color: "#ffffff".to_owned(),
            background: None,
            align: "center".to_owned(),
        });
        let clip_id = project.tracks[0].clips[0].id;
        storage
            .put_editor_project(project.clone())
            .await
            .expect("put project");
        let mut document = preset_document(1.0);
        document.transform = vibe_cs_domain::Transform {
            rotation: 15.0,
            ..vibe_cs_domain::Transform::default()
        };
        document.color_adjust = None;
        document.grayscale = false;
        document.blur_radius = None;
        document.transition_in = None;
        let now = Utc::now();
        let preset = storage
            .create_preset(PresetRecord {
                id: Uuid::new_v4(),
                name: "Unsupported text rotation".to_owned(),
                revision: 1,
                document,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("create preset");

        let error = storage
            .apply_editor_preset(project.id, clip_id, preset.id, 1, 1)
            .await
            .expect_err("text rotation must be rejected");

        assert!(error.to_string().contains("text clips support only"));
        assert_eq!(
            storage
                .get_editor_project(project.id)
                .await
                .expect("project")
                .expect("project exists"),
            project
        );
    }

    #[tokio::test]
    async fn project_batch_delete_is_atomic_and_preserves_shared_assets() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let shared_id = Uuid::new_v4();
        let owned_id = Uuid::new_v4();
        let owner = editor_project_with_asset("Owner", 3, shared_id);
        let survivor = editor_project_with_asset("Survivor", 1, shared_id);
        storage
            .put_editor_project(owner.clone())
            .await
            .expect("put owner");
        storage
            .put_editor_project(survivor.clone())
            .await
            .expect("put survivor");
        storage
            .put_asset(media_asset(shared_id, owner.id, "C:/managed/shared.mp4"))
            .await
            .expect("put shared asset");
        let mut exclusive_asset = media_asset(owned_id, owner.id, "C:/managed/owned.mp4");
        exclusive_asset.proxy_status = MediaProxyStatus::Generating {
            started_at: Utc::now(),
            lease_id: Uuid::new_v4(),
            expires_at: Utc::now() + chrono::Duration::hours(1),
        };
        storage
            .put_asset(exclusive_asset.clone())
            .await
            .expect("put owned asset");

        assert!(matches!(
            storage
                .delete_editor_projects(vec![EditorProjectRevision {
                    id: owner.id,
                    expected_revision: 2,
                }])
                .await
                .expect("revision conflict"),
            EditorProjectDeletion::Conflict { id, current_revision: 3 } if id == owner.id
        ));
        assert!(
            storage
                .get_editor_project(owner.id)
                .await
                .expect("owner")
                .is_some()
        );
        assert!(matches!(
            storage
                .delete_editor_projects(vec![EditorProjectRevision {
                    id: owner.id,
                    expected_revision: 3,
                }])
                .await
                .expect("busy asset"),
            EditorProjectDeletion::BusyAsset { project_id, asset_id }
                if project_id == owner.id && asset_id == owned_id
        ));

        exclusive_asset.proxy_status = MediaProxyStatus::NotRequested;
        storage
            .put_asset(exclusive_asset)
            .await
            .expect("finish proxy state");
        let deleted = storage
            .delete_editor_projects(vec![EditorProjectRevision {
                id: owner.id,
                expected_revision: 3,
            }])
            .await
            .expect("delete owner");
        let EditorProjectDeletion::Deleted(deleted) = deleted else {
            panic!("owner should be deleted");
        };
        assert_eq!(deleted.project_ids, vec![owner.id]);
        assert_eq!(deleted.preserved_shared_asset_ids, vec![shared_id]);
        assert_eq!(deleted.deleted_assets.len(), 1);
        assert_eq!(deleted.deleted_assets[0].id, owned_id);
        assert!(
            deleted
                .protected_paths
                .iter()
                .any(|path| path.ends_with("shared.mp4"))
        );
        assert!(
            storage
                .get_editor_project(owner.id)
                .await
                .expect("owner")
                .is_none()
        );
        assert!(
            storage
                .get_editor_project(survivor.id)
                .await
                .expect("survivor")
                .is_some()
        );
        assert!(
            storage
                .get_asset(owned_id)
                .await
                .expect("owned asset")
                .is_none()
        );
        assert_eq!(
            storage
                .get_asset(shared_id)
                .await
                .expect("shared asset")
                .expect("shared asset exists")
                .project_id,
            None
        );
    }

    #[tokio::test]
    async fn staged_project_delete_restores_files_and_rows_after_injected_database_failure() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let root = tempfile::tempdir().expect("temporary directory");
        let managed_root = root.path().join("uploads").join("assets");
        std::fs::create_dir_all(&managed_root).expect("managed root");
        let source = managed_root.join("owned.mp4");
        std::fs::write(&source, b"owned-by-project").expect("source file");
        let asset_id = Uuid::new_v4();
        let project = editor_project_with_asset("Delete rollback", 1, asset_id);
        storage
            .put_editor_project(project.clone())
            .await
            .expect("put project");
        storage
            .put_asset(media_asset(asset_id, project.id, &source.to_string_lossy()))
            .await
            .expect("put asset");

        let error = storage
            .delete_editor_projects_inner(
                vec![EditorProjectRevision {
                    id: project.id,
                    expected_revision: 1,
                }],
                Some(ManagedFileStaging {
                    managed_roots: vec![managed_root],
                    cleanup_root: root.path().join("cleanup"),
                    quarantine_root: root.path().join("cleanup").join("editor-projects"),
                }),
                || {
                    Err(StorageError::ManagedFile(
                        "injected commit failure".to_owned(),
                    ))
                },
            )
            .await
            .expect_err("injected failure");
        assert!(error.to_string().contains("injected commit failure"));
        assert_eq!(
            std::fs::read(&source).expect("restored source"),
            b"owned-by-project"
        );
        assert!(
            storage
                .get_editor_project(project.id)
                .await
                .expect("project")
                .is_some()
        );
        assert!(storage.get_asset(asset_id).await.expect("asset").is_some());
        assert_eq!(
            std::fs::read_dir(root.path().join("cleanup").join("editor-projects"))
                .expect("cleanup root")
                .count(),
            0
        );
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn staged_project_rollback_uses_open_capabilities_during_an_ancestor_swap() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let root = tempfile::tempdir().expect("temporary directory");
        let managed_root = root.path().join("uploads").join("assets");
        let cleanup_root = root.path().join("cleanup");
        let quarantine_root = cleanup_root.join("editor-projects");
        let renamed_root = cleanup_root.join("editor-projects-renamed");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&managed_root).expect("managed root");
        std::fs::create_dir(&outside).expect("outside root");
        let source = managed_root.join("owned.mp4");
        std::fs::write(&source, b"owned-by-project").expect("source file");
        let asset_id = Uuid::new_v4();
        let project = editor_project_with_asset("Capability rollback", 1, asset_id);
        storage
            .put_editor_project(project.clone())
            .await
            .expect("put project");
        storage
            .put_asset(media_asset(asset_id, project.id, &source.to_string_lossy()))
            .await
            .expect("put asset");
        let staging = ManagedFileStaging {
            managed_roots: vec![managed_root],
            cleanup_root,
            quarantine_root: quarantine_root.clone(),
        };
        let hook_quarantine_root = quarantine_root.clone();
        let hook_renamed_root = renamed_root.clone();
        let hook_outside = outside.clone();

        let error = storage
            .delete_editor_projects_inner(
                vec![EditorProjectRevision {
                    id: project.id,
                    expected_revision: 1,
                }],
                Some(staging),
                move || {
                    if std::fs::rename(&hook_quarantine_root, &hook_renamed_root).is_ok() {
                        create_directory_symlink(&hook_outside, &hook_quarantine_root).map_err(
                            |error| StorageError::ManagedFile(format!("swap quarantine: {error}")),
                        )?;
                    }
                    Err(StorageError::ManagedFile(
                        "injected commit failure".to_owned(),
                    ))
                },
            )
            .await
            .expect_err("injected failure");

        assert!(error.to_string().contains("injected commit failure"));
        assert_eq!(
            std::fs::read(&source).expect("source restored through handles"),
            b"owned-by-project"
        );
        assert_eq!(
            std::fs::read_dir(&outside).expect("outside root").count(),
            0
        );
        let active_root = if renamed_root.is_dir() {
            &renamed_root
        } else {
            &quarantine_root
        };
        assert_eq!(
            std::fs::read_dir(active_root)
                .expect("capability quarantine root")
                .count(),
            0
        );
        assert!(
            storage
                .get_editor_project(project.id)
                .await
                .expect("project")
                .is_some()
        );
        assert!(storage.get_asset(asset_id).await.expect("asset").is_some());
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn staged_project_delete_rejects_a_linked_quarantine_root() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let root = tempfile::tempdir().expect("temporary directory");
        let managed_root = root.path().join("uploads").join("assets");
        let cleanup_root = root.path().join("cleanup");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&managed_root).expect("managed root");
        std::fs::create_dir(&cleanup_root).expect("cleanup root");
        std::fs::create_dir(&outside).expect("outside root");
        let quarantine_root = cleanup_root.join("editor-projects");
        if let Err(error) = create_directory_symlink(&outside, &quarantine_root) {
            if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied {
                return;
            }
            panic!("create quarantine link: {error}");
        }

        let source = managed_root.join("owned.mp4");
        std::fs::write(&source, b"owned-by-project").expect("source file");
        let asset_id = Uuid::new_v4();
        let project = editor_project_with_asset("Unsafe quarantine", 1, asset_id);
        storage
            .put_editor_project(project.clone())
            .await
            .expect("put project");
        storage
            .put_asset(media_asset(asset_id, project.id, &source.to_string_lossy()))
            .await
            .expect("put asset");

        let error = storage
            .delete_editor_projects_staged(
                vec![EditorProjectRevision {
                    id: project.id,
                    expected_revision: 1,
                }],
                ManagedFileStaging {
                    managed_roots: vec![managed_root],
                    cleanup_root,
                    quarantine_root,
                },
            )
            .await
            .expect_err("linked quarantine root must be rejected");
        assert!(error.to_string().contains("not a plain directory"));
        assert_eq!(
            std::fs::read(&source).expect("source remains"),
            b"owned-by-project"
        );
        assert!(
            storage
                .get_editor_project(project.id)
                .await
                .expect("project")
                .is_some()
        );
        assert!(storage.get_asset(asset_id).await.expect("asset").is_some());
        assert_eq!(
            std::fs::read_dir(&outside).expect("outside root").count(),
            0
        );
    }

    #[tokio::test]
    async fn quarantine_restore_never_overwrites_a_recreated_destination() {
        let root = tempfile::tempdir().expect("temporary directory");
        let (_storage, staging, source, quarantine) = committed_file_quarantine(root.path()).await;
        std::fs::write(&source, b"new-owner").expect("recreated destination");

        let error = restore_managed_file_quarantine(&staging, &quarantine)
            .expect_err("restore must not overwrite a recreated destination");

        assert!(error.to_string().contains("refusing to overwrite"));
        assert_eq!(
            std::fs::read(&source).expect("new destination"),
            b"new-owner"
        );
        assert!(quarantine.entries[0].staged_path.is_file());
        assert!(quarantine.journal_path.is_file());
    }

    #[tokio::test]
    async fn quarantine_restore_retries_after_a_hard_link_was_published_before_unlink() {
        let root = tempfile::tempdir().expect("temporary directory");
        let (_storage, staging, source, quarantine) = committed_file_quarantine(root.path()).await;
        let opened = open_existing_quarantine(&staging, &quarantine).expect("open quarantine");
        let entry = &quarantine.entries[0];
        let staged_name = entry.staged_path.file_name().expect("staged name");
        let (source_dir, source_name) =
            open_managed_destination(&opened.managed_roots, &entry.original_path)
                .expect("source destination");
        opened
            .directory
            .hard_link(staged_name, &source_dir, &source_name)
            .expect("simulate published hard link");
        drop(opened);

        restore_managed_file_quarantine(&staging, &quarantine)
            .expect("same-file retry removes staged link");

        assert_eq!(
            std::fs::read(&source).expect("restored source"),
            b"owned-by-project"
        );
        assert!(!quarantine.entries[0].staged_path.exists());
        assert!(!quarantine.journal_path.exists());
        assert!(!quarantine.directory.exists());
    }

    #[tokio::test]
    async fn proxy_generation_leases_expire_and_reject_stale_publishers() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let asset = media_asset(id, project_id, "C:/managed/source.mp4");
        storage.put_asset(asset).await.expect("put asset");
        let now = Utc::now();
        let first_lease = Uuid::new_v4();
        let generating = storage
            .begin_media_proxy_generation(id, first_lease, now, now + chrono::Duration::minutes(5))
            .await
            .expect("begin lease");
        assert!(matches!(generating, MediaAssetUpdate::Updated(_)));
        assert!(matches!(
            storage
                .begin_media_proxy_generation(
                    id,
                    Uuid::new_v4(),
                    now,
                    now + chrono::Duration::minutes(5),
                )
                .await
                .expect("overlapping lease"),
            MediaAssetUpdate::Busy
        ));
        assert!(
            storage
                .recover_expired_media_proxy_generations(now + chrono::Duration::minutes(1))
                .await
                .expect("not expired")
                .is_empty()
        );
        assert_eq!(
            storage
                .recover_expired_media_proxy_generations(now + chrono::Duration::minutes(6))
                .await
                .expect("recover expired")
                .len(),
            1
        );
        let second_lease = Uuid::new_v4();
        let second = storage
            .begin_media_proxy_generation(
                id,
                second_lease,
                now + chrono::Duration::minutes(6),
                now + chrono::Duration::minutes(11),
            )
            .await
            .expect("retry lease");
        let MediaAssetUpdate::Updated(second) = second else {
            panic!("retry should acquire a lease");
        };
        let mut stale = (*second).clone();
        stale.proxy_status = MediaProxyStatus::Ready {
            generated_at: Utc::now(),
        };
        assert!(matches!(
            storage
                .finish_media_proxy_generation(stale.clone(), first_lease)
                .await
                .expect("stale publisher"),
            MediaAssetUpdate::Conflict
        ));
        assert!(matches!(
            storage
                .finish_media_proxy_generation(stale, second_lease)
                .await
                .expect("current publisher"),
            MediaAssetUpdate::Updated(_)
        ));
    }
}
