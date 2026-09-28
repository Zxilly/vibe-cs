/*
 * `interaction` project — the type filter and the batch action of 高光.
 *
 * Three behaviours the artboard is explicit about and a static render cannot
 * show: the chip row narrows the list, the checkbox column feeds a 「已选 N 条」
 * strip, and 「定位」 changes the *address* rather than some state private to
 * this view.
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMatchAnalysis } from '../../../../data/match';
import type { MatchContextPatch } from '../workspaceContext';
import type { MatchViewProps } from '../viewContract';
import { HighlightsView } from './HighlightsView';
import { ANALYSIS } from '../../../../test/fixtures/matchAnalysis';
import { queryResult, renderView, viewProps } from './test/renderView';

vi.mock('../../../../data/match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../data/match')>();
  return { ...actual, useMatchAnalysis: vi.fn() };
});

beforeEach(() => {
  vi.mocked(useMatchAnalysis).mockReturnValue(queryResult(ANALYSIS) as never);
});

/* Both halves under the module's own Provider, as the shell mounts them: the
   batch selection is scoped there, and a body rendered bare has none. */
function renderHighlights(props: MatchViewProps) {
  const Provider = HighlightsView.Provider!;
  return renderView(
    <Provider>
      <HighlightsView.Body {...props} />
    </Provider>,
  );
}

function rows(): readonly string[] {
  return [...document.querySelectorAll('[data-highlight-row]')].map(
    (node) => node.getAttribute('data-highlight-row') ?? '',
  );
}

describe('the type filter', () => {
  it('narrows the list and keeps the total visible', () => {
    renderHighlights(viewProps());
    expect(rows()).toHaveLength(4);

    fireEvent.click(screen.getByRole('radio', { name: /残局/u }));

    expect(rows()).toEqual(['h-21-clutch']);
    // The denominator stays on screen: a filtered list must not read as the
    // whole set.
    expect(screen.getByText(/共 4 条高光，当前筛出 1 条/u)).toBeTruthy();
  });

  it('offers a way back when a filter empties the list', () => {
    renderHighlights(viewProps());
    fireEvent.click(screen.getByRole('radio', { name: /盲狙/u }));
    expect(rows()).toEqual(['h-7-noscope']);

    fireEvent.click(screen.getByRole('radio', { name: /全部/u }));
    expect(rows()).toHaveLength(4);
  });
});

describe('the batch selection', () => {
  it('counts the checked rows on the strip', () => {
    renderHighlights(viewProps());
    expect(document.querySelector('[data-selection-bar]')).toBeNull();

    const boxes = screen.getAllByRole('checkbox', { name: '选择这条高光' });
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);

    expect(screen.getByText('已选 2 条')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '加入作品' }).length).toBeGreaterThan(0);
  });

  it('counts only what the current filter is showing', () => {
    renderHighlights(viewProps());
    const boxes = screen.getAllByRole('checkbox', { name: '选择这条高光' });
    // Rows 0 and 2 are 残局 and 多杀.
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[2] as HTMLElement);
    expect(screen.getByText('已选 2 条')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /残局/u }));
    // 「已选 2 条」 over a one-row list would be a claim about something invisible.
    expect(screen.getByText('已选 1 条')).toBeTruthy();
  });

  it('keeps 加入作品 visible and carries the supplied disabled reason', () => {
    renderHighlights(viewProps());
    fireEvent.click(screen.getAllByRole('checkbox', { name: '选择这条高光' })[0] as HTMLElement);

    const queue = within(document.querySelector('[data-selection-bar]') as HTMLElement)
      .getByRole('button', { name: '加入作品' });
    expect(queue).toHaveProperty('disabled', true);
    expect(document.body.textContent).toContain('录制队列尚未接通');
  });

  it('moves the primary action for a checked set into the Inspector, once', () => {
    const onAddMany = vi.fn();
    const props = { ...viewProps(), addToVideo: { disabled: false, onAddMany } };
    const Provider = HighlightsView.Provider!;
    const Inspector = HighlightsView.Inspector!;
    renderView(
      <Provider>
        <HighlightsView.Body {...props} />
        <Inspector {...props} />
      </Provider>,
    );
    expect(screen.getByRole('button', { name: '把这条高光加入作品' })).toBeTruthy();

    const boxes = screen.getAllByRole('checkbox', { name: '选择这条高光' });
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);

    // The Inspector now describes the set, and its main action is the set's.
    expect(screen.getByText('已选 2 条高光')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '把这条高光加入作品' })).toBeNull();
    const primary = screen.getByRole('button', { name: '把已选 2 条加入作品' });
    expect(primary.className).toContain('bg-accent');
    // The strip keeps an entry point, but not a second blue one.
    const strip = within(document.querySelector('[data-selection-bar]') as HTMLElement)
      .getByRole('button', { name: '加入作品' });
    expect(strip.className).not.toContain('bg-accent');

    fireEvent.click(primary);
    expect(onAddMany).toHaveBeenCalledTimes(1);
    expect(onAddMany.mock.calls[0]?.[0]).toHaveLength(2);

    // Clearing from the Inspector clears the list's boxes too — one set.
    fireEvent.click(within(document.querySelector('[data-inspector]') as HTMLElement).getByRole('button', { name: '清空选择' }));
    expect(document.querySelector('[data-selection-bar]')).toBeNull();
    expect(screen.getByRole('button', { name: '把这条高光加入作品' })).toBeTruthy();
  });

  it('clears the selection and takes the strip away with it', () => {
    renderHighlights(viewProps());
    fireEvent.click(screen.getAllByRole('checkbox', { name: '选择这条高光' })[0] as HTMLElement);
    expect(document.querySelector('[data-selection-bar]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清空选择' }));
    expect(document.querySelector('[data-selection-bar]')).toBeNull();
  });
});

describe('定位', () => {
  it('collects the same full recording source from the row and Inspector', () => {
    const onAdd = vi.fn();
    const props = { ...viewProps(), addToVideo: { disabled: false, onAdd } };
    const Inspector = HighlightsView.Inspector!;
    renderView(<><HighlightsView.Body {...props} /><Inspector {...props} /></>);
    fireEvent.click(screen.getAllByRole('button', { name: '加入作品' })[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: '把这条高光加入作品' }));
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdd.mock.calls[0]?.[0]).toEqual(onAdd.mock.calls[1]?.[0]);
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({ playerId: 'kael', tickRate: 64, highlightId: 'h-21-clutch' });
  });
  it('writes the round and the tick into the address', () => {
    const updateContext = vi.fn<(patch: MatchContextPatch) => void>();
    renderView(<HighlightsView.Body {...viewProps({ updateContext })} />);

    fireEvent.click(screen.getAllByRole('button', { name: '定位' })[0] as HTMLElement);

    // §4.4: 「URL 是唯一真值」 — the selection is the address, not local state.
    expect(updateContext).toHaveBeenCalledWith({ highlight: 'h-21-clutch', round: 21, tick: 148_920, player: 'kael' });
  });
});

describe('keyboard picking', () => {
  it('steps with the arrows, adds with A and ticks with X', () => {
    const updateContext = vi.fn<(patch: MatchContextPatch) => void>();
    const onAdd = vi.fn();
    renderHighlights({ ...viewProps({ updateContext }), addToVideo: { disabled: false, onAdd } });
    const [first, second] = rows();

    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(updateContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ highlight: second }),
      { replace: true },
    );

    fireEvent.keyDown(document.body, { key: 'a' });
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ highlightId: first }));

    fireEvent.keyDown(document.body, { key: 'x' });
    expect(screen.getByText('已选 1 条')).toBeTruthy();
  });

  it('leaves the keys to a focused control that owns them', () => {
    const updateContext = vi.fn<(patch: MatchContextPatch) => void>();
    const onAdd = vi.fn();
    renderHighlights({ ...viewProps({ updateContext }), addToVideo: { disabled: false, onAdd } });

    fireEvent.keyDown(screen.getByRole('radio', { name: /全部/u }), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getAllByRole('button', { name: '加入作品' })[0] as HTMLElement, { key: ' ' });
    fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true });

    expect(updateContext).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
