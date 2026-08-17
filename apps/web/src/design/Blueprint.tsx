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

import type { ElementType, HTMLAttributes, ReactNode } from 'react';

import './blueprint.css';
import { cn } from './cn';

/**
 * The elements a frame is allowed to be. Everything here is a plain box, plus
 * `button` — the library's card view is a card you click, and wrapping it would
 * put a box between the card and the grid cell it sizes to.
 */
export type BlueprintElement =
  | 'div'
  | 'section'
  | 'aside'
  | 'figure'
  | 'article'
  | 'span'
  | 'button';

/**
 * Everything else the framed element carries — `data-*`, `onClick`,
 * `aria-current` — is forwarded. A frame does not get to decide what the thing
 * it frames is allowed to be.
 */
export interface BlueprintProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
  /** The element to render. Default `div`. */
  as?: BlueprintElement | undefined;
  className?: string | undefined;
  /** Only meaningful for `as="button"`, and required there. */
  type?: 'button' | 'submit' | 'reset' | undefined;
  disabled?: boolean | undefined;
}

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;

/**
 * The gap a *list* of framed objects needs between them.
 *
 * The marks straddle the border — `--blueprint-offset` pulls them 6px outside
 * the box on every side — so two framed neighbours need at least 12px of
 * clearance before their marks touch, and a little more before they stop
 * reading as one smudged rule. The lists that hold framed cards were on
 * `gap-2` / `gap-3` / `gap-4` (6.8 / 10.2 / 13.6px against the 3.4px spacing
 * base), all of which collide.
 *
 * `gap-5` is 17px: 12px of marks and 5px of air. Exported rather than typed
 * into each list, because it is a consequence of the frame's geometry and
 * should move with it.
 */
export const BLUEPRINT_LIST_GAP_CLASS = 'gap-5';

/**
 * The four marks on their own, for an element that already *is* the frame.
 *
 * `Blueprint` wraps; a primary button cannot be wrapped without putting a box
 * between it and the flex row it sits in, so it carries `.blueprint` on itself
 * and renders these inside. Same markup contract either way — the kit forbids
 * dropping any of the four, so neither path lets a caller choose three.
 */
export function BlueprintCorners() {
  return (
    <>
      {CORNERS.map((corner) => (
        <i key={corner} aria-hidden="true" className={`corner ${corner}`} />
      ))}
    </>
  );
}

export function Blueprint({ children, as = 'div', className, ...rest }: BlueprintProps) {
  const Element = as as ElementType;
  return (
    <Element
      {...rest}
      {...(as === 'button' && rest.type === undefined ? { type: 'button' } : {})}
      className={cn('blueprint', className)}
    >
      {children}
      <BlueprintCorners />
    </Element>
  );
}
