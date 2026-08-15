/*
 * Design system, layer 1 of 3 — StageBar.
 *
 * The task stage bar of the 「任务详情与阶段日志」artboard, redrawn identically on
 * the 交付 · 任务记录 timeline:
 *
 *   <div style="display:flex;gap:4px">
 *     <span style="flex:1;height:6px;background:[--color-ok]"></span>   … ×6
 *   </div>
 *   <div style="display:flex;justify-content:space-between;font-size:11px;
 *               color:var(--color-neutral-600)">
 *     <span>启动</span><span>跳转</span><span>采集</span>
 *     <span>稳定</span><span>编码</span><span>发布</span>
 *   </div>
 *
 * Six equal segments plus a label row. Spec §4.3 makes the sequence a parameter
 * of the task type (录制 6 阶段, 分析 5 阶段, 导出, 下载), so the component takes the
 * stages rather than hard-coding six; `recordingStages` supplies the six the
 * artboard names.
 *
 * Two departures from the drawn markup, both structural rather than visual:
 *
 *   · the two rows become one `<ol>` of `<li>` cells, so each label is the
 *     accessible name of its own segment instead of floating in a sibling row,
 *     and the active step can carry `aria-current="step"`. Equal columns put
 *     the labels exactly under their segment, which the drawn `space-between`
 *     only approximates.
 *   · every cell states its state in words, `sr-only`. The reference separates
 *     完成 / 进行中 / 未开始 / 失败 by fill colour alone, which the same artboard's
 *     Notice rule ("不只靠颜色区分") rejects one panel further down.
 *
 * Spec §4.3 again: 「推进由后端事件驱动，前端不模拟进度」. There is no timer here
 * and no inference — the caller states each stage's state.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

export type StageState = 'pending' | 'active' | 'done' | 'failed';

export interface Stage {
  id: string;
  label: ReactNode;
  state: StageState;
}

export interface StageBarProps {
  stages: readonly Stage[];
  /** Names the bar as a whole, e.g. 「录制阶段」. */
  label: string;
  className?: string;
}

const SEGMENT_CLASS: Record<StageState, string> = {
  // `--color-neutral-200` is the reference's unfilled track in both themes: the
  // 暗色 artboard's shell mock draws it at that token's own dark value.
  pending: 'bg-neutral-200',
  active: 'bg-accent',
  done: 'bg-ok',
  failed: 'bg-fail',
};

function StateWord({ state }: { state: StageState }) {
  switch (state) {
    case 'pending':
      return <Trans>未开始</Trans>;
    case 'active':
      return <Trans>进行中</Trans>;
    case 'done':
      return <Trans>已完成</Trans>;
    case 'failed':
      return <Trans>失败</Trans>;
  }
}

export function StageBar({ stages, label, className = '' }: StageBarProps) {
  return (
    <ol
      aria-label={label}
      // `grid-flow-col` + `auto-cols-fr`: the artboard's `flex:1` per segment.
      // gap-1 is 3.4px against `--spacing`, the drawn `gap:4px`.
      className={`m-0 grid list-none grid-flow-col auto-cols-fr gap-1 p-0 ${className}`.trimEnd()}
    >
      {stages.map((stage) => (
        <li
          key={stage.id}
          data-stage={stage.id}
          data-state={stage.state}
          aria-current={stage.state === 'active' ? 'step' : undefined}
          className="flex min-w-0 flex-col gap-1 last:text-end"
        >
          <span aria-hidden="true" className={`block h-[6px] w-full ${SEGMENT_CLASS[stage.state]}`} />
          <span className="truncate text-2xs text-neutral-600">{stage.label}</span>
          <span className="sr-only">
            <StateWord state={stage.state} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The six stages the artboard names for a recording task, in order. */
export const RECORDING_STAGE_IDS = ['launch', 'seek', 'capture', 'settle', 'encode', 'publish'] as const;

export type RecordingStageId = (typeof RECORDING_STAGE_IDS)[number];

/**
 * 启动 · 跳转 · 采集 · 稳定 · 编码 · 发布 with the caller's states applied.
 * A state the caller leaves out is `pending`, so a task that has not started
 * can pass an empty array.
 */
export function recordingStages(states: readonly StageState[]): Stage[] {
  const label: Record<RecordingStageId, ReactNode> = {
    launch: <Trans>启动</Trans>,
    seek: <Trans>跳转</Trans>,
    capture: <Trans>采集</Trans>,
    settle: <Trans>稳定</Trans>,
    encode: <Trans>编码</Trans>,
    publish: <Trans>发布</Trans>,
  };

  return RECORDING_STAGE_IDS.map((id, index) => ({
    id,
    label: label[id],
    state: states[index] ?? 'pending',
  }));
}
