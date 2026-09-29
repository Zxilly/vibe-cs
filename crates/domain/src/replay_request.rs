use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AnalysisInputFingerprint, DomainError, EventKind, MatchAnalysis, TimelineEvent};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReplayIdentity {
    pub id: String,
    pub name: String,
    pub team: String,
}

/// Producer-bound input for isolated dense replay extraction. Statistics and
/// embedded analysis projections are not duplicated in the worker request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayRequest {
    pub demo_id: Uuid,
    pub input: AnalysisInputFingerprint,
    pub tick_rate: f64,
    pub verified_total_ticks: u32,
    pub roster: Vec<ReplayIdentity>,
    pub rounds: Vec<[u64; 2]>,
    pub highlights: Vec<[u64; 2]>,
    pub event_ticks: Vec<u64>,
    pub utility_events: Vec<TimelineEvent>,
}

impl ReplayRequest {
    /// Select the source evidence needed for replay without reusing a stored
    /// event-only player projection.
    ///
    /// # Errors
    /// Returns unavailable when analysis lacks verified source tick metadata.
    ///
    /// # Panics
    /// Panics if capture-bound construction violates the invariant that a round
    /// from this analysis and a verified nonzero EOF always have a capture bound.
    pub fn from_analysis(
        input: AnalysisInputFingerprint,
        analysis: &MatchAnalysis,
    ) -> Result<Self, DomainError> {
        let verified_total_ticks = analysis
            .verified_total_ticks
            .filter(|ticks| *ticks > 0)
            .ok_or_else(|| {
                DomainError::DependencyUnavailable(
                    "analysis has no verified replay tick boundary".to_owned(),
                )
            })?;
        Ok(Self {
            demo_id: analysis.demo_id,
            input,
            tick_rate: analysis.tick_rate,
            verified_total_ticks,
            roster: analysis
                .players
                .iter()
                .map(|player| ReplayIdentity {
                    id: player.steam_id.clone(),
                    name: player.name.clone(),
                    team: player.team.clone(),
                })
                .collect(),
            rounds: analysis
                .rounds
                .iter()
                .map(|round| {
                    [
                        round.start_tick,
                        analysis
                            .round_capture_bounds(round.number, None)
                            .expect("round belongs to this analysis")
                            .recordable_end_tick
                            .expect("verified replay boundary supplies the final capture bound"),
                    ]
                })
                .collect(),
            highlights: analysis
                .highlights
                .iter()
                .map(|highlight| [highlight.start_tick, highlight.end_tick])
                .collect(),
            event_ticks: analysis
                .rounds
                .iter()
                .flat_map(|round| round.events.iter().map(|event| event.tick))
                .collect(),
            utility_events: analysis
                .rounds
                .iter()
                .flat_map(|round| round.events.iter())
                .filter(|event| {
                    matches!(
                        event.kind,
                        EventKind::Grenade
                            | EventKind::BombPlant
                            | EventKind::BombDefuse
                            | EventKind::BombExplode
                    )
                })
                .cloned()
                .collect(),
        })
    }
}
