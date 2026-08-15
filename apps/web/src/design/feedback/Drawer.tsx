/*
 * Design system, layer 1 of 3 — Drawer.
 *
 * 「浮层与状态规范」artboard: "Drawer 承载详情与非阻断编辑（比较、注释、属性）",
 * and on the 玩家比较 card: "Esc 关闭，焦点回到触发行；不阻断表格浏览".
 * 「Agent 会话历史」artboard draws the session drawer: a right-hand panel with a
 * 48px header, its own actions, and an ESC hint in the header.
 *
 * 不阻断 is the difference from Dialog, and it is a real one:
 *
 *   · no scrim. The page behind stays visible and clickable, so the user can
 *     keep browsing the table the drawer is describing.
 *   · `aria-modal` is left off. Claiming modality would tell assistive
 *     technology the rest of the page is inert, which is the opposite of what
 *     this overlay promises.
 *
 * Everything else is shared with Dialog through `useOverlayFocus`: Esc closes,
 * Tab cycles inside the panel, and focus returns to the trigger on close. The
 * Tab cycle is a deliberate compromise with 不阻断 — the artboard asks for a
 * focus trap on both overlays by name, and pointer interaction with the page
 * behind is what carries the non-blocking promise.
 *
 * Width: the artboard labels its drawers 「抽屉 · 430px」 and draws the session
 * drawer at 470px. Both land on §3.5's `--w-inspector-wide` (440); the
 * narrower `standard` step (380) is offered for drawers docked beside an
 * Inspector that is already open.
 */

import { t } from '@lingui/core/macro';
import { X } from 'lucide-react';
import { useId, type ReactNode } from 'react';

import { OVERLAY_ACTIONS_CLASS } from './actionButton';
import { useOverlayFocus } from './overlayFocus';

export type DrawerWidth = 'standard' | 'wide';

export interface DrawerProps {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /** The header's secondary line: 「共 14 条」, 「Aurora vs Meridian · R21」. */
  description?: ReactNode;
  /**
   * Optional action row, pinned bottom-right like Dialog's. Style its buttons
   * with `overlayActionClass` so the two overlays share one steel blue.
   */
  footer?: ReactNode;
  width?: DrawerWidth;
  className?: string;
}

const WIDTH_CLASS: Record<DrawerWidth, string> = {
  standard: 'w-[var(--w-inspector)]',
  wide: 'w-[var(--w-inspector-wide)]',
};

export function Drawer({
  open,
  title,
  children,
  onClose,
  description,
  footer,
  width = 'wide',
  className = '',
}: DrawerProps) {
  const titleId = useId();
  const panelRef = useOverlayFocus<HTMLElement>(open, onClose);

  if (!open) return null;

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-overlay="drawer"
      data-width={width}
      className={
        'fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l border-neutral-500 bg-bg ' +
        'shadow-[var(--shadow-lg)] ' +
        `${WIDTH_CLASS[width]} ` +
        className
      }
    >
      {/* 48px on the artboard → `--h-bar` (46), the nearest §3.4 step. */}
      <header className="flex h-[var(--h-bar)] flex-none items-center gap-2.5 border-b border-divider px-3.5">
        <h2 id={titleId} className="truncate font-heading text-lg text-text">
          {title}
        </h2>
        {description === undefined ? null : (
          <p className="truncate text-xs text-neutral-600">{description}</p>
        )}
        <span className="flex-1" />
        {/* The artboard prints the key next to the close affordance. It is a
            key name, not copy, and it duplicates the button's own label. */}
        <span aria-hidden="true" className="font-mono text-xs text-neutral-600">
          ESC
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t`关闭抽屉`}
          data-drawer-action="close"
          className="flex size-[var(--h-ctl-sm)] flex-none items-center justify-center text-neutral-700 hover:text-text"
        >
          <X size={16} strokeWidth={1.5} aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">{children}</div>

      {footer === undefined ? null : (
        <footer className={`border-t border-divider px-3.5 py-2.5 ${OVERLAY_ACTIONS_CLASS}`}>{footer}</footer>
      )}
    </aside>
  );
}
