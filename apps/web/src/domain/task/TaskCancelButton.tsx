/*
 * Domain layer, layer 2 of 3 — 「取消」 on a task, with its confirmation.
 *
 * 「补齐 · 规范与状态」 lists 「停止这次录制？」 among the standard destructive
 * dialogs and writes its body: what the stop discards, what it keeps
 * (「已完成的 2 个片段会保留在输出里」). A task that has run for minutes is not
 * stopped on a mis-click, so every place a task offers 取消 — the drawer card,
 * the task center row, the detail header — goes through this one button and
 * this one dialog rather than firing the mutation from a plain button.
 *
 * The request itself is the caller's (`useTaskActions`); the button only knows
 * whether it is in flight. While it is, or once the service has answered
 * 取消中, the button is disabled with its reason instead of inviting a second
 * request for the same job.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState, type ReactNode } from 'react';

import { Dialog } from '../../design/feedback';
import { Button } from '../../design/primitives';
import type { TaskKind, TaskSummary } from './types';

export interface TaskCancelButtonProps {
  readonly task: TaskSummary;
  /** Sends the cancel request. Called once the reader has confirmed. */
  readonly onConfirm: () => void;
  /** The request is still in flight. */
  readonly pending?: boolean | undefined;
  readonly variant?: 'ghost' | 'secondary' | undefined;
  readonly className?: string | undefined;
}

interface CancelCopy {
  readonly title: ReactNode;
  readonly body: ReactNode;
  readonly confirm: ReactNode;
}

/** What the stop discards and what it leaves alone, per kind. */
function cancelCopy(): Readonly<Record<TaskKind, CancelCopy>> {
  return {
    recording: {
      title: <Trans>停止这次录制？</Trans>,
      body: <Trans>已录完的片段会保留在成品文件里，没录完的片段不会生成。作品和剪辑单不受影响，可以重新发起录制。</Trans>,
      confirm: <Trans>停止录制</Trans>,
    },
    export: {
      title: <Trans>停止这次导出？</Trans>,
      body: <Trans>这次导出不会生成成片。作品和素材不受影响，可以重新导出。</Trans>,
      confirm: <Trans>停止导出</Trans>,
    },
    montage: {
      title: <Trans>停止这次导出？</Trans>,
      body: <Trans>这次导出不会生成成片。作品和素材不受影响，可以重新导出。</Trans>,
      confirm: <Trans>停止导出</Trans>,
    },
    analysis: {
      title: <Trans>停止这次分析？</Trans>,
      body: <Trans>这场比赛会回到未分析状态，Demo 文件不受影响，可以重新分析。</Trans>,
      confirm: <Trans>停止分析</Trans>,
    },
    download: {
      title: <Trans>停止这次下载？</Trans>,
      body: <Trans>这条比赛不会导入资料库，可以稍后重新下载。</Trans>,
      confirm: <Trans>停止下载</Trans>,
    },
  };
}

export function TaskCancelButton({
  task,
  onConfirm,
  pending = false,
  variant = 'ghost',
  className,
}: TaskCancelButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const busy = pending || task.status === 'cancelling';
  const copy = cancelCopy()[task.kind];

  return (
    <>
      <Button
        variant={variant}
        size="sm"
        disabled={busy}
        {...(busy ? { disabledReason: t`正在取消这条任务` } : {})}
        onClick={() => setConfirming(true)}
        {...(className === undefined ? {} : { className })}
      >
        <Trans>取消</Trans>
      </Button>
      <Dialog
        open={confirming}
        tone="destructive"
        title={copy.title}
        confirmLabel={copy.confirm}
        onConfirm={() => {
          setConfirming(false);
          onConfirm();
        }}
        onClose={() => setConfirming(false)}
      >
        {copy.body}
      </Dialog>
    </>
  );
}
