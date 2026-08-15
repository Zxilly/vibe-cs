import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { ROUNDS } from './matchFixtures.testing';
import { RoundTimeline } from './RoundTimeline';

const NAMES = { teamAName: 'Aurora', teamBName: 'Meridian' } as const;

function cells(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[data-round-cell]')];
}

describe('RoundTimeline selection', () => {
  it('reports the round that was clicked and keeps no copy of it', () => {
    const onSelectRound = vi.fn();
    const { container, rerender } = renderInteractive(
      <RoundTimeline rounds={ROUNDS} selectedRound={null} onSelectRound={onSelectRound} {...NAMES} />,
    );

    fireEvent.click(cells(container)[20]!);
    expect(onSelectRound).toHaveBeenCalledWith(21);

    // Uncontrolled it would have moved on its own; the URL is the truth (§4.4).
    expect(container.querySelector('[aria-current="true"]')).toBeNull();

    rerender(
      <RoundTimeline rounds={ROUNDS} selectedRound={21} onSelectRound={onSelectRound} {...NAMES} />,
    );
    expect(container.querySelector('[aria-current="true"]')?.getAttribute('data-round-cell')).toBe('21');
  });

  it('is inert without a handler rather than throwing', () => {
    const { container } = renderInteractive(<RoundTimeline rounds={ROUNDS} {...NAMES} />);

    expect(() => fireEvent.click(cells(container)[0]!)).not.toThrow();
  });
});

describe('RoundTimeline keyboard', () => {
  it('is one tab stop for the whole strip, not one per round', () => {
    const { container } = renderInteractive(
      <RoundTimeline rounds={ROUNDS} selectedRound={21} {...NAMES} />,
    );

    const reachable = cells(container).filter((cell) => cell.tabIndex === 0);
    expect(reachable).toHaveLength(1);
    expect(reachable[0]?.dataset['roundCell']).toBe('21');
  });

  it('walks the strip with the arrow keys', () => {
    const { container } = renderInteractive(
      <RoundTimeline rounds={ROUNDS} selectedRound={5} {...NAMES} />,
    );
    const all = cells(container);
    all[4]!.focus();

    fireEvent.keyDown(all[4]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(all[5]);

    fireEvent.keyDown(all[5]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(all[4]);

    // A wrapped strip is two-dimensional, so up and down move as well.
    fireEvent.keyDown(all[4]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(all[5]);
  });

  it('stops at the ends instead of wrapping past the first or last round', () => {
    const { container } = renderInteractive(<RoundTimeline rounds={ROUNDS} {...NAMES} />);
    const all = cells(container);

    all[0]!.focus();
    fireEvent.keyDown(all[0]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(all[0]);

    all.at(-1)!.focus();
    fireEvent.keyDown(all.at(-1)!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(all.at(-1));
  });

  it('jumps to the first and last round with Home and End', () => {
    const { container } = renderInteractive(
      <RoundTimeline rounds={ROUNDS} selectedRound={12} {...NAMES} />,
    );
    const all = cells(container);
    all[11]!.focus();

    fireEvent.keyDown(all[11]!, { key: 'Home' });
    expect(document.activeElement).toBe(all[0]);

    fireEvent.keyDown(all[0]!, { key: 'End' });
    expect(document.activeElement).toBe(all.at(-1));
  });

  it('selects the focused round with the space bar the browser gives a button', () => {
    const onSelectRound = vi.fn();
    const { container } = renderInteractive(
      <RoundTimeline rounds={ROUNDS} onSelectRound={onSelectRound} {...NAMES} />,
    );
    const all = cells(container);

    all[2]!.focus();
    fireEvent.keyDown(all[2]!, { key: ' ' });
    fireEvent.click(all[2]!);
    expect(onSelectRound).toHaveBeenCalledWith(3);
  });

  it('leaves keys it does not own to the page', () => {
    const { container } = renderInteractive(<RoundTimeline rounds={ROUNDS} {...NAMES} />);
    const all = cells(container);
    all[0]!.focus();

    fireEvent.keyDown(all[0]!, { key: 'Tab' });
    expect(document.activeElement).toBe(all[0]);
  });
});

describe('RoundTimeline states', () => {
  it('runs the failure recovery action', () => {
    const onRetry = vi.fn();
    const { getByRole } = renderInteractive(
      <RoundTimeline rounds={ROUNDS} {...NAMES} failure={{ message: '读不出回合', onRetry }} />,
    );

    fireEvent.click(getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers the empty state its own recovery action', () => {
    const onAnalyse = vi.fn();
    const { getByRole } = renderInteractive(
      <RoundTimeline
        rounds={[]}
        {...NAMES}
        emptyActions={
          <button type="button" onClick={onAnalyse}>
            开始分析
          </button>
        }
      />,
    );

    fireEvent.click(getByRole('button', { name: '开始分析' }));
    expect(onAnalyse).toHaveBeenCalledTimes(1);
  });
});
