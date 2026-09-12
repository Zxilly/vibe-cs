use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{EventKind, MatchAnalysis, RoundSummary};

pub const ROUND_EQUIPMENT_DETAIL: &str = "_round_equipment";

/// Exact player state sampled at the round's freeze-end tick.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlayerEquipmentSnapshot {
    pub side: String,
    #[serde(deserialize_with = "required_nullable")]
    pub equipment_value: Option<u32>,
    #[serde(deserialize_with = "required_nullable")]
    pub money: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RoundEquipmentSnapshot {
    pub freeze_end_tick: u64,
    pub players: BTreeMap<String, PlayerEquipmentSnapshot>,
}

/// Equipment carried by one stable team when the freeze period ends.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TeamEquipmentInsight {
    pub team: String,
    #[serde(deserialize_with = "required_nullable")]
    pub side: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub equipment_value: Option<u64>,
    #[serde(deserialize_with = "required_nullable")]
    pub buy_type: Option<EquipmentBuyType>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EquipmentBuyType {
    Pistol,
    Eco,
    SemiBuy,
    ForceBuy,
    FullBuy,
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

pub(crate) fn equipment_for_round(
    analysis: &MatchAnalysis,
    round: &RoundSummary,
) -> (Option<u64>, Vec<TeamEquipmentInsight>) {
    let starts = round
        .events
        .iter()
        .filter(|event| event.kind == EventKind::RoundStart)
        .collect::<Vec<_>>();
    let [start] = starts.as_slice() else {
        return (None, Vec::new());
    };
    let Some(snapshot) = start
        .detail
        .get(ROUND_EQUIPMENT_DETAIL)
        .and_then(|value| serde_json::from_value::<RoundEquipmentSnapshot>(value.clone()).ok())
        .filter(|value| {
            value.freeze_end_tick >= round.start_tick && value.freeze_end_tick <= round.end_tick
        })
    else {
        return (None, Vec::new());
    };

    let teams = ["A", "B"]
        .into_iter()
        .filter_map(|side| {
            let team = analysis.teams.iter().find(|team| team.side == side)?;
            let players = team
                .players
                .iter()
                .map(|id| snapshot.players.get(id))
                .collect::<Option<Vec<_>>>();
            let complete = players.as_ref().filter(|players| {
                players.len() == 5
                    && matches!(players[0].side.as_str(), "CT" | "T")
                    && players.iter().all(|player| player.side == players[0].side)
            });
            let equipment_value = complete.and_then(|players| {
                players.iter().try_fold(0_u64, |sum, player| {
                    let value = player.equipment_value.filter(|value| *value <= 100_000)?;
                    Some(sum + u64::from(value))
                })
            });
            let money = complete.and_then(|players| {
                players
                    .iter()
                    .try_fold(0_u64, |sum, player| Some(sum + u64::from(player.money?)))
            });
            let previous_winner = analysis
                .rounds
                .iter()
                .find(|previous| previous.number.checked_add(1) == Some(round.number))
                .map(|previous| previous.winner.as_str())
                .filter(|winner| matches!(*winner, "A" | "B"));
            let buy_type = complete.and_then(|players| {
                classify_buy(
                    equipment_value?,
                    money,
                    &players[0].side,
                    is_pistol_round(analysis, round, &team.players)?,
                    previous_winner.map(|winner| winner != side),
                )
            });
            Some(TeamEquipmentInsight {
                team: side.to_owned(),
                side: complete.map(|players| players[0].side.clone()),
                equipment_value,
                buy_type,
            })
        })
        .collect();
    (Some(snapshot.freeze_end_tick), teams)
}

// Competitive buy tiers use the same equipment/cash thresholds as CSDM's
// cs-demo-analyzer (pkg/api/economy.go). A low cash balance alone is not a force
// buy: the preceding round must have been lost.
fn classify_buy(
    equipment: u64,
    money: Option<u64>,
    side: &str,
    pistol: bool,
    lost_previous: Option<bool>,
) -> Option<EquipmentBuyType> {
    Some(if pistol {
        EquipmentBuyType::Pistol
    } else if equipment <= 5_000 {
        EquipmentBuyType::Eco
    } else if equipment >= if side == "CT" { 22_500 } else { 20_000 } {
        EquipmentBuyType::FullBuy
    } else if lost_previous? && money? < 2_000 {
        EquipmentBuyType::ForceBuy
    } else {
        EquipmentBuyType::SemiBuy
    })
}

// The first side swap starts the regulation second half; later swaps belong to
// overtime and must not create more pistol rounds. Require a contiguous history
// from round one instead of guessing a half length or treating a missing
// snapshot as evidence that no swap happened.
fn is_pistol_round(
    analysis: &MatchAnalysis,
    round: &RoundSummary,
    players: &[String],
) -> Option<bool> {
    if round.number == 1 {
        return Some(true);
    }
    let mut initial_side = None;
    for number in 1..=round.number {
        let prior = analysis
            .rounds
            .iter()
            .find(|value| value.number == number)?;
        let start = prior
            .events
            .iter()
            .find(|event| event.kind == EventKind::RoundStart)?;
        let snapshot = start.detail.get(ROUND_EQUIPMENT_DETAIL)?.get("players")?;
        let side = snapshot.get(players.first()?)?.get("side")?.as_str()?;
        if !matches!(side, "CT" | "T")
            || !players.iter().all(|player| {
                snapshot
                    .get(player)
                    .and_then(|value| value.get("side"))
                    .and_then(|value| value.as_str())
                    == Some(side)
            })
        {
            return None;
        }
        let first = *initial_side.get_or_insert(side);
        if side != first {
            return Some(number == round.number);
        }
    }
    Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PlayerStats, TeamSummary, TimelineEvent};

    fn fixture() -> MatchAnalysis {
        let ids = (0..10)
            .map(|index| format!("7656119800000000{index}"))
            .collect::<Vec<_>>();
        let teams = ["A", "B"]
            .into_iter()
            .enumerate()
            .map(|(index, side)| TeamSummary {
                name: side.to_owned(),
                side: side.to_owned(),
                score: 1,
                players: ids[index * 5..index * 5 + 5].to_vec(),
            })
            .collect();
        let players = ids
            .iter()
            .enumerate()
            .map(|(index, id)| PlayerStats {
                steam_id: id.clone(),
                spectator_slot: None,
                name: id.clone(),
                team: if index < 5 { "A" } else { "B" }.to_owned(),
                kills: 0,
                deaths: 0,
                assists: 0,
                headshots: 0,
                damage: 0,
                adr: 0.0,
                kill_death_ratio: 0.0,
                score: 0,
            })
            .collect();
        let rounds = [false, true]
            .into_iter()
            .enumerate()
            .map(|(index, swapped)| {
                let number = u32::try_from(index + 1).unwrap();
                let start_tick = u64::from(number) * 200 - 100;
                let snapshot = RoundEquipmentSnapshot {
                    freeze_end_tick: start_tick + 20,
                    players: ids
                        .iter()
                        .enumerate()
                        .map(|(index, id)| {
                            (
                                id.clone(),
                                PlayerEquipmentSnapshot {
                                    side: if (index < 5) == swapped { "CT" } else { "T" }
                                        .to_owned(),
                                    equipment_value: Some(if index < 5 { 5_000 } else { 4_000 }),
                                    money: Some(500),
                                },
                            )
                        })
                        .collect(),
                };
                RoundSummary {
                    number,
                    start_tick,
                    end_tick: start_tick + 100,
                    winner: if swapped { "B" } else { "A" }.to_owned(),
                    reason: "elimination".to_owned(),
                    team_a_score: 1,
                    team_b_score: u32::from(swapped),
                    events: vec![TimelineEvent {
                        id: format!("round-start-{number}"),
                        tick: start_tick,
                        seconds: f64::from(u32::try_from(start_tick).unwrap()) / 64.0,
                        kind: EventKind::RoundStart,
                        actor: None,
                        target: None,
                        weapon: None,
                        headshot: false,
                        penetrated: false,
                        position: None,
                        detail: serde_json::json!({ ROUND_EQUIPMENT_DETAIL: snapshot }),
                    }],
                }
            })
            .collect();
        MatchAnalysis {
            demo_id: uuid::Uuid::nil(),
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 6.25,
            verified_total_ticks: Some(400),
            teams,
            players,
            rounds,
            highlights: vec![],
        }
    }

    #[test]
    fn equipment_follows_stable_teams_across_side_swaps_and_serialization() {
        let analysis = fixture();
        let rows = analysis.derived_insights().round_economy;
        for row in &rows {
            assert_eq!(row.team_equipment[0].team, "A");
            assert_eq!(row.team_equipment[0].equipment_value, Some(25_000));
            assert_eq!(row.team_equipment[1].equipment_value, Some(20_000));
        }
        assert_eq!(rows[0].team_equipment[0].side.as_deref(), Some("T"));
        assert_eq!(rows[1].team_equipment[0].side.as_deref(), Some("CT"));
        let saved = serde_json::to_string(&analysis).unwrap();
        let loaded: MatchAnalysis = serde_json::from_str(&saved).unwrap();
        assert_eq!(loaded.derived_insights().round_economy, rows);
    }

    #[test]
    fn missing_player_or_value_does_not_become_zero_or_poison_the_other_team() {
        let mut analysis = fixture();
        analysis.rounds[0].events[0].detail[ROUND_EQUIPMENT_DETAIL]["players"]
            .as_object_mut()
            .unwrap()
            .remove("76561198000000009");
        analysis.rounds[1].events[0].detail[ROUND_EQUIPMENT_DETAIL]["players"]["76561198000000000"]
            ["equipment_value"] = serde_json::Value::Null;
        let rows = analysis.derived_insights().round_economy;
        assert_eq!(rows[0].team_equipment[0].equipment_value, Some(25_000));
        assert_eq!(rows[0].team_equipment[1].equipment_value, None);
        assert_eq!(rows[1].team_equipment[0].equipment_value, None);
        assert_eq!(rows[1].team_equipment[1].equipment_value, Some(20_000));
    }

    #[test]
    fn absent_or_out_of_round_freeze_evidence_remains_unavailable() {
        let mut analysis = fixture();
        analysis.rounds[0].events[0].detail = serde_json::json!({});
        analysis.rounds[1].events[0].detail[ROUND_EQUIPMENT_DETAIL]["freeze_end_tick"] =
            serde_json::json!(999);
        for row in analysis.derived_insights().round_economy {
            assert_eq!(row.freeze_end_tick, None);
            assert!(row.team_equipment.is_empty());
        }
    }

    #[test]
    fn buy_tiers_use_equipment_side_cash_and_previous_result() {
        let cases = [
            ("T", 5_000, Some(8_000), "B", Some(EquipmentBuyType::Eco)),
            ("T", 20_000, None, "B", Some(EquipmentBuyType::FullBuy)),
            ("CT", 22_500, None, "B", Some(EquipmentBuyType::FullBuy)),
            (
                "CT",
                22_499,
                Some(2_000),
                "B",
                Some(EquipmentBuyType::SemiBuy),
            ),
            (
                "T",
                19_999,
                Some(1_999),
                "B",
                Some(EquipmentBuyType::ForceBuy),
            ),
            (
                "T",
                19_999,
                Some(1_999),
                "A",
                Some(EquipmentBuyType::SemiBuy),
            ),
            ("T", 19_999, None, "B", None),
            ("T", 19_999, Some(1_999), "", None),
        ];
        for (side, equipment, money, winner, expected) in cases {
            let mut analysis = fixture();
            analysis.rounds[0].winner = winner.to_owned();
            for round in &mut analysis.rounds {
                for (index, player) in analysis.teams[0].players.iter().enumerate() {
                    let value =
                        &mut round.events[0].detail[ROUND_EQUIPMENT_DETAIL]["players"][player];
                    value["side"] = serde_json::json!(side);
                    value["equipment_value"] =
                        serde_json::json!(if index == 0 { equipment } else { 0 });
                    value["money"] =
                        serde_json::json!(money.map(|value| if index == 0 { value } else { 0 }));
                }
            }
            let rows = analysis.derived_insights().round_economy;
            assert_eq!(
                rows[0].team_equipment[0].buy_type,
                Some(EquipmentBuyType::Pistol)
            );
            assert_eq!(
                rows[1].team_equipment[0].buy_type, expected,
                "{side} / {equipment} / {money:?} / {winner}"
            );
        }
    }

    #[test]
    fn only_the_first_side_swap_starts_another_pistol_round() {
        let mut analysis = fixture();
        let mut overtime = analysis.rounds[0].clone();
        overtime.number = 3;
        analysis.rounds.push(overtime);
        let rows = analysis.derived_insights().round_economy;
        assert_eq!(
            rows[1].team_equipment[0].buy_type,
            Some(EquipmentBuyType::Pistol)
        );
        assert_eq!(
            rows[2].team_equipment[0].buy_type,
            Some(EquipmentBuyType::FullBuy)
        );

        analysis.rounds[0].events[0].detail = serde_json::json!({});
        let rows = analysis.derived_insights().round_economy;
        assert_eq!(rows[1].team_equipment[0].equipment_value, Some(25_000));
        assert_eq!(rows[1].team_equipment[0].buy_type, None);
    }
}
