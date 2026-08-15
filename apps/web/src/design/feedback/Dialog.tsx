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
 * No portal: `position: fixed` already escapes every ancestor's layout, and
 * `createPortal` throws under `renderToStaticMarkup`, which is the whole of the
 * spec §6.2 `markup` project.
 */

import { Trans } from '@lingui/react/macro';
import { useId, type ReactNode } from 'react';

import { OVERLAY_ACTIONS_CLASS, overlayActionClass } from './actionButton';
import { useOverlayFocus } from './overlayFocus';

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
  className = '',
}: DialogProps) {
  const titleId = useId();
  const panelRef = useOverlayFocus<HTMLDivElement>(open, onClose);

  if (!open) return null;

  const destructive = tone === 'destructive';

  return (
    // Industry `.dialog-backdrop`: a 50% neutral-900 scrim, contents centred.
    // The scrim is a plain div, not a button — clicking it dismisses, but a
    // confirmation must not be dismissible by a stray Tab+Enter, and the
    // artboard gives every dialog an explicit 取消.
    <div
      data-overlay="dialog-backdrop"
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-neutral-900/50 p-4"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-tone={tone}
        // Stops a click inside the panel from reaching the scrim's handler.
        onClick={(event) => {
          event.stopPropagation();
        }}
        className={
          'flex w-[var(--w-inspector-wide)] max-w-full flex-col gap-3 border bg-bg p-4 ' +
          'shadow-[var(--shadow-lg)] ' +
          (destructive ? 'border-fail-border ' : 'border-divider ') +
          className
        }
      >
        <h2 id={titleId} className={`font-heading text-lg ${destructive ? 'text-fail-text' : 'text-text'}`}>
          {title}
        </h2>

        {children === undefined ? null : (
          <div className="text-sm leading-normal text-neutral-800">{children}</div>
        )}

        <div className={`mt-2 ${OVERLAY_ACTIONS_CLASS}`}>
          <button type="button" onClick={onClose} className={overlayActionClass('secondary')}>
            {cancelLabel ?? <Trans>取消</Trans>}
          </button>
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
      </div>
    </div>
  );
}
