export const ANALYSIS_TABS = [
  'overview',
  'players',
  'weapons',
  'utility',
  'economy',
  'duels',
  'openings',
  'advantage',
  'teams',
  'clutches',
  'insights',
  'review',
  'rounds',
  'replay',
  'heatmap',
  'highlights',
  'cosmetics',
] as const;

export type AnalysisTab = (typeof ANALYSIS_TABS)[number];

export type AnalysisNavigation = {
  tab: AnalysisTab;
  round: number;
  playerId: string | null;
  tick: number | null;
  evidenceId: string | null;
};

export type AnalysisNavigationBounds = {
  roundNumbers?: readonly number[];
  playerIds?: readonly string[];
  roundTickRanges?: readonly {
    number: number;
    startTick: number;
    endTick: number;
  }[];
};

export type AnalysisNavigationPatch = {
  tab?: AnalysisTab;
  round?: number | null;
  playerId?: string | null;
  opponentId?: string | null;
  tick?: number | null;
  evidenceId?: string | null;
};

const tabSet = new Set<string>(ANALYSIS_TABS);

function closestRound(requested: number, available: readonly number[]): number {
  return available.reduce((closest, candidate) => {
    const distance = Math.abs(candidate - requested);
    const closestDistance = Math.abs(closest - requested);
    return distance < closestDistance || (distance === closestDistance && candidate < closest)
      ? candidate
      : closest;
  });
}

export function readAnalysisNavigation(
  params: URLSearchParams,
  bounds: AnalysisNavigationBounds = {},
): AnalysisNavigation {
  const requestedTab = params.get('tab');
  const requestedRound = Number(params.get('round'));
  const positiveRound = Number.isSafeInteger(requestedRound) && requestedRound > 0 ? requestedRound : 1;
  const availableRounds = bounds.roundNumbers?.filter((round) => Number.isSafeInteger(round) && round > 0) ?? [];
  const requestedPlayerId = params.get('player')?.trim() || null;
  const availablePlayers = bounds.playerIds ?? [];
  const selectedRound = availableRounds.length > 0 ? closestRound(positiveRound, availableRounds) : positiveRound;
  const requestedTickValue = params.get('tick');
  const requestedTick = requestedTickValue === null ? null : Number(requestedTickValue);
  const tickRange = bounds.roundTickRanges?.find((range) => range.number === selectedRound);
  const tick = requestedTick !== null
    && Number.isSafeInteger(requestedTick)
    && requestedTick >= 0
    && (!tickRange || (requestedTick >= tickRange.startTick && requestedTick <= tickRange.endTick))
    ? requestedTick
    : null;
  const requestedEvidenceId = params.get('evidence')?.trim() || null;
  const evidenceId = requestedEvidenceId
    && requestedEvidenceId.length <= 512
    && /^demo:[^/]+\/(?:event|highlight|projection):.+$/u.test(requestedEvidenceId)
    ? requestedEvidenceId
    : null;
  return {
    tab: requestedTab && tabSet.has(requestedTab) ? requestedTab as AnalysisTab : 'overview',
    round: selectedRound,
    playerId: availablePlayers.length > 0 && (!requestedPlayerId || !availablePlayers.includes(requestedPlayerId))
      ? availablePlayers[0] ?? null
      : requestedPlayerId,
    tick,
    evidenceId,
  };
}

export function readAnalysisOpponent(
  params: URLSearchParams,
  availablePlayerIds: readonly string[] = [],
): string | null {
  const requestedOpponentId = params.get('opponent')?.trim() || null;
  if (!requestedOpponentId || requestedOpponentId.length > 256) return null;
  return availablePlayerIds.length > 0 && !availablePlayerIds.includes(requestedOpponentId)
    ? null
    : requestedOpponentId;
}

export function updateAnalysisNavigation(
  current: URLSearchParams,
  patch: AnalysisNavigationPatch,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (patch.tab !== undefined) next.set('tab', patch.tab);
  if (patch.round !== undefined) {
    if (patch.round === null) next.delete('round');
    else next.set('round', String(patch.round));
    if (patch.tick === undefined) next.delete('tick');
    if (patch.evidenceId === undefined) next.delete('evidence');
  }
  if (patch.playerId !== undefined) {
    if (patch.playerId) next.set('player', patch.playerId);
    else next.delete('player');
    if (patch.opponentId === undefined) next.delete('opponent');
    if (patch.evidenceId === undefined) next.delete('evidence');
  }
  if (patch.opponentId !== undefined) {
    if (patch.opponentId) next.set('opponent', patch.opponentId);
    else next.delete('opponent');
    if (patch.evidenceId === undefined) next.delete('evidence');
  }
  if (patch.tick !== undefined) {
    if (patch.tick === null) next.delete('tick');
    else next.set('tick', String(patch.tick));
  }
  if (patch.evidenceId !== undefined) {
    if (patch.evidenceId) next.set('evidence', patch.evidenceId);
    else next.delete('evidence');
  }
  return next;
}

export function frameIndexAtTick(ticks: readonly number[], targetTick: number): number {
  if (ticks.length === 0) return 0;
  let low = 0;
  let high = ticks.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((ticks[middle] ?? 0) < targetTick) low = middle + 1;
    else high = middle;
  }
  return (ticks[low] ?? 0) < targetTick ? ticks.length - 1 : low;
}
