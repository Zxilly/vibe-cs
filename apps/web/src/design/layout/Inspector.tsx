/*
 * Design system, layer 1 of 3 — layout.
 *
 * The right-hand detail panel, in both of the states spec §8 requires.
 *
 *   docked   (02, 03, at 1920)  `--w-inspector` (380px, absorbing the
 *            reference's 400) with a 40px head (`--h-panel-head`), a scrolling
 *            body and a footer that carries the panel's main action at
 *            `--h-ctl-lg` over a row of `--h-ctl-sm` seconds.
 *
 *   folded   (補齊 · 壳层规格, 1100 × 700)  collapse rule 2: 「右侧 Inspector
 *            不再常驻，收成底部 44px 选中摘要 + 可召出的右侧抽屉」. The strip
 *            reads 「选中 R21 · 1v3 残局」 and keeps two controls: 「证据详情 ›」
 *            which pulls the drawer out, and 「加入视频」 — a main action, so by
 *            the same §8 rule that governs `Toolbar` it stays on the strip
 *            (`summaryActions`) and is never folded away.
 *
 * The strip is `--h-bar` (46px) rather than the 44px the prose names:
 * `tokens.data.ts` BAR_HEIGHT_MERGE, raw 50 — 「底部选择条 … §8 的折叠规则把它
 * 写成 44，§3.4 没有对应 token；按次级栏归到 46」. `--h-titlebar` is the other
 * 44 and belongs to the window chrome.
 *
 * The drawer follows the reference's overlay contract (補齊 · 规范与状态):
 * 「两者都有焦点陷阱、Esc 关闭和关闭后焦点归位」.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { useCollapsed } from './collapse';
import { cn } from '../cn';

export type InspectorWidth = 'standard' | 'wide';

export interface InspectorProps {
  /** The head — 「选中：第 21 回合」. */
  title: ReactNode;
  /** Plain-text name for the `<aside>` and for the drawer's dialog. */
  label: string;
  /** The one-line form shown on the folded strip. Falls back to `title`. */
  summary?: ReactNode;
  children: ReactNode;
  /** The action block at the bottom of the panel. */
  footer?: ReactNode;
  /** Main actions that stay on the folded strip, beside the drawer trigger. */
  summaryActions?: ReactNode;
  width?: InspectorWidth | undefined;
  /** Overrides the observed §8 breakpoint. */
  collapsed?: boolean | undefined;
  /** Controlled drawer state. */
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Trigger copy on the folded strip. Defaults to 「详情」. */
  openLabel?: ReactNode;
  className?: string | undefined;
}

const WIDTH_CLASS: Record<InspectorWidth, string> = {
  standard: 'w-[var(--w-inspector)]',
  wide: 'w-[var(--w-inspector-wide)]',
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

function InspectorHead({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-[var(--h-panel-head)] flex-none items-center gap-3 border-b border-divider px-5">
      {/* `base.css` is unlayered, so its h2 size wins over any utility; the
          panel head's 14px is therefore declared inline — still a token. */}
      <h2
        data-inspector-title
        className="min-w-0 flex-1 truncate font-heading tracking-wide"
        style={{ fontSize: 'var(--text-base)' }}
      >
        {title}
      </h2>
      {action}
    </div>
  );
}

export function Inspector({
  title,
  label,
  summary,
  children,
  footer,
  summaryActions,
  width = 'standard',
  collapsed,
  open,
  defaultOpen = false,
  onOpenChange,
  openLabel,
  className,
}: InspectorProps) {
  const isCollapsed = useCollapsed(collapsed);
  const panelId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );

  // Focus enters the drawer when it opens and returns to whatever opened it
  // when it closes — 「关闭后焦点归位」. The node is re-checked before the
  // restore because the strip may have unmounted in the meantime.
  useEffect(() => {
    if (!isCollapsed || !isOpen) return undefined;
    const panel = panelRef.current;
    if (panel === null) return undefined;
    const active = document.activeElement;
    const opener = triggerRef.current ?? (active instanceof HTMLElement ? active : null);
    const first = focusableWithin(panel)[0];
    (first ?? panel).focus();
    return () => {
      if (opener !== null && opener.isConnected) opener.focus();
    };
  }, [isCollapsed, isOpen]);

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;

    // Focus trap. The panel itself is the fallback stop, so an empty drawer
    // still cannot leak focus back to the page behind it.
    const panel = panelRef.current;
    if (panel === null) return;
    const stops = focusableWithin(panel);
    if (stops.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const body = (
    <div
      data-inspector-body
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-5"
    >
      {children}
    </div>
  );

  const footerBlock =
    footer !== undefined && footer !== null ? (
      <div
        data-inspector-footer
        className="flex min-w-0 flex-none flex-col gap-2.5 border-t border-divider p-5"
      >
        {footer}
      </div>
    ) : null;

  if (!isCollapsed) {
    return (
      <aside
        aria-label={label}
        data-inspector="docked"
        className={cn(
          'flex min-h-0 min-w-0 flex-none flex-col border-l border-divider',
          WIDTH_CLASS[width],
          className,
        )}
      >
        <InspectorHead title={title} />
        {body}
        {footerBlock}
      </aside>
    );
  }

  return (
    <>
      <div
        data-inspector="summary"
        className={cn(
          'flex h-[var(--h-bar)] flex-none items-center gap-3 border-t border-divider bg-surface-chrome px-7',
          className,
        )}
      >
        <span data-inspector-summary className="min-w-0 truncate text-xs text-neutral-700">
          {summary ?? title}
        </span>
        <div className="flex-1" aria-hidden="true" />
        <button
          ref={triggerRef}
          type="button"
          data-inspector-trigger
          aria-expanded={isOpen}
          aria-controls={isOpen ? panelId : undefined}
          className="flex h-[var(--h-ctl-sm)] flex-none items-center gap-2 border border-divider px-3 text-sm"
          onClick={() => setOpen(!isOpen)}
        >
          {openLabel ?? <Trans>详情</Trans>}
        </button>
        {/* Main actions stay on the strip — §8: 主动作不进溢出菜单. */}
        {summaryActions !== undefined && summaryActions !== null ? (
          <div data-inspector-summary-actions className="flex flex-none items-center gap-2.5">
            {summaryActions}
          </div>
        ) : null}
      </div>

      {isOpen ? (
        <div data-inspector="drawer" className="fixed inset-0 z-40 flex justify-end">
          <div
            data-inspector-scrim
            aria-hidden="true"
            className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-neutral-900)_50%,transparent)]"
            onClick={() => setOpen(false)}
          />
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            className={cn(
              'relative flex h-full flex-col border-l border-divider bg-bg shadow-[var(--shadow-lg)]',
              WIDTH_CLASS[width],
            )}
          >
            <InspectorHead
              title={title}
              action={
                <button
                  type="button"
                  data-inspector-close
                  aria-label={t`关闭`}
                  className="flex h-[var(--h-ctl-sm)] w-[var(--h-ctl-sm)] flex-none items-center justify-center text-neutral-700"
                  onClick={() => setOpen(false)}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              }
            />
            {body}
            {footerBlock}
          </div>
        </div>
      ) : null}
    </>
  );
}
