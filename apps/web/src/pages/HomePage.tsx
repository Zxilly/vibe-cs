/*
 * pages/ — 01 工作台首页 (spec §7 `/`).
 *
 * All five blocks are built as of phase 3g. Each one was waiting on the data
 * file that defines its shape, and the order they arrived in is why this page
 * grew in three rounds:
 *
 *   任务 / 失败       phase 3a, with `data/tasks.ts`
 *   最近输出          phase 3a, with `data/outputs.ts`
 *   待确认方案        phase 3e, with `data/plans.ts`
 *   最近比赛          phase 3b, with `data/demos.ts`
 *   进行中的工程      phase 3f, with the editor and montage projects
 *   环境提示          phase 3g, and it is *not* the service gate — see
 *                     `home/EnvironmentNotice`
 *
 * ── The board's own instruction, and what it rules out ───────────────────
 *
 * 「从『功能入口集合』改为『今日需要处理的工作』：待确认方案在最上，环境问题只在
 * 阻塞时出现。」 Two rules, both structural:
 *
 *   · the order is by *what is waiting on the user*, not by subsystem. Plans
 *     first, then what is running, then what broke, then what to look at.
 *   · a block with nothing in it says so in one line rather than filling its
 *     slot with an empty state. An empty queue is the good outcome on a
 *     workbench, and a full-height 「还没有…」 box for each of five blocks
 *     would make a healthy day look like a broken one.
 *
 * ── Layout ────────────────────────────────────────────────────────────────
 *
 * 最近输出 is a 440px rail (`--w-inspector-wide`, exactly what the artboard
 * draws) beside the task column, and it stacks under the column once the shell
 * folds at 1100px — §8 rule 2 for a rail that is not an Inspector: the artboard
 * has no room for a second column at the fold, and 476px would not be a card.
 */

import { Trans } from '@lingui/react/macro';
import { useNavigate } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { Button } from '../design/primitives';
import { useServiceAction } from '../data/serviceAction';
import { ActiveProjectsPanel } from './home/ActiveProjectsPanel';
import { EnvironmentNotice } from './home/EnvironmentNotice';
import { FirstRunStrip } from './home/FirstRunStrip';
import { HomeFailureNotice } from './home/HomeFailureNotice';
import { PendingPlansPanel } from './home/PendingPlansPanel';
import { RouteLink } from './RouteLink';

export function HomePage() {
  const service = useServiceAction();
  const navigate = useNavigate();

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>工作台</Trans>}
          meta={<Trans>处理待办，继续作品，或者开始新的作品</Trans>}
          primary={
            <Button variant="primary" size="md" onClick={() => void navigate('/projects/new?step=shotlist')}>
              <Trans>新建作品</Trans>
            </Button>
          }
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-7" data-home-layout="three-sections">
        <section className="flex flex-col gap-3" data-home-block="needs-attention">
          <h2 className="border-l-2 border-accent pl-2 text-lg font-medium"><Trans>需要我处理</Trans></h2>
          <EnvironmentNotice />
          <PendingPlansPanel />
          <HomeFailureNotice service={service} />
        </section>

        <section className="flex flex-col gap-3 border-t border-divider pt-5" data-home-block="continue">
          <h2 className="border-l-2 border-accent pl-2 text-lg font-medium"><Trans>继续</Trans></h2>
          <ActiveProjectsPanel />
        </section>

        <section className="flex flex-col gap-3 border-t border-divider pt-5" data-home-block="new">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="border-l-2 border-accent pl-2 text-lg font-medium"><Trans>新建</Trans></h2>
            <span className="flex-1" />
            <Button variant="primary" size="md" onClick={() => void navigate('/projects/new?step=shotlist')}>
              <Trans>新建作品</Trans>
            </Button>
            <RouteLink to="/library" size="sm"><Trans>导入 Demo</Trans></RouteLink>
          </div>
          <FirstRunStrip />
        </section>
      </div>
    </Page>
  );
}
