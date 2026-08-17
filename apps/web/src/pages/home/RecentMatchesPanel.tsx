/*
 * pages/home — 最近比赛.
 *
 * The board draws a four-column table (比赛 · 地图 · 日期 · 状态) with a
 * 「下一步」 action per row, and the action differs by status: an analysed Demo
 * opens its workspace, an unanalysed one starts an analysis.
 *
 * ── 「下一步」 is a link, and only a link ─────────────────────────────────
 *
 * The board's second action reads 「开始分析」, which sounds like a button that
 * starts one. It is not offered here, for a reason that is about this page
 * rather than about the route: starting an analysis is minutes of work on a
 * file the user has not opened, launched from a summary row with no space to
 * say what it will do. 「02 Demo 资料库」 is where that action belongs and it
 * has it, with the row selected and the state visible.
 *
 * So both statuses link, and the destination differs: analysed → the match
 * workspace, not-yet → the library row that can start it. The label says which.
 *
 * ── Status comes from the view model, not from the lifecycle ─────────────
 *
 * `DemoSummary.status` is the four-way display status `data/demos.ts` already
 * derives (`pending` / `parsing` / `ready` / `error`); `lifecycle_status` is
 * the raw wire value beside it. Reading the raw one here would be a second
 * derivation of the same fact, and the two would diverge the first time the
 * backend added a state.
 */

import { Trans } from '@lingui/react/macro';

import { Skeleton } from '../../design/data';
import { Alert, StatusDot, type StatusDotStatus } from '../../design/feedback';
import { useDemoList } from '../../data/demos';
import { dataErrorMessage } from '../../data/errors';
import type { DemoSummary } from '../../shared/desktop/viewModels';
import { RouteLink } from '../RouteLink';

const SHOWN = 3;

export function RecentMatchesPanel() {
  const demos = useDemoList({ page: 1, page_size: SHOWN });
  const error = dataErrorMessage(demos.error);
  const items = demos.data?.items ?? [];

  return (
    <section className="flex flex-col gap-3" data-home-block="matches">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium">
          <Trans>最近比赛</Trans>
        </h2>
        <RouteLink to="/library">
          <Trans>Demo 资料库</Trans>
        </RouteLink>
      </div>

      {error !== null ? (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void demos.refetch() }}>
          <Trans>读不到最近的比赛：{error}</Trans>
        </Alert>
      ) : demos.isPending ? (
        <div className="flex flex-col gap-2.5">
          <Skeleton />
          <Skeleton width="80%" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>资料库里还没有比赛。导入 Demo 之后它们会出现在这里。</Trans>
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((demo) => (
            <MatchRow key={demo.id} demo={demo} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MatchRow({ demo }: { readonly demo: DemoSummary }) {
  const analysed = demo.status === 'ready';
  return (
    <li className="flex items-center justify-between gap-3 text-sm" data-demo={demo.id}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <StatusDot status={statusDot(demo.status)} />
        <span className="truncate">{demo.display_name}</span>
        <span className="flex-none text-xs text-neutral-600">{demo.map_name}</span>
        <span className="flex-none font-mono text-2xs text-neutral-600">
          {demo.match_date === null ? '—' : demo.match_date.slice(5, 10)}
        </span>
      </div>
      <RouteLink
        to={analysed ? `/match/${encodeURIComponent(demo.id)}` : `/library?demo=${encodeURIComponent(demo.id)}`}
        className="flex-none"
      >
        {analysed ? <Trans>打开工作区</Trans> : <Trans>去资料库分析</Trans>}
      </RouteLink>
    </li>
  );
}

/**
 * `error` is `fail`, `ready` is `ok`, and the two in-flight states are `warn`
 * rather than `running`: `running` is the animated dot, and three animated
 * dots on a workbench that is otherwise still would read as the page being
 * busy rather than as three files being processed.
 */
function statusDot(status: DemoSummary['status']): StatusDotStatus {
  switch (status) {
    case 'ready':
      return 'ok';
    case 'error':
      return 'fail';
    case 'parsing':
    case 'pending':
      return 'warn';
  }
}
