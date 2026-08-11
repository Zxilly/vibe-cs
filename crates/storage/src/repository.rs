#![allow(
    clippy::missing_errors_doc,
    reason = "all repository methods consistently return the documented StorageError"
)]

use std::{
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
use uuid::Uuid;
use vibe_cs_domain::{
    AppConfig, BeatAlignmentAudioBinding, BeatAlignmentAudioPlacement, BeatAlignmentDraft,
    CosmeticPlan, DemoPatch, DemoQuery, DemoRecord, DemoStatus, EditorAudioSeparation,
    EditorPresetDocument, EditorProject, EditorProjectSnapshot, ExportJob, HighlightEditPlan,
    MatchAnalysis, MatchDownloadJob, MatchDownloadStatus, MatchHistoryQuery, MediaAsset,
    MediaProxyStatus, MontageProject, Page, RecordedClip, RecordingJob, SteamMatchRecord,
};

use crate::{Result, StorageError, migrations};

/// Maximum number of editor project versions retained for restoration.
pub const EDITOR_PROJECT_SNAPSHOT_LIMIT: usize = 20;

#[cfg(windows)]
const LLM_API_KEY_ENVELOPE_PREFIX: &str = "dpapi:v1:";
#[cfg(windows)]
const LLM_API_KEY_DPAPI_PURPOSE: &[u8] = b"Vibe CS app_config.llm.api_key dpapi:v1 scope:v1";
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
fn has_legacy_plaintext_llm_api_key(config: &AppConfig) -> bool {
    !config.llm.api_key.is_empty() && !config.llm.api_key.starts_with(LLM_API_KEY_ENVELOPE_PREFIX)
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
        // The repository read path immediately rewrites this legacy plaintext
        // under the same serialized connection lock before returning it.
        return Ok(config);
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
pub struct ManagedFileQuarantine {
    pub schema_version: u32,
    pub id: Uuid,
    pub project_ids: Vec<Uuid>,
    pub directory: PathBuf,
    pub journal_path: PathBuf,
    pub entries: Vec<ManagedFileQuarantineEntry>,
    #[serde(default)]
    pub preserved_external_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExportJobRecord {
    pub kind: String,
    pub job: ExportJob,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PresetRecord {
    pub id: Uuid,
    pub name: String,
    pub revision: u64,
    pub document: EditorPresetDocument,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EditorProjectDocument {
    project: EditorProject,
    #[serde(default)]
    snapshots: Vec<StoredEditorProjectSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEditorProjectSnapshot {
    summary: EditorProjectSnapshot,
    project: EditorProject,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CompatibleEditorProjectDocument {
    Versioned(EditorProjectDocument),
    Legacy(EditorProject),
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
            migrations::configure(&connection)?;
            migrations::run(&mut connection)?;
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
            #[cfg(windows)]
            let migrate_legacy_secret = has_legacy_plaintext_llm_api_key(&stored);
            let config = config_from_persistence(stored)?;
            #[cfg(windows)]
            if migrate_legacy_secret {
                let protected = config_for_persistence(&config)?;
                connection.execute(
                    "UPDATE app_config SET document_json = ?1, updated_at = ?2 WHERE key = 'app'",
                    params![encode(&protected)?, Utc::now().to_rfc3339()],
                )?;
            }
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
            let page = query.page.unwrap_or(1).max(1);
            let page_size = query.page_size.unwrap_or(50).clamp(1, 200);
            let search = query.search.filter(|value| !value.trim().is_empty());
            let source = query.source.filter(|value| !value.trim().is_empty());
            let map_name = query.map_name.filter(|value| !value.trim().is_empty());
            let status = query.status.map(status_text);
            let values: [&dyn rusqlite::ToSql; 4] = [&search, &source, &map_name, &status];
            let where_sql = " WHERE (?1 IS NULL OR display_name LIKE '%' || ?1 || '%' OR file_name LIKE '%' || ?1 || '%') \
                             AND (?2 IS NULL OR source = ?2) \
                             AND (?3 IS NULL OR map_name = ?3) \
                             AND (?4 IS NULL OR status = ?4)";
            let total = connection.query_row(
                &format!("SELECT COUNT(*) FROM demos{where_sql}"),
                values,
                |row| row_u64(row, 0),
            )?;

            let mut statement = connection.prepare(&format!(
                "SELECT document_json FROM demos{where_sql} \
                 ORDER BY updated_at DESC LIMIT ?5 OFFSET ?6"
            ))?;
            let mut rows = statement.query(params![
                search,
                source,
                map_name,
                status,
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

    pub async fn put_analysis(&self, analysis: MatchAnalysis) -> Result<MatchAnalysis> {
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO analyses(demo_id, document_json, updated_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(demo_id) DO UPDATE SET document_json = excluded.document_json, \
                 updated_at = excluded.updated_at",
                params![
                    analysis.demo_id.to_string(),
                    encode(&analysis)?,
                    Utc::now().to_rfc3339()
                ],
            )?;
            Ok(analysis)
        })
        .await
    }

    pub async fn list_steam_matches(
        &self,
        query: MatchHistoryQuery,
    ) -> Result<Page<SteamMatchRecord>> {
        self.run(move |connection| {
            let page = query.page.unwrap_or(1).max(1);
            let page_size = query.page_size.unwrap_or(50).clamp(1, 200);
            let steam_id = query.steam_id.filter(|value| !value.trim().is_empty());
            let total = connection.query_row(
                "SELECT COUNT(*) FROM steam_matches WHERE (?1 IS NULL OR steam_id = ?1)",
                [&steam_id],
                |row| row_u64(row, 0),
            )?;
            let mut statement = connection.prepare(
                "SELECT document_json FROM steam_matches \
                 WHERE (?1 IS NULL OR steam_id = ?1) \
                 ORDER BY length(match_id) DESC, match_id DESC LIMIT ?2 OFFSET ?3",
            )?;
            let mut rows = statement.query(params![
                steam_id,
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
                transaction.execute(
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
            }
            transaction.commit()?;
            Ok(records)
        })
        .await
    }

    pub async fn get_match_download_job(&self, id: Uuid) -> Result<Option<MatchDownloadJob>> {
        self.run(move |connection| get_document(connection, "match_download_jobs", id))
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

    pub async fn put_match_download_job(&self, job: MatchDownloadJob) -> Result<MatchDownloadJob> {
        self.run(move |connection| {
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
                    encode(&job)?
                ],
            )?;
            Ok(job)
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
            asset_hash.update(b"vibe-cs-media-asset-v1\0");
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

    /// Restores a retained version while keeping revisions monotonically increasing.
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

    /// Converts expired or legacy proxy leases into retryable failures.
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

    pub async fn list_recording_jobs(&self) -> Result<Vec<RecordingJob>> {
        self.list_documents("recording_jobs", "updated_at DESC")
            .await
    }

    pub async fn put_recording_job(&self, job: RecordingJob) -> Result<RecordingJob> {
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO recording_jobs(id, status, updated_at, document_json) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, \
                 document_json = excluded.document_json",
                params![
                    job.id.to_string(),
                    job_status_text(job.status),
                    job.updated_at.to_rfc3339(),
                    encode(&job)?
                ],
            )?;
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
        schema_version: 1,
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
    if quarantine.schema_version != 1
        || Uuid::parse_str(directory_name_text).ok() != Some(quarantine.id)
    {
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
        "INSERT INTO demos(id, path, file_name, display_name, source, status, map_name, match_date, updated_at, content_sha256, document_json) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, file_name = excluded.file_name, \
         display_name = excluded.display_name, source = excluded.source, status = excluded.status, \
         map_name = excluded.map_name, match_date = excluded.match_date, updated_at = excluded.updated_at, \
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
            demo.updated_at.to_rfc3339(),
            demo.content_sha256,
            encode(demo)?
        ],
    )?;
    Ok(())
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
    let compatible: CompatibleEditorProjectDocument = decode(value)?;
    Ok(match compatible {
        CompatibleEditorProjectDocument::Versioned(document) => document,
        CompatibleEditorProjectDocument::Legacy(project) => EditorProjectDocument {
            project,
            snapshots: Vec::new(),
        },
    })
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
            map_name: None,
            match_date: None,
            duration_seconds: None,
            total_rounds: None,
            team_a_name: None,
            team_b_name: None,
            team_a_score: None,
            team_b_score: None,
            remark: String::new(),
            content_sha256: None,
            file_size: 42,
            created_at: now,
            updated_at: now,
        }
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
            schema_version: vibe_cs_domain::EDITOR_PRESET_SCHEMA_VERSION,
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
    async fn legacy_plaintext_llm_key_migrates_on_first_read() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let mut legacy = AppConfig::default();
        legacy.llm.api_key = "legacy-plaintext-llm-secret".to_owned();
        let legacy_json = encode(&legacy).expect("encode legacy config");
        storage
            .run(move |connection| {
                connection.execute(
                    "INSERT INTO app_config(key, document_json, updated_at) VALUES ('app', ?1, ?2)",
                    params![legacy_json, Utc::now().to_rfc3339()],
                )?;
                Ok(())
            })
            .await
            .expect("insert legacy config");

        let recovered = storage
            .get_config()
            .await
            .expect("read legacy config")
            .expect("legacy config");
        assert_eq!(recovered.llm.api_key, "legacy-plaintext-llm-secret");
        let raw = raw_config_document(&storage).await;
        assert!(!raw.contains("legacy-plaintext-llm-secret"));
        assert!(raw.contains(LLM_API_KEY_ENVELOPE_PREFIX));
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
            teams: vec![],
            players: vec![],
            rounds: vec![],
            highlights: vec![],
        };
        storage.put_analysis(analysis).await.expect("put analysis");
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
        storage
            .put_analysis(MatchAnalysis {
                demo_id: record.id,
                map_name: "de_dust2".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 1.0,
                teams: vec![],
                players: vec![],
                rounds: vec![],
                highlights: vec![],
            })
            .await
            .expect("put analysis");

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
        let mut completed = job;
        completed.status = MatchDownloadStatus::Completed;
        storage
            .put_match_download_job(completed.clone())
            .await
            .expect("complete job");
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
            Some(completed)
        );
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
    async fn editor_project_snapshots_are_bounded_and_read_legacy_documents() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let project = editor_project("Legacy cut", 1);
        let stored_project = project.clone();
        storage
            .run(move |connection| {
                connection.execute(
                    "INSERT INTO editor_projects(id, name, revision, updated_at, document_json) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        stored_project.id.to_string(),
                        stored_project.name,
                        sql_u64(stored_project.revision)?,
                        stored_project.updated_at.to_rfc3339(),
                        encode(&stored_project)?
                    ],
                )?;
                Ok(())
            })
            .await
            .expect("insert legacy project document");
        assert_eq!(
            storage
                .get_editor_project(project.id)
                .await
                .expect("get legacy project"),
            Some(project.clone())
        );

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
        asset_hash.update(b"vibe-cs-media-asset-v1\0");
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
