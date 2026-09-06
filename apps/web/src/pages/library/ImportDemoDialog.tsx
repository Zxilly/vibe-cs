import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { Dialog, Alert } from '../../design/feedback';
import { Button } from '../../design/primitives';
import { chooseLocalFiles, subscribeLocalFileDrop } from '../../shared/desktop/dialog';
import type { ScanResult } from '../../shared/desktop/dto';

export interface ImportDemoDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onImport: (paths: readonly string[]) => Promise<ScanResult>;
  readonly importing: boolean;
  readonly error: string | null;
}

/** Native paths keep match-sized files out of WebView memory and the IPC body. */
export function ImportDemoDialog({ open, onClose, onImport, importing, error }: ImportDemoDialogProps) {
  const [staged, setStaged] = useState<readonly string[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  useEffect(() => {
    if (!open || importing) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeLocalFileDrop((paths) => {
      setStaged(paths);
      setPickerError(null);
      setResult(null);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {
      if (!disposed) setPickerError(t`无法接收拖入的文件，请使用“选择文件”。`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, [open, importing]);

  const close = () => {
    setStaged([]);
    setPickerError(null);
    setResult(null);
    onClose();
  };

  const choose = async () => {
    try {
      const paths = await chooseLocalFiles({
        title: t`选择要导入的 Demo 文件`,
        filters: [{ name: 'CS2 Demo', extensions: ['dem', 'zip'] }],
      });
      if (paths.length > 0) { setStaged(paths); setResult(null); }
      setPickerError(null);
    } catch {
      setPickerError(t`无法打开文件选择器，请重试。`);
    }
  };

  const confirm = () => {
    if (staged.length === 0) { void choose(); return; }
    setResult(null);
    void onImport(staged).then((outcome) => {
      if (outcome.errors.length > 0) setResult(outcome);
      else close();
    }, () => {
      // Keep the chosen paths for the mutation's in-place retry.
    });
  };

  return (
    <Dialog
      open={open}
      title={<Trans>导入 Demo</Trans>}
      onClose={close}
      confirmDisabled={importing}
      confirmLabel={staged.length === 0
        ? <Trans>选择文件</Trans>
        : <Plural value={staged.length} other="导入 # 个文件" />}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        <div data-import-dropzone className="grid min-h-[74px] place-items-center border border-dashed border-neutral-400 p-4 text-center text-sm text-neutral-600">
          {staged.length === 0 ? <Trans>把 .dem 或 .zip 拖到这里</Trans> : (
            <span className="min-w-0 break-all">{staged.map((path) => path.split(/[\\/]/u).at(-1)).join(' · ')}</span>
          )}
        </div>
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>校验文件头与大小；同一份内容不会重复入库</Trans>
        </p>
        {staged.length > 0 ? (
          <div><Button size="sm" variant="ghost" disabled={importing} onClick={() => { void choose(); }}><Trans>重新选择</Trans></Button></div>
        ) : null}
        {pickerError === null ? null : <Alert variant="danger" action={{ label: <Trans>选择文件</Trans>, onAction: () => { void choose(); } }}>{pickerError}</Alert>}
        {result === null ? null : (
          <Alert variant="warning" action={{ label: <Trans>重新选择</Trans>, onAction: () => { void choose(); } }}>
            <p><Trans>导入未全部完成，成功的文件已保留。</Trans></p>
            <ul className="mt-2 max-h-48 overflow-auto break-all">
              {result.errors.map((message, index) => <li key={index}>{message}</li>)}
            </ul>
          </Alert>
        )}
        {error === null ? null : (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: confirm, disabled: importing }}>{error}</Alert>
        )}
      </div>
    </Dialog>
  );
}
