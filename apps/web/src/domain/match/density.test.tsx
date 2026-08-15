/*
 * 1100 × 700 density review — `domain/match/` (spec §9 risk 6).
 *
 * These are not more component tests. Every case here renders a **full** data
 * volume from `domain/densityFixtures.ts` — a match that went to overtime, a
 * round's worth of evidence, a whole roster in the focus set — and asserts the
 * things a static render can actually decide:
 *
 *   · nothing is dropped silently (a count in, the same count out);
 *   · what has to truncate carries `truncate`;
 *   · what has to fold is folded, and the folded thing still has a way back;
 *   · a fixed-height box never contains something that can wrap inside it.
 *
 * `renderToStaticMarkup` has no layout, so nothing here measures a pixel. Where
 * the answer depends on arithmetic — how many round cells fit — the arithmetic
 * is a pure function (`planRoundStrip`) and it is asserted directly, at the
 * widths `densityFixtures` derives from §8.
 */

import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import {
  EVIDENCE_PER_MATCH_MAX,
  EVIDENCE_PER_MATCH_MIN,
  FOLD_CONTENT_WIDTH_PX,
  HIGHLIGHTS_PER_MATCH,
  LONG_OVERTIME_ROUNDS,
  MATCH_ROSTER_SIZE,
  OVERTIME_ROUNDS,
  PERIODS_WITH_OVERTIME,
  REGULATION_ROUNDS,
  makeEvidence,
  makeFocusedPlayers,
  makeHighlights,
  makePeriods,
  makeRounds,
} from '../densityFixtures';
import { EvidenceRow } from './EvidenceRow';
import { HighlightRow } from './HighlightRow';
import { FOCUS_INLINE_MAX, MatchContextBar } from './MatchContextBar';
import { MATCH, TEAM_A, TEAM_B } from './matchFixtures.testing';
import { RoundTimeline } from './RoundTimeline';
import { ROUND_CELL_LABEL_MIN_PX, ROUND_CELL_MIN_PX, planRoundStrip } from './roundTimelineLayout';

/** `--w-inspector`. The narrowest column the strip is ever asked to live in. */
const INSPECTOR_WIDTH_PX = 380;

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** One `<article>` per row, so a per-row assertion can be made per row. */
function rowsOf(html: string): string[] {
  return html.split('<article').slice(1);
}

describe('density · RoundTimeline at the §8 fold', () => {
  it('packs a 30-round overtime into one row of labelled cells at 996px', () => {
    const plan = planRoundStrip({ roundCount: OVERTIME_ROUNDS, availableWidthPx: FOLD_CONTENT_WIDTH_PX });

    expect(plan.rows).toBe(1);
    expect(plan.perRow).toBe(OVERTIME_ROUNDS);
    // 29.3px a cell — above the 20px at which the round number is dropped.
    expect(plan.cellWidthPx).toBeGreaterThanOrEqual(ROUND_CELL_LABEL_MIN_PX);
    expect(plan.showLabels).toBe(true);

    const html = renderMarkup(
      <RoundTimeline
        rounds={makeRounds(OVERTIME_ROUNDS)}
        teamAName="Aurora"
        teamBName="Meridian"
        selectedRound={21}
        availableWidthPx={FOLD_CONTENT_WIDTH_PX}
      />,
    );

    expect(occurrences(html, 'data-round-cell=')).toBe(OVERTIME_ROUNDS);
    expect(html).toContain('data-round-strip-rows="1"');
    expect(html).toContain(`repeat(${String(OVERTIME_ROUNDS)}, minmax(0, 1fr))`);
  });

  it('wraps a 58-round match onto balanced rows and still draws every round', () => {
    const plan = planRoundStrip({ roundCount: LONG_OVERTIME_ROUNDS, availableWidthPx: FOLD_CONTENT_WIDTH_PX });

    expect(plan.rows).toBe(2);
    expect(plan.perRow).toBe(29);
    // Balanced, not filled: no short trailing row that reads as missing data.
    expect(plan.perRow * plan.rows - LONG_OVERTIME_ROUNDS).toBeLessThanOrEqual(1);
    expect(plan.cellWidthPx).toBeGreaterThanOrEqual(ROUND_CELL_MIN_PX);

    const html = renderMarkup(
      <RoundTimeline
        rounds={makeRounds(LONG_OVERTIME_ROUNDS)}
        teamAName="Aurora"
        teamBName="Meridian"
        availableWidthPx={FOLD_CONTENT_WIDTH_PX}
      />,
    );

    // The whole match is on screen. Wrapping is the mitigation; hiding is not.
    expect(occurrences(html, 'data-round-cell=')).toBe(LONG_OVERTIME_ROUNDS);
    expect(html).toContain('data-round-strip-rows="2"');
    expect(html).toContain(`data-round-cell="${String(LONG_OVERTIME_ROUNDS)}"`);
  });

  it('keeps cells hittable inside a 380px Inspector by taking more rows', () => {
    const plan = planRoundStrip({ roundCount: OVERTIME_ROUNDS, availableWidthPx: INSPECTOR_WIDTH_PX });

    expect(plan.rows).toBe(2);
    expect(plan.cellWidthPx).toBeGreaterThanOrEqual(ROUND_CELL_MIN_PX);
    expect(plan.showLabels).toBe(true);
  });

  it('lets the panel header grow rather than spill out of --h-panel-head', () => {
    const html = renderMarkup(
      <RoundTimeline rounds={makeRounds(REGULATION_ROUNDS)} teamAName="Aurora" teamBName="Meridian" />,
    );

    // The header is `flex-wrap`; a wrapping row inside a fixed height leaves the
    // box. The artboard's 40px survives as the floor.
    expect(html).toContain('min-h-[var(--h-panel-head)]');
    expect(html).not.toMatch(/class="[^"]*\bflex h-\[var\(--h-panel-head\)\]/u);
  });
});

describe('density · EvidenceRow at 60–200 rows', () => {
  const evidence = makeEvidence(EVIDENCE_PER_MATCH_MAX);

  it('draws all 200 rows — a list that quietly stops at 50 is the bug', () => {
    const html = renderMarkup(
      <div>
        {evidence.map((item) => (
          <EvidenceRow key={item.id} evidence={item} onSelect={() => {}} onLocate={() => {}} />
        ))}
      </div>,
    );

    expect(occurrences(html, 'data-evidence-row=')).toBe(EVIDENCE_PER_MATCH_MAX);
    expect(html).toContain(`data-evidence-row="ev-${String(EVIDENCE_PER_MATCH_MAX - 1)}"`);
  });

  it('truncates the free text on every row, at every density', () => {
    for (const density of ['comfortable', 'default', 'inline'] as const) {
      const html = renderMarkup(
        <div>
          {evidence.slice(0, EVIDENCE_PER_MATCH_MIN).map((item) => (
            <EvidenceRow key={item.id} evidence={item} density={density} />
          ))}
        </div>,
      );
      const rows = rowsOf(html);
      expect(rows).toHaveLength(EVIDENCE_PER_MATCH_MIN);
      // Actor, target, match label and context are user text of unbounded
      // length; each row has to clip them rather than push the tick column and
      // the 定位 button off the panel.
      for (const row of rows) expect(row).toContain('truncate');
    }
  });

  it('keeps the tick column and the actions out of the shrinking half', () => {
    const first = evidence[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const html = renderMarkup(
      <EvidenceRow evidence={first} onLocate={() => {}} action={<button type="button">加入视频</button>} />,
    );

    // The tick, the annotation, 定位 and the page's action are all `flex-none`;
    // the sentence between them is the only thing that gives way. Two `flex-1`
    // is the row's own nesting (the select button, then the two-line column
    // inside it), not a second shrinking sibling.
    expect(html).toContain('<span data-evidence-annotation="" class="flex-none">');
    expect(html).toContain('<span data-evidence-locate="" class="flex-none">');
    expect(html).toContain('<span data-evidence-action="" class="flex-none">');
    expect(html).toContain('flex flex-none flex-col text-left font-mono text-xs');
  });
});

describe('density · HighlightRow at 18 candidates', () => {
  it('draws every candidate and truncates only the sentence', () => {
    const highlights = makeHighlights(HIGHLIGHTS_PER_MATCH);
    const html = renderMarkup(
      <div>
        {highlights.map((highlight) => (
          <HighlightRow
            key={highlight.id}
            highlight={highlight}
            selected={false}
            action={<button type="button">加入视频</button>}
          />
        ))}
      </div>,
    );

    const rows = rowsOf(html);
    expect(rows).toHaveLength(HIGHLIGHTS_PER_MATCH);
    for (const row of rows) {
      expect(row).toContain('truncate');
      // The tick range is what the recorder is handed; it may never be clipped.
      expect(row).toContain('data-highlight-range=""');
    }
  });
});

describe('density · MatchContextBar at 1100 × 700', () => {
  const roster = makeFocusedPlayers(MATCH_ROSTER_SIZE);
  const periods = makePeriods(PERIODS_WITH_OVERTIME);
  const actions = <button type="button">用 Agent 制作视频</button>;

  it('caps the inline focus chips and counts the rest on the disclosure', () => {
    const html = renderMarkup(
      <MatchContextBar
        match={MATCH}
        teamA={TEAM_A}
        teamB={TEAM_B}
        focusedPlayers={roster}
        onAddFocusedPlayer={() => {}}
        actions={actions}
        collapsed={false}
      />,
    );

    expect(html).toContain(`data-focus-shown="${String(FOCUS_INLINE_MAX)}"`);
    expect(html).toContain(`data-hidden-focus="${String(MATCH_ROSTER_SIZE - FOCUS_INLINE_MAX)}"`);
    // The count is stated in words too — the fold announces what it took.
    expect(html).toContain('聚焦 6');
  });

  it('draws no disclosure when the artboard would not: two chips, no overtime', () => {
    const html = renderMarkup(
      <MatchContextBar
        match={MATCH}
        teamA={TEAM_A}
        teamB={TEAM_B}
        focusedPlayers={makeFocusedPlayers(2)}
        actions={actions}
        collapsed={false}
      />,
    );

    expect(html).toContain('data-focus-shown="2"');
    expect(html).not.toContain('data-match-details-toggle');
  });

  it('folds the metadata line and the whole focus set once collapsed', () => {
    const html = renderMarkup(
      <MatchContextBar
        match={MATCH}
        teamA={TEAM_A}
        teamB={TEAM_B}
        focusedPlayers={roster}
        actions={actions}
        collapsed
      />,
    );

    expect(html).toContain('data-match-context-bar="collapsed"');
    expect(html).not.toContain('data-match-metadata');
    expect(html).not.toContain('data-match-focus');
    // Folded, not lost: the disclosure says how many are inside …
    expect(html).toContain(`data-hidden-focus="${String(MATCH_ROSTER_SIZE)}"`);
    // … and the §8 main action never moves.
    expect(html).toContain('用 Agent 制作视频');
    expect(html).toContain('data-match-actions=""');
  });

  it('never puts the overtime period breakdown in the 56px bar', () => {
    const html = renderMarkup(
      <MatchContextBar
        match={MATCH}
        teamA={TEAM_A}
        teamB={TEAM_B}
        periods={periods}
        sidesSwapped
        actions={actions}
        collapsed={false}
      />,
    );

    // Four periods print as a second, wrapping line inside a `flex-none` box:
    // it does not wrap, it widens the scoreboard past 450px. It belongs to the
    // disclosure, which is now drawn because of it.
    expect(html).not.toContain('data-scoreboard-periods');
    expect(html).toContain('data-match-details-toggle');
  });

  it('lets nothing inside the bar wrap, and lets everything inside the panel', () => {
    const bar = renderMarkup(
      <MatchContextBar
        match={MATCH}
        teamA={TEAM_A}
        teamB={TEAM_B}
        focusedPlayers={roster}
        roundRange="R1–R24"
        actions={actions}
        collapsed={false}
      />,
    );

    const metadata = bar.slice(bar.indexOf('data-match-metadata'));
    const metadataClass = /class="([^"]*)"/u.exec(metadata)?.[1] ?? '';
    expect(metadataClass).toContain('flex-nowrap');
    expect(metadataClass).toContain('min-w-0');
    expect(metadataClass).not.toContain('flex-wrap');
  });
});
