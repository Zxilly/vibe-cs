import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { PlayerHeatmap, RadarOverviewRecord } from '../../shared/desktop/dto';
import { PlayerHeatmapWorkspace } from './PlayerHeatmapWorkspace';

const heatmap: PlayerHeatmap = {
  steam_id: '76561198000000001',
  map_name: 'de_mirage',
  points: [
    {
      demo_id: '00000000-0000-0000-0000-000000000001',
      evidence_id: 'demo:00000000-0000-0000-0000-000000000001/event:kill-1',
      round: 7,
      tick: 640,
      kind: 'kills',
      x: -2200,
      y: 800,
      floor: 0,
      analysis_href: '/analysis?demo=00000000-0000-0000-0000-000000000001&tab=rounds&round=7&tick=640&evidence=demo%3A00000000-0000-0000-0000-000000000001%2Fevent%3Akill-1&player=76561198000000001',
      replay_href: '/analysis?demo=00000000-0000-0000-0000-000000000001&tab=replay&round=7&tick=640&evidence=demo%3A00000000-0000-0000-0000-000000000001%2Fevent%3Akill-1&player=76561198000000001',
    },
    {
      demo_id: '00000000-0000-0000-0000-000000000002',
      evidence_id: 'demo:00000000-0000-0000-0000-000000000002/event:kill-2',
      round: 9,
      tick: 960,
      kind: 'deaths',
      x: -1800,
      y: 400,
      floor: 1,
      analysis_href: '/analysis?demo=00000000-0000-0000-0000-000000000002&tab=rounds&round=9&tick=960&evidence=demo%3A00000000-0000-0000-0000-000000000002%2Fevent%3Akill-2&player=76561198000000001',
      replay_href: '/analysis?demo=00000000-0000-0000-0000-000000000002&tab=replay&round=9&tick=960&evidence=demo%3A00000000-0000-0000-0000-000000000002%2Fevent%3Akill-2&player=76561198000000001',
    },
  ],
  total: 2,
  maximum_points: 5000,
  complete: true,
  coverage: { projected_demos: 3, total_analyses: 3, projection_complete: true },
};

const radar: RadarOverviewRecord = {
  map_name: 'de_mirage',
  transform: { pos_x: -3230, pos_y: 1713, scale: 5, rotate: false, zoom: null },
  image_url: '/api/maps/de_mirage/radar/image',
  image_mime: 'image/png',
  browser_displayable: true,
};

describe('PlayerHeatmapWorkspace', () => {
  it('renders exact kill/death points on the local radar with source-bound actions', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PlayerHeatmapWorkspace
          heatmap={heatmap}
          radar={radar}
          kind="all"
          onKindChange={() => undefined}
          onClose={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('跨比赛地图热图');
    expect(markup).toContain('data-coordinate-space="map-overview"');
    expect(markup).toContain('data-heat-kind="kills"');
    expect(markup).toContain('data-heat-kind="deaths"');
    expect(markup).toContain('2 / 2');
    expect(markup).toContain('tab=rounds');
    expect(markup).toContain('tab=replay');
    expect(markup).not.toContain('热图胜率');
  });

  it('fails closed when the server reports an intentionally bounded result', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PlayerHeatmapWorkspace
          heatmap={{ ...heatmap, points: [], total: 5001, complete: false }}
          radar={null}
          kind="kills"
          onKindChange={() => undefined}
          onClose={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('超过 5000 个上限');
    expect(markup).not.toContain('data-heat-kind');
  });

  it('filters a complete artifact without moving the remaining points', () => {
    const render = (kind: 'all' | 'kills') => renderToStaticMarkup(
      <MemoryRouter>
        <PlayerHeatmapWorkspace
          heatmap={heatmap}
          radar={null}
          kind={kind}
          onKindChange={() => undefined}
          onClose={() => undefined}
        />
      </MemoryRouter>,
    );

    const allMarkup = render('all');
    const killMarkup = render('kills');
    const killPosition = /data-heat-kind="kills" style="([^"]+)"/;

    expect(allMarkup.match(killPosition)?.[1]).toBe(killMarkup.match(killPosition)?.[1]);
    expect(killMarkup).toContain('1 / 2');
    expect(killMarkup).not.toContain('data-heat-kind="deaths"');
  });
});
