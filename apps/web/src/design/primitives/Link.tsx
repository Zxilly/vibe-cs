/**
 * Design system, layer 1 of 3 — Link.
 *
 * The design reference writes 129 anchors, in exactly two sizes: 13px (「查看
 * 全部」「打开所在文件夹」, 27 occurrences) and 12px (metadata lines, 22
 * occurrences). Nothing else about them is overridden, so colour, underline
 * offset and the focus ring all come from base.css's bare `a` rule.
 *
 * A Link navigates. An action that merely looks like a link is
 * `<Button variant="ghost">` — Industry's `.btn-ghost` is that treatment, and
 * routing a click through an `<a href="#">` would break middle-click, the
 * status bar and the back button.
 *
 * The design layer takes no dependency on the router (spec §2.1 rule 1 is
 * about layers, but a primitive that can only render inside a `<Router>` is
 * not a primitive). `href` is a plain string; the shell passes what it needs.
 */

import type { AnchorHTMLAttributes, ReactNode, Ref } from 'react';

import { cn } from '../cn';

export type LinkSize = 'xs' | 'sm' | 'base';

export interface LinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children' | 'target' | 'rel'> {
  size?: LinkSize;
  /**
   * Leaves the app — opens in a new context and gets `rel="noreferrer
   * noopener"`. Reverse tabnabbing is not a hypothetical in a Tauri webview.
   */
  external?: boolean;
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLAnchorElement>;
}

const SIZE_CLASS: Readonly<Record<LinkSize, string>> = {
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
};

/**
 * Colour and underline offset are base.css's. Only the hover emphasis is
 * added here: the reference's links are underlined at rest, so hover has to
 * change something else.
 */
const BASE_CLASS = 'leading-normal underline decoration-1 hover:decoration-2';

export function Link({ size = 'sm', external = false, className, children, ref, ...rest }: LinkProps) {
  return (
    <a
      {...rest}
      ref={ref}
      {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      className={cn(BASE_CLASS, SIZE_CLASS[size], className)}
    >
      {children}
    </a>
  );
}
