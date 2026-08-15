/*
 * pages/ — an anchor that knows the router.
 *
 * `design/primitives/Link` deliberately takes no router dependency ("a
 * primitive that can only render inside a `<Router>` is not a primitive"), so
 * it accepts a plain `href`. The router is in hash mode (spec §1.1), where the
 * correct href for `/library` is `#/library` — a value no page should be
 * spelling out, because the prefix is the router's business and changes with
 * its mode.
 *
 * `useHref` is react-router's own answer to exactly that, so this is the whole
 * component: resolve the path, hand it to the primitive. Navigation stays a
 * real anchor — middle-click, the status bar and the back button all keep
 * working, which is the reason `Link` refuses to be a button in the first
 * place.
 */

import { useHref } from 'react-router-dom';

import { Link, type LinkProps } from '../design/primitives';

export interface RouteLinkProps extends Omit<LinkProps, 'href' | 'external'> {
  /** A router path with its query attached, e.g. `/delivery?view=tasks`. */
  readonly to: string;
}

export function RouteLink({ to, ...rest }: RouteLinkProps) {
  const href = useHref(to);
  return <Link href={href} {...rest} />;
}
