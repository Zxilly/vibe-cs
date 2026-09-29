import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { dataErrorMessage } from '../../../data/errors';
import { useMapGeometryStatus, useRebuildMapGeometry } from '../../../data/mapGeometry';
import { Skeleton } from '../../../design/data';
import { Alert, StatusDot, type StatusDotStatus } from '../../../design/feedback';
import { Button } from '../../../design/primitives';
import type { MapGeometryCacheState } from '../../../shared/desktop/dto';
import { SettingsBlock } from './settingsShared';

const mapNames: Record<string, string> = {
  de_mirage: 'Mirage', de_dust2: 'Dust II', de_inferno: 'Inferno', de_nuke: 'Nuke',
  de_ancient: 'Ancient', de_anubis: 'Anubis', de_train: 'Train', de_overpass: 'Overpass',
};
const dots: Record<MapGeometryCacheState, StatusDotStatus> = {
  missing: 'idle', stale: 'warn', building: 'running', ready: 'ok', failed: 'fail', unavailable: 'idle',
};

function stateLabel(state: MapGeometryCacheState): string {
  switch (state) {
    case 'missing': return t`尚未生成`;
    case 'stale': return t`地图已更新`;
    case 'building': return t`正在生成`;
    case 'ready': return t`已准备`;
    case 'failed': return t`生成失败`;
    case 'unavailable': return t`未找到地图`;
  }
}

export function MapGeometrySettings() {
  const status = useMapGeometryStatus({ pollMs: 2_000 });
  const rebuild = useRebuildMapGeometry();
  const error = dataErrorMessage(status.error);
  const rebuildError = dataErrorMessage(rebuild.error);
  return (
    <SettingsBlock id="map-geometry" title={<Trans>地图 3D 预演</Trans>}
      description={<Trans>准备回放和镜头预演所需的地图。</Trans>}
      actions={<Button variant="ghost" size="sm" onClick={() => void status.refetch()}><Trans>刷新状态</Trans></Button>}
    >
      {error !== null ? <Alert variant="warning" action={{ label: <Trans>重试</Trans>, onAction: () => void status.refetch() }}><Trans>暂时读不到地图，请先确认上方的 CS2 位置。</Trans> {error}</Alert> : null}
      {rebuildError !== null ? <Alert variant="danger" action={{ label: <Trans>知道了</Trans>, onAction: () => rebuild.reset() }}><Trans>地图没有生成成功：</Trans>{rebuildError}</Alert> : null}
      {status.isPending ? <Skeleton /> : null}
      <ul className="divide-y divide-divider" aria-label={t`地图状态`}>
        {(status.data ?? []).map((map) => {
          const name = mapNames[map.map_name] ?? map.map_name;
          const active = rebuild.isPending && rebuild.variables === map.map_name;
          const state = active ? 'building' : map.state;
          const blocked = rebuild.isPending || state === 'building' || state === 'unavailable';
          const disabledReason = state === 'unavailable' ? t`请先在 CS2 中安装这张地图。` : blocked ? t`正在生成地图，请稍候。` : undefined;
          return (
            <li key={map.map_name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm font-medium">{name}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-neutral-600" role="status">
                    <StatusDot status={dots[state]} size="sm" />{stateLabel(state)}
                  </span>
                </div>
                {map.reason !== null && state === 'failed' ? <p className="mt-1 break-words text-sm text-fail-text">{map.reason}</p> : null}
              </div>
              <Button size="sm" variant="secondary" disabled={blocked} disabledReason={disabledReason}
                aria-label={state === 'missing' ? t`生成 ${name} 地图` : t`重新生成 ${name} 地图`}
                onClick={() => void rebuild.mutateAsync(map.map_name).catch(() => undefined)}
              >{active || state === 'building' ? <Trans>正在生成</Trans> : state === 'missing' ? <Trans>生成</Trans> : <Trans>重新生成</Trans>}</Button>
            </li>
          );
        })}
      </ul>
    </SettingsBlock>
  );
}
