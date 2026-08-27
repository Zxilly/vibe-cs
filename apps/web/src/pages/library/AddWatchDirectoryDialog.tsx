/*
 * pages/library — 「添加监听目录」.
 *
 * 「补齐 · 规范与状态」 draws a mono path field showing 「D:\CS2\demos\」, a
 * 「包含子目录」 checkbox, the note 「不接受符号链接根目录」, and 取消 / 开始监听.
 *
 * Two honest departures from the drawing, both visible in the UI rather than
 * only in this comment:
 *
 *   · the path is **typed**, not picked. `shared/desktop/client` has no
 *     directory-picker command, and the browser's file input cannot yield a
 *     directory path. The field is a `Input` with the artboard's mono
 *     treatment and the same placeholder.
 *   · 「包含子目录」 is rendered **checked and disabled**, with the reason on it.
 *     `commands.scanDemos` hard-codes `recursive: true` and `AppConfig.
 *     demo_watch_paths` is a bare `string[]` with nowhere to record a per-path
 *     flag — so the toggle has no wire. Hiding it would silently drop a promise
 *     the artboard makes; disabling it with the reason written down is what the
 *     shell rule 「不隐藏、不静默失败」 asks for everywhere else.
 *
 * Validation is `data/config`'s `rejectWatchPath`, so the confirm button is
 * disabled on the same answer the service would give — and on the one thing the
 * renderer *can* check, a duplicate, rather than on a guess about symlinks.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { rejectWatchPath, type WatchPathRejection } from '../../data/config';
import { Dialog, Alert } from '../../design/feedback';
import { Checkbox, Field, Input } from '../../design/primitives';
import type { ServiceActionButtonProps } from './serviceAction';

export interface AddWatchDirectoryDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Already-watched roots, so a duplicate is refused before the round trip. */
  readonly existingPaths: readonly string[];
  readonly onAdd: (path: string) => Promise<unknown>;
  readonly saving: boolean;
  readonly error: string | null;
  readonly service: ServiceActionButtonProps;
}

export function AddWatchDirectoryDialog({
  open,
  onClose,
  existingPaths,
  onAdd,
  saving,
  error,
  service,
}: AddWatchDirectoryDialogProps) {
  const [path, setPath] = useState('');

  // A dialog that reopens holding the last attempt's text would look like it
  // remembered a failure it did not.
  useEffect(() => {
    if (open) setPath('');
  }, [open]);

  const rejection = rejectWatchPath(path, existingPaths);
  const confirm = () => {
    if (rejection !== null) return;
    void onAdd(path.trim()).then(
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
      title={<Trans>添加监听目录</Trans>}
      onClose={onClose}
      confirmLabel={<Trans>开始监听</Trans>}
      confirmDisabled={rejection !== null || saving || service.disabled}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        <Field
          label={<Trans>目录</Trans>}
          hint={<Trans>不接受符号链接根目录</Trans>}
          // `exactOptionalPropertyTypes`: an explicit `undefined` is not the
          // same as an absent optional prop, so the empty case omits the key.
          {...(rejection === null || path === '' ? {} : { error: rejectionMessage(rejection) })}
        >
          {(control) => (
            <Input
              {...control}
              mono
              value={path}
              placeholder={t`D:\\CS2\\demos\\`}
              invalid={path !== '' && rejection !== null}
              onChange={(event) => {
                setPath(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="flex flex-col gap-1">
          <Checkbox checked disabled>
            <Trans>包含子目录</Trans>
          </Checkbox>
          <p className="text-xs leading-normal text-neutral-600">
            <Trans>服务当前按目录递归监听，子目录会一同纳入</Trans>
          </p>
        </div>

        {service.disabled && service.disabledReason !== undefined ? (
          <p className="text-xs leading-normal text-neutral-700">{service.disabledReason}</p>
        ) : null}

        {error === null ? null : (
          <Alert
            variant="danger"
            action={{ label: <Trans>重试</Trans>, onAction: confirm, disabled: saving }}
          >
            {error}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

function rejectionMessage(rejection: WatchPathRejection) {
  return rejection === 'empty' ? (
    <Trans>填写一个目录的完整路径</Trans>
  ) : (
    <Trans>这个目录已经在监听中</Trans>
  );
}
