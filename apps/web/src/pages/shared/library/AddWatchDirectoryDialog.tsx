/*
 * pages/library — 「添加监听目录」.
 *
 * 「补齐 · 规范与状态」 draws a mono path field showing 「D:\CS2\demos\」, a
 * 「包含子目录」 checkbox, the note 「不接受符号链接根目录」, and 取消 / 开始监听.
 *
 * The path can be picked or typed. 「浏览…」 opens the shell's directory picker
 * (`NativeShell.chooseDirectories`, the same door `ImportDemoDialog` uses for
 * files) and fills the field; the field stays editable, because a picked path
 * is still a path the user may want to correct, and because outside the
 * desktop shell the picker is disabled with its reason and typing is all there
 * is.
 *
 * One honest departure from the drawing, visible in the UI rather than only in
 * this comment: 「包含子目录」 is rendered **checked and disabled**, with the
 * reason on it. `commands.scanDemos` hard-codes `recursive: true` and
 * `AppConfig.demo_watch_paths` is a bare `string[]` with nowhere to record a
 * per-path flag — so the toggle has no wire. Hiding it would silently drop a
 * promise the artboard makes; disabling it with the reason written down is
 * what the shell rule 「不隐藏、不静默失败」 asks for everywhere else.
 *
 * Validation is `data/config`'s `rejectWatchPath`, so the confirm button is
 * disabled on the same answer the service would give — and on the one thing the
 * renderer *can* check, a duplicate, rather than on a guess about symlinks.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { rejectWatchPath, type WatchPathRejection } from '../../../data/config';
import { useNativeShell, useNativeShellAction } from '../../../data/nativeShell';
import { Dialog, Alert } from '../../../design/feedback';
import { Button, Checkbox, Field, Input } from '../../../design/primitives';

export interface AddWatchDirectoryDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Already-watched roots, so a duplicate is refused before the round trip. */
  readonly existingPaths: readonly string[];
  readonly onAdd: (path: string) => Promise<unknown>;
  readonly saving: boolean;
  readonly error: string | null;
}

export function AddWatchDirectoryDialog({
  open,
  onClose,
  existingPaths,
  onAdd,
  saving,
  error,
}: AddWatchDirectoryDialogProps) {
  const shell = useNativeShell();
  const shellAction = useNativeShellAction();
  const [path, setPath] = useState('');
  const [pickerError, setPickerError] = useState<string | null>(null);

  // A dialog that reopens holding the last attempt's text would look like it
  // remembered a failure it did not.
  useEffect(() => {
    if (open) {
      setPath('');
      setPickerError(null);
    }
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

  const browse = () => {
    void shell
      .chooseDirectories({ title: t`选择要监听的目录`, multiple: false })
      .then(([chosen]) => {
        if (chosen !== undefined) setPath(chosen);
        setPickerError(null);
      })
      .catch(() => {
        setPickerError(t`无法打开目录选择器，请直接填写路径。`);
      });
  };

  return (
    <Dialog
      open={open}
      title={<Trans>添加监听目录</Trans>}
      onClose={onClose}
      confirmLabel={<Trans>开始监听</Trans>}
      busy={saving}
      confirmDisabled={rejection !== null}
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
            <div className="flex gap-2">
              <Input
                {...control}
                mono
                value={path}
                disabled={saving}
                placeholder={t`D:\\CS2\\demos\\`}
                invalid={path !== '' && rejection !== null}
                onChange={(event) => {
                  setPath(event.target.value);
                }}
              />
              <Button size="sm" className="flex-none" {...shellAction.buttonProps} disabled={saving || shellAction.buttonProps.disabled} onClick={browse}>
                <Trans>浏览…</Trans>
              </Button>
            </div>
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

        {pickerError === null ? null : (
          <Alert variant="danger" action={{ label: <Trans>浏览…</Trans>, onAction: browse, disabled: saving }}>
            {pickerError}
          </Alert>
        )}

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
