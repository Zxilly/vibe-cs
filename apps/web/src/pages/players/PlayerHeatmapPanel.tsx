/*
 * pages/players — 「Mirage 击杀热图」 of 「玩家档案与趋势」 / 「06 玩家目录」.
 *
 * ── §10.3 gap 7: the aggregation is still server-side missing ──────────────
 *
 * The gap says 「热力图需要服务端聚合。上万个点不能从前端顶起来」. It is still
 * true in the sense that meant: `GET /players/:id/heatmap` returns raw
 * `PlayerHeatmapPoint`s, not bins. What makes it survivable — and what this
 * panel relies on — is the ceiling the route already applies:
 *
 *     crates/application/src/routes/players.rs:353   maximum_points: 5_000
 *
 * So the front end never receives 「上万个点」; it receives at most 5 000, plus a
 * `complete` flag saying whether that ceiling cut the sample. The arithmetic
 * that follows:
 *
 *     5 000 points  ── binWorldSamples, one linear pass ──▶  ≤ 48² = 2 304 cells
 *     and in practice a few hundred, because a map's playable area is a
 *     fraction of its bounding square (`heatBinning`'s own note)
 *
 * One O(n) pass over 5 000 records per map change is not a frame budget
 * problem; 5 000 DOM nodes would have been, which is exactly why `HeatLayer`
 * takes a `HeatDistribution` and not a point list. `players/density.test.tsx`
 * pins the node count at the ceiling.
 *
 * **This is a mitigation, not a fix.** With server-side binning the response
 * would be a few hundred rows instead of 5 000 and the truncation notice below
 * would not have to exist. The gap stays open and is re-reported.
 *
 * ── §10.3 gap 8: no basemap ────────────────────────────────────────────────
 *
 * 「底图图片没有交付路径」 — the Tauri CSP is `default-src 'self'` and there is no
 * `vibe-cs-media:` route for radar artwork. So `basemap` is deliberately not
 * passed, and `MapCanvas` draws its blueprint grid instead: a stand-in that
 * 「cannot be mistaken for a map」, in its own words. No image asset is
 * introduced by this phase.
 *
 * ── Truncation is stated, never hidden ─────────────────────────────────────
 *
 * When `complete` is false the panel says which sample it is drawn from
 * (「取样 5 000 / 12 480」). §10.3's density rule is that a silent truncation is
 * a bug; that applies to a picture as much as to a table.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { heatmapTruncation } from '../../data/players';
import { Notice } from '../../design/feedback';
import { Seg, type SegOption } from '../../design/primitives';
import {
  DEFAULT_HEAT_GRID_SIZE,
  HeatLayer,
  HeatLegend,
  binWorldSamples,
  resolveMapCalibration,
  MapCanvas,
  type HeatSample,
} from '../../domain/map';
import type { PlayerHeatmap } from '../../shared/desktop/dto';

export const HEATMAP_KINDS = ['all', 'kills', 'deaths'] as const;
export type HeatmapKind = (typeof HEATMAP_KINDS)[number];

function kindLabel(kind: HeatmapKind): ReactNode {
  switch (kind) {
    case 'all':
      return <Trans>全部</Trans>;
    case 'kills':
      return <Trans>击杀</Trans>;
    case 'deaths':
      return <Trans>死亡</Trans>;
  }
}

function kindSubject(kind: HeatmapKind): string {
  switch (kind) {
    case 'all':
      return t`击杀与死亡位置`;
    case 'kills':
      return t`击杀位置`;
    case 'deaths':
      return t`死亡位置`;
  }
}

export interface PlayerHeatmapPanelProps {
  readonly playerName: string;
  /** `de_mirage`, as the workspace record spells it. `''` when unknown. */
  readonly mapName: string;
  readonly kind: HeatmapKind;
  readonly onKindChange: (kind: HeatmapKind) => void;
  readonly heatmap: PlayerHeatmap | undefined;
  readonly loading?: boolean | undefined;
  readonly error?: { readonly message: string; readonly onRetry: () => void } | undefined;
}

export function PlayerHeatmapPanel({
  playerName,
  mapName,
  kind,
  onKindChange,
  heatmap,
  loading = false,
  error,
}: PlayerHeatmapPanelProps) {
  const options: readonly SegOption<HeatmapKind>[] = HEATMAP_KINDS.map((value) => ({
    value,
    label: kindLabel(value),
  }));

  const calibration = mapName === '' ? null : resolveMapCalibration(mapName);
  const samples: readonly HeatSample[] =
    heatmap === undefined
      ? []
      : heatmap.points.map((point) => ({ x: point.x, y: point.y, floor: point.floor }));
  const distribution =
    calibration === null
      ? null
      : binWorldSamples(samples, calibration, { gridSize: DEFAULT_HEAT_GRID_SIZE });
  const truncation = heatmap === undefined ? null : heatmapTruncation(heatmap);
  const subject = `${playerName} · ${kindSubject(kind)}`;

  return (
    <section className="flex min-h-0 flex-col gap-3" data-player-heatmap={mapName}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-heading text-2xs tracking-caps text-neutral-600">
          <Trans>{mapName === '' ? '—' : mapName} 热图</Trans>
        </span>
        <div className="flex-1" aria-hidden="true" />
        <Seg
          name="player-heatmap-kind"
          value={kind}
          options={options}
          onChange={onKindChange}
          aria-label={t`热图种类`}
        />
      </div>

      {error === undefined ? null : (
        <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: error.onRetry }}>
          <Trans>热图没能读出来：{error.message}</Trans>
        </Notice>
      )}

      <MapCanvas
        mapName={mapName}
        label={t`${playerName} 在 ${mapName} 的位置热图`}
        status={loading ? 'loading' : distribution === null || distribution.bins.length === 0 ? 'empty' : 'ready'}
        emptyDescription={
          <Trans>这张地图上还没有这名选手的位置样本。分析更多这张图的比赛之后就会有。</Trans>
        }
        emptyActions={null}
        footnote={
          truncation === null ? undefined : truncation.truncated ? (
            <Trans>
              取样 {truncation.shown} / {truncation.total} 个位置（上限 {truncation.limit}）。
              这张图画的是这批取样，不是全部。
            </Trans>
          ) : (
            <Trans>共 {truncation.total} 个位置，全部计入。</Trans>
          )
        }
      >
        {(projection) =>
          distribution === null ? null : (
            <HeatLayer projection={projection} distribution={distribution} subject={subject} />
          )
        }
      </MapCanvas>

      {distribution === null || distribution.bins.length === 0 ? null : (
        <HeatLegend
          distribution={distribution}
          caption={
            <Trans>
              当前统计：{subject}，共 {distribution.sampleCount} 个采样点。
            </Trans>
          }
        />
      )}
    </section>
  );
}
