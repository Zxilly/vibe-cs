use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

use crate::{AnalysisInputFingerprint, DomainError, EventKind, MatchAnalysis};

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RoundReplayRosterPlayer {
    pub steam_id: String,
    pub name: String,
    pub team: String,
    pub side: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RoundReplayRequest {
    pub producer_run_id: Uuid,
    pub demo_id: Uuid,
    pub input_sha256: String,
    pub input_size: u64,
    pub round: u32,
    pub start_tick: u64,
    pub end_tick: u64,
    pub verified_total_ticks: u64,
    pub tick_rate: f64,
    pub event_ticks: Vec<u64>,
    pub roster: Vec<RoundReplayRosterPlayer>,
}

impl RoundReplayRequest {
    /// Builds the source-bound selected-round parser request from one exact producer result.
    ///
    /// # Errors
    ///
    /// Returns an error when the round, replay bounds, event identities, stable teams, or
    /// canonical ten-player roster cannot be proven from the producer analysis.
    pub fn from_analysis(
        producer_run_id: Uuid,
        fingerprint: &AnalysisInputFingerprint,
        analysis: &MatchAnalysis,
        round_number: u32,
    ) -> Result<Self, DomainError> {
        let matching_rounds = analysis
            .rounds
            .iter()
            .filter(|round| round.number == round_number)
            .collect::<Vec<_>>();
        let [round] = matching_rounds.as_slice() else {
            return Err(if matching_rounds.is_empty() {
                DomainError::NotFound("analysis round".to_owned())
            } else {
                DomainError::Conflict("analysis round identity is ambiguous".to_owned())
            });
        };
        let mut event_ids = BTreeSet::new();
        if round.events.iter().any(|event| {
            event.id.trim().is_empty()
                || !event_ids.insert(event.id.as_str())
                || !(round.start_tick..=round.end_tick).contains(&event.tick)
        }) {
            return Err(DomainError::Conflict(
                "analysis round contains noncanonical event identity or bounds".to_owned(),
            ));
        }
        let verified_total_ticks = analysis.verified_total_ticks.ok_or_else(|| {
            DomainError::DependencyUnavailable(
                "analysis does not carry a verified replay tick boundary".to_owned(),
            )
        })?;
        let start_event = round
            .events
            .iter()
            .filter(|event| event.kind == EventKind::RoundStart)
            .collect::<Vec<_>>();
        let [start_event] = start_event.as_slice() else {
            return Err(DomainError::Conflict(
                "analysis round must contain one canonical round-start roster".to_owned(),
            ));
        };
        let roster_sides = start_event
            .detail
            .get("_round_roster")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| {
                DomainError::DependencyUnavailable(
                    "analysis round roster is unavailable".to_owned(),
                )
            })?;
        let player_by_id = analysis
            .players
            .iter()
            .map(|player| (player.steam_id.as_str(), player))
            .collect::<BTreeMap<_, _>>();
        let mut roster = Vec::with_capacity(roster_sides.len());
        for (steam_id, raw_side) in roster_sides {
            let side = canonical_side(raw_side.as_str().unwrap_or_default()).ok_or_else(|| {
                DomainError::Conflict("analysis round roster contains an invalid side".to_owned())
            })?;
            let player = player_by_id.get(steam_id.as_str()).ok_or_else(|| {
                DomainError::Conflict("analysis round roster contains an unknown player".to_owned())
            })?;
            let team = match player.team.as_str() {
                "A" | "B" => player.team.clone(),
                _ => {
                    return Err(DomainError::Conflict(
                        "analysis player lacks a stable Team A/B identity".to_owned(),
                    ));
                }
            };
            roster.push(RoundReplayRosterPlayer {
                steam_id: steam_id.clone(),
                name: player.name.clone(),
                team,
                side: side.to_owned(),
            });
        }
        roster.sort_by(|left, right| left.steam_id.cmp(&right.steam_id));
        let event_ticks = round
            .events
            .iter()
            .map(|event| event.tick)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        Ok(Self {
            producer_run_id,
            demo_id: analysis.demo_id,
            input_sha256: fingerprint.sha256.clone(),
            input_size: fingerprint.size,
            round: round.number,
            start_tick: round.start_tick,
            end_tick: round.end_tick,
            verified_total_ticks: u64::from(verified_total_ticks),
            tick_rate: analysis.tick_rate,
            event_ticks,
            roster,
        })
    }
}

fn canonical_side(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_uppercase().as_str() {
        "T" | "TERRORIST" | "TERRORISTS" | "2" => Some("T"),
        "CT" | "COUNTER-TERRORIST" | "COUNTER-TERRORISTS" | "COUNTERTERRORIST" | "3" => Some("CT"),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoundReplayFieldAvailability {
    Required,
    Nullable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RoundReplayFields {
    pub position: RoundReplayFieldAvailability,
    pub yaw: RoundReplayFieldAvailability,
    pub health: RoundReplayFieldAvailability,
    pub armor: RoundReplayFieldAvailability,
    pub life_state: RoundReplayFieldAvailability,
    pub active_weapon_name: RoundReplayFieldAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RoundReplayMetadata {
    pub producer_run_id: Uuid,
    pub demo_id: Uuid,
    pub input_sha256: String,
    pub input_size: u64,
    pub round: u32,
    pub start_tick: u64,
    pub end_tick: u64,
    pub tick_rate: f64,
    pub sampling_contract_version: u32,
    pub sample_interval_ticks: u32,
    pub requested_tick_count: u32,
    pub accepted_tick_count: u32,
    pub event_tick_count: u32,
    pub players_per_frame: u32,
    pub fields: RoundReplayFields,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RoundReplayPlayer {
    pub steam_id: String,
    pub name: String,
    pub team: String,
    pub side: String,
    pub position: [f64; 3],
    pub yaw: f64,
    pub health: u32,
    pub armor: u32,
    pub life_state: u32,
    pub alive: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub active_weapon_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RoundReplayFrame {
    pub tick: u64,
    pub players: Vec<RoundReplayPlayer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RoundReplayArtifact {
    pub metadata: RoundReplayMetadata,
    pub frames: Vec<RoundReplayFrame>,
}
