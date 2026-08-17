/*
 * App shell — the title bar's crumb, rendered.
 *
 * `routeCrumb` decides *what* the rungs are; this decides how they are drawn
 * and which of them are links. It lives in `app/shell` rather than in the
 * design layer because it needs the router and the catalogue, and the design
 * layer may have neither (spec §2.1 rule 1).
 *
 * Truncation is per segment, not on the whole trail. A single truncating box
 * around 「资料库 › Demo 资料库 › 比赛工作区」 cuts the *last* segment off first
 * — the one that says where you are — and leaves the two you already knew. Each
 * rung truncates on its own, so the leaf keeps as much room as it needs and the
 * head gives way first.
 */

import { useLingui } from '@lingui/react';
import { t } from '@lingui/core/macro';
import { Fragment } from 'react';
import { Link } from 'react-router-dom';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbText,
} from '../../design/layout';
import type { CrumbSegment } from '../routeCrumb';

export interface RouteBreadcrumbProps {
  readonly segments: readonly CrumbSegment[];
}

export function RouteBreadcrumb({ segments }: RouteBreadcrumbProps) {
  const { i18n } = useLingui();

  // A location outside the route table has no place in the hierarchy, and the
  // page it lands on already says so.
  if (segments.length === 0) return null;

  return (
    <Breadcrumb aria-label={t`位置`} data-titlebar-crumb="">
      <BreadcrumbList>
        {segments.map((segment, index) => {
          const label = i18n._(segment.label);
          const last = index === segments.length - 1;
          return (
            /* The separator is a sibling `<li>`, not a child of one: an `<li>`
               inside an `<li>` is not a list. */
            <Fragment key={`${label}-${String(index)}`}>
              {index === 0 ? null : <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {last ? (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
                ) : segment.to === undefined ? (
                  <BreadcrumbText>{label}</BreadcrumbText>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={segment.to}>{label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
