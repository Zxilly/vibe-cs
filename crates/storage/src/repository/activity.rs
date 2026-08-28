use std::collections::HashMap;

use rusqlite::{OptionalExtension as _, named_params, params_from_iter};
use vibe_cs_domain::{AnalysisRun, DemoRecord, MatchDownloadJob, RecordingJob};

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
    Cancelled,
}

impl ActivityState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Failed => "failed",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
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
    Recording {
        job: RecordingJob,
        retryable: bool,
    },
    Export(ExportJobRecord),
    Download {
        job: MatchDownloadJob,
        retryable: bool,
        owner_steam_id: Option<String>,
    },
    Analysis {
        run: AnalysisRun,
        demo: Box<DemoRecord>,
        retryable: bool,
        result_available: bool,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ActivitySummary {
    pub total: u64,
    pub active: u64,
    pub failed: u64,
    pub completed: u64,
    pub cancelled: u64,
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
    result_available: bool,
}

#[derive(serde::Deserialize)]
struct AnalysisActivityDocument {
    run: AnalysisRun,
    demo: DemoRecord,
}

fn decode_persisted_activity(persisted: PersistedActivity) -> Result<ActivitySource> {
    match persisted.source_kind.as_str() {
        "recording" => decode(&persisted.document).map(|job: RecordingJob| {
            let retryable = persisted.retryable && job.retryable_suffix().is_ok();
            ActivitySource::Recording { job, retryable }
        }),
        "export" => decode(&persisted.document).map(ActivitySource::Export),
        "download" => decode(&persisted.document).map(|job| ActivitySource::Download {
            job,
            retryable: persisted.retryable,
            owner_steam_id: persisted.owner_steam_id,
        }),
        "analysis" => decode::<AnalysisActivityDocument>(&persisted.document).map(|document| {
            ActivitySource::Analysis {
                run: document.run,
                demo: Box::new(document.demo),
                retryable: persisted.retryable,
                result_available: persisted.result_available,
            }
        }),
        value => Err(StorageError::ActivityProjection(format!(
            "unknown activity source kind {value:?}"
        ))),
    }
}

const ACTIVITY_FILTER_SQL: &str = "
    WHERE (
        :state IS NULL
        OR (:state = 'active' AND status NOT IN ('completed', 'failed', 'cancelled'))
        OR (:state = 'failed' AND status = 'failed')
        OR (:state = 'completed' AND status = 'completed')
        OR (:state = 'cancelled' AND status = 'cancelled')
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
        'analysis:' || run.id AS activity_id,
        'analysis' AS source_kind,
        run.id AS source_id,
        CASE WHEN run.status = 'interrupted' THEN 'failed' ELSE run.status END AS status,
        run.updated_at,
        json_object('run', json(run.document_json), 'demo', json(demo.document_json)) AS document_json,
        'analysis:' || run.id || ' analysis ' || run.id || ' ' || run.demo_id || ' ' ||
            run.status || ' ' || run.stage || ' ' || COALESCE(run.error, '') || ' ' ||
            demo.display_name AS search_text
    FROM analysis_runs AS run
    INNER JOIN demos AS demo ON demo.id = run.demo_id";

const ACTIVITY_SUMMARY_SQL: &str = "
    SELECT
        COALESCE(SUM(total), 0),
        COALESCE(SUM(active), 0),
        COALESCE(SUM(failed), 0),
        COALESCE(SUM(completed), 0),
        COALESCE(SUM(cancelled), 0)
    FROM (
        SELECT
            COUNT(*) AS total,
            COALESCE(SUM(status NOT IN ('completed', 'failed', 'cancelled')), 0) AS active,
            COALESCE(SUM(status = 'failed'), 0) AS failed,
            COALESCE(SUM(status = 'completed'), 0) AS completed,
            COALESCE(SUM(status = 'cancelled'), 0) AS cancelled
        FROM recording_jobs
        UNION ALL
        SELECT
            COUNT(*),
            COALESCE(SUM(status NOT IN ('completed', 'failed', 'cancelled')), 0),
            COALESCE(SUM(status = 'failed'), 0),
            COALESCE(SUM(status = 'completed'), 0),
            COALESCE(SUM(status = 'cancelled'), 0)
        FROM export_jobs
        UNION ALL
        SELECT
            COUNT(*),
            COALESCE(SUM(status NOT IN ('completed', 'failed', 'cancelled')), 0),
            COALESCE(SUM(status = 'failed'), 0),
            COALESCE(SUM(status = 'completed'), 0),
            COALESCE(SUM(status = 'cancelled'), 0)
        FROM match_download_jobs
        UNION ALL
        SELECT
            COUNT(*),
            COALESCE(SUM(status IN ('queued', 'running')), 0),
            COALESCE(SUM(status IN ('failed', 'interrupted')), 0),
            COALESCE(SUM(status = 'completed'), 0),
            COALESCE(SUM(status = 'cancelled'), 0)
        FROM analysis_runs
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

const RECORDING_RETRYABILITY_SQL: &str = "
    SELECT job.id,
           CASE WHEN
               job.status IN ('failed', 'cancelled')
               AND NOT EXISTS (
                   SELECT 1 FROM recording_jobs AS child WHERE child.retry_of = job.id
               )
               AND NOT EXISTS (
                   SELECT 1 FROM recording_jobs AS active
                    WHERE active.status NOT IN ('completed', 'failed', 'cancelled')
               )
           THEN 1 ELSE 0 END
      FROM recording_jobs AS job";

const ANALYSIS_RETRYABILITY_SQL: &str = "
    SELECT run.id,
           CASE WHEN
               run.status IN ('failed', 'interrupted', 'cancelled')
               AND NOT EXISTS (
                   SELECT 1 FROM analysis_runs AS active
                   WHERE active.demo_id = run.demo_id
                     AND active.status IN ('queued', 'running')
               )
               AND NOT EXISTS (
                   SELECT 1 FROM analysis_runs AS newer
                   WHERE newer.demo_id = run.demo_id
                     AND (
                       newer.created_at > run.created_at
                       OR (newer.created_at = run.created_at AND newer.id < run.id)
                     )
               )
               AND NOT EXISTS (
                   SELECT 1 FROM analyses WHERE analyses.demo_id = run.demo_id
               )
               AND EXISTS (
                   SELECT 1 FROM demos
                   WHERE demos.id = run.demo_id
                     AND demos.status NOT IN ('missing', 'indexing', 'analyzing')
               )
           THEN 1 ELSE 0 END
      FROM analysis_runs AS run";

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

fn recording_retryability_sql(recordings: usize) -> String {
    let parameters = (1..=recordings)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{RECORDING_RETRYABILITY_SQL} WHERE job.id IN ({parameters})")
}

fn analysis_retryability_sql(analyses: usize) -> String {
    let parameters = (1..=analyses)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{ANALYSIS_RETRYABILITY_SQL} WHERE run.id IN ({parameters})")
}

impl Storage {
    /// Reads one exact activity from its authoritative persisted source.
    pub async fn get_activity(
        &self,
        kind: ActivityKind,
        id: uuid::Uuid,
    ) -> Result<Option<ActivitySource>> {
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let branch = ActivityBranch::for_kind(kind);
            let persisted = transaction
                .query_row(
                    &format!(
                        "SELECT source_kind, source_id, document_json \
                           FROM ({}) AS activity WHERE source_id = ?1",
                        branch.source_sql
                    ),
                    [id.to_string()],
                    |row| {
                        Ok(PersistedActivity {
                            source_kind: row.get(0)?,
                            source_id: row.get(1)?,
                            document: row.get(2)?,
                            retryable: false,
                            owner_steam_id: None,
                            result_available: false,
                        })
                    },
                )
                .optional()?;
            let Some(mut persisted) = persisted else {
                transaction.commit()?;
                return Ok(None);
            };
            match kind {
                ActivityKind::Recording => {
                    persisted.retryable = transaction.query_row(
                        &format!("{RECORDING_RETRYABILITY_SQL} WHERE job.id = ?1"),
                        [id.to_string()],
                        |row| row.get::<_, bool>(1),
                    )?;
                }
                ActivityKind::Export => {}
                ActivityKind::Download => {
                    let (owner_steam_id, retryable) = transaction.query_row(
                        &format!("{DOWNLOAD_RETRYABILITY_SQL} WHERE job.id = ?1"),
                        [id.to_string()],
                        |row| Ok((row.get::<_, Option<String>>(1)?, row.get::<_, bool>(2)?)),
                    )?;
                    persisted.owner_steam_id = owner_steam_id;
                    persisted.retryable = retryable;
                }
                ActivityKind::Analysis => {
                    persisted.retryable = transaction.query_row(
                        &format!("{ANALYSIS_RETRYABILITY_SQL} WHERE run.id = ?1"),
                        [id.to_string()],
                        |row| row.get::<_, bool>(1),
                    )?;
                    persisted.result_available = transaction.query_row(
                        "SELECT EXISTS(\
                             SELECT 1 FROM analyses \
                             WHERE analyses.producer_run_id = ?1 \
                               AND analyses.demo_id = (\
                                   SELECT demo_id FROM analysis_runs WHERE id = ?1\
                               )\
                         )",
                        [id.to_string()],
                        |row| row.get::<_, bool>(0),
                    )?;
                }
            }
            transaction.commit()?;
            decode_persisted_activity(persisted).map(Some)
        })
        .await
    }

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
                    cancelled: row_u64(row, 4)?,
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
                    result_available: false,
                });
            }
            drop(rows);
            drop(statement);

            let recording_ids = persisted
                .iter()
                .filter(|activity| activity.source_kind == "recording")
                .map(|activity| activity.source_id.clone())
                .collect::<Vec<_>>();
            if !recording_ids.is_empty() {
                let mut statement =
                    transaction.prepare(&recording_retryability_sql(recording_ids.len()))?;
                let retryability = statement
                    .query_map(params_from_iter(&recording_ids), |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
                    })?
                    .collect::<rusqlite::Result<HashMap<_, _>>>()?;
                for activity in &mut persisted {
                    if activity.source_kind == "recording"
                        && let Some(retryable) = retryability.get(&activity.source_id)
                    {
                        activity.retryable = *retryable;
                    }
                }
            }

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
            let analysis_ids = persisted
                .iter()
                .filter(|activity| activity.source_kind == "analysis")
                .map(|activity| activity.source_id.clone())
                .collect::<Vec<_>>();
            if !analysis_ids.is_empty() {
                let mut statement =
                    transaction.prepare(&analysis_retryability_sql(analysis_ids.len()))?;
                let retryability = statement
                    .query_map(params_from_iter(&analysis_ids), |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
                    })?
                    .collect::<rusqlite::Result<HashMap<_, _>>>()?;
                for activity in &mut persisted {
                    if activity.source_kind == "analysis"
                        && let Some(retryable) = retryability.get(&activity.source_id)
                    {
                        activity.retryable = *retryable;
                    }
                }
                let parameters = (1..=analysis_ids.len())
                    .map(|index| format!("?{index}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                let mut statement = transaction.prepare(&format!(
                    "SELECT run.id, EXISTS(\
                         SELECT 1 FROM analyses \
                         WHERE analyses.producer_run_id = run.id \
                           AND analyses.demo_id = run.demo_id\
                     ) \
                     FROM analysis_runs AS run WHERE run.id IN ({parameters})"
                ))?;
                let availability = statement
                    .query_map(params_from_iter(&analysis_ids), |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
                    })?
                    .collect::<rusqlite::Result<HashMap<_, _>>>()?;
                for activity in &mut persisted {
                    if activity.source_kind == "analysis"
                        && let Some(result_available) = availability.get(&activity.source_id)
                    {
                        activity.result_available = *result_available;
                    }
                }
            }
            transaction.commit()?;

            let items = persisted
                .into_iter()
                .map(decode_persisted_activity)
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

    fn analysis_demo(
        id: uuid::Uuid,
        status: vibe_cs_domain::DemoStatus,
    ) -> vibe_cs_domain::DemoRecord {
        let now = chrono::Utc::now();
        vibe_cs_domain::DemoRecord {
            id,
            path: format!("C:/demos/{id}.dem"),
            file_name: format!("{id}.dem"),
            display_name: "Analysis activity".to_owned(),
            source: "local".to_owned(),
            status,
            map_name: None,
            match_date: None,
            duration_seconds: None,
            total_rounds: None,
            team_a_name: None,
            team_b_name: None,
            team_a_score: None,
            team_b_score: None,
            player_names: Vec::new(),
            remark: String::new(),
            content_sha256: Some("a".repeat(64)),
            file_size: 512,
            created_at: now,
            updated_at: now,
        }
    }

    async fn complete_analysis(storage: &Storage, demo_id: uuid::Uuid) -> uuid::Uuid {
        let fingerprint = vibe_cs_domain::AnalysisInputFingerprint {
            sha256: "a".repeat(64),
            size: 512,
        };
        let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage
            .bind_analysis_run_input(run_id, fingerprint.clone())
            .await
            .unwrap();
        storage.mark_analysis_parser_started(run_id).await.unwrap();
        storage
            .mark_analysis_input_revalidation_started(run_id)
            .await
            .unwrap();
        storage
            .mark_analysis_projection_started(run_id)
            .await
            .unwrap();
        storage
            .complete_analysis_run(
                run_id,
                vibe_cs_domain::MatchAnalysis {
                    demo_id,
                    map_name: "de_mirage".to_owned(),
                    tick_rate: 64.0,
                    duration_seconds: 1.0,
                    verified_total_ticks: None,
                    teams: Vec::new(),
                    players: Vec::new(),
                    rounds: Vec::new(),
                    highlights: Vec::new(),
                },
                fingerprint,
            )
            .await
            .unwrap();
        run_id
    }

    async fn create_export_project(storage: &Storage) -> uuid::Uuid {
        let now = chrono::Utc::now();
        let project_id = uuid::Uuid::new_v4();
        let story_track_id = uuid::Uuid::new_v4();
        storage
            .create_project(vibe_cs_domain::Project {
                id: project_id,
                name: "Export owner".to_owned(),
                revision: 1,
                document: vibe_cs_domain::EditingDocument {
                    width: 1920,
                    height: 1080,
                    fps: 60,
                    duration_seconds: 0.0,
                    story_track_id,
                    tracks: vec![vibe_cs_domain::TimelineTrack {
                        id: story_track_id,
                        name: "Story".to_owned(),
                        kind: vibe_cs_domain::TrackKind::Video,
                        order: 0,
                        muted: false,
                        locked: false,
                        hidden: false,
                        clips: Vec::new(),
                    }],
                    markers: Vec::new(),
                    settings: serde_json::json!({}),
                },
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("create export Project");
        project_id
    }

    #[tokio::test]
    async fn activity_search_accepts_each_copyable_exact_activity_id() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = chrono::Utc::now();
        let recording_id = uuid::Uuid::new_v4();
        let export_id = uuid::Uuid::new_v4();
        let export_project_id = create_export_project(&storage).await;
        let download_id = uuid::Uuid::new_v4();
        let analysis_demo_id = uuid::Uuid::new_v4();
        let match_record_id = "76561198000000000:copied-id";

        storage
            .put_recording_job(vibe_cs_domain::RecordingJob {
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
            .expect("put recording activity");
        storage
            .put_export_job(ExportJobRecord {
                kind: "editor".to_owned(),
                job: vibe_cs_domain::ExportJob {
                    id: export_id,
                    project_id: export_project_id,
                    status: vibe_cs_domain::JobStatus::Completed,
                    progress: 1.0,
                    output_path: "C:/exports/copied-id.mp4".to_owned(),
                    error: None,
                    error_code: None,
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
                error_code: None,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("put download activity");
        storage
            .put_demo(vibe_cs_domain::DemoRecord {
                id: analysis_demo_id,
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
                content_sha256: Some("a".repeat(64)),
                file_size: 512,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("put analysis activity");
        let analysis_id = storage
            .start_analysis_run(analysis_demo_id)
            .await
            .expect("start analysis activity")
            .run
            .id;

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
                    (ActivityKind::Recording, [ActivitySource::Recording { job, .. }])
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
                    (ActivityKind::Analysis, [ActivitySource::Analysis { run, demo, retryable: false, result_available: false }])
                        if run.id == analysis_id && demo.id == analysis_demo_id
                ),
                "copied activity id {exact_id} resolved to the wrong activity: {page:#?}"
            );
        }
    }

    #[tokio::test]
    async fn exact_activity_read_resolves_only_the_requested_kind_and_job_id() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = chrono::Utc::now();
        let export_id = uuid::Uuid::new_v4();
        let export_project_id = create_export_project(&storage).await;
        storage
            .put_export_job(ExportJobRecord {
                kind: "editor".to_owned(),
                job: vibe_cs_domain::ExportJob {
                    id: export_id,
                    project_id: export_project_id,
                    status: vibe_cs_domain::JobStatus::Completed,
                    progress: 1.0,
                    output_path: "C:/exports/exact.mp4".to_owned(),
                    error: None,
                    error_code: None,
                    created_at: now,
                    updated_at: now,
                },
            })
            .await
            .expect("put export activity");

        assert!(matches!(
            storage
                .get_activity(ActivityKind::Export, export_id)
                .await
                .expect("exact export activity"),
            Some(ActivitySource::Export(record)) if record.job.id == export_id
        ));
        assert!(
            storage
                .get_activity(ActivityKind::Recording, export_id)
                .await
                .expect("wrong-kind lookup")
                .is_none(),
            "an exact lookup must not search another activity source"
        );
    }

    #[tokio::test]
    async fn exact_recording_activity_reads_retryability_from_the_same_durable_lineage() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = chrono::Utc::now();
        let parent_id = uuid::Uuid::new_v4();
        let request = vibe_cs_domain::RecordingRequest {
            id: Some(uuid::Uuid::new_v4()),
            demo_id: uuid::Uuid::new_v4(),
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
        let attempt = |id, retry_of| vibe_cs_domain::RecordingJob {
            id,
            retry_of,
            status: vibe_cs_domain::JobStatus::Failed,
            items: vec![request.clone()],
            current_index: 0,
            progress: 0.0,
            message: "capture interrupted".to_owned(),
            outputs: Vec::new(),
            error_code: None,
            created_at: now,
            updated_at: now,
        };
        storage
            .put_recording_job(attempt(parent_id, None))
            .await
            .expect("parent job");

        assert!(matches!(
            storage
                .get_activity(ActivityKind::Recording, parent_id)
                .await
                .expect("retryable parent"),
            Some(ActivitySource::Recording { job, retryable: true }) if job.id == parent_id
        ));

        storage
            .put_recording_job(attempt(uuid::Uuid::new_v4(), Some(parent_id)))
            .await
            .expect("retry child");
        assert!(matches!(
            storage
                .get_activity(ActivityKind::Recording, parent_id)
                .await
                .expect("claimed parent"),
            Some(ActivitySource::Recording { job, retryable: false }) if job.id == parent_id
        ));
    }

    #[tokio::test]
    async fn exact_download_activity_keeps_owner_and_retryability_bound_to_one_snapshot() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = chrono::Utc::now();
        let job_id = uuid::Uuid::new_v4();
        let match_record_id = "76561198000000000:exact-download";
        storage
            .put_steam_matches(vec![vibe_cs_domain::SteamMatchRecord {
                id: match_record_id.to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "exact-download".to_owned(),
                outcome_id: "exact-download-outcome".to_owned(),
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
            .expect("put failed download");

        assert!(matches!(
            storage
                .get_activity(ActivityKind::Download, job_id)
                .await
                .expect("exact download"),
            Some(ActivitySource::Download {
                job,
                retryable: true,
                owner_steam_id: Some(owner),
            }) if job.id == job_id && owner == "76561198000000000"
        ));
    }

    #[tokio::test]
    async fn exact_analysis_activity_preserves_interrupted_stage_and_retry_truth() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = uuid::Uuid::new_v4();
        storage
            .put_demo(analysis_demo(
                demo_id,
                vibe_cs_domain::DemoStatus::Discovered,
            ))
            .await
            .expect("put analysis demo");
        let run_id = storage
            .start_analysis_run(demo_id)
            .await
            .expect("start run")
            .run
            .id;
        storage
            .recover_orphaned_analysis_runs()
            .await
            .expect("interrupt run");

        assert!(matches!(
            storage
                .get_activity(ActivityKind::Analysis, run_id)
                .await
                .expect("exact analysis"),
            Some(ActivitySource::Analysis {
                run,
                demo,
                retryable: true,
                result_available: false,
            }) if run.id == run_id
                && run.status == vibe_cs_domain::AnalysisRunStatus::Interrupted
                && demo.id == demo_id
        ));
    }

    #[tokio::test]
    async fn activity_recording_retryability_tracks_the_latest_durable_attempt() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let now = chrono::Utc::now();
        let parent_id = uuid::Uuid::new_v4();
        let request = vibe_cs_domain::RecordingRequest {
            id: Some(uuid::Uuid::new_v4()),
            demo_id: uuid::Uuid::new_v4(),
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
        let attempt = |id, retry_of| vibe_cs_domain::RecordingJob {
            id,
            retry_of,
            status: vibe_cs_domain::JobStatus::Failed,
            items: vec![request.clone()],
            current_index: 0,
            progress: 0.0,
            message: "capture interrupted".to_owned(),
            outputs: Vec::new(),
            error_code: None,
            created_at: now,
            updated_at: now,
        };
        storage
            .put_recording_job(attempt(parent_id, None))
            .await
            .expect("parent job");
        let query = ActivityQuery {
            search: Some(format!("recording:{parent_id}")),
            kind: Some(ActivityKind::Recording),
            state: None,
            page: 1,
            page_size: 10,
        };

        let initial = storage
            .query_activities(query.clone())
            .await
            .expect("initial activity");
        assert!(matches!(
            initial.items.as_slice(),
            [ActivitySource::Recording { job, retryable: true }] if job.id == parent_id
        ));

        storage
            .put_recording_job(attempt(uuid::Uuid::new_v4(), Some(parent_id)))
            .await
            .expect("retry child");
        let superseded = storage
            .query_activities(query)
            .await
            .expect("superseded activity");
        assert!(matches!(
            superseded.items.as_slice(),
            [ActivitySource::Recording { job, retryable: false }] if job.id == parent_id
        ));
    }

    #[tokio::test]
    async fn interrupted_analysis_is_failed_in_summary_and_state_filters() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = uuid::Uuid::new_v4();
        storage
            .put_demo(vibe_cs_domain::DemoRecord {
                id: demo_id,
                path: "C:/demos/interrupted.dem".to_owned(),
                file_name: "interrupted.dem".to_owned(),
                display_name: "Interrupted analysis".to_owned(),
                source: "local".to_owned(),
                status: vibe_cs_domain::DemoStatus::Discovered,
                map_name: None,
                match_date: None,
                duration_seconds: None,
                total_rounds: None,
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: Vec::new(),
                remark: String::new(),
                content_sha256: Some("a".repeat(64)),
                file_size: 512,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            })
            .await
            .expect("put demo");
        let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage.recover_orphaned_analysis_runs().await.unwrap();

        let failed = storage
            .query_activities(ActivityQuery {
                search: Some(format!("analysis:{run_id}")),
                kind: Some(ActivityKind::Analysis),
                state: Some(ActivityState::Failed),
                page: 1,
                page_size: 10,
            })
            .await
            .unwrap();
        assert_eq!(failed.summary.failed, 1);
        assert_eq!(failed.total, 1);
        assert!(matches!(
            failed.items.as_slice(),
            [ActivitySource::Analysis { run, .. }]
                if run.status == vibe_cs_domain::AnalysisRunStatus::Interrupted
        ));

        let active = storage
            .query_activities(ActivityQuery {
                search: Some(format!("analysis:{run_id}")),
                kind: Some(ActivityKind::Analysis),
                state: Some(ActivityState::Active),
                page: 1,
                page_size: 10,
            })
            .await
            .unwrap();
        assert_eq!(active.total, 0);
    }

    #[tokio::test]
    async fn cancelled_analysis_is_a_retryable_first_class_activity_state() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = uuid::Uuid::new_v4();
        storage
            .put_demo(analysis_demo(
                demo_id,
                vibe_cs_domain::DemoStatus::Discovered,
            ))
            .await
            .expect("put analysis demo");
        let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage.cancel_analysis_run(run_id).await.unwrap();

        let cancelled = storage
            .query_activities(ActivityQuery {
                search: Some(format!("analysis:{run_id}")),
                kind: Some(ActivityKind::Analysis),
                state: Some(ActivityState::Cancelled),
                page: 1,
                page_size: 10,
            })
            .await
            .expect("cancelled activity");

        assert_eq!(cancelled.total, 1);
        assert_eq!(cancelled.summary.cancelled, 1);
        assert_eq!(
            cancelled.summary.total,
            cancelled.summary.active
                + cancelled.summary.failed
                + cancelled.summary.completed
                + cancelled.summary.cancelled
        );
        assert!(matches!(
            cancelled.items.as_slice(),
            [ActivitySource::Analysis {
                run,
                retryable: true,
                result_available: false,
                ..
            }] if run.id == run_id
                && run.status == vibe_cs_domain::AnalysisRunStatus::Cancelled
        ));
    }

    #[tokio::test]
    async fn analysis_retryability_matches_start_claim_lifecycle_preconditions() {
        for status in [
            vibe_cs_domain::DemoStatus::Indexing,
            vibe_cs_domain::DemoStatus::Analyzing,
        ] {
            let storage = Storage::open_in_memory().await.expect("open storage");
            let demo_id = uuid::Uuid::new_v4();
            storage
                .put_demo(analysis_demo(
                    demo_id,
                    vibe_cs_domain::DemoStatus::Discovered,
                ))
                .await
                .unwrap();
            let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
            storage
                .fail_analysis_run(
                    run_id,
                    "fixture failure".to_owned(),
                    vibe_cs_domain::JobFailureCode::Unknown,
                )
                .await
                .unwrap();
            storage.set_demo_status(demo_id, status).await.unwrap();

            let page = storage
                .query_activities(ActivityQuery {
                    search: Some(format!("analysis:{run_id}")),
                    kind: Some(ActivityKind::Analysis),
                    state: Some(ActivityState::Failed),
                    page: 1,
                    page_size: 10,
                })
                .await
                .unwrap();
            assert!(matches!(
                page.items.as_slice(),
                [ActivitySource::Analysis {
                    run,
                    retryable: false,
                    ..
                }] if run.id == run_id
            ));
        }
    }

    #[tokio::test]
    async fn completed_analysis_activity_loses_result_availability_when_projection_is_deleted() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = uuid::Uuid::new_v4();
        storage
            .put_demo(analysis_demo(
                demo_id,
                vibe_cs_domain::DemoStatus::Discovered,
            ))
            .await
            .unwrap();
        let run_id = complete_analysis(&storage, demo_id).await;
        let query = ActivityQuery {
            search: Some(format!("analysis:{run_id}")),
            kind: Some(ActivityKind::Analysis),
            state: Some(ActivityState::Completed),
            page: 1,
            page_size: 10,
        };

        let available = storage.query_activities(query.clone()).await.unwrap();
        assert!(matches!(
            available.items.as_slice(),
            [ActivitySource::Analysis {
                run,
                result_available: true,
                ..
            }] if run.id == run_id
        ));

        assert!(storage.delete_analysis(demo_id).await.unwrap());
        let unavailable = storage.query_activities(query).await.unwrap();
        assert!(matches!(
            unavailable.items.as_slice(),
            [ActivitySource::Analysis {
                run,
                retryable: false,
                result_available: false,
                ..
            }] if run.id == run_id
        ));
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
