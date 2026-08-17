/*
 * Design system, layer 1 of 3 — layout / SplitPane.
 *
 * A content column beside a companion column, with a drag handle between them.
 *
 * Reference: 11 输出与任务记录 — the output grid takes the remaining width and
 * 「任务记录」 sits in a 520px column (`--w-split`, the widest §3.5 step, drawn
 * exactly once and only here). The same shape with a narrower companion is how
 * 09 快速合辑 and 10 多轨编辑器 place their 340px clip / property panels
 * (`--w-panel`), and how the workspace places its 190px view rail
 * (`--w-subnav`, `side="start"`).
 *
 * ── The resizer, and why the token survives it ────────────────────────────
 *
 * This used to say: "there is no free-form pixel prop and no drag handle. The
 * reference draws no resizer anywhere, and the six merged steps exist precisely
 * so panel widths stay comparable across pages."
 *
 * The second half of that is still true and is why the §3.5 token is still the
 * only thing a caller may name. What the first half missed is that a *default*
 * and a *ceiling* are different things: the artboard fixes where a panel starts,
 * not that the user may never widen the task record to read a long path. Every
 * pane in this product is a work surface someone sits in front of for an hour.
 *
 * So: `asideWidth` still takes a §3.5 token and nothing else, and that token is
 * the width the pane opens at, every time, on every page. Dragging moves it
 * from there, and the move is the user's, not the page's.
 *
 * shadcn's Resizable is `react-resizable-panels`, whose v4 accepts real pixels
 * (`defaultSize={520}`), which is what makes this possible at all — a
 * percentage model would have made 「520px」 mean something different in every
 * window size and quietly retired the table.
 *
 * Bounds:
 *   min  `--w-subnav` (190), the narrowest panel §3.5 recognises. Below it a
 *        panel is not a panel, and a companion dragged to 40px is a bug the
 *        user has to undo rather than a layout they chose.
 *   max  60% of the group. Past that the companion is the content and the
 *        content is the companion, which is a different screen.
 *
 * `storageId` opts a pane into remembering its width. Without one the pane
 * opens at its token every time — which is the right default for a pane whose
 * identity is not stable, and the only honest one for a key that would
 * otherwise be a translated label.
 *
 * `min-w-0` on the content column is not decoration: without it a wide table
 * or a long monospace path pushes the flex item past its basis and the
 * companion column gets squeezed off-screen.
 */

import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import type { ReactNode } from 'react';

import { PANEL_WIDTH_PX, type PanelWidthToken } from '../tokens.data';
import { cn } from '../cn';

export type SplitPaneWidth = 'split' | 'panel' | 'inspector' | 'inspector-wide' | 'subnav';

export interface SplitPaneProps {
  /** The content column. */
  children: ReactNode;
  /** The companion column. */
  aside: ReactNode;
  /** Accessible name of the companion column, and of the handle beside it. */
  asideLabel: string;
  /** The §3.5 step the companion opens at. */
  asideWidth?: SplitPaneWidth | undefined;
  /** Which side the companion sits on. Default `end`. */
  asideSide?: 'start' | 'end' | undefined;
  /**
   * Remember the width the user dragged to, under this key. A stable id, not a
   * label: a translated one would forget the layout on a language switch.
   */
  storageId?: string | undefined;
  /** Pin the companion at its token width. */
  fixed?: boolean | undefined;
  className?: string | undefined;
}

const WIDTH_TOKEN: Record<SplitPaneWidth, PanelWidthToken> = {
  split: '--w-split',
  panel: '--w-panel',
  inspector: '--w-inspector',
  'inspector-wide': '--w-inspector-wide',
  subnav: '--w-subnav',
};

/** The narrowest panel §3.5 recognises — see the header. */
const MIN_ASIDE_PX = PANEL_WIDTH_PX['--w-subnav'];
const MAX_ASIDE = '60';

const STORAGE_PREFIX = 'vibe-cs.split.';

function readLayout(storageId: string | undefined): Layout | undefined {
  if (storageId === undefined) return undefined;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + storageId);
    if (raw === null || raw === undefined) return undefined;
    const parsed: unknown = JSON.parse(raw);
    /* A `Layout` is `{ [panelId]: px }`. Anything else was written by an older
       build or by something that is not us. */
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    if (!entries.every(([, size]) => typeof size === 'number' && Number.isFinite(size))) return undefined;
    return Object.fromEntries(entries) as Layout;
  } catch {
    /* A private-mode window, a quota, or a value someone else wrote. The pane
       opens at its token, which is the same thing that happens with no key. */
    return undefined;
  }
}

function writeLayout(storageId: string | undefined, layout: Layout): void {
  if (storageId === undefined) return;
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + storageId, JSON.stringify(layout));
  } catch {
    // Not being able to remember a width is not worth an error path.
  }
}

/**
 * Industry's hairline, widened to a grabbable target. The border stays exactly
 * where the fixed version drew it; the extra width is transparent, so the seam
 * looks the same and the pointer has somewhere to land.
 *
 * `withHandle` draws the reference's grip — two hairlines — only on hover and
 * focus, because a permanent grip on every split would be four new marks on a
 * screen that the artboard draws with none.
 */
const HANDLE_CLASS =
  'group relative flex w-px flex-none cursor-col-resize items-center justify-center bg-divider ' +
  'after:absolute after:inset-y-0 after:-inset-x-1 after:content-[""] ' +
  'hover:bg-accent data-[dragging]:bg-accent ' +
  'focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-0';

const GRIP_CLASS =
  'pointer-events-none absolute h-6 w-px bg-neutral-500 opacity-0 transition-opacity ' +
  'group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[dragging]:opacity-0';

export function SplitPane({
  children,
  aside,
  asideLabel,
  asideWidth = 'split',
  asideSide = 'end',
  storageId,
  fixed = false,
  className,
}: SplitPaneProps) {
  const defaultPx = PANEL_WIDTH_PX[WIDTH_TOKEN[asideWidth]];
  /* Panels are keyed by id, so the stored layout survives a side flip and a
     token change — and a `--w-split` pane the user narrowed stays narrowed. */
  const stored = readLayout(storageId);

  const companion = (
    <Panel
      key="aside"
      id="aside"
      defaultSize={defaultPx}
      minSize={fixed ? defaultPx : MIN_ASIDE_PX}
      maxSize={fixed ? defaultPx : MAX_ASIDE}
      className="flex min-h-0 flex-col"
    >
      <aside
        aria-label={asideLabel}
        data-split-aside={asideSide}
        className={cn(
          'flex min-h-0 flex-1 flex-col',
          asideSide === 'end' ? 'border-l border-divider' : 'border-r border-divider',
        )}
      >
        {aside}
      </aside>
    </Panel>
  );

  const content = (
    <Panel key="content" id="content" className="flex min-h-0 min-w-0 flex-col">
      <div data-split-content className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
      </div>
    </Panel>
  );

  const handle = fixed ? null : (
    <Separator aria-label={asideLabel} data-split-handle="" className={HANDLE_CLASS}>
      <span aria-hidden="true" className={GRIP_CLASS} />
    </Separator>
  );

  return (
    <Group
      orientation="horizontal"
      data-split-pane=""
      {...(stored === undefined ? {} : { defaultLayout: stored })}
      onLayoutChanged={(layout) => writeLayout(storageId, layout)}
      className={cn('flex min-h-0 min-w-0 flex-1', className)}
    >
      {asideSide === 'start' ? companion : content}
      {handle}
      {asideSide === 'start' ? content : companion}
    </Group>
  );
}
