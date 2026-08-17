/*
 * Design system, layer 1 of 3 — feedback components (spec §2 `design/feedback/`).
 *
 * Alert         persistent in-page message, four variants, one recovery action
 * Dialog        irreversible actions and formal confirmations only
 * Drawer        detail and non-blocking editing
 * StatusDot     the 7/8/9px square status marker
 * StageBar      the task stage bar (启动 · 跳转 · 采集 · 稳定 · 编码 · 发布)
 * ProgressBar   a bar only where there is a real denominator
 */

export { Alert, type AlertAction, type AlertProps, type AlertVariant } from './Alert';
export { Dialog, type DialogProps, type DialogTone } from './Dialog';
export { Drawer, type DrawerProps, type DrawerWidth } from './Drawer';
export { StatusDot, type StatusDotProps, type StatusDotSize, type StatusDotStatus } from './StatusDot';
export {
  RECORDING_STAGE_IDS,
  StageBar,
  recordingStages,
  type RecordingStageId,
  type Stage,
  type StageBarProps,
  type StageState,
} from './StageBar';
export { ProgressBar, type ProgressBarProps, type ProgressBarSize, type ProgressBarTone } from './ProgressBar';
export { OVERLAY_ACTIONS_CLASS, overlayActionClass, type OverlayActionVariant } from './actionButton';
export { useOverlayReturnFocus } from './overlayFocus';
export { Tooltip, TooltipProvider, type TooltipProps } from './Tooltip';
export {
  toast,
  Toaster,
  type ToastAction,
  type ToastOptions,
  type ToastVariant,
} from './Toast';
