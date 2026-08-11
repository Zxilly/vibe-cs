use rusqlite::{Connection, OptionalExtension, params};

use crate::Result;

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "core_library",
        sql: r"
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
                document_json TEXT NOT NULL
            );

            CREATE TABLE analyses (
                demo_id TEXT PRIMARY KEY NOT NULL,
                document_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (demo_id) REFERENCES demos(id) ON DELETE CASCADE
            );
        ",
    },
    Migration {
        version: 2,
        name: "media_and_projects",
        sql: r"
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
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                document_json TEXT NOT NULL
            );
        ",
    },
    Migration {
        version: 3,
        name: "background_jobs",
        sql: r"
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

            CREATE INDEX demos_status_idx ON demos(status);
            CREATE INDEX demos_map_idx ON demos(map_name);
            CREATE INDEX demos_updated_idx ON demos(updated_at DESC);
            CREATE INDEX recorded_clips_created_idx ON recorded_clips(created_at DESC);
            CREATE INDEX media_assets_project_idx ON media_assets(project_id);
            CREATE INDEX export_jobs_project_idx ON export_jobs(project_id, updated_at DESC);
        ",
    },
    Migration {
        version: 4,
        name: "demo_content_hash",
        sql: r"
            ALTER TABLE demos ADD COLUMN content_sha256 TEXT;
            CREATE INDEX demos_content_sha256_idx ON demos(content_sha256);
        ",
    },
    Migration {
        version: 5,
        name: "steam_match_history",
        sql: r"
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

            CREATE INDEX steam_matches_account_idx
                ON steam_matches(steam_id, match_id DESC);
            CREATE INDEX match_download_jobs_match_idx
                ON match_download_jobs(match_record_id, updated_at DESC);
        ",
    },
    Migration {
        version: 6,
        name: "versioned_editor_presets",
        sql: r"
            ALTER TABLE editor_presets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
            CREATE INDEX editor_presets_updated_idx ON editor_presets(updated_at DESC);
        ",
    },
    Migration {
        version: 7,
        name: "cosmetic_plans",
        sql: r"
            CREATE TABLE cosmetic_plans (
                id TEXT PRIMARY KEY NOT NULL,
                demo_id TEXT NOT NULL,
                name TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                document_json TEXT NOT NULL,
                FOREIGN KEY (demo_id) REFERENCES demos(id) ON DELETE CASCADE
            );
            CREATE INDEX cosmetic_plans_demo_idx
                ON cosmetic_plans(demo_id, updated_at DESC);
        ",
    },
];

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
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (\
             version INTEGER PRIMARY KEY NOT NULL,\
             name TEXT NOT NULL,\
             applied_at TEXT NOT NULL\
         );",
    )?;

    for migration in MIGRATIONS {
        let applied = connection
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = ?1",
                [migration.version],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if applied {
            continue;
        }

        let transaction = connection.transaction()?;
        transaction.execute_batch(migration.sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
            params![
                migration.version,
                migration.name,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent_and_versioned() {
        let mut connection = Connection::open_in_memory().expect("open sqlite");
        configure(&connection).expect("configure");
        run(&mut connection).expect("first migration");
        run(&mut connection).expect("second migration");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("count migrations");
        assert_eq!(
            count,
            i64::try_from(MIGRATIONS.len()).expect("migration count fits i64")
        );
    }
}
