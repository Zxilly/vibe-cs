use vibe_cs_domain::{
    DirectorPlan, DirectorShot, DirectorShotKind, Highlight, MatchAnalysis, RecordingRequest,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DirectorPolicy {
    pub merge_gap_ticks: u64,
    pub victim_reaction_ticks: u64,
    pub minimum_score: f64,
}

impl Default for DirectorPolicy {
    fn default() -> Self {
        Self {
            merge_gap_ticks: 96,
            victim_reaction_ticks: 96,
            minimum_score: 0.0,
        }
    }
}

/// Creates an evidence-backed shot list. A reaction shot is emitted only when
/// persisted analysis identifies a stable victim for the selected highlight.
#[must_use]
pub fn build_director_plan(
    requests: &[RecordingRequest],
    analyses: &[MatchAnalysis],
    policy: DirectorPolicy,
) -> DirectorPlan {
    let mut shots = Vec::new();
    let mut warnings = Vec::new();
    let mut unresolved_victim_requests = 0_usize;
    for request in requests {
        let highlight = analyses
            .iter()
            .find(|analysis| analysis.demo_id == request.demo_id)
            .and_then(|analysis| find_highlight(analysis, request.highlight_id.as_deref()));
        let score = highlight.map_or(0.0, |value| value.score);
        if score < policy.minimum_score {
            warnings.push(format!(
                "片段 {} 的证据评分低于导演阈值，已跳过",
                request.title
            ));
            continue;
        }
        let mut evidence = vec![format!(
            "tick {}..{}; target {}",
            request.start_tick, request.end_tick, request.player_id
        )];
        if let Some(highlight) = highlight {
            evidence.push(format!(
                "highlight {}; score {:.2}",
                highlight.id, highlight.score
            ));
            evidence.extend(highlight.tags.iter().take(4).cloned());
        } else {
            warnings.push(format!(
                "片段 {} 没有关联的分析高光，只保留用户指定主镜头",
                request.title
            ));
        }
        shots.push(DirectorShot {
            demo_id: request.demo_id,
            source_item_ids: request.id.into_iter().collect(),
            player_id: request.player_id.clone(),
            kind: DirectorShotKind::Player,
            start_tick: request.start_tick,
            end_tick: request.end_tick,
            score,
            evidence,
            explanation: format!("跟随 {} 的证据区间", request.player_id),
        });

        if request.victim_pov {
            if let Some((highlight, victim)) = highlight
                .and_then(|highlight| stable_victim(highlight).map(|victim| (highlight, victim)))
            {
                let duration = policy
                    .victim_reaction_ticks
                    .min(request.end_tick.saturating_sub(request.start_tick));
                shots.push(DirectorShot {
                    demo_id: request.demo_id,
                    source_item_ids: request.id.into_iter().collect(),
                    player_id: victim.to_owned(),
                    kind: DirectorShotKind::VictimReaction,
                    start_tick: request.end_tick.saturating_sub(duration),
                    end_tick: request.end_tick,
                    score,
                    evidence: vec![format!(
                        "highlight {} explicitly identifies victim {}",
                        highlight.id, victim
                    )],
                    explanation: "在击杀前插入短受害者反应镜头".to_owned(),
                });
            } else {
                unresolved_victim_requests = unresolved_victim_requests.saturating_add(1);
                warnings.push(format!(
                    "片段 {} 请求了受害者镜头，但分析中没有稳定身份，未生成该镜头",
                    request.title
                ));
            }
        }
    }

    let original_shot_count = shots.len();
    let shots = merge_adjacent_shots(shots, policy.merge_gap_ticks);
    let victim_reaction_count = shots
        .iter()
        .filter(|shot| shot.kind == DirectorShotKind::VictimReaction)
        .count();
    DirectorPlan {
        merged_item_count: original_shot_count.saturating_sub(shots.len()),
        shots,
        warnings,
        source_item_count: requests.len(),
        victim_reaction_count,
        unresolved_victim_requests,
    }
}

fn find_highlight<'a>(analysis: &'a MatchAnalysis, id: Option<&str>) -> Option<&'a Highlight> {
    id.and_then(|id| {
        analysis
            .highlights
            .iter()
            .find(|highlight| highlight.id == id)
    })
}

fn stable_victim(highlight: &Highlight) -> Option<&str> {
    highlight
        .victims
        .iter()
        .find(|victim| !victim.trim().is_empty() && victim.len() <= 128)
        .map(String::as_str)
}

fn merge_adjacent_shots(mut shots: Vec<DirectorShot>, maximum_gap: u64) -> Vec<DirectorShot> {
    shots.sort_by(|left, right| {
        (
            left.demo_id,
            &left.player_id,
            left.kind as u8,
            left.start_tick,
            left.end_tick,
        )
            .cmp(&(
                right.demo_id,
                &right.player_id,
                right.kind as u8,
                right.start_tick,
                right.end_tick,
            ))
    });
    let mut merged: Vec<DirectorShot> = Vec::with_capacity(shots.len());
    for shot in shots.drain(..) {
        if let Some(previous) = merged.last_mut()
            && previous.demo_id == shot.demo_id
            && previous.player_id == shot.player_id
            && previous.kind == shot.kind
            && shot.start_tick <= previous.end_tick.saturating_add(maximum_gap)
        {
            previous.end_tick = previous.end_tick.max(shot.end_tick);
            previous.score = previous.score.max(shot.score);
            previous.source_item_ids.extend(shot.source_item_ids);
            previous.evidence.extend(shot.evidence);
            "相邻同目标镜头已合并，避免重复 seek 和录制启停".clone_into(&mut previous.explanation);
            continue;
        }
        merged.push(shot);
    }
    merged.sort_by_key(|shot| (shot.demo_id, shot.start_tick, shot.end_tick));
    merged
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;
    use vibe_cs_domain::{HighlightKind, MatchAnalysis};

    use super::*;

    fn request(demo_id: Uuid, id: u128, start_tick: u64, end_tick: u64) -> RecordingRequest {
        RecordingRequest {
            id: Some(Uuid::from_u128(id)),
            demo_id,
            highlight_id: Some("h1".to_owned()),
            player_id: "attacker".to_owned(),
            title: format!("shot-{id}"),
            start_tick,
            end_tick,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: true,
            camera_style: Default::default(),
        }
    }

    fn analysis(demo_id: Uuid) -> MatchAnalysis {
        MatchAnalysis {
            demo_id,
            map_name: "de_test".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 30.0,
            verified_total_ticks: None,
            teams: Vec::new(),
            players: Vec::new(),
            rounds: Vec::new(),
            highlights: vec![Highlight {
                id: "h1".to_owned(),
                player_id: "attacker".to_owned(),
                round: 1,
                start_tick: 100,
                end_tick: 200,
                kind: HighlightKind::MultiKill,
                title: "two kills".to_owned(),
                description: String::new(),
                score: 0.9,
                tags: vec!["headshot".to_owned()],
                victims: vec!["victim".to_owned()],
            }],
        }
    }

    #[test]
    fn merges_adjacent_player_shots_and_keeps_evidence_backed_reactions() {
        let demo_id = Uuid::new_v4();
        let plan = build_director_plan(
            &[request(demo_id, 1, 100, 200), request(demo_id, 2, 220, 300)],
            &[analysis(demo_id)],
            DirectorPolicy::default(),
        );
        assert_eq!(plan.shots.len(), 2);
        let player = plan
            .shots
            .iter()
            .find(|shot| shot.kind == DirectorShotKind::Player)
            .expect("player shot");
        assert_eq!(player.source_item_ids.len(), 2);
        assert_eq!(plan.victim_reaction_count, 1);
        assert!(plan.warnings.is_empty());
    }

    #[test]
    fn refuses_to_invent_victim_identity() {
        let demo_id = Uuid::new_v4();
        let mut analysis = analysis(demo_id);
        analysis.highlights[0].victims.clear();
        let plan = build_director_plan(
            &[request(demo_id, 1, 100, 200)],
            &[analysis],
            DirectorPolicy::default(),
        );
        assert_eq!(plan.shots.len(), 1);
        assert!(plan.warnings[0].contains("没有稳定身份"));
    }
}
