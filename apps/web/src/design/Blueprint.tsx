/*
 * Design system, layer 1 of 3 — layout.
 *
 * The system's one frame: a hairline box with square corners, drawn on cards
 * and figures. The frame is a plain bordered box and nothing more — an
 * earlier revision straddled each corner with a `+` registration mark, and on
 * a data-dense screen those marks read as stray rules hanging off the cards
 * and buttons, so the frame is now deliberately quiet.
 *
 * Everything about the framed element is the caller's — the frame wraps
 * content, it does not style it. See `./blueprint.css` for the one rule.
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

/**
 * The gap a *list* of framed cards needs between them — the same major rhythm
 * as a page body's section stack (`gap-5`), so a card grid and the blocks
 * around it share one spacing beat. Exported rather than typed into each
 * list, because it is one of the system's shared rhythms and should move
 * with the others.
 */
export const CARD_LIST_GAP_CLASS = 'gap-5';

export function Blueprint({ children, as = 'div', className, ...rest }: BlueprintProps) {
  const Element = as as ElementType;
  return (
    <Element
      {...rest}
      {...(as === 'button' && rest.type === undefined ? { type: 'button' } : {})}
      className={cn('blueprint', className)}
    >
      {children}
    </Element>
  );
}
