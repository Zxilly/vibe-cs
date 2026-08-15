/*
 * `markup` project — the profile's heat map, and the two §10.3 gaps it stands
 * on.
 *
 *   gap 7  the aggregation is server-side missing. The page bins on arrival,
 *          which is only viable because the route caps the response — so the
 *          truncation has to be *stated* whenever the cap bit.
 *   gap 8  there is no basemap delivery path. The canvas must therefore draw
 *          its blueprint grid, and this phase must introduce no image asset.
 */

import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { PlayerHeatmapPanel } from './PlayerHeatmapPanel';
import { heatmapPoints, playerHeatmap } from './test/fixtures';

const base = {
  playerName: 'Kael',
  mapName: 'de_mirage',
  kind: 'kills' as const,
  onKindChange: () => undefined,
};

describe('with samples', () => {
  const html = renderMarkup(<PlayerHeatmapPanel {...base} heatmap={playerHeatmap()} />);

  it('draws binned cells, never one node per sample', () => {
    expect(html).toContain('data-layer="heat"');
    const bins = /data-bins="(\d+)"/u.exec(html);
    expect(bins).not.toBeNull();
    // 200 samples collapse into far fewer occupied cells.
    expect(Number(bins?.[1])).toBeLessThanOrEqual(200);
  });

  it('names what is being counted, with a measured denominator', () => {
    expect(html).toContain('Kael · 击杀位置');
    expect(html).toContain('个采样点');
  });

  it('states that nothing was cut when the response was complete', () => {
    expect(html).toContain('全部计入');
  });

  it('introduces no image — §10.3 gap 8 has no delivery path yet', () => {
    expect(html).toContain('map-blueprint-grid');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('background-image');
  });
});

describe('a truncated response', () => {
  it('says which sample the picture is drawn from', () => {
    const html = renderMarkup(
      <PlayerHeatmapPanel
        {...base}
        heatmap={playerHeatmap({ points: heatmapPoints(300), total: 12_480, complete: false })}
      />,
    );
    // A silent truncation is a bug — §10.3.
    expect(html).toContain('取样 300 / 12480');
    expect(html).toContain('不是全部');
  });
});

describe('a map with no calibration', () => {
  it('says the coordinates cannot be placed, rather than drawing them wrong', () => {
    const html = renderMarkup(
      <PlayerHeatmapPanel
        {...base}
        mapName="de_unknownmap"
        heatmap={playerHeatmap({ map_name: 'de_unknownmap' })}
      />,
    );
    expect(html).toContain('缺少这张地图的雷达标定');
    expect(html).not.toContain('data-layer="heat"');
  });
});

describe('no samples at all', () => {
  it('is an empty state, not an empty grid', () => {
    const html = renderMarkup(
      <PlayerHeatmapPanel
        {...base}
        heatmap={playerHeatmap({ points: [], total: 0, complete: true })}
      />,
    );
    expect(html).toContain('这张地图还没有空间证据');
  });
});

describe('a failed read', () => {
  it('renders in place with a recovery action', () => {
    const html = renderMarkup(
      <PlayerHeatmapPanel
        {...base}
        heatmap={undefined}
        error={{ message: '服务未启动', onRetry: () => undefined }}
      />,
    );
    expect(html).toContain('热图没能读出来：服务未启动');
    expect(html).toContain('data-notice-action="primary"');
  });
});
