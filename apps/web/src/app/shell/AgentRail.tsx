/*
 * App shell — the Agent rail, in its two states (spec §3.5).
 *
 * ── The shell contract this component fixes ──────────────────────────────
 *
 * How does the Agent intervene on a page that is not the Agent page: as a
 * floating overlay, or by squeezing the main area?
 *
 * **It squeezes.** The evidence is structural, in two places:
 *
 *   1. `Frame.dc.html` puts the collapsed rail in the flex row itself —
 *      `<main style="flex:1">` followed by `<aside style="width:46px;flex:none;
 *      border-left:…">`. An in-flow sibling, not a positioned layer.
 *   2. The 「Agent 竖条 · 展开态」 artboard draws the *expanded* form the same
 *      way: `<div style="flex:1;padding:14px">` (the library table) beside
 *      `<div style="width:380px;flex:none;border-left:1px solid …">`. The table
 *      to its left is narrower than on the same board's collapsed drawing. No
 *      scrim, no `position:absolute`, no `box-shadow` — every overlay in this
 *      design system (Dialog, Drawer, the command palette) has at least one of
 *      those, and this has none.
 *
 * Three consequences, all deliberate:
 *   · **no focus trap.** Dialog and Drawer trap focus because they are
 *     overlays; this is a column of the page, so Tab walks out of it into the
 *     page below, exactly as it walks out of the SideNav.
 *   · **no `aria-modal`, no scrim.** The page behind stays live, which is the
 *     point — the rail 「跟随你在页面里的选择自动更新」.
 *   · **Esc still collapses it.** It is a disclosure the user opened, and Esc
 *     is how every collapsible thing in this shell closes. Focus returns to
 *     the collapsed rail's button, so the keyboard never lands nowhere.
 *
 * Scope, from the same artboard's own caption: 「在非 Agent 页面上介入：只做上
 * 下文收集与跳转，不在这里做方案编辑」. The expanded body is therefore a slot,
 * filled in phase 3e with the context chips / suggestions / composer the board
 * draws; this round it is the header, the close action, the container and the
 * board's own footnote, which states that boundary in the product's words.
 *
 * Widths are §3.5 verbatim: `--w-agent-rail` (46) collapsed, `--w-inspector`
 * (380) expanded — the spec says the expanded form reuses the Inspector width,
 * and the artboard draws exactly 380.
 *
 * Not drawn anywhere: the rail at ≤1100px. The 1100×700 artboard has no right
 * rail at all; its Agent entry is the sparkle icon in the 56px left rail. The
 * fold decision belongs to `AppShell`, which owns the row this sits in.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { cn } from '../../design/layout';
import { useShellStore } from './shellStore';
import { Badge } from '../../design/primitives';

export interface AgentRailProps {
  /** Pins the state. Omitted, it follows the persisted preference. */
  expanded?: boolean | undefined;
  /** Replaces the store's toggle. Receives the state being moved to. */
  onExpandedChange?: ((expanded: boolean) => void) | undefined;
  /** 「N 待确认」 — plans waiting on the user. 0 hides the badge. */
  pendingCount?: number | undefined;
  /** The expanded body. Phase 3e fills it; empty is a valid state. */
  children?: ReactNode;
  className?: string | undefined;
}

export function AgentRail({
  expanded,
  onExpandedChange,
  pendingCount = 0,
  children,
  className,
}: AgentRailProps) {
  const storedExpanded = useShellStore((state) => state.agentRailExpanded);
  const setAgentRailExpanded = useShellStore((state) => state.setAgentRailExpanded);
  const isExpanded = expanded ?? storedExpanded;

  const panelId = useId();
  const titleId = useId();
  const expandRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const previousExpanded = useRef(isExpanded);

  const setExpanded = (next: boolean) => {
    if (onExpandedChange) onExpandedChange(next);
    else setAgentRailExpanded(next);
  };
  // Read by the Escape listener, which is registered once per open.
  const setExpandedRef = useRef(setExpanded);
  setExpandedRef.current = setExpanded;

  /* Focus follows the state change, but only a change: on first mount the two
     agree and focus stays wherever the page put it. */
  useEffect(() => {
    if (previousExpanded.current === isExpanded) return;
    previousExpanded.current = isExpanded;
    if (isExpanded) collapseRef.current?.focus();
    else expandRef.current?.focus();
  }, [isExpanded]);

  /* Esc collapses. Document-level so it works from anywhere in the panel —
     and only while open, so it never steals Esc from a dialog above it. */
  useEffect(() => {
    if (!isExpanded) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setExpandedRef.current(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isExpanded]);

  if (!isExpanded) {
    return (
      <aside
        data-agent-rail="collapsed"
        className={cn(
          'flex w-[var(--w-agent-rail)] flex-none flex-col border-l border-divider bg-surface-chrome',
          className,
        )}
      >
        <button
          ref={expandRef}
          type="button"
          data-agent-rail-toggle="expand"
          aria-expanded={false}
          aria-controls={panelId}
          onClick={() => setExpanded(true)}
          className="flex flex-1 flex-col items-center gap-3.5 py-3.5 hover:bg-neutral-200"
        >
          <Sparkles size={16} strokeWidth={1.5} aria-hidden="true" className="flex-none text-accent" />
          {/* Frame draws the label rotated at .2em; `--tracking-caps` (.16em)
              is the nearest §3 step. */}
          <span className="[writing-mode:vertical-rl] font-heading text-sm tracking-caps text-accent-800">
            <Trans>AI 工作台</Trans>
          </span>
          {pendingCount > 0 ? (
            <span
              data-agent-rail-pending={pendingCount}
              className="[writing-mode:vertical-rl] border border-accent-300 px-0.5 py-1.5 text-2xs text-accent-700"
            >
              <Plural value={pendingCount} other="# 待确认" />
            </span>
          ) : null}
          <span className="flex-1" />
          <ChevronLeft size={14} strokeWidth={1.5} aria-hidden="true" className="flex-none text-neutral-600" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      id={panelId}
      data-agent-rail="expanded"
      aria-labelledby={titleId}
      className={cn(
        'flex w-[var(--w-inspector)] flex-none flex-col border-l border-divider bg-surface-chrome',
        className,
      )}
    >
      <header className="flex h-[var(--h-panel-head)] flex-none items-center gap-2 border-b border-divider px-3">
        <Sparkles size={15} strokeWidth={1.5} aria-hidden="true" className="flex-none text-accent" />
        <h2 id={titleId} className="min-w-0 truncate font-heading text-base tracking-wide">
          <Trans>AI 工作台</Trans>
        </h2>
        {pendingCount > 0 ? (
          <Badge variant="count" size="sm" data-agent-rail-pending={pendingCount}>
            <Plural value={pendingCount} other="# 待确认" />
          </Badge>
        ) : null}
        <span className="flex-1" />
        <button
          ref={collapseRef}
          type="button"
          data-agent-rail-toggle="collapse"
          aria-expanded={true}
          aria-controls={panelId}
          aria-label={t`收起 AI 工作台`}
          onClick={() => setExpanded(false)}
          className="flex h-[var(--h-ctl-sm)] flex-none items-center gap-1 px-1 text-xs text-neutral-600 hover:text-text"
        >
          <Trans>收起</Trans>
          <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div data-agent-rail-body className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>

      {/* The artboard's own footnote. It states the boundary between this rail
          and the Agent page, so it is product copy, not a placeholder. */}
      <p className="flex-none border-t border-divider px-3 py-2.5 text-2xs leading-normal text-neutral-600">
        <Trans>编辑镜头、接受变更和确认录制都在 Agent 创作页完成，这条竖栏不承载方案编辑。</Trans>
      </p>
    </aside>
  );
}
