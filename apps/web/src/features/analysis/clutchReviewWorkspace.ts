import type { AnalysisWorkspace, Highlight } from '../../shared/desktop/dto';

export type ClutchOutcome = 'won' | 'attempt';

export type ClutchReviewFilter = {
  outcome: ClutchOutcome | null;
  opponent_count: number | null;
  player_id: string | null;
};

export type ClutchReviewEvidence = {
  evidence_id: string;
  demo_id: string;
  source_kind: 'highlight';
  source_id: string;
  outcome: ClutchOutcome;
  opponent_count: number;
  player_id: string;
  player_name: string;
  round: number;
  tick: number;
  end_tick: number;
  eliminations: number;
  survived: boolean;
  victim_ids: string[];
  victim_names: string[];
  highlight: Highlight;
};

export type ClutchReviewWorkspace = {
  availability: {
    state: 'available' | 'partial' | 'unavailable';
    reason: string | null;
  };
  summary: {
    opportunities: number;
    wins: number;
    attempts: number;
    rejected: number;
  };
  evidence: ClutchReviewEvidence[];
};

function opponentCount(tags: readonly string[]): number | null {
  const tagsWithCount = tags.flatMap((tag) => {
    const match = /^1v([2-5])$/u.exec(tag);
    return match ? [Number(match[1])] : [];
  });
  return tagsWithCount.length === 1 ? tagsWithCount[0] ?? null : null;
}

function clutchOutcome(highlight: Highlight): ClutchOutcome | null {
  if (highlight.kind === 'clutch'
    && highlight.tags.includes('clutch')
    && !highlight.tags.includes('clutch_attempt')
    && !highlight.tags.includes('failure')) return 'won';
  if (highlight.kind === 'fail'
    && highlight.tags.includes('clutch_attempt')
    && highlight.tags.includes('failure')
    && !highlight.tags.includes('clutch')) return 'attempt';
  return null;
}

function looksLikeClutchEvidence(highlight: Highlight): boolean {
  return highlight.kind === 'clutch'
    || highlight.tags.includes('clutch')
    || highlight.tags.includes('clutch_attempt');
}

export function buildClutchReviewWorkspace(
  workspace: AnalysisWorkspace,
  filter: ClutchReviewFilter,
): ClutchReviewWorkspace {
  const players = new Map(workspace.players.map((player) => [player.id, player]));
  const rounds = new Map(workspace.rounds.map((round) => [round.number, round]));
  const candidateCount = workspace.highlights.filter(looksLikeClutchEvidence).length;
  const allEvidence = workspace.highlights.flatMap((highlight): ClutchReviewEvidence[] => {
    if (!looksLikeClutchEvidence(highlight)) return [];
    const outcome = clutchOutcome(highlight);
    const opponents = opponentCount(highlight.tags);
    const player = players.get(highlight.player_id);
    const round = rounds.get(highlight.round);
    if (outcome === null
      || opponents === null
      || !player
      || !round
      || highlight.start_tick > highlight.end_tick
      || highlight.start_tick < round.start_tick
      || highlight.start_tick > round.end_tick) return [];
    const victims = highlight.victims.map((id) => players.get(id) ?? null);
    if (victims.some((victim) => !victim)
      || new Set(highlight.victims).size !== highlight.victims.length
      || highlight.victims.includes(player.id)
      || victims.some((victim) => victim?.team === player.team)
      || highlight.victims.length > opponents) return [];
    const survived = !round.events.some((event) => event.kind === 'kill'
      && event.target === player.id
      && event.tick >= highlight.start_tick);
    return [{
      evidence_id: `demo:${workspace.demo_id}/highlight:${highlight.id}`,
      demo_id: workspace.demo_id,
      source_kind: 'highlight',
      source_id: highlight.id,
      outcome,
      opponent_count: opponents,
      player_id: player.id,
      player_name: player.name,
      round: highlight.round,
      tick: highlight.start_tick,
      end_tick: highlight.end_tick,
      eliminations: highlight.victims.length,
      survived,
      victim_ids: [...highlight.victims],
      victim_names: victims.flatMap((victim) => victim ? [victim.name] : []),
      highlight,
    }];
  });
  const rejected = candidateCount - allEvidence.length;
  const evidence = allEvidence
    .filter((item) => filter.outcome === null || item.outcome === filter.outcome)
    .filter((item) => filter.opponent_count === null || item.opponent_count === filter.opponent_count)
    .filter((item) => filter.player_id === null || item.player_id === filter.player_id);
  return {
    availability: rejected === 0
      ? { state: 'available', reason: null }
      : allEvidence.length > 0
        ? {
            state: 'partial',
            reason: `${rejected} clutch candidate(s) were rejected because their authoritative fields were incomplete or inconsistent.`,
          }
        : {
            state: 'unavailable',
            reason: `${rejected} clutch candidate(s) could not prove an exact outcome and 1vN scenario.`,
          },
    summary: {
      opportunities: allEvidence.length,
      wins: allEvidence.filter((item) => item.outcome === 'won').length,
      attempts: allEvidence.filter((item) => item.outcome === 'attempt').length,
      rejected,
    },
    evidence,
  };
}
