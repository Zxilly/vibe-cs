use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use chrono::Utc;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::{RwLock, mpsc, oneshot};
use uuid::Uuid;
use vibe_cs_application::{DemoWatchPort, DemoWatchRootStatus, DemoWatchStatus, EventHub};
use vibe_cs_demo::{DiscoveryOptions, ParseCancellation, ValidatedDemo, ValidationLimits};
use vibe_cs_domain::{DemoQuery, DemoRecord, DemoStatus, DomainError};
use vibe_cs_storage::{DemoContentIdentity, DemoContentRecovery};

const MAXIMUM_WATCH_ROOTS: usize = 64;
const MAXIMUM_DISCOVERED_DEMOS: usize = 10_000;
const DEBOUNCE_INTERVAL: Duration = Duration::from_millis(500);
const PERIODIC_RECONCILIATION: Duration = Duration::from_secs(30);
const FULL_RECONCILIATION: Duration = Duration::from_secs(30 * 60);

#[derive(Debug)]
enum WatchCommand {
    Reconfigure {
        paths: Vec<String>,
        response: oneshot::Sender<DemoWatchStatus>,
    },
    Rescan {
        response: oneshot::Sender<DemoWatchStatus>,
    },
}

/// Long-lived, hot-reloadable demo directory watcher.
#[derive(Debug)]
pub struct RuntimeDemoWatchPort {
    commands: mpsc::Sender<WatchCommand>,
    status: Arc<RwLock<DemoWatchStatus>>,
}

impl RuntimeDemoWatchPort {
    pub async fn start(
        storage: vibe_cs_storage::Storage,
        events: EventHub,
        initial_paths: Vec<String>,
    ) -> Self {
        let (commands, receiver) = mpsc::channel(32);
        let status = Arc::new(RwLock::new(DemoWatchStatus::default()));
        tokio::spawn(run_watch_loop(
            storage,
            events,
            receiver,
            Arc::clone(&status),
        ));
        let manager = Self { commands, status };
        if let Err(error) = manager.reconfigure(initial_paths).await {
            tracing::error!(%error, "unable to start demo directory watcher");
        }
        manager
    }

    async fn request(
        &self,
        command: impl FnOnce(oneshot::Sender<DemoWatchStatus>) -> WatchCommand,
    ) -> Result<DemoWatchStatus, DomainError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(command(response))
            .await
            .map_err(|_| DomainError::Internal("demo directory watcher has stopped".to_owned()))?;
        receiver.await.map_err(|_| {
            DomainError::Internal("demo directory watcher stopped before replying".to_owned())
        })
    }
}

#[async_trait]
impl DemoWatchPort for RuntimeDemoWatchPort {
    async fn reconfigure(&self, paths: Vec<String>) -> Result<DemoWatchStatus, DomainError> {
        if paths.len() > MAXIMUM_WATCH_ROOTS
            || paths
                .iter()
                .any(|path| path.trim().is_empty() || !Path::new(path).is_absolute())
        {
            return Err(DomainError::InvalidInput(format!(
                "watch configuration requires no more than {MAXIMUM_WATCH_ROOTS} absolute directories"
            )));
        }
        self.request(|response| WatchCommand::Reconfigure { paths, response })
            .await
    }

    async fn rescan(&self) -> Result<DemoWatchStatus, DomainError> {
        self.request(|response| WatchCommand::Rescan { response })
            .await
    }

    async fn status(&self) -> DemoWatchStatus {
        self.status.read().await.clone()
    }
}

async fn run_watch_loop(
    storage: vibe_cs_storage::Storage,
    events: EventHub,
    mut commands: mpsc::Receiver<WatchCommand>,
    status: Arc<RwLock<DemoWatchStatus>>,
) {
    let (notify_sender_guard, mut notify_receiver) = mpsc::channel(1_024);
    let callback_sender = notify_sender_guard.clone();
    let overflowed = Arc::new(AtomicBool::new(false));
    let callback_overflowed = Arc::clone(&overflowed);
    let mut watcher = match notify::recommended_watcher(move |event| {
        if callback_sender.try_send(event).is_err() {
            callback_overflowed.store(true, Ordering::Release);
        }
    }) {
        Ok(watcher) => Some(watcher),
        Err(error) => {
            status.write().await.last_error =
                Some(format!("watcher initialization failed: {error}"));
            None
        }
    };
    let mut requested_paths = Vec::new();
    let mut active_roots = Vec::new();
    let mut dirty = false;
    let mut changed_paths = HashSet::new();
    let mut last_change = tokio::time::Instant::now();
    let mut last_reconciliation = tokio::time::Instant::now();
    let mut last_full_reconciliation = tokio::time::Instant::now();
    let mut tick = tokio::time::interval(DEBOUNCE_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break; };
                match command {
                    WatchCommand::Reconfigure { paths, response } => {
                        requested_paths = paths;
                        active_roots = configure_roots(
                            watcher.as_mut(),
                            &active_roots,
                            &requested_paths,
                            &status,
                        ).await;
                        scan_and_update(
                            &storage,
                            &events,
                            &active_roots,
                            ScanMode::Full,
                            &status,
                        ).await;
                        events.publish("demo_watch", "configured", None);
                        let _ = response.send(status.read().await.clone());
                        last_reconciliation = tokio::time::Instant::now();
                        last_full_reconciliation = last_reconciliation;
                        dirty = false;
                        changed_paths.clear();
                    }
                    WatchCommand::Rescan { response } => {
                        active_roots = configure_roots(
                            watcher.as_mut(),
                            &active_roots,
                            &requested_paths,
                            &status,
                        ).await;
                        scan_and_update(
                            &storage,
                            &events,
                            &active_roots,
                            ScanMode::Full,
                            &status,
                        ).await;
                        let _ = response.send(status.read().await.clone());
                        last_reconciliation = tokio::time::Instant::now();
                        last_full_reconciliation = last_reconciliation;
                        dirty = false;
                        changed_paths.clear();
                    }
                }
            }
            event = notify_receiver.recv() => {
                match event {
                    Some(Ok(event)) if event.paths.iter().any(|path| is_relevant_event_path(path, &active_roots)) => {
                        status.write().await.last_event_at = Some(Utc::now());
                        changed_paths.extend(
                            event
                                .paths
                                .into_iter()
                                .filter(|path| active_roots.iter().any(|root| path.starts_with(root))),
                        );
                        dirty = true;
                        last_change = tokio::time::Instant::now();
                    }
                    Some(Ok(_)) | None => {}
                    Some(Err(error)) => {
                        let message = format!("filesystem notification failed: {error}");
                        status.write().await.last_error = Some(message.clone());
                        events.publish("demo_watch", "error", None);
                        tracing::warn!(%error, "demo filesystem notification failed");
                    }
                }
            }
            _ = tick.tick() => {
                let now = tokio::time::Instant::now();
                let notifications_overflowed = overflowed.swap(false, Ordering::AcqRel);
                if notifications_overflowed
                    || (dirty && now.duration_since(last_change) >= DEBOUNCE_INTERVAL)
                {
                    let mode = if notifications_overflowed {
                        ScanMode::Full
                    } else {
                        ScanMode::Changed(std::mem::take(&mut changed_paths))
                    };
                    scan_and_update(&storage, &events, &active_roots, mode, &status).await;
                    dirty = false;
                    last_reconciliation = now;
                    if notifications_overflowed {
                        last_full_reconciliation = now;
                    }
                } else if now.duration_since(last_reconciliation) >= PERIODIC_RECONCILIATION {
                    active_roots = configure_roots(
                        watcher.as_mut(),
                        &active_roots,
                        &requested_paths,
                        &status,
                    ).await;
                    let full = now.duration_since(last_full_reconciliation) >= FULL_RECONCILIATION;
                    scan_and_update(
                        &storage,
                        &events,
                        &active_roots,
                        if full { ScanMode::Full } else { ScanMode::Incremental },
                        &status,
                    ).await;
                    last_reconciliation = now;
                    if full {
                        last_full_reconciliation = now;
                    }
                }
            }
        }
    }

    if let Some(watcher) = watcher.as_mut() {
        for root in &active_roots {
            let _ = watcher.unwatch(root);
        }
    }
    drop(notify_sender_guard);
    status.write().await.running = false;
}

async fn configure_roots(
    mut watcher: Option<&mut RecommendedWatcher>,
    previous_roots: &[PathBuf],
    requested_paths: &[String],
    status: &RwLock<DemoWatchStatus>,
) -> Vec<PathBuf> {
    if let Some(watcher) = watcher.as_deref_mut() {
        for root in previous_roots {
            let _ = watcher.unwatch(root);
        }
    }

    let mut roots = Vec::new();
    let mut root_statuses = Vec::with_capacity(requested_paths.len());
    let mut identities = HashSet::new();
    for requested in requested_paths {
        let path = PathBuf::from(requested);
        let (state, message, active) = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => (
                "rejected",
                Some("symbolic-link watch roots are not allowed".to_owned()),
                previous_roots
                    .iter()
                    .find(|root| paths_match_lexically(root, &path))
                    .cloned(),
            ),
            Ok(metadata) if !metadata.is_dir() => (
                "rejected",
                Some("watch root is not a directory".to_owned()),
                previous_roots
                    .iter()
                    .find(|root| paths_match_lexically(root, &path))
                    .cloned(),
            ),
            Ok(_) => match std::fs::canonicalize(&path) {
                Ok(canonical) => {
                    let identity = canonical.to_string_lossy().to_lowercase();
                    if !identities.insert(identity) {
                        (
                            "duplicate",
                            Some("watch root duplicates another configured directory".to_owned()),
                            None,
                        )
                    } else if let Some(watcher) = watcher.as_deref_mut() {
                        match watcher.watch(&canonical, RecursiveMode::Recursive) {
                            Ok(()) => ("watching", None, Some(canonical)),
                            Err(error) => (
                                "error",
                                Some(format!("unable to watch directory: {error}")),
                                None,
                            ),
                        }
                    } else {
                        (
                            "error",
                            Some("filesystem watcher is unavailable".to_owned()),
                            Some(canonical),
                        )
                    }
                }
                Err(error) => (
                    "error",
                    Some(format!("unable to resolve watch directory: {error}")),
                    None,
                ),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (
                "missing",
                Some("watch directory does not exist".to_owned()),
                previous_roots
                    .iter()
                    .find(|root| paths_match_lexically(root, &path))
                    .cloned(),
            ),
            Err(error) => (
                "error",
                Some(format!("unable to inspect watch directory: {error}")),
                None,
            ),
        };
        if let Some(active) = active {
            roots.push(active);
        }
        root_statuses.push(DemoWatchRootStatus {
            path: requested.clone(),
            state: state.to_owned(),
            message,
        });
    }
    let mut current = status.write().await;
    current.running = root_statuses.iter().any(|root| root.state == "watching");
    current.roots = root_statuses;
    current.last_error = current
        .roots
        .iter()
        .find_map(|root| root.message.clone().filter(|_| root.state == "error"));
    roots
}

fn paths_match_lexically(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy();
    let right = right.to_string_lossy();
    if cfg!(windows) {
        left.strip_prefix(r"\\?\")
            .unwrap_or(&left)
            .eq_ignore_ascii_case(right.strip_prefix(r"\\?\").unwrap_or(&right))
    } else {
        left == right
    }
}

fn is_relevant_event_path(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
        && (path.extension().is_none()
            || path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("dem")))
}

#[derive(Debug, Default)]
struct ScanDelta {
    imported: u64,
    updated: u64,
    missing: u64,
    errors: Vec<String>,
}

#[derive(Debug)]
enum ScanMode {
    Full,
    Changed(HashSet<PathBuf>),
    Incremental,
}

impl ScanMode {
    fn requires_hash(&self, path: &Path) -> bool {
        match self {
            Self::Full => true,
            Self::Incremental => false,
            Self::Changed(changed) => changed.iter().any(|candidate| {
                candidate == path
                    || (candidate.extension().is_none() && path.starts_with(candidate))
            }),
        }
    }
}

async fn scan_and_update(
    storage: &vibe_cs_storage::Storage,
    events: &EventHub,
    roots: &[PathBuf],
    mode: ScanMode,
    status: &RwLock<DemoWatchStatus>,
) {
    let delta = scan_roots(storage, events, roots, mode).await;
    let mut current = status.write().await;
    current.last_scan_at = Some(Utc::now());
    current.imported = delta.imported;
    current.updated = delta.updated;
    current.missing = delta.missing;
    current.last_error = if delta.errors.is_empty() {
        current
            .roots
            .iter()
            .find_map(|root| root.message.clone().filter(|_| root.state == "error"))
    } else {
        Some(delta.errors.join("; "))
    };
    drop(current);
    events.publish(
        "demo_watch",
        if delta.errors.is_empty() {
            "scanned"
        } else {
            "scan_error"
        },
        None,
    );
}

async fn scan_roots(
    storage: &vibe_cs_storage::Storage,
    events: &EventHub,
    roots: &[PathBuf],
    mode: ScanMode,
) -> ScanDelta {
    let mut delta = ScanDelta::default();
    let (roots_for_discovery, unavailable_roots): (Vec<_>, Vec<_>) =
        roots.iter().cloned().partition(|root| {
            std::fs::symlink_metadata(root)
                .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        });
    let discovery = tokio::task::spawn_blocking(move || {
        let mut paths = Vec::new();
        let mut errors = Vec::new();
        for root in roots_for_discovery {
            if paths.len() == MAXIMUM_DISCOVERED_DEMOS {
                errors.push(format!(
                    "discovery stopped after {MAXIMUM_DISCOVERED_DEMOS} demos"
                ));
                break;
            }
            match vibe_cs_demo::discover_demos(
                &root,
                DiscoveryOptions {
                    recursive: true,
                    maximum_files: MAXIMUM_DISCOVERED_DEMOS - paths.len(),
                },
            ) {
                Ok(report) => {
                    paths.extend(report.demos);
                    errors.extend(
                        report
                            .errors
                            .into_iter()
                            .map(|error| format!("{}: {error}", root.display())),
                    );
                }
                Err(error) => errors.push(format!("{}: {error}", root.display())),
            }
        }
        paths.sort_unstable();
        paths.dedup();
        (paths, errors)
    })
    .await;
    let (paths, discovery_errors) = match discovery {
        Ok(result) => result,
        Err(error) => {
            delta
                .errors
                .push(format!("discovery worker failed: {error}"));
            return delta;
        }
    };
    delta.errors.extend(discovery_errors);

    let watched = match list_all_watched_demos(storage).await {
        Ok(watched) => watched,
        Err(error) => {
            delta.errors.push(error.to_string());
            return delta;
        }
    };
    let known = watched
        .iter()
        .map(|demo| {
            (
                demo.path.clone(),
                (demo.file_size, demo.content_sha256.is_some()),
            )
        })
        .collect::<HashMap<_, _>>();

    let validation = tokio::task::spawn_blocking(move || {
        let cancellation = ParseCancellation::default();
        paths
            .into_iter()
            .filter(|path| {
                if mode.requires_hash(path) {
                    return true;
                }
                let identity = path.to_string_lossy();
                let Some((known_size, has_hash)) = known.get(identity.as_ref()) else {
                    return true;
                };
                !has_hash
                    || std::fs::metadata(path)
                        .map_or(true, |metadata| metadata.len() != *known_size)
            })
            .map(|path| {
                let result =
                    vibe_cs_demo::validate_demo(&path, ValidationLimits::default(), &cancellation)
                        .map_err(|error| format!("{}: {error}", path.display()));
                (path, result)
            })
            .collect::<Vec<_>>()
    })
    .await;
    let validations = match validation {
        Ok(validations) => validations,
        Err(error) => {
            delta
                .errors
                .push(format!("validation worker failed: {error}"));
            return delta;
        }
    };
    for (path, validation) in validations {
        let validated = match validation {
            Ok(validated) => validated,
            Err(error) => {
                match storage
                    .get_demo_by_path(path.to_string_lossy().into_owned())
                    .await
                {
                    Ok(Some(existing)) => {
                        let observed_file_size = tokio::fs::metadata(&path)
                            .await
                            .map_or(0, |metadata| metadata.len());
                        match storage
                            .invalidate_demo_content(existing, observed_file_size)
                            .await
                        {
                            Ok(Some(invalidated)) => {
                                events.publish("demo", "invalid", Some(invalidated.id));
                            }
                            Ok(None) => {}
                            Err(storage_error) => delta.errors.push(storage_error.to_string()),
                        }
                    }
                    Ok(None) => {}
                    Err(storage_error) => delta.errors.push(storage_error.to_string()),
                }
                delta.errors.push(error);
                continue;
            }
        };
        match upsert_watched_demo(storage, validated).await {
            Ok(Some((id, changed))) => {
                if changed {
                    delta.updated = delta.updated.saturating_add(1);
                } else {
                    delta.imported = delta.imported.saturating_add(1);
                }
                events.publish("demo", "changed", Some(id));
            }
            Ok(None) => {}
            Err(error) => delta.errors.push(error.to_string()),
        }
    }

    for demo in watched {
        if demo.status != DemoStatus::Missing
            && roots
                .iter()
                .any(|root| Path::new(&demo.path).starts_with(root))
            && (unavailable_roots
                .iter()
                .any(|root| Path::new(&demo.path).starts_with(root))
                || !Path::new(&demo.path).is_file())
        {
            match storage.set_demo_status(demo.id, DemoStatus::Missing).await {
                Ok(_) => {
                    delta.missing = delta.missing.saturating_add(1);
                    events.publish("demo", "missing", Some(demo.id));
                }
                Err(error) => delta.errors.push(error.to_string()),
            }
        }
    }
    delta
}

async fn upsert_watched_demo(
    storage: &vibe_cs_storage::Storage,
    validated: ValidatedDemo,
) -> Result<Option<(Uuid, bool)>, vibe_cs_storage::StorageError> {
    let path = validated.path.to_string_lossy().into_owned();
    if let Some(existing) = storage.get_demo_by_path(path).await? {
        let content_changed = existing.file_size != validated.size
            || existing.content_sha256.as_deref() != Some(validated.sha256.as_str());
        if !content_changed && existing.status != DemoStatus::Missing && existing.source == "watch"
        {
            return Ok(None);
        }
        let mut record = demo_record(validated, "watch");
        record.id = existing.id;
        record.created_at = existing.created_at;
        record.display_name = existing.display_name;
        record.remark = existing.remark;
        if !content_changed {
            record.map_name = existing.map_name;
            record.match_date = existing.match_date;
            record.duration_seconds = existing.duration_seconds;
            record.total_rounds = existing.total_rounds;
            record.team_a_name = existing.team_a_name;
            record.team_b_name = existing.team_b_name;
            record.team_a_score = existing.team_a_score;
            record.team_b_score = existing.team_b_score;
            record.player_names = existing.player_names;
            record.status = if existing.status == DemoStatus::Missing {
                DemoStatus::Discovered
            } else {
                existing.status
            };
        }
        if content_changed {
            storage.replace_demo_content(record.clone()).await?;
        } else {
            storage.put_demo(record.clone()).await?;
        }
        return Ok(Some((record.id, true)));
    }
    let record = demo_record(validated, "watch");
    let outcome = storage.put_content_addressed_demo(record.clone()).await?;
    if outcome.was_inserted() {
        Ok(Some((record.id, false)))
    } else if outcome.demo().path == record.path {
        Ok(Some((outcome.demo().id, true)))
    } else {
        let existing = outcome.into_demo();
        if demo_file_matches_catalog(&existing).await {
            return Ok(None);
        }
        let recovered = storage
            .recover_content_addressed_demo(DemoContentRecovery {
                expected: DemoContentIdentity {
                    id: existing.id,
                    path: existing.path,
                    status: existing.status,
                    content_sha256: existing.content_sha256.unwrap_or_default(),
                    file_size: existing.file_size,
                },
                verified_path: record.path,
                verified_file_name: record.file_name,
                verified_size: record.file_size,
                verified_sha256: record.content_sha256.unwrap_or_default(),
            })
            .await?;
        Ok(recovered.map(|demo| (demo.id, true)))
    }
}

async fn demo_file_matches_catalog(demo: &DemoRecord) -> bool {
    if demo.status == DemoStatus::Missing {
        return false;
    }
    let Some(expected_hash) = demo.content_sha256.clone() else {
        return false;
    };
    let expected_size = demo.file_size;
    let path = PathBuf::from(&demo.path);
    tokio::task::spawn_blocking(move || {
        vibe_cs_demo::validate_demo(
            &path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .is_ok_and(|validated| validated.size == expected_size && validated.sha256 == expected_hash)
    })
    .await
    .unwrap_or(false)
}

fn demo_record(validated: ValidatedDemo, source: &str) -> DemoRecord {
    let file_name = validated
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("match.dem")
        .to_owned();
    let display_name = validated
        .path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(&file_name)
        .to_owned();
    let now = Utc::now();
    DemoRecord {
        id: Uuid::new_v4(),
        path: validated.path.to_string_lossy().into_owned(),
        file_name,
        display_name,
        source: source.to_owned(),
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
        content_sha256: Some(validated.sha256),
        file_size: validated.size,
        created_at: now,
        updated_at: now,
    }
}

async fn list_all_watched_demos(
    storage: &vibe_cs_storage::Storage,
) -> Result<Vec<DemoRecord>, vibe_cs_storage::StorageError> {
    let mut demos = Vec::new();
    let mut page_number = 1_u32;
    loop {
        let page = storage
            .list_demos(DemoQuery {
                source: Some("watch".to_owned()),
                page: Some(page_number),
                page_size: Some(200),
                ..DemoQuery::default()
            })
            .await?;
        let empty = page.items.is_empty();
        demos.extend(page.items);
        if empty || u64::from(page_number) * u64::from(page.page_size) >= page.total {
            break;
        }
        page_number = page_number.saturating_add(1);
    }
    Ok(demos)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn wait_for(
        mut condition: impl FnMut() -> std::pin::Pin<Box<dyn Future<Output = bool>>>,
    ) {
        for _ in 0..30 {
            if condition().await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("condition was not reached before timeout");
    }

    use std::future::Future;

    #[tokio::test]
    async fn watcher_imports_changes_marks_missing_and_restores() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let watcher = RuntimeDemoWatchPort::start(
            storage.clone(),
            EventHub::default(),
            vec![directory.path().to_string_lossy().into_owned()],
        )
        .await;
        assert!(watcher.status().await.running);

        let demo = directory.path().join("watched.dem");
        std::fs::write(&demo, b"PBDEMS2\0version1").expect("write demo");
        wait_for(|| {
            let storage = storage.clone();
            Box::pin(async move {
                storage
                    .list_demos(DemoQuery::default())
                    .await
                    .is_ok_and(|page| page.total == 1)
            })
        })
        .await;
        let record = storage
            .list_demos(DemoQuery::default())
            .await
            .expect("demos")
            .items
            .remove(0);
        let unchanged = watcher.rescan().await.expect("unchanged rescan");
        assert_eq!(unchanged.imported, 0);
        assert_eq!(unchanged.updated, 0);
        assert_eq!(
            storage
                .get_demo(record.id)
                .await
                .expect("demo")
                .expect("record")
                .updated_at,
            record.updated_at
        );
        storage
            .set_demo_status(record.id, DemoStatus::Ready)
            .await
            .expect("ready");

        std::fs::write(&demo, b"NOTADEMOinvalid!").expect("write invalid replacement");
        wait_for(|| {
            let storage = storage.clone();
            Box::pin(async move {
                storage
                    .get_demo(record.id)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|demo| demo.status == DemoStatus::Failed)
            })
        })
        .await;
        std::fs::write(&demo, b"PBDEMS2\0version2").expect("write valid replacement");
        wait_for(|| {
            let storage = storage.clone();
            Box::pin(async move {
                storage
                    .get_demo(record.id)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|demo| demo.status == DemoStatus::Discovered)
            })
        })
        .await;
        let mut summarized = storage
            .get_demo(record.id)
            .await
            .expect("demo")
            .expect("record");
        summarized.status = DemoStatus::Ready;
        summarized.player_names = vec!["FalleN".to_owned(), "m0NESY".to_owned()];
        storage.put_demo(summarized).await.expect("ready summary");

        std::fs::remove_file(&demo).expect("remove demo");
        wait_for(|| {
            let storage = storage.clone();
            Box::pin(async move {
                storage
                    .get_demo(record.id)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|demo| demo.status == DemoStatus::Missing)
            })
        })
        .await;

        std::fs::write(&demo, b"PBDEMS2\0version2").expect("restore demo");
        wait_for(|| {
            let storage = storage.clone();
            Box::pin(async move {
                storage
                    .get_demo(record.id)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|demo| demo.status == DemoStatus::Discovered)
            })
        })
        .await;
        assert_eq!(
            storage
                .get_demo(record.id)
                .await
                .expect("demo")
                .expect("record")
                .player_names,
            vec!["FalleN", "m0NESY"]
        );
    }

    #[tokio::test]
    async fn hot_reload_switches_watched_directories_and_rejects_files() {
        let first = tempfile::tempdir().expect("first directory");
        let second = tempfile::tempdir().expect("second directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let watcher = RuntimeDemoWatchPort::start(
            storage.clone(),
            EventHub::default(),
            vec![first.path().to_string_lossy().into_owned()],
        )
        .await;
        let status = watcher
            .reconfigure(vec![second.path().to_string_lossy().into_owned()])
            .await
            .expect("reconfigure");
        assert_eq!(status.roots[0].state, "watching");

        std::fs::write(first.path().join("ignored.dem"), b"PBDEMS2\0ignored!")
            .expect("write ignored demo");
        std::fs::write(second.path().join("accepted.dem"), b"PBDEMS2\0accepted")
            .expect("write accepted demo");
        wait_for(|| {
            let storage = storage.clone();
            Box::pin(async move {
                storage
                    .list_demos(DemoQuery::default())
                    .await
                    .is_ok_and(|page| page.total == 1)
            })
        })
        .await;
        assert!(
            storage
                .list_demos(DemoQuery::default())
                .await
                .expect("demos")
                .items[0]
                .path
                .contains("accepted.dem")
        );

        let file_root = second.path().join("accepted.dem");
        let status = watcher
            .reconfigure(vec![file_root.to_string_lossy().into_owned()])
            .await
            .expect("file root status");
        assert_eq!(status.roots[0].state, "rejected");
        assert!(!status.running);
    }

    #[tokio::test]
    async fn deleting_and_recreating_a_watch_root_reconciles_records() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let root = parent.path().join("watched");
        std::fs::create_dir(&root).expect("watch root");
        let path = root.join("match.dem");
        std::fs::write(&path, b"PBDEMS2\0rootdemo").expect("demo");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let watcher = RuntimeDemoWatchPort::start(
            storage.clone(),
            EventHub::default(),
            vec![root.to_string_lossy().into_owned()],
        )
        .await;
        let record = storage
            .list_demos(DemoQuery::default())
            .await
            .expect("demos")
            .items
            .remove(0);
        storage
            .set_demo_status(record.id, DemoStatus::Ready)
            .await
            .expect("ready");

        std::fs::remove_file(&path).expect("remove demo");
        std::fs::remove_dir(&root).expect("remove root");
        let status = watcher.rescan().await.expect("scan missing root");
        assert_eq!(status.roots[0].state, "missing");
        assert_eq!(
            storage
                .get_demo(record.id)
                .await
                .expect("demo")
                .expect("record")
                .status,
            DemoStatus::Missing
        );

        std::fs::write(&root, b"not a directory").expect("replace root with file");
        let status = watcher.rescan().await.expect("scan rejected root");
        assert_eq!(status.roots[0].state, "rejected");
        std::fs::remove_file(&root).expect("remove replacement file");
        std::fs::create_dir(&root).expect("restore root");
        std::fs::write(&path, b"PBDEMS2\0rootdemo").expect("restore demo");
        let status = watcher.rescan().await.expect("scan restored root");
        assert_eq!(status.roots[0].state, "watching");
        assert_eq!(
            storage
                .get_demo(record.id)
                .await
                .expect("demo")
                .expect("record")
                .status,
            DemoStatus::Discovered
        );
    }

    #[tokio::test]
    async fn dropping_the_manager_stops_the_actor() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let watcher = RuntimeDemoWatchPort::start(
            storage,
            EventHub::default(),
            vec![directory.path().to_string_lossy().into_owned()],
        )
        .await;
        let status = Arc::clone(&watcher.status);
        drop(watcher);
        for _ in 0..20 {
            if !status.read().await.running {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("watch actor did not shut down");
    }
}
