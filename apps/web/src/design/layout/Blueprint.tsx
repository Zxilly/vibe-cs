/*
 * Design system, layer 1 of 3 — layout.
 *
 * Industry's registration frame: a hairline box with a `+` mark straddling
 * each of its four corners. The kit's readme names the markup contract
 * exactly — 「the `.blueprint` class + four `<i class="corner tl/tr/bl/br">`
 * children」 — and forbids dropping any of the marks, so the four `<i>`s are
 * produced by this component instead of being left to each call site.
 *
 * The marks are decoration in the strictest sense: they carry no information a
 * reader could act on, so they are `aria-hidden`. Everything else about the
 * element is the caller's — the frame wraps content, it does not style it.
 *
 * See `./blueprint.css` for the geometry and why it is ported rather than
 * imported.
 */

import type { ElementType, ReactNode } from 'react';

import './blueprint.css';
import { cn } from '../cn';

/** The elements a frame is allowed to be. Everything here is a plain box. */
export type BlueprintElement = 'div' | 'section' | 'aside' | 'figure' | 'article' | 'span';

export interface BlueprintProps {
  children?: ReactNode;
  /** The element to render. Default `div`. */
  as?: BlueprintElement | undefined;
  className?: string | undefined;
  /** Accessible name, when the frame is also a labelled region. */
  'aria-label'?: string | undefined;
  'aria-labelledby'?: string | undefined;
  'data-testid'?: string | undefined;
}

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;

export function Blueprint({
  children,
  as = 'div',
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': testId,
}: BlueprintProps) {
  const Element = as as ElementType;
  return (
    <Element
      className={cn('blueprint', className)}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      data-testid={testId}
    >
      {children}
      {CORNERS.map((corner) => (
        <i key={corner} aria-hidden="true" className={`corner ${corner}`} />
      ))}
    </Element>
  );
}
