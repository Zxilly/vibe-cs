/*
 * `interaction` project — the type filter and the batch action of 高光.
 *
 * Three behaviours the artboard is explicit about and a static render cannot
 * show: the chip row narrows the list, the checkbox column feeds a 「已选 N 条」
 * strip, and 「定位」 changes the *address* rather than some state private to
 * this view.
 */

import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMatchAnalysis } from '../../../data/match';
import type { MatchContextPatch } from '../workspaceContext';
import { HighlightsView } from './HighlightsView';
import { ANALYSIS } from './test/fixtures';
import { queryResult, renderView, viewProps } from './test/renderView';

vi.mock('../../../data/match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../data/match')>();
  return { ...actual, useMatchAnalysis: vi.fn() };
});

beforeEach(() => {
  vi.mocked(useMatchAnalysis).mockReturnValue(queryResult(ANALYSIS) as never);
});

function rows(): readonly string[] {
  return [...document.querySelectorAll('[data-highlight-row]')].map(
    (node) => node.getAttribute('data-highlight-row') ?? '',
  );
}

describe('the type filter', () => {
  it('narrows the list and keeps the total visible', () => {
    renderView(<HighlightsView.Body {...viewProps()} />);
    expect(rows()).toHaveLength(4);

    fireEvent.click(screen.getByRole('radio', { name: /残局/u }));

    expect(rows()).toEqual(['h-21-clutch']);
    // The denominator stays on screen: a filtered list must not read as the
    // whole set.
    expect(screen.getByText(/共 4 条高光，当前筛出 1 条/u)).toBeTruthy();
  });

  it('offers a way back when a filter empties the list', () => {
    renderView(<HighlightsView.Body {...viewProps()} />);
    fireEvent.click(screen.getByRole('radio', { name: /盲狙/u }));
    expect(rows()).toEqual(['h-7-noscope']);

    fireEvent.click(screen.getByRole('radio', { name: /全部/u }));
    expect(rows()).toHaveLength(4);
  });
});

describe('the batch selection', () => {
  it('counts the checked rows on the strip', () => {
    renderView(<HighlightsView.Body {...viewProps()} />);
    expect(document.querySelector('[data-selection-bar]')).toBeNull();

    const boxes = screen.getAllByRole('checkbox', { name: '选择这条高光' });
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);

    expect(screen.getByText('已选 2 条')).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建作品' })).toBeTruthy();
  });

  it('counts only what the current filter is showing', () => {
    renderView(<HighlightsView.Body {...viewProps()} />);
    const boxes = screen.getAllByRole('checkbox', { name: '选择这条高光' });
    // Rows 0 and 2 are 残局 and 多杀.
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[2] as HTMLElement);
    expect(screen.getByText('已选 2 条')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /残局/u }));
    // 「已选 2 条」 over a one-row list would be a claim about something invisible.
    expect(screen.getByText('已选 1 条')).toBeTruthy();
  });

  it('keeps 加入录制队列 visible and disabled with its reason', () => {
    renderView(<HighlightsView.Body {...viewProps()} />);
    fireEvent.click(screen.getAllByRole('checkbox', { name: '选择这条高光' })[0] as HTMLElement);

    const queue = screen.getByRole('button', { name: '加入录制队列' });
    expect(queue).toHaveProperty('disabled', true);
    expect(document.body.textContent).toContain('录制队列尚未接通');
  });

  it('clears the selection and takes the strip away with it', () => {
    renderView(<HighlightsView.Body {...viewProps()} />);
    fireEvent.click(screen.getAllByRole('checkbox', { name: '选择这条高光' })[0] as HTMLElement);
    expect(document.querySelector('[data-selection-bar]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清空选择' }));
    expect(document.querySelector('[data-selection-bar]')).toBeNull();
  });
});

describe('定位', () => {
  it('writes the round and the tick into the address', () => {
    const updateContext = vi.fn<(patch: MatchContextPatch) => void>();
    renderView(<HighlightsView.Body {...viewProps({ updateContext })} />);

    fireEvent.click(screen.getAllByRole('button', { name: '定位' })[0] as HTMLElement);

    // §4.4: 「URL 是唯一真值」 — the selection is the address, not local state.
    expect(updateContext).toHaveBeenCalledWith({ round: 21, tick: 148_920 });
  });
});
