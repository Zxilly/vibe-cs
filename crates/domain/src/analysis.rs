use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize, Serializer};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq)]
pub struct MatchAnalysis {
    pub demo_id: Uuid,
    pub map_name: String,
    pub tick_rate: f64,
    pub duration_seconds: f64,
    /// Total demo ticks reported by the parser's authoritative replay header.
    pub verified_total_ticks: Option<u32>,
    pub teams: Vec<crate::TeamSummary>,
    pub players: Vec<crate::PlayerStats>,
    pub rounds: Vec<RoundSummary>,
    pub highlights: Vec<Highlight>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MatchAnalysisInput {
    demo_id: Uuid,
    map_name: String,
    tick_rate: f64,
    duration_seconds: f64,
    verified_total_ticks: RequiredNullable<u32>,
    teams: Vec<crate::TeamSummary>,
    players: Vec<crate::PlayerStats>,
    rounds: Vec<RoundSummary>,
    highlights: Vec<Highlight>,
    insights: crate::AnalysisInsights,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RequiredNullable<T> {
    Value(T),
    Null(()),
}

impl<T> RequiredNullable<T> {
    fn into_option(self) -> Option<T> {
        match self {
            Self::Value(value) => Some(value),
            Self::Null(()) => None,
        }
    }
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

impl<'de> Deserialize<'de> for MatchAnalysis {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let input = MatchAnalysisInput::deserialize(deserializer)?;
        let analysis = Self {
            demo_id: input.demo_id,
            map_name: input.map_name,
            tick_rate: input.tick_rate,
            duration_seconds: input.duration_seconds,
            verified_total_ticks: input.verified_total_ticks.into_option(),
            teams: input.teams,
            players: input.players,
            rounds: input.rounds,
            highlights: input.highlights,
        };
        if input.insights != analysis.derived_insights() {
            return Err(serde::de::Error::custom(
                "analysis insights do not match their event-derived current value",
            ));
        }
        Ok(analysis)
    }
}

#[derive(Serialize)]
struct MatchAnalysisWire<'a> {
    demo_id: &'a Uuid,
    map_name: &'a str,
    tick_rate: f64,
    duration_seconds: f64,
    verified_total_ticks: Option<u32>,
    teams: &'a [crate::TeamSummary],
    players: &'a [crate::PlayerStats],
    rounds: &'a [RoundSummary],
    highlights: &'a [Highlight],
    insights: crate::AnalysisInsights,
}

impl Serialize for MatchAnalysis {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        MatchAnalysisWire {
            demo_id: &self.demo_id,
            map_name: &self.map_name,
            tick_rate: self.tick_rate,
            duration_seconds: self.duration_seconds,
            verified_total_ticks: self.verified_total_ticks,
            teams: &self.teams,
            players: &self.players,
            rounds: &self.rounds,
            highlights: &self.highlights,
            insights: self.derived_insights(),
        }
        .serialize(serializer)
    }
}

impl MatchAnalysis {
    /// Replaces side-based T/CT totals with stable Team A/B identities when
    /// every competitive round carries a complete, consistent roster.
    ///
    /// The first complete round roster anchors Team A to that round's T side
    /// and Team B to its CT side. Every round winner is then attributed using
    /// that round's roster, so halftime and overtime side swaps cannot corrupt
    /// the match score. Returns `false` without mutating the analysis when the
    /// decoded evidence is incomplete or inconsistent.
    pub fn normalize_team_continuity(&mut self) -> bool {
        let Some(continuity) = TeamContinuity::derive(self) else {
            return false;
        };

        for player in &mut self.players {
            if continuity.team_a.contains(&player.steam_id) {
                "A"
            } else {
                "B"
            }
            .clone_into(&mut player.team);
        }
        for (round, result) in self.rounds.iter_mut().zip(&continuity.rounds) {
            round.winner.clone_from(&result.winner);
            round.team_a_score = result.team_a_score;
            round.team_b_score = result.team_b_score;
        }
        self.teams = vec![
            crate::TeamSummary {
                name: "Team A".to_owned(),
                side: "A".to_owned(),
                score: continuity.team_a_score,
                players: continuity.team_a.into_iter().collect(),
            },
            crate::TeamSummary {
                name: "Team B".to_owned(),
                side: "B".to_owned(),
                score: continuity.team_b_score,
                players: continuity.team_b.into_iter().collect(),
            },
        ];
        true
    }
}

#[derive(Debug)]
struct TeamContinuity {
    team_a: BTreeSet<String>,
    team_b: BTreeSet<String>,
    team_a_score: u32,
    team_b_score: u32,
    rounds: Vec<StableRoundResult>,
}

#[derive(Debug)]
struct StableRoundResult {
    winner: String,
    team_a_score: u32,
    team_b_score: u32,
}

impl TeamContinuity {
    fn derive(analysis: &MatchAnalysis) -> Option<Self> {
        let first_roster = analysis.rounds.first().and_then(round_roster)?;
        let team_a = roster_side(&first_roster, "T")?;
        let team_b = roster_side(&first_roster, "CT")?;
        if team_a.len() != 5 || team_b.len() != 5 {
            return None;
        }
        let analyzed_players = analysis
            .players
            .iter()
            .map(|player| player.steam_id.clone())
            .collect::<BTreeSet<_>>();
        if analyzed_players.len() != analysis.players.len()
            || analyzed_players != team_a.union(&team_b).cloned().collect()
        {
            return None;
        }

        let expected_players = team_a.union(&team_b).cloned().collect::<BTreeSet<_>>();
        let mut scores = [0_u32; 2];
        let mut rounds = Vec::with_capacity(analysis.rounds.len());
        for round in &analysis.rounds {
            let roster = round_roster(round)?;
            if roster.keys().cloned().collect::<BTreeSet<_>>() != expected_players {
                return None;
            }
            let anchor_side = stable_team_side(&roster, &team_a)?;
            let opponent_side = stable_team_side(&roster, &team_b)?;
            if anchor_side == opponent_side {
                return None;
            }
            let winner = match normalized_team_label(&round.winner) {
                Some("A") => "A",
                Some("B") => "B",
                _ => {
                    let winner_side = normalized_side(&round.winner)?;
                    if winner_side == anchor_side {
                        "A"
                    } else if winner_side == opponent_side {
                        "B"
                    } else {
                        return None;
                    }
                }
            };
            if winner == "A" {
                scores[0] = scores[0].saturating_add(1);
            } else {
                scores[1] = scores[1].saturating_add(1);
            }
            rounds.push(StableRoundResult {
                winner: winner.to_owned(),
                team_a_score: scores[0],
                team_b_score: scores[1],
            });
        }

        Some(Self {
            team_a,
            team_b,
            team_a_score: scores[0],
            team_b_score: scores[1],
            rounds,
        })
    }
}

fn round_roster(round: &RoundSummary) -> Option<BTreeMap<String, String>> {
    let roster = round
        .events
        .iter()
        .find(|event| event.kind == EventKind::RoundStart)?
        .detail
        .get("_round_roster")?
        .as_object()?;
    roster
        .iter()
        .map(|(player, side)| {
            let side = side.as_str().and_then(normalized_side)?;
            Some((player.clone(), side.to_owned()))
        })
        .collect()
}

fn roster_side(roster: &BTreeMap<String, String>, side: &str) -> Option<BTreeSet<String>> {
    let players = roster
        .iter()
        .filter(|(_, player_side)| player_side.as_str() == side)
        .map(|(player, _)| player.clone())
        .collect::<BTreeSet<_>>();
    (!players.is_empty()).then_some(players)
}

fn stable_team_side<'a>(
    roster: &'a BTreeMap<String, String>,
    players: &BTreeSet<String>,
) -> Option<&'a str> {
    let mut sides = players
        .iter()
        .map(|player| roster.get(player).map(String::as_str));
    let side = sides.next()??;
    sides
        .all(|candidate| candidate == Some(side))
        .then_some(side)
}

fn normalized_side(side: &str) -> Option<&'static str> {
    match side.trim().to_ascii_uppercase().as_str() {
        "T" | "TERRORIST" | "TERRORISTS" | "2" => Some("T"),
        "CT" | "COUNTER-TERRORIST" | "COUNTER-TERRORISTS" | "COUNTERTERRORIST" | "3" => Some("CT"),
        _ => None,
    }
}

fn normalized_team_label(team: &str) -> Option<&'static str> {
    match team.trim().to_ascii_uppercase().as_str() {
        "A" => Some("A"),
        "B" => Some("B"),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RoundSummary {
    pub number: u32,
    pub start_tick: u64,
    pub end_tick: u64,
    pub winner: String,
    pub reason: String,
    pub team_a_score: u32,
    pub team_b_score: u32,
    pub events: Vec<TimelineEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TimelineEvent {
    pub id: String,
    pub tick: u64,
    pub seconds: f64,
    pub kind: EventKind,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub actor: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub target: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub weapon: Option<String>,
    pub headshot: bool,
    pub penetrated: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub position: Option<[f64; 3]>,
    pub detail: serde_json::Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    RoundStart,
    RoundEnd,
    Kill,
    Damage,
    BombPlant,
    BombDefuse,
    BombExplode,
    Grenade,
    Purchase,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Highlight {
    pub id: String,
    pub player_id: String,
    pub round: u32,
    pub start_tick: u64,
    pub end_tick: u64,
    pub kind: HighlightKind,
    pub title: String,
    pub description: String,
    pub score: f64,
    pub tags: Vec<String>,
    pub victims: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HighlightKind {
    MultiKill,
    Clutch,
    OneTap,
    Wallbang,
    NoScope,
    Knife,
    Taser,
    Defuse,
    Fail,
    Timeline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReplayFrame {
    pub tick: u64,
    pub players: Vec<ReplayPlayer>,
    pub projectiles: Vec<ReplayProjectile>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub bomb: Option<ReplayBomb>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplayFidelityMode {
    /// Periodic entity snapshots are the spatial source.
    EntitySnapshots,
    /// Entity snapshots are enriched with event-only utility/objective evidence.
    Hybrid,
    /// Only exact ticks carrying positioned game-event evidence are represented.
    EventSparse,
}

/// Machine-readable replay provenance. Consumers must use `tick_rate` and the
/// source tick distance between frames rather than assuming a fixed frame rate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReplayFidelityMetadata {
    pub mode: ReplayFidelityMode,
    pub tick_rate: f64,
    pub frame_count: u64,
    pub positioned_event_count: u64,
    pub start_tick: u64,
    pub end_tick: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReplayArtifact {
    pub frames: Vec<ReplayFrame>,
    pub fidelity: ReplayFidelityMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReplayPlayer {
    pub id: String,
    pub name: String,
    pub team: String,
    pub position: [f64; 3],
    pub yaw: f64,
    pub health: u32,
    pub armor: u32,
    pub alive: bool,
    pub weapon: String,
    /// Evidence-backed player input sampled from the pawn button mask.
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub input: Option<ReplayInputState>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[allow(clippy::struct_excessive_bools)] // Each bit is an independent player input.
pub struct ReplayInputState {
    pub forward: bool,
    pub left: bool,
    pub backward: bool,
    pub right: bool,
    pub jump: bool,
    pub crouch: bool,
    pub walk: bool,
    pub reload: bool,
    pub fire: bool,
    pub secondary_fire: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReplayProjectile {
    pub kind: String,
    pub position: [f64; 3],
    pub active: bool,
    /// Evidence-backed effect radius when the event supplies one, otherwise a
    /// conservative game-semantic fallback for persistent utility.
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub radius: Option<f64>,
    /// Whether this effect participates in the tactical utility visibility
    /// mask. This never implies reconstructed volumetric geometry.
    pub masks_vision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReplayBomb {
    pub position: [f64; 3],
    pub state: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub carrier_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HeatPoint {
    /// Stable evidence identity within a demo analysis.
    pub id: String,
    /// Authoritative analysis round when the point came from a round-scoped API.
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub round: Option<u32>,
    /// Exact source tick for event and movement evidence.
    pub tick: u64,
    pub x: f64,
    pub y: f64,
    pub weight: f64,
    pub floor: i32,
    pub kind: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub player_id: Option<String>,
    /// T/CT side at the evidence tick. This is deliberately not a stable
    /// organization identity across side swaps.
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub side: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub event_kind: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;
    use crate::{PlayerStats, TeamSummary};

    fn minimal_analysis(players: Vec<PlayerStats>) -> MatchAnalysis {
        MatchAnalysis {
            demo_id: Uuid::nil(),
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 120.0,
            verified_total_ticks: None,
            teams: Vec::new(),
            players,
            rounds: Vec::new(),
            highlights: Vec::new(),
        }
    }

    fn player_with_spectator_slot(spectator_slot: Option<u8>) -> PlayerStats {
        PlayerStats {
            steam_id: "76561198000000001".to_owned(),
            spectator_slot,
            name: "Player One".to_owned(),
            team: "T".to_owned(),
            kills: 1,
            deaths: 0,
            assists: 0,
            headshots: 1,
            damage: 100,
            adr: 100.0,
            kill_death_ratio: 1.0,
            score: 2,
        }
    }

    #[test]
    fn analysis_without_current_total_ticks_contract_is_rejected() {
        let mut incomplete =
            serde_json::to_value(minimal_analysis(Vec::new())).expect("current analysis JSON");
        incomplete
            .as_object_mut()
            .expect("analysis is an object")
            .remove("verified_total_ticks");

        assert!(serde_json::from_value::<MatchAnalysis>(incomplete).is_err());
    }

    #[test]
    fn analysis_without_current_spectator_slot_contract_is_rejected() {
        let mut incomplete =
            serde_json::to_value(minimal_analysis(vec![player_with_spectator_slot(Some(8))]))
                .expect("current analysis JSON");
        incomplete["players"][0]
            .as_object_mut()
            .expect("player is an object")
            .remove("spectator_slot");

        assert!(serde_json::from_value::<MatchAnalysis>(incomplete).is_err());
    }

    #[test]
    fn analysis_rejects_retired_fields_inside_typed_round_evidence() {
        let mut analysis = minimal_analysis(Vec::new());
        analysis.rounds = vec![RoundSummary {
            number: 1,
            start_tick: 100,
            end_tick: 200,
            winner: "T".to_owned(),
            reason: "target_bombed".to_owned(),
            team_a_score: 1,
            team_b_score: 0,
            events: vec![TimelineEvent {
                id: "round_start-1".to_owned(),
                tick: 100,
                seconds: 1.562_5,
                kind: EventKind::RoundStart,
                actor: None,
                target: None,
                weapon: None,
                headshot: false,
                penetrated: false,
                position: None,
                detail: json!({"retired_field": "allowed inside open event detail"}),
            }],
        }];
        let current = serde_json::to_value(&analysis).expect("current analysis JSON");
        serde_json::from_value::<MatchAnalysis>(current.clone())
            .expect("open detail remains part of the current wire");

        let mut retired_round = current.clone();
        retired_round["rounds"][0]["retired_field"] = json!(true);
        assert!(serde_json::from_value::<MatchAnalysis>(retired_round).is_err());

        let mut retired_event = current;
        retired_event["rounds"][0]["events"][0]["retired_field"] = json!(true);
        assert!(serde_json::from_value::<MatchAnalysis>(retired_event).is_err());

        for field in ["actor", "target", "weapon", "position"] {
            let mut missing = serde_json::to_value(&analysis).expect("current analysis JSON");
            missing["rounds"][0]["events"][0]
                .as_object_mut()
                .expect("timeline event")
                .remove(field);
            assert!(
                serde_json::from_value::<MatchAnalysis>(missing).is_err(),
                "missing nullable timeline field {field} must be rejected"
            );
        }
    }

    #[test]
    fn analysis_rejects_retired_fields_inside_typed_team_and_highlight_records() {
        let mut analysis = minimal_analysis(Vec::new());
        analysis.teams = vec![TeamSummary {
            name: "Team A".to_owned(),
            side: "A".to_owned(),
            score: 1,
            players: Vec::new(),
        }];
        analysis.highlights = vec![Highlight {
            id: "highlight-1".to_owned(),
            player_id: "76561198000000000".to_owned(),
            round: 1,
            start_tick: 100,
            end_tick: 200,
            kind: HighlightKind::OneTap,
            title: "One tap".to_owned(),
            description: "Evidence-backed kill".to_owned(),
            score: 0.9,
            tags: vec!["one_tap".to_owned()],
            victims: vec!["76561198000000001".to_owned()],
        }];
        let current = serde_json::to_value(&analysis).expect("current analysis JSON");

        let mut retired_team = current.clone();
        retired_team["teams"][0]["retired_field"] = json!(true);
        assert!(serde_json::from_value::<MatchAnalysis>(retired_team).is_err());

        let mut retired_highlight = current;
        retired_highlight["highlights"][0]["retired_field"] = json!(true);
        assert!(serde_json::from_value::<MatchAnalysis>(retired_highlight).is_err());
    }

    #[test]
    fn analysis_rejects_retired_fields_inside_derived_insights() {
        let mut analysis = minimal_analysis(Vec::new());
        analysis.rounds = vec![RoundSummary {
            number: 1,
            start_tick: 100,
            end_tick: 200,
            winner: "T".to_owned(),
            reason: "target_bombed".to_owned(),
            team_a_score: 1,
            team_b_score: 0,
            events: vec![
                TimelineEvent {
                    id: "item_purchase-1".to_owned(),
                    tick: 120,
                    seconds: 1.875,
                    kind: EventKind::Purchase,
                    actor: Some("76561198000000000".to_owned()),
                    target: None,
                    weapon: Some("ak47".to_owned()),
                    headshot: false,
                    penetrated: false,
                    position: None,
                    detail: json!({"price": 2700, "team": "T"}),
                },
                TimelineEvent {
                    id: "grenade_thrown-2".to_owned(),
                    tick: 130,
                    seconds: 2.031_25,
                    kind: EventKind::Grenade,
                    actor: Some("76561198000000000".to_owned()),
                    target: None,
                    weapon: Some("smokegrenade".to_owned()),
                    headshot: false,
                    penetrated: false,
                    position: None,
                    detail: json!({}),
                },
            ],
        }];
        let current = serde_json::to_value(&analysis).expect("current analysis JSON");

        let mut retired_insights = current.clone();
        retired_insights["insights"]["retired_field"] = json!(true);
        assert!(serde_json::from_value::<MatchAnalysis>(retired_insights).is_err());

        let mut retired_availability = current.clone();
        retired_availability["insights"]["availability"]["matchups"]["retired_field"] = json!(true);
        assert!(serde_json::from_value::<MatchAnalysis>(retired_availability).is_err());

        let mut retired_economy = current;
        retired_economy["insights"]["round_economy"][0]["teams"][1]["items"][0]["retired_field"] =
            json!(true);
        assert!(serde_json::from_value::<MatchAnalysis>(retired_economy).is_err());

        for path in [
            &["insights", "round_economy", "0", "teams", "1", "spend"][..],
            &["insights", "player_utility", "0", "flash_duration_seconds"][..],
            &["insights", "availability", "matchups", "reason"][..],
        ] {
            let mut missing = serde_json::to_value(&analysis).expect("current analysis JSON");
            let (parent, field) = path.split_at(path.len() - 1);
            let mut node = &mut missing;
            for segment in parent {
                node = if let Ok(index) = segment.parse::<usize>() {
                    &mut node[index]
                } else {
                    &mut node[*segment]
                };
            }
            node.as_object_mut()
                .expect("typed insight object")
                .remove(field[0]);
            assert!(
                serde_json::from_value::<MatchAnalysis>(missing).is_err(),
                "missing nullable insight field at {path:?} must be rejected"
            );
        }
    }

    fn current_replay_artifact() -> ReplayArtifact {
        ReplayArtifact {
            frames: vec![ReplayFrame {
                tick: 100,
                players: vec![ReplayPlayer {
                    id: "76561198000000000".to_owned(),
                    name: "Player".to_owned(),
                    team: "T".to_owned(),
                    position: [1.0, 2.0, 3.0],
                    yaw: 90.0,
                    health: 100,
                    armor: 100,
                    alive: true,
                    weapon: "ak47".to_owned(),
                    input: None,
                }],
                projectiles: vec![ReplayProjectile {
                    kind: "smoke".to_owned(),
                    position: [4.0, 5.0, 6.0],
                    active: true,
                    radius: None,
                    masks_vision: true,
                }],
                bomb: Some(ReplayBomb {
                    position: [7.0, 8.0, 9.0],
                    state: "carried".to_owned(),
                    carrier_id: None,
                }),
            }],
            fidelity: ReplayFidelityMetadata {
                mode: ReplayFidelityMode::EntitySnapshots,
                tick_rate: 64.0,
                frame_count: 1,
                positioned_event_count: 0,
                start_tick: 100,
                end_tick: 100,
            },
        }
    }

    #[test]
    fn replay_artifact_rejects_retired_fields_inside_typed_frames() {
        let current =
            serde_json::to_value(current_replay_artifact()).expect("current replay artifact");

        for path in [
            &["frames", "0"][..],
            &["frames", "0", "players", "0"][..],
            &["frames", "0", "projectiles", "0"][..],
            &["frames", "0", "bomb"][..],
        ] {
            let mut retired = current.clone();
            let mut node = &mut retired;
            for segment in path {
                node = if let Ok(index) = segment.parse::<usize>() {
                    &mut node[index]
                } else {
                    &mut node[*segment]
                };
            }
            node["retired_field"] = json!(true);
            assert!(
                serde_json::from_value::<ReplayArtifact>(retired).is_err(),
                "retired field at {path:?} must be rejected"
            );
        }
    }

    #[test]
    fn replay_artifact_requires_current_nullable_fields_to_be_explicit() {
        let current =
            serde_json::to_value(current_replay_artifact()).expect("current replay artifact");

        for path in [
            &["frames", "0", "bomb"][..],
            &["frames", "0", "players", "0", "input"][..],
            &["frames", "0", "projectiles", "0", "radius"][..],
            &["frames", "0", "bomb", "carrier_id"][..],
        ] {
            let mut missing = current.clone();
            let (parent, field) = path.split_at(path.len() - 1);
            let mut node = &mut missing;
            for segment in parent {
                node = if let Ok(index) = segment.parse::<usize>() {
                    &mut node[index]
                } else {
                    &mut node[*segment]
                };
            }
            node.as_object_mut()
                .expect("typed replay object")
                .remove(field[0]);
            assert!(
                serde_json::from_value::<ReplayArtifact>(missing).is_err(),
                "missing nullable field at {path:?} must be rejected"
            );
        }
    }

    #[test]
    fn heat_point_accepts_only_the_complete_current_typed_shape() {
        let current = serde_json::to_value(HeatPoint {
            id: "kill-1".to_owned(),
            round: None,
            tick: 100,
            x: 1.0,
            y: 2.0,
            weight: 1.0,
            floor: 0,
            kind: "kill".to_owned(),
            player_id: None,
            side: None,
            event_kind: None,
        })
        .expect("current heat point");

        for field in ["round", "player_id", "side", "event_kind"] {
            let mut missing = current.clone();
            missing
                .as_object_mut()
                .expect("heat point object")
                .remove(field);
            assert!(
                serde_json::from_value::<HeatPoint>(missing).is_err(),
                "missing nullable field {field} must be rejected"
            );
        }

        let mut retired = current;
        retired["retired_field"] = json!(true);
        assert!(serde_json::from_value::<HeatPoint>(retired).is_err());
    }

    #[test]
    fn parser_observed_spectator_slot_round_trips_through_analysis_json() {
        let wire =
            serde_json::to_value(minimal_analysis(vec![player_with_spectator_slot(Some(8))]))
                .expect("current analysis JSON");
        let analysis: MatchAnalysis = serde_json::from_value(wire).expect("analysis with slot");

        assert_eq!(analysis.players[0].spectator_slot, Some(8));
        assert_eq!(
            serde_json::to_value(&analysis).expect("analysis wire json")["players"][0]["spectator_slot"],
            json!(8)
        );
    }

    #[test]
    fn verified_total_ticks_round_trips_in_the_current_wire_shape() {
        let mut analysis = minimal_analysis(Vec::new());
        assert!(
            serde_json::to_value(&analysis).expect("current JSON")["verified_total_ticks"]
                .is_null()
        );

        analysis.verified_total_ticks = Some(7_680);
        let json = serde_json::to_value(&analysis).expect("analysis JSON");
        assert_eq!(json["verified_total_ticks"], 7_680);
        assert_eq!(
            serde_json::from_value::<MatchAnalysis>(json)
                .expect("round-tripped analysis")
                .verified_total_ticks,
            Some(7_680)
        );
    }

    #[test]
    fn stable_team_continuity_follows_rosters_across_the_side_swap() {
        let team_a = ["a1", "a2", "a3", "a4", "a5"];
        let team_b = ["b1", "b2", "b3", "b4", "b5"];
        let mut analysis = MatchAnalysis {
            demo_id: Uuid::new_v4(),
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 2_958.062_5,
            verified_total_ticks: None,
            teams: vec![
                team_summary("T", 3, &team_b),
                team_summary("CT", 1, &team_a),
            ],
            players: team_a
                .iter()
                .map(|id| player(id, "CT"))
                .chain(team_b.iter().map(|id| player(id, "T")))
                .collect(),
            rounds: vec![
                round(1, "CT", roster(&team_a, "T", &team_b, "CT")),
                round(2, "T", roster(&team_a, "T", &team_b, "CT")),
                round(3, "T", roster(&team_a, "CT", &team_b, "T")),
                round(4, "T", roster(&team_a, "CT", &team_b, "T")),
            ],
            highlights: vec![],
        };

        assert!(analysis.normalize_team_continuity());

        assert_eq!(analysis.teams[0], team_summary("A", 1, &team_a));
        assert_eq!(analysis.teams[1], team_summary("B", 3, &team_b));
        assert!(
            analysis.players[..5]
                .iter()
                .all(|player| player.team == "A")
        );
        assert!(
            analysis.players[5..]
                .iter()
                .all(|player| player.team == "B")
        );
        assert_eq!(
            analysis
                .rounds
                .iter()
                .map(|round| (
                    round.winner.as_str(),
                    round.team_a_score,
                    round.team_b_score
                ))
                .collect::<Vec<_>>(),
            vec![("B", 0, 1), ("A", 1, 1), ("B", 1, 2), ("B", 1, 3)]
        );
    }

    #[test]
    fn incomplete_round_rosters_never_create_claimed_team_scores() {
        let team_a = ["a1", "a2", "a3", "a4", "a5"];
        let team_b = ["b1", "b2", "b3", "b4", "b5"];
        let mut incomplete_roster = roster(&team_a, "T", &team_b, "CT");
        incomplete_roster.remove("b5");
        let mut analysis = MatchAnalysis {
            demo_id: Uuid::new_v4(),
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 120.0,
            verified_total_ticks: None,
            teams: vec![
                team_summary("T", 1, &team_a),
                team_summary("CT", 0, &team_b),
            ],
            players: team_a
                .iter()
                .map(|id| player(id, "T"))
                .chain(team_b.iter().map(|id| player(id, "CT")))
                .collect(),
            rounds: vec![round(1, "T", incomplete_roster)],
            highlights: vec![],
        };
        let original = analysis.clone();

        assert!(!analysis.normalize_team_continuity());
        assert_eq!(analysis, original);
    }

    #[test]
    fn normalized_team_continuity_is_idempotent() {
        let team_a = ["a1", "a2", "a3", "a4", "a5"];
        let team_b = ["b1", "b2", "b3", "b4", "b5"];
        let mut analysis = MatchAnalysis {
            demo_id: Uuid::new_v4(),
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 120.0,
            verified_total_ticks: None,
            teams: vec![
                team_summary("T", 1, &team_a),
                team_summary("CT", 1, &team_b),
            ],
            players: team_a
                .iter()
                .map(|id| player(id, "T"))
                .chain(team_b.iter().map(|id| player(id, "CT")))
                .collect(),
            rounds: vec![
                round(1, "T", roster(&team_a, "T", &team_b, "CT")),
                round(2, "T", roster(&team_a, "CT", &team_b, "T")),
            ],
            highlights: vec![],
        };
        assert!(analysis.normalize_team_continuity());
        let normalized = analysis.clone();

        assert!(analysis.normalize_team_continuity());
        assert_eq!(analysis, normalized);
    }

    #[test]
    fn major_final_mirage_round_evidence_reconstructs_eight_to_thirteen() {
        let furia = ["FalleN", "molodoy", "KSCERATO", "yuurih", "YEKINDAR"];
        let falcons = ["karrigan", "TeSeS", "NiKo", "m0NESY", "kyousuke"];
        let winners = [
            "CT", "CT", "CT", "CT", "CT", "CT", "CT", "CT", "T", "T", "T", "T", "T", "CT", "T",
            "T", "T", "CT", "CT", "CT", "T",
        ];
        let rounds = winners
            .iter()
            .enumerate()
            .map(|(index, winner)| {
                let number = u32::try_from(index + 1).expect("fixture round number");
                let roster = if number <= 12 {
                    roster(&furia, "T", &falcons, "CT")
                } else {
                    roster(&furia, "CT", &falcons, "T")
                };
                round(number, winner, roster)
            })
            .collect();
        let mut analysis = MatchAnalysis {
            demo_id: Uuid::new_v4(),
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 2_958.062_5,
            verified_total_ticks: None,
            teams: vec![
                team_summary("T", 9, &falcons),
                team_summary("CT", 12, &furia),
            ],
            players: furia
                .iter()
                .map(|id| player(id, "CT"))
                .chain(falcons.iter().map(|id| player(id, "T")))
                .collect(),
            rounds,
            highlights: vec![],
        };

        assert!(analysis.normalize_team_continuity());
        assert_eq!(analysis.teams[0].score, 8);
        assert_eq!(analysis.teams[1].score, 13);
        assert_eq!(
            analysis.rounds.last().map(|round| (
                round.winner.as_str(),
                round.team_a_score,
                round.team_b_score
            )),
            Some(("B", 8, 13))
        );
    }

    fn roster(
        anchor: &[&str; 5],
        anchor_side: &str,
        opponent: &[&str; 5],
        opponent_side: &str,
    ) -> BTreeMap<String, String> {
        anchor
            .iter()
            .map(|id| ((*id).to_owned(), anchor_side.to_owned()))
            .chain(
                opponent
                    .iter()
                    .map(|id| ((*id).to_owned(), opponent_side.to_owned())),
            )
            .collect()
    }

    #[allow(clippy::needless_pass_by_value)] // The fixture JSON owns the roster value.
    fn round(number: u32, winner: &str, roster: BTreeMap<String, String>) -> RoundSummary {
        RoundSummary {
            number,
            start_tick: u64::from(number) * 100,
            end_tick: u64::from(number) * 100 + 99,
            winner: winner.to_owned(),
            reason: String::new(),
            team_a_score: 0,
            team_b_score: 0,
            events: vec![TimelineEvent {
                id: format!("round-{number}-start"),
                tick: u64::from(number) * 100,
                seconds: f64::from(number),
                kind: EventKind::RoundStart,
                actor: None,
                target: None,
                weapon: None,
                headshot: false,
                penetrated: false,
                position: None,
                detail: json!({ "_round_roster": roster }),
            }],
        }
    }

    fn player(id: &str, side: &str) -> PlayerStats {
        PlayerStats {
            steam_id: id.to_owned(),
            spectator_slot: None,
            name: id.to_owned(),
            team: side.to_owned(),
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

    fn team_summary(side: &str, score: u32, players: &[&str; 5]) -> TeamSummary {
        TeamSummary {
            name: format!("Team {side}"),
            side: side.to_owned(),
            score,
            players: players.iter().map(|id| (*id).to_owned()).collect(),
        }
    }
}
