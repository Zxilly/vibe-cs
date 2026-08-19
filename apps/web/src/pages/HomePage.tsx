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

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useNavigate } from 'react-router-dom';

import { Page, SplitPane, Toolbar, useShellCollapsed } from '../design/layout';
import { Button } from '../design/primitives';
import { useServiceAction } from '../data/serviceAction';
import { ActiveProjectsPanel } from './home/ActiveProjectsPanel';
import { EnvironmentNotice } from './home/EnvironmentNotice';
import { FirstRunStrip } from './home/FirstRunStrip';
import { HomeFailureNotice } from './home/HomeFailureNotice';
import { PendingPlansPanel } from './home/PendingPlansPanel';
import { RecentMatchesPanel } from './home/RecentMatchesPanel';
import { HomeTasksPanel } from './home/HomeTasksPanel';
import { RecentOutputsPanel } from './home/RecentOutputsPanel';

export function HomePage() {
  const collapsed = useShellCollapsed();
  const service = useServiceAction();
  const navigate = useNavigate();

  const tasks = (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
      {/* Only when something is actually blocked, and above everything else
          when it is: a broken capture environment makes the blocks below it
          unactionable. */}
      <EnvironmentNotice />

      {/* Only while the library is empty — see `home/FirstRunStrip`. */}
      <FirstRunStrip />

      <PendingPlansPanel />

      <HomeTasksPanel service={service} />
      <HomeFailureNotice service={service} />

      <RecentMatchesPanel />
      <ActiveProjectsPanel />
    </div>
  );

  const outputs = <RecentOutputsPanel service={service} />;

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>今日工作</Trans>}
          meta={<Trans>进行中的任务、失败可恢复的任务和最近的成片</Trans>}
          primary={
            <Button variant="primary" size="md" onClick={() => void navigate('/agent')}>
              <Trans>用 Agent 制作视频</Trans>
            </Button>
          }
        />
      }
    >
      {collapsed ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {tasks}
          <div className="flex flex-col border-t border-divider">{outputs}</div>
        </div>
      ) : (
        <SplitPane
          asideLabel={t`最近成品文件`}
          asideWidth="inspector-wide"
          storageId="home-outputs"
          aside={outputs}
        >
          {tasks}
        </SplitPane>
      )}
    </Page>
  );
}
