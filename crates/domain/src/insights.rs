use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{EventKind, MatchAnalysis, TimelineEvent};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalysisInsights {
    pub round_economy: Vec<RoundEconomyInsight>,
    pub player_utility: Vec<PlayerUtilityInsight>,
    pub matchups: Vec<PlayerMatchupInsight>,
    pub availability: AnalysisInsightAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoundEconomyInsight {
    pub round: u32,
    pub teams: Vec<TeamPurchaseInsight>,
    pub unattributed_purchase_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TeamPurchaseInsight {
    pub team: String,
    pub purchase_count: u32,
    pub items: Vec<CountedItem>,
    /// Only present when every decoded purchase for this team carried an
    /// explicit non-negative price. No static price table is used.
    pub spend: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CountedItem {
    pub name: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlayerUtilityInsight {
    pub player_id: String,
    pub throws: u32,
    pub detonations: u32,
    pub items: Vec<CountedItem>,
    pub damage: u32,
    pub damage_events: u32,
    pub flash_events: u32,
    pub players_flashed: u32,
    /// Absent when at least one decoded blind event omitted its duration.
    pub flash_duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlayerMatchupInsight {
    pub player_id: String,
    pub opponent_id: String,
    pub kills: u32,
    pub deaths: u32,
    pub headshot_kills: u32,
    pub damage_dealt: u32,
    pub damage_taken: u32,
    pub damage_events: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalysisInsightAvailability {
    pub purchase_events: InsightCapability,
    pub purchase_spend: InsightCapability,
    pub utility_events: InsightCapability,
    pub utility_damage: InsightCapability,
    pub flash_effects: InsightCapability,
    pub matchups: InsightCapability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InsightCapability {
    pub available: bool,
    pub reason: Option<String>,
}

impl InsightCapability {
    fn available() -> Self {
        Self {
            available: true,
            reason: None,
        }
    }

    fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            reason: Some(reason.to_owned()),
        }
    }
}

#[derive(Debug, Default)]
struct PurchaseAccumulator {
    count: u32,
    items: BTreeMap<String, u32>,
    total_spend: u64,
    missing_price: bool,
}

#[derive(Debug, Default)]
struct UtilityAccumulator {
    throws: u32,
    detonations: u32,
    items: BTreeMap<String, u32>,
    damage: u32,
    damage_events: u32,
    flash_events: u32,
    flashed_players: BTreeSet<String>,
    flash_duration_seconds: f64,
    missing_flash_duration: bool,
}

#[derive(Debug, Default)]
struct MatchupAccumulator {
    kills: u32,
    headshot_kills: u32,
    damage: u32,
    damage_events: u32,
}

impl MatchAnalysis {
    /// Derives only evidence-backed aggregates from decoded game events. In
    /// particular, it never estimates item prices or invents grenade effects.
    #[must_use]
    pub fn derived_insights(&self) -> AnalysisInsights {
        derive_analysis_insights(self)
    }
}

#[must_use]
pub fn derive_analysis_insights(analysis: &MatchAnalysis) -> AnalysisInsights {
    let player_teams = analysis
        .players
        .iter()
        .filter(|player| !player.team.is_empty())
        .map(|player| (player.steam_id.clone(), player.team.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut teams = player_teams.values().cloned().collect::<BTreeSet<_>>();
    teams.extend(["CT".to_owned(), "T".to_owned()]);
    let round_economy = derive_round_economy(analysis, &teams);
    let (player_utility, utility_event_count, utility_damage_count, flash_event_count) =
        derive_player_utility(analysis);
    let matchups = derive_matchups(analysis);
    let matchups_available = !matchups.is_empty();
    let attributed_purchase_count = round_economy
        .iter()
        .flat_map(|round| &round.teams)
        .map(|team| u64::from(team.purchase_count))
        .sum::<u64>();
    let unattributed_purchase_count = round_economy
        .iter()
        .map(|round| u64::from(round.unattributed_purchase_count))
        .sum::<u64>();
    let purchase_count = attributed_purchase_count.saturating_add(unattributed_purchase_count);
    let spend_is_complete = purchase_count > 0
        && unattributed_purchase_count == 0
        && round_economy
            .iter()
            .flat_map(|round| &round.teams)
            .filter(|team| team.purchase_count > 0)
            .all(|team| team.spend.is_some());

    AnalysisInsights {
        round_economy,
        player_utility,
        matchups,
        availability: AnalysisInsightAvailability {
            purchase_events: capability(purchase_count > 0, "no item_purchase events were decoded"),
            purchase_spend: capability(
                spend_is_complete,
                "decoded purchase events do not provide a complete explicit price field",
            ),
            utility_events: capability(
                utility_event_count > 0,
                "no grenade lifecycle events were decoded",
            ),
            utility_damage: capability(
                utility_damage_count > 0,
                "no utility-attributed player_hurt events were decoded",
            ),
            flash_effects: capability(flash_event_count > 0, "no player_blind events were decoded"),
            matchups: capability(
                matchups_available,
                "no identified attacker-target combat pairs were decoded",
            ),
        },
    }
}

fn derive_round_economy(
    analysis: &MatchAnalysis,
    teams: &BTreeSet<String>,
) -> Vec<RoundEconomyInsight> {
    analysis
        .rounds
        .iter()
        .map(|round| {
            let mut by_team = teams
                .iter()
                .cloned()
                .map(|team| (team, PurchaseAccumulator::default()))
                .collect::<BTreeMap<_, _>>();
            let mut unattributed_purchase_count = 0_u32;
            for event in round
                .events
                .iter()
                .filter(|event| event.kind == EventKind::Purchase)
            {
                // A player's side changes at halftime. Only the team carried
                // by this purchase event is valid for a per-round side total.
                let team = detail_team(event);
                let Some(team) = team else {
                    unattributed_purchase_count = unattributed_purchase_count.saturating_add(1);
                    continue;
                };
                let accumulator = by_team.entry(team).or_default();
                accumulator.count = accumulator.count.saturating_add(1);
                let item = normalized_item_name(event.weapon.as_deref().unwrap_or("unknown"));
                let item_count = accumulator.items.entry(item).or_default();
                *item_count = item_count.saturating_add(1);
                if let Some(price) =
                    detail_u64(event, &["cost", "price", "item_cost", "purchase_cost"])
                {
                    accumulator.total_spend = accumulator.total_spend.saturating_add(price);
                } else {
                    accumulator.missing_price = true;
                }
            }
            RoundEconomyInsight {
                round: round.number,
                teams: by_team
                    .into_iter()
                    .map(|(team, accumulator)| TeamPurchaseInsight {
                        team,
                        purchase_count: accumulator.count,
                        items: counted_items(accumulator.items),
                        spend: (accumulator.count > 0 && !accumulator.missing_price)
                            .then_some(accumulator.total_spend),
                    })
                    .collect(),
                unattributed_purchase_count,
            }
        })
        .collect()
}

fn derive_player_utility(analysis: &MatchAnalysis) -> (Vec<PlayerUtilityInsight>, u64, u64, u64) {
    let mut players = analysis
        .players
        .iter()
        .map(|player| (player.steam_id.clone(), UtilityAccumulator::default()))
        .collect::<BTreeMap<_, _>>();
    let mut utility_event_count = 0_u64;
    let mut utility_damage_count = 0_u64;
    let mut flash_event_count = 0_u64;

    for event in analysis.rounds.iter().flat_map(|round| &round.events) {
        if event.kind == EventKind::Grenade {
            utility_event_count = utility_event_count.saturating_add(1);
            if event.id.starts_with("player_blind-") {
                flash_event_count = flash_event_count.saturating_add(1);
                let Some(actor) = event.actor.as_ref() else {
                    continue;
                };
                let accumulator = players.entry(actor.clone()).or_default();
                accumulator.flash_events = accumulator.flash_events.saturating_add(1);
                if let Some(target) = event.target.as_ref() {
                    accumulator.flashed_players.insert(target.clone());
                }
                if let Some(duration) = detail_f64(
                    event,
                    &["blind_duration", "blind_duration_full", "duration"],
                ) {
                    accumulator.flash_duration_seconds += duration.max(0.0);
                } else {
                    accumulator.missing_flash_duration = true;
                }
                continue;
            }
            let Some(actor) = event.actor.as_ref() else {
                continue;
            };
            let accumulator = players.entry(actor.clone()).or_default();
            if event.id.starts_with("grenade_thrown-") {
                accumulator.throws = accumulator.throws.saturating_add(1);
                let item = utility_name(event);
                let count = accumulator.items.entry(item).or_default();
                *count = count.saturating_add(1);
            } else if is_utility_activation(&event.id) {
                accumulator.detonations = accumulator.detonations.saturating_add(1);
            }
        }
        if event.kind == EventKind::Damage
            && event.weapon.as_deref().is_some_and(is_utility_weapon)
            && let Some(actor) = event.actor.as_ref()
        {
            utility_damage_count = utility_damage_count.saturating_add(1);
            let accumulator = players.entry(actor.clone()).or_default();
            accumulator.damage_events = accumulator.damage_events.saturating_add(1);
            accumulator.damage = accumulator
                .damage
                .saturating_add(detail_damage(event).unwrap_or(0));
        }
    }

    let summaries = players
        .into_iter()
        .map(|(player_id, accumulator)| PlayerUtilityInsight {
            player_id,
            throws: accumulator.throws,
            detonations: accumulator.detonations,
            items: counted_items(accumulator.items),
            damage: accumulator.damage,
            damage_events: accumulator.damage_events,
            flash_events: accumulator.flash_events,
            players_flashed: u32::try_from(accumulator.flashed_players.len()).unwrap_or(u32::MAX),
            flash_duration_seconds: (accumulator.flash_events > 0
                && !accumulator.missing_flash_duration)
                .then_some(accumulator.flash_duration_seconds),
        })
        .collect();
    (
        summaries,
        utility_event_count,
        utility_damage_count,
        flash_event_count,
    )
}

fn derive_matchups(analysis: &MatchAnalysis) -> Vec<PlayerMatchupInsight> {
    let mut directed = BTreeMap::<(String, String), MatchupAccumulator>::new();
    for event in analysis.rounds.iter().flat_map(|round| &round.events) {
        if !matches!(event.kind, EventKind::Kill | EventKind::Damage) {
            continue;
        }
        let (Some(actor), Some(target)) = (event.actor.as_ref(), event.target.as_ref()) else {
            continue;
        };
        if actor == target {
            continue;
        }
        let accumulator = directed.entry((actor.clone(), target.clone())).or_default();
        match event.kind {
            EventKind::Kill => {
                accumulator.kills = accumulator.kills.saturating_add(1);
                if event.headshot {
                    accumulator.headshot_kills = accumulator.headshot_kills.saturating_add(1);
                }
            }
            EventKind::Damage => {
                accumulator.damage_events = accumulator.damage_events.saturating_add(1);
                accumulator.damage = accumulator
                    .damage
                    .saturating_add(detail_damage(event).unwrap_or(0));
            }
            _ => {}
        }
    }

    let pairs = directed
        .keys()
        .flat_map(|(actor, target)| {
            [
                (actor.clone(), target.clone()),
                (target.clone(), actor.clone()),
            ]
        })
        .collect::<BTreeSet<_>>();
    pairs
        .into_iter()
        .map(|(player_id, opponent_id)| {
            let dealt = directed.get(&(player_id.clone(), opponent_id.clone()));
            let taken = directed.get(&(opponent_id.clone(), player_id.clone()));
            PlayerMatchupInsight {
                player_id,
                opponent_id,
                kills: dealt.map_or(0, |summary| summary.kills),
                deaths: taken.map_or(0, |summary| summary.kills),
                headshot_kills: dealt.map_or(0, |summary| summary.headshot_kills),
                damage_dealt: dealt.map_or(0, |summary| summary.damage),
                damage_taken: taken.map_or(0, |summary| summary.damage),
                damage_events: dealt.map_or(0, |summary| summary.damage_events),
            }
        })
        .collect()
}

fn capability(available: bool, unavailable_reason: &str) -> InsightCapability {
    if available {
        InsightCapability::available()
    } else {
        InsightCapability::unavailable(unavailable_reason)
    }
}

fn counted_items(items: BTreeMap<String, u32>) -> Vec<CountedItem> {
    items
        .into_iter()
        .map(|(name, count)| CountedItem { name, count })
        .collect()
}

fn normalized_item_name(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    let normalized = lower.strip_prefix("weapon_").unwrap_or(&lower).to_owned();
    if normalized.is_empty() {
        "unknown".to_owned()
    } else {
        normalized
    }
}

fn utility_name(event: &TimelineEvent) -> String {
    if let Some(weapon) = event.weapon.as_deref().filter(|weapon| !weapon.is_empty()) {
        return normalized_item_name(weapon);
    }
    for (prefix, name) in [
        ("hegrenade_", "hegrenade"),
        ("flashbang_", "flashbang"),
        ("smokegrenade_", "smokegrenade"),
        ("decoy_", "decoy"),
        ("inferno_", "inferno"),
    ] {
        if event.id.starts_with(prefix) {
            return name.to_owned();
        }
    }
    "grenade".to_owned()
}

fn is_utility_activation(event_id: &str) -> bool {
    [
        "hegrenade_detonate-",
        "flashbang_detonate-",
        "smokegrenade_detonate-",
        "decoy_started-",
        "inferno_startburn-",
    ]
    .iter()
    .any(|prefix| event_id.starts_with(prefix))
}

fn is_utility_weapon(weapon: &str) -> bool {
    let weapon = normalized_item_name(weapon);
    [
        "hegrenade",
        "flashbang",
        "smokegrenade",
        "decoy",
        "molotov",
        "incgrenade",
        "inferno",
    ]
    .iter()
    .any(|candidate| weapon.contains(candidate))
}

fn detail_damage(event: &TimelineEvent) -> Option<u32> {
    detail_u64(event, &["dmg_health", "damage"]).and_then(|damage| u32::try_from(damage).ok())
}

fn detail_u64(event: &TimelineEvent, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let value = event.detail.get(*key)?;
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
    })
}

fn detail_f64(event: &TimelineEvent, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| event.detail.get(*key))
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
}

fn detail_team(event: &TimelineEvent) -> Option<String> {
    ["team", "teamnum", "userteam", "actor_team"]
        .iter()
        .find_map(|key| event.detail.get(*key))
        .and_then(|value| {
            if let Some(number) = value.as_i64() {
                return match number {
                    2 => Some("T".to_owned()),
                    3 => Some("CT".to_owned()),
                    _ => None,
                };
            }
            let text = value.as_str()?.trim().to_ascii_uppercase();
            match text.as_str() {
                "2" | "T" | "TERRORIST" => Some("T".to_owned()),
                "3" | "CT" | "COUNTER-TERRORIST" | "COUNTER_TERRORIST" => Some("CT".to_owned()),
                _ => None,
            }
        })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::{Highlight, PlayerStats, RoundSummary, TeamSummary};

    fn event(
        id: &str,
        kind: EventKind,
        actor: Option<&str>,
        target: Option<&str>,
        weapon: Option<&str>,
        detail: serde_json::Value,
    ) -> TimelineEvent {
        TimelineEvent {
            id: id.to_owned(),
            tick: 100,
            seconds: 1.5,
            kind,
            actor: actor.map(str::to_owned),
            target: target.map(str::to_owned),
            weapon: weapon.map(str::to_owned),
            headshot: id.starts_with("headshot"),
            penetrated: false,
            position: None,
            detail,
        }
    }

    fn analysis(events: Vec<TimelineEvent>) -> MatchAnalysis {
        MatchAnalysis {
            demo_id: Uuid::nil(),
            map_name: "de_test".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 30.0,
            teams: Vec::<TeamSummary>::new(),
            players: [("alice", "T"), ("bob", "CT"), ("cara", "T")]
                .into_iter()
                .map(|(id, team)| PlayerStats {
                    steam_id: id.to_owned(),
                    name: id.to_owned(),
                    team: team.to_owned(),
                    kills: 0,
                    deaths: 0,
                    assists: 0,
                    headshots: 0,
                    damage: 0,
                    adr: 0.0,
                    rating: 0.0,
                    score: 0,
                })
                .collect(),
            rounds: vec![RoundSummary {
                number: 1,
                start_tick: 0,
                end_tick: 200,
                winner: "T".to_owned(),
                reason: "elimination".to_owned(),
                team_a_score: 1,
                team_b_score: 0,
                events,
            }],
            highlights: Vec::<Highlight>::new(),
        }
    }

    #[test]
    fn aggregates_only_explicit_economy_and_utility_evidence() {
        let analysis = analysis(vec![
            event(
                "item_purchase-10-1",
                EventKind::Purchase,
                Some("alice"),
                None,
                Some("weapon_ak47"),
                json!({"price": 2700, "team": 2}),
            ),
            event(
                "item_purchase-11-2",
                EventKind::Purchase,
                Some("alice"),
                None,
                Some("smokegrenade"),
                json!({"team": 2}),
            ),
            event(
                "grenade_thrown-20-3",
                EventKind::Grenade,
                Some("alice"),
                None,
                Some("weapon_smokegrenade"),
                json!({}),
            ),
            event(
                "hegrenade_detonate-30-4",
                EventKind::Grenade,
                Some("alice"),
                None,
                None,
                json!({}),
            ),
            event(
                "player_hurt-31-5",
                EventKind::Damage,
                Some("alice"),
                Some("bob"),
                Some("hegrenade"),
                json!({"dmg_health": 42}),
            ),
            event(
                "player_blind-32-6",
                EventKind::Grenade,
                Some("alice"),
                Some("bob"),
                None,
                json!({"blind_duration": 2.25}),
            ),
        ]);

        let insights = analysis.derived_insights();
        let t = &insights.round_economy[0].teams[1];
        assert_eq!(t.team, "T");
        assert_eq!(t.purchase_count, 2);
        assert_eq!(t.items[0].name, "ak47");
        assert_eq!(t.spend, None, "partial prices must not be estimated");
        let utility = insights
            .player_utility
            .iter()
            .find(|summary| summary.player_id == "alice")
            .unwrap();
        assert_eq!(utility.throws, 1);
        assert_eq!(utility.detonations, 1);
        assert_eq!(utility.damage, 42);
        assert_eq!(utility.players_flashed, 1);
        assert_eq!(utility.flash_duration_seconds, Some(2.25));
        assert!(insights.availability.purchase_events.available);
        assert!(!insights.availability.purchase_spend.available);
        assert!(insights.availability.flash_effects.available);

        let wire = serde_json::to_value(&analysis).unwrap();
        assert_eq!(wire["insights"]["player_utility"][0]["throws"], 1);
        let round_trip: MatchAnalysis = serde_json::from_value(wire).unwrap();
        assert_eq!(round_trip, analysis);
    }

    #[test]
    fn produces_directional_player_matchups() {
        let analysis = analysis(vec![
            event(
                "headshot-kill",
                EventKind::Kill,
                Some("alice"),
                Some("bob"),
                Some("ak47"),
                json!({}),
            ),
            event(
                "damage",
                EventKind::Damage,
                Some("alice"),
                Some("bob"),
                Some("ak47"),
                json!({"dmg_health": 88}),
            ),
            event(
                "return-damage",
                EventKind::Damage,
                Some("bob"),
                Some("alice"),
                Some("m4a1"),
                json!({"dmg_health": 31}),
            ),
        ]);

        let insights = analysis.derived_insights();
        let alice = insights
            .matchups
            .iter()
            .find(|summary| summary.player_id == "alice")
            .unwrap();
        assert_eq!(alice.opponent_id, "bob");
        assert_eq!(alice.kills, 1);
        assert_eq!(alice.deaths, 0);
        assert_eq!(alice.headshot_kills, 1);
        assert_eq!(alice.damage_dealt, 88);
        assert_eq!(alice.damage_taken, 31);
    }

    #[test]
    fn missing_event_classes_remain_explicitly_unavailable() {
        let insights = analysis(Vec::new()).derived_insights();

        assert!(!insights.availability.purchase_events.available);
        assert!(!insights.availability.purchase_spend.available);
        assert!(!insights.availability.utility_events.available);
        assert!(!insights.availability.utility_damage.available);
        assert!(!insights.availability.flash_effects.available);
        assert!(!insights.availability.matchups.available);
        assert!(
            insights
                .availability
                .purchase_events
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("item_purchase"))
        );
    }
}
