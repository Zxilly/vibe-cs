use crate::{EventKind, MatchAnalysis};

/// Playback limits for a round, separate from its statistical result event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoundCaptureBounds {
    pub round_number: u32,
    pub round_start_tick: u64,
    /// The statistical `RoundEnd` tick, often also the winning kill tick.
    pub round_end_tick: u64,
    pub next_round_start_tick: Option<u64>,
    /// Exact replay header ticks; never reconstructed from floating-point time.
    pub demo_end_tick: Option<u64>,
    /// Last tick the recording may include without crossing the next round or EOF.
    /// None means the final round has no verified replay boundary.
    pub recordable_end_tick: Option<u64>,
    /// Known death evidence for this player, independent of camera style.
    pub player_death_tick: Option<u64>,
}

impl MatchAnalysis {
    /// Describes a round's capturable tail for both Agent evidence and recording.
    /// A result event ends the statistics, not the remaining replay footage.
    #[must_use]
    pub fn round_capture_bounds(
        &self,
        round_number: u32,
        player_id: &str,
    ) -> Option<RoundCaptureBounds> {
        let round = self
            .rounds
            .iter()
            .find(|round| round.number == round_number)?;
        let next_round_start_tick = self
            .rounds
            .iter()
            .filter(|candidate| candidate.start_tick > round.start_tick)
            .map(|candidate| candidate.start_tick)
            .min();
        let demo_end_tick = self
            .verified_total_ticks
            .filter(|ticks| *ticks > 0)
            .map(u64::from);
        let recordable_end_tick = match (next_round_start_tick.map(|tick| tick - 1), demo_end_tick)
        {
            (Some(next_end), Some(demo_end)) => Some(next_end.min(demo_end)),
            (next_end, demo_end) => next_end.or(demo_end),
        };
        let player_death_tick = round
            .events
            .iter()
            .filter(|event| {
                event.kind == EventKind::Kill && event.target.as_deref() == Some(player_id)
            })
            .map(|event| event.tick)
            .min();
        Some(RoundCaptureBounds {
            round_number: round.number,
            round_start_tick: round.start_tick,
            round_end_tick: round.end_tick,
            next_round_start_tick,
            demo_end_tick,
            recordable_end_tick,
            player_death_tick,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RoundSummary, TimelineEvent};

    fn analysis() -> MatchAnalysis {
        let round = |number, start_tick, end_tick| RoundSummary {
            number,
            start_tick,
            end_tick,
            winner: "A".to_owned(),
            reason: "elimination".to_owned(),
            team_a_score: number,
            team_b_score: 0,
            events: Vec::new(),
        };
        MatchAnalysis {
            demo_id: uuid::Uuid::new_v4(),
            map_name: "de_test".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 1.0,
            verified_total_ticks: Some(450),
            players: Vec::new(),
            teams: Vec::new(),
            rounds: vec![round(2, 300, 400), round(1, 100, 200)],
            highlights: Vec::new(),
        }
    }

    #[test]
    fn statistical_end_does_not_remove_the_tail_before_the_next_round() {
        let analysis = analysis();
        let bounds = analysis.round_capture_bounds(1, "player").unwrap();
        assert_eq!(bounds.round_end_tick, 200);
        assert_eq!(bounds.next_round_start_tick, Some(300));
        assert_eq!(bounds.recordable_end_tick, Some(299));
        let final_round = analysis.round_capture_bounds(2, "player").unwrap();
        assert_eq!(final_round.recordable_end_tick, Some(450));
        assert_eq!(final_round.demo_end_tick, Some(450));
    }

    #[test]
    fn missing_header_ticks_never_fabricate_a_final_playback_boundary() {
        let mut analysis = analysis();
        analysis.verified_total_ticks = None;
        assert_eq!(
            analysis
                .round_capture_bounds(1, "player")
                .unwrap()
                .recordable_end_tick,
            Some(299)
        );
        assert_eq!(
            analysis
                .round_capture_bounds(2, "player")
                .unwrap()
                .recordable_end_tick,
            None
        );
    }

    #[test]
    fn player_death_is_a_separate_constraint_from_the_playable_round_tail() {
        let mut analysis = analysis();
        analysis.rounds[1].events.push(TimelineEvent {
            id: "death".to_owned(),
            tick: 180,
            seconds: 2.8125,
            kind: EventKind::Kill,
            actor: Some("opponent".to_owned()),
            target: Some("player".to_owned()),
            weapon: None,
            headshot: false,
            penetrated: false,
            position: None,
            detail: serde_json::Value::Null,
        });
        let bounds = analysis.round_capture_bounds(1, "player").unwrap();
        assert_eq!(bounds.player_death_tick, Some(180));
        assert_eq!(bounds.recordable_end_tick, Some(299));
        assert_eq!(
            analysis
                .round_capture_bounds(1, "another-player")
                .unwrap()
                .player_death_tick,
            None
        );
    }
}
