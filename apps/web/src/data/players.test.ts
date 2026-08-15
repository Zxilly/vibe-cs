/*
 * `unit` project — how much of a heat map came back.
 *
 * §10.3 gap 7 asked for server-side aggregation and it still does not exist;
 * what exists is a server-side *cap* (`maximum_points`, 5 000). That makes the
 * `complete` flag the only thing standing between an honest picture and one
 * that silently draws a fifth of the data as if it were all of it, so the flag
 * is turned into a value here and asserted.
 */

import { describe, expect, it } from 'vitest';

import { heatmapTruncation } from './players';
import { playerHeatmap, heatmapPoints } from '../pages/players/test/fixtures';

describe('heatmapTruncation', () => {
  it('says nothing was cut when the response is complete', () => {
    expect(heatmapTruncation(playerHeatmap())).toEqual({
      truncated: false,
      shown: 200,
      total: 200,
      limit: 5000,
    });
  });

  it('reports both halves of 「取样 5 000 / 12 480」', () => {
    const capped = playerHeatmap({
      points: heatmapPoints(5000),
      total: 12_480,
      complete: false,
    });
    expect(heatmapTruncation(capped)).toEqual({
      truncated: true,
      shown: 5000,
      total: 12_480,
      limit: 5000,
    });
  });

  it('trusts `complete` over comparing the two counts', () => {
    // They can also differ because a point failed to project, and only the
    // service knows which of the two happened.
    const odd = playerHeatmap({ points: heatmapPoints(10), total: 12, complete: true });
    expect(heatmapTruncation(odd).truncated).toBe(false);
    expect(heatmapTruncation(odd).shown).toBe(10);
  });
});
