/*
 * pages/ — 06 玩家目录 (spec §7 `/players`, phase 3d).
 */

import { Trans } from '@lingui/react/macro';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';

export function PlayersPage() {
  return (
    <Page
      toolbar={<Toolbar title={<Trans>玩家目录</Trans>} meta={<Trans>出现在已分析比赛里的选手</Trans>} />}
    >
      <PagePlaceholder
        phase="3d"
        description={<Trans>目录按出场数与近期表现排序，点进一名选手可以看他的档案与趋势。</Trans>}
      />
    </Page>
  );
}
