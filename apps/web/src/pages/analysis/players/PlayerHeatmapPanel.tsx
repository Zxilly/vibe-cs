/* Player position samples are binned before rendering. MapCanvas owns the
 * loading, unavailable-map and request-failure states. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { heatmapTruncation } from '../../../data/players';
import { Seg, type SegOption } from '../../../design/primitives';
import {
  DEFAULT_HEAT_GRID_SIZE,
  HeatLayer,
  HeatLegend,
  binWorldSamples,
  resolveMapCalibration,
  MapCanvas,
  type HeatSample,
} from '../../../domain/map';
import type { PlayerHeatmap } from '../../../shared/desktop/dto';

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
    /* `flex-none`, not `min-h-0`: the aside this sits in scrolls (DESIGN.md,
       「内容面板各自滚动」). A shrinkable section would take the whole column's
       overflow itself — its square canvas is then centred *over* the title row
       and the kind switch, which is what a 1100 × 700 window used to show. */
    <section className="flex flex-none flex-col gap-3" data-player-heatmap={mapName}>
      <div className="flex flex-none flex-wrap items-center gap-2.5">
        <h2 className="text-sm font-medium">
          <Trans>{mapName === '' ? '—' : mapName} 热图</Trans>
        </h2>
        <div className="flex-1" aria-hidden="true" />
        <Seg
          name="player-heatmap-kind"
          value={kind}
          options={options}
          onChange={onKindChange}
          aria-label={t`热图种类`}
        />
      </div>

      <MapCanvas
        mapName={mapName}
        label={t`${playerName} 在 ${mapName} 的位置热图`}
        {...(error === undefined ? {} : {
          error: {
            message: <Trans>无法加载热图：{error.message}</Trans>,
            action: { label: <Trans>重试</Trans>, onAction: error.onRetry },
          },
        })}
        status={loading ? 'loading' : distribution === null || distribution.bins.length === 0 ? 'empty' : 'ready'}
        emptyDescription={
          <Trans>还没有位置数据，请先分析该选手在这张地图上的比赛。</Trans>
        }
        emptyActions={null}
        /* Only a cut sample gets a footnote. A complete one is already counted
           by the legend's caption (「共 N 个采样点」), and saying the same number
           twice under one picture reads as two different numbers. */
        footnote={
          truncation === null || !truncation.truncated ? undefined : (
            <Trans>
              热力图基于部分位置数据。
            </Trans>
          )
        }
      >
        {(projection) =>
          distribution === null ? null : (
            <HeatLayer projection={projection} distribution={distribution} subject={subject} />
          )
        }
      </MapCanvas>

      {error !== undefined || distribution === null || distribution.bins.length === 0 ? null : (
        <HeatLegend
          distribution={distribution}
          caption={
            <Trans>
              {subject}
            </Trans>
          }
        />
      )}
    </section>
  );
}
