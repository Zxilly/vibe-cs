/**
 * The browser APIs jsdom does not implement but Radix needs.
 *
 * Loaded by both jsdom projects (`markup` and `interaction`). None of these is
 * a behavioural stand-in — they exist so that a component which *calls* the API
 * during mount does not throw before the assertion it is under test for. Where
 * a real implementation would matter (a slider reading its own track width),
 * the test has to drive the geometry itself; a polyfill that invents numbers
 * would make such a test pass for the wrong reason.
 *
 * jsdom tracks these upstream, so each entry is installed only when missing.
 *
 * It also unmounts between tests. `globals` is off, so Testing Library's own
 * auto-cleanup hook never registers; without this, trees leak across tests and
 * an assertion starts reading the previous test's DOM — which for a portalled
 * overlay means reading a dialog the current test never opened.
 */

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

/* Radix's popper (DropdownMenu, Tooltip, Select) and its Slider observe their
   own box. jsdom has no layout engine, so an observer that never fires is the
   honest stub: nothing ever resizes. */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/* Used by Radix's scroll-locking and by `Presence` when a component animates
   out. Same reasoning as above. */
if (!('IntersectionObserver' in globalThis)) {
  globalThis.IntersectionObserver = class IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

/* Pointer capture. Radix's Slider and Select call these on every pointerdown;
   jsdom implements the events but not the capture APIs. */
for (const name of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const) {
  if (!(name in Element.prototype)) {
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      writable: true,
      value: name === 'hasPointerCapture' ? () => false : () => undefined,
    });
  }
}

/* Radix's roving focus scrolls the newly focused item into view. */
if (!('scrollIntoView' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
}

/* `Dialog` and `Drawer` ask whether the user has asked for reduced motion. */
if (!('matchMedia' in globalThis)) {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
