use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    path::PathBuf,
    sync::Arc,
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use tokio::{
    sync::{Mutex, RwLock},
    time::Instant,
};
use url::Url;
use vibe_cs_api::{
    AvatarCacheCleanup, AvatarCacheStatus, PlayerAggregateStats, PlayerAvatar, PlayerDirectoryItem,
    PlayerDirectoryPage, PlayerDirectoryQuery, PlayerPort, PlayerProfile, PlayerRecentMatch,
    PlayerSteamProfile, SteamProfileState,
};
use vibe_cs_domain::{DemoQuery, DemoRecord, DomainError, MatchAnalysis, PlayerStats};
use vibe_cs_integrations::{
    IntegrationError, SecretString, SteamAvatarImage, SteamPlayerProfilePort, SteamPlayerSummary,
    SteamProfileClient, is_steam_id,
};

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::avatar_cache::AvatarCache;

const MAXIMUM_DIRECTORY_DEMOS: usize = 1_000;
const DEMO_PAGE_SIZE: u32 = 200;
const MAXIMUM_PLAYER_PAGE_SIZE: u32 = 100;
const MAXIMUM_PLAYER_PAGE: u32 = 10_000;
const MAXIMUM_SEARCH_CHARS: usize = 128;
const MAXIMUM_RECENT_MATCHES: usize = 20;
const MAXIMUM_LOCAL_NAME_CHARS: usize = 128;
const MAXIMUM_DEMO_NAME_CHARS: usize = 256;
const PLAYER_CATALOG_TTL: std::time::Duration = std::time::Duration::from_secs(5);

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
    catalog_cache: Arc<RwLock<Option<CachedPlayerCatalog>>>,
    catalog_refresh: Arc<Mutex<()>>,
    #[cfg(test)]
    catalog_builds: Arc<AtomicUsize>,
}

#[derive(Debug, Clone)]
struct PlayerCatalog {
    players: Vec<LocalPlayer>,
    scanned_demos: u32,
    scan_complete: bool,
}

#[derive(Debug, Clone)]
struct CachedPlayerCatalog {
    inserted_at: Instant,
    catalog: Arc<PlayerCatalog>,
}

#[derive(Debug, Clone)]
struct LocalPlayer {
    steam_id: String,
    name: String,
    aliases: Vec<String>,
    last_team: Option<String>,
    last_match_at: DateTime<Utc>,
    stats: PlayerAggregateStats,
    recent_matches: Vec<PlayerRecentMatch>,
}

#[derive(Debug, Default)]
struct PlayerAccumulator {
    names: BTreeSet<String>,
    latest_name: Option<String>,
    latest_team: Option<String>,
    latest_at: Option<DateTime<Utc>>,
    matches: u32,
    kills: u64,
    deaths: u64,
    assists: u64,
    headshots: u64,
    damage: u64,
    adr_total: f64,
    adr_samples: u32,
    rating_total: f64,
    rating_samples: u32,
    recent_matches: Vec<PlayerRecentMatch>,
}

impl RuntimePlayerPort {
    #[must_use]
    pub fn new(storage: vibe_cs_storage::Storage, avatar_cache_dir: PathBuf) -> Self {
        Self {
            storage,
            backend: Arc::new(SystemPlayerBackend),
            avatar_cache: AvatarCache::new(avatar_cache_dir),
            catalog_cache: Arc::new(RwLock::new(None)),
            catalog_refresh: Arc::new(Mutex::new(())),
            #[cfg(test)]
            catalog_builds: Arc::new(AtomicUsize::new(0)),
        }
    }

    #[cfg(test)]
    fn with_backend(mut self, backend: Arc<dyn RuntimePlayerBackend>) -> Self {
        self.backend = backend;
        self
    }

    async fn catalog(&self) -> Result<Arc<PlayerCatalog>, DomainError> {
        if let Some(catalog) = self.fresh_cached_catalog().await {
            return Ok(catalog);
        }
        let _refresh = self.catalog_refresh.lock().await;
        if let Some(catalog) = self.fresh_cached_catalog().await {
            return Ok(catalog);
        }
        let catalog = Arc::new(self.build_catalog().await?);
        *self.catalog_cache.write().await = Some(CachedPlayerCatalog {
            inserted_at: Instant::now(),
            catalog: Arc::clone(&catalog),
        });
        Ok(catalog)
    }

    async fn fresh_cached_catalog(&self) -> Option<Arc<PlayerCatalog>> {
        self.catalog_cache
            .read()
            .await
            .as_ref()
            .filter(|cached| cached.inserted_at.elapsed() < PLAYER_CATALOG_TTL)
            .map(|cached| Arc::clone(&cached.catalog))
    }

    async fn build_catalog(&self) -> Result<PlayerCatalog, DomainError> {
        #[cfg(test)]
        self.catalog_builds.fetch_add(1, Ordering::SeqCst);
        let mut demos = Vec::with_capacity(MAXIMUM_DIRECTORY_DEMOS);
        let mut total = 0_u64;
        for page in 1..=5 {
            let batch = self
                .storage
                .list_demos(DemoQuery {
                    page: Some(page),
                    page_size: Some(DEMO_PAGE_SIZE),
                    ..DemoQuery::default()
                })
                .await
                .map_err(|error| storage_error(&error))?;
            total = batch.total;
            if batch.items.is_empty() {
                break;
            }
            let remaining = MAXIMUM_DIRECTORY_DEMOS.saturating_sub(demos.len());
            demos.extend(batch.items.into_iter().take(remaining));
            if demos.len() >= MAXIMUM_DIRECTORY_DEMOS {
                break;
            }
        }

        let scanned_demos = u32::try_from(demos.len()).unwrap_or(u32::MAX);
        let mut players = BTreeMap::<String, PlayerAccumulator>::new();
        for demo in demos {
            let Some(analysis) = self
                .storage
                .get_analysis(demo.id)
                .await
                .map_err(|error| storage_error(&error))?
            else {
                continue;
            };
            aggregate_analysis(&mut players, &demo, &analysis);
        }
        let mut players = players
            .into_iter()
            .filter_map(|(steam_id, accumulator)| finish_player(steam_id, accumulator))
            .collect::<Vec<_>>();
        players.sort_by(|left, right| {
            right
                .last_match_at
                .cmp(&left.last_match_at)
                .then_with(|| left.steam_id.cmp(&right.steam_id))
        });
        Ok(PlayerCatalog {
            players,
            scanned_demos,
            scan_complete: total <= u64::try_from(MAXIMUM_DIRECTORY_DEMOS).unwrap_or(u64::MAX),
        })
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

    async fn require_local_player(&self, steam_id: &str) -> Result<LocalPlayer, DomainError> {
        validate_steam_id(steam_id)?;
        self.catalog()
            .await?
            .players
            .iter()
            .find(|player| player.steam_id == steam_id)
            .cloned()
            .ok_or_else(|| DomainError::NotFound("player".to_owned()))
    }
}

#[async_trait]
impl PlayerPort for RuntimePlayerPort {
    async fn list(&self, query: PlayerDirectoryQuery) -> Result<PlayerDirectoryPage, DomainError> {
        let (page, page_size, search) = validate_query(query)?;
        let catalog = self.catalog().await?;
        let mut filtered = catalog
            .players
            .iter()
            .filter(|player| player_matches(player, search.as_deref()))
            .cloned()
            .collect::<Vec<_>>();
        let total = u64::try_from(filtered.len()).unwrap_or(u64::MAX);
        let offset = u64::from(page.saturating_sub(1)).saturating_mul(u64::from(page_size));
        let offset = usize::try_from(offset).unwrap_or(usize::MAX);
        let take = usize::try_from(page_size).unwrap_or(usize::MAX);
        let selected = if offset >= filtered.len() {
            Vec::new()
        } else {
            filtered.drain(offset..).take(take).collect::<Vec<_>>()
        };
        let mut items = selected.into_iter().map(local_item).collect::<Vec<_>>();
        self.enrich(&mut items).await?;
        Ok(PlayerDirectoryPage {
            items,
            total,
            page,
            page_size,
            scanned_demos: catalog.scanned_demos,
            scan_complete: catalog.scan_complete,
        })
    }

    async fn get(&self, steam_id: String) -> Result<PlayerProfile, DomainError> {
        validate_steam_id(&steam_id)?;
        let catalog = self.catalog().await?;
        let local = catalog
            .players
            .iter()
            .find(|player| player.steam_id == steam_id)
            .cloned()
            .ok_or_else(|| DomainError::NotFound("player".to_owned()))?;
        let mut recent_matches = local.recent_matches.clone();
        recent_matches.truncate(MAXIMUM_RECENT_MATCHES);
        let mut items = vec![local_item(local)];
        self.enrich(&mut items).await?;
        Ok(PlayerProfile {
            player: items.remove(0),
            recent_matches,
            scanned_demos: catalog.scanned_demos,
            scan_complete: catalog.scan_complete,
        })
    }

    async fn avatar(&self, steam_id: String) -> Result<PlayerAvatar, DomainError> {
        let _ = self.require_local_player(&steam_id).await?;
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

fn aggregate_analysis(
    players: &mut BTreeMap<String, PlayerAccumulator>,
    demo: &DemoRecord,
    analysis: &MatchAnalysis,
) {
    let played_at = demo.match_date.unwrap_or(demo.created_at);
    let mut seen = HashSet::new();
    for stats in &analysis.players {
        if !is_steam_id(&stats.steam_id) || !seen.insert(stats.steam_id.clone()) {
            continue;
        }
        let accumulator = players.entry(stats.steam_id.clone()).or_default();
        let name = bounded_local_text(&stats.name, MAXIMUM_LOCAL_NAME_CHARS)
            .unwrap_or_else(|| stats.steam_id.clone());
        accumulator.names.insert(name.clone());
        if accumulator
            .latest_at
            .is_none_or(|latest| played_at > latest)
        {
            accumulator.latest_at = Some(played_at);
            accumulator.latest_name = Some(name);
            accumulator.latest_team = bounded_local_text(&stats.team, 32);
        }
        accumulator.matches = accumulator.matches.saturating_add(1);
        accumulator.kills = accumulator.kills.saturating_add(u64::from(stats.kills));
        accumulator.deaths = accumulator.deaths.saturating_add(u64::from(stats.deaths));
        accumulator.assists = accumulator.assists.saturating_add(u64::from(stats.assists));
        accumulator.headshots = accumulator
            .headshots
            .saturating_add(u64::from(stats.headshots));
        accumulator.damage = accumulator.damage.saturating_add(u64::from(stats.damage));
        add_average_sample(
            stats.adr,
            &mut accumulator.adr_total,
            &mut accumulator.adr_samples,
        );
        add_average_sample(
            stats.rating,
            &mut accumulator.rating_total,
            &mut accumulator.rating_samples,
        );
        accumulator
            .recent_matches
            .push(recent_match(demo, stats, played_at));
    }
}

fn add_average_sample(value: f64, total: &mut f64, samples: &mut u32) {
    if value.is_finite() {
        *total += value;
        *samples = samples.saturating_add(1);
    }
}

fn recent_match(
    demo: &DemoRecord,
    stats: &PlayerStats,
    played_at: DateTime<Utc>,
) -> PlayerRecentMatch {
    PlayerRecentMatch {
        demo_id: demo.id,
        demo_name: bounded_local_text(&demo.display_name, MAXIMUM_DEMO_NAME_CHARS)
            .or_else(|| bounded_local_text(&demo.file_name, MAXIMUM_DEMO_NAME_CHARS))
            .unwrap_or_else(|| demo.id.to_string()),
        map_name: demo
            .map_name
            .as_deref()
            .and_then(|value| bounded_local_text(value, 64)),
        played_at,
        team: bounded_local_text(&stats.team, 32),
        kills: stats.kills,
        deaths: stats.deaths,
        assists: stats.assists,
        headshots: stats.headshots,
        damage: stats.damage,
        adr: stats.adr.is_finite().then_some(stats.adr),
        rating: stats.rating.is_finite().then_some(stats.rating),
    }
}

fn finish_player(steam_id: String, mut accumulator: PlayerAccumulator) -> Option<LocalPlayer> {
    let last_match_at = accumulator.latest_at?;
    accumulator.recent_matches.sort_by(|left, right| {
        right
            .played_at
            .cmp(&left.played_at)
            .then_with(|| left.demo_id.cmp(&right.demo_id))
    });
    let name = accumulator.latest_name.unwrap_or_else(|| steam_id.clone());
    let aliases = accumulator
        .names
        .into_iter()
        .filter(|alias| alias != &name)
        .collect();
    Some(LocalPlayer {
        steam_id,
        name,
        aliases,
        last_team: accumulator.latest_team,
        last_match_at,
        stats: PlayerAggregateStats {
            matches: accumulator.matches,
            kills: accumulator.kills,
            deaths: accumulator.deaths,
            assists: accumulator.assists,
            headshots: accumulator.headshots,
            damage: accumulator.damage,
            average_adr: average(accumulator.adr_total, accumulator.adr_samples),
            average_rating: average(accumulator.rating_total, accumulator.rating_samples),
        },
        recent_matches: accumulator.recent_matches,
    })
}

fn average(total: f64, samples: u32) -> Option<f64> {
    (samples > 0)
        .then(|| total / f64::from(samples))
        .filter(|value| value.is_finite())
}

fn local_item(player: LocalPlayer) -> PlayerDirectoryItem {
    PlayerDirectoryItem {
        steam_id: player.steam_id,
        name: player.name,
        aliases: player.aliases,
        last_team: player.last_team,
        last_match_at: player.last_match_at,
        stats: player.stats,
        steam: PlayerSteamProfile::not_configured(),
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

fn validate_query(query: PlayerDirectoryQuery) -> Result<(u32, u32, Option<String>), DomainError> {
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
    Ok((page, page_size, search))
}

fn player_matches(player: &LocalPlayer, search: Option<&str>) -> bool {
    let Some(search) = search else {
        return true;
    };
    let search = search.to_lowercase();
    player.steam_id.contains(&search)
        || player.name.to_lowercase().contains(&search)
        || player
            .aliases
            .iter()
            .any(|alias| alias.to_lowercase().contains(&search))
}

fn bounded_local_text(value: &str, maximum_chars: usize) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.chars().count() <= maximum_chars
        && !value.contains(['\r', '\n', '\0']))
    .then(|| value.to_owned())
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
    use vibe_cs_domain::{AppConfig, DemoStatus, PlayerStats, TeamSummary};

    use super::*;

    const PLAYER_ID: &str = "76561198000000001";

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
        let id = Uuid::new_v4();
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
                remark: String::new(),
                content_sha256: Some("a".repeat(64)),
                file_size: 1,
                created_at: played_at,
                updated_at: played_at,
            })
            .await
            .expect("demo");
        storage
            .put_analysis(MatchAnalysis {
                demo_id: id,
                map_name: "de_test".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 60.0,
                teams: vec![TeamSummary {
                    name: "T".to_owned(),
                    side: "T".to_owned(),
                    score: 1,
                    players: vec![PLAYER_ID.to_owned()],
                }],
                players: vec![PlayerStats {
                    steam_id: PLAYER_ID.to_owned(),
                    name: name.to_owned(),
                    team: "T".to_owned(),
                    kills,
                    deaths: 5,
                    assists: 2,
                    headshots: 4,
                    damage: kills * 100,
                    adr: f64::from(kills),
                    rating: 1.0,
                    score: 0,
                }],
                rounds: Vec::new(),
                highlights: Vec::new(),
            })
            .await
            .expect("analysis");
    }

    #[tokio::test]
    async fn local_directory_aggregates_stable_ids_and_recent_matches() {
        let (port, backend, _temporary) = fixture(false).await;
        let page = port
            .list(PlayerDirectoryQuery {
                search: Some("old name".to_owned()),
                page: Some(1),
                page_size: Some(10),
            })
            .await
            .expect("directory");

        assert_eq!(page.total, 1);
        assert_eq!(page.scanned_demos, 2);
        assert_eq!(page.items[0].name, "New Name");
        assert_eq!(page.items[0].stats.matches, 2);
        assert_eq!(page.items[0].stats.kills, 30);
        assert_eq!(page.items[0].steam.state, SteamProfileState::NotConfigured);
        assert_eq!(backend.summary_calls.load(Ordering::SeqCst), 0);
        let profile = port.get(PLAYER_ID.to_owned()).await.expect("profile");
        assert_eq!(profile.recent_matches.len(), 2);
        assert!(profile.recent_matches[0].played_at > profile.recent_matches[1].played_at);
        assert_eq!(port.catalog_builds.load(Ordering::SeqCst), 1);
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
