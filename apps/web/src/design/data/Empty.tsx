/**
 * Design system, layer 1 of 3 — Empty, the empty and error placeholders.
 *
 * shadcn's name, not shadcn's shape. Its `Empty` is a compound —
 * `EmptyHeader / EmptyMedia / EmptyTitle / EmptyDescription / EmptyContent` —
 * and two things this component is required to guarantee cannot be expressed
 * that way: 「每条都带一个主要恢复动作」 has to be a *required prop*, and the
 * artboard's five states have to be addressable by name so that 64 call sites
 * cannot each re-type their copy. Both are below.
 *
 * 「补齐 · 规范与状态」draws six cells under "空 · 加载 · 错误": four empty
 * states, one loading skeleton (see `Skeleton.tsx`) and one error state. All
 * five are reproduced here, copy included:
 *
 *   no-matches     还没有比赛 · folder glyph · 导入 Demo ＋ 添加目录
 *   not-analysed   这场还没分析 · 开始分析
 *   no-hits        没有命中的证据 · 改为近 30 天 ＋ 清空条件
 *   no-outputs     还没有输出 · 用 Agent 制作视频
 *   error          这个页面没能打开 · fail-border frame, fail-text heading ·
 *                  返回工作台 ＋ 导出诊断
 *
 * The rule the same artboard states for `Notice` governs these too — "每条都带
 * 一个主要恢复动作" — so `actions` is a **required** prop. A placeholder with
 * nothing to do about it does not type-check.
 *
 * The action nodes come from the caller: the recovery for "没有命中的证据" is
 * page knowledge ("改为近 30 天" has to know what the filter is), and the
 * buttons themselves are `design/primitives/Button`, which pages already hold.
 *
 * One preset's copy is deliberately only half the artboard's. `no-hits` reads
 * "当前条件：选手 Kael ＋ 穿墙 ＋ 近 7 天。放宽时间范围通常最有效。" — the first
 * sentence is a rendering of live filter state, so the preset keeps the general
 * advice and the page passes the conditions in as `description`.
 */

import { Trans } from '@lingui/react/macro';
import { Folder } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../cn';

export type EmptyVariant = 'empty' | 'error';

/** The five states of the artboard, addressed by name. */
export type EmptyPreset = 'no-matches' | 'not-analysed' | 'no-hits' | 'no-outputs' | 'error';

export interface EmptyProps {
  /** Fills in the artboard's title, description, glyph and tone. */
  readonly preset?: EmptyPreset | undefined;
  /** Defaults to `error` for the `error` preset and `empty` for everything else. */
  readonly variant?: EmptyVariant | undefined;
  readonly icon?: ReactNode | undefined;
  readonly title?: ReactNode | undefined;
  readonly description?: ReactNode | undefined;
  /** Required: every state carries a primary recovery action. */
  readonly actions: ReactNode;
  /** Heading level, so the placeholder slots into the page's outline. */
  readonly headingLevel?: 2 | 3 | 4 | undefined;
  readonly className?: string | undefined;
}

const HEADING_TAG = { 2: 'h2', 3: 'h3', 4: 'h4' } as const;

/**
 * 172px, drawn six times over on 「补齐 · 规范与状态」. `tokens.data.ts` keeps it
 * out of the §3.4 bar inventory on purpose — it is a content box, not a bar —
 * and records the disposition "应在 EmptyState 里固化为组件常量". This is that
 * constant. `min-h` rather than `h`, because the artboard's cells hold two
 * lines and a real error message can run longer. Exported so the states that
 * stand in for an Empty — a loading skeleton in the same slot — can hold
 * the same box without copying the number.
 */
export const EMPTY_MIN_HEIGHT_CLASS = 'min-h-[172px]';

export function Empty({
  preset,
  variant,
  icon,
  title,
  description,
  actions,
  headingLevel = 3,
  className,
}: EmptyProps) {
  const headingId = useId();
  const content = preset === undefined ? undefined : PRESET_CONTENT[preset];
  const resolvedVariant = variant ?? (preset === 'error' ? 'error' : 'empty');
  const resolvedIcon = icon ?? content?.icon;
  const resolvedDescription = description ?? content?.description;
  const Heading = HEADING_TAG[headingLevel];

  return (
    <section
      aria-labelledby={headingId}
      data-tone={resolvedVariant}
      className={cn(
        EMPTY_MIN_HEIGHT_CLASS,
        'flex flex-col items-center justify-center gap-2 border p-5 text-center',
        resolvedVariant === 'error' ? 'border-fail-border' : 'border-divider',
        className,
      )}
    >
      {resolvedIcon ?? null}
      <Heading
        id={headingId}
        className={cn('font-heading text-lg', resolvedVariant === 'error' ? 'text-fail-text' : null)}
      >
        {title ?? content?.title}
      </Heading>
      {resolvedDescription === undefined ? null : (
        <p
          className={cn(
            'max-w-[46ch] text-xs leading-normal',
            resolvedVariant === 'error' ? 'text-neutral-800' : 'text-neutral-700',
          )}
        >
          {resolvedDescription}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>
    </section>
  );
}

interface PresetContent {
  readonly icon?: ReactNode | undefined;
  readonly title: ReactNode;
  readonly description: ReactNode;
}

/** The artboard's copy, verbatim, with the zh-CN source inside the macro (§5.1). */
const PRESET_CONTENT: Record<EmptyPreset, PresetContent> = {
  'no-matches': {
    icon: <Folder className="size-8 text-neutral-500" strokeWidth={1.5} aria-hidden="true" />,
    title: <Trans>还没有比赛</Trans>,
    description: <Trans>导入一个 .dem，或添加一个监听目录自动发现</Trans>,
  },
  'not-analysed': {
    title: <Trans>这场还没分析</Trans>,
    description: <Trans>分析后才有回合、证据和高光。一场 40 分钟的比赛大约需要 3 分钟。</Trans>,
  },
  'no-hits': {
    title: <Trans>没有命中的证据</Trans>,
    description: <Trans>放宽时间范围通常最有效。</Trans>,
  },
  'no-outputs': {
    title: <Trans>还没有输出</Trans>,
    description: <Trans>完成一次录制或导出后，成片会出现在这里，并链接回它的来源任务。</Trans>,
  },
  error: {
    title: <Trans>这个页面没能打开</Trans>,
    description: <Trans>其余功能不受影响。你可以返回工作台，或把这次错误导出给开发者。</Trans>,
  },
};
