/*
 * pages/ — 比赛历史与 Steam 下载 (spec §7 `/history`, phase 3d).
 *
 * Replaces the pre-redesign `/match-history`; the old address redirects here
 * (`app/router.tsx`).
 *
 * ── The artboard ───────────────────────────────────────────────────────────
 *
 * 「补齐 · 暗色与其余页面」 draws it as a 944 × 560 panel: a 48px head
 * (「比赛历史 · Steam · 上次同步 08-15 08:40」, then 「Steam 设置」 and
 * 「同步最近比赛」), a 42px filter strip carrying four state counts and the note
 * 「Valve 官方链路。FACEIT 等平台连接器尚未提供」, the table, and an accent-100
 * selection bar with 「下载后自动分析」 and 「下载选中的 2 场」. Promoted to a route,
 * the head becomes the `Toolbar` and the strip becomes `Page`'s `bar` slot.
 *
 * ── The read ───────────────────────────────────────────────────────────────
 *
 * `data/history.ts` (`useMatchHistory` / `useActiveMatchDownloads`) and the
 * `history` namespace in `data/keys.ts`. Both were missing when this page was
 * first built, which is why it shipped with a hard-coded empty list; the seam
 * exists now and the page reads the service like every other §7 page.
 *
 * Two things the page still says rather than draws:
 *
 *   · 「下载后自动分析」 is disabled — `commands.downloadMatchDemo` takes a match
 *     id and nothing else, so the checkbox has no wire field to set. Reported
 *     as a contract gap; disabled with the reason attached beats a toggle that
 *     silently does nothing (§8).
 *   · the state counts are labelled 本页. The service pages the list, so a
 *     count over the rows on screen is a count of the page — printing it as a
 *     corpus total is precisely the silent-truncation bug §10.3 rules out. The
 *     corpus total is the server's own, printed beside it and in the footer.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { dataErrorMessage } from '../data/errors';
import {
  invalidateAfterMatchDownload,
  useActiveMatchDownloads,
  useCancelMatchDownload,
  useDownloadMatchDemo,
  useMatchHistory,
  useSyncMatchHistory,
} from '../data/history';
import { Empty, Pagination, TableSkeleton } from '../design/data';
import { Alert } from '../design/feedback';
import { Page, SelectionBar, Toolbar } from '../design/layout';
import { Button, Badge } from '../design/primitives';
import type { MatchHistoryItem } from '../shared/desktop/dto';
import { RouteLink } from './RouteLink';
import { useServiceAction } from '../data/serviceAction';
import { MatchHistoryTable } from './history/MatchHistoryTable';
import { DEMO_RETENTION_DAYS, matchHistoryCounts } from './history/matchHistoryRows';
import { formatSyncedAt, latestSyncedAt } from './history/matchHistorySync';

/** 42px rows, and the artboard's panel shows about a dozen at a time. */
const HISTORY_PAGE_SIZE = 50;

/** How often the active downloads are re-read while any is in flight. Only the
 *  job list moves at this cadence — the match table is left alone until a job
 *  actually finishes, which is what `invalidateAfterMatchDownload` is for. */
const DOWNLOAD_POLL_MS = 2_000;

export function HistoryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const service = useServiceAction();

  /* Selection is genuinely page-local: it is a staging area for one download
     batch, not an address anybody would share. Compare `/players`, where the
     compared pair *is* shareable and therefore lives in the URL. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState(1);

  const history = useMatchHistory({ page, page_size: HISTORY_PAGE_SIZE });
  const rows: readonly MatchHistoryItem[] = history.data?.items ?? [];
  const total = history.data?.total ?? 0;

  /* The job list is polled while anything is in flight and left alone
     otherwise; the match table is never on this cadence. */
  const downloads = useActiveMatchDownloads({ pollWhileActiveMs: DOWNLOAD_POLL_MS });
  const active = downloads.data ?? [];
  const activeCount = active.length;

  const sync = useSyncMatchHistory();
  const download = useDownloadMatchDemo();
  const cancel = useCancelMatchDownload();

  useDownloadCompletion(activeCount, () => void invalidateAfterMatchDownload(queryClient));

  const stateOptions = { now: new Date() };
  const counts = matchHistoryCounts(rows, stateOptions);
  const syncedAt = latestSyncedAt(rows);

  /* The download actions are blocked by the same thing every other write on
     every other page is blocked by, and they say so with the same sentence. */
  const actionDisabledReason = service.buttonProps.disabledReason;

  const selectedRows = rows.filter((row) => selected.has(row.id));

  /**
   * Queues one download per match. `clearSelection` is true only for the batch
   * from the selection bar — a row's own 下载 must leave the checkboxes alone,
   * or clicking one row would silently empty a batch the user was still
   * assembling.
   */
  const startDownloads = (items: readonly MatchHistoryItem[], clearSelection = false): void => {
    for (const item of items) download.mutate(item.match_id);
    if (clearSelection) setSelected(new Set());
  };

  /* `MatchHistoryItem` carries no job id, so 「取消」 has to find the job that
     belongs to the row. When the active list has not arrived yet there is no id
     to cancel with, and the button says that rather than sending a guess. */
  const jobIdFor = (item: MatchHistoryItem): string | undefined =>
    active.find((job) => job.match_record_id === item.id)?.id;

  const readError = dataErrorMessage(history.error);
  const writeError =
    dataErrorMessage(sync.error) ?? dataErrorMessage(download.error) ?? dataErrorMessage(cancel.error);

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>比赛历史</Trans>}
          meta={
            syncedAt === null ? (
              <Trans>Steam 上的对局记录与回放下载</Trans>
            ) : (
              <Trans>Steam · 上次同步 {formatSyncedAt(syncedAt)}</Trans>
            )
          }
          inlineActionsWhenCollapsed={1}
          actions={[
            {
              id: 'steam-settings',
              label: <Trans>Steam 设置</Trans>,
              control: (
                <RouteLink to="/settings?section=app">
                  <Trans>Steam 设置</Trans>
                </RouteLink>
              ),
            },
          ]}
          primary={
            <Button
              variant="primary"
              onClick={() => sync.mutate()}
              {...service.buttonProps}
              {...(sync.isPending ? { disabled: true } : {})}
            >
              {sync.isPending ? <Trans>正在同步…</Trans> : <Trans>同步最近比赛</Trans>}
              {service.suffix}
            </Button>
          }
        />
      }
      bar={
        <div className="flex flex-wrap items-center gap-2.5 border-b border-divider bg-surface px-7 py-2.5">
          <Badge variant="accent">
            <Trans>全部 {total}</Trans>
          </Badge>
          <Badge variant="neutral">
            <Trans>本页未下载 {counts.available}</Trans>
          </Badge>
          <Badge variant="neutral">
            <Trans>本页已入库 {counts.downloaded}</Trans>
          </Badge>
          <Badge variant="neutral">
            <Trans>本页已过期 {counts.expired}</Trans>
          </Badge>
          {activeCount === 0 ? null : (
            <Badge variant="accent">
              <Trans>下载中 {activeCount}</Trans>
            </Badge>
          )}
          <div className="flex-1" aria-hidden="true" />
          <span className="text-2xs text-neutral-600">
            <Trans>Valve 官方链路。FACEIT 等平台连接器尚未提供</Trans>
          </span>
        </div>
      }
      footer={
        selected.size === 0 ? null : (
          <SelectionBar
            summary={<Trans>已选 {selected.size} 场</Trans>}
            primary={
              <Button
                variant="primary"
                size="sm"
                onClick={() => startDownloads(selectedRows, true)}
                {...service.buttonProps}
              >
                <Trans>下载选中的 {selected.size} 场</Trans>
                {service.suffix}
              </Button>
            }
          >
            {/* The service takes a match id and nothing else — see the header. */}
            <Button
              variant="secondary"
              size="sm"
              disabled
              disabledReason={t`暂不支持下载后自动分析，下载完成可在资料库里开始分析`}
            >
              <Trans>下载后自动分析</Trans>
            </Button>
          </SelectionBar>
        )
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-7">
        {readError === null ? null : (
          <Alert
            variant="danger"
            action={{ label: <Trans>重试</Trans>, onAction: () => void history.refetch() }}
            detail={<Trans>读取是只读的，重试不会改动任何记录，也不会重新下载任何回放。</Trans>}
          >
            <Trans>比赛历史没能读出来：{readError}</Trans>
          </Alert>
        )}

        {writeError === null ? null : (
          <Alert
            variant="danger"
            action={{
              label: <Trans>去设置检查 Steam 连接</Trans>,
              /* The router owns the address, including its hash prefix (§1.1);
                 a page that wrote `location.hash` itself would break the day the
                 router mode changes. */
              onAction: () => void navigate('/settings?section=app'),
            }}
            detail={<Trans>同步与下载都要走 Steam 凭据，凭据过期时这两件事会一起失败。</Trans>}
          >
            <Trans>这次操作没有成功：{writeError}</Trans>
          </Alert>
        )}

        <MatchHistoryTable
          rows={rows}
          stateOptions={stateOptions}
          selected={selected}
          onSelectedChange={setSelected}
          onDownload={(item) => startDownloads([item])}
          onCancel={(item) => {
            const jobId = jobIdFor(item);
            if (jobId !== undefined) cancel.mutate(jobId);
          }}
          {...(actionDisabledReason === undefined ? {} : { actionDisabledReason })}
          loading={history.isPending}
          skeleton={<TableSkeleton rows={8} stage={t`正在读取比赛历史`} className="m-4" />}
          empty={
            <Empty
              className="m-4"
              title={<Trans>还没有可显示的对局</Trans>}
              description={
                <Trans>
                  同步之后，这里会列出账号最近的竞技对局。Valve 只保留大约 {DEMO_RETENTION_DAYS} 天内的回放，
                  过期的对局会留在列表里但不再可下载。
                </Trans>
              }
              actions={
                <RouteLink to="/library">
                  <Trans>去 Demo 资料库</Trans>
                </RouteLink>
              }
            />
          }
          footer={
            <Pagination
              page={page}
              pageSize={HISTORY_PAGE_SIZE}
              total={total}
              onPageChange={setPage}
              summary={<Trans>共 {total} 场对局</Trans>}
            />
          }
        />
      </div>
    </Page>
  );
}

/**
 * Fires once when the last download leaves the active list.
 *
 * A finished job is the moment three things changed at once — the row is 已入库,
 * the task record is 已完成, and the library has a demo it did not have — and
 * nothing else tells the page about it: the completion is the *absence* of a
 * job, so there is no mutation whose `onSuccess` could carry the invalidation.
 * `data/history.ts` owns which keys that sweeps.
 */
function useDownloadCompletion(activeCount: number, onDrained: () => void): void {
  const previous = useRef(activeCount);
  /* `onDrained` is kept in a ref rather than in the dependency list: it is a
     fresh closure on every render, and the effect must run when the *count*
     changes, not when the page re-renders for an unrelated reason. */
  const handler = useRef(onDrained);
  handler.current = onDrained;

  useEffect(() => {
    if (previous.current > 0 && activeCount === 0) handler.current();
    previous.current = activeCount;
  }, [activeCount]);
}
