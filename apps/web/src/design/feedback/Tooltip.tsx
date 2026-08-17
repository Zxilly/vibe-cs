/*
 * Design system, layer 1 of 3 — Tooltip.
 *
 * shadcn's Tooltip — Radix `TooltipPrimitive` — and the reason the system
 * needed one at all.
 *
 * ── The bug this exists to close ──────────────────────────────────────────
 *
 * The shell artboard's degradation rule is 「需要服务的动作变为禁用并写明原因，
 * 不隐藏、不静默失败」, and `Button` implemented the 写明原因 half with the
 * native `title` attribute. On a **disabled** button that attribute shows
 * nothing: a disabled control receives no pointer events, so Chromium — which
 * is what WebView2 runs — never raises the tooltip. The reason was reaching a
 * screen reader through `aria-describedby` and reaching a sighted mouse user
 * not at all, on precisely the 234 controls where the product had promised to
 * explain itself.
 *
 * Radix cannot hang a tooltip on a disabled trigger either — nothing can, the
 * events do not exist — so `Trigger` wraps rather than borrows: the wrapper
 * span is what the pointer meets, and it stays focusable so the reason is
 * reachable from the keyboard as well. That is the standard shadcn answer to
 * the same problem, and it is the only one that does not lie.
 *
 * ── Not a Notice, and not a place to put copy ─────────────────────────────
 *
 * 「浮层与状态规范」 gives persistent explanation to `Notice` and forbids
 * carrying errors in transient overlays. A tooltip here is only ever the
 * short 「为什么现在不能点」 line — never a recovery action, never something
 * the user has to read to proceed. Anything with an action is a Notice.
 */

import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cn } from '../cn';

/**
 * Radix shares one delay timer per provider, which is what makes moving along
 * a toolbar feel like one gesture instead of six separate waits. shadcn's own
 * current Tooltip nonetheless puts a provider inside each tooltip rather than
 * asking for one at the app root, and that is copied here for the reason it
 * exists upstream: a component whose correctness depends on an ancestor
 * somebody has to remember to add is one that silently breaks in the next test
 * harness. Hoist a `TooltipProvider` above a dense row if the shared timer is
 * wanted there; nesting providers is legal.
 */
export function TooltipProvider({
  delayDuration = 400,
  children,
  ...rest
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} {...rest}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  /** The short line. Omit and the child is rendered with nothing attached. */
  content?: ReactNode;
  /** The control the tooltip describes. */
  children: ReactNode;
  /**
   * Put the tooltip on a wrapper rather than on the child. Required when the
   * child is disabled — see the module comment.
   *
   * Decide this once for a given control and keep it: flipping `wrap` remounts
   * the child, which for a button that has just become available means the
   * node the caller was holding is gone.
   */
  wrap?: boolean;
  /**
   * Make that wrapper a tab stop. Only when the child cannot be focused
   * itself — a disabled control — or the row grows a second stop for nothing.
   */
  wrapFocusable?: boolean;
  /**
   * Layout classes for that wrapper. The wrapper becomes the flex item its
   * child used to be, so a child carrying `flex-1` or `w-full` has to hand
   * those to it or the row silently re-flows around a shrink-wrapped span.
   */
  wrapClassName?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}

const CONTENT_CLASS =
  'z-50 max-w-[var(--w-panel)] border border-divider bg-bg px-2 py-1 ' +
  'text-xs leading-normal text-text shadow-[var(--shadow-md)]';

export function Tooltip({
  content,
  children,
  wrap = false,
  wrapFocusable = false,
  wrapClassName,
  side = 'top',
  className,
}: TooltipProps) {
  if (content === undefined || content === null || content === '') return <>{children}</>;

  return (
    <TooltipProvider>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          {wrap ? (
            /* `inline-flex`, not `block`: the wrapper stands where the control
               stood, inside button rows that are flex containers. */
            <span
              {...(wrapFocusable ? { tabIndex: 0 } : {})}
              className={cn('inline-flex', wrapClassName)}
            >
              {children}
            </span>
          ) : (
            children
          )}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content side={side} sideOffset={4} className={cn(CONTENT_CLASS, className)}>
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipProvider>
  );
}
