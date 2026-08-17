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
  /**
   * Moves the viewport to a width. Every `(max-width: Npx)` query answers
   * against it independently, which is what a test needs once more than one
   * breakpoint is in play — `setMatches` answers the same for all of them.
   */
  setWidth(px: number): void;
  /** Puts the original `window.matchMedia` back. */
  restore(): void;
}

const MAX_WIDTH = /\(\s*max-width:\s*(\d+(?:\.\d+)?)px\s*\)/u;

/**
 * Queries this stub answers without a viewport width.
 *
 * `(pointer:coarse)` is asked by `react-resizable-panels`, which widens a
 * separator's hit region for touch. This product is a desktop window with a
 * mouse, so the answer is `false` — and it is listed rather than defaulted,
 * because the throw below is what keeps a typo in a real media query from
 * quietly passing as 「wide enough」.
 */
const KNOWN_ANSWERS: Readonly<Record<string, boolean>> = {
  '(pointer:coarse)': false,
  '(pointer: coarse)': false,
};

/**
 * `initial` is either a flat answer for every query (the original behaviour) or
 * a viewport width, in which case each query is evaluated against it.
 */
export function stubMatchMedia(initial: boolean | number): MatchMediaStub {
  const listeners = new Set<ChangeListener>();
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  let matches = typeof initial === 'boolean' ? initial : null;
  let width = typeof initial === 'number' ? initial : null;

  const answers = (query: string): boolean => {
    const known = KNOWN_ANSWERS[query.trim()];
    if (known !== undefined) return known;
    if (width === null) return matches ?? false;
    const found = MAX_WIDTH.exec(query);
    // A query this stub cannot read must not silently report "wide enough" —
    // that would turn a typo in a media query into a passing test.
    if (found === null) throw new Error(`stubMatchMedia 无法解析这条查询：${query}`);
    return width <= Number(found[1]);
  };

  const matchMedia = (query: string): MediaQueryList =>
    ({
      media: query,
      get matches() {
        return answers(query);
      },
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

  const notify = () => {
    // The event body is unused: `useSyncExternalStore` re-reads the snapshot
    // rather than trusting what the event carries.
    const event = {} as MediaQueryListEvent;
    for (const listener of listeners) listener(event);
  };

  return {
    setMatches(next: boolean) {
      matches = next;
      width = null;
      notify();
    },
    setWidth(px: number) {
      width = px;
      matches = null;
      notify();
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
