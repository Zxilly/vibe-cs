/*
 * pages/ — 玩家档案与趋势 (spec §7 `/players/:playerId`, phase 3d).
 *
 * A detail route, so the toolbar opens with the reference's back link — 03's
 * 「‹ 资料库」, the same shape one level down. The title bar's crumb already
 * reads 「资料库 › 玩家档案」; this is the way *back*, not a second crumb.
 *
 * The id is rendered rather than resolved to a name: the name is server data
 * (`data/players.ts`, phase 3d), and showing the raw id is honest about what
 * the route currently knows.
 */

import { Trans } from '@lingui/react/macro';
import { useParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';
import { RouteLink } from './RouteLink';

export function PlayerProfilePage() {
  const { playerId = '' } = useParams<{ playerId: string }>();

  return (
    <Page
      toolbar={
        <Toolbar
          leading={
            <RouteLink to="/players">
              <Trans>‹ 玩家目录</Trans>
            </RouteLink>
          }
          title={<Trans>玩家档案</Trans>}
          meta={playerId}
        />
      }
    >
      <PagePlaceholder
        phase="3d"
        description={<Trans>档案页给出这名选手的出场、命中分布与近期趋势，并链接回他出现过的比赛。</Trans>}
      />
    </Page>
  );
}
