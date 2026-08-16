use chrono::{DateTime, Utc};
use rusqlite::{Transaction, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use vibe_cs_domain::MatchAnalysis;

use super::Storage;
use crate::{Result, StorageError};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct LineupProjectionCoverage {
    pub evaluated_demos: u64,
    pub verified_demos: u64,
    pub total_analyses: u64,
    pub projection_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LineupDirectoryQuery {
    pub search: String,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct LineupDirectoryItem {
    pub lineup_id: String,
    pub members: [String; 5],
    pub maps: u64,
    pub wins: u64,
    pub losses: u64,
    pub ties: u64,
    pub rounds_for: u64,
    pub rounds_against: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct LineupDirectoryPage {
    pub items: Vec<LineupDirectoryItem>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub coverage: LineupProjectionCoverage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct LineupMapItem {
    pub demo_id: String,
    pub map_name: Option<String>,
    pub match_date: Option<DateTime<Utc>>,
    pub cataloged_at: DateTime<Utc>,
    pub opponent_lineup_id: String,
    pub team_slot: String,
    pub rounds_for: u32,
    pub rounds_against: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct LineupMapPage {
    pub lineup_id: String,
    pub members: [String; 5],
    pub items: Vec<LineupMapItem>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub coverage: LineupProjectionCoverage,
}

pub(super) fn replace_lineup_projection(
    transaction: &Transaction<'_>,
    analysis: &MatchAnalysis,
    analysis_updated_at: &str,
) -> Result<()> {
    transaction.execute(
        "DELETE FROM lineup_map_items WHERE demo_id = ?1",
        [analysis.demo_id.to_string()],
    )?;
    if let Some(lineups) = analysis.verified_local_lineups() {
        for lineup in lineups {
            transaction.execute(
                "INSERT INTO lineup_map_items(demo_id, lineup_id, opponent_lineup_id, team_slot, rounds_for, rounds_against) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![analysis.demo_id.to_string(), lineup.lineup_id, lineup.opponent_lineup_id,
                    lineup.team_slot, i64::from(lineup.rounds_for), i64::from(lineup.rounds_against)],
            )?;
            for (position, steam_id) in lineup.members.iter().enumerate() {
                transaction.execute(
                    "INSERT INTO lineup_map_members(demo_id, lineup_id, position, steam_id) VALUES (?1, ?2, ?3, ?4)",
                    params![analysis.demo_id.to_string(), lineup.lineup_id, i64::try_from(position).map_err(|_| StorageError::LineupProjection("member position overflow".to_owned()))?, steam_id],
                )?;
            }
        }
        transaction.execute(
            "INSERT INTO lineup_projection_state(demo_id, analysis_updated_at, status, reason, projected_lineups, projected_members) \
             VALUES (?1, ?2, 'verified', NULL, 2, 10) \
             ON CONFLICT(demo_id) DO UPDATE SET analysis_updated_at=excluded.analysis_updated_at, status=excluded.status, reason=NULL, projected_lineups=2, projected_members=10",
            params![analysis.demo_id.to_string(), analysis_updated_at],
        )?;
    } else {
        transaction.execute(
            "INSERT INTO lineup_projection_state(demo_id, analysis_updated_at, status, reason, projected_lineups, projected_members) \
             VALUES (?1, ?2, 'unavailable', 'unverified_round_roster', 0, 0) \
             ON CONFLICT(demo_id) DO UPDATE SET analysis_updated_at=excluded.analysis_updated_at, status=excluded.status, reason=excluded.reason, projected_lineups=0, projected_members=0",
            params![analysis.demo_id.to_string(), analysis_updated_at],
        )?;
    }
    Ok(())
}

impl Storage {
    pub async fn list_lineups(&self, query: LineupDirectoryQuery) -> Result<LineupDirectoryPage> {
        if query.page == 0 || query.page > 10_000 || query.page_size == 0 || query.page_size > 100 {
            return Err(StorageError::Domain(
                vibe_cs_domain::DomainError::InvalidInput(
                    "lineup page is out of bounds".to_owned(),
                ),
            ));
        }
        let search = query.search.trim().to_ascii_lowercase();
        if search.chars().count() > 128 {
            return Err(StorageError::Domain(
                vibe_cs_domain::DomainError::InvalidInput("lineup search is too long".to_owned()),
            ));
        }
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let coverage = coverage(&transaction)?;
            let total = transaction.query_row(
                "SELECT COUNT(DISTINCT item.lineup_id) FROM lineup_map_items item \
                 JOIN lineup_projection_state state ON state.demo_id=item.demo_id AND state.status='verified' AND state.projected_lineups=(SELECT COUNT(*) FROM lineup_map_items counted WHERE counted.demo_id=state.demo_id) AND state.projected_members=(SELECT COUNT(*) FROM lineup_map_members counted WHERE counted.demo_id=state.demo_id) \
                 JOIN analyses a ON a.demo_id=item.demo_id AND a.updated_at=state.analysis_updated_at \
                 WHERE ?1='' OR instr(lower(item.lineup_id), ?1)>0 OR EXISTS (SELECT 1 FROM lineup_map_members m WHERE m.demo_id=item.demo_id AND m.lineup_id=item.lineup_id AND instr(m.steam_id, ?1)>0)",
                params![search], |row| row.get::<_, i64>(0))?;
            let offset = i64::from(query.page.saturating_sub(1)) * i64::from(query.page_size);
            let mut statement = transaction.prepare(
                "SELECT item.lineup_id, COUNT(*), \
                    SUM(CASE WHEN item.rounds_for>item.rounds_against THEN 1 ELSE 0 END), \
                    SUM(CASE WHEN item.rounds_for<item.rounds_against THEN 1 ELSE 0 END), \
                    SUM(CASE WHEN item.rounds_for=item.rounds_against THEN 1 ELSE 0 END), \
                    SUM(item.rounds_for), SUM(item.rounds_against) \
                 FROM lineup_map_items item \
                 JOIN lineup_projection_state state ON state.demo_id=item.demo_id AND state.status='verified' AND state.projected_lineups=(SELECT COUNT(*) FROM lineup_map_items counted WHERE counted.demo_id=state.demo_id) AND state.projected_members=(SELECT COUNT(*) FROM lineup_map_members counted WHERE counted.demo_id=state.demo_id) \
                 JOIN analyses a ON a.demo_id=item.demo_id AND a.updated_at=state.analysis_updated_at \
                 WHERE ?1='' OR instr(lower(item.lineup_id), ?1)>0 OR EXISTS (SELECT 1 FROM lineup_map_members m WHERE m.demo_id=item.demo_id AND m.lineup_id=item.lineup_id AND instr(m.steam_id, ?1)>0) \
                 GROUP BY item.lineup_id ORDER BY COUNT(*) DESC, item.lineup_id ASC LIMIT ?2 OFFSET ?3")?;
            let rows = statement.query_map(params![search, i64::from(query.page_size), offset], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?, row.get::<_, i64>(6)?))
            })?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut items = Vec::with_capacity(rows.len());
            for (lineup_id, maps, wins, losses, ties, rounds_for, rounds_against) in rows {
                items.push(LineupDirectoryItem { members: members(&transaction, &lineup_id)?, lineup_id,
                    maps: to_u64(maps)?, wins: to_u64(wins)?, losses: to_u64(losses)?, ties: to_u64(ties)?, rounds_for: to_u64(rounds_for)?, rounds_against: to_u64(rounds_against)? });
            }
            drop(statement);
            transaction.commit()?;
            Ok(LineupDirectoryPage { items, total: to_u64(total)?, page: query.page, page_size: query.page_size, coverage })
        }).await
    }

    pub async fn list_lineup_maps(
        &self,
        lineup_id: String,
        page: u32,
        page_size: u32,
    ) -> Result<LineupMapPage> {
        if lineup_id.len() != 64
            || !lineup_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || page == 0
            || page > 10_000
            || page_size == 0
            || page_size > 100
        {
            return Err(StorageError::Domain(
                vibe_cs_domain::DomainError::InvalidInput("invalid lineup map query".to_owned()),
            ));
        }
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let coverage = coverage(&transaction)?;
            let total = transaction.query_row("SELECT COUNT(*) FROM lineup_map_items item JOIN lineup_projection_state state ON state.demo_id=item.demo_id AND state.status='verified' AND state.projected_lineups=(SELECT COUNT(*) FROM lineup_map_items counted WHERE counted.demo_id=state.demo_id) AND state.projected_members=(SELECT COUNT(*) FROM lineup_map_members counted WHERE counted.demo_id=state.demo_id) JOIN analyses a ON a.demo_id=item.demo_id AND a.updated_at=state.analysis_updated_at WHERE item.lineup_id=?1", [&lineup_id], |row| row.get::<_, i64>(0))?;
            if total == 0 {
                transaction.commit()?;
                let error = if coverage.projection_complete {
                    vibe_cs_domain::DomainError::NotFound("local lineup".to_owned())
                } else {
                    vibe_cs_domain::DomainError::DependencyUnavailable("local lineup projection is incomplete".to_owned())
                };
                return Err(StorageError::Domain(error));
            }
            let lineup_members = members(&transaction, &lineup_id)?;
            let offset = i64::from(page.saturating_sub(1)) * i64::from(page_size);
            let mut statement = transaction.prepare("SELECT item.demo_id, demo.map_name, demo.match_date, demo.created_at, item.opponent_lineup_id, item.team_slot, item.rounds_for, item.rounds_against FROM lineup_map_items item JOIN lineup_projection_state state ON state.demo_id=item.demo_id AND state.status='verified' AND state.projected_lineups=(SELECT COUNT(*) FROM lineup_map_items counted WHERE counted.demo_id=state.demo_id) AND state.projected_members=(SELECT COUNT(*) FROM lineup_map_members counted WHERE counted.demo_id=state.demo_id) JOIN analyses a ON a.demo_id=item.demo_id AND a.updated_at=state.analysis_updated_at JOIN demos demo ON demo.id=item.demo_id WHERE item.lineup_id=?1 ORDER BY (demo.match_date IS NULL), demo.match_date DESC, demo.created_at DESC, item.demo_id ASC LIMIT ?2 OFFSET ?3")?;
            let items = statement.query_map(params![lineup_id, i64::from(page_size), offset], |row| {
                let match_date = row.get::<_, Option<String>>(2)?;
                Ok(LineupMapItem { demo_id: row.get(0)?, map_name: row.get(1)?, match_date: parse_optional_datetime(match_date.as_deref())?, cataloged_at: parse_datetime(&row.get::<_, String>(3)?)?, opponent_lineup_id: row.get(4)?, team_slot: row.get(5)?, rounds_for: u32::try_from(row.get::<_, i64>(6)?).map_err(|e| rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Integer, Box::new(e)))?, rounds_against: u32::try_from(row.get::<_, i64>(7)?).map_err(|e| rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Integer, Box::new(e)))? })
            })?.collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            transaction.commit()?;
            Ok(LineupMapPage { lineup_id, members: lineup_members, items, total: to_u64(total)?, page, page_size, coverage })
        }).await
    }
}

fn coverage(transaction: &Transaction<'_>) -> Result<LineupProjectionCoverage> {
    let (evaluated, verified, total) = transaction.query_row(
        "SELECT COUNT(state.demo_id), SUM(CASE WHEN state.status='verified' THEN 1 ELSE 0 END), (SELECT COUNT(*) FROM analyses) FROM lineup_projection_state state JOIN analyses a ON a.demo_id=state.demo_id AND a.updated_at=state.analysis_updated_at WHERE state.projected_lineups=(SELECT COUNT(*) FROM lineup_map_items counted WHERE counted.demo_id=state.demo_id) AND state.projected_members=(SELECT COUNT(*) FROM lineup_map_members counted WHERE counted.demo_id=state.demo_id)",
        [], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0), row.get::<_, i64>(2)?)))?;
    Ok(LineupProjectionCoverage {
        evaluated_demos: to_u64(evaluated)?,
        verified_demos: to_u64(verified)?,
        total_analyses: to_u64(total)?,
        projection_complete: evaluated == total,
    })
}

fn members(transaction: &Transaction<'_>, lineup_id: &str) -> Result<[String; 5]> {
    let mut statement = transaction.prepare("SELECT DISTINCT steam_id FROM lineup_map_members WHERE lineup_id=?1 ORDER BY steam_id ASC LIMIT 6")?;
    let values = statement
        .query_map([lineup_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    values.try_into().map_err(|_| {
        StorageError::LineupProjection(format!(
            "lineup {lineup_id} does not have exactly five members"
        ))
    })
}

fn to_u64(value: i64) -> Result<u64> {
    u64::try_from(value)
        .map_err(|_| StorageError::LineupProjection("negative lineup aggregate".to_owned()))
}
fn parse_datetime(value: &str) -> rusqlite::Result<DateTime<Utc>> {
    value.parse().map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn parse_optional_datetime(value: Option<&str>) -> rusqlite::Result<Option<DateTime<Utc>>> {
    value.map(parse_datetime).transpose()
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;
    use vibe_cs_domain::{
        AnalysisInputFingerprint, DemoRecord, DemoStatus, EventKind, MatchAnalysis, PlayerStats,
        RoundSummary, TeamSummary, TimelineEvent,
    };

    use super::{LineupDirectoryQuery, Storage};

    #[tokio::test]
    async fn completed_analysis_publishes_two_verified_lineups_and_exact_map_history() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let demo_id = Uuid::new_v4();
        let now = Utc::now();
        storage
            .put_demos(vec![DemoRecord {
                id: demo_id,
                path: "C:/match.dem".to_owned(),
                file_name: "match.dem".to_owned(),
                display_name: "Match".to_owned(),
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
            }])
            .await
            .expect("demo");
        let fingerprint = AnalysisInputFingerprint {
            sha256: "a".repeat(64),
            size: 512,
        };
        let run_id = storage
            .start_analysis_run(demo_id)
            .await
            .expect("run")
            .run
            .id;
        storage
            .bind_analysis_run_input(run_id, fingerprint.clone())
            .await
            .expect("bind");
        storage
            .mark_analysis_parser_started(run_id)
            .await
            .expect("parser");
        storage
            .mark_analysis_input_revalidation_started(run_id)
            .await
            .expect("verify");
        storage
            .mark_analysis_projection_started(run_id)
            .await
            .expect("project");
        storage
            .complete_analysis_run(run_id, analysis(demo_id), fingerprint)
            .await
            .expect("complete");

        let page = storage
            .list_lineups(LineupDirectoryQuery {
                search: String::new(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("lineups");
        assert_eq!(page.total, 2);
        assert_eq!(page.coverage.evaluated_demos, 1);
        assert_eq!(page.coverage.verified_demos, 1);
        assert!(page.coverage.projection_complete);
        let lineup = &page.items[0];
        assert_eq!(lineup.maps, 1);
        assert_eq!(lineup.maps, lineup.wins + lineup.losses + lineup.ties);
        let maps = storage
            .list_lineup_maps(lineup.lineup_id.clone(), 1, 20)
            .await
            .expect("maps");
        assert_eq!(maps.lineup_id, lineup.lineup_id);
        assert_eq!(maps.items[0].demo_id, demo_id.to_string());
        assert_eq!(maps.members, lineup.members);
    }

    fn analysis(demo_id: Uuid) -> MatchAnalysis {
        let a = [
            "76561198000000001",
            "76561198000000002",
            "76561198000000003",
            "76561198000000004",
            "76561198000000005",
        ];
        let b = [
            "76561198000000006",
            "76561198000000007",
            "76561198000000008",
            "76561198000000009",
            "76561198000000010",
        ];
        let roster = a
            .iter()
            .map(|id| ((*id).to_owned(), json!("T")))
            .chain(b.iter().map(|id| ((*id).to_owned(), json!("CT"))))
            .collect::<serde_json::Map<String, serde_json::Value>>();
        let players = a
            .iter()
            .map(|id| player(id, "A"))
            .chain(b.iter().map(|id| player(id, "B")))
            .collect();
        MatchAnalysis {
            demo_id,
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 120.0,
            verified_total_ticks: Some(10_000),
            teams: vec![team("A", 1, &a), team("B", 0, &b)],
            players,
            rounds: vec![RoundSummary {
                number: 1,
                start_tick: 100,
                end_tick: 200,
                winner: "A".to_owned(),
                reason: String::new(),
                team_a_score: 1,
                team_b_score: 0,
                events: vec![TimelineEvent {
                    id: "round-1-start".to_owned(),
                    tick: 100,
                    seconds: 1.0,
                    kind: EventKind::RoundStart,
                    actor: None,
                    target: None,
                    weapon: None,
                    headshot: false,
                    penetrated: false,
                    position: None,
                    detail: json!({"_round_roster": roster}),
                }],
            }],
            highlights: Vec::new(),
        }
    }

    fn player(id: &str, team: &str) -> PlayerStats {
        PlayerStats {
            steam_id: id.to_owned(),
            spectator_slot: None,
            name: id.to_owned(),
            team: team.to_owned(),
            kills: 0,
            deaths: 0,
            assists: 0,
            headshots: 0,
            damage: 0,
            adr: 0.0,
            kill_death_ratio: 0.0,
            score: 0,
        }
    }
    fn team(slot: &str, score: u32, ids: &[&str; 5]) -> TeamSummary {
        TeamSummary {
            name: format!("Team {slot}"),
            side: slot.to_owned(),
            score,
            players: ids.iter().map(|id| (*id).to_owned()).collect(),
        }
    }
}
