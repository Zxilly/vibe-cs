use chrono::Utc;
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use uuid::Uuid;
use vibe_cs_domain::{
    AnalysisInputFingerprint, AnalysisRun, AnalysisRunDetail, AnalysisRunEvent,
    AnalysisRunEventCode, AnalysisRunStage, AnalysisRunStatus, DemoRecord, DemoStatus,
    MatchAnalysis,
};

use super::{Storage, decode, encode, get_document, put_demo_row};
use crate::{Result, StorageError};

#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisRunClaim {
    pub run: AnalysisRun,
    pub demo: DemoRecord,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisReplaySource {
    pub run: AnalysisRun,
    pub demo: DemoRecord,
    pub analysis: MatchAnalysis,
    pub fingerprint: AnalysisInputFingerprint,
}

impl Storage {
    pub async fn start_analysis_run(&self, demo_id: Uuid) -> Result<AnalysisRunClaim> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(mut demo) = get_document::<DemoRecord>(&transaction, "demos", demo_id)? else {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::NotFound(
                    "demo".to_owned(),
                )));
            };
            if demo.status == DemoStatus::Missing {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "restore and rescan the Demo before starting analysis".to_owned(),
                )));
            }
            if let Some(run) = transaction
                .query_row(
                    "SELECT document_json FROM analysis_runs \
                     WHERE demo_id = ?1 AND status IN ('queued', 'running') \
                     ORDER BY created_at DESC, id ASC LIMIT 1",
                    [demo_id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .map(|document| decode::<AnalysisRun>(&document))
                .transpose()?
            {
                transaction.commit()?;
                return Ok(AnalysisRunClaim {
                    run,
                    demo,
                    created: false,
                });
            }
            if matches!(demo.status, DemoStatus::Indexing | DemoStatus::Analyzing) {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "analysis cannot start from the Demo's current lifecycle state".to_owned(),
                )));
            }
            let completed = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM analyses WHERE demo_id = ?1)",
                [demo_id.to_string()],
                |row| row.get::<_, bool>(0),
            )?;
            if completed {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "demo analysis is already completed".to_owned(),
                )));
            }

            let now = Utc::now();
            let run = AnalysisRun {
                id: Uuid::new_v4(),
                demo_id,
                input_sha256: None,
                input_size: None,
                status: AnalysisRunStatus::Queued,
                stage: AnalysisRunStage::ValidatingInput,
                error: None,
                created_at: now,
                updated_at: now,
            };
            let event = AnalysisRunEvent {
                run_id: run.id,
                sequence: 0,
                stage: run.stage,
                message_code: AnalysisRunEventCode::InputValidationStarted,
                detail: None,
                created_at: now,
            };
            put_analysis_run_row(&transaction, &run)?;
            put_analysis_run_event_row(&transaction, &event)?;
            demo.status = DemoStatus::Analyzing;
            demo.updated_at = now;
            put_demo_row(&transaction, &demo)?;
            transaction.commit()?;
            Ok(AnalysisRunClaim {
                run,
                demo,
                created: true,
            })
        })
        .await
    }

    pub async fn get_analysis_run(&self, run_id: Uuid) -> Result<Option<AnalysisRunDetail>> {
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let detail = analysis_run_detail(&transaction, run_id)?;
            transaction.commit()?;
            Ok(detail)
        })
        .await
    }

    /// Returns only the result produced by this exact durable attempt.
    pub async fn get_analysis_for_run(&self, run_id: Uuid) -> Result<Option<MatchAnalysis>> {
        self.run(move |connection| {
            connection
                .query_row(
                    "SELECT analysis.document_json \
                     FROM analyses AS analysis \
                     INNER JOIN analysis_runs AS run \
                         ON run.id = analysis.producer_run_id \
                        AND run.demo_id = analysis.demo_id \
                     WHERE run.id = ?1",
                    [run_id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .map(|document| decode(&document))
                .transpose()
        })
        .await
    }

    /// Reads the exact completed producer, its result, and the current Demo in one snapshot.
    pub async fn get_analysis_replay_source(
        &self,
        run_id: Uuid,
    ) -> Result<Option<AnalysisReplaySource>> {
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let Some(run) = get_document::<AnalysisRun>(&transaction, "analysis_runs", run_id)?
            else {
                transaction.commit()?;
                return Ok(None);
            };
            if run.status != AnalysisRunStatus::Completed {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "round replay requires a completed analysis run".to_owned(),
                )));
            }
            let analysis = transaction
                .query_row(
                    "SELECT analysis.document_json FROM analyses AS analysis \
                     WHERE analysis.demo_id = ?1 AND analysis.producer_run_id = ?2",
                    params![run.demo_id.to_string(), run.id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .map(|document| decode::<MatchAnalysis>(&document))
                .transpose()?
                .ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::DependencyUnavailable(
                        "analysis run result is no longer current".to_owned(),
                    ))
                })?;
            let demo = get_document::<DemoRecord>(&transaction, "demos", run.demo_id)?.ok_or_else(
                || {
                    StorageError::Domain(vibe_cs_domain::DomainError::DependencyUnavailable(
                        "analysis Demo is no longer available".to_owned(),
                    ))
                },
            )?;
            let fingerprint = AnalysisInputFingerprint {
                sha256: run.input_sha256.clone().ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::DependencyUnavailable(
                        "analysis run input fingerprint is unavailable".to_owned(),
                    ))
                })?,
                size: run.input_size.ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::DependencyUnavailable(
                        "analysis run input size is unavailable".to_owned(),
                    ))
                })?,
            };
            if analysis.demo_id != run.demo_id
                || demo.content_sha256.as_deref() != Some(fingerprint.sha256.as_str())
                || demo.file_size != fingerprint.size
            {
                return Err(StorageError::Domain(
                    vibe_cs_domain::DomainError::DependencyUnavailable(
                        "analysis replay source is no longer current".to_owned(),
                    ),
                ));
            }
            transaction.commit()?;
            Ok(Some(AnalysisReplaySource {
                run,
                demo,
                analysis,
                fingerprint,
            }))
        })
        .await
    }

    pub async fn list_analysis_runs(&self, demo_id: Uuid) -> Result<Vec<AnalysisRun>> {
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT document_json FROM analysis_runs WHERE demo_id = ?1 \
                 ORDER BY created_at ASC, id ASC",
            )?;
            let documents = statement
                .query_map([demo_id.to_string()], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            documents
                .into_iter()
                .map(|document| decode(&document))
                .collect()
        })
        .await
    }

    pub async fn get_active_analysis_run(
        &self,
        demo_id: Uuid,
    ) -> Result<Option<AnalysisRunDetail>> {
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let run_id = transaction
                .query_row(
                    "SELECT id FROM analysis_runs \
                     WHERE demo_id = ?1 AND status IN ('queued', 'running') \
                     ORDER BY created_at DESC, id ASC LIMIT 1",
                    [demo_id.to_string()],
                    |row| {
                        let value = row.get::<_, String>(0)?;
                        Uuid::parse_str(&value).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })
                    },
                )
                .optional()?;
            let detail = run_id
                .map(|run_id| analysis_run_detail(&transaction, run_id))
                .transpose()?
                .flatten();
            transaction.commit()?;
            Ok(detail)
        })
        .await
    }

    pub async fn bind_analysis_run_input(
        &self,
        run_id: Uuid,
        fingerprint: AnalysisInputFingerprint,
    ) -> Result<AnalysisRun> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut run = get_document::<AnalysisRun>(&transaction, "analysis_runs", run_id)?
                .ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::NotFound(
                        "analysis run".to_owned(),
                    ))
                })?;
            if run.stage != AnalysisRunStage::ValidatingInput {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "analysis run is not validating its input".to_owned(),
                )));
            }
            let demo = get_document::<DemoRecord>(&transaction, "demos", run.demo_id)?.ok_or_else(
                || StorageError::Domain(vibe_cs_domain::DomainError::NotFound("demo".to_owned())),
            )?;
            let expected_sha256 = canonical_sha256(demo.content_sha256.as_deref())?;
            let actual_sha256 = canonical_sha256(Some(&fingerprint.sha256))?;
            if expected_sha256 != actual_sha256 || demo.file_size != fingerprint.size {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "analysis input no longer matches the Demo fingerprint and size".to_owned(),
                )));
            }
            run.input_sha256 = Some(actual_sha256);
            run.input_size = Some(fingerprint.size);
            transition_analysis_run(
                &transaction,
                &mut run,
                AnalysisRunEventCode::InputVerified,
                None,
            )?;
            transaction.commit()?;
            Ok(run)
        })
        .await
    }

    pub async fn mark_analysis_parser_started(&self, run_id: Uuid) -> Result<AnalysisRun> {
        self.transition_analysis_run(run_id, AnalysisRunEventCode::ParserStarted, None)
            .await
    }

    pub async fn mark_analysis_projection_started(&self, run_id: Uuid) -> Result<AnalysisRun> {
        self.transition_analysis_run(run_id, AnalysisRunEventCode::ProjectionStarted, None)
            .await
    }

    pub async fn mark_analysis_input_revalidation_started(
        &self,
        run_id: Uuid,
    ) -> Result<AnalysisRun> {
        self.transition_analysis_run(run_id, AnalysisRunEventCode::InputRevalidationStarted, None)
            .await
    }

    pub async fn complete_analysis_run(
        &self,
        run_id: Uuid,
        mut analysis: MatchAnalysis,
        observed_source_fingerprint_after_parse: AnalysisInputFingerprint,
    ) -> Result<AnalysisRun> {
        let has_stable_team_continuity = analysis.normalize_team_continuity();
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut run = get_document::<AnalysisRun>(&transaction, "analysis_runs", run_id)?
                .ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::NotFound(
                        "analysis run".to_owned(),
                    ))
                })?;
            if run.stage != AnalysisRunStage::Projecting || analysis.demo_id != run.demo_id {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "analysis result does not belong to the running attempt".to_owned(),
                )));
            }
            let expected_sha256 = canonical_sha256(run.input_sha256.as_deref())?;
            let observed_sha256 =
                canonical_sha256(Some(&observed_source_fingerprint_after_parse.sha256))?;
            if expected_sha256 != observed_sha256
                || run.input_size != Some(observed_source_fingerprint_after_parse.size)
            {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "analysis input changed while the parser was running".to_owned(),
                )));
            }
            let Some(mut demo) = get_document::<DemoRecord>(&transaction, "demos", run.demo_id)?
            else {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::NotFound(
                    "demo".to_owned(),
                )));
            };
            if demo.status != DemoStatus::Analyzing {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "analysis attempt no longer owns the Demo lifecycle".to_owned(),
                )));
            }
            if canonical_sha256(demo.content_sha256.as_deref())? != observed_sha256
                || demo.file_size != observed_source_fingerprint_after_parse.size
            {
                return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                    "analysis input no longer matches the current Demo record".to_owned(),
                )));
            }
            super::players::validate_player_match_projection(&analysis)?;

            let total_rounds = u32::try_from(analysis.rounds.len()).map_err(|_| {
                StorageError::IntegerOutOfRange(
                    u64::try_from(analysis.rounds.len()).unwrap_or(u64::MAX),
                )
            })?;
            demo.status = DemoStatus::Ready;
            demo.map_name = Some(analysis.map_name.clone());
            demo.duration_seconds = Some(analysis.duration_seconds);
            demo.total_rounds = Some(total_rounds);
            demo.player_names = analysis
                .players
                .iter()
                .map(|player| player.name.trim())
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .collect();
            demo.player_names.sort();
            demo.player_names.dedup();
            demo.player_names
                .truncate(vibe_cs_domain::MAX_DEMO_PLAYER_SUMMARY_NAMES);
            if has_stable_team_continuity {
                demo.team_a_name = analysis.teams.first().map(|team| team.name.clone());
                demo.team_b_name = analysis.teams.get(1).map(|team| team.name.clone());
                demo.team_a_score = analysis.teams.first().map(|team| team.score);
                demo.team_b_score = analysis.teams.get(1).map(|team| team.score);
            } else {
                demo.team_a_name = None;
                demo.team_b_name = None;
                demo.team_a_score = None;
                demo.team_b_score = None;
            }
            let completed_at = Utc::now();
            demo.updated_at = completed_at;
            transition_analysis_run(
                &transaction,
                &mut run,
                AnalysisRunEventCode::Completed,
                None,
            )?;
            transaction.execute(
                "INSERT INTO analyses(\
                    demo_id, producer_run_id, producer_status, document_json, updated_at\
                 ) VALUES (?1, ?2, 'completed', ?3, ?4)",
                params![
                    analysis.demo_id.to_string(),
                    run.id.to_string(),
                    encode(&analysis)?,
                    completed_at.to_rfc3339(),
                ],
            )?;
            super::replace_evidence_projection(
                &transaction,
                &analysis,
                &completed_at.to_rfc3339(),
            )?;
            super::players::replace_player_match_projection(
                &transaction,
                &analysis,
                &completed_at.to_rfc3339(),
            )?;
            put_demo_row(&transaction, &demo)?;
            transaction.commit()?;
            Ok(run)
        })
        .await
    }

    pub async fn fail_analysis_run(&self, run_id: Uuid, error: String) -> Result<AnalysisRun> {
        let error = bounded_terminal_detail(&error, "analysis failed");
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut run = get_document::<AnalysisRun>(&transaction, "analysis_runs", run_id)?
                .ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::NotFound(
                        "analysis run".to_owned(),
                    ))
                })?;
            transition_analysis_run(
                &transaction,
                &mut run,
                AnalysisRunEventCode::Failed,
                Some(error),
            )?;
            let mut demo = get_document::<DemoRecord>(&transaction, "demos", run.demo_id)?
                .ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::NotFound("demo".to_owned()))
                })?;
            if demo.status == DemoStatus::Analyzing {
                demo.status = DemoStatus::Failed;
                demo.updated_at = run.updated_at;
                put_demo_row(&transaction, &demo)?;
            }
            transaction.commit()?;
            Ok(run)
        })
        .await
    }

    pub async fn cancel_analysis_run(&self, run_id: Uuid) -> Result<AnalysisRun> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut run = get_document::<AnalysisRun>(&transaction, "analysis_runs", run_id)?
                .ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::NotFound(
                        "analysis run".to_owned(),
                    ))
                })?;
            if run.status == AnalysisRunStatus::Cancelled {
                transaction.commit()?;
                return Ok(run);
            }
            transition_analysis_run(
                &transaction,
                &mut run,
                AnalysisRunEventCode::Cancelled,
                Some("analysis_cancelled_by_user".to_owned()),
            )?;
            let mut demo = get_document::<DemoRecord>(&transaction, "demos", run.demo_id)?
                .ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::NotFound("demo".to_owned()))
                })?;
            if demo.status == DemoStatus::Analyzing {
                demo.status = DemoStatus::Discovered;
                demo.updated_at = run.updated_at;
                put_demo_row(&transaction, &demo)?;
            }
            transaction.commit()?;
            Ok(run)
        })
        .await
    }

    pub async fn recover_orphaned_analysis_runs(&self) -> Result<u64> {
        self.run(|connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let documents = {
                let mut statement = transaction.prepare(
                    "SELECT document_json FROM analysis_runs \
                     WHERE status IN ('queued', 'running') ORDER BY created_at ASC, id ASC",
                )?;
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut runs = documents
                .into_iter()
                .map(|document| decode::<AnalysisRun>(&document))
                .collect::<Result<Vec<_>>>()?;
            for run in &mut runs {
                transition_analysis_run(
                    &transaction,
                    run,
                    AnalysisRunEventCode::Interrupted,
                    Some("analysis_interrupted_by_restart".to_owned()),
                )?;
                let mut demo = get_document::<DemoRecord>(&transaction, "demos", run.demo_id)?
                    .ok_or_else(|| {
                        StorageError::Domain(vibe_cs_domain::DomainError::NotFound(
                            "demo".to_owned(),
                        ))
                    })?;
                if demo.status == DemoStatus::Analyzing {
                    demo.status = DemoStatus::Failed;
                    demo.updated_at = run.updated_at;
                    put_demo_row(&transaction, &demo)?;
                }
            }
            transaction.commit()?;
            u64::try_from(runs.len()).map_err(|_| StorageError::IntegerOutOfRange(u64::MAX))
        })
        .await
    }

    /// Terminalizes demo lifecycle work that has no durable owner after startup.
    ///
    /// An active analysis run owns its `Analyzing` demo and is deliberately left
    /// alone here. Callers recover durable analysis runs first, then invoke this
    /// recovery for import/indexing work and legacy ownerless `Analyzing` rows.
    pub async fn recover_orphaned_demo_processing(&self) -> Result<u64> {
        self.run(|connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut demos = {
                let mut statement = transaction.prepare(
                    "SELECT demo.document_json FROM demos AS demo \
                     WHERE demo.status = 'indexing' \
                        OR (demo.status = 'analyzing' AND NOT EXISTS (\
                            SELECT 1 FROM analysis_runs AS run \
                            WHERE run.demo_id = demo.id \
                              AND run.status IN ('queued', 'running')\
                        ))",
                )?;
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            let recovered = u64::try_from(demos.len())
                .map_err(|_| StorageError::IntegerOutOfRange(u64::MAX))?;
            let now = Utc::now();
            for document in demos.drain(..) {
                let mut demo = decode::<DemoRecord>(&document)?;
                demo.status = DemoStatus::Failed;
                demo.updated_at = now;
                put_demo_row(&transaction, &demo)?;
            }
            transaction.commit()?;
            Ok(recovered)
        })
        .await
    }

    async fn transition_analysis_run(
        &self,
        run_id: Uuid,
        event_code: AnalysisRunEventCode,
        detail: Option<String>,
    ) -> Result<AnalysisRun> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut run = get_document::<AnalysisRun>(&transaction, "analysis_runs", run_id)?
                .ok_or_else(|| {
                    StorageError::Domain(vibe_cs_domain::DomainError::NotFound(
                        "analysis run".to_owned(),
                    ))
                })?;
            transition_analysis_run(&transaction, &mut run, event_code, detail)?;
            transaction.commit()?;
            Ok(run)
        })
        .await
    }
}

fn analysis_run_detail(
    connection: &rusqlite::Connection,
    run_id: Uuid,
) -> Result<Option<AnalysisRunDetail>> {
    let Some(run) = get_document::<AnalysisRun>(connection, "analysis_runs", run_id)? else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT document_json FROM analysis_run_events \
         WHERE run_id = ?1 ORDER BY sequence ASC",
    )?;
    let documents = statement
        .query_map([run_id.to_string()], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let events = documents
        .into_iter()
        .map(|document| decode(&document))
        .collect::<Result<Vec<_>>>()?;
    let result_available = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM analyses \
         WHERE producer_run_id = ?1 AND demo_id = ?2)",
        params![run.id.to_string(), run.demo_id.to_string()],
        |row| row.get::<_, bool>(0),
    )?;
    Ok(Some(AnalysisRunDetail {
        run,
        events,
        result_available,
    }))
}

fn canonical_sha256(value: Option<&str>) -> Result<String> {
    let value = value.ok_or_else(|| {
        StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
            "Demo has no durable SHA-256 fingerprint".to_owned(),
        ))
    })?;
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
            "Demo SHA-256 fingerprint is invalid".to_owned(),
        )));
    }
    Ok(value.to_ascii_lowercase())
}

fn bounded_terminal_detail(value: &str, fallback: &'static str) -> String {
    let trimmed = value.trim();
    let value = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    value
        .chars()
        .take(vibe_cs_domain::MAX_ANALYSIS_RUN_DETAIL_CHARS)
        .collect()
}

fn transition_analysis_run(
    transaction: &Transaction<'_>,
    run: &mut AnalysisRun,
    event_code: AnalysisRunEventCode,
    detail: Option<String>,
) -> Result<()> {
    let stage = event_code.stage();
    if !run.stage.can_transition_to(stage) {
        return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
            format!(
                "analysis run cannot transition from {:?} to {stage:?}",
                run.stage
            ),
        )));
    }
    let detail = detail.map(|value| value.chars().take(2_000).collect::<String>());
    let mut sequence = transaction.query_row(
        "SELECT COUNT(*) FROM analysis_run_events WHERE run_id = ?1",
        [run.id.to_string()],
        |row| row.get::<_, u32>(0),
    )?;
    let terminal = stage.status().is_terminal();
    if !terminal && sequence >= vibe_cs_domain::MAX_ANALYSIS_RUN_EVENTS - 1 {
        return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
            "analysis run event limit reserved its terminal event".to_owned(),
        )));
    }
    if terminal && sequence >= vibe_cs_domain::MAX_ANALYSIS_RUN_EVENTS {
        let terminal_sequence = vibe_cs_domain::MAX_ANALYSIS_RUN_EVENTS - 1;
        let removed = transaction.execute(
            "DELETE FROM analysis_run_events \
             WHERE run_id = ?1 AND sequence = ?2 \
               AND stage NOT IN ('completed', 'failed', 'interrupted', 'cancelled')",
            params![run.id.to_string(), terminal_sequence],
        )?;
        if removed != 1 {
            return Err(StorageError::Domain(vibe_cs_domain::DomainError::Conflict(
                "analysis run event capacity has no replaceable non-terminal event".to_owned(),
            )));
        }
        sequence = terminal_sequence;
    }
    let now = Utc::now();
    run.stage = stage;
    run.status = stage.status();
    run.updated_at = now;
    if matches!(
        stage,
        AnalysisRunStage::Failed | AnalysisRunStage::Interrupted
    ) {
        run.error.clone_from(&detail);
    }
    let updated = transaction.execute(
        "UPDATE analysis_runs SET input_sha256 = ?1, input_size = ?2, status = ?3, \
         stage = ?4, error = ?5, updated_at = ?6, document_json = ?7 WHERE id = ?8",
        params![
            run.input_sha256,
            run.input_size.map(super::sql_u64).transpose()?,
            analysis_run_status(run.status),
            analysis_run_stage(run.stage),
            run.error,
            run.updated_at.to_rfc3339(),
            encode(run)?,
            run.id.to_string(),
        ],
    )?;
    if updated != 1 {
        return Err(StorageError::ActivityProjection(
            "analysis run transition lost its authoritative row".to_owned(),
        ));
    }
    put_analysis_run_event_row(
        transaction,
        &AnalysisRunEvent {
            run_id: run.id,
            sequence,
            stage,
            message_code: event_code,
            detail,
            created_at: now,
        },
    )
}

fn put_analysis_run_row(transaction: &Transaction<'_>, run: &AnalysisRun) -> Result<()> {
    transaction.execute(
        "INSERT INTO analysis_runs(\
             id, demo_id, input_sha256, input_size, status, stage, error, created_at, updated_at, document_json\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            run.id.to_string(),
            run.demo_id.to_string(),
            run.input_sha256,
            run.input_size.map(super::sql_u64).transpose()?,
            analysis_run_status(run.status),
            analysis_run_stage(run.stage),
            run.error,
            run.created_at.to_rfc3339(),
            run.updated_at.to_rfc3339(),
            encode(run)?,
        ],
    )?;
    Ok(())
}

fn put_analysis_run_event_row(
    transaction: &Transaction<'_>,
    event: &AnalysisRunEvent,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO analysis_run_events(\
             run_id, sequence, stage, message_code, detail, created_at, document_json\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            event.run_id.to_string(),
            event.sequence,
            analysis_run_stage(event.stage),
            analysis_run_event_code(event.message_code),
            event.detail,
            event.created_at.to_rfc3339(),
            encode(event)?,
        ],
    )?;
    Ok(())
}

const fn analysis_run_status(status: AnalysisRunStatus) -> &'static str {
    match status {
        AnalysisRunStatus::Queued => "queued",
        AnalysisRunStatus::Running => "running",
        AnalysisRunStatus::Completed => "completed",
        AnalysisRunStatus::Failed => "failed",
        AnalysisRunStatus::Interrupted => "interrupted",
        AnalysisRunStatus::Cancelled => "cancelled",
    }
}

const fn analysis_run_stage(stage: AnalysisRunStage) -> &'static str {
    match stage {
        AnalysisRunStage::ValidatingInput => "validating_input",
        AnalysisRunStage::ParserQueued => "parser_queued",
        AnalysisRunStage::ParserRunning => "parser_running",
        AnalysisRunStage::VerifyingInputAfterParse => "verifying_input_after_parse",
        AnalysisRunStage::Projecting => "projecting",
        AnalysisRunStage::Completed => "completed",
        AnalysisRunStage::Failed => "failed",
        AnalysisRunStage::Interrupted => "interrupted",
        AnalysisRunStage::Cancelled => "cancelled",
    }
}

const fn analysis_run_event_code(code: AnalysisRunEventCode) -> &'static str {
    match code {
        AnalysisRunEventCode::InputValidationStarted => "input_validation_started",
        AnalysisRunEventCode::InputVerified => "input_verified",
        AnalysisRunEventCode::ParserStarted => "parser_started",
        AnalysisRunEventCode::InputRevalidationStarted => "input_revalidation_started",
        AnalysisRunEventCode::ProjectionStarted => "projection_started",
        AnalysisRunEventCode::Completed => "completed",
        AnalysisRunEventCode::Failed => "failed",
        AnalysisRunEventCode::Interrupted => "interrupted",
        AnalysisRunEventCode::Cancelled => "cancelled",
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use rusqlite::params;
    use uuid::Uuid;
    use vibe_cs_domain::{
        AnalysisInputFingerprint, AnalysisRunEvent, AnalysisRunEventCode, AnalysisRunStage,
        AnalysisRunStatus, DemoRecord, DemoStatus, MAX_ANALYSIS_RUN_EVENTS, MatchAnalysis,
    };

    use super::super::{Storage, encode};
    use super::put_analysis_run_event_row;

    fn demo(id: Uuid) -> DemoRecord {
        let now = Utc::now();
        DemoRecord {
            id,
            path: "C:/matches/current.dem".to_owned(),
            file_name: "current.dem".to_owned(),
            display_name: "Current match".to_owned(),
            source: "local".to_owned(),
            status: DemoStatus::Discovered,
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

    fn analysis(demo_id: Uuid) -> MatchAnalysis {
        MatchAnalysis {
            demo_id,
            map_name: "de_ancient".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 90.0,
            verified_total_ticks: Some(5_760),
            teams: Vec::new(),
            players: Vec::new(),
            rounds: Vec::new(),
            highlights: Vec::new(),
        }
    }

    async fn fill_analysis_event_capacity(storage: &Storage, run_id: Uuid, count: u32) {
        assert!((1..=MAX_ANALYSIS_RUN_EVENTS).contains(&count));
        storage
            .run(move |connection| {
                let transaction = connection.transaction()?;
                for sequence in 1..count {
                    put_analysis_run_event_row(
                        &transaction,
                        &AnalysisRunEvent {
                            run_id,
                            sequence,
                            stage: AnalysisRunStage::ValidatingInput,
                            message_code: AnalysisRunEventCode::InputValidationStarted,
                            detail: Some(format!("capacity fixture {sequence}")),
                            created_at: Utc::now(),
                        },
                    )?;
                }
                transaction.commit()?;
                Ok(())
            })
            .await
            .expect("fill analysis event capacity");
    }

    #[tokio::test]
    async fn concurrent_starts_claim_one_active_run_and_one_initial_event() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage
            .put_demos(vec![demo(demo_id)])
            .await
            .expect("put demo");

        let (first, second) = tokio::join!(
            storage.start_analysis_run(demo_id),
            storage.start_analysis_run(demo_id)
        );
        let first = first.expect("first start");
        let second = second.expect("second start");

        assert_eq!(first.run.id, second.run.id);
        assert_ne!(first.created, second.created);
        assert_eq!(first.run.status, AnalysisRunStatus::Queued);
        assert_eq!(first.run.stage, AnalysisRunStage::ValidatingInput);
        assert_eq!(first.run.input_sha256, None);
        assert_eq!(first.run.input_size, None);
        assert_eq!(first.demo.status, DemoStatus::Analyzing);

        let detail = storage
            .get_analysis_run(first.run.id)
            .await
            .expect("get run")
            .expect("stored run");
        assert_eq!(detail.events.len(), 1);
        assert_eq!(detail.events[0].sequence, 0);
        assert_eq!(
            detail.events[0].message_code,
            AnalysisRunEventCode::InputValidationStarted
        );
        assert!(!detail.result_available);
    }

    #[tokio::test]
    async fn active_lookup_returns_the_exact_active_snapshot_and_none_after_terminalization() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage.put_demo(demo(demo_id)).await.expect("put demo");
        let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage
            .bind_analysis_run_input(
                run_id,
                AnalysisInputFingerprint {
                    sha256: "a".repeat(64),
                    size: 512,
                },
            )
            .await
            .unwrap();

        let active = storage
            .get_active_analysis_run(demo_id)
            .await
            .unwrap()
            .expect("active run");
        assert_eq!(active.run.id, run_id);
        assert_eq!(active.run.stage, AnalysisRunStage::ParserQueued);
        assert_eq!(active.events.len(), 2);
        assert_eq!(
            active.events[1].message_code,
            AnalysisRunEventCode::InputVerified
        );
        assert!(!active.result_available);

        storage
            .fail_analysis_run(run_id, "fixture failure".to_owned())
            .await
            .unwrap();
        assert!(
            storage
                .get_active_analysis_run(demo_id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn verified_input_is_bound_only_at_the_parser_queue_transition() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage
            .put_demos(vec![demo(demo_id)])
            .await
            .expect("put demo");
        let claim = storage
            .start_analysis_run(demo_id)
            .await
            .expect("start run");

        let run = storage
            .bind_analysis_run_input(
                claim.run.id,
                AnalysisInputFingerprint {
                    sha256: "a".repeat(64),
                    size: 512,
                },
            )
            .await
            .expect("bind verified input");

        assert_eq!(run.input_sha256.as_deref(), Some("a".repeat(64).as_str()));
        assert_eq!(run.input_size, Some(512));
        assert_eq!(run.status, AnalysisRunStatus::Queued);
        assert_eq!(run.stage, AnalysisRunStage::ParserQueued);
        let detail = storage
            .get_analysis_run(run.id)
            .await
            .expect("get run")
            .expect("stored run");
        assert_eq!(
            detail
                .events
                .iter()
                .map(|event| (event.sequence, event.message_code))
                .collect::<Vec<_>>(),
            vec![
                (0, AnalysisRunEventCode::InputValidationStarted),
                (1, AnalysisRunEventCode::InputVerified),
            ]
        );
    }

    #[tokio::test]
    async fn start_fails_closed_for_indexing_or_orphaned_analyzing_demo() {
        for status in [DemoStatus::Indexing, DemoStatus::Analyzing] {
            let storage = Storage::open_in_memory().await.expect("open storage");
            let demo_id = Uuid::new_v4();
            let mut record = demo(demo_id);
            record.status = status;
            storage.put_demos(vec![record]).await.expect("put demo");

            let error = storage
                .start_analysis_run(demo_id)
                .await
                .expect_err("inconsistent lifecycle must not create a run");
            assert!(error.to_string().contains("cannot start"));
            assert!(
                storage
                    .list_analysis_runs(demo_id)
                    .await
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[tokio::test]
    async fn parser_started_is_an_atomic_monotonic_event_transition() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage
            .put_demos(vec![demo(demo_id)])
            .await
            .expect("put demo");
        let run_id = storage
            .start_analysis_run(demo_id)
            .await
            .expect("start")
            .run
            .id;
        storage
            .bind_analysis_run_input(
                run_id,
                AnalysisInputFingerprint {
                    sha256: "a".repeat(64),
                    size: 512,
                },
            )
            .await
            .expect("bind");

        let run = storage
            .mark_analysis_parser_started(run_id)
            .await
            .expect("parser started");
        assert_eq!(run.status, AnalysisRunStatus::Running);
        assert_eq!(run.stage, AnalysisRunStage::ParserRunning);
        assert!(storage.mark_analysis_parser_started(run_id).await.is_err());

        let detail = storage
            .get_analysis_run(run_id)
            .await
            .expect("get")
            .expect("run");
        assert_eq!(detail.events.len(), 3);
        assert_eq!(detail.events[2].sequence, 2);
        assert_eq!(
            detail.events[2].message_code,
            AnalysisRunEventCode::ParserStarted
        );
    }

    #[tokio::test]
    async fn completion_atomically_publishes_result_demo_and_attempt_events() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage
            .put_demos(vec![demo(demo_id)])
            .await
            .expect("put demo");
        let run_id = storage
            .start_analysis_run(demo_id)
            .await
            .expect("start")
            .run
            .id;
        let fingerprint = AnalysisInputFingerprint {
            sha256: "a".repeat(64),
            size: 512,
        };
        storage
            .bind_analysis_run_input(run_id, fingerprint.clone())
            .await
            .expect("bind");
        storage
            .mark_analysis_parser_started(run_id)
            .await
            .expect("parser started");
        storage
            .mark_analysis_input_revalidation_started(run_id)
            .await
            .expect("input revalidation started");
        let projecting = storage
            .mark_analysis_projection_started(run_id)
            .await
            .expect("projection started");
        assert_eq!(projecting.stage, AnalysisRunStage::Projecting);
        assert_eq!(
            storage
                .get_analysis_run(run_id)
                .await
                .unwrap()
                .unwrap()
                .run
                .stage,
            AnalysisRunStage::Projecting
        );

        let run = storage
            .complete_analysis_run(run_id, analysis(demo_id), fingerprint)
            .await
            .expect("complete run");

        assert_eq!(run.status, AnalysisRunStatus::Completed);
        assert_eq!(run.stage, AnalysisRunStage::Completed);
        assert_eq!(
            storage.get_demo(demo_id).await.unwrap().unwrap().status,
            DemoStatus::Ready
        );
        assert!(storage.get_analysis(demo_id).await.unwrap().is_some());
        let detail = storage.get_analysis_run(run_id).await.unwrap().unwrap();
        assert!(detail.result_available);
        assert_eq!(
            detail
                .events
                .iter()
                .map(|event| event.message_code)
                .collect::<Vec<_>>(),
            vec![
                AnalysisRunEventCode::InputValidationStarted,
                AnalysisRunEventCode::InputVerified,
                AnalysisRunEventCode::ParserStarted,
                AnalysisRunEventCode::InputRevalidationStarted,
                AnalysisRunEventCode::ProjectionStarted,
                AnalysisRunEventCode::Completed,
            ]
        );
    }

    #[tokio::test]
    async fn database_rejects_analysis_rows_from_noncompleted_producer_runs() {
        for terminal_failure in [false, true] {
            let storage = Storage::open_in_memory().await.expect("open storage");
            let demo_id = Uuid::new_v4();
            storage.put_demo(demo(demo_id)).await.expect("put demo");
            let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
            if terminal_failure {
                storage
                    .fail_analysis_run(run_id, "fixture failure".to_owned())
                    .await
                    .unwrap();
            }
            let document = encode(&analysis(demo_id)).unwrap();
            let error = storage
                .run(move |connection| {
                    connection.execute(
                        "INSERT INTO analyses(\
                             demo_id, producer_run_id, producer_status, document_json, updated_at\
                         ) VALUES (?1, ?2, 'completed', ?3, ?4)",
                        params![
                            demo_id.to_string(),
                            run_id.to_string(),
                            document,
                            Utc::now().to_rfc3339(),
                        ],
                    )?;
                    Ok(())
                })
                .await
                .expect_err("only a completed producer may publish an analysis row");
            assert!(
                error.to_string().contains("FOREIGN KEY constraint failed"),
                "unexpected invariant error: {error}"
            );
        }
    }

    #[tokio::test]
    async fn validation_failure_is_persisted_without_inventing_an_input_binding() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage
            .put_demos(vec![demo(demo_id)])
            .await
            .expect("put demo");
        let run_id = storage
            .start_analysis_run(demo_id)
            .await
            .expect("start")
            .run
            .id;

        let run = storage
            .fail_analysis_run(run_id, "input fingerprint did not match".to_owned())
            .await
            .expect("fail run");

        assert_eq!(run.status, AnalysisRunStatus::Failed);
        assert_eq!(run.stage, AnalysisRunStage::Failed);
        assert_eq!(run.input_sha256, None);
        assert_eq!(run.input_size, None);
        assert_eq!(
            storage.get_demo(demo_id).await.unwrap().unwrap().status,
            DemoStatus::Failed
        );
        assert!(storage.get_analysis(demo_id).await.unwrap().is_none());
        let detail = storage.get_analysis_run(run_id).await.unwrap().unwrap();
        assert_eq!(detail.events.len(), 2);
        assert_eq!(detail.events[1].sequence, 1);
        assert_eq!(detail.events[1].message_code, AnalysisRunEventCode::Failed);
        assert_eq!(
            detail.events[1].detail.as_deref(),
            Some("input fingerprint did not match")
        );
        assert!(!detail.result_available);
    }

    #[tokio::test]
    async fn cancelling_an_analysis_run_persists_a_non_failure_terminal_state() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage.put_demo(demo(demo_id)).await.expect("put demo");
        let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;

        let run = storage
            .cancel_analysis_run(run_id)
            .await
            .expect("cancel run");

        assert_eq!(run.status, AnalysisRunStatus::Cancelled);
        assert_eq!(run.stage, AnalysisRunStage::Cancelled);
        assert_eq!(run.error, None);
        assert_eq!(
            storage.get_demo(demo_id).await.unwrap().unwrap().status,
            DemoStatus::Discovered
        );
        let detail = storage.get_analysis_run(run_id).await.unwrap().unwrap();
        assert_eq!(detail.events.len(), 2);
        assert_eq!(
            detail.events[1].message_code,
            AnalysisRunEventCode::Cancelled
        );
        assert_eq!(
            detail.events[1].detail.as_deref(),
            Some("analysis_cancelled_by_user")
        );
        assert!(!detail.result_available);
        assert!(
            storage
                .get_analysis_for_run(run_id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn cancelling_an_already_cancelled_exact_run_is_idempotent() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage.put_demo(demo(demo_id)).await.expect("put demo");
        let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        let first = storage.cancel_analysis_run(run_id).await.unwrap();

        let repeated = storage
            .cancel_analysis_run(run_id)
            .await
            .expect("repeat exact cancellation");

        assert_eq!(repeated, first);
        let detail = storage.get_analysis_run(run_id).await.unwrap().unwrap();
        assert_eq!(detail.events.len(), 2);
        assert_eq!(
            detail.events.last().unwrap().message_code,
            AnalysisRunEventCode::Cancelled
        );
    }

    #[tokio::test]
    async fn terminal_transitions_keep_an_exact_event_at_the_event_capacity_boundary() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let cancel_reserved_demo = Uuid::new_v4();
        let cancel_full_demo = Uuid::new_v4();
        let fail_full_demo = Uuid::new_v4();
        let interrupt_full_demo = Uuid::new_v4();
        storage
            .put_demos(
                [
                    cancel_reserved_demo,
                    cancel_full_demo,
                    fail_full_demo,
                    interrupt_full_demo,
                ]
                .into_iter()
                .enumerate()
                .map(|(index, id)| {
                    let mut record = demo(id);
                    record.path = format!("C:/matches/capacity-{index}.dem");
                    record.file_name = format!("capacity-{index}.dem");
                    record.content_sha256 = Some(format!("{index:064x}"));
                    record
                })
                .collect(),
            )
            .await
            .expect("put demos");

        let cancel_reserved = storage
            .start_analysis_run(cancel_reserved_demo)
            .await
            .unwrap()
            .run;
        fill_analysis_event_capacity(&storage, cancel_reserved.id, 31).await;
        assert!(
            storage
                .bind_analysis_run_input(
                    cancel_reserved.id,
                    AnalysisInputFingerprint {
                        sha256: "0".repeat(64),
                        size: 512,
                    },
                )
                .await
                .is_err(),
            "non-terminal progress must reserve the terminal event slot"
        );
        storage
            .cancel_analysis_run(cancel_reserved.id)
            .await
            .expect("cancel at reserved boundary");

        let cancel_full = storage
            .start_analysis_run(cancel_full_demo)
            .await
            .unwrap()
            .run;
        fill_analysis_event_capacity(&storage, cancel_full.id, 32).await;
        storage
            .cancel_analysis_run(cancel_full.id)
            .await
            .expect("cancel a legacy full-capacity run");

        let fail_full = storage
            .start_analysis_run(fail_full_demo)
            .await
            .unwrap()
            .run;
        fill_analysis_event_capacity(&storage, fail_full.id, 32).await;
        storage
            .fail_analysis_run(fail_full.id, "parser failed".to_owned())
            .await
            .expect("fail a legacy full-capacity run");

        let interrupt_full = storage
            .start_analysis_run(interrupt_full_demo)
            .await
            .unwrap()
            .run;
        fill_analysis_event_capacity(&storage, interrupt_full.id, 32).await;
        assert_eq!(storage.recover_orphaned_analysis_runs().await.unwrap(), 1);

        for (run_id, expected) in [
            (cancel_reserved.id, AnalysisRunEventCode::Cancelled),
            (cancel_full.id, AnalysisRunEventCode::Cancelled),
            (fail_full.id, AnalysisRunEventCode::Failed),
            (interrupt_full.id, AnalysisRunEventCode::Interrupted),
        ] {
            let detail = storage.get_analysis_run(run_id).await.unwrap().unwrap();
            assert_eq!(detail.events.len(), MAX_ANALYSIS_RUN_EVENTS as usize);
            assert_eq!(detail.events.last().unwrap().sequence, 31);
            assert_eq!(detail.events.last().unwrap().message_code, expected);
            assert_eq!(
                detail
                    .events
                    .iter()
                    .filter(|event| event.message_code == expected)
                    .count(),
                1,
                "terminal event must be unique"
            );
        }
    }

    #[tokio::test]
    async fn latest_cancelled_analysis_attempt_can_be_retried_without_mutating_history() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage.put_demo(demo(demo_id)).await.expect("put demo");
        let cancelled = storage.start_analysis_run(demo_id).await.unwrap().run;
        storage.cancel_analysis_run(cancelled.id).await.unwrap();

        let retry = storage
            .start_analysis_run(demo_id)
            .await
            .expect("retry cancelled attempt");

        assert!(retry.created);
        assert_ne!(retry.run.id, cancelled.id);
        assert_eq!(retry.run.status, AnalysisRunStatus::Queued);
        let history = storage.list_analysis_runs(demo_id).await.unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].id, cancelled.id);
        assert_eq!(history[0].status, AnalysisRunStatus::Cancelled);
        assert_eq!(history[1].id, retry.run.id);
    }

    #[tokio::test]
    async fn cancelling_preserves_demo_lifecycle_and_fingerprint_changed_by_an_external_owner() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        for (index, external_status) in [DemoStatus::Missing, DemoStatus::Discovered]
            .into_iter()
            .enumerate()
        {
            let demo_id = Uuid::new_v4();
            let mut record = demo(demo_id);
            record.path = format!("C:/matches/external-{index}.dem");
            record.file_name = format!("external-{index}.dem");
            record.content_sha256 = Some(format!("{index:064x}"));
            storage.put_demo(record).await.expect("put demo");
            let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
            let mut external = storage.get_demo(demo_id).await.unwrap().unwrap();
            external.status = external_status;
            external.content_sha256 = Some(format!("{:064x}", index + 10));
            external.file_size += 1_024;
            storage
                .put_demo(external.clone())
                .await
                .expect("external update");

            storage
                .cancel_analysis_run(run_id)
                .await
                .expect("cancel exact run");

            let current = storage.get_demo(demo_id).await.unwrap().unwrap();
            assert_eq!(current.status, external_status);
            assert_eq!(current.content_sha256, external.content_sha256);
            assert_eq!(current.file_size, external.file_size);
        }
    }

    #[tokio::test]
    async fn startup_recovery_is_a_noop_for_cancelled_attempts() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage.put_demo(demo(demo_id)).await.expect("put demo");
        let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage.cancel_analysis_run(run_id).await.unwrap();
        let before = storage.get_analysis_run(run_id).await.unwrap().unwrap();

        assert_eq!(storage.recover_orphaned_analysis_runs().await.unwrap(), 0);

        let after = storage.get_analysis_run(run_id).await.unwrap().unwrap();
        assert_eq!(after, before);
        assert_eq!(after.run.status, AnalysisRunStatus::Cancelled);
        assert_eq!(
            after.events.last().unwrap().message_code,
            AnalysisRunEventCode::Cancelled
        );
    }

    #[tokio::test]
    async fn cancel_complete_and_fail_races_commit_one_exact_terminal_event() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let complete_demo_id = Uuid::new_v4();
        let fail_demo_id = Uuid::new_v4();
        let mut complete_demo = demo(complete_demo_id);
        complete_demo.path = "C:/matches/complete-race.dem".to_owned();
        complete_demo.file_name = "complete-race.dem".to_owned();
        complete_demo.content_sha256 = Some("c".repeat(64));
        let mut fail_demo = demo(fail_demo_id);
        fail_demo.path = "C:/matches/fail-race.dem".to_owned();
        fail_demo.file_name = "fail-race.dem".to_owned();
        fail_demo.content_sha256 = Some("f".repeat(64));
        storage
            .put_demos(vec![complete_demo, fail_demo])
            .await
            .unwrap();

        let complete_run = storage
            .start_analysis_run(complete_demo_id)
            .await
            .unwrap()
            .run;
        let complete_fingerprint = AnalysisInputFingerprint {
            sha256: "c".repeat(64),
            size: 512,
        };
        storage
            .bind_analysis_run_input(complete_run.id, complete_fingerprint.clone())
            .await
            .unwrap();
        storage
            .mark_analysis_parser_started(complete_run.id)
            .await
            .unwrap();
        storage
            .mark_analysis_input_revalidation_started(complete_run.id)
            .await
            .unwrap();
        storage
            .mark_analysis_projection_started(complete_run.id)
            .await
            .unwrap();
        let (completed, cancelled) = tokio::join!(
            storage.complete_analysis_run(
                complete_run.id,
                analysis(complete_demo_id),
                complete_fingerprint,
            ),
            storage.cancel_analysis_run(complete_run.id),
        );
        assert_ne!(completed.is_ok(), cancelled.is_ok());
        let complete_detail = storage
            .get_analysis_run(complete_run.id)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            complete_detail.run.status,
            AnalysisRunStatus::Completed | AnalysisRunStatus::Cancelled
        ));
        assert_eq!(
            complete_detail
                .events
                .iter()
                .filter(|event| event.stage.is_terminal())
                .count(),
            1
        );
        assert_eq!(
            complete_detail.result_available,
            complete_detail.run.status == AnalysisRunStatus::Completed
        );

        let fail_run = storage.start_analysis_run(fail_demo_id).await.unwrap().run;
        let (failed, cancelled) = tokio::join!(
            storage.fail_analysis_run(fail_run.id, "parser failed".to_owned()),
            storage.cancel_analysis_run(fail_run.id),
        );
        assert_ne!(failed.is_ok(), cancelled.is_ok());
        let fail_detail = storage
            .get_analysis_run(fail_run.id)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            fail_detail.run.status,
            AnalysisRunStatus::Failed | AnalysisRunStatus::Cancelled
        ));
        assert_eq!(
            fail_detail
                .events
                .iter()
                .filter(|event| event.stage.is_terminal())
                .count(),
            1
        );
        assert!(!fail_detail.result_available);
    }

    #[tokio::test]
    async fn startup_recovery_interrupts_every_nonterminal_attempt_and_its_demo() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let validating_id = Uuid::new_v4();
        let parsing_id = Uuid::new_v4();
        let mut validating_demo = demo(validating_id);
        validating_demo.path = "C:/matches/validating.dem".to_owned();
        validating_demo.content_sha256 = Some("b".repeat(64));
        let mut parsing_demo = demo(parsing_id);
        parsing_demo.path = "C:/matches/parsing.dem".to_owned();
        storage
            .put_demos(vec![validating_demo, parsing_demo])
            .await
            .expect("put demos");
        let validating_run = storage.start_analysis_run(validating_id).await.unwrap().run;
        let parsing_run = storage.start_analysis_run(parsing_id).await.unwrap().run;
        storage
            .bind_analysis_run_input(
                parsing_run.id,
                AnalysisInputFingerprint {
                    sha256: "a".repeat(64),
                    size: 512,
                },
            )
            .await
            .unwrap();
        storage
            .mark_analysis_parser_started(parsing_run.id)
            .await
            .unwrap();

        assert_eq!(storage.recover_orphaned_analysis_runs().await.unwrap(), 2);

        for (demo_id, run_id) in [
            (validating_id, validating_run.id),
            (parsing_id, parsing_run.id),
        ] {
            let detail = storage.get_analysis_run(run_id).await.unwrap().unwrap();
            assert_eq!(detail.run.status, AnalysisRunStatus::Interrupted);
            assert_eq!(detail.run.stage, AnalysisRunStage::Interrupted);
            assert_eq!(
                detail.events.last().unwrap().message_code,
                AnalysisRunEventCode::Interrupted
            );
            assert_eq!(
                storage.get_demo(demo_id).await.unwrap().unwrap().status,
                DemoStatus::Failed
            );
        }
        assert_eq!(storage.recover_orphaned_analysis_runs().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn startup_recovery_terminalizes_only_demo_processing_without_a_durable_owner() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let indexing_id = Uuid::new_v4();
        let orphaned_analyzing_id = Uuid::new_v4();
        let owned_analyzing_id = Uuid::new_v4();
        let ready_id = Uuid::new_v4();
        let records = [
            (indexing_id, DemoStatus::Indexing),
            (orphaned_analyzing_id, DemoStatus::Analyzing),
            (owned_analyzing_id, DemoStatus::Discovered),
            (ready_id, DemoStatus::Ready),
        ]
        .into_iter()
        .map(|(id, status)| {
            let mut record = demo(id);
            record.path = format!("C:/matches/{id}.dem");
            record.content_sha256 = Some(hex::encode(id.as_bytes()).repeat(2));
            record.status = status;
            record
        })
        .collect::<Vec<_>>();
        storage.put_demos(records).await.expect("put demos");
        storage
            .start_analysis_run(owned_analyzing_id)
            .await
            .expect("owned analysis run");

        assert_eq!(storage.recover_orphaned_demo_processing().await.unwrap(), 2);
        assert_eq!(
            storage.get_demo(indexing_id).await.unwrap().unwrap().status,
            DemoStatus::Failed
        );
        assert_eq!(
            storage
                .get_demo(orphaned_analyzing_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            DemoStatus::Failed
        );
        assert_eq!(
            storage
                .get_demo(owned_analyzing_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            DemoStatus::Analyzing
        );
        assert_eq!(
            storage.get_demo(ready_id).await.unwrap().unwrap().status,
            DemoStatus::Ready
        );
    }

    #[tokio::test]
    async fn result_availability_is_bound_to_the_exact_producer_attempt() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage.put_demo(demo(demo_id)).await.expect("put demo");
        let fingerprint = AnalysisInputFingerprint {
            sha256: "a".repeat(64),
            size: 512,
        };

        let first_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage
            .bind_analysis_run_input(first_id, fingerprint.clone())
            .await
            .unwrap();
        storage
            .mark_analysis_parser_started(first_id)
            .await
            .unwrap();
        storage
            .mark_analysis_input_revalidation_started(first_id)
            .await
            .unwrap();
        storage
            .mark_analysis_projection_started(first_id)
            .await
            .unwrap();
        storage
            .complete_analysis_run(first_id, analysis(demo_id), fingerprint.clone())
            .await
            .unwrap();
        assert!(
            storage
                .get_analysis_run(first_id)
                .await
                .unwrap()
                .unwrap()
                .result_available
        );

        assert!(storage.delete_analysis(demo_id).await.unwrap());
        assert!(
            !storage
                .get_analysis_run(first_id)
                .await
                .unwrap()
                .unwrap()
                .result_available
        );
        let second_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage
            .bind_analysis_run_input(second_id, fingerprint.clone())
            .await
            .unwrap();
        storage
            .mark_analysis_parser_started(second_id)
            .await
            .unwrap();
        storage
            .mark_analysis_input_revalidation_started(second_id)
            .await
            .unwrap();
        storage
            .mark_analysis_projection_started(second_id)
            .await
            .unwrap();
        storage
            .complete_analysis_run(second_id, analysis(demo_id), fingerprint)
            .await
            .unwrap();

        assert!(
            !storage
                .get_analysis_run(first_id)
                .await
                .unwrap()
                .unwrap()
                .result_available
        );
        assert!(
            storage
                .get_analysis_run(second_id)
                .await
                .unwrap()
                .unwrap()
                .result_available
        );
        assert_eq!(
            storage
                .get_analysis_for_run(second_id)
                .await
                .unwrap()
                .unwrap()
                .demo_id,
            demo_id
        );
        assert!(
            storage
                .get_analysis_for_run(first_id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn changed_input_cannot_publish_an_analysis_projection() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage.put_demo(demo(demo_id)).await.expect("put demo");
        let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage
            .bind_analysis_run_input(
                run_id,
                AnalysisInputFingerprint {
                    sha256: "a".repeat(64),
                    size: 512,
                },
            )
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

        let error = storage
            .complete_analysis_run(
                run_id,
                analysis(demo_id),
                AnalysisInputFingerprint {
                    sha256: "b".repeat(64),
                    size: 512,
                },
            )
            .await
            .expect_err("changed input must fail closed");

        assert!(error.to_string().contains("changed"));
        assert!(storage.get_analysis(demo_id).await.unwrap().is_none());
        assert!(
            !storage
                .get_analysis_run(run_id)
                .await
                .unwrap()
                .unwrap()
                .result_available
        );
    }

    #[tokio::test]
    async fn terminalizing_a_run_preserves_a_concurrent_missing_demo_truth() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage.put_demo(demo(demo_id)).await.expect("put demo");
        let failed_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage
            .set_demo_status(demo_id, DemoStatus::Missing)
            .await
            .unwrap();
        storage
            .fail_analysis_run(failed_id, "source disappeared".to_owned())
            .await
            .unwrap();
        assert_eq!(
            storage.get_demo(demo_id).await.unwrap().unwrap().status,
            DemoStatus::Missing
        );

        storage
            .set_demo_status(demo_id, DemoStatus::Discovered)
            .await
            .unwrap();
        let interrupted_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage
            .set_demo_status(demo_id, DemoStatus::Missing)
            .await
            .unwrap();
        storage.recover_orphaned_analysis_runs().await.unwrap();
        assert_eq!(
            storage.get_demo(demo_id).await.unwrap().unwrap().status,
            DemoStatus::Missing
        );
        assert_eq!(
            storage
                .get_analysis_run(interrupted_id)
                .await
                .unwrap()
                .unwrap()
                .run
                .status,
            AnalysisRunStatus::Interrupted
        );
    }

    #[tokio::test]
    async fn terminalizing_an_old_attempt_preserves_a_new_discovered_input() {
        for interrupted in [false, true] {
            let storage = Storage::open_in_memory().await.expect("open storage");
            let demo_id = Uuid::new_v4();
            storage.put_demo(demo(demo_id)).await.expect("put demo");
            let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
            let mut changed = storage.get_demo(demo_id).await.unwrap().unwrap();
            changed.status = DemoStatus::Discovered;
            changed.content_sha256 = Some("b".repeat(64));
            changed.file_size = 1_024;
            storage.put_demo(changed).await.unwrap();

            if interrupted {
                storage.recover_orphaned_analysis_runs().await.unwrap();
            } else {
                storage
                    .fail_analysis_run(run_id, "old attempt failed".to_owned())
                    .await
                    .unwrap();
            }

            let current = storage.get_demo(demo_id).await.unwrap().unwrap();
            assert_eq!(current.status, DemoStatus::Discovered);
            assert_eq!(
                current.content_sha256.as_deref(),
                Some("b".repeat(64).as_str())
            );
            assert_eq!(current.file_size, 1_024);
        }
    }

    #[tokio::test]
    async fn completion_cannot_overwrite_an_external_demo_lifecycle_change() {
        for status in [DemoStatus::Missing, DemoStatus::Discovered] {
            let storage = Storage::open_in_memory().await.expect("open storage");
            let demo_id = Uuid::new_v4();
            storage.put_demo(demo(demo_id)).await.expect("put demo");
            let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
            let fingerprint = AnalysisInputFingerprint {
                sha256: "a".repeat(64),
                size: 512,
            };
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
            storage.set_demo_status(demo_id, status).await.unwrap();

            let error = storage
                .complete_analysis_run(run_id, analysis(demo_id), fingerprint)
                .await
                .expect_err("external lifecycle must win");

            assert!(error.to_string().contains("no longer owns"));
            assert_eq!(
                storage.get_demo(demo_id).await.unwrap().unwrap().status,
                status
            );
            assert!(storage.get_analysis(demo_id).await.unwrap().is_none());
        }
    }
}
