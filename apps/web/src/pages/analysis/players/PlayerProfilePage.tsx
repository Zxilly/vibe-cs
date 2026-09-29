/*
 * pages/ — 选手档案与趋势 (spec §7 `/players/:playerId`, phase 3d).
 *
 * ── Where the layout comes from ────────────────────────────────────────────
 *
 * There is no full-page artboard for this route. What there is:
 *
 *   · 「补齐 · 暗色与其余页面」 draws a 944 × 560 panel titled 「玩家档案与趋势」 —
 *     a 64px identity header (a square initial plate, the name, 「Aurora · 64 场
 *     · 别名 3 个 · 最近出场 08-14」, then 加入比较 and 做一条集锦), then a split:
 *     the left column holds a metric segmented control, a 170px trend box and a
 *     framed 按地图 table; the 320px right column holds a 击杀热图, a 最近比赛
 *     list and a dashed 「段位历史不可用」 note.
 *   · 「06 玩家目录」's Inspector settles the vocabulary the panel above uses —
 *     the comparison bars, the heat map caption, 「查看最近比赛」 / 「做一条 Kael
 *     集锦」.
 *
 * This page is that 944px panel promoted to a route, with two adjustments the
 * promotion forces:
 *
 *   1. The identity header becomes the `Toolbar` rather than a second bar under
 *      it. A route already has a top bar, and stacking a 64px header on a 56px
 *      toolbar would spend 120px of a 700px window on saying the same name
 *      twice. Parent navigation stays in the shell breadcrumb, while the
 *      player's initial plate occupies `leading`.
 *   3. The panel's 「做一条集锦」 is not drawn. Highlights are cut in a match
 *      workspace or by the Agent, never from a profile, so a primary button
 *      here could only ever be disabled — and a main action that can never be
 *      taken is not a main action (DESIGN.md: 「蓝色优先表达主动作」; a
 *      `disabledReason` is for 「为什么现在不能点」, not for 「never」). The
 *      route offers the thing it can do instead: a secondary link into the
 *      player's most recent match workspace.
 *   2. The right column is `--w-panel` (340) rather than the panel's 320 — §3.5
 *      has no 320 token and 340 is the nearest, a 20px fold well inside the
 *      80px bound `PANEL_WIDTH_MAX_FOLD_PX` records.
 *
 * ── Trajectories are not drawn here (§10.3 gap 1) ──────────────────────────
 *
 * The gap asks phase 3c/3d to set a down-sampling strategy for `PathLayer`
 * (240 paths × 600 samples = 2.65 MB of markup). Neither the profile panel nor
 * 「06」 draws a trajectory — the only map surface on this route is the heat map,
 * which takes a `HeatDistribution` and cannot put one node per sample on screen
 * by construction. So no strategy is set here, and the gap stays with the
 * workspace's 2D replay view, which is the surface that actually renders paths.
 *
 * ── Everything else this page states is measured ───────────────────────────
 *
 * §7 says the profile links back to the matches the player appeared in, so the
 * 最近比赛 list is `listPlayerMatches`, capped at the same `TREND_WINDOW` the
 * chart uses — one read feeding both, and the chart can never be drawn from a
 * sample the list does not show.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useParams, useSearchParams } from 'react-router-dom';

import { dataErrorMessage } from '../../../data/errors';
import { usePlayer, usePlayerHeatmap, usePlayerMaps, usePlayerMatches } from '../../../data/players';
import { Empty, Skeleton } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Page, Toolbar } from '../../../design/layout';
import { Button } from '../../../design/primitives';
import { RouteLink } from '../../shared/navigation/RouteLink';
import { PlayerHeatmapPanel, HEATMAP_KINDS, type HeatmapKind } from './PlayerHeatmapPanel';
import { PlayerMapTable } from './PlayerMapTable';
import { PlayerTrend } from './PlayerTrend';
import { pickQueryValue } from '../../shared/navigation/routeQuery';
import {
  TREND_METRICS,
  TREND_WINDOW,
  formatFixed,
  formatMonthDay,
  nameInitial,
  NO_VALUE,
  type TrendMetric,
} from './playerStats';

/** One page is enough for the 按地图 table: CS2 has nine active-duty maps and a
 *  handful of retired ones, so a second page would be a rounding error. */
const MAP_PAGE_SIZE = 20;

export function PlayerProfilePage() {
  const { playerId = '' } = useParams<{ playerId: string }>();
  const [params, setParams] = useSearchParams();

  const metric = pickQueryValue(params.get('metric'), TREND_METRICS, 'kd');
  const kind = pickQueryValue(params.get('kind'), HEATMAP_KINDS, 'all');
  const mapParam = (params.get('map') ?? '').trim();

  const steamId = playerId === '' ? null : playerId;
  const profile = usePlayer(steamId);
  const matches = usePlayerMatches(steamId, { page: 1, page_size: TREND_WINDOW });
  const maps = usePlayerMaps(steamId, { page: 1, page_size: MAP_PAGE_SIZE });

  /* The map the heat map is about: whatever the URL says, else the player's
     most-played map — which is the first row, because `listPlayerMaps` orders
     by matches. Falling back to a *named* map rather than to "no map" is what
     makes the panel useful on a bare `/players/:id` link. */
  const defaultMap = maps.data?.items[0]?.map_name ?? '';
  const mapName = mapParam === '' ? defaultMap : mapParam;
  const heatmap = usePlayerHeatmap(steamId, { map: mapName, kind });

  const setParam = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(name);
    else next.set(name, value);
    setParams(next);
  };

  const player = profile.data?.player;
  const profileError = dataErrorMessage(profile.error);
  const matchesError = dataErrorMessage(matches.error);
  const mapsError = dataErrorMessage(maps.error);
  const heatmapError = dataErrorMessage(heatmap.error);
  const recentMatches = matches.data?.items ?? [];
  const latestMatch = recentMatches[0];
  const lastSeen = player === undefined ? '' : formatMonthDay(player.last_match_date);

  return (
    <Page
      scroll={false}
      className="@container/profile"
      toolbar={
        <Toolbar
          leading={
            player === undefined ? null : (
              <span
                aria-hidden="true"
                className="grid size-9 flex-none place-items-center border border-accent font-heading text-base text-accent-800"
              >
                {nameInitial(player.name)}
              </span>
            )
          }
          title={player === undefined ? <Trans>选手档案</Trans> : player.name}
          meta={
            player === undefined ? (
              playerId
            ) : (
              /* 最近出场 only when a date exists. A manually imported demo has
                 no match date (that field comes from Steam's history), and a
                 label with nothing after it is the one thing worse than the
                 table's dash. */
              <>
                <Trans>
                  {player.last_team ?? NO_VALUE} · {player.stats.matches} 场 · 别名{' '}
                  {player.aliases_total} 个
                </Trans>
                {lastSeen === '' ? null : (
                  <>
                    {' · '}
                    <Trans>最近出场 {lastSeen}</Trans>
                  </>
                )}
              </>
            )
          }
          inlineActionsWhenCollapsed={1}
          actions={
            latestMatch === undefined
              ? []
              : [
                  {
                    id: 'workspace',
                    label: <Trans>去比赛工作区做集锦</Trans>,
                    control: (
                      <RouteLink to={`/match/${encodeURIComponent(latestMatch.demo_id)}`}>
                        <Trans>去比赛工作区做集锦</Trans>
                      </RouteLink>
                    ),
                  },
                ]
          }
        />
      }
    >
      {profileError === null ? null : (
        <div className="p-6">
          <Alert
            variant="danger"
            action={{ label: <Trans>重试</Trans>, onAction: () => void profile.refetch() }}

          >
            <Trans>这名选手的档案没能读出来：{profileError}</Trans>
          </Alert>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @min-[900px]/profile:flex-row @min-[900px]/profile:overflow-hidden">
        <div className="flex min-w-0 flex-none flex-col gap-5 border-b border-divider p-4 @min-[900px]/profile:min-h-0 @min-[900px]/profile:flex-1 @min-[900px]/profile:overflow-y-auto @min-[900px]/profile:border-r @min-[900px]/profile:border-b-0 @min-[900px]/profile:p-6">
          <PlayerTrend
            matches={recentMatches}
            metric={metric}
            onMetricChange={(next: TrendMetric) => setParam('metric', next)}
            loading={matches.isPending}
            {...(matchesError === null ? {} : { error: { message: matchesError, onRetry: () => void matches.refetch() } })}
          />
          {mapsError === null ? null : <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void maps.refetch() }}>
            <Trans>地图统计没能读出来：{mapsError}</Trans>
          </Alert>}
          {mapsError === null || maps.data !== undefined ? <PlayerMapTable rows={maps.data?.items ?? []} loading={maps.isPending} /> : null}
        </div>

        <aside
          aria-label={t`地图与最近比赛`}
          className="flex min-w-0 flex-none flex-col gap-4 p-4 @min-[900px]/profile:w-[var(--w-panel)] @min-[900px]/profile:min-h-0 @min-[900px]/profile:overflow-y-auto @min-[900px]/profile:p-5"
        >
          <PlayerHeatmapPanel
            playerName={player?.name ?? playerId}
            mapName={mapName}
            kind={kind}
            onKindChange={(next: HeatmapKind) => setParam('kind', next)}
            heatmap={heatmap.data}
            loading={maps.isPending || (heatmap.isPending && mapName !== '')}
            {...(heatmapError === null
              ? {}
              : { error: { message: heatmapError, onRetry: () => void heatmap.refetch() } })}
          />

          {/* The map picker sits under the canvas rather than beside the kind
              segment: the list is as long as the player's map pool and cannot
              be a segmented control. */}
          {maps.data === undefined || maps.data.items.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-neutral-600">
                <Trans>换一张图</Trans>
              </span>
              {maps.data.items.map((item) =>
                item.map_name === null ? null : (
                  <Button
                    key={item.map_name}
                    variant={item.map_name === mapName ? 'primary' : 'secondary'}
                    size="sm"
                    aria-pressed={item.map_name === mapName}
                    onClick={() => setParam('map', item.map_name ?? '')}
                  >
                    {item.map_name}
                  </Button>
                ),
              )}
            </div>
          )}

          <section className="flex flex-col gap-2" data-player-recent="">
            <h3 className="text-sm font-medium">
              <Trans>最近比赛</Trans>
            </h3>
            {matches.isPending ? (
              <div role="status" aria-busy="true" className="flex flex-col gap-2">
                <Skeleton className="h-10" /><Skeleton className="h-10" />
                <span className="text-xs text-neutral-600"><Trans>正在读取最近比赛</Trans></span>
              </div>
            ) : matchesError !== null ? (
              <Alert
                variant="danger"
                action={{ label: <Trans>重试</Trans>, onAction: () => void matches.refetch() }}
              >
                <Trans>最近比赛没能读出来：{matchesError}</Trans>
              </Alert>
            ) : recentMatches.length === 0 ? (
              <Empty
                title={<Trans>还没有比赛</Trans>}
                description={<Trans>这名选手还没有出现在任何一场已分析的比赛里。</Trans>}
                actions={
                  <RouteLink to="/library">
                    <Trans>去资料库分析一场</Trans>
                  </RouteLink>
                }
              />
            ) : (
              <ul className="flex list-none flex-col gap-2">
                {recentMatches.map((match) => (
                  <li key={match.demo_id} className="flex items-baseline justify-between gap-3 border-b border-divider pb-2 text-sm">
                    <RouteLink to={`/match/${encodeURIComponent(match.demo_id)}`} title={match.demo_name} className="min-w-0 truncate">
                      {match.demo_name}
                    </RouteLink>
                    <span className="flex-none font-mono text-xs text-neutral-700">
                      K/D {formatFixed(match.kill_death_ratio, 2)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Verbatim from the artboard: a dashed note for a statistic the demo
              files do not contain, rather than an empty chart. */}
          <p className="border border-dashed border-neutral-400 p-3 text-xs leading-normal text-neutral-700">
            <Trans>段位历史不可用：这批 Demo 里没有段位信息。</Trans>
          </p>
        </aside>
      </div>
    </Page>
  );
}
