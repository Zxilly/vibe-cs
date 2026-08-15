/*
 * pages/ — 03 比赛工作区 (spec §7 `/match/:demoId?view=…`, phase 3c).
 *
 * §7 promotes the demo id from a query to a path segment, which is what makes
 * the crumb 「资料库 › Aurora vs Meridian › 概览」 expressible at all — the match
 * is a first-class identity, not a filter on the analysis page. The old
 * `/analysis?demo=…` redirects here (`app/router.tsx`).
 *
 * `?view=` selects one of the nine merged views. This round resolves and names
 * the current one; the 190px view rail (and its ≤1100px fold into top tabs,
 * §8 rule 3) is `design/layout/SubNav` and belongs to phase 3c together with
 * the context bar, so the skeleton deliberately stops at the toolbar rather
 * than half-building a navigation that 3c would have to undo.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';
import { pickQueryValue } from './routeQuery';
import { RouteLink } from './RouteLink';

/** §7's merge table, in the order artboard 03 draws the rail. */
export const MATCH_VIEWS = [
  'overview',
  'rounds',
  'players',
  'duels',
  'utility',
  'replay',
  'highlights',
  'review',
  'teams',
] as const;

export type MatchView = (typeof MATCH_VIEWS)[number];

const VIEW_LABEL: Record<MatchView, ReactNode> = {
  overview: <Trans>概览</Trans>,
  rounds: <Trans>回合</Trans>,
  players: <Trans>玩家</Trans>,
  duels: <Trans>对位</Trans>,
  utility: <Trans>道具与经济</Trans>,
  replay: <Trans>回放与热力图</Trans>,
  highlights: <Trans>高光</Trans>,
  review: <Trans>Review 与注释</Trans>,
  teams: <Trans>阵容</Trans>,
};

export function MatchWorkspacePage() {
  const { demoId = '' } = useParams<{ demoId: string }>();
  const [params] = useSearchParams();
  const view = pickQueryValue(params.get('view'), MATCH_VIEWS, 'overview');

  return (
    <Page
      toolbar={
        <Toolbar
          tone="chrome"
          leading={
            <RouteLink to="/library">
              <Trans>‹ 资料库</Trans>
            </RouteLink>
          }
          title={VIEW_LABEL[view]}
          meta={demoId}
        />
      }
    >
      <PagePlaceholder
        phase="3c"
        description={
          <Trans>
            工作区把一场比赛的回合、选手、对位、道具、回放、高光与 Review 收在同一个地址下，
            右侧 Inspector 统一承载证据详情与「加入视频」。
          </Trans>
        }
      />
    </Page>
  );
}
