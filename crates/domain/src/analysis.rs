use serde::{Deserialize, Serialize, Serializer};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MatchAnalysis {
    pub demo_id: Uuid,
    pub map_name: String,
    pub tick_rate: f64,
    pub duration_seconds: f64,
    pub teams: Vec<crate::TeamSummary>,
    pub players: Vec<crate::PlayerStats>,
    pub rounds: Vec<RoundSummary>,
    pub highlights: Vec<Highlight>,
}

#[derive(Serialize)]
struct MatchAnalysisWire<'a> {
    demo_id: &'a Uuid,
    map_name: &'a str,
    tick_rate: f64,
    duration_seconds: f64,
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
            teams: &self.teams,
            players: &self.players,
            rounds: &self.rounds,
            highlights: &self.highlights,
            insights: self.derived_insights(),
        }
        .serialize(serializer)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
pub struct TimelineEvent {
    pub id: String,
    pub tick: u64,
    pub seconds: f64,
    pub kind: EventKind,
    pub actor: Option<String>,
    pub target: Option<String>,
    pub weapon: Option<String>,
    pub headshot: bool,
    pub penetrated: bool,
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
pub struct ReplayFrame {
    pub tick: u64,
    pub players: Vec<ReplayPlayer>,
    pub projectiles: Vec<ReplayProjectile>,
    pub bomb: Option<ReplayBomb>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    /// Evidence-backed player input sampled from the pawn button mask. Older
    /// analyses and demos without this field leave it absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
pub struct ReplayProjectile {
    pub kind: String,
    pub position: [f64; 3],
    pub active: bool,
    /// Evidence-backed effect radius when the event supplies one, otherwise a
    /// conservative game-semantic fallback for persistent utility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,
    /// Whether this effect participates in the tactical utility visibility
    /// mask. This never implies reconstructed volumetric geometry.
    #[serde(default)]
    pub masks_vision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayBomb {
    pub position: [f64; 3],
    pub state: String,
    pub carrier_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HeatPoint {
    pub x: f64,
    pub y: f64,
    pub weight: f64,
    pub floor: i32,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_kind: Option<String>,
}
