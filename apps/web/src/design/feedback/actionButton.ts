/*
 * Design system, layer 1 of 3 — the overlay action button.
 *
 * 「浮层与状态规范」artboard, verbatim:
 *   "破坏性动作的主按钮用砖红，其余一律用钢蓝主按钮，位置固定在右下。"
 *
 * Dialog owns its own footer and uses these classes directly. Drawer takes a
 * `footer` slot (its actions differ per drawer — 标为已处理 / 保存 / 比较), so the
 * classes are exported for callers to reuse rather than hidden inside Dialog:
 * two overlays writing two different steel blues is exactly the debt §2.1 of
 * the spec is closing.
 *
 * Geometry follows Industry's `.btn` (square, hairline border, heading face)
 * with the design reference's 30px raised to the §3.3 floor, `--h-ctl-sm`.
 */

export type OverlayActionVariant = 'primary' | 'secondary' | 'destructive';

const BASE =
  'inline-flex h-[var(--h-ctl-sm)] flex-none items-center justify-center gap-1.5 border px-3 ' +
  'font-heading text-sm leading-tight disabled:cursor-not-allowed disabled:opacity-45';

const VARIANT: Record<OverlayActionVariant, string> = {
  // Industry `.btn-primary`: accent fill, ground-coloured label, accent border.
  primary: 'border-accent bg-accent text-bg hover:bg-accent-600 active:bg-accent-700',
  // Industry `.btn-secondary`: transparent, divider hairline.
  secondary: 'border-divider bg-transparent text-text hover:bg-neutral-200 active:bg-neutral-300',
  // 砖红. `--color-fail` has no tonal ramp, so the hover step reuses
  // `--color-fail-text` — the same colour mixed toward the ink, which darkens
  // in light and lightens in dark, i.e. it moves away from the resting fill in
  // both themes.
  destructive: 'border-fail bg-fail text-bg hover:bg-fail-text active:bg-fail-text',
};

export function overlayActionClass(variant: OverlayActionVariant): string {
  return `${BASE} ${VARIANT[variant]}`;
}

/** The fixed bottom-right action row shared by Dialog and Drawer footers. */
export const OVERLAY_ACTIONS_CLASS = 'flex flex-none items-center justify-end gap-2';
