use std::collections::{BTreeMap, BTreeSet};

use vibe_cs_domain::{
    EventKind, Highlight, HighlightKind, PlayerStats, RoundSummary, TimelineEvent,
};

#[derive(Debug, Clone, Copy)]
pub struct HighlightPolicy {
    pub multi_kill_count: usize,
    pub multi_kill_window_ticks: u64,
}

impl Default for HighlightPolicy {
    fn default() -> Self {
        Self {
            multi_kill_count: 2,
            multi_kill_window_ticks: 640,
        }
    }
}

/// Deterministically classifies parsed events. It performs no I/O and does not
/// invent events that were absent from the demo.
#[must_use]
pub fn classify_highlights(rounds: &[RoundSummary], policy: HighlightPolicy) -> Vec<Highlight> {
    classify_highlights_with_players(rounds, &[], policy)
}

/// Classifies parsed events and roster-backed clutch/failure attempts.
///
/// Clutch classification requires stable player/team evidence. When that
/// evidence is absent, the ordinary event classifiers still run and no clutch
/// is guessed.
#[must_use]
pub fn classify_highlights_with_players(
    rounds: &[RoundSummary],
    players: &[PlayerStats],
    policy: HighlightPolicy,
) -> Vec<Highlight> {
    let mut highlights = Vec::new();
    for round in rounds {
        let before = highlights.len();
        classify_special_events(round, &mut highlights);
        classify_multi_kills(round, policy, &mut highlights);
        classify_clutch_attempts(round, players, &mut highlights);
        annotate_round_evidence(round, &mut highlights[before..]);
    }
    classify_cross_round_collections(rounds, &mut highlights);
    highlights.sort_by_key(|highlight| (highlight.start_tick, highlight.id.clone()));
    highlights
}

fn annotate_round_evidence(round: &RoundSummary, highlights: &mut [Highlight]) {
    let score_before_a = round
        .team_a_score
        .saturating_sub(u32::from(round.winner.eq_ignore_ascii_case("A")));
    let score_before_b = round
        .team_b_score
        .saturating_sub(u32::from(round.winner.eq_ignore_ascii_case("B")));
    let match_point = score_before_a == 12 || score_before_b == 12;
    let deciding_round = score_before_a == 12 && score_before_b == 12;
    let economy_upset = evidence_economy_upset(round);

    for highlight in highlights {
        if match_point {
            highlight.tags.push("match_point".to_owned());
        }
        if deciding_round {
            highlight.tags.push("deciding_round".to_owned());
        }
        if economy_upset {
            highlight.tags.push("economy_upset".to_owned());
        }
        for event in round.events.iter().filter(|event| {
            event.kind == EventKind::Kill
                && event.actor.as_deref() == Some(highlight.player_id.as_str())
                && (highlight.start_tick..=highlight.end_tick).contains(&event.tick)
        }) {
            if detail_i64_any(event, &["attacker_health", "health", "health_remaining"])
                .is_some_and(|health| (1..=10).contains(&health))
            {
                highlight.tags.push("low_health".to_owned());
            }
            if detail_f64_any(event, &["distance", "kill_distance"])
                .is_some_and(|distance| distance >= 1_500.0)
            {
                highlight.tags.push("long_distance".to_owned());
            }
            if detail_f64_any(event, &["attacker_speed", "speed", "velocity"])
                .is_some_and(|speed| speed >= 40.0)
            {
                highlight.tags.push("moving_kill".to_owned());
            }
        }
        highlight.tags.sort();
        highlight.tags.dedup();
    }
}

fn evidence_economy_upset(round: &RoundSummary) -> bool {
    if !matches!(round.winner.to_ascii_uppercase().as_str(), "A" | "B") {
        return false;
    }
    let mut totals = BTreeMap::<String, i64>::new();
    for event in round
        .events
        .iter()
        .filter(|event| event.kind == EventKind::Purchase)
    {
        let Some(team) = detail_string_any(event, &["team", "side", "player_team"])
            .and_then(|team| normalize_side_evidence(&team))
        else {
            return false;
        };
        let Some(cost) =
            detail_i64_any(event, &["cost", "price", "value"]).filter(|cost| *cost >= 0)
        else {
            return false;
        };
        *totals.entry(team).or_default() += cost;
    }
    let winner = round.winner.to_ascii_uppercase();
    let loser = if winner == "A" { "B" } else { "A" };
    totals
        .get(&winner)
        .zip(totals.get(loser))
        .is_some_and(|(won, lost)| {
            *won > 0 && *lost > 0 && won.saturating_mul(3) < lost.saturating_mul(2)
        })
}

fn normalize_side_evidence(value: &str) -> Option<String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "A" | "T" | "TERRORIST" | "2" => Some("A".to_owned()),
        "B" | "CT" | "COUNTER-TERRORIST" | "COUNTERTERRORIST" | "3" => Some("B".to_owned()),
        _ => None,
    }
}

fn classify_cross_round_collections(rounds: &[RoundSummary], output: &mut Vec<Highlight>) {
    let mut kills = BTreeMap::<String, Vec<&TimelineEvent>>::new();
    let mut deaths = BTreeMap::<String, Vec<&TimelineEvent>>::new();
    let mut matchups = BTreeMap::<(String, String), Vec<&TimelineEvent>>::new();
    for event in rounds
        .iter()
        .flat_map(|round| &round.events)
        .filter(|event| event.kind == EventKind::Kill)
    {
        let (Some(actor), Some(target)) = (event.actor.as_ref(), event.target.as_ref()) else {
            continue;
        };
        kills.entry(actor.clone()).or_default().push(event);
        deaths.entry(target.clone()).or_default().push(event);
        matchups
            .entry((actor.clone(), target.clone()))
            .or_default()
            .push(event);
    }
    for (player, events) in kills.iter().filter(|(_, events)| events.len() >= 2) {
        push_timeline_collection(
            output,
            rounds,
            player,
            events,
            "kill_reel",
            "Full-match elimination reel",
            HighlightKind::Timeline,
        );
    }
    for (player, events) in deaths.iter().filter(|(_, events)| events.len() >= 2) {
        push_timeline_collection(
            output,
            rounds,
            player,
            events,
            "death_reel",
            "Full-match death reel",
            HighlightKind::Fail,
        );
    }
    for ((killer, victim), events) in matchups.into_iter().filter(|(_, events)| events.len() >= 3) {
        for (index, event) in events.iter().enumerate() {
            output.push(Highlight {
                id: format!("timeline:{killer}:{victim}:nemesis:{}", event.id),
                player_id: killer.clone(),
                round: round_for_tick(rounds, event.tick),
                start_tick: event.tick.saturating_sub(96),
                end_tick: event.tick.saturating_add(160),
                kind: HighlightKind::Timeline,
                title: format!("Nemesis matchup · {}/{}", index + 1, events.len()),
                description: format!("Decoded elimination against {victim}"),
                score: 0.65,
                tags: vec![
                    "timeline".to_owned(),
                    "nemesis".to_owned(),
                    format!("collection:nemesis:{killer}:{victim}"),
                ],
                victims: vec![victim.clone()],
            });
        }
    }
}

fn push_timeline_collection(
    output: &mut Vec<Highlight>,
    rounds: &[RoundSummary],
    player: &str,
    events: &[&TimelineEvent],
    tag: &str,
    title: &str,
    kind: HighlightKind,
) {
    for (index, event) in events.iter().enumerate() {
        output.push(Highlight {
            id: format!("timeline:{player}:{tag}:{}", event.id),
            player_id: player.to_owned(),
            round: round_for_tick(rounds, event.tick),
            start_tick: event.tick.saturating_sub(96),
            end_tick: event.tick.saturating_add(160),
            kind,
            title: format!("{title} · {}/{}", index + 1, events.len()),
            description:
                "Decoded event retained as an individual clip in the chronological collection"
                    .to_owned(),
            score: 0.5,
            tags: vec![
                "timeline".to_owned(),
                tag.to_owned(),
                format!("collection:{tag}:{player}"),
            ],
            victims: (tag == "kill_reel")
                .then(|| event.target.clone())
                .flatten()
                .into_iter()
                .collect(),
        });
    }
}

fn round_for_tick(rounds: &[RoundSummary], tick: u64) -> u32 {
    rounds
        .iter()
        .find(|round| (round.start_tick..=round.end_tick).contains(&tick))
        .map_or(0, |round| round.number)
}

#[derive(Debug, Clone)]
struct ClutchCandidate {
    player_id: String,
    team: String,
    opponents_at_start: usize,
    start_tick: u64,
}

fn classify_clutch_attempts(
    round: &RoundSummary,
    players: &[PlayerStats],
    output: &mut Vec<Highlight>,
) {
    let player_teams = round_player_teams(round, players);
    let teams = player_teams
        .values()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if teams.len() != 2 {
        return;
    }

    let mut alive = teams
        .iter()
        .map(|team| {
            let members = player_teams
                .iter()
                .filter_map(|(player, player_team)| {
                    (player_team == team).then_some(player.as_str())
                })
                .collect::<BTreeSet<_>>();
            (*team, members)
        })
        .collect::<BTreeMap<_, _>>();
    if alive.values().any(|members| members.len() < 2) {
        return;
    }

    let mut candidates = BTreeMap::<&str, ClutchCandidate>::new();
    let mut kills = round
        .events
        .iter()
        .filter(|event| event.kind == EventKind::Kill)
        .collect::<Vec<_>>();
    kills.sort_by_key(|event| event.tick);

    for event in &kills {
        if let Some(target) = event.target.as_deref()
            && let Some(team) = player_teams.get(target).map(String::as_str)
            && let Some(members) = alive.get_mut(team)
        {
            members.remove(target);
        }

        for team in &teams {
            if candidates.contains_key(team) {
                continue;
            }
            let Some(team_alive) = alive.get(team) else {
                continue;
            };
            if team_alive.len() != 1 {
                continue;
            }
            let opponents = alive
                .iter()
                .filter(|(other, _)| *other != team)
                .map(|(_, members)| members.len())
                .sum::<usize>();
            if opponents < 2 {
                continue;
            }
            let Some(player_id) = team_alive.first() else {
                continue;
            };
            candidates.insert(
                team,
                ClutchCandidate {
                    player_id: (*player_id).to_owned(),
                    team: (*team).to_owned(),
                    opponents_at_start: opponents,
                    start_tick: event.tick,
                },
            );
        }
    }

    for candidate in candidates.into_values() {
        let won = round.winner.eq_ignore_ascii_case(&candidate.team);
        let victims = kills
            .iter()
            .filter(|event| {
                event.tick >= candidate.start_tick
                    && event.actor.as_deref() == Some(candidate.player_id.as_str())
            })
            .filter_map(|event| event.target.clone())
            .collect::<Vec<_>>();
        if won && victims.is_empty() {
            continue;
        }
        let kind = if won {
            HighlightKind::Clutch
        } else {
            HighlightKind::Fail
        };
        let outcome = if won { "clutch" } else { "attempt" };
        let title = format!("1v{} {outcome}", candidate.opponents_at_start);
        let mut tags = vec![
            if won { "clutch" } else { "failure" }.to_owned(),
            format!("1v{}", candidate.opponents_at_start),
        ];
        if !won {
            tags.push("clutch_attempt".to_owned());
        }
        let opponent_score =
            f64::from(u32::try_from(candidate.opponents_at_start).unwrap_or(u32::MAX));
        output.push(Highlight {
            id: format!(
                "{}:{}:{}-{}",
                round.number, candidate.player_id, candidate.start_tick, outcome
            ),
            player_id: candidate.player_id,
            round: round.number,
            start_tick: candidate.start_tick.saturating_sub(128),
            end_tick: round.end_tick.saturating_add(96),
            kind,
            title,
            description: if won {
                format!(
                    "Won a 1v{} situation with {} elimination(s)",
                    candidate.opponents_at_start,
                    victims.len()
                )
            } else {
                format!(
                    "Reached a 1v{} situation but did not win the round",
                    candidate.opponents_at_start
                )
            },
            score: if won {
                (0.72 + opponent_score * 0.055).min(1.0)
            } else {
                (0.45 + opponent_score * 0.035).min(0.7)
            },
            tags,
            victims,
        });
    }
}

fn round_player_teams(round: &RoundSummary, players: &[PlayerStats]) -> BTreeMap<String, String> {
    if let Some(value) = round
        .events
        .iter()
        .find_map(|event| event.detail.get("_round_roster"))
    {
        let Some(roster) = value.as_object() else {
            return BTreeMap::new();
        };
        let teams = roster
            .iter()
            .filter_map(|(player, team)| {
                let team = team.as_str()?;
                (!player.trim().is_empty() && matches!(team, "T" | "CT"))
                    .then(|| (player.clone(), team.to_owned()))
            })
            .collect::<BTreeMap<_, _>>();
        return if teams.len() == roster.len() && teams.len() == players.len() {
            teams
        } else {
            BTreeMap::new()
        };
    }
    players
        .iter()
        .filter(|player| !player.steam_id.trim().is_empty() && !player.team.trim().is_empty())
        .map(|player| (player.steam_id.clone(), player.team.clone()))
        .collect()
}

fn classify_special_events(round: &RoundSummary, output: &mut Vec<Highlight>) {
    for event in &round.events {
        let Some(player_id) = event.actor.as_ref() else {
            continue;
        };
        let weapon = event
            .weapon
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let (kind, title, score, mut tags) = match event.kind {
            EventKind::Kill
                if event.target.as_ref() == Some(player_id) || detail_bool(event, "suicide") =>
            {
                (
                    HighlightKind::Fail,
                    "Self elimination",
                    0.62,
                    vec!["failure", "self_elimination"],
                )
            }
            EventKind::Kill if detail_bool(event, "teamkill") => (
                HighlightKind::Fail,
                "Team elimination",
                0.66,
                vec!["failure", "team_elimination"],
            ),
            EventKind::Kill if weapon.contains("knife") || weapon.contains("bayonet") => (
                HighlightKind::Knife,
                "Knife elimination",
                0.82,
                vec!["kill", "knife"],
            ),
            EventKind::Kill
                if weapon.contains("taser") || weapon == "zeus" || weapon == "weapon_taser" =>
            {
                (
                    HighlightKind::Taser,
                    "Taser elimination",
                    0.78,
                    vec!["kill", "taser"],
                )
            }
            EventKind::Kill if event.penetrated => (
                HighlightKind::Wallbang,
                "Wallbang",
                0.80,
                vec!["kill", "wallbang"],
            ),
            EventKind::Kill if detail_bool(event, "noscope") => (
                HighlightKind::NoScope,
                "No-scope elimination",
                0.84,
                vec!["kill", "no_scope"],
            ),
            EventKind::Kill
                if event.headshot
                    && detail_i64(event, "dmg_health").is_some_and(|damage| damage >= 100) =>
            {
                (
                    HighlightKind::OneTap,
                    "One-tap",
                    0.88,
                    vec!["kill", "headshot", "one_tap"],
                )
            }
            EventKind::BombDefuse => (
                HighlightKind::Defuse,
                "Bomb defused",
                0.72,
                vec!["objective", "defuse"],
            ),
            _ => continue,
        };
        if event.headshot && !tags.contains(&"headshot") {
            tags.push("headshot");
        }
        output.push(Highlight {
            id: format!("{}:{}:{:?}", round.number, event.id, kind).to_ascii_lowercase(),
            player_id: player_id.clone(),
            round: round.number,
            start_tick: event.tick.saturating_sub(96),
            end_tick: event.tick.saturating_add(160),
            kind,
            title: title.to_owned(),
            description: event.target.as_ref().map_or_else(
                || title.to_owned(),
                |target| format!("{title} against {target}"),
            ),
            score,
            tags: tags.into_iter().map(str::to_owned).collect(),
            victims: event.target.clone().into_iter().collect(),
        });
    }
}

fn classify_multi_kills(
    round: &RoundSummary,
    policy: HighlightPolicy,
    output: &mut Vec<Highlight>,
) {
    if policy.multi_kill_count < 2 {
        return;
    }
    let mut by_actor: BTreeMap<&str, Vec<&TimelineEvent>> = BTreeMap::new();
    for event in &round.events {
        if event.kind == EventKind::Kill
            && let Some(actor) = event.actor.as_deref()
        {
            by_actor.entry(actor).or_default().push(event);
        }
    }
    for (actor, mut kills) in by_actor {
        kills.sort_by_key(|event| event.tick);
        let mut start = 0;
        for end in 0..kills.len() {
            while kills[end].tick.saturating_sub(kills[start].tick) > policy.multi_kill_window_ticks
            {
                start += 1;
            }
            let count = end - start + 1;
            if count < policy.multi_kill_count {
                continue;
            }
            // Emit only the maximal window ending before a gap or at the final kill.
            let next_extends = kills.get(end + 1).is_some_and(|next| {
                next.tick.saturating_sub(kills[start].tick) <= policy.multi_kill_window_ticks
            });
            if next_extends {
                continue;
            }
            let victims = kills[start..=end]
                .iter()
                .filter_map(|event| event.target.clone())
                .collect::<Vec<_>>();
            output.push(Highlight {
                id: format!("{}:{}:{}-multikill", round.number, actor, kills[start].tick),
                player_id: actor.to_owned(),
                round: round.number,
                start_tick: kills[start].tick.saturating_sub(128),
                end_tick: kills[end].tick.saturating_add(192),
                kind: HighlightKind::MultiKill,
                title: format!("{count}K sequence"),
                description: format!("{count} eliminations in a short interval"),
                score: (0.65 + (f64::from(u32::try_from(count).unwrap_or(u32::MAX)) * 0.07))
                    .min(1.0),
                tags: vec![
                    "kill".to_owned(),
                    "multi_kill".to_owned(),
                    format!("{count}k"),
                ],
                victims,
            });
        }
    }
}

fn detail_bool(event: &TimelineEvent, key: &str) -> bool {
    event
        .detail
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn detail_i64(event: &TimelineEvent, key: &str) -> Option<i64> {
    event.detail.get(key).and_then(serde_json::Value::as_i64)
}

fn detail_i64_any(event: &TimelineEvent, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| detail_i64(event, key))
}

fn detail_f64_any(event: &TimelineEvent, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| event.detail.get(*key)?.as_f64())
        .filter(|value| value.is_finite())
}

fn detail_string_any(event: &TimelineEvent, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| event.detail.get(*key)?.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(id: &str, tick: u64, weapon: &str, headshot: bool, penetrated: bool) -> TimelineEvent {
        TimelineEvent {
            id: id.to_owned(),
            tick,
            seconds: f64::from(u32::try_from(tick).unwrap_or(u32::MAX)) / 64.0,
            kind: EventKind::Kill,
            actor: Some("alice".to_owned()),
            target: Some(format!("victim-{id}")),
            weapon: Some(weapon.to_owned()),
            headshot,
            penetrated,
            position: None,
            detail: json!({"dmg_health": 110}),
        }
    }

    fn round(events: Vec<TimelineEvent>) -> RoundSummary {
        RoundSummary {
            number: 3,
            start_tick: 0,
            end_tick: 1_000,
            winner: String::new(),
            reason: String::new(),
            team_a_score: 0,
            team_b_score: 0,
            events,
        }
    }

    fn player(id: &str, team: &str) -> PlayerStats {
        PlayerStats {
            steam_id: id.to_owned(),
            spectator_slot: None,
            name: id.to_owned(),
            team: team.to_owned(),
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

    fn elimination(id: &str, tick: u64, actor: &str, target: &str) -> TimelineEvent {
        TimelineEvent {
            id: id.to_owned(),
            tick,
            seconds: f64::from(u32::try_from(tick).unwrap_or(u32::MAX)) / 64.0,
            kind: EventKind::Kill,
            actor: Some(actor.to_owned()),
            target: Some(target.to_owned()),
            weapon: Some("ak47".to_owned()),
            headshot: false,
            penetrated: false,
            position: None,
            detail: json!({}),
        }
    }

    #[test]
    fn tags_multi_kill_and_one_tap() {
        let highlights = classify_highlights(
            &[round(vec![
                event("one", 100, "ak47", true, false),
                event("two", 180, "ak47", false, false),
            ])],
            HighlightPolicy::default(),
        );
        assert!(
            highlights
                .iter()
                .any(|item| item.kind == HighlightKind::OneTap)
        );
        let multi = highlights
            .iter()
            .find(|item| item.kind == HighlightKind::MultiKill)
            .unwrap();
        assert!(multi.tags.contains(&"multi_kill".to_owned()));
        assert!(multi.tags.contains(&"2k".to_owned()));
    }

    #[test]
    fn labels_wallbang_knife_and_no_scope() {
        let mut no_scope = event("scope", 300, "awp", false, false);
        no_scope.detail = json!({"noscope": true});
        let highlights = classify_highlights(
            &[round(vec![
                event("wall", 100, "m4a1", false, true),
                event("knife", 900, "weapon_knife", false, false),
                no_scope,
            ])],
            HighlightPolicy::default(),
        );
        assert!(
            highlights
                .iter()
                .any(|item| item.kind == HighlightKind::Wallbang)
        );
        assert!(
            highlights
                .iter()
                .any(|item| item.kind == HighlightKind::Knife)
        );
        assert!(
            highlights
                .iter()
                .any(|item| item.kind == HighlightKind::NoScope)
        );
    }

    #[test]
    fn classifies_roster_backed_clutch_and_failure_without_guessing() {
        let players = vec![
            player("a1", "T"),
            player("a2", "T"),
            player("a3", "T"),
            player("b1", "CT"),
            player("b2", "CT"),
            player("b3", "CT"),
        ];
        let mut won_round = round(vec![
            elimination("k1", 100, "b1", "a2"),
            elimination("k2", 120, "b2", "a3"),
            elimination("k3", 160, "a1", "b1"),
            elimination("k4", 180, "a1", "b2"),
            elimination("k5", 200, "a1", "b3"),
        ]);
        won_round.winner = "T".to_owned();
        won_round.end_tick = 220;
        let won =
            classify_highlights_with_players(&[won_round], &players, HighlightPolicy::default());
        let clutch = won
            .iter()
            .find(|item| item.kind == HighlightKind::Clutch)
            .expect("clutch");
        assert_eq!(clutch.player_id, "a1");
        assert_eq!(clutch.victims, ["b1", "b2", "b3"]);
        assert!(clutch.tags.contains(&"1v3".to_owned()));

        let mut lost_round = round(vec![
            elimination("l1", 100, "b1", "a2"),
            elimination("l2", 120, "b2", "a3"),
            elimination("l3", 160, "b3", "a1"),
        ]);
        lost_round.winner = "CT".to_owned();
        lost_round.end_tick = 180;
        let lost =
            classify_highlights_with_players(&[lost_round], &players, HighlightPolicy::default());
        assert!(
            lost.iter()
                .any(|item| item.kind == HighlightKind::Fail && item.player_id == "a1")
        );

        let no_roster = classify_highlights(
            &[round(vec![elimination("n1", 100, "a1", "b1")])],
            HighlightPolicy::default(),
        );
        assert!(
            !no_roster
                .iter()
                .any(|item| matches!(item.kind, HighlightKind::Clutch | HighlightKind::Fail))
        );
    }

    #[test]
    fn clutch_uses_round_roster_instead_of_final_post_halftime_sides() {
        let final_players = vec![
            player("a1", "CT"),
            player("a2", "CT"),
            player("a3", "CT"),
            player("b1", "T"),
            player("b2", "T"),
            player("b3", "T"),
        ];
        let mut round = round(vec![
            TimelineEvent {
                id: "round-start".to_owned(),
                tick: 0,
                seconds: 0.0,
                kind: EventKind::RoundStart,
                actor: None,
                target: None,
                weapon: None,
                headshot: false,
                penetrated: false,
                position: None,
                detail: json!({
                    "_round_roster": {
                        "a1": "T", "a2": "T", "a3": "T",
                        "b1": "CT", "b2": "CT", "b3": "CT"
                    }
                }),
            },
            elimination("k1", 100, "b1", "a2"),
            elimination("k2", 120, "b2", "a3"),
            elimination("k3", 160, "a1", "b1"),
            elimination("k4", 180, "a1", "b2"),
            elimination("k5", 200, "a1", "b3"),
        ]);
        round.winner = "T".to_owned();
        round.end_tick = 220;

        let highlights =
            classify_highlights_with_players(&[round], &final_players, HighlightPolicy::default());
        let clutch = highlights
            .iter()
            .find(|item| item.kind == HighlightKind::Clutch)
            .expect("round-backed clutch");
        assert_eq!(clutch.player_id, "a1");
        assert!(clutch.tags.contains(&"1v3".to_owned()));
    }

    #[test]
    fn adds_only_evidence_backed_context_and_cross_round_collections() {
        let mut first = round(vec![
            elimination("k1", 100, "alice", "bob"),
            elimination("k2", 140, "alice", "bob"),
        ]);
        first.number = 1;
        first.winner = "A".to_owned();
        first.team_a_score = 13;
        first.team_b_score = 12;
        first.events[0].detail = json!({"attacker_health": 7, "distance": 1700.0});

        let mut second = round(vec![elimination("k3", 1_100, "alice", "bob")]);
        second.number = 2;
        second.start_tick = 1_000;
        second.end_tick = 1_200;
        second.winner = "A".to_owned();

        let highlights = classify_highlights(&[first, second], HighlightPolicy::default());
        let contextual = highlights
            .iter()
            .find(|item| item.tags.contains(&"low_health".to_owned()))
            .expect("explicit low-health evidence");
        assert!(contextual.tags.contains(&"long_distance".to_owned()));
        assert!(contextual.tags.contains(&"match_point".to_owned()));
        assert!(!contextual.tags.contains(&"economy_upset".to_owned()));
        assert_eq!(
            highlights
                .iter()
                .filter(|item| item.kind == HighlightKind::Timeline
                    && item.tags.contains(&"nemesis".to_owned())
                    && item.victims == ["bob"])
                .count(),
            3
        );
    }
}
