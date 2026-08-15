/*
 * The second selectable layer, proving the shared behaviour is actually shared
 * rather than re-implemented: same single tab stop, same arrow movement, same
 * "focus does not commit" rule — on objects whose granularity is a whole track
 * rather than a single event.
 */

import { act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
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

function track(playerId: string, playerName: string): PlayerPath {
  return {
    playerId,
    playerName,
    samples: [
      { tick: 1, x: 100, y: 900 },
      { tick: 2, x: 500, y: 500 },
    ],
  };
}

const paths = [track('kael', 'Kael'), track('sable', 'Sable'), track('corvin', 'Corvin')];

function setup(options: { selectedPlayerId?: string } = {}) {
  const onSelectPlayer = vi.fn();
  const view = renderInteractive(
    <svg>
      <PathLayer projection={projection} paths={paths} onSelectPlayer={onSelectPlayer} {...options} />
    </svg>,
  );
  const tracks = () => Array.from(view.container.querySelectorAll<SVGGElement>('[data-path]'));
  return { ...view, onSelectPlayer, tracks };
}

describe('PathLayer selection', () => {
  it('is one tab stop whose arrows walk the roster', () => {
    const { tracks } = setup({ selectedPlayerId: 'sable' });
    expect(tracks().map((element) => element.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);

    const selected = tracks()[1] as SVGGElement;
    act(() => {
      selected.focus();
    });
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tracks()[2]);
  });

  it('commits on click and on Enter, never on focus alone', () => {
    const { tracks, onSelectPlayer } = setup();
    const first = tracks()[0] as SVGGElement;
    act(() => {
      first.focus();
    });
    expect(onSelectPlayer).not.toHaveBeenCalled();

    fireEvent.keyDown(first, { key: 'Enter' });
    expect(onSelectPlayer).toHaveBeenLastCalledWith('kael');

    fireEvent.click(tracks()[2] as SVGGElement);
    expect(onSelectPlayer).toHaveBeenLastCalledWith('corvin');
  });

  it('emphasises the hovered track and lets go again', () => {
    const { tracks, container } = setup();
    const target = tracks()[1] as SVGGElement;
    const stroke = () => container.querySelector('[data-path="sable"] [data-role="track"]')?.getAttribute('class');

    expect(stroke()).toContain('stroke-team-b');
    fireEvent.pointerEnter(target);
    expect(stroke()).toContain('stroke-accent-800');
    fireEvent.pointerLeave(target);
    expect(stroke()).toContain('stroke-team-b');
  });
});
