use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension as _, Transaction, TransactionBehavior, params};
use uuid::Uuid;
use vibe_cs_domain::{
    DomainError, MatchAnalysis, PlayerReviewMetadata, ReviewMetadataUpdate, ReviewTag,
    ReviewTagCreate, RoundReviewMetadata, is_canonical_review_steam64, is_review_source_sha256,
};

use super::{Storage, parse_repository_datetime, read_demo_tag};
use crate::{Result, StorageError};

impl Storage {
    pub async fn create_review_tag(&self, input: ReviewTagCreate) -> Result<ReviewTag> {
        self.create_demo_tag(input).await
    }

    pub async fn list_review_tags(&self) -> Result<Vec<ReviewTag>> {
        self.list_demo_tags().await
    }

    pub async fn update_review_tag(
        &self,
        id: Uuid,
        input: ReviewTagCreate,
    ) -> Result<Option<ReviewTag>> {
        self.update_demo_tag(id, input).await
    }

    pub async fn delete_review_tag(&self, id: Uuid) -> Result<bool> {
        self.delete_demo_tag(id).await
    }

    pub async fn get_player_review_metadata(
        &self,
        steam_id: String,
    ) -> Result<Option<PlayerReviewMetadata>> {
        validate_player_review_id(&steam_id)?;
        self.run(move |connection| read_player_metadata(connection, &steam_id))
            .await
    }

    pub async fn update_player_review_metadata(
        &self,
        steam_id: String,
        update: ReviewMetadataUpdate,
    ) -> Result<Option<PlayerReviewMetadata>> {
        validate_player_review_id(&steam_id)?;
        update.validate()?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !current_player_exists(&transaction, &steam_id)? {
                if !player_projection_complete(&transaction)? {
                    return Err(DomainError::DependencyUnavailable(
                        "Player review metadata requires a complete current Player projection"
                            .to_owned(),
                    )
                    .into());
                }
                transaction.commit()?;
                return Ok(None);
            }
            validate_tag_ids(&transaction, &update.tag_ids)?;
            let now = Utc::now();
            transaction.execute(
                "INSERT INTO player_review_metadata(steam_id, comment, updated_at) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(steam_id) DO UPDATE SET \
                    comment = excluded.comment, updated_at = excluded.updated_at",
                params![steam_id, update.comment, now.to_rfc3339()],
            )?;
            replace_player_tags(&transaction, &steam_id, &update.tag_ids)?;
            let metadata = read_player_metadata(&transaction, &steam_id)?.ok_or_else(|| {
                StorageError::Domain(DomainError::Internal(
                    "Player review metadata disappeared during its transaction".to_owned(),
                ))
            })?;
            transaction.commit()?;
            Ok(Some(metadata))
        })
        .await
    }

    pub async fn get_round_review_metadata(
        &self,
        demo_id: Uuid,
        round: u32,
    ) -> Result<Option<RoundReviewMetadata>> {
        validate_round_number(round)?;
        self.run(move |connection| read_current_round_metadata(connection, demo_id, round))
            .await
    }

    pub async fn update_round_review_metadata(
        &self,
        demo_id: Uuid,
        round: u32,
        update: ReviewMetadataUpdate,
    ) -> Result<Option<RoundReviewMetadata>> {
        validate_round_number(round)?;
        update.validate()?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some((source_sha256, analysis_updated_at)) =
                current_round_source(&transaction, demo_id, round)?
            else {
                transaction.commit()?;
                return Ok(None);
            };
            validate_tag_ids(&transaction, &update.tag_ids)?;
            let now = Utc::now();
            transaction.execute(
                "INSERT INTO round_review_metadata(\
                    demo_id, source_sha256, round, comment, updated_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(demo_id, source_sha256, round) DO UPDATE SET \
                    comment = excluded.comment, updated_at = excluded.updated_at",
                params![
                    demo_id.to_string(),
                    source_sha256,
                    i64::from(round),
                    update.comment,
                    now.to_rfc3339(),
                ],
            )?;
            replace_round_tags(
                &transaction,
                demo_id,
                &source_sha256,
                round,
                &update.tag_ids,
            )?;
            let metadata = read_round_metadata(
                &transaction,
                demo_id,
                &source_sha256,
                round,
                analysis_updated_at,
            )?;
            transaction.commit()?;
            Ok(Some(metadata))
        })
        .await
    }
}

fn validate_player_review_id(steam_id: &str) -> Result<()> {
    if is_canonical_review_steam64(steam_id) {
        return Ok(());
    }
    Err(DomainError::InvalidInput(
        "Player review metadata requires one canonical 17-digit Steam64 identity".to_owned(),
    )
    .into())
}

fn validate_round_number(round: u32) -> Result<()> {
    if round > 0 {
        return Ok(());
    }
    Err(DomainError::InvalidInput(
        "Round review metadata requires a positive round number".to_owned(),
    )
    .into())
}

fn player_projection_complete(connection: &Connection) -> Result<bool> {
    let (projected, analyses) = connection.query_row(
        "SELECT \
            (SELECT COUNT(*) FROM analyses AS analysis \
              INNER JOIN player_match_projection_state AS state \
                      ON state.demo_id = analysis.demo_id \
                     AND state.analysis_updated_at = analysis.updated_at \
                     AND state.projected_players = (\
                         SELECT COUNT(*) FROM player_match_items AS counted \
                          WHERE counted.demo_id = analysis.demo_id\
                     )), \
            (SELECT COUNT(*) FROM analyses)",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    Ok(projected == analyses)
}

fn current_player_exists(connection: &Connection, steam_id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(\
            SELECT 1 FROM player_match_items AS item \
            INNER JOIN analyses AS analysis ON analysis.demo_id = item.demo_id \
            INNER JOIN player_match_projection_state AS state \
                    ON state.demo_id = analysis.demo_id \
                   AND state.analysis_updated_at = analysis.updated_at \
                   AND state.projected_players = (\
                       SELECT COUNT(*) FROM player_match_items AS counted \
                        WHERE counted.demo_id = analysis.demo_id\
                   ) \
            WHERE item.steam_id = ?1\
        )",
        [steam_id],
        |row| row.get(0),
    )?)
}

fn validate_tag_ids(transaction: &Transaction<'_>, tag_ids: &[Uuid]) -> Result<()> {
    for tag_id in tag_ids {
        let exists = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM review_tags WHERE id = ?1)",
            [tag_id.to_string()],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Err(DomainError::InvalidInput(
                "one or more assigned review tags do not exist".to_owned(),
            )
            .into());
        }
    }
    Ok(())
}

fn replace_player_tags(
    transaction: &Transaction<'_>,
    steam_id: &str,
    tag_ids: &[Uuid],
) -> Result<()> {
    transaction.execute(
        "DELETE FROM player_review_tag_assignments WHERE steam_id = ?1",
        [steam_id],
    )?;
    for (position, tag_id) in tag_ids.iter().enumerate() {
        transaction.execute(
            "INSERT INTO player_review_tag_assignments(steam_id, tag_id, position) \
             VALUES (?1, ?2, ?3)",
            params![steam_id, tag_id.to_string(), usize_to_i64(position)?],
        )?;
    }
    Ok(())
}

fn replace_round_tags(
    transaction: &Transaction<'_>,
    demo_id: Uuid,
    source_sha256: &str,
    round: u32,
    tag_ids: &[Uuid],
) -> Result<()> {
    transaction.execute(
        "DELETE FROM round_review_tag_assignments \
         WHERE demo_id = ?1 AND source_sha256 = ?2 AND round = ?3",
        params![demo_id.to_string(), source_sha256, i64::from(round)],
    )?;
    for (position, tag_id) in tag_ids.iter().enumerate() {
        transaction.execute(
            "INSERT INTO round_review_tag_assignments(\
                demo_id, source_sha256, round, tag_id, position\
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                demo_id.to_string(),
                source_sha256,
                i64::from(round),
                tag_id.to_string(),
                usize_to_i64(position)?,
            ],
        )?;
    }
    Ok(())
}

fn usize_to_i64(value: usize) -> Result<i64> {
    i64::try_from(value).map_err(|_| {
        StorageError::Domain(DomainError::InvalidInput(
            "review tag position is out of range".to_owned(),
        ))
    })
}

fn read_tags(
    connection: &Connection,
    sql: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<ReviewTag>> {
    let mut statement = connection.prepare(sql)?;
    Ok(statement
        .query_map(values, read_demo_tag)?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn read_player_metadata(
    connection: &Connection,
    steam_id: &str,
) -> Result<Option<PlayerReviewMetadata>> {
    if !current_player_exists(connection, steam_id)? {
        if !player_projection_complete(connection)? {
            return Err(DomainError::DependencyUnavailable(
                "Player review metadata requires a complete current Player projection".to_owned(),
            )
            .into());
        }
        return Ok(None);
    }
    let stored = connection
        .query_row(
            "SELECT comment, updated_at FROM player_review_metadata WHERE steam_id = ?1",
            [steam_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let fallback = connection.query_row(
        "SELECT MAX(demo.created_at) \
         FROM player_match_items AS item \
         INNER JOIN analyses AS analysis ON analysis.demo_id = item.demo_id \
         INNER JOIN player_match_projection_state AS state \
                 ON state.demo_id = analysis.demo_id \
                AND state.analysis_updated_at = analysis.updated_at \
                AND state.projected_players = (\
                    SELECT COUNT(*) FROM player_match_items AS counted \
                     WHERE counted.demo_id = analysis.demo_id\
                ) \
         INNER JOIN demos AS demo ON demo.id = item.demo_id \
         WHERE item.steam_id = ?1",
        [steam_id],
        |row| row.get::<_, Option<String>>(0),
    )?;
    let (comment, updated_at) = match stored {
        Some((comment, updated_at)) => (comment, parse_repository_datetime(&updated_at)?),
        None => (
            String::new(),
            parse_repository_datetime(&fallback.ok_or_else(|| {
                StorageError::Domain(DomainError::Internal(
                    "Projected Player has no catalog timestamp".to_owned(),
                ))
            })?)?,
        ),
    };
    let tags = read_tags(
        connection,
        "SELECT tag.id, tag.name, tag.color, tag.created_at, tag.updated_at \
         FROM player_review_tag_assignments AS assignment \
         INNER JOIN review_tags AS tag ON tag.id = assignment.tag_id \
         WHERE assignment.steam_id = ?1 ORDER BY assignment.position ASC",
        [steam_id],
    )?;
    Ok(Some(PlayerReviewMetadata {
        steam_id: steam_id.to_owned(),
        comment,
        tags,
        updated_at,
    }))
}

fn current_round_source(
    connection: &Connection,
    demo_id: Uuid,
    round: u32,
) -> Result<Option<(String, DateTime<Utc>)>> {
    let stored = connection
        .query_row(
            "SELECT demo.content_sha256, json_extract(demo.document_json, '$.file_size'), \
                    analysis.document_json, \
                    analysis.updated_at, run.input_sha256, run.input_size \
             FROM demos AS demo \
             LEFT JOIN analyses AS analysis ON analysis.demo_id = demo.id \
             LEFT JOIN analysis_runs AS run ON run.id = analysis.producer_run_id \
             WHERE demo.id = ?1",
            [demo_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((demo_hash, demo_size, document, analysis_updated_at, run_hash, run_size)) = stored
    else {
        return Ok(None);
    };
    let (
        Some(demo_hash),
        Some(document),
        Some(analysis_updated_at),
        Some(run_hash),
        Some(run_size),
    ) = (demo_hash, document, analysis_updated_at, run_hash, run_size)
    else {
        return Err(DomainError::DependencyUnavailable(
            "Round review metadata requires one current completed Analysis".to_owned(),
        )
        .into());
    };
    if !is_review_source_sha256(&demo_hash)
        || demo_hash != run_hash
        || demo_size < 0
        || demo_size != run_size
    {
        return Err(DomainError::DependencyUnavailable(
            "Round review metadata source identity does not match its producer".to_owned(),
        )
        .into());
    }
    let analysis: MatchAnalysis = serde_json::from_str(&document)?;
    if analysis.demo_id != demo_id {
        return Err(DomainError::DependencyUnavailable(
            "Round review metadata Analysis belongs to another Demo".to_owned(),
        )
        .into());
    }
    let count = analysis
        .rounds
        .iter()
        .filter(|candidate| candidate.number == round)
        .count();
    if count == 0 {
        return Ok(None);
    }
    if count != 1 {
        return Err(DomainError::DependencyUnavailable(
            "Round review metadata requires one unique current round".to_owned(),
        )
        .into());
    }
    Ok(Some((
        demo_hash,
        parse_repository_datetime(&analysis_updated_at)?,
    )))
}

fn read_current_round_metadata(
    connection: &Connection,
    demo_id: Uuid,
    round: u32,
) -> Result<Option<RoundReviewMetadata>> {
    let Some((source_sha256, analysis_updated_at)) =
        current_round_source(connection, demo_id, round)?
    else {
        return Ok(None);
    };
    Ok(Some(read_round_metadata(
        connection,
        demo_id,
        &source_sha256,
        round,
        analysis_updated_at,
    )?))
}

fn read_round_metadata(
    connection: &Connection,
    demo_id: Uuid,
    source_sha256: &str,
    round: u32,
    fallback_updated_at: DateTime<Utc>,
) -> Result<RoundReviewMetadata> {
    let stored = connection
        .query_row(
            "SELECT comment, updated_at FROM round_review_metadata \
             WHERE demo_id = ?1 AND source_sha256 = ?2 AND round = ?3",
            params![demo_id.to_string(), source_sha256, i64::from(round)],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let (comment, updated_at) = match stored {
        Some((comment, updated_at)) => (comment, parse_repository_datetime(&updated_at)?),
        None => (String::new(), fallback_updated_at),
    };
    let tags = read_tags(
        connection,
        "SELECT tag.id, tag.name, tag.color, tag.created_at, tag.updated_at \
         FROM round_review_tag_assignments AS assignment \
         INNER JOIN review_tags AS tag ON tag.id = assignment.tag_id \
         WHERE assignment.demo_id = ?1 AND assignment.source_sha256 = ?2 \
           AND assignment.round = ?3 ORDER BY assignment.position ASC",
        params![demo_id.to_string(), source_sha256, i64::from(round)],
    )?;
    Ok(RoundReviewMetadata {
        demo_id,
        source_sha256: source_sha256.to_owned(),
        round,
        comment,
        tags,
        updated_at,
    })
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;
    use vibe_cs_domain::{
        AnalysisInputFingerprint, DemoRecord, DemoStatus, MatchAnalysis, PlayerStats,
        ReviewMetadataUpdate, ReviewTagCreate, RoundSummary,
    };

    use crate::Storage;

    const PLAYER_ID: &str = "76561197960690195";

    fn demo(id: Uuid) -> DemoRecord {
        let now = Utc::now();
        DemoRecord {
            id,
            path: format!("C:/matches/{id}.dem"),
            file_name: format!("{id}.dem"),
            display_name: "M1 Mirage".to_owned(),
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
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 90.0,
            verified_total_ticks: Some(5_760),
            teams: Vec::new(),
            players: vec![PlayerStats {
                steam_id: PLAYER_ID.to_owned(),
                spectator_slot: Some(1),
                name: "FalleN".to_owned(),
                team: "A".to_owned(),
                kills: 9,
                deaths: 14,
                assists: 6,
                headshots: 6,
                damage: 1_638,
                adr: 78.0,
                kill_death_ratio: 9.0 / 14.0,
                score: 20,
            }],
            rounds: vec![RoundSummary {
                number: 13,
                start_tick: 100_000,
                end_tick: 110_004,
                winner: "A".to_owned(),
                reason: "elimination".to_owned(),
                team_a_score: 7,
                team_b_score: 6,
                events: Vec::new(),
            }],
            highlights: Vec::new(),
        }
    }

    async fn complete(storage: &Storage, demo_id: Uuid) {
        let current = storage
            .get_demo(demo_id)
            .await
            .expect("read Demo")
            .expect("Demo before completion");
        let fingerprint = AnalysisInputFingerprint {
            sha256: current.content_sha256.expect("Demo fingerprint"),
            size: current.file_size,
        };
        let run_id = storage
            .start_analysis_run(demo_id)
            .await
            .expect("start")
            .run
            .id;
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
            .expect("revalidation started");
        storage
            .mark_analysis_projection_started(run_id)
            .await
            .expect("projection started");
        storage
            .complete_analysis_run(run_id, analysis(demo_id), fingerprint)
            .await
            .expect("complete analysis");
    }

    #[tokio::test]
    async fn player_and_source_bound_round_share_the_review_tag_catalog() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        complete(&storage, record.id).await;

        let tag = storage
            .create_review_tag(ReviewTagCreate {
                name: "Retake".to_owned(),
                color: "#2563eb".to_owned(),
            })
            .await
            .expect("create shared review tag");
        let update = ReviewMetadataUpdate {
            comment: "Review utility timing".to_owned(),
            tag_ids: vec![tag.id],
        };

        let player = storage
            .update_player_review_metadata(PLAYER_ID.to_owned(), update.clone())
            .await
            .expect("update player")
            .expect("projected player");
        let round = storage
            .update_round_review_metadata(record.id, 13, update)
            .await
            .expect("update round")
            .expect("current round");

        assert_eq!(player.steam_id, PLAYER_ID);
        assert_eq!(player.tags, vec![tag.clone()]);
        assert_eq!(round.demo_id, record.id);
        assert_eq!(round.source_sha256, "a".repeat(64));
        assert_eq!(round.round, 13);
        assert_eq!(round.tags, vec![tag]);
    }

    #[tokio::test]
    async fn round_review_follows_source_hash_while_player_review_follows_steam64() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        complete(&storage, record.id).await;

        let tag = storage
            .create_review_tag(ReviewTagCreate {
                name: "Major".to_owned(),
                color: "#16a34a".to_owned(),
            })
            .await
            .expect("create tag");
        let update = ReviewMetadataUpdate {
            comment: "Old source review".to_owned(),
            tag_ids: vec![tag.id],
        };
        storage
            .update_player_review_metadata(PLAYER_ID.to_owned(), update.clone())
            .await
            .expect("player update");
        storage
            .update_round_review_metadata(record.id, 13, update)
            .await
            .expect("round update");

        let mut replacement = storage
            .get_demo(record.id)
            .await
            .expect("read current Demo")
            .expect("current Demo");
        replacement.content_sha256 = Some("b".repeat(64));
        replacement.file_size = 640;
        replacement.status = DemoStatus::Discovered;
        replacement.updated_at = Utc::now();
        storage
            .replace_demo_content(replacement)
            .await
            .expect("replace content atomically");
        complete(&storage, record.id).await;

        let round = storage
            .get_round_review_metadata(record.id, 13)
            .await
            .expect("read replacement round")
            .expect("replacement round");
        assert_eq!(round.source_sha256, "b".repeat(64));
        assert_eq!(round.comment, "");
        assert!(round.tags.is_empty());

        let player = storage
            .get_player_review_metadata(PLAYER_ID.to_owned())
            .await
            .expect("read player metadata")
            .expect("same Steam64");
        assert_eq!(player.comment, "Old source review");
        assert_eq!(player.tags, vec![tag]);
    }
}
