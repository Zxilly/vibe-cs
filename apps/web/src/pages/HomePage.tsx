/*
 * pages/ — 01 工作台首页 (spec §7 `/`).
 *
 * §10 schedules this page for phase 3g. Two of its five blocks are task and
 * output surfaces, and phase 3a owns both data files — so those two are built
 * here now and the rest are named, not approximated:
 *
 *   待确认方案        phase 3e. It is an Agent proposal (§4.5) with a model that
 *                     is still being settled with the backend; `data/plans.ts`
 *                     does not exist yet and inventing a card for it would mean
 *                     inventing the shape it reads.
 *   最近比赛          phase 3b/3d. `data/demos.ts` exists, but the table, its
 *                     status column and its 「下一步」 action are the library's
 *                     own contract and belong with the page that defines them.
 *   进行中的工程      phase 3f, with the editor and montage projects.
 *   环境提示          the shell already owns service state
 *                     (`app/boundary/ServiceGate`); 「环境问题只在阻塞相应任务时
 *                     出现」 is a rule about *task* blocking that phase 3g should
 *                     wire to the same gate rather than a second probe here.
 *
 * The placeholders are `EmptyState`s naming their phase — the same convention
 * the phase-1 route stubs used for a whole page — so the workbench is honest at
 * every width instead of looking finished with two blocks missing.
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
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { EmptyState } from '../design/data';
import { Page, SplitPane, Toolbar, useShellCollapsed } from '../design/layout';
import { Button } from '../design/primitives';
import { useServiceAction } from '../data/serviceAction';
import { HomeFailureNotice } from './home/HomeFailureNotice';
import { HomeTasksPanel } from './home/HomeTasksPanel';
import { RecentOutputsPanel } from './home/RecentOutputsPanel';

export function HomePage() {
  const collapsed = useShellCollapsed();
  const service = useServiceAction();
  const navigate = useNavigate();

  const tasks = (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
      <PhaseBlock
        phase="3e"
        title={<Trans>待确认的方案</Trans>}
        description={<Trans>Agent 完成选材与镜头设计后，方案会出现在最上面，等你审阅。</Trans>}
      />

      <HomeTasksPanel service={service} />
      <HomeFailureNotice service={service} />

      <PhaseBlock
        phase="3b"
        title={<Trans>最近比赛</Trans>}
        description={<Trans>最近导入的比赛、它们的分析状态，以及每一场的下一步。</Trans>}
      />
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
        <SplitPane asideLabel={t`最近输出`} asideWidth="inspector-wide" aside={outputs}>
          {tasks}
        </SplitPane>
      )}
    </Page>
  );
}

/**
 * A block that is not built yet, saying which phase builds it. `EmptyState`
 * requires a recovery action; there is none here — the block is not broken, it
 * is scheduled — so the slot is filled with nothing rather than with a button
 * that would go somewhere unrelated. `domain/task/TaskDetail` does the same for
 * its empty log.
 */
function PhaseBlock({
  phase,
  title,
  description,
}: {
  readonly phase: string;
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <EmptyState
      title={title}
      description={
        <>
          {description} <Trans>这一块在阶段 {phase} 接入。</Trans>
        </>
      }
      actions={null}
      headingLevel={3}
    />
  );
}
