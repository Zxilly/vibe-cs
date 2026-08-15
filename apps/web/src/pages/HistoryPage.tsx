/*
 * pages/ — 比赛历史与 Steam 下载 (spec §7 `/history`, phase 3d).
 *
 * Replaces the pre-redesign `/match-history`; the old address redirects here
 * (`app/router.tsx`).
 */

import { Trans } from '@lingui/react/macro';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';

export function HistoryPage() {
  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>比赛历史</Trans>}
          meta={<Trans>Steam 上的对局记录与回放下载</Trans>}
        />
      }
    >
      <PagePlaceholder
        phase="3d"
        description={
          <Trans>这一页列出账号在 Steam 上的历史对局，下载回放后它会出现在 Demo 资料库里。</Trans>
        }
      />
    </Page>
  );
}
