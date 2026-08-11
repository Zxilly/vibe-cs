import type { LlmReviewRequest, LlmReviewScope, LlmReviewTone } from '../../shared/api/dto';

export const maximumReviewHighlights = 24;

export function buildReviewRequest(
  scope: LlmReviewScope,
  tone: LlmReviewTone,
  playerId: string | null,
  selectedHighlightIds: readonly string[],
): LlmReviewRequest {
  if (scope === 'player' && !playerId) throw new Error('player review requires a player');
  const highlightIds = scope === 'highlights'
    ? [...new Set(selectedHighlightIds)].slice(0, maximumReviewHighlights)
    : [];
  return {
    scope,
    tone,
    highlight_ids: highlightIds,
    ...(scope === 'player' && playerId ? { player_id: playerId } : {}),
  };
}

export function toggleReviewHighlight(
  selected: readonly string[],
  highlightId: string,
): string[] {
  if (selected.includes(highlightId)) return selected.filter((id) => id !== highlightId);
  if (selected.length >= maximumReviewHighlights) return [...selected];
  return [...selected, highlightId];
}
