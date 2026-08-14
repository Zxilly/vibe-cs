use std::collections::HashSet;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension as _, Transaction, params};
use uuid::Uuid;
use vibe_cs_domain::{DomainError, MatchAnalysis};

use super::{Storage, row_u64, sql_u64};
use crate::{Result, StorageError};

const MAXIMUM_PLAYER_MATCH_PAGE: u32 = 10_000;
const MAXIMUM_PLAYER_MATCH_PAGE_SIZE: u32 = 100;
const MAXIMUM_PLAYER_NAME_CHARS: usize = 128;
const MAXIMUM_PLAYER_TEAM_CHARS: usize = 32;
const MAXIMUM_PLAYER_SEARCH_CHARS: usize = 128;
const MAXIMUM_PLAYER_ALIASES: u32 = 32;
const MAXIMUM_PLAYER_HEATMAP_POINTS: u64 = 5_000;

macro_rules! valid_player_projections_cte {
    () => {
        "valid_player_projections AS (\
    SELECT analysis.demo_id \
      FROM analyses AS analysis \
      INNER JOIN player_match_projection_state AS state \
              ON state.demo_id = analysis.demo_id \
             AND state.analysis_updated_at = analysis.updated_at \
             AND state.projected_players = (\
                 SELECT COUNT(*) FROM player_match_items AS counted \
                  WHERE counted.demo_id = analysis.demo_id\
             )\
)"
    };
}

macro_rules! valid_player_heatmap_projections_cte {
    () => {
        "valid_player_heatmap_projections AS (\
    SELECT analysis.demo_id \
      FROM analyses AS analysis \
      INNER JOIN player_match_projection_state AS player_state \
              ON player_state.demo_id = analysis.demo_id \
             AND player_state.analysis_updated_at = analysis.updated_at \
             AND player_state.projected_players = (\
                 SELECT COUNT(*) FROM player_match_items AS counted_player \
                  WHERE counted_player.demo_id = analysis.demo_id\
             ) \
      INNER JOIN evidence_search_projection_state AS evidence_state \
              ON evidence_state.demo_id = analysis.demo_id \
             AND evidence_state.analysis_updated_at = analysis.updated_at \
             AND evidence_state.indexed_items = (\
                 SELECT COUNT(*) FROM evidence_search_items AS counted_evidence \
                  WHERE counted_evidence.demo_id = analysis.demo_id\
             )\
)"
    };
}

const PLAYER_DIRECTORY_CTE: &str = concat!(
    "WITH ",
    valid_player_projections_cte!(),
    ", aggregated AS (\
    SELECT item.steam_id, \
           (SELECT latest.player_name \
              FROM player_match_items AS latest \
              INNER JOIN valid_player_projections AS latest_projection \
                      ON latest_projection.demo_id = latest.demo_id \
              INNER JOIN demos AS latest_demo ON latest_demo.id = latest.demo_id \
             WHERE latest.steam_id = item.steam_id \
             ORDER BY latest_demo.created_at DESC, latest.demo_id ASC LIMIT 1) AS current_name, \
           (SELECT latest.player_name_key \
              FROM player_match_items AS latest \
              INNER JOIN valid_player_projections AS latest_projection \
                      ON latest_projection.demo_id = latest.demo_id \
              INNER JOIN demos AS latest_demo ON latest_demo.id = latest.demo_id \
             WHERE latest.steam_id = item.steam_id \
             ORDER BY latest_demo.created_at DESC, latest.demo_id ASC LIMIT 1) AS current_name_key, \
           (SELECT latest.team \
              FROM player_match_items AS latest \
              INNER JOIN valid_player_projections AS latest_projection \
                      ON latest_projection.demo_id = latest.demo_id \
              INNER JOIN demos AS latest_demo ON latest_demo.id = latest.demo_id \
             WHERE latest.steam_id = item.steam_id \
             ORDER BY latest_demo.created_at DESC, latest.demo_id ASC LIMIT 1) AS current_team, \
           (SELECT latest.team_key \
              FROM player_match_items AS latest \
              INNER JOIN valid_player_projections AS latest_projection \
                      ON latest_projection.demo_id = latest.demo_id \
              INNER JOIN demos AS latest_demo ON latest_demo.id = latest.demo_id \
             WHERE latest.steam_id = item.steam_id \
             ORDER BY latest_demo.created_at DESC, latest.demo_id ASC LIMIT 1) AS current_team_key, \
           MAX(demo.match_date) AS last_match_date, \
           MAX(demo.created_at) AS last_cataloged_at, \
           COUNT(*) AS matches, SUM(item.kills) AS kills, SUM(item.deaths) AS deaths, \
           SUM(item.assists) AS assists, SUM(item.headshots) AS headshots, \
           SUM(item.damage) AS damage, AVG(item.adr) AS average_adr, \
           AVG(item.kill_death_ratio) AS average_kill_death_ratio \
      FROM player_match_items AS item \
      INNER JOIN valid_player_projections AS projection ON projection.demo_id = item.demo_id \
      INNER JOIN demos AS demo ON demo.id = item.demo_id \
     GROUP BY item.steam_id\
), filtered AS (\
    SELECT * FROM aggregated \
     WHERE ?1 IS NULL OR instr(steam_id, ?1) > 0 \
        OR EXISTS (\
            SELECT 1 FROM player_match_items AS candidate \
            INNER JOIN valid_player_projections AS candidate_projection \
                    ON candidate_projection.demo_id = candidate.demo_id \
             WHERE candidate.steam_id = aggregated.steam_id \
               AND instr(candidate.player_name_key, ?1) > 0\
        )\
)"
);

const EXACT_PLAYER_SQL: &str = concat!(
    "WITH ",
    valid_player_projections_cte!(),
    " SELECT item.steam_id, \
       (SELECT latest.player_name \
          FROM player_match_items AS latest \
          INNER JOIN valid_player_projections AS latest_projection \
                  ON latest_projection.demo_id = latest.demo_id \
          INNER JOIN demos AS latest_demo ON latest_demo.id = latest.demo_id \
         WHERE latest.steam_id = ?1 \
         ORDER BY latest_demo.created_at DESC, latest.demo_id ASC LIMIT 1), \
       (SELECT latest.team \
          FROM player_match_items AS latest \
          INNER JOIN valid_player_projections AS latest_projection \
                  ON latest_projection.demo_id = latest.demo_id \
          INNER JOIN demos AS latest_demo ON latest_demo.id = latest.demo_id \
         WHERE latest.steam_id = ?1 \
         ORDER BY latest_demo.created_at DESC, latest.demo_id ASC LIMIT 1), \
       MAX(demo.match_date), MAX(demo.created_at), COUNT(*), \
       SUM(item.kills), SUM(item.deaths), SUM(item.assists), SUM(item.headshots), \
       SUM(item.damage), AVG(item.adr), AVG(item.kill_death_ratio) \
  FROM player_match_items AS item \
  INNER JOIN valid_player_projections AS projection ON projection.demo_id = item.demo_id \
  INNER JOIN demos AS demo ON demo.id = item.demo_id \
 WHERE item.steam_id = ?1 \
 GROUP BY item.steam_id"
);

const PLAYER_MATCH_COUNT_SQL: &str = concat!(
    "WITH ",
    valid_player_projections_cte!(),
    " SELECT COUNT(*) \
        FROM player_match_items AS item \
        INNER JOIN valid_player_projections AS projection ON projection.demo_id = item.demo_id \
       WHERE item.steam_id = ?1"
);

const PLAYER_ALIASES_SQL: &str = concat!(
    "WITH ",
    valid_player_projections_cte!(),
    ", distinct_aliases AS (\
        SELECT item.player_name, item.player_name_key, \
               MAX(demo.created_at) AS latest_cataloged_at, \
               MIN(item.demo_id) AS stable_demo_id \
          FROM player_match_items AS item \
          INNER JOIN valid_player_projections AS projection ON projection.demo_id = item.demo_id \
          INNER JOIN demos AS demo ON demo.id = item.demo_id \
         WHERE item.steam_id = ?1 AND item.player_name <> ?2 \
         GROUP BY item.player_name\
    ), counted_aliases AS (\
        SELECT player_name, player_name_key, latest_cataloged_at, stable_demo_id, \
               COUNT(*) OVER() AS aliases_total \
          FROM distinct_aliases\
    ) \
    SELECT player_name, aliases_total \
      FROM counted_aliases \
     ORDER BY latest_cataloged_at DESC, player_name_key ASC, player_name ASC, stable_demo_id ASC \
     LIMIT ?3"
);

const PLAYER_MATCH_PAGE_SQL: &str = concat!(
    "WITH ",
    valid_player_projections_cte!(),
    " SELECT item.demo_id, demo.display_name, demo.map_name, \
       demo.match_date, demo.created_at, item.team, item.kills, item.deaths, item.assists, \
       item.headshots, item.damage, item.adr, item.kill_death_ratio \
  FROM player_match_items AS item \
  INNER JOIN valid_player_projections AS projection ON projection.demo_id = item.demo_id \
  INNER JOIN demos AS demo ON demo.id = item.demo_id \
 WHERE item.steam_id = ?1 \
 ORDER BY (demo.match_date IS NULL) ASC, demo.match_date DESC, \
          demo.created_at DESC, item.demo_id ASC \
 LIMIT ?2 OFFSET ?3"
);

const PLAYER_MAP_COUNT_SQL: &str = concat!(
    "WITH ",
    valid_player_projections_cte!(),
    " SELECT COUNT(*) FROM (\
        SELECT demo.map_name \
          FROM player_match_items AS item \
          INNER JOIN valid_player_projections AS projection ON projection.demo_id = item.demo_id \
          INNER JOIN demos AS demo ON demo.id = item.demo_id \
         WHERE item.steam_id = ?1 \
         GROUP BY demo.map_name\
      )"
);

const PLAYER_MAP_PAGE_SQL: &str = concat!(
    "WITH ",
    valid_player_projections_cte!(),
    " SELECT demo.map_name, COUNT(*), SUM(item.kills), SUM(item.deaths), \
       SUM(item.assists), SUM(item.headshots), SUM(item.damage), AVG(item.adr), \
       AVG(item.kill_death_ratio) \
  FROM player_match_items AS item \
  INNER JOIN valid_player_projections AS projection ON projection.demo_id = item.demo_id \
  INNER JOIN demos AS demo ON demo.id = item.demo_id \
 WHERE item.steam_id = ?1 \
 GROUP BY demo.map_name \
 ORDER BY COUNT(*) DESC, (demo.map_name IS NULL) ASC, \
          lower(demo.map_name) ASC, demo.map_name ASC \
 LIMIT ?2 OFFSET ?3"
);

const PLAYER_PROJECTION_COVERAGE_SQL: &str = concat!(
    "WITH ",
    valid_player_projections_cte!(),
    " SELECT \
    (SELECT COUNT(*) FROM valid_player_projections), \
    (SELECT COUNT(*) FROM analyses)"
);

const PLAYER_HEATMAP_CTE: &str = concat!(
    "WITH ",
    valid_player_heatmap_projections_cte!(),
    ", points AS (\
        SELECT item.demo_id, item.evidence_id, item.round, item.tick, \
               'kills' AS kind, item.actor_x AS x, item.actor_y AS y, item.actor_z AS z \
          FROM evidence_search_items AS item \
          INNER JOIN valid_player_heatmap_projections AS projection \
                  ON projection.demo_id = item.demo_id \
         WHERE item.source_kind = 'event' AND item.event_type = 'kill' \
           AND item.actor_id = ?1 AND item.map_name = ?2 \
           AND item.actor_x IS NOT NULL \
        UNION ALL \
        SELECT item.demo_id, item.evidence_id, item.round, item.tick, \
               'deaths' AS kind, item.target_x AS x, item.target_y AS y, item.target_z AS z \
          FROM evidence_search_items AS item \
          INNER JOIN valid_player_heatmap_projections AS projection \
                  ON projection.demo_id = item.demo_id \
         WHERE item.source_kind = 'event' AND item.event_type = 'kill' \
           AND item.target_id = ?1 AND item.map_name = ?2 \
           AND item.target_x IS NOT NULL\
    ), filtered_points AS (\
        SELECT * FROM points WHERE ?3 = 'all' OR kind = ?3\
    )"
);

const PLAYER_HEATMAP_COVERAGE_SQL: &str = concat!(
    "WITH ",
    valid_player_heatmap_projections_cte!(),
    " SELECT (SELECT COUNT(*) FROM valid_player_heatmap_projections), \
             (SELECT COUNT(*) FROM analyses)"
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerDirectorySort {
    Player,
    Team,
    Matches,
    Kd,
    Kills,
    Deaths,
    Assists,
    Headshots,
    Adr,
    Damage,
    LastMatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerSortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerDirectoryQuery {
    pub search: Option<String>,
    pub page: u32,
    pub page_size: u32,
    pub sort: PlayerDirectorySort,
    pub direction: PlayerSortDirection,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PlayerProjectionCoverage {
    pub projected_demos: u64,
    pub total_analyses: u64,
    pub projection_complete: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlayerAggregateStats {
    pub matches: u32,
    pub kills: u64,
    pub deaths: u64,
    pub assists: u64,
    pub headshots: u64,
    pub damage: u64,
    pub average_adr: Option<f64>,
    pub average_kill_death_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedPlayer {
    pub steam_id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub aliases_total: u64,
    pub last_team: Option<String>,
    pub last_match_date: Option<DateTime<Utc>>,
    pub last_cataloged_at: DateTime<Utc>,
    pub stats: PlayerAggregateStats,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerDirectoryPage {
    pub items: Vec<ProjectedPlayer>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub coverage: PlayerProjectionCoverage,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerProfile {
    pub player: ProjectedPlayer,
    pub coverage: PlayerProjectionCoverage,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerComparisonProjection {
    pub players: [Option<ProjectedPlayer>; 2],
    pub coverage: PlayerProjectionCoverage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerMatchQuery {
    pub steam_id: String,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedPlayerMatch {
    pub demo_id: Uuid,
    pub demo_name: String,
    pub map_name: Option<String>,
    pub match_date: Option<DateTime<Utc>>,
    pub cataloged_at: DateTime<Utc>,
    pub team: Option<String>,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub headshots: u32,
    pub damage: u32,
    pub adr: Option<f64>,
    pub kill_death_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerMatchPage {
    pub steam_id: String,
    pub items: Vec<ProjectedPlayerMatch>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub coverage: PlayerProjectionCoverage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerMapQuery {
    pub steam_id: String,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedPlayerMap {
    pub map_name: Option<String>,
    pub stats: PlayerAggregateStats,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerMapPage {
    pub steam_id: String,
    pub items: Vec<ProjectedPlayerMap>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub coverage: PlayerProjectionCoverage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerHeatmapKind {
    All,
    Kills,
    Deaths,
}

impl PlayerHeatmapKind {
    const fn as_sql(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Kills => "kills",
            Self::Deaths => "deaths",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerHeatmapQuery {
    pub steam_id: String,
    pub map_name: String,
    pub kind: PlayerHeatmapKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedPlayerHeatPoint {
    pub demo_id: Uuid,
    pub evidence_id: String,
    pub round: u32,
    pub tick: u64,
    pub kind: PlayerHeatmapKind,
    pub x: f64,
    pub y: f64,
    pub floor: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerHeatmapProjection {
    pub steam_id: String,
    pub map_name: String,
    pub points: Vec<ProjectedPlayerHeatPoint>,
    pub total: u64,
    pub maximum_points: u64,
    pub complete: bool,
    pub coverage: PlayerProjectionCoverage,
}

impl Storage {
    pub async fn get_player(&self, steam_id: String) -> Result<Option<PlayerProfile>> {
        validate_steam_id(&steam_id)?;
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let coverage = player_projection_coverage(&transaction)?;
            let player = projected_player_by_id(&transaction, &steam_id)?;
            transaction.commit()?;
            Ok(player.map(|player| PlayerProfile { player, coverage }))
        })
        .await
    }

    pub async fn get_players(&self, steam_ids: [String; 2]) -> Result<PlayerComparisonProjection> {
        validate_steam_id(&steam_ids[0])?;
        validate_steam_id(&steam_ids[1])?;
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let coverage = player_projection_coverage(&transaction)?;
            let players = [
                projected_player_by_id(&transaction, &steam_ids[0])?,
                projected_player_by_id(&transaction, &steam_ids[1])?,
            ];
            transaction.commit()?;
            Ok(PlayerComparisonProjection { players, coverage })
        })
        .await
    }

    pub async fn list_players(&self, query: PlayerDirectoryQuery) -> Result<PlayerDirectoryPage> {
        let search = validate_directory_query(&query)?;
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let coverage = player_projection_coverage(&transaction)?;
            let count_sql = format!("{PLAYER_DIRECTORY_CTE} SELECT COUNT(*) FROM filtered");
            let total = transaction.query_row(&count_sql, [&search], |row| row_u64(row, 0))?;
            let order_sql = player_order_sql(query.sort, query.direction);
            let page_sql = format!(
                "{PLAYER_DIRECTORY_CTE} \
                 SELECT steam_id, current_name, current_team, last_match_date, \
                        last_cataloged_at, matches, kills, deaths, assists, headshots, damage, \
                        average_adr, average_kill_death_ratio \
                   FROM filtered ORDER BY {order_sql} LIMIT ?2 OFFSET ?3"
            );
            let offset = u64::from(query.page - 1) * u64::from(query.page_size);
            let mut statement = transaction.prepare(&page_sql)?;
            let persisted = statement
                .query_map(
                    params![search, query.page_size, sql_u64(offset)?],
                    persisted_projected_player,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            let items = persisted
                .into_iter()
                .map(|player| finish_projected_player(&transaction, player))
                .collect::<Result<Vec<_>>>()?;
            transaction.commit()?;
            Ok(PlayerDirectoryPage {
                items,
                total,
                page: query.page,
                page_size: query.page_size,
                coverage,
            })
        })
        .await
    }

    pub async fn list_player_matches(&self, query: PlayerMatchQuery) -> Result<PlayerMatchPage> {
        validate_match_query(&query)?;
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let coverage = player_projection_coverage(&transaction)?;
            let total = transaction.query_row(
                PLAYER_MATCH_COUNT_SQL,
                [query.steam_id.as_str()],
                |row| row_u64(row, 0),
            )?;
            let offset = u64::from(query.page - 1) * u64::from(query.page_size);
            let mut statement = transaction.prepare(PLAYER_MATCH_PAGE_SQL)?;
            let items = statement
                .query_map(
                    params![query.steam_id, query.page_size, sql_u64(offset)?],
                    projected_player_match,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            transaction.commit()?;
            Ok(PlayerMatchPage {
                steam_id: query.steam_id,
                items,
                total,
                page: query.page,
                page_size: query.page_size,
                coverage,
            })
        })
        .await
    }

    pub async fn list_player_maps(&self, query: PlayerMapQuery) -> Result<PlayerMapPage> {
        validate_map_query(&query)?;
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let coverage = player_projection_coverage(&transaction)?;
            let total =
                transaction.query_row(PLAYER_MAP_COUNT_SQL, [query.steam_id.as_str()], |row| {
                    row_u64(row, 0)
                })?;
            let offset = u64::from(query.page - 1) * u64::from(query.page_size);
            let mut statement = transaction.prepare(PLAYER_MAP_PAGE_SQL)?;
            let items = statement
                .query_map(
                    params![query.steam_id, query.page_size, sql_u64(offset)?],
                    projected_player_map,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            transaction.commit()?;
            Ok(PlayerMapPage {
                steam_id: query.steam_id,
                items,
                total,
                page: query.page,
                page_size: query.page_size,
                coverage,
            })
        })
        .await
    }

    pub async fn player_heatmap(
        &self,
        query: PlayerHeatmapQuery,
    ) -> Result<PlayerHeatmapProjection> {
        validate_steam_id(&query.steam_id)?;
        let map_name = bounded_text(&query.map_name, 128)
            .ok_or_else(|| StorageError::PlayerProjection("invalid heatmap map name".to_owned()))?;
        let kind = query.kind.as_sql();
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let coverage = player_heatmap_coverage(&transaction)?;
            let count_sql = format!("{PLAYER_HEATMAP_CTE} SELECT COUNT(*) FROM filtered_points");
            let total = transaction.query_row(
                &count_sql,
                params![query.steam_id, map_name, kind],
                |row| row_u64(row, 0),
            )?;
            let complete = total <= MAXIMUM_PLAYER_HEATMAP_POINTS;
            let points = if complete {
                let points_sql = format!(
                    "{PLAYER_HEATMAP_CTE} \
                     SELECT demo_id, evidence_id, round, tick, kind, x, y, z \
                       FROM filtered_points \
                      ORDER BY CASE kind WHEN 'kills' THEN 0 ELSE 1 END, \
                               demo_id ASC, evidence_id ASC"
                );
                let mut statement = transaction.prepare(&points_sql)?;
                let points = statement
                    .query_map(
                        params![query.steam_id, map_name, kind],
                        projected_player_heat_point,
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                drop(statement);
                points
            } else {
                Vec::new()
            };
            transaction.commit()?;
            Ok(PlayerHeatmapProjection {
                steam_id: query.steam_id,
                map_name,
                points,
                total,
                maximum_points: MAXIMUM_PLAYER_HEATMAP_POINTS,
                complete,
                coverage,
            })
        })
        .await
    }
}

#[derive(Debug)]
struct PersistedProjectedPlayer {
    steam_id: String,
    name: String,
    last_team: Option<String>,
    last_match_date: Option<DateTime<Utc>>,
    last_cataloged_at: DateTime<Utc>,
    stats: PlayerAggregateStats,
}

pub(super) fn replace_player_match_projection(
    transaction: &Transaction<'_>,
    analysis: &MatchAnalysis,
    analysis_updated_at: &str,
) -> Result<()> {
    validate_player_match_projection(analysis)?;
    let projected = analysis
        .players
        .iter()
        .filter(|player| is_steam_id(&player.steam_id))
        .collect::<Vec<_>>();
    transaction.execute(
        "DELETE FROM player_match_items WHERE demo_id = ?1",
        [analysis.demo_id.to_string()],
    )?;
    let mut projected_players = 0_u64;
    for player in projected {
        let name = bounded_text(&player.name, MAXIMUM_PLAYER_NAME_CHARS)
            .unwrap_or_else(|| player.steam_id.clone());
        let name_key = name.to_lowercase();
        let team = bounded_text(&player.team, MAXIMUM_PLAYER_TEAM_CHARS);
        let team_key = team.as_deref().map(str::to_lowercase);
        transaction.execute(
            "INSERT INTO player_match_items(\
                 demo_id, steam_id, player_name, player_name_key, team, team_key, kills, deaths, \
                 assists, headshots, damage, adr, kill_death_ratio\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                analysis.demo_id.to_string(),
                player.steam_id,
                name,
                name_key,
                team,
                team_key,
                i64::from(player.kills),
                i64::from(player.deaths),
                i64::from(player.assists),
                i64::from(player.headshots),
                i64::from(player.damage),
                player.adr,
                player.kill_death_ratio,
            ],
        )?;
        projected_players = projected_players.saturating_add(1);
    }
    transaction.execute(
        "INSERT INTO player_match_projection_state(\
             demo_id, analysis_updated_at, projected_players\
         ) VALUES (?1, ?2, ?3) \
         ON CONFLICT(demo_id) DO UPDATE SET \
             analysis_updated_at = excluded.analysis_updated_at, \
             projected_players = excluded.projected_players",
        params![
            analysis.demo_id.to_string(),
            analysis_updated_at,
            sql_u64(projected_players)?,
        ],
    )?;
    Ok(())
}

pub(super) fn validate_player_match_projection(analysis: &MatchAnalysis) -> Result<()> {
    let mut identities = HashSet::with_capacity(analysis.players.len());
    for player in analysis
        .players
        .iter()
        .filter(|player| is_steam_id(&player.steam_id))
    {
        if !identities.insert(player.steam_id.as_str()) {
            return Err(StorageError::PlayerProjection(format!(
                "duplicate valid Steam64 identity {} in analysis {}",
                player.steam_id, analysis.demo_id
            )));
        }
        if !player.adr.is_finite() || player.adr < 0.0 {
            return Err(StorageError::PlayerProjection(format!(
                "player {} has invalid ADR in analysis {}",
                player.steam_id, analysis.demo_id
            )));
        }
        if !player.kill_death_ratio.is_finite() || player.kill_death_ratio < 0.0 {
            return Err(StorageError::PlayerProjection(format!(
                "player {} has invalid kill/death ratio in analysis {}",
                player.steam_id, analysis.demo_id
            )));
        }
    }
    Ok(())
}

fn validate_match_query(query: &PlayerMatchQuery) -> Result<()> {
    validate_steam_id(&query.steam_id)?;
    if !(1..=MAXIMUM_PLAYER_MATCH_PAGE).contains(&query.page) {
        return Err(DomainError::InvalidInput(format!(
            "page must be between 1 and {MAXIMUM_PLAYER_MATCH_PAGE}"
        ))
        .into());
    }
    if !(1..=MAXIMUM_PLAYER_MATCH_PAGE_SIZE).contains(&query.page_size) {
        return Err(DomainError::InvalidInput(format!(
            "page_size must be between 1 and {MAXIMUM_PLAYER_MATCH_PAGE_SIZE}"
        ))
        .into());
    }
    Ok(())
}

fn validate_map_query(query: &PlayerMapQuery) -> Result<()> {
    validate_steam_id(&query.steam_id)?;
    validate_pagination(query.page, query.page_size)
}

fn validate_pagination(page: u32, page_size: u32) -> Result<()> {
    if !(1..=MAXIMUM_PLAYER_MATCH_PAGE).contains(&page) {
        return Err(DomainError::InvalidInput(format!(
            "page must be between 1 and {MAXIMUM_PLAYER_MATCH_PAGE}"
        ))
        .into());
    }
    if !(1..=MAXIMUM_PLAYER_MATCH_PAGE_SIZE).contains(&page_size) {
        return Err(DomainError::InvalidInput(format!(
            "page_size must be between 1 and {MAXIMUM_PLAYER_MATCH_PAGE_SIZE}"
        ))
        .into());
    }
    Ok(())
}

fn validate_steam_id(steam_id: &str) -> Result<()> {
    if is_steam_id(steam_id) {
        return Ok(());
    }
    Err(DomainError::InvalidInput(
        "Steam ID must contain one valid 17-digit Steam64 identity".to_owned(),
    )
    .into())
}

fn validate_directory_query(query: &PlayerDirectoryQuery) -> Result<Option<String>> {
    if !(1..=MAXIMUM_PLAYER_MATCH_PAGE).contains(&query.page) {
        return Err(DomainError::InvalidInput(format!(
            "page must be between 1 and {MAXIMUM_PLAYER_MATCH_PAGE}"
        ))
        .into());
    }
    if !(1..=MAXIMUM_PLAYER_MATCH_PAGE_SIZE).contains(&query.page_size) {
        return Err(DomainError::InvalidInput(format!(
            "page_size must be between 1 and {MAXIMUM_PLAYER_MATCH_PAGE_SIZE}"
        ))
        .into());
    }
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if search.is_some_and(|value| value.chars().count() > MAXIMUM_PLAYER_SEARCH_CHARS) {
        return Err(DomainError::InvalidInput(format!(
            "search must contain at most {MAXIMUM_PLAYER_SEARCH_CHARS} characters"
        ))
        .into());
    }
    Ok(search.map(str::to_lowercase))
}

fn player_order_sql(sort: PlayerDirectorySort, direction: PlayerSortDirection) -> &'static str {
    match (sort, direction) {
        (PlayerDirectorySort::Player, PlayerSortDirection::Asc) => {
            "current_name_key ASC, current_name ASC, steam_id ASC"
        }
        (PlayerDirectorySort::Player, PlayerSortDirection::Desc) => {
            "current_name_key DESC, current_name ASC, steam_id ASC"
        }
        (PlayerDirectorySort::Team, PlayerSortDirection::Asc) => {
            "(current_team_key IS NULL) ASC, current_team_key ASC, current_team ASC, steam_id ASC"
        }
        (PlayerDirectorySort::Team, PlayerSortDirection::Desc) => {
            "(current_team_key IS NULL) ASC, current_team_key DESC, current_team ASC, steam_id ASC"
        }
        (PlayerDirectorySort::Matches, PlayerSortDirection::Asc) => "matches ASC, steam_id ASC",
        (PlayerDirectorySort::Matches, PlayerSortDirection::Desc) => "matches DESC, steam_id ASC",
        (PlayerDirectorySort::Kd, PlayerSortDirection::Asc) => {
            "(kills = 0 AND deaths = 0) ASC, \
             (deaths = 0 AND kills > 0) ASC, \
             (CAST(kills AS REAL) / CAST(MAX(deaths, 1) AS REAL)) ASC, steam_id ASC"
        }
        (PlayerDirectorySort::Kd, PlayerSortDirection::Desc) => {
            "(kills = 0 AND deaths = 0) ASC, \
             (deaths = 0 AND kills > 0) DESC, \
             (CAST(kills AS REAL) / CAST(MAX(deaths, 1) AS REAL)) DESC, steam_id ASC"
        }
        (PlayerDirectorySort::Kills, PlayerSortDirection::Asc) => "kills ASC, steam_id ASC",
        (PlayerDirectorySort::Kills, PlayerSortDirection::Desc) => "kills DESC, steam_id ASC",
        (PlayerDirectorySort::Deaths, PlayerSortDirection::Asc) => "deaths ASC, steam_id ASC",
        (PlayerDirectorySort::Deaths, PlayerSortDirection::Desc) => "deaths DESC, steam_id ASC",
        (PlayerDirectorySort::Assists, PlayerSortDirection::Asc) => "assists ASC, steam_id ASC",
        (PlayerDirectorySort::Assists, PlayerSortDirection::Desc) => "assists DESC, steam_id ASC",
        (PlayerDirectorySort::Headshots, PlayerSortDirection::Asc) => {
            "(kills = 0) ASC, \
             (CAST(headshots AS REAL) / CAST(NULLIF(kills, 0) AS REAL)) ASC, steam_id ASC"
        }
        (PlayerDirectorySort::Headshots, PlayerSortDirection::Desc) => {
            "(kills = 0) ASC, \
             (CAST(headshots AS REAL) / CAST(NULLIF(kills, 0) AS REAL)) DESC, steam_id ASC"
        }
        (PlayerDirectorySort::Adr, PlayerSortDirection::Asc) => {
            "(average_adr IS NULL) ASC, average_adr ASC, steam_id ASC"
        }
        (PlayerDirectorySort::Adr, PlayerSortDirection::Desc) => {
            "(average_adr IS NULL) ASC, average_adr DESC, steam_id ASC"
        }
        (PlayerDirectorySort::Damage, PlayerSortDirection::Asc) => "damage ASC, steam_id ASC",
        (PlayerDirectorySort::Damage, PlayerSortDirection::Desc) => "damage DESC, steam_id ASC",
        (PlayerDirectorySort::LastMatch, PlayerSortDirection::Asc) => {
            "(last_match_date IS NULL) ASC, last_match_date ASC, \
             last_cataloged_at DESC, steam_id ASC"
        }
        (PlayerDirectorySort::LastMatch, PlayerSortDirection::Desc) => {
            "(last_match_date IS NULL) ASC, last_match_date DESC, \
             last_cataloged_at DESC, steam_id ASC"
        }
    }
}

fn player_projection_coverage(connection: &Connection) -> Result<PlayerProjectionCoverage> {
    let (projected_demos, total_analyses) =
        connection.query_row(PLAYER_PROJECTION_COVERAGE_SQL, [], |row| {
            Ok((row_u64(row, 0)?, row_u64(row, 1)?))
        })?;
    Ok(PlayerProjectionCoverage {
        projected_demos,
        total_analyses,
        projection_complete: projected_demos == total_analyses,
    })
}

fn player_heatmap_coverage(connection: &Connection) -> Result<PlayerProjectionCoverage> {
    let (projected_demos, total_analyses) =
        connection.query_row(PLAYER_HEATMAP_COVERAGE_SQL, [], |row| {
            Ok((row_u64(row, 0)?, row_u64(row, 1)?))
        })?;
    Ok(PlayerProjectionCoverage {
        projected_demos,
        total_analyses,
        projection_complete: projected_demos == total_analyses,
    })
}

fn projected_player_match(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectedPlayerMatch> {
    let demo_id = row.get::<_, String>(0)?;
    Ok(ProjectedPlayerMatch {
        demo_id: parse_uuid(&demo_id, 0)?,
        demo_name: row.get(1)?,
        map_name: row.get(2)?,
        match_date: row.get(3)?,
        cataloged_at: row.get(4)?,
        team: row.get(5)?,
        kills: row_u32(row, 6)?,
        deaths: row_u32(row, 7)?,
        assists: row_u32(row, 8)?,
        headshots: row_u32(row, 9)?,
        damage: row_u32(row, 10)?,
        adr: row.get(11)?,
        kill_death_ratio: row.get(12)?,
    })
}

fn projected_player_map(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectedPlayerMap> {
    Ok(ProjectedPlayerMap {
        map_name: row.get(0)?,
        stats: PlayerAggregateStats {
            matches: row_u32(row, 1)?,
            kills: row_u64(row, 2)?,
            deaths: row_u64(row, 3)?,
            assists: row_u64(row, 4)?,
            headshots: row_u64(row, 5)?,
            damage: row_u64(row, 6)?,
            average_adr: row.get(7)?,
            average_kill_death_ratio: row.get(8)?,
        },
    })
}

fn projected_player_heat_point(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ProjectedPlayerHeatPoint> {
    let demo_id = row.get::<_, String>(0)?;
    let kind = match row.get::<_, String>(4)?.as_str() {
        "kills" => PlayerHeatmapKind::Kills,
        "deaths" => PlayerHeatmapKind::Deaths,
        value => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                format!("invalid player heatmap kind {value}").into(),
            ));
        }
    };
    let z = row.get::<_, f64>(7)?;
    #[allow(clippy::cast_possible_truncation)]
    let floor = (z / 256.0)
        .floor()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32;
    Ok(ProjectedPlayerHeatPoint {
        demo_id: parse_uuid(&demo_id, 0)?,
        evidence_id: row.get(1)?,
        round: row_u32(row, 2)?,
        tick: row_u64(row, 3)?,
        kind,
        x: row.get(5)?,
        y: row.get(6)?,
        floor,
    })
}

fn persisted_projected_player(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<PersistedProjectedPlayer> {
    Ok(PersistedProjectedPlayer {
        steam_id: row.get(0)?,
        name: row.get(1)?,
        last_team: row.get(2)?,
        last_match_date: row.get(3)?,
        last_cataloged_at: row.get(4)?,
        stats: PlayerAggregateStats {
            matches: row_u32(row, 5)?,
            kills: row_u64(row, 6)?,
            deaths: row_u64(row, 7)?,
            assists: row_u64(row, 8)?,
            headshots: row_u64(row, 9)?,
            damage: row_u64(row, 10)?,
            average_adr: row.get(11)?,
            average_kill_death_ratio: row.get(12)?,
        },
    })
}

fn finish_projected_player(
    connection: &Connection,
    persisted: PersistedProjectedPlayer,
) -> Result<ProjectedPlayer> {
    let mut statement = connection.prepare(PLAYER_ALIASES_SQL)?;
    let persisted_aliases = statement
        .query_map(
            params![
                persisted.steam_id,
                persisted.name,
                i64::from(MAXIMUM_PLAYER_ALIASES),
            ],
            |row| Ok((row.get::<_, String>(0)?, row_u64(row, 1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let aliases_total = persisted_aliases
        .first()
        .map_or(0, |(_, aliases_total)| *aliases_total);
    let aliases = persisted_aliases
        .into_iter()
        .map(|(alias, _)| alias)
        .collect();
    Ok(ProjectedPlayer {
        steam_id: persisted.steam_id,
        name: persisted.name,
        aliases,
        aliases_total,
        last_team: persisted.last_team,
        last_match_date: persisted.last_match_date,
        last_cataloged_at: persisted.last_cataloged_at,
        stats: persisted.stats,
    })
}

fn projected_player_by_id(
    connection: &Connection,
    steam_id: &str,
) -> Result<Option<ProjectedPlayer>> {
    connection
        .query_row(EXACT_PLAYER_SQL, [steam_id], persisted_projected_player)
        .optional()?
        .map(|player| finish_projected_player(connection, player))
        .transpose()
}

fn parse_uuid(value: &str, index: usize) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn row_u32(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u32> {
    let value = row.get::<_, i64>(index)?;
    u32::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn bounded_text(value: &str, maximum_chars: usize) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.chars().count() <= maximum_chars
        && !value.contains(['\r', '\n', '\0']))
    .then(|| value.to_owned())
}

fn is_steam_id(value: &str) -> bool {
    if value.len() != 17 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Ok(steam_id) = value.parse::<u64>() else {
        return false;
    };
    let universe = (steam_id >> 56) & 0xff;
    let account_type = (steam_id >> 52) & 0x0f;
    let instance = (steam_id >> 32) & 0x000f_ffff;
    let account_id = steam_id & u64::from(u32::MAX);
    universe == 1 && account_type == 1 && instance == 1 && account_id != 0
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use chrono::{DateTime, Duration, TimeZone as _, Utc};
    use rusqlite::params;
    use uuid::Uuid;
    use vibe_cs_domain::{
        AnalysisInputFingerprint, DemoRecord, DemoStatus, EventKind, MatchAnalysis, PlayerStats,
        RoundSummary, TimelineEvent,
    };

    use super::{
        EXACT_PLAYER_SQL, MAXIMUM_PLAYER_ALIASES, MAXIMUM_PLAYER_NAME_CHARS,
        MAXIMUM_PLAYER_TEAM_CHARS, PLAYER_ALIASES_SQL, PLAYER_DIRECTORY_CTE,
        PLAYER_MATCH_COUNT_SQL, PLAYER_MATCH_PAGE_SQL, PLAYER_PROJECTION_COVERAGE_SQL,
        PlayerDirectoryQuery, PlayerDirectorySort, PlayerHeatmapKind, PlayerHeatmapQuery,
        PlayerMapQuery, PlayerMatchQuery, PlayerSortDirection, ProjectedPlayerMap,
        ProjectedPlayerMatch, player_order_sql,
    };
    use crate::Storage;

    const PLAYER_ID: &str = "76561197960690195";

    fn demo(id: Uuid) -> DemoRecord {
        let id_hex = id.simple().to_string();
        let cataloged_at = Utc
            .with_ymd_and_hms(2026, 8, 13, 16, 51, 52)
            .single()
            .expect("cataloged time");
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
            content_sha256: Some(format!("{id_hex}{id_hex}")),
            file_size: 512,
            created_at: cataloged_at,
            updated_at: cataloged_at,
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
                team: "FURIA".to_owned(),
                kills: 9,
                deaths: 14,
                assists: 6,
                headshots: 6,
                damage: 1_638,
                adr: 78.0,
                kill_death_ratio: 9.0 / 14.0,
                score: 20,
            }],
            rounds: Vec::new(),
            highlights: Vec::new(),
        }
    }

    async fn complete(
        storage: &Storage,
        demo_id: Uuid,
        analysis: MatchAnalysis,
    ) -> crate::Result<()> {
        let record = storage
            .get_demo(demo_id)
            .await?
            .expect("demo before completion");
        let fingerprint = AnalysisInputFingerprint {
            sha256: record.content_sha256.expect("demo content fingerprint"),
            size: record.file_size,
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
            .expect("input revalidation started");
        storage
            .mark_analysis_projection_started(run_id)
            .await
            .expect("projection started");
        storage
            .complete_analysis_run(run_id, analysis, fingerprint)
            .await?;
        Ok(())
    }

    fn explain_plan<P: rusqlite::Params>(
        connection: &rusqlite::Connection,
        sql: &str,
        values: P,
    ) -> crate::Result<Vec<String>> {
        let explained = format!("EXPLAIN QUERY PLAN {sql}");
        let mut statement = connection.prepare(&explained)?;
        Ok(statement
            .query_map(values, |row| row.get::<_, String>(3))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    #[tokio::test]
    async fn completed_analysis_publishes_nullable_match_truth_and_catalog_time() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        complete(&storage, record.id, analysis(record.id))
            .await
            .expect("complete");

        let page = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("list projected matches");

        assert_eq!(page.total, 1);
        assert_eq!(page.coverage.projected_demos, 1);
        assert_eq!(page.coverage.total_analyses, 1);
        assert!(page.coverage.projection_complete);
        assert_eq!(
            page.items,
            vec![ProjectedPlayerMatch {
                demo_id: record.id,
                demo_name: "M1 Mirage".to_owned(),
                map_name: Some("de_mirage".to_owned()),
                match_date: None,
                cataloged_at: record.created_at,
                team: Some("FURIA".to_owned()),
                kills: 9,
                deaths: 14,
                assists: 6,
                headshots: 6,
                damage: 1_638,
                adr: Some(78.0),
                kill_death_ratio: Some(9.0 / 14.0),
            }]
        );
    }

    #[tokio::test]
    async fn completed_analyses_publish_exact_per_map_player_aggregates() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        for (map_name, kills, deaths, assists, headshots, damage, adr, kd) in [
            ("de_mirage", 9, 14, 6, 6, 1_638, 78.0, 9.0 / 14.0),
            ("de_mirage", 18, 10, 4, 9, 2_100, 100.0, 1.8),
            ("de_anubis", 12, 12, 5, 4, 1_700, 81.0, 1.0),
        ] {
            let record = demo(Uuid::new_v4());
            storage.put_demo(record.clone()).await.expect("put demo");
            let mut result = analysis(record.id);
            result.map_name = map_name.to_owned();
            let player = &mut result.players[0];
            player.kills = kills;
            player.deaths = deaths;
            player.assists = assists;
            player.headshots = headshots;
            player.damage = damage;
            player.adr = adr;
            player.kill_death_ratio = kd;
            complete(&storage, record.id, result)
                .await
                .expect("complete analysis");
        }

        let page = storage
            .list_player_maps(PlayerMapQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("list map aggregates");

        assert_eq!(page.total, 2);
        assert_eq!(page.coverage.projected_demos, 3);
        assert_eq!(page.coverage.total_analyses, 3);
        assert!(page.coverage.projection_complete);
        assert_eq!(
            page.items,
            vec![
                ProjectedPlayerMap {
                    map_name: Some("de_mirage".to_owned()),
                    stats: super::PlayerAggregateStats {
                        matches: 2,
                        kills: 27,
                        deaths: 24,
                        assists: 10,
                        headshots: 15,
                        damage: 3_738,
                        average_adr: Some(89.0),
                        average_kill_death_ratio: Some(f64::midpoint(9.0 / 14.0, 1.8)),
                    },
                },
                ProjectedPlayerMap {
                    map_name: Some("de_anubis".to_owned()),
                    stats: super::PlayerAggregateStats {
                        matches: 1,
                        kills: 12,
                        deaths: 12,
                        assists: 5,
                        headshots: 4,
                        damage: 1_700,
                        average_adr: Some(81.0),
                        average_kill_death_ratio: Some(1.0),
                    },
                },
            ]
        );
    }

    #[tokio::test]
    async fn player_heatmap_aggregates_exact_kill_and_death_coordinates_across_matching_maps() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        for (map_name, event_id, player_is_actor, x) in [
            ("de_mirage", "kill-one", true, 100.0),
            ("de_mirage", "death-two", false, 200.0),
            ("de_anubis", "other-map", true, 300.0),
        ] {
            let record = demo(Uuid::new_v4());
            storage.put_demo(record.clone()).await.expect("put demo");
            let mut result = analysis(record.id);
            result.map_name = map_name.to_owned();
            result.rounds = vec![RoundSummary {
                number: 7,
                start_tick: 400,
                end_tick: 800,
                winner: "A".to_owned(),
                reason: "target_saved".to_owned(),
                team_a_score: 4,
                team_b_score: 3,
                events: vec![TimelineEvent {
                    id: event_id.to_owned(),
                    tick: 640,
                    seconds: 10.0,
                    kind: EventKind::Kill,
                    actor: Some(
                        if player_is_actor {
                            PLAYER_ID
                        } else {
                            "76561198000000002"
                        }
                        .to_owned(),
                    ),
                    target: Some(
                        if player_is_actor {
                            "76561198000000002"
                        } else {
                            PLAYER_ID
                        }
                        .to_owned(),
                    ),
                    weapon: Some("ak47".to_owned()),
                    headshot: false,
                    penetrated: false,
                    position: Some([x, x + 1.0, 64.0]),
                    detail: serde_json::json!({
                        "attacker_X": x + 10.0,
                        "attacker_Y": x + 11.0,
                        "attacker_Z": 320.0,
                        "user_X": x,
                        "user_Y": x + 1.0,
                        "user_Z": 64.0
                    }),
                }],
            }];
            complete(&storage, record.id, result)
                .await
                .expect("complete analysis");
        }

        let heatmap = storage
            .player_heatmap(PlayerHeatmapQuery {
                steam_id: PLAYER_ID.to_owned(),
                map_name: "de_mirage".to_owned(),
                kind: PlayerHeatmapKind::All,
            })
            .await
            .expect("cross-match heatmap");

        assert_eq!(heatmap.steam_id, PLAYER_ID);
        assert_eq!(heatmap.map_name, "de_mirage");
        assert_eq!(heatmap.total, 2);
        assert!(heatmap.complete);
        assert_eq!(heatmap.coverage.projected_demos, 3);
        assert!(heatmap.coverage.projection_complete);
        assert_eq!(heatmap.points[0].kind, PlayerHeatmapKind::Kills);
        assert_eq!((heatmap.points[0].x, heatmap.points[0].y), (110.0, 111.0));
        assert_eq!(heatmap.points[1].kind, PlayerHeatmapKind::Deaths);
        assert_eq!((heatmap.points[1].x, heatmap.points[1].y), (200.0, 201.0));
        assert!(
            heatmap
                .points
                .iter()
                .all(|point| point.round == 7 && point.tick == 640)
        );
        assert!(
            heatmap
                .points
                .iter()
                .all(|point| point.evidence_id.contains("/event:"))
        );
    }

    #[tokio::test]
    async fn duplicate_valid_steam_id_fails_the_completion_transaction_closed() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        let mut result = analysis(record.id);
        let mut duplicate = result.players[0].clone();
        duplicate.name = "duplicate identity".to_owned();
        result.players.push(duplicate);

        let error = complete(&storage, record.id, result)
            .await
            .expect_err("duplicate valid Steam64 must fail closed");

        assert!(
            error
                .to_string()
                .contains("duplicate valid Steam64 identity"),
            "unexpected error: {error}"
        );
        assert!(storage.get_analysis(record.id).await.unwrap().is_none());
        assert_eq!(
            storage.get_demo(record.id).await.unwrap().unwrap().status,
            DemoStatus::Analyzing
        );
        let page = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("projection remains unpublished");
        assert_eq!(page.total, 0);
        assert_eq!(page.coverage.projected_demos, 0);
        assert_eq!(page.coverage.total_analyses, 0);
        assert!(page.coverage.projection_complete);
    }

    #[tokio::test]
    async fn malformed_required_player_metrics_fail_the_completion_transaction_closed() {
        for (adr, kill_death_ratio) in [
            (f64::NAN, 1.0),
            (-0.01, 1.0),
            (78.0, f64::INFINITY),
            (78.0, -0.01),
        ] {
            let storage = Storage::open_in_memory().await.expect("open storage");
            let record = demo(Uuid::new_v4());
            storage.put_demo(record.clone()).await.expect("put demo");
            let mut result = analysis(record.id);
            result.players[0].adr = adr;
            result.players[0].kill_death_ratio = kill_death_ratio;

            let error = complete(&storage, record.id, result)
                .await
                .expect_err("malformed required player metrics must fail closed");

            assert!(
                matches!(error, crate::StorageError::PlayerProjection(_)),
                "unexpected error: {error}"
            );
            assert!(storage.get_analysis(record.id).await.unwrap().is_none());
            assert_eq!(
                storage.get_demo(record.id).await.unwrap().unwrap().status,
                DemoStatus::Analyzing
            );
            let page = storage
                .list_player_matches(PlayerMatchQuery {
                    steam_id: PLAYER_ID.to_owned(),
                    page: 1,
                    page_size: 20,
                })
                .await
                .expect("projection remains unpublished");
            assert_eq!(page.total, 0);
            assert_eq!(page.coverage.projected_demos, 0);
            assert_eq!(page.coverage.total_analyses, 0);
            assert!(page.coverage.projection_complete);
        }
    }

    #[tokio::test]
    async fn zero_valid_players_still_records_a_complete_projection() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        let mut result = analysis(record.id);
        result.players[0].steam_id = "BOT".to_owned();

        complete(&storage, record.id, result)
            .await
            .expect("invalid identities are excluded, not published");

        let page = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("read coverage");
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);
        assert_eq!(page.coverage.projected_demos, 1);
        assert_eq!(page.coverage.total_analyses, 1);
        assert!(page.coverage.projection_complete);
    }

    #[tokio::test]
    async fn stale_projection_state_is_incomplete_and_hidden_from_the_directory() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        complete(&storage, record.id, analysis(record.id))
            .await
            .expect("complete");
        storage
            .run(move |connection| {
                connection.execute(
                    "UPDATE player_match_projection_state \
                     SET analysis_updated_at = '2000-01-01T00:00:00Z' \
                     WHERE demo_id = ?1",
                    [record.id.to_string()],
                )?;
                Ok(())
            })
            .await
            .expect("tamper projection state");

        let page = storage
            .list_players(PlayerDirectoryQuery {
                search: None,
                page: 1,
                page_size: 20,
                sort: PlayerDirectorySort::Player,
                direction: PlayerSortDirection::Asc,
            })
            .await
            .expect("directory");
        let profile = storage
            .get_player(PLAYER_ID.to_owned())
            .await
            .expect("profile");
        let matches = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("matches");
        let comparison = storage
            .get_players([PLAYER_ID.to_owned(), PLAYER_ID.to_owned()])
            .await
            .expect("comparison");

        assert_eq!(page.coverage.projected_demos, 0);
        assert_eq!(page.coverage.total_analyses, 1);
        assert!(!page.coverage.projection_complete);
        assert_eq!(page.total, 0);
        assert!(page.items.is_empty());
        assert!(profile.is_none());
        assert_eq!(matches.total, 0);
        assert_eq!(matches.coverage, page.coverage);
        assert_eq!(comparison.players, [None, None]);
        assert_eq!(comparison.coverage, page.coverage);
    }

    #[tokio::test]
    async fn projection_with_missing_items_is_incomplete_and_hidden_from_the_directory() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        complete(&storage, record.id, analysis(record.id))
            .await
            .expect("complete");
        storage
            .run(move |connection| {
                connection.execute(
                    "DELETE FROM player_match_items WHERE demo_id = ?1",
                    [record.id.to_string()],
                )?;
                Ok(())
            })
            .await
            .expect("delete projected item");

        let page = storage
            .list_players(PlayerDirectoryQuery {
                search: None,
                page: 1,
                page_size: 20,
                sort: PlayerDirectorySort::Player,
                direction: PlayerSortDirection::Asc,
            })
            .await
            .expect("directory");
        let profile = storage
            .get_player(PLAYER_ID.to_owned())
            .await
            .expect("profile");
        let matches = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("matches");
        let comparison = storage
            .get_players([PLAYER_ID.to_owned(), PLAYER_ID.to_owned()])
            .await
            .expect("comparison");

        assert_eq!(page.coverage.projected_demos, 0);
        assert_eq!(page.coverage.total_analyses, 1);
        assert!(!page.coverage.projection_complete);
        assert_eq!(page.total, 0);
        assert!(page.items.is_empty());
        assert!(profile.is_none());
        assert_eq!(matches.total, 0);
        assert_eq!(matches.coverage, page.coverage);
        assert_eq!(comparison.players, [None, None]);
        assert_eq!(comparison.coverage, page.coverage);
    }

    #[tokio::test]
    async fn all_public_player_reads_hide_stale_projection_rows() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let valid_id = Uuid::new_v4();
        let stale_id = Uuid::new_v4();
        let mut valid_demo = demo(valid_id);
        valid_demo.created_at = "2026-08-13T16:51:52Z".parse().unwrap();
        valid_demo.updated_at = valid_demo.created_at;
        valid_demo.display_name = "Valid match".to_owned();
        let mut stale_demo = demo(stale_id);
        stale_demo.created_at = "2026-08-13T16:52:05Z".parse().unwrap();
        stale_demo.updated_at = stale_demo.created_at;
        stale_demo.path = format!("C:/matches/{stale_id}.dem");
        stale_demo.display_name = "Stale match".to_owned();
        stale_demo.content_sha256 = Some("b".repeat(64));
        storage.put_demo(valid_demo).await.expect("put valid demo");
        storage.put_demo(stale_demo).await.expect("put stale demo");
        let mut valid_analysis = analysis(valid_id);
        valid_analysis.players[0].name = "Valid FalleN".to_owned();
        complete(&storage, valid_id, valid_analysis)
            .await
            .expect("complete valid");
        let mut stale_analysis = analysis(stale_id);
        stale_analysis.players[0].name = "Stale FalleN".to_owned();
        complete(&storage, stale_id, stale_analysis)
            .await
            .expect("complete stale");
        storage
            .run(move |connection| {
                connection.execute(
                    "UPDATE player_match_projection_state \
                     SET analysis_updated_at = '2000-01-01T00:00:00Z' \
                     WHERE demo_id = ?1",
                    [stale_id.to_string()],
                )?;
                Ok(())
            })
            .await
            .expect("tamper stale projection state");

        let directory = storage
            .list_players(PlayerDirectoryQuery {
                search: None,
                page: 1,
                page_size: 20,
                sort: PlayerDirectorySort::Player,
                direction: PlayerSortDirection::Asc,
            })
            .await
            .expect("directory");
        let profile = storage
            .get_player(PLAYER_ID.to_owned())
            .await
            .expect("profile")
            .expect("valid projected player");
        let matches = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("matches");
        let comparison = storage
            .get_players([PLAYER_ID.to_owned(), PLAYER_ID.to_owned()])
            .await
            .expect("comparison");
        let stale_alias = storage
            .list_players(PlayerDirectoryQuery {
                search: Some("Stale FalleN".to_owned()),
                page: 1,
                page_size: 20,
                sort: PlayerDirectorySort::Player,
                direction: PlayerSortDirection::Asc,
            })
            .await
            .expect("stale alias search");

        assert_eq!(directory.coverage.projected_demos, 1);
        assert_eq!(directory.coverage.total_analyses, 2);
        assert!(!directory.coverage.projection_complete);
        assert_eq!(directory.items[0].name, "Valid FalleN");
        assert!(directory.items[0].aliases.is_empty());
        assert_eq!(directory.items[0].stats.matches, 1);
        assert_eq!(profile.player.name, "Valid FalleN");
        assert!(profile.player.aliases.is_empty());
        assert_eq!(profile.player.stats.matches, 1);
        assert_eq!(matches.total, 1);
        assert_eq!(matches.items[0].demo_id, valid_id);
        assert_eq!(comparison.players[0].as_ref().unwrap().name, "Valid FalleN");
        assert_eq!(comparison.players[1].as_ref().unwrap().stats.matches, 1);
        assert_eq!(stale_alias.total, 0);
        assert!(stale_alias.items.is_empty());
    }

    #[tokio::test]
    async fn directory_aggregates_real_m1_m2_m3_without_inventing_match_dates() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let fixtures = [
            (
                "ee98d419-cf81-4a3a-831f-e0e19882d3b0",
                "M1 Mirage",
                "2026-08-13T16:51:52.817524300Z",
                "de_mirage",
                (9, 14, 6, 6, 1_638, 78.0, 9.0 / 14.0),
            ),
            (
                "70330609-4b7a-44d3-9c03-47336e5e578c",
                "M2 Anubis",
                "2026-08-13T16:51:58.999300400Z",
                "de_anubis",
                (18, 15, 4, 10, 2_550, 121.428_571, 1.2),
            ),
            (
                "c4d1caa5-3d4c-4e71-9df1-3716334ed887",
                "M3 Inferno",
                "2026-08-13T16:52:05.501077Z",
                "de_inferno",
                (10, 15, 7, 5, 1_427, 67.952_381, 10.0 / 15.0),
            ),
        ];
        for (id, display_name, cataloged_at, map_name, stats) in fixtures {
            let id = Uuid::parse_str(id).expect("fixture demo id");
            let cataloged_at = cataloged_at
                .parse::<DateTime<Utc>>()
                .expect("fixture catalog time");
            let mut record = demo(id);
            record.path = format!("C:/matches/{id}.dem");
            record.file_name = format!("{id}.dem");
            record.display_name = display_name.to_owned();
            record.created_at = cataloged_at;
            record.updated_at = cataloged_at;
            storage.put_demo(record).await.expect("put demo");
            let mut result = analysis(id);
            result.map_name = map_name.to_owned();
            let player = &mut result.players[0];
            (
                player.kills,
                player.deaths,
                player.assists,
                player.headshots,
                player.damage,
                player.adr,
                player.kill_death_ratio,
            ) = stats;
            complete(&storage, id, result).await.expect("complete");
        }

        let page = storage
            .list_players(PlayerDirectoryQuery {
                search: Some("FalleN".to_owned()),
                page: 1,
                page_size: 20,
                sort: PlayerDirectorySort::LastMatch,
                direction: PlayerSortDirection::Desc,
            })
            .await
            .expect("directory page");

        assert_eq!(page.total, 1);
        assert_eq!(page.coverage.projected_demos, 3);
        assert_eq!(page.coverage.total_analyses, 3);
        assert!(page.coverage.projection_complete);
        let player = page.items.first().expect("FalleN directory row");
        assert_eq!(player.steam_id, PLAYER_ID);
        assert_eq!(player.name, "FalleN");
        assert!(player.aliases.is_empty());
        assert_eq!(player.last_team.as_deref(), Some("FURIA"));
        assert_eq!(player.last_match_date, None);
        assert_eq!(
            player.last_cataloged_at,
            "2026-08-13T16:52:05.501077Z"
                .parse::<DateTime<Utc>>()
                .unwrap()
        );
        assert_eq!(player.stats.matches, 3);
        assert_eq!(player.stats.kills, 37);
        assert_eq!(player.stats.deaths, 44);
        assert_eq!(player.stats.assists, 17);
        assert_eq!(player.stats.headshots, 21);
        assert_eq!(player.stats.damage, 5_615);
        assert!(
            (player.stats.average_adr.unwrap() - 89.126_984).abs() < 0.000_001,
            "unexpected average ADR: {:?}",
            player.stats.average_adr
        );
        assert!(
            (player.stats.average_kill_death_ratio.unwrap() - 0.836_507_936_5).abs()
                < 0.000_000_001,
            "unexpected average K/D: {:?}",
            player.stats.average_kill_death_ratio
        );

        let first_matches = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 2,
            })
            .await
            .expect("first M1/M2/M3 match page");
        let second_matches = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 2,
                page_size: 2,
            })
            .await
            .expect("second M1/M2/M3 match page");
        assert_eq!(first_matches.total, 3);
        assert_eq!(first_matches.steam_id, PLAYER_ID);
        assert_eq!(
            first_matches
                .items
                .iter()
                .map(|item| item.demo_name.as_str())
                .collect::<Vec<_>>(),
            vec!["M3 Inferno", "M2 Anubis"]
        );
        assert!(
            first_matches
                .items
                .iter()
                .all(|item| item.match_date.is_none())
        );
        assert_eq!(second_matches.items[0].demo_name, "M1 Mirage");
        assert!(second_matches.items[0].match_date.is_none());
    }

    #[tokio::test]
    async fn profile_reads_one_exact_projected_steam_identity_with_coverage() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        complete(&storage, record.id, analysis(record.id))
            .await
            .expect("complete");

        let profile = storage
            .get_player(PLAYER_ID.to_owned())
            .await
            .expect("get player")
            .expect("projected player");

        assert_eq!(profile.player.steam_id, PLAYER_ID);
        assert_eq!(profile.player.name, "FalleN");
        assert_eq!(profile.coverage.projected_demos, 1);
        assert_eq!(profile.coverage.total_analyses, 1);
        assert!(profile.coverage.projection_complete);
        assert!(
            storage
                .get_player("76561198000000001".to_owned())
                .await
                .expect("unknown lookup")
                .is_none()
        );
    }

    #[tokio::test]
    async fn trusted_match_date_updates_reorder_without_reprojection_or_changing_current_identity()
    {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let older_id = Uuid::parse_str("ee98d419-cf81-4a3a-831f-e0e19882d3b0").unwrap();
        let newer_id = Uuid::parse_str("70330609-4b7a-44d3-9c03-47336e5e578c").unwrap();
        let mut older = demo(older_id);
        older.created_at = "2026-08-13T16:51:52.817524300Z".parse().unwrap();
        older.updated_at = older.created_at;
        older.display_name = "M1 Mirage".to_owned();
        let mut newer = demo(newer_id);
        newer.created_at = "2026-08-13T16:51:58.999300400Z".parse().unwrap();
        newer.updated_at = newer.created_at;
        newer.display_name = "M2 Anubis".to_owned();
        storage.put_demo(older.clone()).await.expect("put older");
        storage.put_demo(newer.clone()).await.expect("put newer");
        let mut older_analysis = analysis(older_id);
        older_analysis.players[0].name = "Historical FalleN".to_owned();
        older_analysis.players[0].team = "Historical team".to_owned();
        complete(&storage, older_id, older_analysis)
            .await
            .expect("complete older");
        let mut newer_analysis = analysis(newer_id);
        newer_analysis.map_name = "de_anubis".to_owned();
        newer_analysis.players[0].name = "Current FalleN".to_owned();
        newer_analysis.players[0].team = "Current team".to_owned();
        complete(&storage, newer_id, newer_analysis)
            .await
            .expect("complete newer");

        let trusted_date = "2026-06-21T18:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let mut updated = storage.get_demo(older_id).await.unwrap().unwrap();
        updated.match_date = Some(trusted_date);
        storage
            .put_demo(updated)
            .await
            .expect("publish trusted date");

        let matches = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("ordered matches");
        assert_eq!(
            matches
                .items
                .iter()
                .map(|item| (item.demo_id, item.match_date))
                .collect::<Vec<_>>(),
            vec![(older_id, Some(trusted_date)), (newer_id, None)]
        );

        let directory = storage
            .list_players(PlayerDirectoryQuery {
                search: Some("Historical FalleN".to_owned()),
                page: 1,
                page_size: 20,
                sort: PlayerDirectorySort::LastMatch,
                direction: PlayerSortDirection::Desc,
            })
            .await
            .expect("alias search");
        let player = directory.items.first().expect("alias match");
        assert_eq!(player.name, "Current FalleN");
        assert_eq!(player.aliases, vec!["Historical FalleN"]);
        assert_eq!(player.last_team.as_deref(), Some("Current team"));
        assert_eq!(player.last_match_date, Some(trusted_date));
        assert_eq!(player.last_cataloged_at, newer.created_at);
    }

    #[tokio::test]
    async fn directory_sort_ties_page_stably_by_steam_id() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        let mut result = analysis(record.id);
        let template = result.players.remove(0);
        result.players = [
            "76561198000000003",
            "76561198000000001",
            "76561198000000002",
        ]
        .into_iter()
        .map(|steam_id| PlayerStats {
            steam_id: steam_id.to_owned(),
            name: "Tie".to_owned(),
            ..template.clone()
        })
        .collect();
        complete(&storage, record.id, result)
            .await
            .expect("complete");
        let query = |page| PlayerDirectoryQuery {
            search: None,
            page,
            page_size: 2,
            sort: PlayerDirectorySort::Kills,
            direction: PlayerSortDirection::Desc,
        };

        let first = storage.list_players(query(1)).await.expect("first page");
        let second = storage.list_players(query(2)).await.expect("second page");
        let repeated = storage
            .list_players(query(1))
            .await
            .expect("repeat first page");

        assert_eq!(first.total, 3);
        assert_eq!(second.total, 3);
        assert_eq!(
            first
                .items
                .iter()
                .map(|player| player.steam_id.as_str())
                .collect::<Vec<_>>(),
            vec!["76561198000000001", "76561198000000002"]
        );
        assert_eq!(second.items[0].steam_id, "76561198000000003");
        assert_eq!(first.items, repeated.items);
    }

    #[tokio::test]
    async fn directory_sorts_the_displayed_kd_and_headshot_rates_before_paging() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let lower_ratio = "76561198000000001";
        let higher_ratio = "76561198000000002";
        for (index, id) in [Uuid::new_v4(), Uuid::new_v4()].into_iter().enumerate() {
            let mut record = demo(id);
            record.path = format!("C:/matches/{id}.dem");
            storage.put_demo(record).await.expect("put demo");
            let mut result = analysis(id);
            let mut first = result.players.remove(0);
            first.steam_id = lower_ratio.to_owned();
            first.name = "Lower displayed ratios".to_owned();
            let mut second = first.clone();
            second.steam_id = higher_ratio.to_owned();
            second.name = "Higher displayed ratios".to_owned();
            if index == 0 {
                first.kills = 100;
                first.deaths = 1;
                first.headshots = 10;
                first.kill_death_ratio = 100.0;
                second.kills = 5;
                second.deaths = 5;
                second.headshots = 5;
                second.kill_death_ratio = 1.0;
            } else {
                first.kills = 0;
                first.deaths = 110;
                first.headshots = 0;
                first.kill_death_ratio = 0.0;
                second.kills = 5;
                second.deaths = 5;
                second.headshots = 0;
                second.kill_death_ratio = 1.0;
            }
            result.players = vec![first, second];
            complete(&storage, id, result).await.expect("complete");
        }
        let query = |sort| PlayerDirectoryQuery {
            search: None,
            page: 1,
            page_size: 1,
            sort,
            direction: PlayerSortDirection::Asc,
        };

        let kd = storage
            .list_players(query(PlayerDirectorySort::Kd))
            .await
            .expect("K/D page");
        let headshots = storage
            .list_players(query(PlayerDirectorySort::Headshots))
            .await
            .expect("headshot-rate page");

        assert_eq!(kd.total, 2);
        assert_eq!(kd.items[0].steam_id, lower_ratio);
        assert_eq!(headshots.total, 2);
        assert_eq!(headshots.items[0].steam_id, lower_ratio);
    }

    #[tokio::test]
    async fn directory_kd_sort_keeps_zero_zero_unknown_after_finite_and_infinite_values() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let demo_id = Uuid::new_v4();
        storage.put_demo(demo(demo_id)).await.expect("put demo");
        let mut result = analysis(demo_id);
        let mut unknown = result.players.remove(0);
        unknown.steam_id = "76561198000000001".to_owned();
        unknown.name = "Unknown K/D".to_owned();
        unknown.kills = 0;
        unknown.deaths = 0;
        unknown.kill_death_ratio = 0.0;
        let mut finite = unknown.clone();
        finite.steam_id = "76561198000000002".to_owned();
        finite.name = "Finite K/D".to_owned();
        finite.kills = 1;
        finite.deaths = 2;
        finite.kill_death_ratio = 0.5;
        let mut infinite = unknown.clone();
        infinite.steam_id = "76561198000000003".to_owned();
        infinite.name = "Infinite K/D".to_owned();
        infinite.kills = 1;
        infinite.deaths = 0;
        infinite.kill_death_ratio = 1.0;
        result.players = vec![unknown, finite, infinite];
        complete(&storage, demo_id, result).await.expect("complete");

        let query = |direction| PlayerDirectoryQuery {
            search: None,
            page: 1,
            page_size: 3,
            sort: PlayerDirectorySort::Kd,
            direction,
        };
        let ascending = storage
            .list_players(query(PlayerSortDirection::Asc))
            .await
            .expect("ascending K/D");
        let descending = storage
            .list_players(query(PlayerSortDirection::Desc))
            .await
            .expect("descending K/D");

        assert_eq!(
            ascending
                .items
                .iter()
                .map(|player| player.steam_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "76561198000000002",
                "76561198000000003",
                "76561198000000001",
            ]
        );
        assert_eq!(
            descending
                .items
                .iter()
                .map(|player| player.steam_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "76561198000000003",
                "76561198000000002",
                "76561198000000001",
            ]
        );
    }

    #[tokio::test]
    async fn directory_search_and_sort_use_literal_unicode_keys_across_pages() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let alias_id = "76561198000000001";
        let adjacent_id = "76561198000000002";
        let percent_id = "76561198000000003";
        let underscore_id = "76561198000000004";
        let older_id = Uuid::new_v4();
        let newer_id = Uuid::new_v4();
        let mut older = demo(older_id);
        older.path = format!("C:/matches/{older_id}.dem");
        older.created_at = "2026-08-13T16:51:52Z".parse().unwrap();
        older.updated_at = older.created_at;
        storage.put_demo(older).await.expect("put older");
        let mut old_analysis = analysis(older_id);
        old_analysis.players[0].steam_id = alias_id.to_owned();
        old_analysis.players[0].name = "ÉCLAIR".to_owned();
        complete(&storage, older_id, old_analysis)
            .await
            .expect("complete older");

        let mut newer = demo(newer_id);
        newer.path = format!("C:/matches/{newer_id}.dem");
        newer.created_at = "2026-08-13T16:52:05Z".parse().unwrap();
        newer.updated_at = newer.created_at;
        storage.put_demo(newer).await.expect("put newer");
        let template = analysis(newer_id).players.remove(0);
        let named = [
            (alias_id, "Åcase", "Åteam"),
            (adjacent_id, "äcase", "äteam"),
            (percent_id, "100% literal", "Literal"),
            (underscore_id, "under_score", "Literal"),
        ];
        let mut current = analysis(newer_id);
        current.players = named
            .into_iter()
            .map(|(steam_id, name, team)| PlayerStats {
                steam_id: steam_id.to_owned(),
                name: name.to_owned(),
                team: team.to_owned(),
                ..template.clone()
            })
            .collect();
        complete(&storage, newer_id, current)
            .await
            .expect("complete newer");

        let query = |search: &str, page| PlayerDirectoryQuery {
            search: Some(search.to_owned()),
            page,
            page_size: 1,
            sort: PlayerDirectorySort::Player,
            direction: PlayerSortDirection::Asc,
        };
        let alias = storage
            .list_players(query("éclair", 1))
            .await
            .expect("Unicode alias search");
        assert_eq!(alias.total, 1);
        assert_eq!(alias.items[0].steam_id, alias_id);

        let first = storage
            .list_players(query("case", 1))
            .await
            .expect("first Unicode page");
        let second = storage
            .list_players(query("case", 2))
            .await
            .expect("second Unicode page");
        assert_eq!(first.total, 2);
        assert_eq!(first.items[0].steam_id, adjacent_id);
        assert_eq!(second.items[0].steam_id, alias_id);

        let team_query = |page| PlayerDirectoryQuery {
            search: None,
            page,
            page_size: 1,
            sort: PlayerDirectorySort::Team,
            direction: PlayerSortDirection::Asc,
        };
        let first_team = storage
            .list_players(team_query(3))
            .await
            .expect("first Unicode team page after literal teams");
        let second_team = storage
            .list_players(team_query(4))
            .await
            .expect("second Unicode team page after literal teams");
        assert_eq!(first_team.total, 4);
        assert_eq!(first_team.items[0].steam_id, adjacent_id);
        assert_eq!(second_team.items[0].steam_id, alias_id);

        for (literal, expected) in [("%", percent_id), ("_", underscore_id)] {
            let page = storage
                .list_players(query(literal, 1))
                .await
                .expect("literal search");
            assert_eq!(page.total, 1, "{literal} must not be a SQL wildcard");
            assert_eq!(page.items[0].steam_id, expected);
        }
    }

    #[tokio::test]
    async fn player_responses_bound_recent_aliases_without_narrowing_alias_search() {
        const NAMES: usize = 40;
        let storage = Storage::open_in_memory().await.expect("open storage");
        let base_time = "2026-08-13T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        for index in 0..NAMES {
            let id = Uuid::new_v4();
            let mut record = demo(id);
            record.created_at = base_time + Duration::seconds(i64::try_from(index).unwrap());
            record.updated_at = record.created_at;
            storage.put_demo(record).await.expect("put alias demo");
            let mut result = analysis(id);
            result.players[0].name = format!("Alias {index:02}");
            complete(&storage, id, result)
                .await
                .expect("complete alias analysis");
        }

        let oldest_alias_search = storage
            .list_players(PlayerDirectoryQuery {
                search: Some("Alias 00".to_owned()),
                page: 1,
                page_size: 20,
                sort: PlayerDirectorySort::Player,
                direction: PlayerSortDirection::Asc,
            })
            .await
            .expect("oldest alias search");
        let profile = storage
            .get_player(PLAYER_ID.to_owned())
            .await
            .expect("profile")
            .expect("player");

        assert_eq!(oldest_alias_search.total, 1);
        let directory_player = &oldest_alias_search.items[0];
        assert_eq!(directory_player.name, "Alias 39");
        assert_eq!(directory_player.aliases.len(), 32);
        assert_eq!(directory_player.aliases_total, 39);
        assert_eq!(directory_player.aliases.first().unwrap(), "Alias 38");
        assert_eq!(directory_player.aliases.last().unwrap(), "Alias 07");
        assert_eq!(profile.player.aliases, directory_player.aliases);
        assert_eq!(profile.player.aliases_total, directory_player.aliases_total);
    }

    #[tokio::test]
    async fn last_match_sort_keeps_unknown_dates_last_in_both_directions() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let known_player = "76561198000000001";
        let unknown_player = "76561198000000002";
        for (steam_id, match_date) in [
            (
                known_player,
                Some("2026-06-21T18:00:00Z".parse::<DateTime<Utc>>().unwrap()),
            ),
            (unknown_player, None),
        ] {
            let id = Uuid::new_v4();
            let mut record = demo(id);
            record.path = format!("C:/matches/{id}.dem");
            record.match_date = match_date;
            storage.put_demo(record).await.expect("put demo");
            let mut result = analysis(id);
            result.players[0].steam_id = steam_id.to_owned();
            complete(&storage, id, result).await.expect("complete");
        }

        for direction in [PlayerSortDirection::Asc, PlayerSortDirection::Desc] {
            let page = storage
                .list_players(PlayerDirectoryQuery {
                    search: None,
                    page: 1,
                    page_size: 2,
                    sort: PlayerDirectorySort::LastMatch,
                    direction,
                })
                .await
                .expect("last-match sort");
            assert_eq!(page.items[0].steam_id, known_player);
            assert_eq!(page.items[1].steam_id, unknown_player);
            assert!(page.items[0].last_match_date.is_some());
            assert!(page.items[1].last_match_date.is_none());
        }
    }

    #[tokio::test]
    async fn projection_preserves_bounded_local_name_and_team_fallbacks() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        let mut result = analysis(record.id);
        let template = result.players.remove(0);
        result.players = vec![
            PlayerStats {
                steam_id: "76561198000000001".to_owned(),
                name: "n".repeat(MAXIMUM_PLAYER_NAME_CHARS + 1),
                team: "bad\nteam".to_owned(),
                ..template.clone()
            },
            PlayerStats {
                steam_id: "76561198000000002".to_owned(),
                name: "bad\0name".to_owned(),
                team: "t".repeat(MAXIMUM_PLAYER_TEAM_CHARS + 1),
                ..template
            },
        ];
        complete(&storage, record.id, result)
            .await
            .expect("complete");

        for steam_id in ["76561198000000001", "76561198000000002"] {
            let profile = storage
                .get_player(steam_id.to_owned())
                .await
                .expect("profile read")
                .expect("projected player");
            assert_eq!(profile.player.name, steam_id);
            assert!(profile.player.aliases.is_empty());
            assert_eq!(profile.player.last_team, None);
            let matches = storage
                .list_player_matches(PlayerMatchQuery {
                    steam_id: steam_id.to_owned(),
                    page: 1,
                    page_size: 20,
                })
                .await
                .expect("match read");
            assert_eq!(matches.items[0].team, None);
        }
        let rejected_text = storage
            .list_players(PlayerDirectoryQuery {
                search: Some("bad".to_owned()),
                page: 1,
                page_size: 20,
                sort: PlayerDirectorySort::Player,
                direction: PlayerSortDirection::Asc,
            })
            .await
            .expect("rejected text search");
        assert_eq!(rejected_text.total, 0);
    }

    #[tokio::test]
    async fn persistent_projection_queries_scale_without_reading_analysis_documents() {
        const ANALYSES: usize = 1_000;
        const PLAYERS_PER_ANALYSIS: usize = 10;
        const QUERY_CEILING: std::time::Duration = std::time::Duration::from_secs(5);

        let storage = Storage::open_in_memory().await.expect("open storage");
        let base_time = "2026-08-13T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let mut records = Vec::with_capacity(ANALYSES);
        for index in 0..ANALYSES {
            let id = Uuid::new_v4();
            let mut record = demo(id);
            record.path = format!("C:/scale/{index:04}-{id}.dem");
            record.file_name = format!("{index:04}-{id}.dem");
            record.display_name = format!("Scale match {index:04}");
            record.created_at = base_time + Duration::seconds(i64::try_from(index).unwrap());
            record.updated_at = record.created_at;
            records.push(record);
        }
        storage
            .put_demos(records.clone())
            .await
            .expect("put scale demos");
        for (analysis_index, record) in records.into_iter().enumerate() {
            let template = analysis(record.id).players.remove(0);
            let mut result = analysis(record.id);
            result.players = (1..=PLAYERS_PER_ANALYSIS)
                .map(|player_index| {
                    let steam_id = 76_561_198_000_000_000_u64
                        + u64::try_from(player_index).expect("player index");
                    PlayerStats {
                        steam_id: steam_id.to_string(),
                        name: format!("Scale Player {player_index:02}"),
                        team: format!("Team {}", player_index % 2),
                        kills: u32::try_from(analysis_index % 30 + player_index).unwrap(),
                        ..template.clone()
                    }
                })
                .collect();
            complete(&storage, record.id, result)
                .await
                .expect("complete scale analysis");
        }

        let directory_started = Instant::now();
        let directory = storage
            .list_players(PlayerDirectoryQuery {
                search: None,
                page: 1,
                page_size: 5,
                sort: PlayerDirectorySort::Kills,
                direction: PlayerSortDirection::Desc,
            })
            .await
            .expect("scale directory page");
        let directory_elapsed = directory_started.elapsed();

        let match_started = Instant::now();
        let matches = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: "76561198000000001".to_owned(),
                page: 10,
                page_size: 50,
            })
            .await
            .expect("scale exact match page");
        let match_elapsed = match_started.elapsed();

        eprintln!(
            "player projection scale gate: analyses={ANALYSES}, rows={}, directory_count_page={directory_elapsed:?}, exact_match_page={match_elapsed:?}",
            ANALYSES * PLAYERS_PER_ANALYSIS
        );
        assert_eq!(directory.total, PLAYERS_PER_ANALYSIS as u64);
        assert_eq!(directory.items.len(), 5);
        assert_eq!(directory.coverage.projected_demos, ANALYSES as u64);
        assert_eq!(directory.coverage.total_analyses, ANALYSES as u64);
        assert!(directory.coverage.projection_complete);
        assert_eq!(matches.total, ANALYSES as u64);
        assert_eq!(matches.items.len(), 50);
        assert!(
            directory_elapsed < QUERY_CEILING,
            "directory: {directory_elapsed:?}"
        );
        assert!(match_elapsed < QUERY_CEILING, "matches: {match_elapsed:?}");

        for sql in [
            PLAYER_DIRECTORY_CTE,
            EXACT_PLAYER_SQL,
            PLAYER_ALIASES_SQL,
            PLAYER_MATCH_COUNT_SQL,
            PLAYER_MATCH_PAGE_SQL,
            PLAYER_PROJECTION_COVERAGE_SQL,
        ] {
            assert!(
                !sql.contains("document_json"),
                "player read SQL must never read serialized analysis documents: {sql}"
            );
        }
        let (payload_plan, coverage_plan) = storage
            .run(|connection| {
                let count_sql = format!("{PLAYER_DIRECTORY_CTE} SELECT COUNT(*) FROM filtered");
                let page_sql = format!(
                    "{PLAYER_DIRECTORY_CTE} \
                     SELECT steam_id, current_name, current_team, last_match_date, \
                            last_cataloged_at, matches, kills, deaths, assists, headshots, damage, \
                            average_adr, average_kill_death_ratio \
                       FROM filtered ORDER BY {} LIMIT ?2 OFFSET ?3",
                    player_order_sql(PlayerDirectorySort::Kills, PlayerSortDirection::Desc)
                );
                let mut payload_plan =
                    explain_plan(connection, &count_sql, [Option::<String>::None])?;
                payload_plan.extend(explain_plan(
                    connection,
                    &page_sql,
                    params![Option::<String>::None, 5_i64, 0_i64],
                )?);
                payload_plan.extend(explain_plan(
                    connection,
                    EXACT_PLAYER_SQL,
                    params!["76561198000000001"],
                )?);
                payload_plan.extend(explain_plan(
                    connection,
                    PLAYER_ALIASES_SQL,
                    params![
                        "76561198000000001",
                        "Scale Player 01",
                        i64::from(MAXIMUM_PLAYER_ALIASES),
                    ],
                )?);
                payload_plan.extend(explain_plan(
                    connection,
                    PLAYER_MATCH_PAGE_SQL,
                    params!["76561198000000001", 50_i64, 450_i64],
                )?);
                let coverage_plan = explain_plan(connection, PLAYER_PROJECTION_COVERAGE_SQL, [])?;
                Ok((payload_plan, coverage_plan))
            })
            .await
            .expect("explain player projection reads");
        assert!(
            payload_plan.iter().any(|detail| {
                detail.contains("player_match_items") || detail.contains("player_match_player_idx")
            }),
            "player payload plans must use persistent projection rows: {payload_plan:#?}"
        );
        assert!(
            payload_plan
                .iter()
                .filter(|detail| detail.contains("SEARCH analysis"))
                .all(|detail| detail.contains("sqlite_autoindex_analyses_1")),
            "player payload validity checks must bind analyses by demo id: {payload_plan:#?}"
        );
        assert!(
            coverage_plan
                .iter()
                .any(|detail| detail.starts_with("SCAN analyses USING COVERING INDEX")),
            "coverage total must count analyses through a covering index: {coverage_plan:#?}"
        );
        assert!(
            coverage_plan
                .iter()
                .filter(|detail| detail.contains("SEARCH analysis"))
                .all(|detail| detail.contains("sqlite_autoindex_analyses_1")),
            "coverage validity must bind each analysis by demo id: {coverage_plan:#?}"
        );
    }

    #[tokio::test]
    async fn deleting_then_reanalyzing_cascades_and_replaces_player_rows() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        let mut first = analysis(record.id);
        let mut removed_player = first.players[0].clone();
        removed_player.steam_id = "76561198000000001".to_owned();
        first.players.push(removed_player);
        complete(&storage, record.id, first)
            .await
            .expect("first completion");

        assert!(storage.delete_analysis(record.id).await.unwrap());
        let removed = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("cascade read");
        assert_eq!(removed.total, 0);
        assert_eq!(removed.coverage.projected_demos, 0);
        assert_eq!(removed.coverage.total_analyses, 0);
        assert!(removed.coverage.projection_complete);

        let mut replacement = analysis(record.id);
        replacement.players[0].kills = 42;
        complete(&storage, record.id, replacement)
            .await
            .expect("replacement completion");
        let retained = storage
            .list_player_matches(PlayerMatchQuery {
                steam_id: PLAYER_ID.to_owned(),
                page: 1,
                page_size: 20,
            })
            .await
            .expect("replacement row");
        assert_eq!(retained.total, 1);
        assert_eq!(retained.items[0].kills, 42);
        assert_eq!(retained.coverage.projected_demos, 1);
        assert_eq!(retained.coverage.total_analyses, 1);
        assert!(
            storage
                .get_player("76561198000000001".to_owned())
                .await
                .expect("removed player lookup")
                .is_none()
        );
    }

    #[tokio::test]
    async fn comparison_reads_both_ordered_identities_and_coverage_in_one_projection_snapshot() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let record = demo(Uuid::new_v4());
        storage.put_demo(record.clone()).await.expect("put demo");
        let mut result = analysis(record.id);
        let mut left = result.players[0].clone();
        left.steam_id = "76561198000000002".to_owned();
        left.name = "Left".to_owned();
        result.players.push(left);
        complete(&storage, record.id, result)
            .await
            .expect("complete");

        let comparison = storage
            .get_players(["76561198000000002".to_owned(), PLAYER_ID.to_owned()])
            .await
            .expect("comparison snapshot");

        assert_eq!(
            comparison.players.map(|player| player.unwrap().steam_id),
            ["76561198000000002", PLAYER_ID]
        );
        assert_eq!(comparison.coverage.projected_demos, 1);
        assert_eq!(comparison.coverage.total_analyses, 1);
        assert!(comparison.coverage.projection_complete);
    }
}
