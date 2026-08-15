/*
 * Design system, layer 1 of 3 — layout.
 *
 * Test support for `./collapse.ts`. Not imported by any component.
 *
 * jsdom ships a `window.matchMedia` that always reports `matches: false` and
 * never fires a change event, so a test cannot cross the §8 breakpoint by
 * resizing anything. This installs a stub that does both: it answers the
 * current state and notifies the `useSyncExternalStore` subscription when the
 * state is moved, which is the only way to prove that a component folds *in
 * response to* the viewport rather than only when a prop pins it.
 */

type ChangeListener = (event: MediaQueryListEvent) => void;

export interface MatchMediaStub {
  /** Moves the viewport across the breakpoint and notifies subscribers. */
  setMatches(next: boolean): void;
  /** Puts the original `window.matchMedia` back. */
  restore(): void;
}

export function stubMatchMedia(initialMatches: boolean): MatchMediaStub {
  const listeners = new Set<ChangeListener>();
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  let matches = initialMatches;

  const matchMedia = (query: string): MediaQueryList =>
    ({
      media: query,
      matches,
      onchange: null,
      addEventListener: (_type: string, listener: ChangeListener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: ChangeListener) => {
        listeners.delete(listener);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });

  return {
    setMatches(next: boolean) {
      matches = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
    restore() {
      if (original === undefined) {
        Reflect.deleteProperty(window, 'matchMedia');
        return;
      }
      Object.defineProperty(window, 'matchMedia', original);
    },
  };
}
