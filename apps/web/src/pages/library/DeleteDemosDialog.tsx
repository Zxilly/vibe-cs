/*
 * pages/library — 「删除 3 条记录？」, the destructive one.
 *
 * 「补齐 · 规范与状态」 draws it in the fail palette: a brick-red border and
 * title, the blast radius spelled out — 「其中 2 条是受管文件，会进入可回滚暂存，
 * 24 小时后清除；1 条是外部文件，只移除记录。」 — and a brick-red 删除 bottom
 * right. `Dialog tone="destructive"` is all three.
 *
 * The two halves come from `libraryFormat.partitionForDelete`, which infers
 * 「受管」 from `DemoSummary.source === 'upload'` because the wire carries no
 * managed flag. The sentence is assembled from that count rather than copied
 * verbatim, so the numbers are always the selection's own.
 */

import { Plural, Trans } from '@lingui/react/macro';

import { Dialog, Alert } from '../../design/feedback';
import type { DemoSummary } from '../../shared/desktop/viewModels';
import { partitionForDelete } from './libraryFormat';

export interface DeleteDemosDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The rows the selection bar is acting on, in row order. */
  readonly demos: readonly DemoSummary[];
  readonly onDelete: () => Promise<unknown>;
  readonly deleting: boolean;
  readonly error: string | null;
}

export function DeleteDemosDialog({
  open,
  onClose,
  demos,
  onDelete,
  deleting,
  error,
}: DeleteDemosDialogProps) {
  const { managed, external } = partitionForDelete(demos);

  const confirm = () => {
    void onDelete().then(
      () => {
        onClose();
      },
      () => {
        /* rendered from `error` below */
      },
    );
  };

  return (
    <Dialog
      open={open}
      tone="destructive"
      title={<Plural value={demos.length} other="删除 # 条记录？" />}
      onClose={onClose}
      confirmLabel={<Trans>删除</Trans>}
      confirmDisabled={deleting || demos.length === 0}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        <p className="leading-normal">
          {managed.length > 0 ? (
            <Plural
              value={managed.length}
              other="其中 # 条是受管文件，会进入可回滚暂存，24 小时后清除。"
            />
          ) : null}
          {external.length > 0 ? (
            <Plural value={external.length} other="# 条是外部文件，只移除记录，磁盘上的文件不会被删除。" />
          ) : null}
        </p>

        {/* The names, so 「3 条」 is checkable. Truncated per row rather than
            cut off as a list: §10.3 calls a silently shortened list a bug. */}
        <ul className="flex max-h-[172px] flex-col gap-1 overflow-y-auto text-xs text-neutral-700">
          {demos.map((demo) => (
            <li key={demo.id} className="truncate">
              {demo.display_name}
            </li>
          ))}
        </ul>

        {error === null ? null : (
          <Alert
            variant="danger"
            action={{ label: <Trans>重试</Trans>, onAction: confirm, disabled: deleting }}
          >
            {error}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
