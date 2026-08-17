/*
 * Domain layer, 2 of 3 — agent/TakeCard.
 *
 * One column of 「Agent 形态 2c · 分支比较 · 三条 Take」:
 *
 *   Take B · 压到 30 秒                                   [正在预览]
 *   28.5 秒 · 3 个镜头
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔  ← the strip
 *   ☑ 01 建立地点 · Static · 3.0s
 *   ☑ 02 跟随突破 · Tracking · 3.0s
 *   ☐ 04 已删除
 *   节奏最紧，适合竖屏和社媒。结尾在拆包成功的瞬间硬切。
 *   与 Take A：时长        −13.5s
 *   击杀证据覆盖           ▪ 3 / 3 未减少
 *   [预览中]  [整条选用]
 *
 * ── This one has no backend, and says so ──────────────────────────────────
 *
 * `agentContract.ts` gap 8: §4.5.2's `Take` / `Composition` have **no wire type
 * and no route**, and `AgentWorkspaceSettings.take_limit` limits something the
 * API cannot list. That is a fact about the data, not about the drawing, so the
 * component exists and every value it prints arrives as a prop:
 *
 *   · the shots are `AgentPlanShot`s, because a take is a plan (§4.5.2:
 *     `Take { id, label, plan: Plan, metrics }`), and the pick list is the
 *     artboard's 「从不同 take 里各取一个镜头合成」;
 *   · the metrics are free label / value rows, the way `TaskDetail.facts` is —
 *     **not** a fixed set of fields, because inventing 「穿墙风险镜头」 as a typed
 *     property is exactly how a made-up schema gets shipped;
 *   · the strip is passed in as a node, so the caller decides whether this take
 *     is drawn against its own length or against the baseline's.
 *
 * Nothing here fabricates a take. A page with no takes renders no `TakeCard`s.
 */

import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Button, Checkbox, Tag, cn } from '../../design/primitives';
import type { AgentPlanShot } from '../../shared/desktop/dto';

import { formatShotDuration } from './shotFormat';
import { AGENT_SHOT_KIND } from './types';

/** One line of the pick list: a shot of this take, in or out of the composition. */
export interface TakeShotPick {
  readonly shot: AgentPlanShot;
  readonly index: number;
  readonly picked: boolean;
  readonly onToggle?: ((shot: AgentPlanShot) => void) | undefined;
  readonly disabledReason?: string | undefined;
}

/** 「与 Take A：时长 −13.5s」. Free rows — see the header on why they are not typed. */
export interface TakeMetric {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** Marks a value the reader should weigh — 「穿墙风险镜头 +1」. */
  readonly tone?: 'neutral' | 'warn' | undefined;
}

export interface TakeCardProps {
  /** 「Take A · 原始方案」. */
  readonly label: ReactNode;
  /** 「42.0 秒 · 4 个镜头」. */
  readonly summary?: ReactNode | undefined;
  /** 「基准」/「正在预览」. */
  readonly badge?: ReactNode | undefined;
  /** A `PlanStrip`, built by the caller. */
  readonly strip?: ReactNode | undefined;
  readonly shots: readonly TakeShotPick[];
  /** 「证据最完整的一版…」 — the take's own note. */
  readonly note?: ReactNode | undefined;
  readonly metrics?: readonly TakeMetric[] | undefined;
  /** The take being previewed. Draws the frame, not just the badge. */
  readonly selected?: boolean | undefined;
  readonly onPreview?: (() => void) | undefined;
  readonly previewDisabledReason?: string | undefined;
  readonly onUseWhole?: (() => void) | undefined;
  readonly useWholeDisabledReason?: string | undefined;
  readonly className?: string | undefined;
}

export function TakeCard({
  label,
  summary,
  badge,
  strip,
  shots,
  note,
  metrics,
  selected = false,
  onPreview,
  previewDisabledReason,
  onUseWhole,
  useWholeDisabledReason,
  className,
}: TakeCardProps) {
  const { i18n } = useLingui();

  return (
    <section
      data-take-card=""
      {...(selected ? { 'data-take-state': 'previewing' } : {})}
      className={cn(
        'flex min-w-0 flex-col border',
        selected ? 'border-accent bg-accent-100' : 'border-divider',
        className,
      )}
    >
      <header className="flex flex-none items-center gap-2 border-b border-divider p-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="min-w-0 truncate font-heading text-lg leading-tight font-normal">{label}</h3>
          {summary === undefined ? null : (
            <p className="min-w-0 truncate text-xs text-neutral-600">{summary}</p>
          )}
        </div>
        {badge === undefined ? null : (
          <Tag tone={selected ? 'accent' : 'neutral'} className="flex-none">
            {badge}
          </Tag>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
        {strip}

        <ul data-take-shots={shots.length} className="flex flex-col gap-1.5">
          {shots.map((pick) => {
            const kind = AGENT_SHOT_KIND[pick.shot.kind];
            const removed = pick.shot.removed_by !== null;
            const number = String(pick.index).padStart(2, '0');
            const text = removed
              ? `${number} ${pick.shot.title}`
              : `${number} ${pick.shot.title} · ${kind.code} · ${formatShotDuration(pick.shot.duration_seconds)}`;

            return (
              <li key={pick.shot.id} data-take-shot={pick.shot.id} className="flex min-w-0">
                <Checkbox
                  size="md"
                  checked={pick.picked}
                  onChange={pick.onToggle === undefined ? undefined : () => pick.onToggle?.(pick.shot)}
                  {...(pick.onToggle === undefined || pick.disabledReason !== undefined
                    ? { disabled: true, ...(pick.disabledReason === undefined ? {} : { title: pick.disabledReason }) }
                    : {})}
                  className="min-w-0"
                >
                  <span className={cn('min-w-0 truncate text-sm', removed && 'text-neutral-600')}>
                    {text}
                    {removed ? (
                      <>
                        {' · '}
                        <Trans>已删除</Trans>
                      </>
                    ) : null}
                    <span className="sr-only"> {i18n._(kind.label)}</span>
                  </span>
                </Checkbox>
              </li>
            );
          })}
        </ul>

        {note === undefined ? null : (
          <p className="border-t border-divider pt-2.5 text-xs leading-normal text-neutral-800">{note}</p>
        )}

        {metrics === undefined || metrics.length === 0 ? null : (
          <dl data-take-metrics={metrics.length} className="flex flex-col gap-1.5 border-t border-divider pt-2.5 text-xs">
            {metrics.map((metric) => (
              <div key={metric.id} className="flex min-w-0 items-baseline justify-between gap-3">
                <dt className="min-w-0 truncate text-neutral-600">{metric.label}</dt>
                <dd className={cn('flex-none font-mono', metric.tone === 'warn' && 'text-warn-text')}>
                  {metric.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {onPreview === undefined && onUseWhole === undefined ? null : (
          <div className="mt-auto flex gap-2 pt-1">
            {onPreview === undefined ? null : (
              <Button
                size="sm"
                grow
                data-take-preview=""
                onClick={onPreview}
                {...(previewDisabledReason === undefined
                  ? {}
                  : { disabled: true, disabledReason: previewDisabledReason })}
              >
                {selected ? <Trans>预览中</Trans> : <Trans>预览</Trans>}
              </Button>
            )}
            {onUseWhole === undefined ? null : (
              <Button
                size="sm"
                grow
                variant={selected ? 'primary' : 'secondary'}
                data-take-use=""
                onClick={onUseWhole}
                {...(useWholeDisabledReason === undefined
                  ? {}
                  : { disabled: true, disabledReason: useWholeDisabledReason })}
              >
                <Trans>整条选用</Trans>
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
