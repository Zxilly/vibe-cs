/*
 * Design system, layer 1 of 3 — layout / Breadcrumb.
 *
 * shadcn's Breadcrumb: a `<nav>` around an ordered list, one item per segment,
 * the last one marked `aria-current="page"` and not a link.
 *
 * ── Why this replaced a joined string ─────────────────────────────────────
 *
 * The title bar used to render the crumb as `segments.join(' › ')` inside a
 * single truncating span. That is the artboard's picture of it, and it reads
 * correctly — but it is a picture: the separator is text, so a screen reader
 * says 「资料库 › 比赛工作区」 as one run with a chevron in the middle of it, and
 * there is nothing to click. A crumb whose whole job is to say where you are
 * in a hierarchy should let you go up it.
 *
 * So: a real list, the separator `aria-hidden` (it is punctuation, not
 * content), and the segments that *have* a destination are links.
 *
 * ── Not every segment has one ─────────────────────────────────────────────
 *
 * The head of most crumbs is a rail **group** — 「资料库」, 「制作」 — and a
 * group is a heading in the nav, not a route. Rendering it as a dead link
 * would be worse than rendering it as text, so `BreadcrumbLink` is used only
 * where there is somewhere to go and `BreadcrumbText` carries the rest.
 *
 * `asChild` rather than shadcn's newer `render` prop: that spelling comes from
 * Base UI, and this design layer is on Radix, where the same idea is `asChild`
 * — which is what `Button` and `Badge` here already take.
 */

import { Slot as SlotPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cn } from '../cn';

export type BreadcrumbProps = ComponentPropsWithoutRef<'nav'>;

export function Breadcrumb({ className, ...rest }: BreadcrumbProps) {
  return <nav {...rest} aria-label={rest['aria-label']} className={cn('min-w-0', className)} />;
}

export type BreadcrumbListProps = ComponentPropsWithoutRef<'ol'>;

export function BreadcrumbList({ className, ...rest }: BreadcrumbListProps) {
  return (
    <ol
      {...rest}
      className={cn('m-0 flex min-w-0 list-none items-center gap-1.5 p-0 text-sm', className)}
    />
  );
}

export type BreadcrumbItemProps = ComponentPropsWithoutRef<'li'>;

export function BreadcrumbItem({ className, ...rest }: BreadcrumbItemProps) {
  return <li {...rest} className={cn('flex min-w-0 items-center', className)} />;
}

export interface BreadcrumbLinkProps extends ComponentPropsWithoutRef<'a'> {
  /** Render the child element — a router `Link` — instead of an `<a>`. */
  asChild?: boolean;
}

/** A segment you can go back to. */
export function BreadcrumbLink({ asChild = false, className, ...rest }: BreadcrumbLinkProps) {
  const Root = asChild ? SlotPrimitive.Root : 'a';
  return (
    <Root
      {...rest}
      className={cn(
        'min-w-0 truncate text-neutral-700 no-underline hover:text-text hover:underline',
        className,
      )}
    />
  );
}

export type BreadcrumbTextProps = ComponentPropsWithoutRef<'span'>;

/** A segment with nowhere to go — a nav group heading. */
export function BreadcrumbText({ className, ...rest }: BreadcrumbTextProps) {
  return <span {...rest} className={cn('min-w-0 truncate text-neutral-700', className)} />;
}

export type BreadcrumbPageProps = ComponentPropsWithoutRef<'span'>;

/** Where you are. Never a link — it would navigate to the page you are on. */
export function BreadcrumbPage({ className, ...rest }: BreadcrumbPageProps) {
  return (
    <span
      {...rest}
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn('min-w-0 truncate text-text', className)}
    />
  );
}

export interface BreadcrumbSeparatorProps extends ComponentPropsWithoutRef<'li'> {
  children?: ReactNode;
}

/**
 * The reference's 「›」. `aria-hidden` and `role="presentation"`: it is
 * punctuation between two names, and read aloud it is noise.
 */
export function BreadcrumbSeparator({ className, children, ...rest }: BreadcrumbSeparatorProps) {
  return (
    <li
      {...rest}
      role="presentation"
      aria-hidden="true"
      className={cn('flex-none text-neutral-600', className)}
    >
      {children ?? '›'}
    </li>
  );
}
