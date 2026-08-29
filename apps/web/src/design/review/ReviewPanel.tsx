import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../cn';

export interface ReviewPanelProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
  readonly emphasis?: 'neutral' | 'focus';
}

/** Shared PR-style surface used by preview, diff, timeline, and Agent review. */
export function ReviewPanel({
  children,
  emphasis = 'neutral',
  className,
  ...props
}: ReviewPanelProps) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-sm border bg-bg',
        emphasis === 'focus'
          ? 'border-accent-500 shadow-[0_0_0_1px_var(--color-accent-200)]'
          : 'border-divider',
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}
