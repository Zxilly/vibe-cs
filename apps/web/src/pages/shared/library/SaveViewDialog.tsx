/*
 * pages/library — 「保存为视图」.
 *
 * 「补齐 · 规范与状态」 draws a name field prefilled 「待剪素材」, the line
 * 「保存当前的搜索、筛选、排序和列配置」, and 取消 / 保存. The saved view then
 * appears in the filter strip as the accent tag 「保存的视图 · 待剪素材」 that
 * 「02 Demo 资料库」 draws.
 *
 * App-session view state is owned by librarySession; changing routes does not
 * discard a saved filter and column snapshot.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { Dialog } from '../../../design/feedback';
import { Field, Input } from '../../../design/primitives';

export interface SaveViewDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Names already taken, so 保存 does not silently replace one. */
  readonly existingNames: readonly string[];
  readonly onSave: (name: string) => void;
}

export function SaveViewDialog({ open, onClose, existingNames, onSave }: SaveViewDialogProps) {
  const [name, setName] = useState('');

  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const trimmed = name.trim();
  const duplicate = existingNames.some((entry) => entry === trimmed);
  const invalid = trimmed === '' || duplicate;

  return (
    <Dialog
      open={open}
      title={<Trans>保存为视图</Trans>}
      onClose={onClose}
      confirmLabel={<Trans>保存</Trans>}
      confirmDisabled={invalid}
      onConfirm={() => {
        if (invalid) return;
        onSave(trimmed);
        onClose();
      }}
    >
      <div className="flex flex-col gap-3">
        <Field
          label={<Trans>名称</Trans>}
          {...(duplicate ? { error: <Trans>已经有一个同名的视图</Trans> } : {})}
        >
          {(control) => (
            <Input
              {...control}
              value={name}
              placeholder={t`待剪素材`}
              invalid={duplicate}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>保存当前的搜索、筛选、排序和列配置</Trans>
        </p>
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>保存的视图只保留到关闭应用为止</Trans>
        </p>
      </div>
    </Dialog>
  );
}
