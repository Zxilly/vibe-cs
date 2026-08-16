/*
 * pages/montage — 「从录制结果添加」.
 *
 * A Dialog rather than a Drawer, and that is the one decision in this file.
 * 「补齐 · 规范与状态」 splits them by reversibility: 「Dialog 只承载不可逆动作
 * 与正式确认；Drawer 承载详情与非阻断编辑」. Adding clips *is* reversible —
 * they can be removed again — but it is a formal confirmation of a set: the
 * user ticks several takes and commits them in one write, exactly like 「列配置」
 * and 「删除 3 条记录？」. A Drawer would invite half-committed state on a page
 * whose every other control writes through immediately.
 *
 * Takes already in the project are listed and disabled rather than hidden: a
 * user looking for 「Mirage 1v3 残局」 and not finding it would conclude the
 * recording was lost.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { EmptyState, Skeleton } from '../../design/data';
import { Dialog, Notice } from '../../design/feedback';
import { Checkbox } from '../../design/primitives';
import { dataErrorMessage } from '../../data/errors';
import { useRecordedClips } from '../../data/outputs';
import { formatTaskClock } from '../../domain/task';
import type { RecordedClip } from '../../shared/desktop/dto';
import { RouteLink } from '../RouteLink';

export interface AddClipsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Clip ids the project already holds. Shown, disabled, never hidden. */
  readonly held: ReadonlySet<string>;
  readonly onAdd: (clipIds: readonly string[]) => void;
  readonly disabled: boolean;
  readonly disabledReason?: string | undefined;
}

export function AddClipsDialog({ open, onClose, held, onAdd, disabled, disabledReason }: AddClipsDialogProps) {
  const takes = useRecordedClips();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const rows = takes.data?.items ?? [];
  const error = dataErrorMessage(takes.error);

  const toggle = (clipId: string) => {
    const next = new Set(picked);
    if (next.has(clipId)) next.delete(clipId);
    else next.add(clipId);
    setPicked(next);
  };

  const close = () => {
    setPicked(new Set());
    onClose();
  };

  return (
    <Dialog
      open={open}
      title={<Trans>从录制结果添加</Trans>}
      confirmLabel={<Trans>添加 {picked.size} 段</Trans>}
      confirmDisabled={picked.size === 0 || disabled}
      onConfirm={() => {
        onAdd([...picked]);
        close();
      }}
      onClose={close}
    >
      {disabledReason === undefined ? null : (
        <p className="mb-3 text-xs text-neutral-700">{disabledReason}</p>
      )}

      {error === null ? null : (
        <Notice
          tone="danger"
          action={{ label: <Trans>重试</Trans>, onAction: () => void takes.refetch() }}
        >
          <Trans>录制结果没能读取：{error}</Trans>
        </Notice>
      )}

      {takes.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton width="100%" />
          <Skeleton width="86%" />
          <Skeleton width="72%" />
          <p className="sr-only" role="status">
            <Trans>正在读取录制结果</Trans>
          </p>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={<Trans>还没有录制结果</Trans>}
          description={<Trans>完成一次录制后，片段会出现在这里。</Trans>}
          headingLevel={4}
          actions={
            <RouteLink to="/recording">
              <Trans>去录制</Trans>
            </RouteLink>
          }
        />
      ) : (
        <ul className="flex max-h-[280px] flex-col gap-1 overflow-y-auto" data-montage-take-list="">
          {rows.map((take) => (
            <TakeRow
              key={take.id}
              take={take}
              held={held.has(take.id)}
              checked={picked.has(take.id)}
              onToggle={() => toggle(take.id)}
            />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function TakeRow({
  take,
  held,
  checked,
  onToggle,
}: {
  readonly take: RecordedClip;
  readonly held: boolean;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li className="flex min-h-[var(--h-row-compact)] items-center gap-3 border-b border-divider px-1">
      <Checkbox
        checked={checked}
        disabled={held}
        aria-label={t`选择 ${take.title}`}
        data-take={take.id}
        onChange={onToggle}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{take.title}</span>
        <span className="truncate text-xs text-neutral-600">
          {take.player_name} · {take.map_name} · {formatTaskClock(take.created_at, { now: new Date() })}
        </span>
      </span>
      <span className="flex-none font-mono text-xs text-neutral-700">
        {take.duration_seconds.toFixed(1)}s
      </span>
      {held ? (
        <span className="flex-none text-xs text-neutral-600">
          <Trans>已在合辑中</Trans>
        </span>
      ) : null}
    </li>
  );
}
