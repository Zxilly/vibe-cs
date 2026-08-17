/*
 * Design system, layer 1 of 3 — Dialog.
 *
 * 「浮层与状态规范」artboard, the note under 「对话框与抽屉 · 十一个」, verbatim:
 *   "分工：Dialog 只承载不可逆动作与正式确认（删除、停止、覆盖）；
 *     Drawer 承载详情与非阻断编辑（比较、注释、属性）；
 *     两者都有焦点陷阱、Esc 关闭和关闭后焦点归位。
 *     破坏性动作的主按钮用砖红，其余一律用钢蓝主按钮，位置固定在右下。"
 *
 * The division of labour is in the shape of the API, not only in the docs: a
 * Dialog *is* a confirmation. `onConfirm` and `confirmLabel` are required and
 * there is no way to render one without an action row, so a panel that only
 * shows detail cannot be built out of this component — that is Drawer.
 *
 * All nine dialogs the artboard draws share one skeleton: title, a body of one
 * or two lines, and a right-aligned 取消 / 主动作 pair. The two destructive ones
 * (「删除 3 条记录？」and its sibling) differ only in the fail-coloured border,
 * title and primary button.
 *
 * ── shadcn's Dialog, and what it replaced ─────────────────────────────────
 *
 * This was a `position: fixed` div with a hand-written focus trap, and it said
 * so: "No portal: `createPortal` throws under `renderToStaticMarkup`, which is
 * the whole of the spec §6.2 `markup` project." That constraint is gone — the
 * `markup` project runs in jsdom now — and with it the four things the
 * hand-rolled version could not do:
 *
 *   · **Portal.** `position: fixed` escapes layout but not a `transform`,
 *     `filter` or `contain` ancestor, any of which would silently re-parent
 *     the dialog into a corner of the page. Radix renders it at the body.
 *   · **One Escape per overlay.** The old key handler was on `document`, so a
 *     drawer with a confirmation open over it closed both on one press. Radix
 *     stacks dismissable layers and only the top one answers.
 *   · **Outside-press, not click.** Dismissal is decided on the `pointerdown`
 *     rather than on the click, so a drag that starts inside and ends outside —
 *     a text selection running past the panel edge — no longer dismisses the
 *     dialog. The old backdrop had a plain `onClick`, which did.
 *   · **Scroll lock**, which a modal needs and no amount of `z-index` provides.
 *
 * What is unchanged: focus moves to 取消 on open, Tab cycles inside, focus
 * returns to the trigger on close, and the markup keeps its `data-overlay`,
 * `data-tone` and `data-dialog-action` hooks.
 */

import { Dialog as DialogPrimitive } from 'radix-ui';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { OVERLAY_ACTIONS_CLASS, overlayActionClass } from './actionButton';
import { useOverlayReturnFocus } from './overlayFocus';
import { cn } from '../cn';

export type DialogTone = 'default' | 'destructive';

export interface DialogProps {
  open: boolean;
  /** 「删除 3 条记录？」「停止这次录制？」 — a question, per the artboard. */
  title: ReactNode;
  /** What the action will actually do. Both destructive dialogs spell out the blast radius. */
  children?: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  /** Esc, the backdrop and the 取消 button all route here. */
  onClose: () => void;
  cancelLabel?: ReactNode;
  tone?: DialogTone;
  confirmDisabled?: boolean;
  className?: string;
}

/* Industry `.dialog-backdrop`: a 50% neutral-900 scrim. */
const BACKDROP_CLASS = 'fixed inset-0 z-50 bg-neutral-900/50';

const PANEL_CLASS =
  'fixed left-1/2 top-1/2 z-50 flex w-[var(--w-inspector-wide)] max-w-[calc(100%-2rem)] ' +
  '-translate-x-1/2 -translate-y-1/2 flex-col gap-3 border bg-bg p-4 shadow-[var(--shadow-lg)]';

export function Dialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  cancelLabel,
  tone = 'default',
  confirmDisabled = false,
  className,
}: DialogProps) {
  const destructive = tone === 'destructive';
  const returnFocus = useOverlayReturnFocus(open);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-overlay="dialog-backdrop" className={BACKDROP_CLASS} />
        <DialogPrimitive.Content
          data-tone={tone}
          onCloseAutoFocus={returnFocus}
          /* The body is prose of one or two lines, not a described-by target:
             it is already inside the dialog and read in order. Passing
             `undefined` explicitly is how Radix is told the omission is
             deliberate rather than a missing `Description`. */
          aria-describedby={undefined}
          className={cn(PANEL_CLASS, destructive ? 'border-fail-border' : 'border-divider', className)}
        >
          <DialogPrimitive.Title
            className={cn('font-heading text-lg', destructive ? 'text-fail-text' : 'text-text')}
          >
            {title}
          </DialogPrimitive.Title>

          {children === undefined ? null : (
            <div className="text-sm leading-normal text-neutral-800">{children}</div>
          )}

          <div className={cn('mt-2', OVERLAY_ACTIONS_CLASS)}>
            <DialogPrimitive.Close className={overlayActionClass('secondary')}>
              {cancelLabel ?? <Trans>取消</Trans>}
            </DialogPrimitive.Close>
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirmDisabled}
              data-dialog-action="confirm"
              className={overlayActionClass(destructive ? 'destructive' : 'primary')}
            >
              {confirmLabel}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
