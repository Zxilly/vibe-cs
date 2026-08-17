/*
 * Domain layer, layer 2 of 3 — 「这次重试意味着什么」.
 *
 * The task detail artboard puts a short explanation of a retry beside the
 * stage log — 「第 3 个片段开始时观察者身份没有立即确认，系统重新跳转后再采集。成片
 * 不受影响，时长与请求一致。」 — and the 浮层与状态规范 panel rules that a standing
 * message is a `Notice`, that it stays until the problem is resolved, that it
 * carries one primary recovery action and that its state is shown by shape as
 * well as by hue. All four are `design/feedback/Notice`'s job, so this
 * component is a `Notice` with the task's arithmetic in front of it and draws
 * nothing of its own.
 *
 * Two sentences, one component:
 *
 *   still retrying   「第 2 次重试」 — the run is going again
 *   exhausted        「已重试 2 次 · 已达上限，不再自动重试」 — `taskMachine`'s
 *                    `RETRY` is now ignored (see note (c) there), and saying so
 *                    is the difference between a system that gave up and a
 *                    system that looks stuck
 *
 * Both go through the `Plural` macro. Chinese has one plural form and takes the
 * `other` branch for every count, so the macro changes nothing in the source
 * locale — which is exactly why it has to be there: the message that reaches
 * the catalogue has to be pluralisable before a translator sees it, or every
 * English count reads 「1 retries」.
 *
 * The tone follows the meaning rather than the count: a retry in flight is a
 * `warning` (something went wrong, the system is handling it), a spent budget
 * is a `danger` (something went wrong and the system has stopped).
 */

import { Plural } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Alert } from '../../design/feedback';

import type { TaskRecoveryAction } from './types';

export interface RetryNoticeProps {
  /** Retries used so far — `taskRetryCount(context)`. The first run is not one. */
  readonly retries: number;
  /** Retries allowed — `taskMaxRetries(context)`. */
  readonly maxRetries: number;
  /**
   * 「第 3 个片段开始时观察者身份没有立即确认，系统重新跳转后再采集。」 — what this
   * retry means, in the user's language. The artboard prints one; the reason
   * the run failed is not the same sentence as what the retry does about it.
   */
  readonly explanation?: ReactNode | undefined;
  /**
   * The way out. Required, like every `Notice` action: while retries remain it
   * is usually 「查看阶段」, once they are spent it is the failure's own recovery
   * (「重试导出」「释放空间」), which is why the type is the same one
   * `TaskFailure.recovery` uses.
   */
  readonly action: TaskRecoveryAction;
  readonly className?: string | undefined;
}

/** 「已达上限，不再自动重试」. */
export function retriesExhausted(retries: number, maxRetries: number): boolean {
  return retries >= maxRetries;
}

export function RetryNotice({ retries, maxRetries, explanation, action, className }: RetryNoticeProps) {
  const exhausted = retriesExhausted(retries, maxRetries);
  const count = Math.max(0, Math.trunc(retries));

  return (
    <Alert
      variant={exhausted ? 'danger' : 'warning'}
      action={{
        label: action.label,
        onAction: action.onAction,
        ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
      }}
      {...(explanation === undefined ? {} : { detail: explanation })}
      {...(className === undefined ? {} : { className })}
    >
      {exhausted ? (
        <Plural value={count} other="已重试 # 次 · 已达上限，不再自动重试" />
      ) : (
        <Plural value={count} other="第 # 次重试" />
      )}
    </Alert>
  );
}
