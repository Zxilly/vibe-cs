/*
 * 1100 × 700 density review — `domain/map/` (spec §9 risk 6).
 *
 * The map is the one directory where the density question is not 「does it fit」
 * but 「how many DOM nodes does a real query produce」. `MapCanvas.tsx` states a
 * budget in its header — 10⁴ heat points collapsed to at most `gridSize²` cells,
 * ten paths whose sample count lives in a `d` attribute, a few hundred duels
 * that must stay individually clickable — and every one of those three claims is
 * checked here against `densityFixtures`' volumes rather than against four
 * hand-written points.
 *
 * Node counts are countable in `renderToStaticMarkup`, so unlike the layout
 * questions elsewhere in this review these assertions are exact.
 */

import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import {
  ENGAGEMENT_COUNT,
  HEAT_SAMPLE_COUNT,
  PATH_SAMPLE_COUNT,
  PLAYER_PATH_COUNT,
  makeEngagements,
  makeHeatSamples,
  makePlayerPaths,
} from '../densityFixtures';
import { EngagementLayer } from './EngagementLayer';
import { binWorldSamples, DEFAULT_HEAT_GRID_SIZE } from './heatBinning';
import { HeatLayer } from './HeatLayer';
import { MAP_CANVAS_EXTENT } from './MapCanvas';
import type { MapCalibration } from './mapCalibration';
import { createMapProjection } from './mapProjection';
import { PathLayer } from './PathLayer';

/** 1:1 world → overview, so a fixture's world units are also its pixels. */
const UNIT_MAP: MapCalibration = {
  mapName: 'de_unit',
  originX: 0,
  originY: 1024,
  unitsPerPixel: 1,
  overviewSize: 1024,
  confidence: 'verified',
  provenance: 'density fixture',
};

const projection = createMapProjection(UNIT_MAP, {
  width: MAP_CANVAS_EXTENT,
  height: MAP_CANVAS_EXTENT,
});

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('density · HeatLayer with a cross-match heat query', () => {
  const distribution = binWorldSamples(makeHeatSamples(HEAT_SAMPLE_COUNT), UNIT_MAP);

  it('bins twelve thousand samples below the gridSize² ceiling before the DOM', () => {
    expect(distribution.sampleCount).toBe(HEAT_SAMPLE_COUNT);
    expect(distribution.skippedCount).toBe(0);
    expect(distribution.bins.length).toBeLessThanOrEqual(DEFAULT_HEAT_GRID_SIZE ** 2);

    const html = renderMarkup(
      <svg>
        <HeatLayer projection={projection} distribution={distribution} subject="Kael 的死亡位置" />
      </svg>,
    );

    // One rect per *occupied* cell and not one per sample: the whole reason the
    // canvas can stay SVG at this volume.
    expect(occurrences(html, '<rect')).toBe(distribution.bins.length);
    expect(occurrences(html, '<rect')).toBeLessThan(HEAT_SAMPLE_COUNT / 10);
    // The sample count survives into the accessible name, so the reduction is
    // stated rather than hidden.
    expect(html).toContain(`共 ${String(HEAT_SAMPLE_COUNT)} 个采样点`);
  });
});

describe('density · PathLayer with a whole match of tracks', () => {
  it('keeps 240 tracks at three nodes each — the samples live in the `d`', () => {
    const paths = makePlayerPaths(PLAYER_PATH_COUNT, PATH_SAMPLE_COUNT);
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={paths} selectedPlayerId="player-0" />
      </svg>,
    );

    expect(occurrences(html, 'data-path=')).toBe(PLAYER_PATH_COUNT);
    // track + start dot + direction head. 144 000 samples, 720 elements.
    expect(occurrences(html, 'data-role="track"')).toBe(PLAYER_PATH_COUNT);
    expect(occurrences(html, 'data-role="track-start"')).toBe(PLAYER_PATH_COUNT);
    expect(occurrences(html, '<path')).toBeLessThanOrEqual(PLAYER_PATH_COUNT * 2);

    // The cost that *is* paid is markup bytes. Recorded rather than asserted
    // loosely: 240 × 600 points is about 3 MB of path commands, which is the
    // number a page has to weigh before it hands this many tracks to one layer.
    expect(html.length).toBeGreaterThan(1_000_000);
    expect(html.length).toBeLessThan(8_000_000);
  });

  it('is one tab stop for the whole layer, not one per track', () => {
    const paths = makePlayerPaths(PLAYER_PATH_COUNT, 8);
    const html = renderMarkup(
      <svg>
        <PathLayer projection={projection} paths={paths} onSelectPlayer={() => {}} selectedPlayerId="player-3" />
      </svg>,
    );

    expect(occurrences(html, 'tabindex="0"')).toBe(1);
    expect(occurrences(html, 'tabindex="-1"')).toBe(PLAYER_PATH_COUNT - 1);
  });
});

describe('density · EngagementLayer with a match of duels', () => {
  it('draws 190 duels as clickable, individually named objects', () => {
    const engagements = makeEngagements(ENGAGEMENT_COUNT);
    const html = renderMarkup(
      <svg>
        <EngagementLayer
          projection={projection}
          engagements={engagements}
          onSelectEngagement={() => {}}
          selectedEngagementId="duel-0"
        />
      </svg>,
    );

    expect(occurrences(html, 'data-engagement=')).toBe(ENGAGEMENT_COUNT);
    // Every duel keeps its own hit area — the 14-unit transparent line — so the
    // density does not quietly make them unhittable.
    expect(occurrences(html, 'data-role="hit-area"')).toBe(ENGAGEMENT_COUNT);
    // ~6 nodes each: hit line, axis, attacker dot, victim cross, and two rings
    // on the selected one only.
    expect(occurrences(html, '<line') + occurrences(html, '<circle') + occurrences(html, '<path')).toBeLessThan(
      ENGAGEMENT_COUNT * 7,
    );
    expect(occurrences(html, 'tabindex="0"')).toBe(1);
  });
});
