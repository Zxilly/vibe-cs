//! Exact schema contract for the current, unreleased product.

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::{Result, StorageError};

const CURRENT_SCHEMA: &str = r"
    CREATE TABLE storage_contract (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
        fingerprint TEXT NOT NULL
    );

    CREATE TABLE app_config (
        key TEXT PRIMARY KEY NOT NULL,
        document_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE demos (
        id TEXT PRIMARY KEY NOT NULL,
        path TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        map_name TEXT,
        match_date TEXT,
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL,
        content_sha256 TEXT
    );

    CREATE TABLE analyses (
        demo_id TEXT PRIMARY KEY NOT NULL,
        document_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (demo_id) REFERENCES demos(id) ON DELETE CASCADE
    );

    CREATE TABLE recorded_clips (
        id TEXT PRIMARY KEY NOT NULL,
        demo_id TEXT,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        document_json TEXT NOT NULL,
        FOREIGN KEY (demo_id) REFERENCES demos(id) ON DELETE SET NULL
    );

    CREATE TABLE montage_projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL
    );

    CREATE TABLE editor_projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL
    );

    CREATE TABLE media_assets (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        document_json TEXT NOT NULL
    );

    CREATE TABLE editor_presets (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL
    );

    CREATE TABLE export_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL
    );

    CREATE TABLE recording_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL
    );

    CREATE TABLE steam_matches (
        id TEXT PRIMARY KEY NOT NULL,
        steam_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL,
        UNIQUE(steam_id, match_id)
    );

    CREATE TABLE match_download_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        match_record_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL,
        FOREIGN KEY (match_record_id) REFERENCES steam_matches(id) ON DELETE CASCADE
    );

    CREATE TABLE cosmetic_plans (
        id TEXT PRIMARY KEY NOT NULL,
        demo_id TEXT NOT NULL,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL,
        FOREIGN KEY (demo_id) REFERENCES demos(id) ON DELETE CASCADE
    );

    CREATE TABLE evidence_search_items (
        evidence_id TEXT PRIMARY KEY NOT NULL,
        demo_id TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('event', 'highlight')),
        source_id TEXT NOT NULL,
        event_family TEXT,
        event_type TEXT NOT NULL,
        map_name TEXT NOT NULL,
        map_key TEXT NOT NULL,
        round INTEGER NOT NULL CHECK(round >= 0),
        tick INTEGER NOT NULL CHECK(tick >= 0),
        end_tick INTEGER NOT NULL CHECK(end_tick >= tick),
        actor_id TEXT,
        actor_name TEXT,
        actor_id_key TEXT,
        actor_name_key TEXT,
        target_id TEXT,
        target_name TEXT,
        target_id_key TEXT,
        target_name_key TEXT,
        weapon TEXT,
        weapon_key TEXT,
        headshot INTEGER CHECK(headshot IS NULL OR headshot IN (0, 1)),
        penetrated INTEGER CHECK(penetrated IS NULL OR penetrated IN (0, 1)),
        attributes_json TEXT NOT NULL,
        search_text TEXT NOT NULL,
        FOREIGN KEY (demo_id) REFERENCES analyses(demo_id) ON DELETE CASCADE,
        UNIQUE(demo_id, source_kind, source_id)
    );

    CREATE TABLE evidence_search_victims (
        evidence_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position >= 0),
        victim_id TEXT NOT NULL,
        victim_name TEXT,
        victim_id_key TEXT NOT NULL,
        victim_name_key TEXT,
        PRIMARY KEY(evidence_id, position),
        FOREIGN KEY (evidence_id) REFERENCES evidence_search_items(evidence_id)
            ON DELETE CASCADE
    );

    CREATE TABLE evidence_search_projection_state (
        demo_id TEXT PRIMARY KEY NOT NULL,
        analysis_updated_at TEXT NOT NULL,
        indexed_items INTEGER NOT NULL CHECK(indexed_items >= 0),
        FOREIGN KEY (demo_id) REFERENCES analyses(demo_id) ON DELETE CASCADE
    );

    CREATE TABLE evidence_annotations (
        id TEXT PRIMARY KEY NOT NULL,
        demo_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        round INTEGER NOT NULL CHECK(round >= 1),
        tick INTEGER NOT NULL CHECK(tick >= 0),
        review_state TEXT NOT NULL CHECK(review_state IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL,
        FOREIGN KEY (demo_id) REFERENCES demos(id) ON DELETE CASCADE
    );

    CREATE INDEX demos_status_idx ON demos(status);
    CREATE INDEX demos_map_idx ON demos(map_name);
    CREATE INDEX demos_updated_idx ON demos(updated_at DESC);
    CREATE INDEX demos_content_sha256_idx ON demos(content_sha256);
    CREATE INDEX recorded_clips_created_idx ON recorded_clips(created_at DESC);
    CREATE INDEX media_assets_project_idx ON media_assets(project_id);
    CREATE INDEX export_jobs_project_idx ON export_jobs(project_id, updated_at DESC);
    CREATE INDEX steam_matches_account_idx ON steam_matches(steam_id, match_id DESC);
    CREATE INDEX match_download_jobs_match_idx
        ON match_download_jobs(match_record_id, updated_at DESC);
    CREATE INDEX editor_presets_updated_idx ON editor_presets(updated_at DESC);
    CREATE INDEX cosmetic_plans_demo_idx ON cosmetic_plans(demo_id, updated_at DESC);
    CREATE INDEX evidence_search_demo_idx
        ON evidence_search_items(demo_id, round, tick);
    CREATE INDEX evidence_search_family_idx
        ON evidence_search_items(event_family, tick);
    CREATE INDEX evidence_search_actor_idx
        ON evidence_search_items(actor_id_key, actor_name_key);
    CREATE INDEX evidence_search_target_idx
        ON evidence_search_items(target_id_key, target_name_key);
    CREATE INDEX evidence_search_weapon_idx ON evidence_search_items(weapon_key);
    CREATE INDEX evidence_search_map_idx ON evidence_search_items(map_key);
    CREATE INDEX evidence_search_victim_idx
        ON evidence_search_victims(victim_id_key, victim_name_key);
    CREATE INDEX evidence_annotations_evidence_idx
        ON evidence_annotations(evidence_id, updated_at DESC);
    CREATE INDEX evidence_annotations_demo_idx
        ON evidence_annotations(demo_id, updated_at DESC);
";

pub(crate) fn configure(connection: &Connection) -> Result<()> {
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;\n\
         PRAGMA journal_mode = WAL;\n\
         PRAGMA synchronous = NORMAL;",
    )?;
    Ok(())
}

pub(crate) fn run(connection: &mut Connection) -> Result<()> {
    let table_count = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    let fingerprint = schema_fingerprint();
    if table_count == 0 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(CURRENT_SCHEMA)?;
        transaction.execute(
            "INSERT INTO storage_contract(singleton, fingerprint) VALUES (1, ?1)",
            params![fingerprint],
        )?;
        transaction.commit()?;
        return Ok(());
    }

    let stored = connection
        .query_row(
            "SELECT fingerprint FROM storage_contract WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| match error {
            rusqlite::Error::SqliteFailure(_, Some(message))
                if message.contains("no such table: storage_contract") =>
            {
                StorageError::CurrentSchemaRequired
            }
            other => StorageError::Database(other),
        })?;
    if stored.as_deref() != Some(fingerprint.as_str()) {
        return Err(StorageError::CurrentSchemaRequired);
    }
    Ok(())
}

fn schema_fingerprint() -> String {
    hex::encode(Sha256::digest(CURRENT_SCHEMA.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_uses_only_the_current_schema_contract() {
        let mut connection = Connection::open_in_memory().expect("open sqlite");
        configure(&connection).expect("configure");
        run(&mut connection).expect("create current schema");
        run(&mut connection).expect("reopen current schema");

        assert_eq!(
            connection
                .query_row(
                    "SELECT fingerprint FROM storage_contract WHERE singleton = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("current contract"),
            schema_fingerprint()
        );
    }

    #[test]
    fn pre_contract_database_is_rejected() {
        let mut connection = Connection::open_in_memory().expect("open sqlite");
        connection
            .execute_batch("CREATE TABLE experimental_product_data(id TEXT PRIMARY KEY);")
            .expect("non-current schema fixture");

        assert!(matches!(
            run(&mut connection),
            Err(StorageError::CurrentSchemaRequired)
        ));
    }

    #[test]
    fn different_contract_is_rejected() {
        let mut connection = Connection::open_in_memory().expect("open sqlite");
        connection
            .execute_batch(
                "CREATE TABLE storage_contract(\
                    singleton INTEGER PRIMARY KEY NOT NULL,\
                    fingerprint TEXT NOT NULL\
                 );\
                 INSERT INTO storage_contract(singleton, fingerprint) VALUES (1, 'other');",
            )
            .expect("different contract fixture");

        assert!(matches!(
            run(&mut connection),
            Err(StorageError::CurrentSchemaRequired)
        ));
    }
}
