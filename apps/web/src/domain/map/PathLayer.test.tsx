import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import type { MapCalibration } from './mapCalibration';
import { createMapProjection } from './mapProjection';
import { PathLayer, type PlayerPath } from './PathLayer';

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

const kael: PlayerPath = {
  playerId: 'kael',
  playerName: 'Kael',
  side: 'CT',
  samples: [
    { tick: 148_812, x: 0, y: 1024 },
    { tick: 149_100, x: 512, y: 512 },
    { tick: 149_356, x: 1024, y: 0 },
  ],
};

const sable: PlayerPath = {
  playerId: 'sable',
  playerName: 'Sable',
  side: 'T',
  samples: [
    { tick: 148_900, x: 1024, y: 1024 },
    { tick: 149_200, x: 0, y: 0 },
  ],
};

describe('PathLayer', () => {
  it('draws one track per player, with the start dot the artboard draws', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[kael, sable]} />
      </svg>,
    );
    expect(html).toContain('data-path="kael"');
    expect(html).toContain('data-path="sable"');
    expect(html).toContain('data-role="track"');
    expect(html).toContain('data-role="track-start"');
    expect(html).toContain('d="M 0 0 L 360 360 L 720 720"');
  });

  it('marks the end of the track, so time has a direction', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[kael]} />
      </svg>,
    );
    expect(html).toContain('data-role="track-end"');
  });

  it('leaves the head off a track too short to carry one', () => {
    const stub: PlayerPath = {
      playerId: 'stub',
      playerName: 'Stub',
      samples: [
        { tick: 1, x: 0, y: 1024 },
        { tick: 2, x: 8, y: 1024 },
      ],
    };
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[stub]} />
      </svg>,
    );
    expect(html).toContain('data-role="track"');
    expect(html).not.toContain('data-role="track-end"');
  });

  it('paints the selected player in accent and everyone else in the opposing-side token', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[kael, sable]} selectedPlayerId="kael" />
      </svg>,
    );
    expect(html).toContain('stroke-accent-800');
    expect(html).toContain('stroke-team-b');
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it('emphasises a highlighted player without selecting it', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[sable]} highlightedPlayerId="sable" />
      </svg>,
    );
    expect(html).toContain('stroke-accent-800');
    expect(html).toContain('data-selected="false"');
  });

  it('carries the side as data, not as colour', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[kael, sable]} />
      </svg>,
    );
    expect(html).toContain('data-side="CT"');
    expect(html).toContain('data-side="T"');
  });

  it('names each track in words, with the tick range it covers', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[kael]} />
      </svg>,
    );
    expect(html).toContain('Kael 的移动路线');
    expect(html).toContain('3 个位置样本');
    expect(html).toContain('148812');
    expect(html).toContain('149356');
  });

  it('is inert without an onSelectPlayer — no tab stop, no listbox', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[kael]} />
      </svg>,
    );
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain('tabindex');
  });

  it('becomes a single-tab-stop listbox once selection is wired up', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[kael, sable]} selectedPlayerId="sable" onSelectPlayer={() => {}} />
      </svg>,
    );
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html.match(/tabindex="0"/gu)).toHaveLength(1);
    expect(html).toContain('aria-selected="true"');
  });

  it('renders the empty path as a labelled note', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[]} />
      </svg>,
    );
    expect(html).toContain('data-layer-state="empty"');
    expect(html).toContain('没有位置样本');
    expect(html).not.toContain('<path');
  });

  it('treats a roster of empty tracks as empty rather than drawing degenerate lines', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[{ playerId: 'ghost', playerName: 'Ghost', samples: [] }]} />
      </svg>,
    );
    expect(html).toContain('data-layer-state="empty"');
  });

  it('renders nothing when the page has the layer switched off', () => {
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={[kael]} visible={false} />
      </svg>,
    );
    expect(html).toBe('<svg></svg>');
  });
});
