/*
 * Design system, layer 1 of 3 — Drawer.
 *
 * 「浮层与状态规范」artboard: "Drawer 承载详情与非阻断编辑（比较、注释、属性）",
 * and on the 玩家比较 card: "Esc 关闭，焦点回到触发行；不阻断表格浏览".
 * 「Agent 会话历史」artboard draws the session drawer: a right-hand panel with a
 * 48px header, its own actions, and an ESC hint in the header.
 *
 * Radix's Dialog with `modal={false}` — the same primitive as `Dialog`, with
 * the modality turned off, which is exactly what 不阻断 means:
 *
 *   · no scrim, so the page behind stays visible and clickable;
 *   · no `aria-modal`, because claiming modality would tell assistive
 *     technology the rest of the page is inert — the opposite of the promise;
 *   · no scroll lock and no outside-pointer blocking, so the table the drawer
 *     is describing can still be scrolled and read.
 *
 * Outside presses are swallowed rather than dismissing: a drawer that closed
 * when the user clicked the row behind it would make 「不阻断表格浏览」 unusable
 * in one gesture. Esc and the close button are the two ways out, as the
 * artboard draws them.
 *
 * ── The one place this now differs from the artboard ──────────────────────
 *
 * 「两者都有焦点陷阱」 asks for a focus trap on the Drawer as well as on the
 * Dialog, and this no longer has one. The previous hand-rolled version did,
 * and its own comment called it "a deliberate compromise with 不阻断" — which
 * is the tell: an overlay cannot both promise that the page behind stays
 * usable and refuse to let the keyboard reach it. Radix's non-modal scope
 * keeps the three halves that are not in tension — focus enters the panel on
 * open, Esc closes it, focus returns to the trigger — and lets Tab leave, the
 * way every non-blocking side panel behaves.
 *
 * Width: the artboard labels its drawers 「抽屉 · 430px」 and draws the session
 * drawer at 470px. Both land on §3.5's `--w-inspector-wide` (440); the
 * narrower `standard` step (380) is offered for drawers docked beside an
 * Inspector that is already open.
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { t } from '@lingui/core/macro';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { OVERLAY_ACTIONS_CLASS } from './actionButton';
import { useOverlayReturnFocus } from './overlayFocus';
import { cn } from '../cn';

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

const PANEL_CLASS =
  'fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l border-neutral-500 bg-bg ' +
  'shadow-[var(--shadow-lg)]';

export function Drawer({
  open,
  title,
  children,
  onClose,
  description,
  footer,
  width = 'wide',
  className,
}: DrawerProps) {
  const returnFocus = useOverlayReturnFocus(open);

  return (
    <DialogPrimitive.Root
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          asChild
          data-overlay="drawer"
          data-width={width}
          onCloseAutoFocus={returnFocus}
          /* 不阻断: a press on the page behind belongs to the page. */
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          className={cn(PANEL_CLASS, WIDTH_CLASS[width], className)}
        >
          <aside>
            {/* 48px on the artboard → `--h-bar` (46), the nearest §3.4 step. */}
            <header className="flex h-[var(--h-bar)] flex-none items-center gap-2.5 border-b border-divider px-3.5">
              <DialogPrimitive.Title className="truncate font-heading text-lg text-text">
                {title}
              </DialogPrimitive.Title>
              {description === undefined ? null : (
                <DialogPrimitive.Description className="truncate text-xs text-neutral-600">
                  {description}
                </DialogPrimitive.Description>
              )}
              <span className="flex-1" />
              {/* The artboard prints the key next to the close affordance. It is
                  a key name, not copy, and it duplicates the button's own label. */}
              <span aria-hidden="true" className="font-mono text-xs text-neutral-600">
                ESC
              </span>
              <DialogPrimitive.Close
                aria-label={t`关闭抽屉`}
                data-drawer-action="close"
                className="flex size-[var(--h-ctl-sm)] flex-none items-center justify-center text-neutral-700 hover:text-text"
              >
                <X size={16} strokeWidth={1.5} aria-hidden />
              </DialogPrimitive.Close>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-3.5">{children}</div>

            {footer === undefined ? null : (
              <footer className={cn('border-t border-divider px-3.5 py-2.5', OVERLAY_ACTIONS_CLASS)}>
                {footer}
              </footer>
            )}
          </aside>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
