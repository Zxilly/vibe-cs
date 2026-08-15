import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { binNormalizedSamples } from './heatBinning';
import { HeatLayer, HeatLegend, HEAT_STEP_FILL } from './HeatLayer';
import type { MapCalibration } from './mapCalibration';
import { createMapProjection } from './mapProjection';

const UNIT_MAP: MapCalibration = {
  mapName: 'de_unit',
  originX: 0,
  originY: 1024,
  unitsPerPixel: 1,
  overviewSize: 1024,
  confidence: 'verified',
  provenance: 'test fixture',
};

const projection = createMapProjection(UNIT_MAP, { width: 720, height: 720 });

/** Two occupied cells out of sixteen, weights 1 and 34 — the artboard's legend. */
const distribution = binNormalizedSamples(
  [
    { x: 0.1, y: 0.1, weight: 1 },
    { x: 0.9, y: 0.9, weight: 34 },
  ],
  { gridSize: 4, steps: 9 },
);

const empty = binNormalizedSamples([], { gridSize: 4 });

describe('HeatLayer', () => {
  it('draws one rect per occupied cell and none for the rest', () => {
    const html = renderMarkup(
      <svg>
        <HeatLayer projection={projection} distribution={distribution} />
      </svg>,
    );
    expect(html.match(/<rect/gu)).toHaveLength(2);
    expect(html).toContain('data-bins="2"');
  });

  it('places a cell where the projection puts it and sizes it to the grid', () => {
    const html = renderMarkup(
      <svg>
        <HeatLayer projection={projection} distribution={distribution} />
      </svg>,
    );
    // gridSize 4 over a 720 canvas → 180 per cell; the first bin is column 0, row 0.
    expect(html).toContain('width="180"');
    expect(html).toContain('x="0"');
  });

  it('takes its colour from the accent ladder, low cell to low rung', () => {
    const html = renderMarkup(
      <svg>
        <HeatLayer projection={projection} distribution={distribution} />
      </svg>,
    );
    expect(html).toContain(HEAT_STEP_FILL[0]);
    expect(html).toContain(HEAT_STEP_FILL[8]);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it('names itself with measured numbers only', () => {
    const html = renderMarkup(
      <svg>
        <HeatLayer projection={projection} distribution={distribution} subject="Kael 的死亡位置" />
      </svg>,
    );
    expect(html).toContain('Kael 的死亡位置');
    expect(html).toContain('2 个采样点');
    expect(html).toContain('最密处 34 次');
    expect(html).not.toContain('%');
  });

  it('renders the empty path as a labelled note, not as a grid of zeroes', () => {
    const html = renderMarkup(
      <svg>
        <HeatLayer projection={projection} distribution={empty} subject="Kael 的死亡位置" />
      </svg>,
    );
    expect(html).toContain('data-layer-state="empty"');
    expect(html).toContain('没有采样点');
    expect(html).not.toContain('<rect');
  });

  it('renders nothing when the page has the layer switched off', () => {
    const html = renderMarkup(
      <svg>
        <HeatLayer projection={projection} distribution={distribution} visible={false} />
      </svg>,
    );
    expect(html).toBe('<svg></svg>');
  });
});

describe('HeatLegend', () => {
  it('labels both ends with the observed counts, as the artboard does', () => {
    const html = renderMarkup(
      <HeatLegend distribution={distribution} caption="当前统计：Kael 在 Mirage 的死亡位置，覆盖 12 场比赛。" />,
    );
    expect(html).toContain('1 次');
    expect(html).toContain('34 次');
    expect(html).toContain('密度');
    expect(html).toContain('当前统计：Kael 在 Mirage 的死亡位置，覆盖 12 场比赛。');
  });

  it('draws the scale as the same finite ladder the cells were assigned from', () => {
    const html = renderMarkup(<HeatLegend distribution={distribution} />);
    expect(html).toContain('bg-accent-100');
    expect(html).toContain('bg-accent-900');
    expect(html).not.toContain('gradient');
  });

  it('draws no scale at all when nothing was measured', () => {
    const html = renderMarkup(<HeatLegend distribution={empty} />);
    expect(html).toContain('没有采样点');
    expect(html).not.toContain('data-testid="heat-legend"');
    expect(html).not.toContain('0 次');
  });
});
