import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ChartNoAxesCombined, Clapperboard } from 'lucide-react';
import { useState } from 'react';

import { Dialog } from '../../design/feedback';
import { cn } from '../../design/primitives';
import type { WorkspaceMode } from './navigation';

export interface FirstRunGuideProps {
  open: boolean;
  initialMode: WorkspaceMode;
  onChoose: (mode: WorkspaceMode) => void;
  onDismiss: () => void;
}

const CHOICE_CLASS =
  'flex min-h-32 flex-col items-start gap-2 border p-4 text-left ' +
  'hover:border-accent-400 hover:bg-accent-100';

export function FirstRunGuide({ open, initialMode, onChoose, onDismiss }: FirstRunGuideProps) {
  const [selected, setSelected] = useState<WorkspaceMode>(initialMode);

  return (
    <Dialog
      open={open}
      title={<Trans>先选择一种工作模式</Trans>}
      confirmLabel={
        selected === 'edit' ? <Trans>进入剪辑模式</Trans> : <Trans>进入分析模式</Trans>
      }
      cancelLabel={<Trans>先用当前模式</Trans>}
      onClose={onDismiss}
      onConfirm={() => onChoose(selected)}
      className="w-[var(--w-split)]"
    >
      <div className="flex flex-col gap-4" data-first-run-guide>
        <p>
          <Trans>两种模式使用同一份 Demo、比赛、选手和证据；这里只决定先把哪些工具放在手边。</Trans>
        </p>

        <div className="grid grid-cols-2 gap-3" role="group" aria-label={t`工作模式`}>
          <button
            type="button"
            aria-pressed={selected === 'edit'}
            data-first-run-mode="edit"
            className={cn(
              CHOICE_CLASS,
              selected === 'edit' ? 'border-accent bg-accent-100' : 'border-divider',
            )}
            onClick={() => setSelected('edit')}
          >
            <Clapperboard size={20} strokeWidth={1.5} aria-hidden="true" className="text-accent-700" />
            <strong className="font-heading text-lg"><Trans>剪辑模式</Trans></strong>
            <span className="text-xs leading-normal text-neutral-700">
              <Trans>从素材建立作品，整理剪辑单，录制并交付成品。</Trans>
            </span>
          </button>

          <button
            type="button"
            aria-pressed={selected === 'analysis'}
            data-first-run-mode="analysis"
            className={cn(
              CHOICE_CLASS,
              selected === 'analysis' ? 'border-accent bg-accent-100' : 'border-divider',
            )}
            onClick={() => setSelected('analysis')}
          >
            <ChartNoAxesCombined size={20} strokeWidth={1.5} aria-hidden="true" className="text-accent-700" />
            <strong className="font-heading text-lg"><Trans>分析模式</Trans></strong>
            <span className="text-xs leading-normal text-neutral-700">
              <Trans>查看比赛、回合、玩家、证据、热力图与 2D 回放。</Trans>
            </span>
          </button>
        </div>

        <p className="border-t border-divider pt-3 text-xs text-neutral-600">
          <Trans>之后可随时用窗口左上角的模式按钮切换，不会复制或移动任何数据。</Trans>
        </p>
      </div>
    </Dialog>
  );
}
