import { act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubMatchMedia, type MatchMediaStub } from '../../design/layout/collapse.testing';
import { renderInteractive } from '../../test/render';
import { MatchContextBar } from './MatchContextBar';
import { MATCH, TEAM_A, TEAM_B } from './matchFixtures.testing';

const BASE = { match: MATCH, teamA: TEAM_A, teamB: TEAM_B } as const;

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

describe('MatchContextBar across its own breakpoint', () => {
  it('folds the metadata into a disclosure when the window crosses the breakpoint', () => {
    media = stubMatchMedia(false);
    const stub = media;
    const { container } = renderInteractive(<MatchContextBar {...BASE} />);

    expect(container.querySelector('[data-match-context-bar]')?.getAttribute('data-match-context-bar')).toBe(
      'expanded',
    );
    expect(container.querySelector('[data-match-metadata]')).not.toBeNull();
    expect(container.querySelector('[data-match-details-toggle]')).toBeNull();

    act(() => {
      stub.setMatches(true);
    });

    expect(container.querySelector('[data-match-context-bar]')?.getAttribute('data-match-context-bar')).toBe(
      'collapsed',
    );
    expect(container.querySelector('[data-match-metadata]')).toBeNull();
    expect(container.querySelector('[data-match-details-toggle]')).not.toBeNull();
  });

  it('folds at 1600, not at 1100 — crossing §8 upward makes the column narrower', () => {
    // 1101px window: nav 216 + rail 46 + page padding 48 leaves ~791px, less
    // than the ~996px the same page had at 1100 folded. Unfolded this bar needs
    // ~1300px, so the band above §8's breakpoint is exactly where it must stay
    // folded — the bug the §9 risk-6 density review found.
    media = stubMatchMedia(1101);
    const stub = media;
    const { container } = renderInteractive(<MatchContextBar {...BASE} />);

    const state = () =>
      container.querySelector('[data-match-context-bar]')?.getAttribute('data-match-context-bar');

    expect(state()).toBe('collapsed');

    act(() => {
      stub.setWidth(1599);
    });
    expect(state()).toBe('collapsed');

    act(() => {
      stub.setWidth(1601);
    });
    expect(state()).toBe('expanded');
  });

  it('keeps the primary action out of the fold at every width (§8, non-negotiable)', () => {
    media = stubMatchMedia(false);
    const stub = media;
    const { getByRole } = renderInteractive(
      <MatchContextBar {...BASE} actions={<button type="button">用 Agent 制作视频</button>} />,
    );

    expect(getByRole('button', { name: '用 Agent 制作视频' })).toBeTruthy();

    act(() => {
      stub.setMatches(true);
    });

    expect(getByRole('button', { name: '用 Agent 制作视频' })).toBeTruthy();
  });

  it('gives everything the fold took a way back, wired to aria-expanded', () => {
    media = stubMatchMedia(true);
    const { container, getByRole } = renderInteractive(
      <MatchContextBar {...BASE} focusedPlayers={[{ id: 'kael', name: 'Kael' }]} />,
    );

    const toggle = getByRole('button', { name: /比赛信息/u });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-match-details]')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const details = container.querySelector('[data-match-details]');
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain('Mirage');
    expect(details?.textContent).toContain('64 tick');
    expect(details?.textContent).toContain('Kael');

    // The disclosure names the panel it controls, so the two are tied for
    // assistive technology rather than only visually adjacent.
    expect(toggle.getAttribute('aria-controls')).toBe(details?.id);

    fireEvent.click(toggle);
    expect(container.querySelector('[data-match-details]')).toBeNull();
  });

  it('does not open the disclosure over a skeleton', () => {
    media = stubMatchMedia(true);
    const { container } = renderInteractive(<MatchContextBar {...BASE} loading />);

    expect(container.querySelector('[data-match-context-state="loading"]')).not.toBeNull();
    expect(container.querySelector('[data-match-details-toggle]')).toBeNull();
  });
});

describe('MatchContextBar actions', () => {
  it('reports a removed focus player by id', () => {
    media = stubMatchMedia(false);
    const onRemove = vi.fn();
    const { getByRole } = renderInteractive(
      <MatchContextBar {...BASE} focusedPlayers={[{ id: 'kael', name: 'Kael', onRemove }]} />,
    );

    fireEvent.click(getByRole('button', { name: 'Kael' }));
    expect(onRemove).toHaveBeenCalledWith('kael');
  });

  it('opens the focus picker', () => {
    media = stubMatchMedia(false);
    const onAdd = vi.fn();
    const { getByRole } = renderInteractive(
      <MatchContextBar {...BASE} onAddFocusedPlayer={onAdd} />,
    );

    fireEvent.click(getByRole('button', { name: '＋ 添加选手' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('runs the failure recovery without losing the bar', () => {
    media = stubMatchMedia(false);
    const onRetry = vi.fn();
    const { container, getByRole } = renderInteractive(
      <MatchContextBar {...BASE} failure={{ message: '读不出这场比赛', onRetry }} />,
    );

    fireEvent.click(getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-match-context-bar]')).not.toBeNull();
  });
});
