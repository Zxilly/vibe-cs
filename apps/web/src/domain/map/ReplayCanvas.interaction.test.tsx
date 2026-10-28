import { act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { MapCanvas, MAP_CANVAS_EXTENT } from './MapCanvas';
import { PlayerLayer } from './ReplayCanvas';
import type { PlayerMarker } from './replayModel';

const MARKER: PlayerMarker = {
  playerId: 's1mple',
  playerName: 's1mple',
  initial: 'S',
  x: 0,
  y: 0,
  side: 'CT',
  team: 'A',
  health: 100,
  weapon: 'awp',
  yaw: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ReplayCanvas screen annotations', () => {
  it('keeps marker size and identity readable across canvas resizes without moving its world anchor', () => {
    let width = 240;
    const updates: (() => void)[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(update: () => void) { updates.push(update); }
      observe() {}
      disconnect = disconnect;
    });
    vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, width, width),
    );
    const onSelect = vi.fn();
    const view = renderInteractive(
      <MapCanvas mapName="de_mirage" label="Mirage">
        {(projection) => (
          <PlayerLayer projection={projection} markers={[MARKER]} onSelectPlayer={onSelect} />
        )}
      </MapCanvas>,
    );
    const marker = () => view.container.querySelector('[data-player-marker="s1mple"]')!;
    const label = () => marker().querySelector('text')!;
    const rect = () => marker().querySelector('rect')!;
    const anchor = () => [label().getAttribute('x'), label().getAttribute('y')];
    const initialAnchor = anchor();
    const physicalLabelSize = () => Number(label().getAttribute('font-size')) * width / MAP_CANVAS_EXTENT;
    const physicalMarkerSize = () => Number(rect().getAttribute('width')) * width / MAP_CANVAS_EXTENT;

    expect(physicalLabelSize()).toBeCloseTo(13);
    expect(physicalMarkerSize()).toBeCloseTo(24);
    expect(rect().getAttribute('class')).toContain('fill-bg');
    expect(updates).toHaveLength(1);

    for (const nextWidth of [720, 300]) {
      act(() => { width = nextWidth; updates[0]!(); });
      expect(physicalLabelSize()).toBeCloseTo(13);
      expect(physicalMarkerSize()).toBeCloseTo(24);
      expect(anchor()).toEqual(initialAnchor);
    }
    fireEvent.click(marker());
    expect(onSelect).toHaveBeenCalledWith('s1mple');
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
