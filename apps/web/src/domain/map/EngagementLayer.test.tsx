import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { EngagementLayer, type Engagement } from './EngagementLayer';
import type { MapCalibration } from './mapCalibration';
import { createMapProjection } from './mapProjection';
import { HAMMER_UNITS_PER_METRE } from './pathGeometry';

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

/** Due east, 18.7m apart — the artboard's own numbers. */
const wallbang: Engagement = {
  id: 'ev-26',
  tick: 149_120,
  round: 21,
  attacker: { playerId: 'kael', playerName: 'Kael', side: 'CT', x: 100, y: 500 },
  victim: { playerId: 'corvin', playerName: 'Corvin', side: 'T', x: 100 + 18.7 * HAMMER_UNITS_PER_METRE, y: 500 },
  weapon: 'ak47',
  throughWall: true,
};

const headshot: Engagement = {
  id: 'ev-19',
  tick: 148_900,
  attacker: { playerId: 'kael', playerName: 'Kael', x: 200, y: 200 },
  victim: { playerId: 'sable', playerName: 'Sable', x: 400, y: 400 },
  weapon: 'deagle',
  headshot: true,
};

describe('EngagementLayer', () => {
  it('draws the artboard axis: a dashed line from attacker to an X on the victim', () => {
    const html = renderMarkup(
      <svg>
        <EngagementLayer projection={projection} engagements={[headshot]} />
      </svg>,
    );
    expect(html).toContain('data-role="axis"');
    expect(html).toContain('data-role="attacker"');
    expect(html).toContain('data-role="victim"');
    expect(html).toContain('stroke-dasharray="5 4"');
    expect(html).toContain('stroke-fail');
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it('gives a wallbang its own dash without recolouring the axis', () => {
    const html = renderMarkup(
      <svg>
        <EngagementLayer projection={projection} engagements={[wallbang]} />
      </svg>,
    );
    expect(html).toContain('stroke-dasharray="2 3"');
    expect(html).toContain('data-through-wall="true"');
    expect(html).toContain('stroke-fail');
  });

  it('names a duel exactly as the event list does, with the world angle and distance', () => {
    const html = renderMarkup(
      <svg>
        <EngagementLayer projection={projection} engagements={[wallbang]} />
      </svg>,
    );
    expect(html).toContain('Kael → Corvin · ak47');
    expect(html).toContain('穿墙');
    expect(html).toContain('交战轴 0°');
    expect(html).toContain('距离 18.7m');
  });

  it('lists the qualifiers it was given and no others', () => {
    const html = renderMarkup(
      <svg>
        <EngagementLayer
          projection={projection}
          engagements={[{ ...headshot, attackerBlind: true, victimBlind: true }]}
        />
      </svg>,
    );
    expect(html).toContain('爆头');
    expect(html).toContain('闪盲开火');
    expect(html).toContain('受害者被闪');
    expect(html).not.toContain('穿墙');
  });

  it('carries a hit target wider than the drawn stroke', () => {
    const html = renderMarkup(
      <svg>
        <EngagementLayer projection={projection} engagements={[headshot]} />
      </svg>,
    );
    expect(html).toContain('data-role="hit-area"');
    expect(html).toContain('stroke="transparent"');
  });

  it('marks the selected duel with a ring rather than a different hue', () => {
    const html = renderMarkup(
      <svg>
        <EngagementLayer projection={projection} engagements={[headshot]} selectedEngagementId="ev-19" />
      </svg>,
    );
    expect(html.match(/data-role="selection-ring"/gu)).toHaveLength(2);
    expect(html).toContain('stroke-accent-800');
    expect(html).toContain('data-selected="true"');
  });

  it('is inert without an onSelectEngagement', () => {
    const html = renderMarkup(
      <svg>
        <EngagementLayer projection={projection} engagements={[headshot]} />
      </svg>,
    );
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain('tabindex');
  });

  it('becomes a single-tab-stop listbox once selection is wired up', () => {
    const html = renderMarkup(
      <svg>
        <EngagementLayer
          projection={projection}
          engagements={[headshot, wallbang]}
          onSelectEngagement={() => {}}
        />
      </svg>,
    );
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/gu)).toHaveLength(2);
    expect(html.match(/tabindex="0"/gu)).toHaveLength(1);
  });

  it('renders the empty path as a labelled note', () => {
    const html = renderMarkup(
      <svg>
        <EngagementLayer projection={projection} engagements={[]} />
      </svg>,
    );
    expect(html).toContain('data-layer-state="empty"');
    expect(html).toContain('没有经击杀验证的交战轴');
    expect(html).not.toContain('<line');
  });

  it('renders nothing when the page has the layer switched off', () => {
    const html = renderMarkup(
      <svg>
        <EngagementLayer projection={projection} engagements={[headshot]} visible={false} />
      </svg>,
    );
    expect(html).toBe('<svg></svg>');
  });
});
