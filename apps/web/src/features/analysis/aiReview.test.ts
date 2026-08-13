import { describe, expect, it } from 'vitest';

import {
  buildReviewRequest,
  maximumReviewHighlights,
  toggleReviewHighlight,
} from './aiReview';

describe('AI review request boundary', () => {
  it('only sends server-recognized selection fields', () => {
    expect(buildReviewRequest('match', 'analytical', 'ignored', ['ignored'])).toEqual({
      scope: 'match',
      tone: 'analytical',
      player_id: null,
      highlight_ids: [],
    });
    expect(buildReviewRequest('player', 'coach', 'player-1', ['ignored'])).toEqual({
      scope: 'player',
      tone: 'coach',
      player_id: 'player-1',
      highlight_ids: [],
    });
  });

  it('deduplicates and bounds highlight filters', () => {
    const identifiers = Array.from(
      { length: maximumReviewHighlights + 3 },
      (_, index) => `highlight-${index}`,
    );
    const request = buildReviewRequest(
      'highlights',
      'direct',
      null,
      [...identifiers, identifiers[0]!],
    );
    expect(request.highlight_ids).toHaveLength(maximumReviewHighlights);
    expect(new Set(request.highlight_ids).size).toBe(maximumReviewHighlights);
  });

  it('enforces player and selection constraints before network I/O', () => {
    expect(() => buildReviewRequest('player', 'coach', null, [])).toThrow();
    const full = Array.from(
      { length: maximumReviewHighlights },
      (_, index) => `highlight-${index}`,
    );
    expect(toggleReviewHighlight(full, 'one-too-many')).toEqual(full);
    expect(toggleReviewHighlight(['a', 'b'], 'a')).toEqual(['b']);
  });
});
