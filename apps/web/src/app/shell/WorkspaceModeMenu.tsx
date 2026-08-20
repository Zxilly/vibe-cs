import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import {
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  Clapperboard,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../design/primitives';
import type { WorkspaceMode } from './navigation';

export interface WorkspaceModeMenuProps {
  mode: WorkspaceMode;
  collapsed: boolean;
  onModeChange?: ((mode: WorkspaceMode) => void) | undefined;
}

const CONTENT_CLASS =
  'z-30 w-[var(--w-nav)] border border-divider bg-bg p-1.5 shadow-[var(--shadow-md)]';

const ITEM_CLASS =
  'grid min-h-[var(--h-row-evidence)] cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 px-3 ' +
  'text-left outline-none data-[highlighted]:bg-accent-100 data-[state=checked]:text-accent-800';

export function WorkspaceModeMenu({ mode, collapsed, onModeChange }: WorkspaceModeMenuProps) {
  const ModeIcon = mode === 'edit' ? Clapperboard : ChartNoAxesCombined;
  const currentModeLabel = mode === 'edit' ? t`剪辑模式` : t`分析模式`;

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger
        type="button"
        aria-label={t`切换工作模式，当前：${currentModeLabel}`}
        data-workspace-mode-trigger
        className={cn(
          'flex h-full w-full items-center gap-2 text-text outline-none hover:bg-neutral-200 ' +
            'data-[state=open]:bg-neutral-200',
          collapsed ? 'justify-center px-1.5' : 'px-4',
        )}
      >
        <ModeIcon size={16} strokeWidth={1.5} aria-hidden="true" className="flex-none text-accent-700" />
        {collapsed ? null : (
          <span className="min-w-0 flex-1 truncate text-left font-heading text-md">
            {currentModeLabel}
          </span>
        )}
        <ChevronDown size={13} strokeWidth={1.5} aria-hidden="true" className="flex-none text-neutral-600" />
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          sideOffset={1}
          aria-label={t`工作模式`}
          data-workspace-mode-menu
          className={CONTENT_CLASS}
        >
          <DropdownMenuPrimitive.Label className="px-3 py-1.5 font-heading text-2xs tracking-caps text-neutral-600">
            <Trans>工作模式</Trans>
          </DropdownMenuPrimitive.Label>
          <DropdownMenuPrimitive.RadioGroup
            value={mode}
            onValueChange={(value) => {
              if (value === 'edit' || value === 'analysis') onModeChange?.(value);
            }}
          >
            <ModeItem
              value="edit"
              icon={Clapperboard}
              title={<Trans>剪辑模式</Trans>}
              description={<Trans>作品、剪辑单、录制与成品</Trans>}
            />
            <ModeItem
              value="analysis"
              icon={ChartNoAxesCombined}
              title={<Trans>分析模式</Trans>}
              description={<Trans>比赛、玩家、证据与回放</Trans>}
            />
          </DropdownMenuPrimitive.RadioGroup>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function ModeItem({
  value,
  icon: Icon,
  title,
  description,
}: {
  value: WorkspaceMode;
  icon: LucideIcon;
  title: ReactNode;
  description: ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.RadioItem value={value} className={ITEM_CLASS}>
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="text-accent-700" />
      <span className="flex min-w-0 flex-col">
        <span className="font-heading text-sm">{title}</span>
        <span className="truncate text-2xs text-neutral-600">{description}</span>
      </span>
      <DropdownMenuPrimitive.ItemIndicator>
        <Check size={14} strokeWidth={1.5} aria-hidden="true" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  );
}
