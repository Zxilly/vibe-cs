/*
 * Domain layer, 2 of 3 — agent/AgentWorkTrail.
 *
 * 「07 Agent 创作面板」's 工作进度:
 *
 *   ▪ 读取比赛结构      24 回合 · 10 名选手 · 18 条高光证据
 *   ▪ 筛选候选片段      7 条与 Kael 相关，选中第 21 回合残局
 *   ▪ 读取空间证据      移动路线、朝向样本、经击杀验证的交战轴
 *   ▪ 设计镜头          4 个镜头 · 1 处降级为 POV · 1 处标注风险
 *   ▫ 等待你的确认      确认后才会启动 CS2 回放与采集
 *
 * A marker, a connector down to the next one, a label and a detail line. The
 * same shape appears inside an assistant bubble as its tool calls, which is why
 * it is one component and not a block of the Agent page.
 *
 * ── Three states, and why the last one is warn ────────────────────────────
 *
 *   done     filled — it happened. `StatusDot`'s `ok`.
 *   active   filled — it is happening. `StatusDot`'s `running`.
 *   waiting  **hollow warn**, which is the artboard's own last row: 「等待你的
 *            确认」 is drawn as a hollow amber square, and amber is §3.1's
 *            等待确认. That is not decoration — §4.5.3 ① makes 「waiting for
 *            you」 the state the entire recording pipeline hangs on.
 *
 * `StatusDot` fills what has happened and outlines what has not, so the shape
 * separates the three for a reader who cannot separate the hues (§6.2), and
 * every row's word says it as well.
 *
 * Pure presentation. Backend gap 7 (`agentContract.ts`) is why the steps arrive
 * as props: `AgentSessionEntry` has no per-step record, and a tool call's
 * `input` / `output` are `unknown`, so the labels are the caller's to resolve.
 */

import { useLingui } from '@lingui/react';
import type { ReactNode } from 'react';

import { StatusDot, type StatusDotStatus } from '../../design/feedback';
import { cn } from '../../design/primitives';

import { AGENT_WORK_STEP_STATE, type AgentWorkStepState } from './workSteps';

export interface AgentWorkStep {
  readonly id: string;
  readonly label: ReactNode;
  /** The second line — 「24 回合 · 10 名选手 · 18 条高光证据」. Omitted when absent. */
  readonly detail?: ReactNode | undefined;
  readonly state?: AgentWorkStepState | undefined;
}

const DOT_STATUS: Readonly<Record<AgentWorkStepState, StatusDotStatus>> = {
  done: 'ok',
  active: 'running',
  waiting: 'warn',
};

export interface AgentWorkTrailProps {
  readonly steps: readonly AgentWorkStep[];
  /** Accessible name of the list — 「工作进度」. */
  readonly label: string;
  readonly className?: string | undefined;
}

export function AgentWorkTrail({ steps, label, className }: AgentWorkTrailProps) {
  const { i18n } = useLingui();

  return (
    <ol data-agent-work-trail="" aria-label={label} className={cn('flex flex-col', className)}>
      {steps.map((step, position) => {
        const state = step.state ?? 'done';
        const last = position === steps.length - 1;

        return (
          <li key={step.id} data-work-step={step.id} data-work-state={state} className="flex gap-3">
            <span className="flex w-[9px] flex-none flex-col items-center">
              <StatusDot status={DOT_STATUS[state]} size="lg" className="mt-1" />
              {/* The connector. Hidden from assistive technology: the list
                  already says these are consecutive. */}
              {last ? null : <span aria-hidden="true" className="w-px flex-1 bg-divider" />}
            </span>

            <div className={cn('flex min-w-0 flex-col gap-0.5', last ? null : 'pb-4')}>
              <span className="min-w-0 text-sm">
                {step.label}
                {/* The state in words, so the square is never the only reading. */}
                <span className="sr-only"> {i18n._(AGENT_WORK_STEP_STATE[state].label)}</span>
              </span>
              {step.detail === undefined ? null : (
                <span className="min-w-0 text-xs text-neutral-600">{step.detail}</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
