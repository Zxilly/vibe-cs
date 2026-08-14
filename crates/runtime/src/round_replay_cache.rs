use std::{future::Future, path::PathBuf, sync::Arc};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use vibe_cs_domain::{DomainError, RoundReplayArtifact, RoundReplayRequest};

const MAXIMUM_ENTRY_BYTES: u64 = 128 * 1024 * 1024;
const MAXIMUM_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAXIMUM_CACHE_ENTRIES: usize = 128;

#[derive(Debug, Clone)]
pub(crate) struct RoundReplayCache {
    root: PathBuf,
    gate: Arc<Mutex<()>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CacheDocument {
    key: String,
    generated_at: DateTime<Utc>,
    artifact: RoundReplayArtifact,
}

impl RoundReplayCache {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            gate: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) async fn resolve<F, Fut>(
        &self,
        request: &RoundReplayRequest,
        generate: F,
    ) -> Result<RoundReplayArtifact, DomainError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<RoundReplayArtifact, DomainError>>,
    {
        let _guard = self.gate.lock().await;
        tokio::fs::create_dir_all(&self.root)
            .await
            .map_err(|error| {
                DomainError::Internal(format!("unable to create round replay cache: {error}"))
            })?;
        let key = cache_key(request)?;
        let path = self.root.join(format!("{key}.round.json"));
        let mut repaired = false;
        if path.is_file() {
            if let Ok(artifact) = read_document(&path, &key, request).await {
                return Ok(artifact);
            }
            tokio::fs::remove_file(&path).await.map_err(|error| {
                DomainError::CleanupFailed(format!(
                    "corrupt round replay cache entry could not be removed: {error}"
                ))
            })?;
            repaired = true;
        }
        let artifact = generate().await?;
        validate_artifact(&artifact, request)?;
        let document = CacheDocument {
            key: key.clone(),
            generated_at: Utc::now(),
            artifact,
        };
        let bytes = serde_json::to_vec(&document).map_err(|error| {
            DomainError::Internal(format!("unable to encode round replay cache: {error}"))
        })?;
        if bytes.len() > usize::try_from(MAXIMUM_ENTRY_BYTES).unwrap_or(usize::MAX) {
            return Err(DomainError::InvalidInput(
                "round replay cache entry exceeds its byte budget".to_owned(),
            ));
        }
        let temporary = self
            .root
            .join(format!(".{key}.{}.partial", uuid::Uuid::new_v4()));
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|error| {
                DomainError::Internal(format!(
                    "unable to create round replay cache entry: {error}"
                ))
            })?;
        let write_result = async {
            file.write_all(&bytes).await?;
            file.flush().await?;
            file.sync_all().await
        }
        .await;
        drop(file);
        if let Err(error) = write_result {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(DomainError::Internal(format!(
                "unable to persist round replay cache: {error}"
            )));
        }
        if let Err(error) = tokio::fs::rename(&temporary, &path).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(DomainError::Internal(format!(
                "unable to publish round replay cache: {error}"
            )));
        }
        prune(&self.root, &path).await?;
        let artifact = document.artifact;
        if repaired {
            tracing::warn!(%key, "repaired a corrupt selected-round replay cache entry");
        }
        Ok(artifact)
    }
}

fn cache_key(request: &RoundReplayRequest) -> Result<String, DomainError> {
    let bytes = serde_json::to_vec(request).map_err(|error| {
        DomainError::Internal(format!("unable to encode round replay key: {error}"))
    })?;
    let mut digest = Sha256::new();
    digest.update(b"round-replay-contract-v2\0");
    digest.update(bytes);
    Ok(hex::encode(digest.finalize()))
}

async fn read_document(
    path: &PathBuf,
    key: &str,
    request: &RoundReplayRequest,
) -> Result<RoundReplayArtifact, DomainError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| DomainError::Internal(error.to_string()))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_ENTRY_BYTES {
        return Err(DomainError::InvalidInput(
            "invalid round replay cache entry".to_owned(),
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    tokio::fs::File::open(path)
        .await
        .map_err(|error| DomainError::Internal(error.to_string()))?
        .take(MAXIMUM_ENTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| DomainError::Internal(error.to_string()))?;
    let document: CacheDocument = serde_json::from_slice(&bytes).map_err(|error| {
        DomainError::InvalidInput(format!("invalid round replay cache JSON: {error}"))
    })?;
    if document.key != key {
        return Err(DomainError::InvalidInput(
            "round replay cache key mismatch".to_owned(),
        ));
    }
    validate_artifact(&document.artifact, request)?;
    Ok(document.artifact)
}

fn validate_artifact(
    artifact: &RoundReplayArtifact,
    request: &RoundReplayRequest,
) -> Result<(), DomainError> {
    let metadata = &artifact.metadata;
    if metadata.producer_run_id != request.producer_run_id
        || metadata.demo_id != request.demo_id
        || metadata.input_sha256 != request.input_sha256
        || metadata.input_size != request.input_size
        || metadata.round != request.round
        || metadata.start_tick != request.start_tick
        || metadata.end_tick != request.end_tick
        || metadata.sampling_contract_version != 2
        || metadata.sample_interval_ticks != 16
        || metadata.players_per_frame != 10
        || metadata
            .freeze_end_tick
            .is_some_and(|tick| !(request.start_tick..=request.end_tick).contains(&tick))
        || metadata.accepted_tick_count as usize != artifact.frames.len()
        || artifact.frames.first().map(|frame| frame.tick) != Some(request.start_tick)
        || artifact.frames.last().map(|frame| frame.tick) != Some(request.end_tick)
        || artifact
            .frames
            .iter()
            .any(|frame| frame.players.len() != 10)
    {
        return Err(DomainError::InvalidInput(
            "round replay cache provenance mismatch".to_owned(),
        ));
    }
    let roster = request
        .roster
        .iter()
        .map(|player| (player.steam_id.as_str(), player))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut previous_tick = None;
    for frame in &artifact.frames {
        if !(request.start_tick..=request.end_tick).contains(&frame.tick)
            || previous_tick.is_some_and(|previous| frame.tick <= previous)
        {
            return Err(DomainError::InvalidInput(
                "round replay cache tick order mismatch".to_owned(),
            ));
        }
        previous_tick = Some(frame.tick);
        let players = frame
            .players
            .iter()
            .map(|player| (player.steam_id.as_str(), player))
            .collect::<std::collections::BTreeMap<_, _>>();
        if players.len() != 10 || players.keys().ne(roster.keys()) {
            return Err(DomainError::InvalidInput(
                "round replay cache roster mismatch".to_owned(),
            ));
        }
        for (steam_id, player) in players {
            let expected = roster[steam_id];
            if player.name != expected.name
                || player.team != expected.team
                || player.side != expected.side
                || player
                    .position
                    .iter()
                    .any(|value| !value.is_finite() || value.abs() > 1_000_000.0)
                || !player.yaw.is_finite()
                || player.yaw.abs() > 360.0
                || player.health > 200
                || player.armor > 200
                || player.life_state > 255
                || player.money > 100_000
                || player.current_equipment_value > 100_000
                || player.round_start_equipment_value > 100_000
                || player.alive != (player.life_state == 0 && player.health > 0)
                || player.active_weapon_name.as_ref().is_some_and(|weapon| {
                    weapon.len() > 128 || weapon.chars().any(char::is_control)
                })
            {
                return Err(DomainError::InvalidInput(
                    "round replay cache player state mismatch".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

async fn prune(root: &PathBuf, protected: &PathBuf) -> Result<(), DomainError> {
    let mut directory = tokio::fs::read_dir(root)
        .await
        .map_err(|error| DomainError::Internal(error.to_string()))?;
    let mut entries = Vec::new();
    while let Some(entry) = directory
        .next_entry()
        .await
        .map_err(|error| DomainError::Internal(error.to_string()))?
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = entry
            .metadata()
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        if metadata.is_file() {
            entries.push((path, metadata.len(), metadata.modified().ok()));
        }
    }
    entries.sort_by_key(|(_, _, modified)| *modified);
    let mut bytes = entries
        .iter()
        .fold(0_u64, |total, (_, size, _)| total.saturating_add(*size));
    let mut count = entries.len();
    for (path, size, _) in entries {
        if count <= MAXIMUM_CACHE_ENTRIES && bytes <= MAXIMUM_CACHE_BYTES {
            break;
        }
        if path == *protected {
            continue;
        }
        tokio::fs::remove_file(&path).await.map_err(|error| {
            DomainError::CleanupFailed(format!("unable to prune round replay cache: {error}"))
        })?;
        count = count.saturating_sub(1);
        bytes = bytes.saturating_sub(size);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use tempfile::TempDir;
    use uuid::Uuid;
    use vibe_cs_domain::{
        RoundReplayFieldAvailability, RoundReplayFields, RoundReplayFrame, RoundReplayMetadata,
        RoundReplayPlayer, RoundReplayRosterPlayer,
    };

    use super::*;

    fn request() -> RoundReplayRequest {
        RoundReplayRequest {
            producer_run_id: Uuid::new_v4(),
            demo_id: Uuid::new_v4(),
            input_sha256: "a".repeat(64),
            input_size: 100,
            round: 1,
            start_tick: 100,
            end_tick: 116,
            verified_total_ticks: 1_000,
            tick_rate: 64.0,
            event_ticks: Vec::new(),
            roster: (0..10)
                .map(|index| RoundReplayRosterPlayer {
                    steam_id: format!("7656119{:010}", index + 1),
                    name: format!("P{}", index + 1),
                    team: if index < 5 { "A" } else { "B" }.to_owned(),
                    side: if index < 5 { "T" } else { "CT" }.to_owned(),
                })
                .collect(),
        }
    }

    fn artifact(request: &RoundReplayRequest) -> RoundReplayArtifact {
        let players = request
            .roster
            .iter()
            .map(|player| RoundReplayPlayer {
                steam_id: player.steam_id.clone(),
                name: player.name.clone(),
                team: player.team.clone(),
                side: player.side.clone(),
                position: [0.0, 0.0, 0.0],
                yaw: 0.0,
                health: 100,
                armor: 100,
                life_state: 0,
                alive: true,
                money: 800,
                current_equipment_value: 200,
                round_start_equipment_value: 200,
                has_helmet: false,
                active_weapon_name: None,
            })
            .collect::<Vec<_>>();
        RoundReplayArtifact {
            metadata: RoundReplayMetadata {
                producer_run_id: request.producer_run_id,
                demo_id: request.demo_id,
                input_sha256: request.input_sha256.clone(),
                input_size: request.input_size,
                round: request.round,
                start_tick: request.start_tick,
                end_tick: request.end_tick,
                tick_rate: request.tick_rate,
                sampling_contract_version: 2,
                sample_interval_ticks: 16,
                requested_tick_count: 2,
                accepted_tick_count: 2,
                event_tick_count: 0,
                freeze_end_tick: Some(100),
                players_per_frame: 10,
                fields: RoundReplayFields {
                    position: RoundReplayFieldAvailability::Required,
                    yaw: RoundReplayFieldAvailability::Required,
                    health: RoundReplayFieldAvailability::Required,
                    armor: RoundReplayFieldAvailability::Required,
                    life_state: RoundReplayFieldAvailability::Required,
                    money: RoundReplayFieldAvailability::Required,
                    current_equipment_value: RoundReplayFieldAvailability::Required,
                    round_start_equipment_value: RoundReplayFieldAvailability::Required,
                    has_helmet: RoundReplayFieldAvailability::Required,
                    active_weapon_name: RoundReplayFieldAvailability::Nullable,
                },
            },
            frames: vec![
                RoundReplayFrame {
                    tick: request.start_tick,
                    players: players.clone(),
                },
                RoundReplayFrame {
                    tick: request.end_tick,
                    players,
                },
            ],
        }
    }

    #[tokio::test]
    async fn exact_round_cache_reuses_one_generation_and_repairs_corruption() {
        let temporary = TempDir::new().unwrap();
        let cache = RoundReplayCache::new(temporary.path().join("rounds"));
        let request = request();
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = Arc::clone(&calls);
        let expected = artifact(&request);
        let first = cache
            .resolve(&request, || async move {
                first_calls.fetch_add(1, Ordering::SeqCst);
                Ok(expected)
            })
            .await
            .unwrap();
        let second_calls = Arc::clone(&calls);
        let second = cache
            .resolve(&request, || async move {
                second_calls.fetch_add(1, Ordering::SeqCst);
                panic!("cache hit must not regenerate")
            })
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let key = cache_key(&request).unwrap();
        tokio::fs::write(
            temporary
                .path()
                .join("rounds")
                .join(format!("{key}.round.json")),
            b"not-json",
        )
        .await
        .unwrap();
        let repaired_calls = Arc::clone(&calls);
        let repaired_artifact = artifact(&request);
        let repaired = cache
            .resolve(&request, || async move {
                repaired_calls.fetch_add(1, Ordering::SeqCst);
                Ok(repaired_artifact)
            })
            .await
            .unwrap();
        assert_eq!(repaired, first);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
