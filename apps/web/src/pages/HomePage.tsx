/*
 * pages/ — 01 工作台首页 (spec §7 `/`, phase 3g).
 *
 * The reference draws the landing surface as 「今天可以做什么」: recent matches,
 * unfinished tasks and the two entry actions. None of it exists without
 * `data/**`, so this round ships the frame and says so.
 */

import { Trans } from '@lingui/react/macro';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';
import { RouteLink } from './RouteLink';

export function HomePage() {
  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>工作台</Trans>}
          meta={<Trans>最近的比赛、进行中的任务和待确认的方案</Trans>}
        />
      }
    >
      <PagePlaceholder
        phase="3g"
        description={
          <Trans>
            首页汇总最近导入的比赛、正在跑的分析与录制任务，以及 Agent 等你确认的方案。
          </Trans>
        }
        actions={
          <RouteLink to="/library">
            <Trans>打开 Demo 资料库</Trans>
          </RouteLink>
        }
      />
    </Page>
  );
}
