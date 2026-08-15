/*
 * 1100 × 700 density review — the half of `domain/match/` that needs a DOM.
 *
 * Two things the markup project cannot decide: whether what the bar folded away
 * is actually reachable (it takes a click), and whether a 58-cell round strip is
 * still one tab stop rather than fifty-eight.
 *
 * **What jsdom does not do is lay anything out.** `getBoundingClientRect` is all
 * zeroes here, so nothing below claims a cell wrapped, a chip overflowed or a
 * bar is 56px tall — the arithmetic for that lives in `roundTimelineLayout.ts`
 * and is asserted in the node project. These are reachability and focus
 * assertions, and they are strong for exactly that.
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderInteractive } from '../../test/render';
import {
  LONG_OVERTIME_ROUNDS,
  MATCH_ROSTER_SIZE,
  PERIODS_WITH_OVERTIME,
  makeFocusedPlayers,
  makePeriods,
  makeRounds,
} from '../densityFixtures';
import { MatchContextBar } from './MatchContextBar';
import { MATCH, TEAM_A, TEAM_B } from './matchFixtures.testing';
import { RoundTimeline } from './RoundTimeline';

describe('density · what the context bar folds is still reachable', () => {
  it('opens the whole roster and the overtime breakdown from the disclosure', () => {
    renderInteractive(
      <MatchContextBar
        match={MATCH}
        teamA={TEAM_A}
        teamB={TEAM_B}
        focusedPlayers={makeFocusedPlayers(MATCH_ROSTER_SIZE)}
        periods={makePeriods(PERIODS_WITH_OVERTIME)}
        sidesSwapped
        actions={<button type="button">用 Agent 制作视频</button>}
        collapsed
      />,
    );

    const toggle = screen.getByRole('button', { name: /比赛信息/u });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const panel = document.querySelector('[data-match-details=""]');
    expect(panel).not.toBeNull();
    if (panel === null) return;

    // Every one of the ten focus players, not the four the expanded bar keeps.
    const focus = panel.querySelector('[data-match-focus=""]');
    expect(focus?.getAttribute('data-focus-shown')).toBe(String(MATCH_ROSTER_SIZE));
    // The metadata line the 56px bar could not hold …
    expect(panel.querySelector('[data-match-metadata=""]')).not.toBeNull();
    // … and the period breakdown the bar never shows at any width.
    expect(panel.querySelectorAll('[data-scoreboard-period]')).toHaveLength(PERIODS_WITH_OVERTIME);

    // The main action stayed on the bar the whole time (§8).
    expect(screen.getByRole('button', { name: '用 Agent 制作视频' })).not.toBeNull();
  });
});

describe('density · a 58-cell round strip is one tab stop', () => {
  it('gives exactly one cell a tabindex of 0 and walks the rest with arrows', () => {
    const { container } = renderInteractive(
      <RoundTimeline
        rounds={makeRounds(LONG_OVERTIME_ROUNDS)}
        teamAName="Aurora"
        teamBName="Meridian"
        selectedRound={21}
      />,
    );

    const cells = [...container.querySelectorAll<HTMLButtonElement>('[data-round-cell]')];
    expect(cells).toHaveLength(LONG_OVERTIME_ROUNDS);

    const stops = cells.filter((cell) => cell.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.dataset['roundCell']).toBe('21');

    // Roving: the arrow moves focus without adding a second tab stop.
    stops[0]?.focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect((document.activeElement as HTMLElement).dataset['roundCell']).toBe('22');
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);

    // End reaches the last round of the longest overtime in one key press.
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect((document.activeElement as HTMLElement).dataset['roundCell']).toBe(String(LONG_OVERTIME_ROUNDS));
  });

  it('keeps every round in the accessible name even when the number is dropped', () => {
    const { container } = renderInteractive(
      <RoundTimeline
        rounds={makeRounds(LONG_OVERTIME_ROUNDS)}
        teamAName="Aurora"
        teamBName="Meridian"
        // 240px: cells fall under the 20px at which the printed number goes.
        availableWidthPx={240}
      />,
    );

    const group = within(container).getByRole('group', { name: '回合时间线' });
    const cells = [...group.querySelectorAll('[data-round-cell]')];
    expect(cells).toHaveLength(LONG_OVERTIME_ROUNDS);
    // The digits are gone from the face of the cell but not from the record.
    for (const cell of cells) expect(cell.textContent).toMatch(/第 \d+ 回合/u);
  });
});
