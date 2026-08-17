/*
 * Design system, layer 1 of 3 — StatusDot.
 *
 * The single most repeated atom in the design reference: a square marker,
 * 7 / 8 / 9 px, that precedes a status line. Tallied over the reference:
 *
 *   filled  --color-ok       19×  已完成 / 本地服务在线 / 采集组件已准备
 *   filled  --color-accent   21×  运行中 / 当前选中的活动任务
 *   hollow  --color-neutral-500 17×  未开始 / 排队中
 *   hollow  --color-warn      8×  等待确认
 *   hollow  --color-fail      6×  失败
 *
 * Fill is therefore not decoration: the reference fills what has happened or is
 * happening and outlines what has not, which keeps the five states apart for a
 * reader who cannot separate the hues.
 *
 * The marker is square. `--radius-*` is 0 across this system and the reference
 * contains no border-radius declaration; only `.radio .dot` is round.
 */

import { cn } from '../cn';

export type StatusDotStatus = 'idle' | 'running' | 'ok' | 'warn' | 'fail';

/** 7 / 8 / 9 px — the three sizes the reference actually draws. */
export type StatusDotSize = 'sm' | 'md' | 'lg';

export interface StatusDotProps {
  status: StatusDotStatus;
  size?: StatusDotSize;
  /**
   * Accessible name. Omit when the dot sits directly in front of a status
   * line that already says the same thing — then it is decorative and is
   * hidden from assistive technology instead of duplicating the sentence.
   */
  label?: string;
  className?: string;
}

const SIZE_CLASS: Record<StatusDotSize, string> = {
  sm: 'size-[7px]',
  md: 'size-[8px]',
  lg: 'size-[9px]',
};

const STATUS_CLASS: Record<StatusDotStatus, string> = {
  idle: 'border border-neutral-500',
  running: 'bg-accent',
  ok: 'bg-ok',
  warn: 'border border-warn',
  fail: 'border border-fail',
};

export function StatusDot({ status, size = 'md', label, className }: StatusDotProps) {
  const shape = status === 'running' || status === 'ok' ? 'filled' : 'hollow';

  return (
    <span
      data-status={status}
      data-shape={shape}
      className={cn('block flex-none', SIZE_CLASS[size], STATUS_CLASS[status], className)}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    />
  );
}
