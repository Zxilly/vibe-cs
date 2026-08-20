/*
 * pages/evidence — the 「证据详情」 panel of 「05 证据检索」.
 *
 * `design/layout/Inspector` uses the shared 380px context width and brings the
 * §8 collapse for free: below 1100px it folds itself
 * into a 46px summary strip plus a drawer, and 「在比赛工作区打开」 — a main
 * action — rides on the strip rather than into the drawer. Nothing here has to
 * know about the breakpoint.
 *
 * ── Fields the artboard draws that the index does not carry ────────────────
 *
 * The reference lists 武器 / 距离, 交战轴, 回合情境 and 空间证据.
 * `EvidenceSearchItem` has the weapon, the headshot / penetration flags, the
 * source (event vs highlight) and an `attributes` bag that may hold a world
 * position. It has **no** distance, no engagement bearing and no round context.
 * Those three are not rendered as blanks or as zeros — they are simply absent,
 * and they are reported as a contract gap. A panel that printed 「0.0m」 for a
 * distance nobody measured would be worse than one that stays quiet.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Empty } from '../../design/data';
import { Inspector } from '../../design/layout';
import { Button, Badge } from '../../design/primitives';
import { StatusDot } from '../../design/feedback';
import { formatTickCount } from '../../domain/match';
import type { EvidenceSearchItem } from '../../shared/desktop/dto';
import { evidencePosition, formatMatchDay } from './evidenceItems';

export interface EvidenceDetailProps {
  /** `null` when nothing is selected. */
  readonly row: EvidenceSearchItem | null;
  readonly onOpenWorkspace: (row: EvidenceSearchItem) => void;
  readonly onLocate: (row: EvidenceSearchItem) => void;
  readonly onAddToVideo: (row: EvidenceSearchItem) => void;
  /** Why the annotation editor is unavailable; it is disabled, never hidden. */
  readonly annotateDisabledReason?: string | undefined;
  readonly onAnnotate?: (() => void) | undefined;
}

function Field({ label, children }: { readonly label: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="flex-none text-neutral-600">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

export function EvidenceDetail({
  row,
  onOpenWorkspace,
  onLocate,
  onAddToVideo,
  annotateDisabledReason,
  onAnnotate,
}: EvidenceDetailProps) {
  if (row === null) {
    return (
      <Inspector title={<Trans>证据详情</Trans>} label={t`证据详情`}>
        <Empty
          title={<Trans>还没有选中证据</Trans>}
          description={<Trans>点一行结果，这里会给出它的比赛、回合、tick 和可以做的事。</Trans>}
          actions={null}
        />
      </Inspector>
    );
  }

  const position = evidencePosition(row);
  const day = formatMatchDay(row.match_date);
  const subject =
    row.actor_name ?? row.actor_id ?? row.demo_display_name;
  const target = row.target_name ?? row.target_id;

  return (
    <Inspector
      title={<Trans>证据详情</Trans>}
      label={t`证据详情`}
      summary={
        <Trans>
          选中 {subject} · 第 {row.round} 回合 · tick {formatTickCount(row.tick)}
        </Trans>
      }
      summaryActions={
        <Button variant="primary" size="sm" onClick={() => onOpenWorkspace(row)}>
          <Trans>在比赛工作区打开</Trans>
        </Button>
      }
      footer={
        <>
          <Button variant="primary" size="lg" block onClick={() => onOpenWorkspace(row)}>
            <Trans>在比赛工作区打开</Trans>
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" grow onClick={() => onLocate(row)}>
              <Trans>2D 回放定位</Trans>
            </Button>
            <Button variant="secondary" size="sm" grow onClick={() => onAddToVideo(row)}>
              <Trans>加入作品</Trans>
            </Button>
          </div>
        </>
      }
    >
      <div>
        <div className="font-heading text-xl">
          {target === null ? (
            <>{subject}</>
          ) : (
            <Trans>
              {subject} → {target}
            </Trans>
          )}
        </div>
        <div className="mt-0.5 text-xs text-neutral-700">
          <Trans>
            {row.demo_display_name} · {row.map_name} · 第 {row.round} 回合 · tick{' '}
            {formatTickCount(row.tick)}
          </Trans>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Field label={<Trans>武器</Trans>}>
          {row.weapon ?? <span className="text-neutral-600">—</span>}
        </Field>
        <Field label={<Trans>命中方式</Trans>}>
          <span className="flex items-center justify-end gap-2">
            {row.penetrated === true ? <Badge variant="accent"><Trans>穿墙</Trans></Badge> : null}
            {row.headshot === true ? <Badge variant="accent"><Trans>爆头</Trans></Badge> : null}
            {row.penetrated !== true && row.headshot !== true ? (
              <span className="text-neutral-600">—</span>
            ) : null}
          </span>
        </Field>
        <Field label={<Trans>来源</Trans>}>
          {row.source_kind === 'highlight' ? <Trans>高光检测</Trans> : <Trans>逐事件时间轴</Trans>}
        </Field>
        <Field label={<Trans>比赛日期</Trans>}>
          {day === '' ? <span className="text-neutral-600">—</span> : day}
        </Field>
        <Field label={<Trans>空间证据</Trans>}>
          <span className="flex items-center justify-end gap-2">
            <StatusDot status={position === null ? 'idle' : 'ok'} />
            {position === null ? <Trans>不可用</Trans> : <Trans>可用</Trans>}
          </span>
        </Field>
      </div>

      <div className="border border-divider p-3">
        <div className="mb-2 font-heading text-2xs tracking-caps text-neutral-700">
          <Trans>注释</Trans>
        </div>
        <p className="text-xs leading-normal text-neutral-700">
          <Trans>这条证据还没有注释。注释是跨比赛复用的，写在这里的话会出现在「注释」视图里。</Trans>
        </p>
        <div className="mt-2">
          <Button
            variant="secondary"
            size="sm"
            {...(annotateDisabledReason === undefined
              ? {}
              : { disabled: true, disabledReason: annotateDisabledReason })}
            {...(onAnnotate === undefined ? {} : { onClick: onAnnotate })}
          >
            <Trans>写注释</Trans>
          </Button>
        </div>
      </div>
    </Inspector>
  );
}
