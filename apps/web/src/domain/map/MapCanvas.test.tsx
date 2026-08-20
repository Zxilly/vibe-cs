import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { MapCanvas, MAP_CANVAS_EXTENT } from './MapCanvas';
import type { MapProjection } from './mapProjection';

describe('MapCanvas', () => {
  it('draws a square canvas with the accessible name it was given', () => {
    const html = renderMarkup(<MapCanvas mapName="de_mirage" label="Mirage · 第 21 回合" />);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Mirage · 第 21 回合"');
    expect(html).toContain(`viewBox="0 0 ${MAP_CANVAS_EXTENT} ${MAP_CANVAS_EXTENT}"`);
    expect(html).toContain('aspect-square');
  });

  it('stands in with a blueprint grid when the page has no basemap', () => {
    const html = renderMarkup(<MapCanvas mapName="de_mirage" label="Mirage" />);
    expect(html).toContain('data-testid="map-blueprint-grid"');
    expect(html).toContain('stroke-grid');
  });

  it('drops the grid when a basemap is supplied, and never fetches one itself', () => {
    const html = renderMarkup(
      <MapCanvas mapName="de_mirage" label="Mirage" basemap={<div data-testid="page-basemap" />} />,
    );
    expect(html).toContain('data-testid="page-basemap"');
    expect(html).not.toContain('data-testid="map-blueprint-grid"');
    expect(html).not.toContain('http');
  });

  it('crops the basemap and projection to an explicitly focused world region', () => {
    const html = renderMarkup(
      <MapCanvas
        mapName="de_mirage"
        label="Mirage local shot"
        basemap={<div data-testid="page-basemap" />}
        focusBounds={{ minimum: { x: -1800, y: 600 }, maximum: { x: -1400, y: 1000 } }}
      />,
    );
    expect(html).toContain('data-map-focus="bounded"');
    expect(html).toContain('data-map-basemap-viewport="bounded"');
  });

  it('hands the projection to a render-callback child', () => {
    let seen: MapProjection | null = null;
    renderMarkup(
      <MapCanvas mapName="de_mirage" label="Mirage">
        {(projection) => {
          seen = projection;
          return null;
        }}
      </MapCanvas>,
    );
    const projection = seen as MapProjection | null;
    expect(projection).not.toBeNull();
    expect(projection?.calibration.mapName).toBe('de_mirage');
    expect(projection?.extent).toBe(MAP_CANVAS_EXTENT);
  });

  it('prefers a live overview transform over the built-in table', () => {
    let seen: MapProjection | null = null;
    renderMarkup(
      <MapCanvas
        mapName="de_mirage"
        label="Mirage"
        overviewTransform={{ pos_x: -1000, pos_y: 1000, scale: 4, rotate: false, zoom: null }}
      >
        {(projection) => {
          seen = projection;
          return null;
        }}
      </MapCanvas>,
    );
    expect((seen as MapProjection | null)?.calibration.originX).toBe(-1000);
  });

  it('says so on screen when it is drawing from a placeholder calibration', () => {
    const html = renderMarkup(<MapCanvas mapName="de_inferno" label="Inferno" />);
    expect(html).toContain('data-testid="map-calibration-warning"');
    expect(html).toContain('占位标定');
    expect(html).toContain('text-warn-text');
  });

  it('stays quiet when the calibration is one this repository can check', () => {
    const html = renderMarkup(<MapCanvas mapName="de_mirage" label="Mirage" />);
    expect(html).not.toContain('data-testid="map-calibration-warning"');
  });

  it('renders a state instead of an empty picture when no calibration can be found', () => {
    const html = renderMarkup(<MapCanvas mapName="de_nuke" label="Nuke" />);
    expect(html).toContain('缺少这张地图的雷达标定');
    expect(html).not.toContain('data-testid="map-blueprint-grid"');
  });

  it('renders the empty state without drawing a canvas of zeroes', () => {
    const html = renderMarkup(
      <MapCanvas mapName="de_mirage" label="Mirage" status="empty" emptyDescription="当前条件：第 21 回合" />,
    );
    expect(html).toContain('这张地图还没有空间证据');
    expect(html).toContain('当前条件：第 21 回合');
    expect(html).not.toContain('<svg');
  });

  it('renders the loading state with no percentage anywhere', () => {
    const html = renderMarkup(<MapCanvas mapName="de_mirage" label="Mirage" status="loading" />);
    expect(html).toContain('正在读取空间证据');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('%');
  });

  it('renders the failure state as an in-page Notice carrying a recovery action', () => {
    const html = renderMarkup(
      <MapCanvas
        mapName="de_mirage"
        label="Mirage"
        error={{ message: '空间证据读取失败', action: { label: '重试', onAction: () => {} } }}
      />,
    );
    expect(html).toContain('空间证据读取失败');
    expect(html).toContain('重试');
    expect(html).toContain('role="alert"');
  });

  it('draws the artboard legend chip', () => {
    const html = renderMarkup(
      <MapCanvas
        mapName="de_mirage"
        label="Mirage"
        legend={[
          { id: 'path', label: 'Kael 移动路线', glyph: 'line', tone: 'accent' },
          { id: 'duel', label: '经击杀验证的交战轴', glyph: 'dashed', tone: 'fail' },
        ]}
      />,
    );
    expect(html).toContain('Kael 移动路线');
    expect(html).toContain('经击杀验证的交战轴');
    expect(html).toContain('bg-accent-800');
    expect(html).toContain('border-fail');
  });

  it('gives the selection a written form in a live region', () => {
    const html = renderMarkup(
      <MapCanvas mapName="de_mirage" label="Mirage" selectionSummary="Kael → Corvin · 穿墙 · 交战轴 132° · 距离 18.7m" />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Kael → Corvin · 穿墙 · 交战轴 132° · 距离 18.7m');
  });

  it('renders the provenance footnote the artboard puts beside the canvas', () => {
    const html = renderMarkup(
      <MapCanvas mapName="de_mirage" label="Mirage" footnote="坐标来自本地 overview 与 VPK 雷达，采样 64 tick。" />,
    );
    expect(html).toContain('坐标来自本地 overview 与 VPK 雷达，采样 64 tick。');
  });

  it('paints from tokens only — no bare hex reaches the markup', () => {
    const html = renderMarkup(
      <MapCanvas
        mapName="de_mirage"
        label="Mirage"
        legend={[{ id: 'a', label: 'a', glyph: 'swatch', tone: 'team-b' }]}
        selectionSummary="x"
      />,
    );
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
