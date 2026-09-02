import { t } from '@lingui/core/macro';
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  Gauge,
  Hand,
  MousePointer2,
  MoveHorizontal,
  MoveLeft,
  MoveRight,
  Scissors,
  ZoomIn,
} from 'lucide-react';

import { Tooltip } from '../../design/feedback';
import { cn } from '../../design/primitives';

export type TimelineEditTool =
  | 'selection'
  | 'track_forward'
  | 'track_backward'
  | 'ripple'
  | 'razor'
  | 'slip'
  | 'rolling'
  | 'rate'
  | 'slide'
  | 'hand'
  | 'zoom';

export function TimelineToolStrip({
  editTool,
  canRippleTool,
  canSlipTool,
  canRollTool,
  canRateTool,
  canSlideTool,
  onChangeTool,
}: {
  readonly editTool: TimelineEditTool;
  readonly canRippleTool: boolean;
  readonly canSlipTool: boolean;
  readonly canRollTool: boolean;
  readonly canRateTool: boolean;
  readonly canSlideTool: boolean;
  readonly onChangeTool: (tool: TimelineEditTool) => void;
}) {
  const tools = [
    {
      label: t`选择工具 (V)`,
      description: t`选择、移动和裁切时间轴片段`,
      unavailable: '',
      icon: <MousePointer2 className="size-4" aria-hidden="true" />,
      enabled: true,
      pressed: editTool === 'selection',
      action: () => onChangeTool('selection'),
    },
    {
      label: t`手形工具 (H)`,
      description: t`拖动时间轴画布，不改变播放头或片段`,
      unavailable: '',
      icon: <Hand className="size-4" aria-hidden="true" />,
      enabled: true,
      pressed: editTool === 'hand',
      action: () => onChangeTool('hand'),
    },
    {
      label: t`缩放工具 (Z)`,
      description: t`点击放大，Alt 点击缩小；以点击位置为锚点`,
      unavailable: '',
      icon: <ZoomIn className="size-4" aria-hidden="true" />,
      enabled: true,
      pressed: editTool === 'zoom',
      action: () => onChangeTool('zoom'),
    },
    {
      label: t`向前选择轨道工具 (A)`,
      description: t`选择点击位置及其右侧的片段；按 Shift 跨所有轨道`,
      unavailable: '',
      icon: <MoveRight className="size-4" aria-hidden="true" />,
      enabled: true,
      pressed: editTool === 'track_forward',
      action: () => onChangeTool('track_forward'),
    },
    {
      label: t`向后选择轨道工具 (Shift+A)`,
      description: t`选择点击位置及其左侧的片段；按 Shift 跨所有轨道`,
      unavailable: '',
      icon: <MoveLeft className="size-4" aria-hidden="true" />,
      enabled: true,
      pressed: editTool === 'track_backward',
      action: () => onChangeTool('track_backward'),
    },
    {
      label: t`波纹编辑工具 (B)`,
      description: t`拖动片段边缘并实时移动后续片段；保留自由轨已有间隙`,
      unavailable: t`没有可波纹裁切的未锁定片段`,
      icon: <MoveRight className="size-4" aria-hidden="true" />,
      enabled: canRippleTool,
      pressed: editTool === 'ripple',
      action: () => onChangeTool('ripple'),
    },
    {
      label: t`剃刀工具 (C)`,
      description: t`点击切开片段；按 Shift 切开所有轨道，按 Alt 仅切开当前声道`,
      unavailable: '',
      icon: <Scissors className="size-4" aria-hidden="true" />,
      enabled: true,
      pressed: editTool === 'razor',
      action: () => onChangeTool('razor'),
    },
    {
      label: t`滑移工具 (Y)`,
      description: t`更换片段的源入点和源出点，不改变时间轴位置与时长`,
      unavailable: t`没有可滑移的未锁定媒体片段`,
      icon: <MoveHorizontal className="size-4" aria-hidden="true" />,
      enabled: canSlipTool,
      pressed: editTool === 'slip',
      action: () => onChangeTool('slip'),
    },
    {
      label: t`滚动编辑工具 (N)`,
      description: t`移动相邻片段的剪辑点，不改变两个片段的总时长`,
      unavailable: t`没有可滚动编辑的未锁定相邻片段`,
      icon: <BetweenHorizontalEnd className="size-4" aria-hidden="true" />,
      enabled: canRollTool,
      pressed: editTool === 'rolling',
      action: () => onChangeTool('rolling'),
    },
    {
      label: t`比率伸缩工具 (R)`,
      description: t`拖动片段终点改变播放速度和时长`,
      unavailable: t`没有可比率伸缩的未锁定媒体片段`,
      icon: <Gauge className="size-4" aria-hidden="true" />,
      enabled: canRateTool,
      pressed: editTool === 'rate',
      action: () => onChangeTool('rate'),
    },
    {
      label: t`滑动工具 (U)`,
      description: t`移动中间片段并同时裁切相邻片段，不改变它的时长`,
      unavailable: t`没有具备可编辑相邻片段的未锁定 Story 片段`,
      icon: <BetweenHorizontalStart className="size-4" aria-hidden="true" />,
      enabled: canSlideTool,
      pressed: editTool === 'slide',
      action: () => onChangeTool('slide'),
    },
  ] as const;
  return (
    <aside className="absolute bottom-10 left-0 top-[var(--h-panel-head)] z-50 flex w-10 flex-col items-center gap-1 border-r border-divider bg-bg pt-1" aria-label={t`时间轴工具`}>
      {tools.map((tool) => {
        const explanation = tool.enabled ? tool.description : tool.unavailable;
        return (
          <Tooltip
            key={tool.label}
            content={`${tool.label} — ${explanation}`}
            side="right"
            wrap
            wrapFocusable={!tool.enabled}
            wrapClassName="flex-none"
          >
            <button
              type="button"
              className={cn(
                'grid size-8 place-items-center rounded-sm text-neutral-600 hover:bg-neutral-100 hover:text-text disabled:text-neutral-300',
                tool.pressed && 'bg-accent-100 text-accent-text',
              )}
              aria-label={tool.label}
              aria-pressed={tool.pressed}
              disabled={!tool.enabled}
              onClick={tool.action}
            >
              {tool.icon}
            </button>
          </Tooltip>
        );
      })}
    </aside>
  );
}


