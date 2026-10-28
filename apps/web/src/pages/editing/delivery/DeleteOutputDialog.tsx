/** Confirm whether this action deletes a managed file or only removes its record. */

import { Trans } from '@lingui/react/macro';

import { Alert, Dialog } from '../../../design/feedback';
import { outputDeletionRemovesFile, outputFileIsUsable } from '../../../domain/media/outputModel';
import type { OutputItem } from '../../../shared/desktop/dto';

export interface DeleteOutputDialogProps {
  /** The row being acted on; `null` keeps the dialog closed. */
  readonly output: OutputItem | null;
  readonly onClose: () => void;
  readonly onDelete: (output: OutputItem) => Promise<unknown>;
  readonly deleting: boolean;
  readonly error: string | null;
}

export function DeleteOutputDialog({ output, onClose, onDelete, deleting, error }: DeleteOutputDialogProps) {
  const removesFile = output !== null && outputDeletionRemovesFile(output);
  const missing = output !== null && !outputFileIsUsable(output.availability);
  const fileName = output?.file_name ?? '';

  const confirm = () => {
    if (output === null) return;
    void onDelete(output).then(onClose, () => {
      /* rendered from `error` below */
    });
  };

  return (
    <Dialog
      open={output !== null}
      tone={removesFile ? 'destructive' : 'default'}
      title={removesFile ? <Trans>删除这个成品文件？</Trans> : <Trans>移除这条记录？</Trans>}
      onClose={onClose}
      confirmLabel={removesFile ? <Trans>删除文件</Trans> : <Trans>移除记录</Trans>}
      busy={deleting}
      confirmDisabled={output === null}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        <p className="break-words leading-normal">
          {removesFile ? (
            <Trans>「{fileName}」会从磁盘删除，不能恢复。指向它的记录一起移除。</Trans>
          ) : missing ? (
            <Trans>「{fileName}」已不在原位，只移除这条记录。</Trans>
          ) : (
            <Trans>只移除「{fileName}」的记录，磁盘上的文件不会被删除。</Trans>
          )}
        </p>

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
