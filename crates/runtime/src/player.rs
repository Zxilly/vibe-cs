use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use url::Url;
use vibe_cs_application::{
    AvatarCacheCleanup, AvatarCacheStatus, PlayerAggregateStats, PlayerAvatar, PlayerComparison,
    PlayerComparisonQuery, PlayerDirectoryItem, PlayerDirectoryPage, PlayerDirectoryQuery,
    PlayerDirectorySort, PlayerDirectorySortDirection, PlayerMapItem, PlayerMapPage,
    PlayerMapQuery, PlayerMatch, PlayerMatchPage, PlayerMatchQuery, PlayerPort, PlayerProfile,
    PlayerProjectionCoverage, PlayerSteamProfile, SteamProfileState,
};
use vibe_cs_domain::DomainError;
use vibe_cs_integrations::{
    IntegrationError, SecretString, SteamAvatarImage, SteamPlayerProfilePort, SteamPlayerSummary,
    SteamProfileClient, is_steam_id,
};
use vibe_cs_storage::{
    PlayerDirectoryQuery as StoragePlayerDirectoryQuery,
    PlayerDirectorySort as StoragePlayerDirectorySort, PlayerMapQuery as StoragePlayerMapQuery,
    PlayerMatchQuery as StoragePlayerMatchQuery,
    PlayerProjectionCoverage as StoragePlayerProjectionCoverage,
    PlayerSortDirection as StoragePlayerSortDirection, ProjectedPlayer, ProjectedPlayerMap,
    ProjectedPlayerMatch,
};

use crate::avatar_cache::AvatarCache;

const MAXIMUM_PLAYER_PAGE_SIZE: u32 = 100;
const MAXIMUM_PLAYER_PAGE: u32 = 10_000;
const MAXIMUM_SEARCH_CHARS: usize = 128;

#[async_trait]
trait RuntimePlayerBackend: Send + Sync + std::fmt::Debug {
    async fn summaries(
        &self,
        api_key: SecretString,
        steam_ids: &[String],
    ) -> Result<Vec<SteamPlayerSummary>, IntegrationError>;
    async fn avatar(
        &self,
        api_key: SecretString,
        url: &Url,
    ) -> Result<SteamAvatarImage, IntegrationError>;
}

#[derive(Debug, Default)]
struct SystemPlayerBackend;

#[async_trait]
impl RuntimePlayerBackend for SystemPlayerBackend {
    async fn summaries(
        &self,
        api_key: SecretString,
        steam_ids: &[String],
    ) -> Result<Vec<SteamPlayerSummary>, IntegrationError> {
        SteamProfileClient::new(api_key)?.summaries(steam_ids).await
    }

    async fn avatar(
        &self,
        api_key: SecretString,
        url: &Url,
    ) -> Result<SteamAvatarImage, IntegrationError> {
        SteamProfileClient::new(api_key)?.avatar(url).await
    }
}

#[derive(Debug, Clone)]
pub struct RuntimePlayerPort {
    storage: vibe_cs_storage::Storage,
    backend: Arc<dyn RuntimePlayerBackend>,
    avatar_cache: AvatarCache,
}

impl RuntimePlayerPort {
    #[must_use]
    pub fn new(storage: vibe_cs_storage::Storage, avatar_cache_dir: PathBuf) -> Self {
        Self {
            storage,
            backend: Arc::new(SystemPlayerBackend),
            avatar_cache: AvatarCache::new(avatar_cache_dir),
        }
    }

    #[cfg(test)]
    fn with_backend(mut self, backend: Arc<dyn RuntimePlayerBackend>) -> Self {
        self.backend = backend;
        self
    }

    async fn steam_api_key(&self) -> Result<Option<SecretString>, DomainError> {
        let key = self
            .storage
            .get_config()
            .await
            .map_err(|error| storage_error(&error))?
            .unwrap_or_default()
            .steam
            .web_api_key;
        let key = key.trim();
        Ok((!key.is_empty()).then(|| SecretString::new(key)))
    }

    async fn enrich(&self, players: &mut [PlayerDirectoryItem]) -> Result<(), DomainError> {
        let Some(api_key) = self.steam_api_key().await? else {
            return Ok(());
        };
        let ids = players
            .iter()
            .map(|player| player.steam_id.clone())
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(());
        }
        let summaries = match self.backend.summaries(api_key, &ids).await {
            Ok(summaries) => summaries,
            Err(error) => {
                tracing::warn!(%error, "Steam player profile enrichment failed");
                for player in players {
                    player.steam = PlayerSteamProfile::unavailable(
                        "Steam public profile is temporarily unavailable",
                    );
                }
                return Ok(());
            }
        };
        let summaries = summaries
            .into_iter()
            .map(|summary| (summary.steam_id.clone(), summary))
            .collect::<BTreeMap<_, _>>();
        for player in players {
            player.steam = summaries.get(&player.steam_id).map_or_else(
                || PlayerSteamProfile::unavailable("Steam did not return a public profile"),
                summary_profile,
            );
        }
        Ok(())
    }

    async fn require_local_player(&self, steam_id: &str) -> Result<(), DomainError> {
        validate_steam_id(steam_id)?;
        let projected = self
            .storage
            .get_players([steam_id.to_owned(), steam_id.to_owned()])
            .await
            .map_err(|error| storage_error(&error))?;
        require_projected_player(projected.players[0].as_ref(), projected.coverage, "player")?;
        Ok(())
    }
}

#[async_trait]
impl PlayerPort for RuntimePlayerPort {
    async fn list(&self, query: PlayerDirectoryQuery) -> Result<PlayerDirectoryPage, DomainError> {
        let (page, page_size, search, sort, direction) = validate_query(query)?;
        let projected = self
            .storage
            .list_players(StoragePlayerDirectoryQuery {
                search,
                page,
                page_size,
                sort: storage_sort(sort),
                direction: storage_direction(direction),
            })
            .await
            .map_err(|error| storage_error(&error))?;
        let mut items = projected
            .items
            .into_iter()
            .map(projected_player)
            .collect::<Vec<_>>();
        self.enrich(&mut items).await?;
        Ok(PlayerDirectoryPage {
            items,
            total: projected.total,
            page: projected.page,
            page_size: projected.page_size,
            coverage: projection_coverage(projected.coverage),
        })
    }

    async fn get(&self, steam_id: String) -> Result<PlayerProfile, DomainError> {
        validate_steam_id(&steam_id)?;
        let projected = self
            .storage
            .get_players([steam_id.clone(), steam_id])
            .await
            .map_err(|error| storage_error(&error))?;
        let player =
            require_projected_player(projected.players[0].as_ref(), projected.coverage, "player")?
                .clone();
        let mut items = vec![projected_player(player)];
        self.enrich(&mut items).await?;
        Ok(PlayerProfile {
            player: items.remove(0),
            coverage: projection_coverage(projected.coverage),
        })
    }

    async fn matches(
        &self,
        steam_id: String,
        query: PlayerMatchQuery,
    ) -> Result<PlayerMatchPage, DomainError> {
        validate_steam_id(&steam_id)?;
        let (page, page_size) = validate_match_query(&query)?;
        let requested_steam_id = steam_id.clone();
        let projected = self
            .storage
            .list_player_matches(StoragePlayerMatchQuery {
                steam_id,
                page,
                page_size,
            })
            .await
            .map_err(|error| storage_error(&error))?;
        if projected.total == 0 {
            return Err(exact_player_absence(projected.coverage, "player"));
        }
        Ok(PlayerMatchPage {
            steam_id: requested_steam_id,
            items: projected.items.into_iter().map(projected_match).collect(),
            total: projected.total,
            page: projected.page,
            page_size: projected.page_size,
            coverage: projection_coverage(projected.coverage),
        })
    }

    async fn maps(
        &self,
        steam_id: String,
        query: PlayerMapQuery,
    ) -> Result<PlayerMapPage, DomainError> {
        validate_steam_id(&steam_id)?;
        let (page, page_size) = validate_map_query(&query)?;
        let requested_steam_id = steam_id.clone();
        let projected = self
            .storage
            .list_player_maps(StoragePlayerMapQuery {
                steam_id,
                page,
                page_size,
            })
            .await
            .map_err(|error| storage_error(&error))?;
        if projected.total == 0 {
            return Err(exact_player_absence(projected.coverage, "player"));
        }
        Ok(PlayerMapPage {
            steam_id: requested_steam_id,
            items: projected.items.into_iter().map(projected_map).collect(),
            total: projected.total,
            page: projected.page,
            page_size: projected.page_size,
            coverage: projection_coverage(projected.coverage),
        })
    }

    async fn compare(&self, query: PlayerComparisonQuery) -> Result<PlayerComparison, DomainError> {
        validate_steam_id(&query.left)?;
        validate_steam_id(&query.right)?;
        if query.left == query.right {
            return Err(DomainError::InvalidInput(
                "player comparison requires two different Steam IDs".to_owned(),
            ));
        }

        let projected = self
            .storage
            .get_players([query.left.clone(), query.right.clone()])
            .await
            .map_err(|error| storage_error(&error))?;
        let [left, right] = projected.players;
        let left = require_projected_player(
            left.as_ref(),
            projected.coverage,
            &format!("player {}", query.left),
        )?
        .clone();
        let right = require_projected_player(
            right.as_ref(),
            projected.coverage,
            &format!("player {}", query.right),
        )?
        .clone();
        let mut players = [projected_player(left), projected_player(right)];
        self.enrich(&mut players).await?;
        Ok(PlayerComparison {
            players,
            coverage: projection_coverage(projected.coverage),
        })
    }

    async fn avatar(&self, steam_id: String) -> Result<PlayerAvatar, DomainError> {
        self.require_local_player(&steam_id).await?;
        let api_key = self.steam_api_key().await?.ok_or_else(|| {
            DomainError::DependencyUnavailable(
                "Steam avatar is unavailable until a Web API key is configured".to_owned(),
            )
        })?;
        let backend = Arc::clone(&self.backend);
        let id = steam_id.clone();
        self.avatar_cache
            .resolve(&steam_id, move || async move {
                let summaries = backend
                    .summaries(api_key.clone(), std::slice::from_ref(&id))
                    .await
                    .map_err(integration_error)?;
                let url = summaries
                    .into_iter()
                    .find(|summary| summary.steam_id == id)
                    .and_then(|summary| summary.avatar_url)
                    .ok_or_else(|| {
                        DomainError::DependencyUnavailable(
                            "Steam did not return a trusted avatar for this player".to_owned(),
                        )
                    })?;
                backend
                    .avatar(api_key, &url)
                    .await
                    .map_err(integration_error)
            })
            .await
    }

    async fn avatar_cache_status(&self) -> Result<AvatarCacheStatus, DomainError> {
        self.avatar_cache.status().await
    }

    async fn clear_avatar_cache(&self) -> Result<AvatarCacheCleanup, DomainError> {
        self.avatar_cache.clear().await
    }
}

fn projected_match(projected: ProjectedPlayerMatch) -> PlayerMatch {
    PlayerMatch {
        demo_id: projected.demo_id,
        demo_name: projected.demo_name,
        map_name: projected.map_name,
        match_date: projected.match_date,
        cataloged_at: projected.cataloged_at,
        team: projected.team,
        kills: projected.kills,
        deaths: projected.deaths,
        assists: projected.assists,
        headshots: projected.headshots,
        damage: projected.damage,
        adr: projected.adr,
        kill_death_ratio: projected.kill_death_ratio,
    }
}

fn projected_map(projected: ProjectedPlayerMap) -> PlayerMapItem {
    PlayerMapItem {
        map_name: projected.map_name,
        stats: PlayerAggregateStats {
            matches: projected.stats.matches,
            kills: projected.stats.kills,
            deaths: projected.stats.deaths,
            assists: projected.stats.assists,
            headshots: projected.stats.headshots,
            damage: projected.stats.damage,
            average_adr: projected.stats.average_adr,
            average_kill_death_ratio: projected.stats.average_kill_death_ratio,
        },
    }
}

fn projected_player(player: ProjectedPlayer) -> PlayerDirectoryItem {
    PlayerDirectoryItem {
        steam_id: player.steam_id,
        name: player.name,
        aliases: player.aliases,
        aliases_total: player.aliases_total,
        last_team: player.last_team,
        last_match_date: player.last_match_date,
        last_cataloged_at: player.last_cataloged_at,
        stats: PlayerAggregateStats {
            matches: player.stats.matches,
            kills: player.stats.kills,
            deaths: player.stats.deaths,
            assists: player.stats.assists,
            headshots: player.stats.headshots,
            damage: player.stats.damage,
            average_adr: player.stats.average_adr,
            average_kill_death_ratio: player.stats.average_kill_death_ratio,
        },
        steam: PlayerSteamProfile::not_configured(),
    }
}

const fn projection_coverage(
    coverage: StoragePlayerProjectionCoverage,
) -> PlayerProjectionCoverage {
    PlayerProjectionCoverage {
        projected_demos: coverage.projected_demos,
        total_analyses: coverage.total_analyses,
        projection_complete: coverage.projection_complete,
    }
}

fn require_projected_player<'a, T>(
    player: Option<&'a T>,
    coverage: StoragePlayerProjectionCoverage,
    resource: &str,
) -> Result<&'a T, DomainError> {
    player.ok_or_else(|| exact_player_absence(coverage, resource))
}

fn exact_player_absence(coverage: StoragePlayerProjectionCoverage, resource: &str) -> DomainError {
    if coverage.projection_complete {
        DomainError::NotFound(resource.to_owned())
    } else {
        DomainError::DependencyUnavailable(
            "player projection is incomplete; exact player absence cannot be proven".to_owned(),
        )
    }
}

fn summary_profile(summary: &SteamPlayerSummary) -> PlayerSteamProfile {
    PlayerSteamProfile {
        state: SteamProfileState::Available,
        persona_name: Some(summary.persona_name.clone()),
        real_name: summary.real_name.clone(),
        profile_url: summary.profile_url.as_ref().map(ToString::to_string),
        country_code: summary.country_code.clone(),
        persona_state: summary.persona_state,
        last_logoff: unix_time(summary.last_logoff),
        created_at: unix_time(summary.created_at),
        avatar_url: summary
            .avatar_url
            .as_ref()
            .map(|_| format!("/api/players/{}/avatar", summary.steam_id)),
        reason: None,
    }
}

fn unix_time(value: Option<u64>) -> Option<DateTime<Utc>> {
    value
        .and_then(|value| i64::try_from(value).ok())
        .and_then(|seconds| DateTime::from_timestamp(seconds, 0))
}

fn validate_query(
    query: PlayerDirectoryQuery,
) -> Result<
    (
        u32,
        u32,
        Option<String>,
        PlayerDirectorySort,
        PlayerDirectorySortDirection,
    ),
    DomainError,
> {
    let page = query.page.unwrap_or(1);
    let page_size = query.page_size.unwrap_or(50);
    if page == 0 || page > MAXIMUM_PLAYER_PAGE {
        return Err(DomainError::InvalidInput(format!(
            "page must be between 1 and {MAXIMUM_PLAYER_PAGE}"
        )));
    }
    if page_size == 0 || page_size > MAXIMUM_PLAYER_PAGE_SIZE {
        return Err(DomainError::InvalidInput(format!(
            "page_size must be between 1 and {MAXIMUM_PLAYER_PAGE_SIZE}"
        )));
    }
    let search = query
        .search
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if search
        .as_ref()
        .is_some_and(|value| value.chars().count() > MAXIMUM_SEARCH_CHARS)
    {
        return Err(DomainError::InvalidInput(format!(
            "search must not exceed {MAXIMUM_SEARCH_CHARS} characters"
        )));
    }
    Ok((page, page_size, search, query.sort, query.direction))
}

fn validate_match_query(query: &PlayerMatchQuery) -> Result<(u32, u32), DomainError> {
    query.validate()?;
    Ok((query.page, query.page_size))
}

fn validate_map_query(query: &PlayerMapQuery) -> Result<(u32, u32), DomainError> {
    query.validate()?;
    Ok((query.page, query.page_size))
}

const fn storage_sort(sort: PlayerDirectorySort) -> StoragePlayerDirectorySort {
    match sort {
        PlayerDirectorySort::Player => StoragePlayerDirectorySort::Player,
        PlayerDirectorySort::Team => StoragePlayerDirectorySort::Team,
        PlayerDirectorySort::Matches => StoragePlayerDirectorySort::Matches,
        PlayerDirectorySort::Kd => StoragePlayerDirectorySort::Kd,
        PlayerDirectorySort::Kills => StoragePlayerDirectorySort::Kills,
        PlayerDirectorySort::Deaths => StoragePlayerDirectorySort::Deaths,
        PlayerDirectorySort::Assists => StoragePlayerDirectorySort::Assists,
        PlayerDirectorySort::Headshots => StoragePlayerDirectorySort::Headshots,
        PlayerDirectorySort::Adr => StoragePlayerDirectorySort::Adr,
        PlayerDirectorySort::Damage => StoragePlayerDirectorySort::Damage,
        PlayerDirectorySort::LastMatch => StoragePlayerDirectorySort::LastMatch,
    }
}

const fn storage_direction(direction: PlayerDirectorySortDirection) -> StoragePlayerSortDirection {
    match direction {
        PlayerDirectorySortDirection::Asc => StoragePlayerSortDirection::Asc,
        PlayerDirectorySortDirection::Desc => StoragePlayerSortDirection::Desc,
    }
}

fn validate_steam_id(steam_id: &str) -> Result<(), DomainError> {
    if is_steam_id(steam_id) {
        Ok(())
    } else {
        Err(DomainError::InvalidInput(
            "Steam ID must contain exactly 17 digits".to_owned(),
        ))
    }
}

fn storage_error(error: &vibe_cs_storage::StorageError) -> DomainError {
    DomainError::Internal(format!("player directory storage failed: {error}"))
}

fn integration_error(error: IntegrationError) -> DomainError {
    match error {
        IntegrationError::InvalidInput(message)
        | IntegrationError::InvalidConfiguration(message) => DomainError::InvalidInput(message),
        IntegrationError::NotConfigured { message, .. } => {
            DomainError::DependencyUnavailable(message)
        }
        _ => DomainError::DependencyUnavailable(
            "Steam public profile service is unavailable".to_owned(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use chrono::Duration;
    use tempfile::TempDir;
    use uuid::Uuid;
    use vibe_cs_domain::{
        AppConfig, DemoRecord, DemoStatus, MatchAnalysis, PlayerStats, TeamSummary,
    };

    use super::*;

    const PLAYER_ID: &str = "76561198000000001";

    async fn persist_completed_analysis(
        storage: &vibe_cs_storage::Storage,
        analysis: MatchAnalysis,
    ) -> vibe_cs_storage::Result<()> {
        let demo = storage
            .get_demo(analysis.demo_id)
            .await?
            .expect("fixture demo");
        let fingerprint = vibe_cs_domain::AnalysisInputFingerprint {
            sha256: demo.content_sha256.expect("fixture fingerprint"),
            size: demo.file_size,
        };
        storage
            .set_demo_status(demo.id, DemoStatus::Discovered)
            .await?;
        let run_id = storage.start_analysis_run(demo.id).await?.run.id;
        storage
            .bind_analysis_run_input(run_id, fingerprint.clone())
            .await?;
        storage.mark_analysis_parser_started(run_id).await?;
        storage
            .mark_analysis_input_revalidation_started(run_id)
            .await?;
        storage.mark_analysis_projection_started(run_id).await?;
        storage
            .complete_analysis_run(run_id, analysis, fingerprint)
            .await
            .map(|_| ())
    }

    #[derive(Debug)]
    struct FakeBackend {
        summary_calls: AtomicUsize,
        avatar_calls: AtomicUsize,
    }

    #[async_trait]
    impl RuntimePlayerBackend for FakeBackend {
        async fn summaries(
            &self,
            _api_key: SecretString,
            steam_ids: &[String],
        ) -> Result<Vec<SteamPlayerSummary>, IntegrationError> {
            self.summary_calls.fetch_add(1, Ordering::SeqCst);
            Ok(steam_ids
                .iter()
                .map(|steam_id| SteamPlayerSummary {
                    steam_id: steam_id.clone(),
                    persona_name: "Public Player".to_owned(),
                    profile_url: Url::parse(&format!(
                        "https://steamcommunity.com/profiles/{steam_id}/"
                    ))
                    .ok(),
                    avatar_url: Url::parse("https://avatars.steamstatic.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_full.jpg").ok(),
                    real_name: None,
                    country_code: Some("CN".to_owned()),
                    persona_state: Some(1),
                    last_logoff: None,
                    created_at: None,
                })
                .collect())
        }

        async fn avatar(
            &self,
            _api_key: SecretString,
            _url: &Url,
        ) -> Result<SteamAvatarImage, IntegrationError> {
            self.avatar_calls.fetch_add(1, Ordering::SeqCst);
            Ok(SteamAvatarImage {
                bytes: vec![0xff, 0xd8, 0xff, 1],
                mime_type: "image/jpeg",
            })
        }
    }

    async fn fixture(configured: bool) -> (RuntimePlayerPort, Arc<FakeBackend>, TempDir) {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        if configured {
            let mut config = AppConfig::default();
            config.steam.web_api_key = "secret".to_owned();
            storage.put_config(config).await.expect("config");
        }
        let temporary = TempDir::new().expect("temp dir");
        let backend = Arc::new(FakeBackend {
            summary_calls: AtomicUsize::new(0),
            avatar_calls: AtomicUsize::new(0),
        });
        let port = RuntimePlayerPort::new(storage.clone(), temporary.path().join("avatar-cache"))
            .with_backend(backend.clone());
        let older = Utc::now() - Duration::days(2);
        let newer = Utc::now() - Duration::days(1);
        put_match(&storage, older, "Old Name", 10).await;
        put_match(&storage, newer, "New Name", 20).await;
        (port, backend, temporary)
    }

    async fn put_match(
        storage: &vibe_cs_storage::Storage,
        played_at: DateTime<Utc>,
        name: &str,
        kills: u32,
    ) {
        put_player_match(storage, played_at, PLAYER_ID, name, kills).await;
    }

    async fn put_player_match(
        storage: &vibe_cs_storage::Storage,
        played_at: DateTime<Utc>,
        steam_id: &str,
        name: &str,
        kills: u32,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let id_hex = id.simple().to_string();
        storage
            .put_demo(DemoRecord {
                id,
                path: format!("{id}.dem"),
                file_name: format!("{id}.dem"),
                display_name: format!("Match {kills}"),
                source: "test".to_owned(),
                status: DemoStatus::Ready,
                map_name: Some("de_test".to_owned()),
                match_date: Some(played_at),
                duration_seconds: Some(60.0),
                total_rounds: Some(1),
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: Vec::new(),
                remark: String::new(),
                content_sha256: Some(format!("{id_hex}{id_hex}")),
                file_size: 1,
                created_at: played_at,
                updated_at: played_at,
            })
            .await
            .expect("demo");
        persist_completed_analysis(
            storage,
            MatchAnalysis {
                demo_id: id,
                map_name: "de_test".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 60.0,
                verified_total_ticks: None,
                teams: vec![TeamSummary {
                    name: "T".to_owned(),
                    side: "T".to_owned(),
                    score: 1,
                    players: vec![steam_id.to_owned()],
                }],
                players: vec![PlayerStats {
                    steam_id: steam_id.to_owned(),
                    spectator_slot: None,
                    name: name.to_owned(),
                    team: "T".to_owned(),
                    kills,
                    deaths: 5,
                    assists: 2,
                    headshots: 4,
                    damage: kills * 100,
                    adr: f64::from(kills),
                    kill_death_ratio: 1.0,
                    score: 0,
                }],
                rounds: Vec::new(),
                highlights: Vec::new(),
            },
        )
        .await
        .expect("analysis");
        id
    }

    #[tokio::test]
    async fn local_directory_aggregates_stable_ids_and_player_matches() {
        let (port, backend, _temporary) = fixture(false).await;
        let page = port
            .list(PlayerDirectoryQuery {
                search: Some("old name".to_owned()),
                page: Some(1),
                page_size: Some(10),
                sort: PlayerDirectorySort::LastMatch,
                direction: PlayerDirectorySortDirection::Desc,
            })
            .await
            .expect("directory");

        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].aliases_total, 1);
        assert_eq!(page.coverage.projected_demos, 2);
        assert_eq!(page.coverage.total_analyses, 2);
        assert!(page.coverage.projection_complete);
        assert_eq!(page.items[0].name, "New Name");
        assert_eq!(page.items[0].stats.matches, 2);
        assert_eq!(page.items[0].stats.kills, 30);
        assert_eq!(page.items[0].steam.state, SteamProfileState::NotConfigured);
        assert_eq!(backend.summary_calls.load(Ordering::SeqCst), 0);
        let profile = port.get(PLAYER_ID.to_owned()).await.expect("profile");
        assert_eq!(profile.player.stats.matches, 2);
        let matches = port
            .matches(
                PLAYER_ID.to_owned(),
                PlayerMatchQuery {
                    page: 1,
                    page_size: 20,
                },
            )
            .await
            .expect("matches");
        assert_eq!(matches.items.len(), 2);
        assert!(matches.items[0].match_date > matches.items[1].match_date);
    }

    #[tokio::test]
    async fn player_matches_page_is_windowed_by_the_complete_projection() {
        let (port, _, _temporary) = fixture(false).await;
        let newest = Utc::now();
        for index in 0..23 {
            put_match(
                &port.storage,
                newest - Duration::minutes(i64::from(index)),
                "Current Name",
                30 + index,
            )
            .await;
        }

        let page = port
            .matches(
                PLAYER_ID.to_owned(),
                PlayerMatchQuery {
                    page: 2,
                    page_size: 20,
                },
            )
            .await
            .expect("second player match page");

        assert_eq!(page.total, 25);
        assert_eq!(page.steam_id, PLAYER_ID);
        assert_eq!(page.page, 2);
        assert_eq!(page.page_size, 20);
        assert_eq!(page.items.len(), 5);
        assert_eq!(
            page.items.iter().map(|item| item.kills).collect::<Vec<_>>(),
            vec![50, 51, 52, 20, 10]
        );
        assert_eq!(page.coverage.projected_demos, 25);
        assert_eq!(page.coverage.total_analyses, 25);
        assert!(page.coverage.projection_complete);
    }

    #[tokio::test]
    async fn player_matches_reject_invalid_input_and_a_projection_missing_player() {
        let (port, _, _temporary) = fixture(false).await;
        let query = || PlayerMatchQuery {
            page: 1,
            page_size: 20,
        };

        assert!(matches!(
            port.matches("not-a-steam-id".to_owned(), query()).await,
            Err(DomainError::InvalidInput(_))
        ));
        assert!(matches!(
            port.matches(
                PLAYER_ID.to_owned(),
                PlayerMatchQuery {
                    page: 0,
                    page_size: 20,
                },
            )
            .await,
            Err(DomainError::InvalidInput(_))
        ));
        assert!(matches!(
            port.matches("76561198000000999".to_owned(), query()).await,
            Err(DomainError::NotFound(resource)) if resource == "player"
        ));
    }

    #[tokio::test]
    async fn exact_player_absence_is_not_not_found_until_projection_coverage_is_complete() {
        let temporary = TempDir::new().expect("temp dir");
        let database_path = temporary.path().join("players.sqlite");
        let storage = vibe_cs_storage::Storage::open(&database_path)
            .await
            .expect("storage");
        put_player_match(
            &storage,
            Utc::now() - Duration::days(1),
            PLAYER_ID,
            "Stale Player",
            10,
        )
        .await;
        rusqlite::Connection::open(&database_path)
            .expect("tamper connection")
            .execute(
                "UPDATE player_match_projection_state \
                 SET analysis_updated_at = '2000-01-01T00:00:00Z'",
                [],
            )
            .expect("tamper projection state");
        let port = RuntimePlayerPort::new(storage, temporary.path().join("avatar-cache"));
        let missing = "76561198000000999";

        assert!(matches!(
            port.get(PLAYER_ID.to_owned()).await,
            Err(DomainError::DependencyUnavailable(_))
        ));
        assert!(matches!(
            port.matches(
                PLAYER_ID.to_owned(),
                PlayerMatchQuery {
                    page: 1,
                    page_size: 20,
                },
            )
            .await,
            Err(DomainError::DependencyUnavailable(_))
        ));
        assert!(matches!(
            port.compare(PlayerComparisonQuery {
                left: PLAYER_ID.to_owned(),
                right: missing.to_owned(),
            })
            .await,
            Err(DomainError::DependencyUnavailable(_))
        ));

        let complete_storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("complete empty storage");
        let complete_port = RuntimePlayerPort::new(
            complete_storage,
            temporary.path().join("complete-avatar-cache"),
        );
        assert!(matches!(
            complete_port.get(PLAYER_ID.to_owned()).await,
            Err(DomainError::NotFound(resource)) if resource == "player"
        ));
        assert!(matches!(
            complete_port
                .matches(
                    PLAYER_ID.to_owned(),
                    PlayerMatchQuery {
                        page: 1,
                        page_size: 20,
                    },
                )
                .await,
            Err(DomainError::NotFound(resource)) if resource == "player"
        ));
    }

    #[tokio::test]
    async fn comparison_uses_one_projection_snapshot_and_one_ordered_enrichment() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let mut config = AppConfig::default();
        config.steam.web_api_key = "secret".to_owned();
        storage.put_config(config).await.expect("config");
        let temporary = TempDir::new().expect("temp dir");
        let backend = Arc::new(FakeBackend {
            summary_calls: AtomicUsize::new(0),
            avatar_calls: AtomicUsize::new(0),
        });
        let port = RuntimePlayerPort::new(storage.clone(), temporary.path().join("avatar-cache"))
            .with_backend(backend.clone());
        let older = Utc::now() - Duration::days(2);
        let newer = Utc::now() - Duration::days(1);
        let left = "76561198000000002";
        let right = PLAYER_ID;
        put_player_match(&storage, older, right, "Right", 10).await;
        put_player_match(&storage, newer, left, "Left", 20).await;

        let comparison = port
            .compare(PlayerComparisonQuery {
                left: left.to_owned(),
                right: right.to_owned(),
            })
            .await
            .expect("comparison");

        assert_eq!(
            comparison
                .players
                .iter()
                .map(|player| player.steam_id.as_str())
                .collect::<Vec<_>>(),
            [left, right]
        );
        assert_eq!(comparison.coverage.projected_demos, 2);
        assert_eq!(comparison.coverage.total_analyses, 2);
        assert!(comparison.coverage.projection_complete);
        assert_eq!(backend.summary_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn comparison_rejects_invalid_duplicate_and_missing_players_without_partial_results() {
        let (port, _, _temporary) = fixture(false).await;
        let missing = "76561198000000999";

        for query in [
            PlayerComparisonQuery {
                left: "not-a-steam-id".to_owned(),
                right: PLAYER_ID.to_owned(),
            },
            PlayerComparisonQuery {
                left: PLAYER_ID.to_owned(),
                right: PLAYER_ID.to_owned(),
            },
        ] {
            assert!(matches!(
                port.compare(query).await,
                Err(DomainError::InvalidInput(_))
            ));
        }
        assert!(matches!(
            port.compare(PlayerComparisonQuery {
                left: PLAYER_ID.to_owned(),
                right: missing.to_owned(),
            })
            .await,
            Err(DomainError::NotFound(resource)) if resource.contains(missing)
        ));
    }

    #[tokio::test]
    async fn directory_sorts_the_filtered_projection_before_pagination() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let temporary = TempDir::new().expect("temp dir");
        let backend = Arc::new(FakeBackend {
            summary_calls: AtomicUsize::new(0),
            avatar_calls: AtomicUsize::new(0),
        });
        let port = RuntimePlayerPort::new(storage.clone(), temporary.path().join("avatar-cache"))
            .with_backend(backend);
        let played_at = Utc::now() - Duration::days(1);
        put_player_match(&storage, played_at, "76561198000000002", "Higher", 30).await;
        put_player_match(
            &storage,
            played_at - Duration::minutes(1),
            PLAYER_ID,
            "Lower",
            10,
        )
        .await;

        let page = port
            .list(PlayerDirectoryQuery {
                search: None,
                page: Some(1),
                page_size: Some(1),
                sort: PlayerDirectorySort::Kills,
                direction: PlayerDirectorySortDirection::Asc,
            })
            .await
            .expect("sorted directory");

        assert_eq!(page.total, 2);
        assert_eq!(page.items[0].steam_id, PLAYER_ID);
    }

    #[tokio::test]
    async fn configured_profiles_and_avatar_cache_use_backend_truthfully() {
        let (port, backend, _temporary) = fixture(true).await;
        let profile = port.get(PLAYER_ID.to_owned()).await.expect("profile");
        assert_eq!(profile.player.steam.state, SteamProfileState::Available);
        assert_eq!(
            profile.player.steam.avatar_url.as_deref(),
            Some("/api/players/76561198000000001/avatar")
        );
        let first = port.avatar(PLAYER_ID.to_owned()).await.expect("avatar");
        let second = port
            .avatar(PLAYER_ID.to_owned())
            .await
            .expect("cached avatar");
        assert!(!first.cached);
        assert!(second.cached);
        assert_eq!(backend.avatar_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn invalid_ids_and_unbounded_queries_are_rejected() {
        let (port, _, _temporary) = fixture(false).await;
        assert!(matches!(
            port.get("not-a-steam-id".to_owned()).await,
            Err(DomainError::InvalidInput(_))
        ));
        assert!(matches!(
            port.list(PlayerDirectoryQuery {
                search: None,
                page: Some(1),
                page_size: Some(101),
                sort: PlayerDirectorySort::LastMatch,
                direction: PlayerDirectorySortDirection::Desc,
            })
            .await,
            Err(DomainError::InvalidInput(_))
        ));
        assert!(matches!(
            port.avatar(PLAYER_ID.to_owned()).await,
            Err(DomainError::DependencyUnavailable(_))
        ));
    }
}
