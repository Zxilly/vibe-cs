import { buttonVariants } from '../primitives/Button';

export type OverlayActionVariant = 'primary' | 'secondary' | 'destructive';

/** Dialog and Drawer use the same Button state and geometry authority. */
export function overlayActionClass(variant: OverlayActionVariant): string {
  return buttonVariants({ variant: variant === 'destructive' ? 'danger' : variant, size: 'sm' });
}

/** The fixed bottom-right action row shared by Dialog and Drawer footers. */
export const OVERLAY_ACTIONS_CLASS = 'flex flex-none items-center justify-end gap-2';
