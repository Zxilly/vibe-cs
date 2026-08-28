/*
 * Domain layer, 2 of 3 — agent/PlanShotRow.
 *
 * One shot of a plan. The reference draws it at two densities and they are the
 * same object, so this is one component with a `density` prop rather than two —
 * the rule `EvidenceRow` established:
 *
 *   card     「07 Agent 创作面板」's 2×2 grid, and 「补齐 · 手动编辑」's list —
 *            番号 · 种类 · 标题 · 时长 / 依据 / tick 区间 / 风险 / 来源徽标
 *   compact  「Agent 形态 2b」's four selectable headers and 「新建会话」's
 *            当前镜头 grid — one line plus 「Static · 交代 A 点与包点关系」
 *
 * ── What the artboards ask for, field by field ────────────────────────────
 *
 *   番号        the position, one-based, mono — the same number the strip, the
 *               change cards and the edit notice all use to name a shot
 *   种类徽标    `AGENT_SHOT_KIND[kind].code` — 「Static」「Tracking」, the Latin
 *               camera term the artboard prints, with the Chinese gloss as the
 *               accessible name (`domain/agent/types.ts` explains the pairing)
 *   时长        mono, one decimal, right-aligned
 *   依据        `rationale`, the sentence that says why the shot exists
 *   证据引用    `evidence_refs`, printed as the server sends them (they are
 *               opaque strings on the wire; nothing here parses them)
 *   风险        `risks`, each on the warn surface with an icon — 「无完整碰撞
 *               几何，运动镜头可能穿墙」
 *   来源徽标    `AGENT_PLAN_AUTHOR[source].sourceBadge` — 「Agent」/「你改过」.
 *               §4.5.3 ② is in that word: a shot the user touched is never
 *               marked as needing approval.
 *   已删除态    `removed_by !== null` — dashed box, 「你删除的」, and 撤销删除
 *               stays offered. A soft delete that cannot be undone is a delete.
 *
 * A field the backend leaves empty is **omitted**, never drawn as an empty row:
 * `rationale` may be `''` and `evidence_refs` / `risks` may be `[]`, and each of
 * those is a line that is simply not there.
 *
 * Pure presentation (§2.1 rule 6): no query, no navigation, no editing state.
 * The manual-edit form of this card — the one with the fields and 保存改动 — is
 * a page concern, because it owns the draft and the notifier; what is shared is
 * the reading of a shot, which is this.
 */

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { Skeleton } from '../../design/data';
import { Button, Badge, cn } from '../../design/primitives';
import type { AgentPlanShot, AgentShotMaterializationState } from '../../shared/desktop/dto';

import { formatShotDuration, formatTickRange } from './shotFormat';
import { AGENT_PLAN_AUTHOR, AGENT_SHOT_KIND, AGENT_SHOT_VIEW } from './types';

export type PlanShotDensity = 'card' | 'compact';

export interface PlanShotRowProps {
  readonly shot: AgentPlanShot;
  /** One-based position. The list owns the numbering, not the shot. */
  readonly index: number;
  readonly density?: PlanShotDensity | undefined;
  readonly selected?: boolean | undefined;
  /** Durable Take compatibility projected by the collaboration workbench. */
  readonly materializationState?: AgentShotMaterializationState | undefined;
  readonly onSelect?: ((shot: AgentPlanShot) => void) | undefined;
  /** 「撤销删除」. Offered only while `removed_by` is set. */
  readonly onRestore?: ((shot: AgentPlanShot) => void) | undefined;
  readonly restoreDisabledReason?: string | undefined;
  /** 「替换镜头」 and friends — page-owned actions, placed in the footer. */
  readonly action?: ReactNode | undefined;
  /** 「双击编辑 · 拖动可排序」, which only the editable list draws. */
  readonly hint?: ReactNode | undefined;
  readonly className?: string | undefined;
}

const TICK_LABEL = msg`tick`;
const EVIDENCE_LABEL = msg`依据`;

/** The reference's selected card: a 2px accent frame over the accent plate. */
const SELECTED_CLASS = 'border-accent bg-accent-100';

export function PlanShotRow({
  shot,
  index,
  density = 'card',
  selected = false,
  materializationState,
  onSelect,
  onRestore,
  restoreDisabledReason,
  action,
  hint,
  className,
}: PlanShotRowProps) {
  const { i18n } = useLingui();

  const kind = AGENT_SHOT_KIND[shot.kind];
  const view = AGENT_SHOT_VIEW[shot.view];
  const author = AGENT_PLAN_AUTHOR[shot.source];
  const removed = shot.removed_by !== null;
  const removedBy = shot.removed_by === null ? null : AGENT_PLAN_AUTHOR[shot.removed_by];
  const risky = shot.risks.length > 0;

  const number = String(index).padStart(2, '0');
  const duration = formatShotDuration(shot.duration_seconds);
  const KindIcon = kind.icon;
  const materializationLabel = materializationState === undefined
    ? null
    : materializationState === 'recorded'
      ? <Trans>已录制</Trans>
      : materializationState === 'stale'
        ? <Trans>需重录</Trans>
        : materializationState === 'unbound'
          ? <Trans>未绑定</Trans>
          : materializationState === 'removed'
            ? <Trans>已移除</Trans>
            : <Trans>待录制</Trans>;

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex-none font-mono text-xs text-neutral-600">{number}</span>
      <Badge variant={selected ? 'accent' : 'neutral'} className="flex-none gap-1">
        <KindIcon size={11} strokeWidth={1.5} aria-hidden="true" />
        {kind.code}
        <span className="sr-only"> {i18n._(kind.label)}</span>
      </Badge>
      <span
        className={cn(
          'min-w-0 truncate font-heading',
          density === 'card' ? 'text-lg' : 'text-base',
          removed && 'text-neutral-600',
        )}
      >
        {shot.title}
      </span>
      <span className="ml-auto flex-none font-mono text-xs">{duration}</span>
    </div>
  );

  const body =
    density === 'compact' ? (
      <p className="truncate text-xs text-neutral-700">
        {kind.code}
        {materializationLabel === null ? null : <> · {materializationLabel}</>}
        {shot.rationale === '' ? null : <> · {shot.rationale}</>}
      </p>
    ) : (
      <>
        {shot.rationale === '' ? null : (
          <p className="text-sm leading-normal text-neutral-800">{shot.rationale}</p>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-700">
          {shot.evidence_refs.length === 0 ? null : (
            <span data-shot-evidence="" className="min-w-0 truncate">
              {i18n._(EVIDENCE_LABEL)}：{shot.evidence_refs.join(' · ')}
            </span>
          )}
          <span className="flex-none font-mono">
            {i18n._(TICK_LABEL)} {formatTickRange(shot.start_tick, shot.end_tick)}
          </span>
        </div>

        {risky ? (
          <ul data-shot-risks="" className="flex flex-col gap-1">
            {shot.risks.map((risk) => (
              <li
                key={risk}
                className="flex items-start gap-2 bg-warn-surface px-2.5 py-2 text-xs text-warn-text"
              >
                <TriangleAlert size={13} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 flex-none" />
                <span className="min-w-0">{risk}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </>
    );

  const footer =
    density === 'compact' ? null : (
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {/* 来源徽标. An outline chip for 「你改过」 so it reads as the user's mark
            even where the accent plate is already the selection. */}
        <Badge data-shot-source={shot.source} variant={shot.source === 'user' ? 'outline' : 'neutral'}>
          {i18n._(author.sourceBadge)}
        </Badge>
        <Badge variant="neutral">{i18n._(view.label)}</Badge>
        {materializationLabel === null ? null : (
          <Badge
            data-shot-materialization={materializationState}
            variant={materializationState === 'recorded' ? 'accent' : 'outline'}
          >
            {materializationLabel}
          </Badge>
        )}
        {removedBy === null ? null : (
          <Badge data-shot-removed="" variant="outline">
            {i18n._(removedBy.removedBadge)}
          </Badge>
        )}
        {onRestore === undefined || !removed ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRestore(shot)}
            {...(restoreDisabledReason === undefined
              ? {}
              : { disabled: true, disabledReason: restoreDisabledReason })}
          >
            <Trans>撤销删除</Trans>
          </Button>
        )}
        {action === undefined ? null : <span className="ml-auto flex-none">{action}</span>}
      </div>
    );

  const content = (
    <>
      {header}
      {body}
      {footer}
      {hint === undefined || density === 'compact' ? null : (
        <p className="text-xs text-neutral-600">{hint}</p>
      )}
    </>
  );

  const frame = cn(
    'flex flex-col gap-2 border p-3.5 text-left',
    density === 'compact' && 'gap-1 p-3',
    removed
      ? 'border-dashed border-neutral-500 bg-neutral-100'
      : risky && !selected
        ? 'border-warn-border'
        : 'border-divider',
    selected && !removed && SELECTED_CLASS,
    className,
  );

  if (onSelect === undefined) {
    return (
      <article
        data-plan-shot={shot.id}
        data-density={density}
        data-shot-kind={shot.kind}
        {...(removed ? { 'data-shot-state': 'removed' } : {})}
        aria-current={selected ? true : undefined}
        className={frame}
      >
        {content}
      </article>
    );
  }

  /* Selectable shots are real buttons — the 2b board's four headers are how the
     panel on the right changes, and a header only a pointer can reach makes the
     whole editor unreachable from the keyboard. The footer's own buttons sit
     inside it, so `onRestore` and `action` are rendered outside the button when
     the row is selectable. */
  return (
    <article
      data-plan-shot={shot.id}
      data-density={density}
      data-shot-kind={shot.kind}
      {...(removed ? { 'data-shot-state': 'removed' } : {})}
      aria-current={selected ? true : undefined}
      className={frame}
    >
      <button
        type="button"
        data-plan-shot-select=""
        aria-pressed={selected}
        onClick={() => onSelect(shot)}
        className="flex min-w-0 flex-1 flex-col gap-2 text-left"
      >
        {header}
        {body}
      </button>
      {footer}
      {hint === undefined || density === 'compact' ? null : (
        <p className="text-xs text-neutral-600">{hint}</p>
      )}
    </article>
  );
}

/**
 * The loading form. Bars only — 「加载中 · 表格骨架（不显示虚构百分比）」 applies
 * to a card as much as to a table, and a shot whose record has not arrived has
 * no length to state either.
 */
export function PlanShotRowSkeleton({
  density = 'card',
  className,
}: {
  readonly density?: PlanShotDensity | undefined;
  readonly className?: string | undefined;
}) {
  const { i18n } = useLingui();
  return (
    <div
      data-plan-shot-skeleton=""
      role="status"
      aria-busy="true"
      aria-label={i18n._(LOADING_LABEL)}
      className={cn('flex flex-col gap-2 border border-divider p-3.5', density === 'compact' && 'p-3', className)}
    >
      <Skeleton width="52%" className="h-3.5" />
      {density === 'compact' ? null : <Skeleton width="86%" />}
      <Skeleton width="38%" />
    </div>
  );
}

const LOADING_LABEL = msg`加载镜头`;
