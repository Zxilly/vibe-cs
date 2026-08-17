/*
 * Domain layer, 2 of 3 — match/EvidenceRow.
 *
 * One normalised fact, stamped with the tick it happened at. The reference
 * draws it in three places, and they are the same row at three densities:
 *
 *   comfortable  「05 证据检索」, a 42px results row across a full page —
 *                时间 / 比赛 / 地图 / 回合 / 主体 / 事件 / tick / 注释 / 定位·加入视频
 *   default      「03 比赛工作区」 Inspector, 「回合内证据」 — a mono tick in its own
 *                column, a first line 「Kael → Sable · AK-47 · 爆头」 and a second
 *                「A 点连接处 · 距离 12.4m」. Two lines is exactly what
 *                `--h-row-evidence` (52) exists for, so it is the default.
 *   inline       「07 Agent 创作面板」 citation list — 「引用了 4 条证据」 followed by
 *                bare links. One line, no annotation, no action column.
 *
 * Hence one `density` prop rather than three components: the domain object is
 * identical in all three and only the line count and the optional columns move.
 * Three copies would mean a change to how a tick prints had to be made thrice.
 *
 * ── Not silently failing ────────────────────────────────────────────────
 *
 * 「定位」 is the row's whole purpose — it is what makes a piece of evidence
 * deep-linkable (spec §4.4). When it cannot be offered (the demo file is
 * missing, the local service is offline) the button stays visible and disabled
 * with the reason attached, through `Button`'s `disabledReason`. The shell's
 * degradation rule — 「需要服务的动作变为禁用并写明原因，不隐藏、不静默失败」 —
 * applies to a row as much as to a toolbar.
 */

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { Skeleton } from '../../design/data';
import { Button, cn, Badge } from '../../design/primitives';
import { EVIDENCE_KIND } from './matchEnums';
import { CS2_TICK_RATE, formatTickClock, formatTickCount, formatTickTimecode } from './matchTime';
import type { EvidenceItem } from './types';

export type EvidenceDensity = 'comfortable' | 'default' | 'inline';

export interface EvidenceRowProps {
  readonly evidence: EvidenceItem;
  readonly density?: EvidenceDensity | undefined;
  /** Match-level tick rate; `evidence.tickRate` wins when both are present. */
  readonly tickRate?: number | undefined;
  /** Highlighted as the current row — the reference's accent-100 plate. */
  readonly selected?: boolean | undefined;
  /** Selecting the row itself (the search table's row click). */
  readonly onSelect?: ((evidence: EvidenceItem) => void) | undefined;
  /** 「定位」 — seek the workspace to this tick. The row's reason to exist. */
  readonly onLocate?: ((evidence: EvidenceItem) => void) | undefined;
  /** Why 「定位」 is unavailable. Disables it and says so, rather than hiding it. */
  readonly locateDisabledReason?: string | undefined;
  /** Page-supplied extra action — 「加入视频」, 「批量注释」. */
  readonly action?: ReactNode | undefined;
  readonly className?: string | undefined;
}

/* §3.4: 「--h-row-evidence 52 双行证据条目」. The one-line densities take the
   ordinary row heights of the same tables (42 / 38). */
const HEIGHT_CLASS: Readonly<Record<EvidenceDensity, string>> = {
  comfortable: 'min-h-[var(--h-row)]',
  default: 'min-h-[var(--h-row-evidence)]',
  inline: 'min-h-[var(--h-row-compact)]',
};

const PADDING_CLASS: Readonly<Record<EvidenceDensity, string>> = {
  comfortable: 'px-3.5 py-2',
  default: 'px-3.5 py-2',
  inline: 'py-1',
};

/** The reference's selected row: accent plate plus a 2px rule down its edge. */
const SELECTED_CLASS = 'bg-accent-100 shadow-[inset_2px_0_0_var(--color-accent)]';

const TICK_LABEL = msg`tick`;
const LOCATE_LABEL = msg`定位`;

export function EvidenceRow({
  evidence,
  density = 'default',
  tickRate,
  selected = false,
  onSelect,
  onLocate,
  locateDisabledReason,
  action,
  className,
}: EvidenceRowProps) {
  const { i18n } = useLingui();
  const rate = evidence.tickRate ?? tickRate ?? CS2_TICK_RATE;
  const kind = EVIDENCE_KIND[evidence.kind];
  const KindIcon = kind.icon;

  const body = (
    <>
      {/* The tick column. Both readings appear at the two-line density: the
          number is the identity a deep link carries, the timecode is what a
          human compares against a video. The one-line densities show the clock,
          which is what their artboards draw. */}
      <span className="flex flex-none flex-col text-left font-mono text-xs">
        <span className="text-accent-700" title={`${i18n._(TICK_LABEL)} ${formatTickCount(evidence.tick)}`}>
          {density === 'default' ? formatTickCount(evidence.tick) : formatTickClock(evidence.tick, rate)}
        </span>
        {density === 'default' ? (
          <span className="text-neutral-600">{formatTickTimecode(evidence.tick, rate)}</span>
        ) : null}
      </span>

      <KindIcon size={13} strokeWidth={1.5} aria-hidden="true" className="flex-none text-neutral-600" />
      <span className="sr-only">{i18n._(kind.label)}</span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          {evidence.actor === undefined ? null : <span className="truncate">{evidence.actor}</span>}
          {evidence.target === undefined ? null : (
            <>
              <ArrowRight
                size={11}
                strokeWidth={1.5}
                aria-hidden="true"
                className="flex-none text-neutral-600"
              />
              <span className="truncate">{evidence.target}</span>
            </>
          )}
          {evidence.weapon === undefined ? null : <span className="text-neutral-700">· {evidence.weapon}</span>}
          {evidence.description === undefined ? null : (
            <span className="text-neutral-700">· {evidence.description}</span>
          )}
          {evidence.round === undefined ? null : (
            <span className="flex-none text-xs text-neutral-600">
              <Trans>第 {evidence.round} 回合</Trans>
            </span>
          )}
        </span>
        {density === 'inline' ? null : (
          <span className="flex min-w-0 items-center gap-2 text-xs text-neutral-600">
            {evidence.matchLabel === undefined ? null : <span className="truncate">{evidence.matchLabel}</span>}
            {evidence.context === undefined ? null : <span className="truncate">{evidence.context}</span>}
          </span>
        )}
      </span>
    </>
  );

  return (
    <article
      data-evidence-row={evidence.id}
      data-density={density}
      data-kind={evidence.kind}
      data-tick={evidence.tick}
      aria-current={selected ? true : undefined}
      className={cn(
        'flex items-center gap-3 text-sm',
        HEIGHT_CLASS[density],
        PADDING_CLASS[density],
        density === 'inline' ? null : 'border-b border-divider',
        selected ? SELECTED_CLASS : null,
        className,
      )}
    >
      {/* Row selection is a real button rather than a click handler on the
          container: a row you can only reach with a pointer is a row half the
          users cannot reach at all. */}
      {onSelect === undefined ? (
        <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>
      ) : (
        <button
          type="button"
          data-evidence-select=""
          aria-pressed={selected}
          onClick={() => onSelect(evidence)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          {body}
        </button>
      )}

      {evidence.annotation === undefined || density === 'inline' ? null : (
        <span data-evidence-annotation="" className="flex-none">
          <Badge variant={evidence.annotation.resolved === true ? 'neutral' : 'outline'}>
            {evidence.annotation.label}
          </Badge>
        </span>
      )}

      {onLocate === undefined ? null : (
        <span data-evidence-locate="" className="flex-none">
          <Button
            variant="ghost"
            size="sm"
            {...(locateDisabledReason === undefined
              ? {}
              : { disabled: true, disabledReason: locateDisabledReason })}
            onClick={() => onLocate(evidence)}
          >
            {i18n._(LOCATE_LABEL)}
          </Button>
        </span>
      )}

      {action === undefined ? null : (
        <span data-evidence-action="" className="flex-none">
          {action}
        </span>
      )}
    </article>
  );
}

/**
 * The loading form of the same row. The artboard's rule — 「加载中 · 表格骨架
 * （不显示虚构百分比）」 — means the placeholder holds the row's box and says
 * nothing about how far along anything is.
 */
export function EvidenceRowSkeleton({ density = 'default' }: { readonly density?: EvidenceDensity }) {
  return (
    <div
      data-evidence-row-skeleton=""
      className={cn(
        'flex items-center gap-3 border-b border-divider',
        HEIGHT_CLASS[density],
        PADDING_CLASS[density],
      )}
    >
      <Skeleton width="64px" />
      <Skeleton width="42%" />
      <Skeleton width="18%" />
    </div>
  );
}
