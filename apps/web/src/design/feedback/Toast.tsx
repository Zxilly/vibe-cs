/*
 * Design system, layer 1 of 3 — Toast.
 *
 * shadcn's Toast, on Radix. And the reason the system now has one, because
 * 「浮层与状态规范」 says it should not:
 *
 *   "Notice 常驻在页面里直到问题解决，不用 Toast 承载错误"
 *
 * ── What that rule is actually protecting ─────────────────────────────────
 *
 * A message that disappears cannot hold a decision. If the user has to *choose*
 * something — retry, free some space, pick another directory — then a box that
 * removes itself after four seconds is a box that loses the choice, and the
 * user is left knowing something went wrong and not what to do. Every one of
 * the four artboard samples is that shape, which is why `Alert` requires an
 * `action` prop and has no timer.
 *
 * What the rule over-reaches on is the other half: a failure the user is
 * *already looking at*, with nothing to decide, whose retry is the same click
 * they just made. 「打开目录失败」 has no recovery step — you click again, or you
 * do not. Today that case is worse than a toast, not better: `openDirectory`
 * returns a boolean every caller drops, so the folder silently does not open
 * and the product says nothing at all. 「不隐藏、不静默失败」 is the rule that
 * governs there, and it is the one being broken.
 *
 * ── The split, stated once ────────────────────────────────────────────────
 *
 *   Toast   the result of something the user just did, complete either way,
 *           with nothing to decide. 「已复制路径」, 「打开目录失败」.
 *   Alert   anything the user has to choose about; anything about work that
 *           runs while attention is elsewhere — a recording, an analysis, an
 *           export — because a toast for a job that finished ten minutes ago
 *           is a message nobody was there to read; anything that blocks.
 *
 * The test for which one: **if the message vanished unread, would the user
 * have lost something?** If yes it is an Alert.
 *
 * ── Not a general error sink ──────────────────────────────────────────────
 *
 * Spec §4.1 routes query errors to `Alert` (`throwOnError: false`, 「错误就地
 * 渲染成 Notice」) and that is unchanged. A failed *read* leaves a hole in the
 * page, and the page has to say so where the hole is — a toast about it would
 * disappear and leave an empty panel with no explanation.
 *
 * ── Behaviour ─────────────────────────────────────────────────────────────
 *
 * Radix owns the live region, the hover/focus pause, the swipe dismiss and the
 * F8 hotkey that moves focus into the viewport. `error` is announced
 * assertively and stays twice as long, because it is the one a reader must not
 * miss; the rest wait for a pause in what the user is doing.
 */

import * as ToastPrimitive from '@radix-ui/react-toast';
import { t } from '@lingui/core/macro';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';

import { cn } from '../cn';

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastAction {
  readonly label: ReactNode;
  readonly onAction: () => void;
}

export interface ToastOptions {
  /** A second line — what was affected, which path, why. */
  readonly description?: ReactNode;
  /**
   * One optional shortcut, never the only way out. A toast's action is a
   * convenience 「撤销」/「打开」; anything the user *must* do is an `Alert`.
   */
  readonly action?: ToastAction;
  /** Milliseconds. Defaults by variant — see `DURATION_MS`. */
  readonly duration?: number;
}

interface ToastEntry extends ToastOptions {
  readonly id: number;
  readonly variant: ToastVariant;
  readonly message: ReactNode;
}

/* ── the queue ───────────────────────────────────────────────────────────── */

let entries: readonly ToastEntry[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function push(variant: ToastVariant, message: ReactNode, options: ToastOptions = {}): number {
  const id = (nextId += 1);
  entries = [...entries, { ...options, id, variant, message }];
  emit();
  return id;
}

function dismiss(id: number): void {
  entries = entries.filter((entry) => entry.id !== id);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly ToastEntry[] {
  return entries;
}

/**
 * Raise a toast. Callable from an event handler, a mutation callback, anywhere
 * — it is a module-level queue rather than a hook, because the thing that
 * fails is rarely the thing that renders.
 */
export const toast = {
  info: (message: ReactNode, options?: ToastOptions) => push('info', message, options),
  success: (message: ReactNode, options?: ToastOptions) => push('success', message, options),
  error: (message: ReactNode, options?: ToastOptions) => push('error', message, options),
  dismiss,
  /** Empties the queue. For tests, and for a route change that invalidates it. */
  clear: () => {
    entries = [];
    emit();
  },
};

/* ── the view ────────────────────────────────────────────────────────────── */

/** An error waits longer, because it is the one a reader must not miss. */
const DURATION_MS: Record<ToastVariant, number> = {
  info: 4000,
  success: 4000,
  error: 8000,
};

const VARIANT: Record<ToastVariant, { readonly Icon: typeof Info; readonly box: string; readonly icon: string }> = {
  info: { Icon: Info, box: 'border-accent-300 bg-accent-100', icon: 'text-accent-700' },
  success: { Icon: CircleCheck, box: 'border-ok-border bg-ok-surface', icon: 'text-ok' },
  error: { Icon: CircleAlert, box: 'border-fail-border bg-fail-surface', icon: 'text-fail' },
};

const ROOT_CLASS =
  'flex items-start gap-2.5 border px-3 py-2.5 text-sm shadow-[var(--shadow-md)] ' +
  'data-[state=closed]:opacity-0 data-[swipe=end]:opacity-0 transition-opacity';

/**
 * Mounted once, at the shell. Bottom-right, above every overlay: a toast that a
 * dialog covered would be a message the product decided not to show.
 */
export function Toaster() {
  const queue = useSyncExternalStore(subscribe, snapshot, snapshot);

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {queue.map((entry) => {
        const style = VARIANT[entry.variant];
        const { Icon } = style;
        return (
          <ToastPrimitive.Root
            key={entry.id}
            open
            type={entry.variant === 'error' ? 'foreground' : 'background'}
            duration={entry.duration ?? DURATION_MS[entry.variant]}
            data-variant={entry.variant}
            className={cn(ROOT_CLASS, style.box)}
            onOpenChange={(open) => {
              if (!open) dismiss(entry.id);
            }}
          >
            <span className={cn('flex-none pt-px', style.icon)}>
              <Icon size={15} strokeWidth={1.5} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <ToastPrimitive.Title className="text-text">{entry.message}</ToastPrimitive.Title>
              {entry.description === undefined ? null : (
                <ToastPrimitive.Description className="mt-1 text-xs leading-normal text-neutral-700">
                  {entry.description}
                </ToastPrimitive.Description>
              )}
            </div>
            {entry.action === undefined ? null : (
              <ToastPrimitive.Action
                asChild
                /* Radix reads this out as 「按下 X 以…」 for a screen reader that
                   cannot reach the button before the toast closes. */
                altText={typeof entry.action.label === 'string' ? entry.action.label : t`执行这个操作`}
              >
                <button
                  type="button"
                  data-toast-action=""
                  className="flex-none text-xs text-accent-700 underline underline-offset-2"
                  onClick={entry.action.onAction}
                >
                  {entry.action.label}
                </button>
              </ToastPrimitive.Action>
            )}
            <ToastPrimitive.Close
              aria-label={t`关闭提示`}
              data-toast-close=""
              className="flex-none text-neutral-600 hover:text-text"
            >
              <X size={14} strokeWidth={1.5} aria-hidden />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport
        data-toaster=""
        label={t`提示`}
        className="fixed bottom-4 right-4 z-[60] m-0 flex w-[var(--w-inspector)] max-w-[calc(100%-2rem)] list-none flex-col gap-2 p-0"
      />
    </ToastPrimitive.Provider>
  );
}
