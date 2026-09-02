/*
 * pages/library — 「导入 Demo」, the first of the artboard's eleven overlays.
 *
 * 「补齐 · 规范与状态」 draws it exactly: a dashed drop target reading 「把 .dem
 * 或 .zip 拖到这里」, the line 「校验文件头与大小；同一份内容不会重复入库」, and
 * 取消 / 选择文件 bottom-right.
 *
 * ## Why it is still a `Dialog`
 *
 * `Dialog`'s API *is* a confirmation — `confirmLabel` and `onConfirm` are
 * required — and the artboard's primary button says 「选择文件」, which opens a
 * picker rather than confirming anything. Both are satisfied by staging: with
 * nothing staged the confirm opens the file picker, and once files are staged
 * it becomes 「导入 N 个文件」, which is the confirmation. Nothing is imported
 * behind the user's back either way, and the overlay never becomes a form with
 * a life of its own — the case the brief says should have been a Drawer.
 *
 * ## Why a file input and not a native path picker
 *
 * `shared/desktop/client` exposes no directory / file dialog command;
 * `commands.importDemos` takes `File[]` and uploads each through the bridge.
 * So the picker is the platform's own `<input type="file">`, which also makes
 * the drop target real work rather than decoration.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { useRef, useState, type DragEvent } from 'react';

import { Dialog, Alert } from '../../design/feedback';
import { Button, cn } from '../../design/primitives';

/** `.zip` is in the artboard's copy: the service unpacks archives of demos. */
const ACCEPTED_EXTENSIONS = '.dem,.zip';

export interface ImportDemoDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Resolves when the bridge has answered; the dialog closes on success. */
  readonly onImport: (files: readonly File[]) => Promise<unknown>;
  readonly importing: boolean;
  /** A failed import, already turned into a sentence by `data/errors`. */
  readonly error: string | null;
}

export function ImportDemoDialog({
  open,
  onClose,
  onImport,
  importing,
  error,
}: ImportDemoDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<readonly File[]>([]);
  const [dragging, setDragging] = useState(false);

  const close = () => {
    setStaged([]);
    setDragging(false);
    onClose();
  };

  const confirm = () => {
    if (staged.length === 0) {
      inputRef.current?.click();
      return;
    }
    void onImport(staged).then(
      () => {
        close();
      },
      () => {
        // The rejection is already on the mutation; `error` renders it below
        // and the staged files stay put so the user can retry the same set.
      },
    );
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    setStaged([...event.dataTransfer.files]);
  };

  return (
    <Dialog
      open={open}
      title={<Trans>导入 Demo</Trans>}
      onClose={close}
      confirmDisabled={importing}
      confirmLabel={
        staged.length === 0 ? (
          <Trans>选择文件</Trans>
        ) : (
          <Plural value={staged.length} other="导入 # 个文件" />
        )
      }
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        {/* The drop target. `aria-hidden` is wrong here — a keyboard user
            reaches the same capability through the confirm button, and the
            zone itself carries no focusable child, so it is left as plain
            content with the instruction spelled out. */}
        <div
          data-import-dropzone
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={onDrop}
          className={cn(
            'grid min-h-[74px] place-items-center border border-dashed p-4 text-center text-sm',
            dragging ? 'border-accent bg-accent-100 text-accent-800' : 'border-neutral-400 text-neutral-600',
          )}
        >
          {staged.length === 0 ? (
            <Trans>把 .dem 或 .zip 拖到这里</Trans>
          ) : (
            <span className="min-w-0 truncate">
              {staged.map((file) => file.name).join(' · ')}
            </span>
          )}
        </div>

        <p className="text-xs leading-normal text-neutral-600">
          <Trans>校验文件头与大小；同一份内容不会重复入库</Trans>
        </p>

        {staged.length > 0 ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStaged([]);
              }}
            >
              <Trans>重新选择</Trans>
            </Button>
          </div>
        ) : null}

        {error === null ? null : (
          <Alert
            variant="danger"
            action={{ label: <Trans>重试</Trans>, onAction: confirm, disabled: importing }}
          >
            {error}
          </Alert>
        )}

        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS}
          aria-label={t`选择要导入的 Demo 文件`}
          className="sr-only"
          onChange={(event) => {
            setStaged([...(event.target.files ?? [])]);
          }}
        />
      </div>
    </Dialog>
  );
}
