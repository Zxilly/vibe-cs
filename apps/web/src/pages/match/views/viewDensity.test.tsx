/*
 * 1100 × 700 density review — 回放 / 高光 / Review (spec §9 risk 6).
 *
 * `domain/map/density.test.tsx` already measures what the *layers* cost at
 * `densityFixtures`' volumes. What is measured here is what these three pages
 * decide on top of them:
 *
 *   · the replay thins a whole-match track before it reaches `PathLayer`
 *     (§10.3 gap 1 measured 2.65 MB of markup for an unthinned one);
 *   · the highlight list scrolls **inside its own box** and prints the total,
 *     because 「横向/纵向滚动必须发生在容器内部，该截断的 truncate，该分页的分页
 *     且印总数」;
 *   · the Review panel's two columns each scroll on their own, so six
 *     unavailable-capability cards cannot push the header off screen.
 *
 * The folded content width is 996px (`FOLD_CONTENT_WIDTH_PX`) and the docked
 * one 616px; neither is measurable in `renderToStaticMarkup`, so what is
 * asserted here is the structural guarantee that makes the width survivable —
 * a scroll container with `min-h-0` above it — plus the counts, which are
 * exact.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  useCreateMatchAnnotation,
  useDeleteMatchAnnotation,
  useGenerateMatchReview,
  useMatchAnalysis,
  useMatchAnnotations,
  useUpdateMatchAnnotation,
} from '../../../data/match';
import { DEFAULT_HEAT_GRID_SIZE, binWorldSamples, resolveMapCalibration } from '../../../domain/map';
import {
  HEAT_SAMPLE_COUNT,
  HIGHLIGHTS_PER_MATCH,
  makeHeatSamples,
} from '../../../domain/densityFixtures';
import type { AnalysisWorkspace, Highlight, ReplayFrameRecord } from '../../../shared/desktop/dto';
import { HighlightsView } from './HighlightsView';
import { ReplayCanvas } from './ReplayCanvas';
import { ReviewView } from './ReviewView';
import { PATH_SAMPLE_LIMIT, buildPlayerTracks, playerMarkers } from './replayModel';
import { ANALYSIS, ANALYSIS_WITHOUT_INSIGHTS, ANNOTATIONS, HIGHLIGHTS } from './test/fixtures';
import { markupView, mutationResult, queryResult, viewProps } from './test/renderView';

vi.mock('../../../data/match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../data/match')>();
  return {
    ...actual,
    useMatchAnalysis: vi.fn(),
    useMatchAnnotations: vi.fn(),
    useGenerateMatchReview: vi.fn(),
    useCreateMatchAnnotation: vi.fn(),
    useUpdateMatchAnnotation: vi.fn(),
    useDeleteMatchAnnotation: vi.fn(),
  };
});

/* ── 回放: a whole match of frames ───────────────────────────────────────── */

/** Five minutes of a 64-tick stream at one frame per tick, ten players. */
const MATCH_FRAME_COUNT = 5_000;
const ROSTER = 10;

function matchFrames(): readonly ReplayFrameRecord[] {
  return Array.from({ length: MATCH_FRAME_COUNT }, (_, index) => ({
    tick: 100_000 + index,
    players: Array.from({ length: ROSTER }, (_, slot) => ({
      id: `p${String(slot)}`,
      name: `Player-${String(slot)}`,
      team: slot % 2 === 0 ? 'CT' : 'T',
      position: [((index * 7 + slot * 61) % 4_000) - 3_000, ((index * 11 + slot * 37) % 4_000) - 3_000, 64] as [
        number,
        number,
        number,
      ],
      yaw: 0,
      health: 100,
      armor: 100,
      alive: true,
      weapon: 'ak47',
      input: null,
    })),
    projectiles: [],
    bomb: null,
  }));
}

describe('density · 回放 with a whole match in the stream', () => {
  const frames = matchFrames();
  const tracks = buildPlayerTracks(frames, frames.length - 1);

  it('thins every track to the sample budget and reports the stride', () => {
    expect(tracks.paths).toHaveLength(ROSTER);
    for (const path of tracks.paths) {
      expect(path.samples.length).toBeLessThanOrEqual(PATH_SAMPLE_LIMIT + 1);
    }
    // Reported, not hidden: the view prints 「移动路线每 N 帧取一个采样点」.
    expect(tracks.stride).toBe(Math.ceil(MATCH_FRAME_COUNT / PATH_SAMPLE_LIMIT));
  });

  it('keeps the canvas markup well inside the layer group’s own budget', () => {
    /* The checked-in Mirage calibration, so the fixture's unit-square samples
       are projected back into the exact world box the canvas will draw. */
    const calibration = resolveMapCalibration('de_mirage', null);
    if (calibration === null) throw new Error('de_mirage calibration is missing');
    const span = calibration.unitsPerPixel * calibration.overviewSize;
    const distribution = binWorldSamples(
      makeHeatSamples(HEAT_SAMPLE_COUNT, 1_024).map((sample) => ({
        x: calibration.originX + (sample.x / 1_024) * span,
        y: calibration.originY - (sample.y / 1_024) * span,
        weight: 1,
      })),
      calibration,
    );

    const html = markupView(
      <ReplayCanvas
        mapName="de_mirage"
        label="density"
        layers={{ players: true, paths: true, kills: true, heat: true }}
        markers={playerMarkers(frames[frames.length - 1] ?? null)}
        paths={tracks.paths}
        engagements={[]}
        distribution={distribution}
        selectedPlayerId={null}
        onSelectPlayer={() => undefined}
        selectedEngagementId={null}
        onSelectEngagement={() => undefined}
      />,
    );

    // §10.3 gap 1 put an unthinned 240 × 600 track set at 2.65 MB; ten thinned
    // tracks plus a binned cloud is an order of magnitude under it.
    expect(html.length).toBeLessThan(1_000_000);
    // The heat cloud is bounded by the grid, not by the sample count.
    const bins = Number(/data-bins="(\d+)"/u.exec(html)?.[1] ?? '0');
    expect(bins).toBeGreaterThan(0);
    expect(bins).toBeLessThanOrEqual(DEFAULT_HEAT_GRID_SIZE * DEFAULT_HEAT_GRID_SIZE);
    // Ten markers, not ten thousand: only the frame at the playhead is drawn.
    expect(html.split('data-player-marker=').length - 1).toBe(ROSTER);
  });
});

/* ── 高光: a full match of candidates ────────────────────────────────────── */

function manyHighlights(): AnalysisWorkspace {
  const base = HIGHLIGHTS[0] as Highlight;
  return {
    ...ANALYSIS,
    highlights: Array.from({ length: HIGHLIGHTS_PER_MATCH }, (_, index) => ({
      ...base,
      id: `h-${String(index)}`,
      round: 24 - index,
      start_tick: 100_000 + index * 1_000,
      end_tick: 100_900 + index * 1_000,
    })),
  };
}

describe('density · 高光 with a full match of candidates', () => {
  it('scrolls inside its own box and prints the total', () => {
    vi.mocked(useMatchAnalysis).mockReturnValue(queryResult(manyHighlights()) as never);
    const html = markupView(<HighlightsView.Body {...viewProps()} />);

    expect(html.split('data-highlight-row=').length - 1).toBe(HIGHLIGHTS_PER_MATCH);
    // The scroll is the list's, not the document's: `base.css` sets
    // `overflow: hidden` on body, so a list that grew the page would clip.
    expect(html).toContain('data-highlights="list"');
    expect(html).toMatch(/data-highlights="list"[^>]*min-h-0 flex-1 list-none overflow-y-auto/u);
    expect(html).toContain(`共 ${String(HIGHLIGHTS_PER_MATCH)} 条高光`);
  });
});

/* ── Review: every capability unavailable ────────────────────────────────── */

describe('density · Review with every capability refused', () => {
  it('gives each column its own scroll so the header cannot be pushed off', () => {
    vi.mocked(useMatchAnalysis).mockReturnValue(queryResult(ANALYSIS_WITHOUT_INSIGHTS) as never);
    vi.mocked(useMatchAnnotations).mockReturnValue(queryResult(ANNOTATIONS) as never);
    vi.mocked(useGenerateMatchReview).mockReturnValue(mutationResult() as never);
    vi.mocked(useCreateMatchAnnotation).mockReturnValue(mutationResult() as never);
    vi.mocked(useUpdateMatchAnnotation).mockReturnValue(mutationResult() as never);
    vi.mocked(useDeleteMatchAnnotation).mockReturnValue(mutationResult() as never);

    const html = markupView(<ReviewView.Body {...viewProps()} />);
    expect(html.split('data-insight-gap=').length - 1).toBe(6);
    expect(html).toMatch(/data-review-insights=""[^>]*overflow-y-auto/u);
    expect(html).toMatch(/data-review-commentary=""[^>]*overflow-y-auto/u);
  });
});
