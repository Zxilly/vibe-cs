use std::collections::HashMap;

use rusqlite::{named_params, params_from_iter};
use vibe_cs_domain::{DemoRecord, MatchDownloadJob, RecordingJob};

use super::{ExportJobRecord, Storage, decode, row_u64, sql_u64};
use crate::{Result, StorageError};

const MAXIMUM_ACTIVITY_PAGE: u32 = 10_000;
const MAXIMUM_ACTIVITY_PAGE_SIZE: u32 = 100;
const MAXIMUM_ACTIVITY_SEARCH_CHARS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityKind {
    Recording,
    Export,
    Download,
    Analysis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityState {
    Active,
    Failed,
    Completed,
}

impl ActivityState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Failed => "failed",
            Self::Completed => "completed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityQuery {
    pub search: Option<String>,
    pub kind: Option<ActivityKind>,
    pub state: Option<ActivityState>,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ActivitySource {
    Recording(RecordingJob),
    Export(ExportJobRecord),
    Download {
        job: MatchDownloadJob,
        retryable: bool,
        owner_steam_id: Option<String>,
    },
    Analysis(DemoRecord),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ActivitySummary {
    pub total: u64,
    pub active: u64,
    pub failed: u64,
    pub completed: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActivityPage {
    pub items: Vec<ActivitySource>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub summary: ActivitySummary,
}

#[derive(Debug)]
struct PersistedActivity {
    source_kind: String,
    source_id: String,
    document: String,
    retryable: bool,
    owner_steam_id: Option<String>,
}

const ACTIVITY_FILTER_SQL: &str = "
    WHERE (
        :state IS NULL
        OR (:state = 'active' AND status NOT IN ('completed', 'failed', 'cancelled'))
        OR (:state = 'failed' AND status = 'failed')
        OR (:state = 'completed' AND status = 'completed')
    )
      AND (:search IS NULL OR instr(lower(search_text), lower(:search)) > 0)";

const RECORDING_ACTIVITY_SQL: &str = "
    SELECT
        'recording:' || id AS activity_id,
        'recording' AS source_kind,
        id AS source_id,
        status,
        updated_at,
        document_json,
        'recording:' || id || ' recording ' || id || ' ' || status || ' ' ||
            COALESCE(json_extract(document_json, '$.items[0].demo_id'), '') || ' ' ||
            COALESCE(json_extract(document_json, '$.items[0].title'), '') || ' ' ||
            COALESCE(json_extract(document_json, '$.message'), '') AS search_text
    FROM recording_jobs";

const EXPORT_ACTIVITY_SQL: &str = "
    SELECT
        'export:' || id AS activity_id,
        'export' AS source_kind,
        id AS source_id,
        status,
        updated_at,
        document_json,
        'export:' || id || ' export ' || id || ' ' || status || ' ' || kind || ' ' || project_id || ' ' ||
            COALESCE(json_extract(document_json, '$.job.output_path'), '') || ' ' ||
            COALESCE(json_extract(document_json, '$.job.error'), '') AS search_text
    FROM export_jobs";

const DOWNLOAD_ACTIVITY_SQL: &str = "
    SELECT
        'download:' || job.id AS activity_id,
        'download' AS source_kind,
        job.id AS source_id,
        job.status,
        job.updated_at,
        job.document_json,
        'download:' || job.id || ' download ' || job.id || ' ' || job.status || ' ' || job.match_record_id || ' ' ||
            COALESCE(json_extract(job.document_json, '$.error'), '') AS search_text
    FROM match_download_jobs AS job";

const ANALYSIS_ACTIVITY_SQL: &str = "
    SELECT
        'analysis:' || demo.id AS activity_id,
        'analysis' AS source_kind,
        demo.id AS source_id,
        CASE demo.status WHEN 'ready' THEN 'completed' ELSE demo.status END AS status,
        demo.updated_at,
        demo.document_json,
        'analysis:' || demo.id || ' analysis ' || demo.id || ' ' ||
            CASE demo.status WHEN 'ready' THEN 'completed' ELSE demo.status END || ' ' ||
            demo.display_name AS search_text
    FROM demos AS demo
    WHERE demo.status IN ('analyzing', 'failed')
       OR (demo.status = 'ready' AND EXISTS (
            SELECT 1 FROM analyses WHERE analyses.demo_id = demo.id
       ))";

const ACTIVITY_SUMMARY_SQL: &str = "
    SELECT
        COALESCE(SUM(total), 0),
        COALESCE(SUM(active), 0),
        COALESCE(SUM(failed), 0),
        COALESCE(SUM(completed), 0)
    FROM (
        SELECT
            COUNT(*) AS total,
            COALESCE(SUM(status NOT IN ('completed', 'failed', 'cancelled')), 0) AS active,
            COALESCE(SUM(status = 'failed'), 0) AS failed,
            COALESCE(SUM(status = 'completed'), 0) AS completed
        FROM recording_jobs
        UNION ALL
        SELECT
            COUNT(*),
            COALESCE(SUM(status NOT IN ('completed', 'failed', 'cancelled')), 0),
            COALESCE(SUM(status = 'failed'), 0),
            COALESCE(SUM(status = 'completed'), 0)
        FROM export_jobs
        UNION ALL
        SELECT
            COUNT(*),
            COALESCE(SUM(status NOT IN ('completed', 'failed', 'cancelled')), 0),
            COALESCE(SUM(status = 'failed'), 0),
            COALESCE(SUM(status = 'completed'), 0)
        FROM match_download_jobs
        UNION ALL
        SELECT
            COUNT(*),
            COALESCE(SUM(demo.status = 'analyzing'), 0),
            COALESCE(SUM(demo.status = 'failed'), 0),
            COALESCE(SUM(demo.status = 'ready'), 0)
        FROM demos AS demo
        WHERE demo.status IN ('analyzing', 'failed')
           OR (demo.status = 'ready' AND EXISTS (
                SELECT 1 FROM analyses WHERE analyses.demo_id = demo.id
           ))
    )";

const DOWNLOAD_RETRYABILITY_SQL: &str = "
    SELECT job.id, match_record.steam_id,
           CASE WHEN
                job.status IN ('failed', 'cancelled')
                AND NOT EXISTS (
                    SELECT 1 FROM match_download_jobs AS active
                    WHERE active.match_record_id = job.match_record_id
                      AND active.status NOT IN ('completed', 'cancelled', 'failed')
                )
                AND NOT EXISTS (
                    SELECT 1 FROM match_download_jobs AS newer
                    WHERE newer.match_record_id = job.match_record_id
                      AND (
                        newer.updated_at > job.updated_at
                        OR (newer.updated_at = job.updated_at AND newer.id < job.id)
                      )
                )
                AND match_record.id IS NOT NULL
                AND json_extract(match_record.document_json, '$.demo_id') IS NULL
                AND json_extract(match_record.document_json, '$.demo_status') <> 'downloaded'
           THEN 1 ELSE 0 END
    FROM match_download_jobs AS job
    LEFT JOIN steam_matches AS match_record ON match_record.id = job.match_record_id";

#[derive(Debug, Clone, Copy)]
struct ActivityBranch {
    source_sql: &'static str,
}

impl ActivityBranch {
    const fn for_kind(kind: ActivityKind) -> Self {
        Self {
            source_sql: match kind {
                ActivityKind::Recording => RECORDING_ACTIVITY_SQL,
                ActivityKind::Export => EXPORT_ACTIVITY_SQL,
                ActivityKind::Download => DOWNLOAD_ACTIVITY_SQL,
                ActivityKind::Analysis => ANALYSIS_ACTIVITY_SQL,
            },
        }
    }
}

const ALL_ACTIVITY_KINDS: [ActivityKind; 4] = [
    ActivityKind::Recording,
    ActivityKind::Export,
    ActivityKind::Download,
    ActivityKind::Analysis,
];

fn selected_activity_branches(kind: Option<ActivityKind>) -> Vec<ActivityBranch> {
    kind.map_or_else(
        || {
            ALL_ACTIVITY_KINDS
                .into_iter()
                .map(ActivityBranch::for_kind)
                .collect()
        },
        |kind| vec![ActivityBranch::for_kind(kind)],
    )
}

fn activity_page_sql(kind: Option<ActivityKind>) -> String {
    let branches = selected_activity_branches(kind);
    if let [branch] = branches.as_slice() {
        return format!(
            "SELECT source_kind, source_id, document_json
               FROM ({}) AS activity{ACTIVITY_FILTER_SQL}
              ORDER BY updated_at DESC, activity_id ASC
              LIMIT :limit OFFSET :offset",
            branch.source_sql
        );
    }

    let candidates = branches
        .iter()
        .map(|branch| {
            format!(
                "SELECT * FROM (
                    SELECT activity_id, source_kind, source_id, updated_at, document_json
                      FROM ({}) AS activity{ACTIVITY_FILTER_SQL}
                     ORDER BY updated_at DESC, activity_id ASC
                     LIMIT :window
                )",
                branch.source_sql
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    format!(
        "SELECT source_kind, source_id, document_json
           FROM ({candidates}) AS page_candidates
          ORDER BY updated_at DESC, activity_id ASC
          LIMIT :limit OFFSET :offset"
    )
}

fn activity_count_sql(kind: Option<ActivityKind>) -> String {
    let counts = selected_activity_branches(kind)
        .iter()
        .map(|branch| {
            format!(
                "SELECT COUNT(*) AS count
                   FROM ({}) AS activity{ACTIVITY_FILTER_SQL}",
                branch.source_sql
            )
        })
        .collect::<Vec<_>>();
    if let [count] = counts.as_slice() {
        count.clone()
    } else {
        format!(
            "SELECT COALESCE(SUM(count), 0) FROM ({})",
            counts.join(" UNION ALL ")
        )
    }
}

fn download_retryability_sql(downloads: usize) -> String {
    let parameters = (1..=downloads)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{DOWNLOAD_RETRYABILITY_SQL} WHERE job.id IN ({parameters})")
}

impl Storage {
    /// Queries the current cross-workflow activity projection without loading complete job
    /// histories into application memory.
    ///
    /// Summary, filtered count and page rows are read in one `SQLite` transaction, so every
    /// number and item in the result describes one persisted snapshot. Every activity kind is
    /// filtered and windowed at its authoritative table before the cross-kind merge. Writes,
    /// deletes and foreign-key cascades are therefore visible immediately without rebuilding a
    /// derived history.
    pub async fn query_activities(&self, query: ActivityQuery) -> Result<ActivityPage> {
        if !(1..=MAXIMUM_ACTIVITY_PAGE).contains(&query.page) {
            return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
                "activity page must be between 1 and {MAXIMUM_ACTIVITY_PAGE}"
            ))
            .into());
        }
        if !(1..=MAXIMUM_ACTIVITY_PAGE_SIZE).contains(&query.page_size) {
            return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
                "activity page_size must be between 1 and {MAXIMUM_ACTIVITY_PAGE_SIZE}"
            ))
            .into());
        }
        if query
            .search
            .as_deref()
            .is_some_and(|search| search.chars().count() > MAXIMUM_ACTIVITY_SEARCH_CHARS)
        {
            return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
                "activity search must contain at most {MAXIMUM_ACTIVITY_SEARCH_CHARS} characters"
            ))
            .into());
        }
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let summary = transaction.query_row(ACTIVITY_SUMMARY_SQL, [], |row| {
                Ok(ActivitySummary {
                    total: row_u64(row, 0)?,
                    active: row_u64(row, 1)?,
                    failed: row_u64(row, 2)?,
                    completed: row_u64(row, 3)?,
                })
            })?;
            let state = query.state.map(ActivityState::as_str);
            let search = query
                .search
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let total = transaction.query_row(
                &activity_count_sql(query.kind),
                named_params! {
                    ":state": state,
                    ":search": search,
                },
                |row| row_u64(row, 0),
            )?;
            let offset = u64::from(query.page.saturating_sub(1)) * u64::from(query.page_size);
            let mut statement = transaction.prepare(&activity_page_sql(query.kind))?;
            let limit = sql_u64(u64::from(query.page_size))?;
            let offset = sql_u64(offset)?;
            let mut rows = if query.kind.is_some() {
                statement.query(named_params! {
                    ":state": state,
                    ":search": search,
                    ":limit": limit,
                    ":offset": offset,
                })?
            } else {
                let window = offset.checked_add(limit).ok_or_else(|| {
                    StorageError::ActivityProjection(
                        "activity page window exceeds SQLite integer range".to_owned(),
                    )
                })?;
                statement.query(named_params! {
                    ":state": state,
                    ":search": search,
                    ":window": window,
                    ":limit": limit,
                    ":offset": offset,
                })?
            };
            let mut persisted = Vec::new();
            while let Some(row) = rows.next()? {
                persisted.push(PersistedActivity {
                    source_kind: row.get(0)?,
                    source_id: row.get(1)?,
                    document: row.get(2)?,
                    retryable: false,
                    owner_steam_id: None,
                });
            }
            drop(rows);
            drop(statement);

            let download_ids = persisted
                .iter()
                .filter(|activity| activity.source_kind == "download")
                .map(|activity| activity.source_id.clone())
                .collect::<Vec<_>>();
            if !download_ids.is_empty() {
                let mut statement =
                    transaction.prepare(&download_retryability_sql(download_ids.len()))?;
                let retryability = statement
                    .query_map(params_from_iter(&download_ids), |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            (row.get::<_, Option<String>>(1)?, row.get::<_, bool>(2)?),
                        ))
                    })?
                    .collect::<rusqlite::Result<HashMap<_, _>>>()?;
                for activity in &mut persisted {
                    if activity.source_kind == "download"
                        && let Some((owner_steam_id, retryable)) =
                            retryability.get(&activity.source_id)
                    {
                        activity.owner_steam_id.clone_from(owner_steam_id);
                        activity.retryable = *retryable;
                    }
                }
            }
            transaction.commit()?;

            let items = persisted
                .into_iter()
                .map(|persisted| match persisted.source_kind.as_str() {
                    "recording" => decode(&persisted.document).map(ActivitySource::Recording),
                    "export" => decode(&persisted.document).map(ActivitySource::Export),
                    "download" => decode(&persisted.document).map(|job| ActivitySource::Download {
                        job,
                        retryable: persisted.retryable,
                        owner_steam_id: persisted.owner_steam_id,
                    }),
                    "analysis" => decode(&persisted.document).map(ActivitySource::Analysis),
                    value => Err(StorageError::ActivityProjection(format!(
                        "unknown activity source kind {value:?}"
                    ))),
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(ActivityPage {
                items,
                total,
                page: query.page,
                page_size: query.page_size,
                summary,
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn activity_search_accepts_each_copyable_exact_activity_id() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = chrono::Utc::now();
        let recording_id = uuid::Uuid::new_v4();
        let export_id = uuid::Uuid::new_v4();
        let download_id = uuid::Uuid::new_v4();
        let analysis_id = uuid::Uuid::new_v4();
        let match_record_id = "76561198000000000:copied-id";

        storage
            .put_recording_job(vibe_cs_domain::RecordingJob {
                id: recording_id,
                status: vibe_cs_domain::JobStatus::Running,
                items: vec![],
                current_index: 0,
                progress: 0.0,
                message: "recording.stage.capturing".to_owned(),
                outputs: vec![],
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("put recording activity");
        storage
            .put_export_job(ExportJobRecord {
                kind: "editor".to_owned(),
                job: vibe_cs_domain::ExportJob {
                    id: export_id,
                    project_id: uuid::Uuid::new_v4(),
                    status: vibe_cs_domain::JobStatus::Completed,
                    progress: 1.0,
                    output_path: "C:/exports/copied-id.mp4".to_owned(),
                    error: None,
                    created_at: now,
                    updated_at: now,
                },
            })
            .await
            .expect("put export activity");
        storage
            .put_steam_matches(vec![vibe_cs_domain::SteamMatchRecord {
                id: match_record_id.to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "copied-id".to_owned(),
                outcome_id: "copied-id-outcome".to_owned(),
                token: 7,
                map_name: Some("de_mirage".to_owned()),
                played_at: Some(now),
                score: None,
                result: vibe_cs_domain::MatchHistoryResult::Unknown,
                demo_status: vibe_cs_domain::MatchDemoStatus::Failed,
                demo_id: None,
                last_error: Some("network".to_owned()),
                synced_at: now,
                updated_at: now,
            }])
            .await
            .expect("put match activity owner");
        storage
            .put_match_download_job(vibe_cs_domain::MatchDownloadJob {
                id: download_id,
                match_record_id: match_record_id.to_owned(),
                status: vibe_cs_domain::MatchDownloadStatus::Failed,
                downloaded_bytes: 0,
                total_bytes: None,
                progress: 0.0,
                demo_id: None,
                error: Some("network".to_owned()),
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("put download activity");
        storage
            .put_demo(vibe_cs_domain::DemoRecord {
                id: analysis_id,
                path: "C:/demos/copied-id.dem".to_owned(),
                file_name: "copied-id.dem".to_owned(),
                display_name: "Copied ID analysis".to_owned(),
                source: "local".to_owned(),
                status: vibe_cs_domain::DemoStatus::Failed,
                map_name: None,
                match_date: None,
                duration_seconds: None,
                total_rounds: None,
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: vec![],
                remark: String::new(),
                content_sha256: None,
                file_size: 1,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("put analysis activity");

        for (exact_id, expected_kind) in [
            (format!("recording:{recording_id}"), ActivityKind::Recording),
            (format!("export:{export_id}"), ActivityKind::Export),
            (format!("download:{download_id}"), ActivityKind::Download),
            (format!("analysis:{analysis_id}"), ActivityKind::Analysis),
        ] {
            let page = storage
                .query_activities(ActivityQuery {
                    search: Some(exact_id.clone()),
                    kind: None,
                    state: None,
                    page: 1,
                    page_size: 10,
                })
                .await
                .expect("search exact activity id");

            assert_eq!(page.total, 1, "copied activity id {exact_id} must resolve");
            assert!(
                matches!(
                    (expected_kind, page.items.as_slice()),
                    (ActivityKind::Recording, [ActivitySource::Recording(job)])
                        if job.id == recording_id
                ) || matches!(
                    (expected_kind, page.items.as_slice()),
                    (ActivityKind::Export, [ActivitySource::Export(record)])
                        if record.job.id == export_id
                ) || matches!(
                    (expected_kind, page.items.as_slice()),
                    (ActivityKind::Download, [ActivitySource::Download { job, .. }])
                        if job.id == download_id
                ) || matches!(
                    (expected_kind, page.items.as_slice()),
                    (ActivityKind::Analysis, [ActivitySource::Analysis(demo)])
                        if demo.id == analysis_id
                ),
                "copied activity id {exact_id} resolved to the wrong activity: {page:#?}"
            );
        }
    }

    #[tokio::test]
    async fn activity_kind_page_plan_reads_only_the_requested_source() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let plan = storage
            .run(|connection| {
                let mut statement = connection.prepare(&format!(
                    "EXPLAIN QUERY PLAN {}",
                    activity_page_sql(Some(ActivityKind::Export))
                ))?;
                let details = statement
                    .query_map(
                        named_params! {
                            ":state": Option::<String>::None,
                            ":search": Option::<String>::None,
                            ":limit": 10_i64,
                            ":offset": 0_i64,
                        },
                        |row| row.get::<_, String>(3),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(details)
            })
            .await
            .expect("explain activity page");

        for unrequested_source in ["recording_jobs", "match_download_jobs", "demos"] {
            assert!(
                plan.iter()
                    .all(|detail| !detail.contains(unrequested_source)),
                "export-only activity plan must not read {unrequested_source}: {plan:#?}"
            );
        }
    }

    #[tokio::test]
    async fn activity_cross_kind_page_plan_defers_download_retryability_until_after_paging() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let plan = storage
            .run(|connection| {
                let mut statement = connection
                    .prepare(&format!("EXPLAIN QUERY PLAN {}", activity_page_sql(None)))?;
                let details = statement
                    .query_map(
                        named_params! {
                            ":state": Option::<String>::None,
                            ":search": Option::<String>::None,
                            ":window": 10_i64,
                            ":limit": 10_i64,
                            ":offset": 0_i64,
                        },
                        |row| row.get::<_, String>(3),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(details)
            })
            .await
            .expect("explain cross-kind activity page");

        for retry_dependency in ["SEARCH active", "SEARCH newer", "SEARCH match_record"] {
            assert!(
                plan.iter().all(|detail| !detail.contains(retry_dependency)),
                "page merge must not compute retryability while scanning download history: {plan:#?}"
            );
        }
        assert_eq!(
            plan.iter()
                .filter(|detail| detail.starts_with("CO-ROUTINE (subquery-"))
                .count(),
            ALL_ACTIVITY_KINDS.len(),
            "each source must be filtered and windowed before the final page merge: {plan:#?}"
        );
    }

    #[tokio::test]
    async fn current_activity_schema_uses_authoritative_tables_and_status_order_indexes() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let (obsolete_view, indexes) = storage
            .run(|connection| {
                let obsolete_view = connection.query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                      WHERE type = 'view' AND name = 'activity_projection'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                let mut statement = connection.prepare(
                    "SELECT name FROM sqlite_master
                      WHERE type = 'index' AND name LIKE '%_activity_status_idx'",
                )?;
                let indexes = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((obsolete_view, indexes))
            })
            .await
            .expect("inspect current activity schema");

        assert_eq!(
            obsolete_view, 0,
            "current schema must not retain an unused view"
        );
        for expected in [
            "recording_jobs_activity_status_idx",
            "export_jobs_activity_status_idx",
            "match_download_jobs_activity_status_idx",
            "demos_activity_status_idx",
        ] {
            assert!(
                indexes.iter().any(|index| index == expected),
                "missing status/order index {expected}: {indexes:#?}"
            );
        }
    }

    #[tokio::test]
    async fn activity_query_rejects_unbounded_or_invalid_storage_pages() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        for query in [
            ActivityQuery {
                search: None,
                kind: None,
                state: None,
                page: 0,
                page_size: 50,
            },
            ActivityQuery {
                search: None,
                kind: None,
                state: None,
                page: 10_001,
                page_size: 50,
            },
            ActivityQuery {
                search: None,
                kind: None,
                state: None,
                page: 1,
                page_size: 101,
            },
        ] {
            assert!(matches!(
                storage.query_activities(query).await,
                Err(StorageError::Domain(
                    vibe_cs_domain::DomainError::InvalidInput(_)
                ))
            ));
        }
    }
}
