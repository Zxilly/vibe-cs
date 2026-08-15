/*
 * pages/library — 「列配置」.
 *
 * 「补齐 · 规范与状态」 draws a checkbox list (地图 / 回合数 / 文件大小 / 校验值)
 * over 恢复默认 / 应用.
 *
 * ## Why this is a Dialog and not a Drawer
 *
 * The same artboard's footnote splits the two: 「Dialog 只承载不可逆动作与正式
 * 确认（删除、停止、覆盖）；Drawer 承载详情与非阻断编辑」. Column configuration
 * looks like editing, but the artboard gives it an 应用 button, and that is the
 * distinction that matters: the edit is a **draft** until applied, and applying
 * it is an atomic overwrite of the table's shape. Nothing changes behind the
 * dialog while it is open, so a non-blocking overlay would buy nothing.
 *
 * 恢复默认 does not take the 取消 slot. `Dialog`'s left button is `onClose`, and
 * a control labelled 恢复默认 that actually closed the overlay would be a trap;
 * so it sits inside the body as a ghost button that resets the draft, and 取消
 * keeps its own meaning. This is a deliberate departure from the drawing.
 *
 * ## The list itself
 *
 * `design/data`'s `columnConfigOptions` and `toggleColumn` already model this —
 * the same pure functions `DataTable` reads `hiddenColumns` with — so nothing
 * about visibility is re-derived here. The artboard's 文件大小 and 校验值 are
 * absent for the reason `libraryFormat.ts` records: `normalizeDemo` drops
 * `file_size` and `content_sha256`, so neither column can exist yet.
 */

import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { columnConfigOptions, toggleColumn, type ColumnConfigEntry } from '../../design/data';
import { Dialog } from '../../design/feedback';
import { Button, Checkbox } from '../../design/primitives';

export interface ColumnConfigDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Every column the table can draw, in header order. */
  readonly columns: readonly ColumnConfigEntry[];
  readonly hidden: ReadonlySet<string>;
  readonly onApply: (hidden: ReadonlySet<string>) => void;
}

export function ColumnConfigDialog({
  open,
  onClose,
  columns,
  hidden,
  onApply,
}: ColumnConfigDialogProps) {
  const [draft, setDraft] = useState<ReadonlySet<string>>(hidden);

  // The draft is seeded on every open, not once: a dialog reopened after a
  // cancel must show what the table is doing now, not the abandoned edit.
  useEffect(() => {
    if (open) setDraft(hidden);
  }, [open, hidden]);

  const options = columnConfigOptions(columns, draft);

  return (
    <Dialog
      open={open}
      title={<Trans>列配置</Trans>}
      onClose={onClose}
      // A verb here — Apply. The bare 「应用」 msgid is the settings section
      // 「应用」, a noun (App), so this one is contextualised.
      confirmLabel={<Trans context="dialog-confirm">应用</Trans>}
      onConfirm={() => {
        onApply(draft);
        onClose();
      }}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          {options.map((option) => (
            <Checkbox
              key={option.id}
              size="sm"
              checked={option.visible}
              onChange={() => {
                setDraft(toggleColumn(draft, option.id));
              }}
            >
              {option.label}
            </Checkbox>
          ))}
        </div>
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(new Set<string>());
            }}
          >
            <Trans>恢复默认</Trans>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
