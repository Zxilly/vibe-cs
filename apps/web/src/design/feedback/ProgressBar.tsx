/*
 * Design system, layer 1 of 3 — ProgressBar.
 *
 * The reference draws it the same way in all eight places it appears:
 *
 *   <div style="height:6px;background:var(--color-neutral-200)">
 *     <div style="width:62%;height:6px;background:var(--color-accent)"></div>
 *   </div>
 *
 * A track, a fill, no label of its own — the caller writes 「62%」or「2/6」
 * beside it in the mono face, and the stage name above it.
 *
 * The one rule the artboard states in prose, on the 加载 · 空 · 错误 panel:
 *   "有真实分母时才用进度条，否则只给阶段名"
 * so `value` and `max` are both required and neither is optional-with-default:
 * there is no indeterminate mode to fall into, and code that has no denominator
 * cannot render this component at all. It renders a StageBar instead.
 */

export type ProgressBarTone = 'accent' | 'ok' | 'fail';

/** 5 / 6 / 8 px — the three track heights the reference draws. */
export type ProgressBarSize = 'sm' | 'md' | 'lg';

export interface ProgressBarProps {
  /** Completed units. Clamped into `[0, max]`. */
  value: number;
  /** The real denominator: 6 clips, 5 analysis stages, 100 percent. */
  max: number;
  /** Accessible name, e.g. 「分析进度」. */
  label: string;
  /**
   * What the number means, read out in place of the bare ratio — 「2/6 片段」.
   * Omit and assistive technology announces the percentage.
   */
  valueText?: string;
  size?: ProgressBarSize;
  tone?: ProgressBarTone;
  className?: string;
}

const SIZE_CLASS: Record<ProgressBarSize, string> = {
  sm: 'h-[5px]',
  md: 'h-[6px]',
  lg: 'h-[8px]',
};

const TONE_CLASS: Record<ProgressBarTone, string> = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  fail: 'bg-fail',
};

export function ProgressBar({
  value,
  max,
  label,
  valueText,
  size = 'md',
  tone = 'accent',
  className = '',
}: ProgressBarProps) {
  // A denominator of zero is a caller bug, not a state to render: it would make
  // the ratio undefined. Treat it as "nothing done" rather than dividing by it.
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  const percent = (clamped / safeMax) * 100;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuetext={valueText}
      data-tone={tone}
      className={`w-full bg-neutral-200 ${SIZE_CLASS[size]} ${className}`.trimEnd()}
    >
      <div
        aria-hidden="true"
        className={`h-full ${TONE_CLASS[tone]}`}
        style={{ width: `${String(percent)}%` }}
      />
    </div>
  );
}
