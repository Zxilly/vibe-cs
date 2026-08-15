/*
 * The group's keyboard contract, proven on the busiest layer.
 *
 * 简报 §15.3 requires the main selections to be completable from the keyboard,
 * and a map is where that is easiest to get wrong: the objects are scattered
 * pixels with no reading order. The behaviour proven here is the one
 * `useRovingSelection` gives all three selectable layers — one tab stop, arrows
 * inside it, Enter to commit — so a regression in any of them shows up here.
 */

import { act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { EngagementLayer, type Engagement } from './EngagementLayer';
import type { MapCalibration } from './mapCalibration';
import { createMapProjection } from './mapProjection';

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

function duel(id: string, tick: number, victim: string): Engagement {
  return {
    id,
    tick,
    attacker: { playerId: 'kael', playerName: 'Kael', x: 100, y: 900 },
    victim: { playerId: victim, playerName: victim, x: 600, y: 300 },
    weapon: 'ak47',
  };
}

const engagements = [duel('ev-1', 100, 'Sable'), duel('ev-2', 200, 'Corvin'), duel('ev-3', 300, 'Thorne')];

function setup(options: { selectedEngagementId?: string } = {}) {
  const onSelectEngagement = vi.fn();
  const view = renderInteractive(
    <svg>
      <EngagementLayer
        projection={projection}
        engagements={engagements}
        onSelectEngagement={onSelectEngagement}
        {...options}
      />
    </svg>,
  );
  const options_ = () => Array.from(view.container.querySelectorAll<SVGGElement>('[data-engagement]'));
  const focus = (index: number) => {
    const element = options_()[index];
    if (!element) throw new Error(`no engagement at ${index}`);
    act(() => {
      element.focus();
    });
    return element;
  };
  return { ...view, onSelectEngagement, options: options_, focus };
}

describe('EngagementLayer keyboard', () => {
  it('exposes the duels as one listbox of options', () => {
    const { getByRole, getAllByRole } = setup();
    expect(getByRole('listbox', { name: '交火' })).toBeDefined();
    expect(getAllByRole('option')).toHaveLength(3);
  });

  it('is a single tab stop: only the selected option is tabbable', () => {
    const { options } = setup({ selectedEngagementId: 'ev-2' });
    expect(options().map((element) => element.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('moves focus between duels with the arrow keys, in both axes', () => {
    const { focus, options } = setup();
    const first = focus(0);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options()[1]);

    fireEvent.keyDown(options()[1] as SVGGElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(options()[2]);

    fireEvent.keyDown(options()[2] as SVGGElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(options()[1]);
  });

  it('wraps at both ends, so every duel is reachable from any of them', () => {
    const { focus, options } = setup();
    fireEvent.keyDown(focus(2), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options()[0]);

    fireEvent.keyDown(options()[0] as SVGGElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(options()[2]);
  });

  it('jumps to the ends with Home and End', () => {
    const { focus, options } = setup();
    fireEvent.keyDown(focus(1), { key: 'End' });
    expect(document.activeElement).toBe(options()[2]);

    fireEvent.keyDown(options()[2] as SVGGElement, { key: 'Home' });
    expect(document.activeElement).toBe(options()[0]);
  });

  it('does not select while moving — the page is not dragged along by every keystroke', () => {
    const { focus, onSelectEngagement } = setup();
    fireEvent.keyDown(focus(0), { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as SVGGElement, { key: 'End' });
    expect(onSelectEngagement).not.toHaveBeenCalled();
  });

  it('commits on Enter and on Space', () => {
    const { focus, onSelectEngagement } = setup();
    fireEvent.keyDown(focus(1), { key: 'Enter' });
    expect(onSelectEngagement).toHaveBeenLastCalledWith('ev-2');

    fireEvent.keyDown(focus(2), { key: ' ' });
    expect(onSelectEngagement).toHaveBeenLastCalledWith('ev-3');
  });

  it('leaves keys it does not own to the page', () => {
    const { focus } = setup();
    const element = focus(0);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      element.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it('commits on a click too', () => {
    const { options, onSelectEngagement } = setup();
    fireEvent.click(options()[2] as SVGGElement);
    expect(onSelectEngagement).toHaveBeenCalledWith('ev-3');
  });

  it('says which duel is selected in words, not only in paint', () => {
    const { getAllByRole } = setup({ selectedEngagementId: 'ev-2' });
    const selected = getAllByRole('option').find((element) => element.getAttribute('aria-selected') === 'true');
    expect(selected?.getAttribute('aria-label')).toContain('Kael → Corvin · ak47');
  });

  it('emphasises the duel under the pointer without selecting it', () => {
    const { options, onSelectEngagement, container } = setup();
    const target = options()[0] as SVGGElement;
    fireEvent.pointerEnter(target);
    expect(container.querySelector('[data-engagement="ev-1"] [data-role="axis"]')?.getAttribute('stroke-width')).toBe(
      '2.5',
    );
    expect(onSelectEngagement).not.toHaveBeenCalled();

    fireEvent.pointerLeave(target);
    expect(container.querySelector('[data-engagement="ev-1"] [data-role="axis"]')?.getAttribute('stroke-width')).toBe(
      '1.5',
    );
  });
});
