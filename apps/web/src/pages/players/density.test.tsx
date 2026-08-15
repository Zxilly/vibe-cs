/*
 * `markup` project — the profile at the volumes that actually occur.
 *
 * The one worth pinning is the heat map. §10.3 gap 7 said 「上万个点不能从前端
 * 顶起来」; what makes the page survivable is that the route caps the response at
 * `maximum_points` = 5 000 (`crates/application/src/routes/players.rs:353`) and
 * that `binWorldSamples` collapses whatever arrives into at most `gridSize²`
 * occupied cells before anything reaches the DOM.
 *
 * So the assertion is the bound, at the cap: 5 000 samples in, at most 48² =
 * 2 304 `<rect>`s out — and in practice far fewer, because a map's playable
 * area is a fraction of its bounding square. If a later change ever put one
 * node per sample on screen, this test is what goes red.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_HEAT_GRID_SIZE } from '../../domain/map';
import { renderMarkup } from '../../test/render';
import { PlayerHeatmapPanel } from './PlayerHeatmapPanel';
import { PlayerMapTable } from './PlayerMapTable';
import { PlayerTrend } from './PlayerTrend';
import { heatmapPoints, playerHeatmap, playerMapItem, playerMatches } from './test/fixtures';

/** The service's own ceiling, transcribed. Not imported: it lives in Rust. */
const SERVER_HEATMAP_CAP = 5000;

const MAXIMUM_BINS = DEFAULT_HEAT_GRID_SIZE * DEFAULT_HEAT_GRID_SIZE;

describe('the heat map at the server cap', () => {
  const html = renderMarkup(
    <PlayerHeatmapPanel
      playerName="Kael"
      mapName="de_mirage"
      kind="all"
      onKindChange={() => undefined}
      heatmap={playerHeatmap({
        points: heatmapPoints(SERVER_HEATMAP_CAP),
        total: 12_480,
        complete: false,
      })}
    />,
  );

  it('never puts one node per sample on screen', () => {
    const rects = html.match(/<rect /gu) ?? [];
    expect(rects.length).toBeLessThanOrEqual(MAXIMUM_BINS + 2);
    expect(rects.length).toBeLessThan(SERVER_HEATMAP_CAP);
  });

  it('reports the number of bins it drew, so the bound is observable', () => {
    const bins = /data-bins="(\d+)"/u.exec(html);
    expect(bins).not.toBeNull();
    expect(Number(bins?.[1])).toBeLessThanOrEqual(MAXIMUM_BINS);
  });

  it('stays a size a 1100 × 700 window can paint', () => {
    // `domain/map/density.test.tsx` set 1 MB as the low edge of the *problem*
    // band for `PathLayer`; a binned heat layer must be far under it.
    expect(html.length).toBeLessThan(500_000);
  });

  it('says the picture is a sample — a silent truncation is a bug', () => {
    expect(html).toContain(`取样 ${String(SERVER_HEATMAP_CAP)} / 12480`);
  });
});

describe('the trend chart over the full window', () => {
  it('is one path however many matches it draws', () => {
    const html = renderMarkup(
      <PlayerTrend matches={playerMatches(20)} metric="kd" onMetricChange={() => undefined} />,
    );
    // The sample count lives inside the `d` attribute, not in the node count —
    // the same argument `MapCanvas` makes for paths.
    expect(html.match(/data-trend-path/gu)).toHaveLength(1);
    expect(html.length).toBeLessThan(20_000);
  });
});

describe('the 按地图 table over a full map pool', () => {
  it('keeps its scroll inside the panel', () => {
    const rows = ['de_mirage', 'de_ancient', 'de_nuke', 'de_overpass', 'de_inferno', 'de_anubis', 'de_dust2', 'de_train', 'de_vertigo'].map(
      (map) => playerMapItem({ map_name: map }),
    );
    const html = renderMarkup(<PlayerMapTable rows={rows} />);
    expect(html).toContain('overflow-auto');
    expect(html.match(/<tr /gu)?.length).toBeGreaterThanOrEqual(rows.length);
  });
});
