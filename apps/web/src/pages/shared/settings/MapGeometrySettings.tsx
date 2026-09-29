import { Trans } from '@lingui/react/macro';

import { dataErrorMessage } from '../../../data/errors';
import { useClearMapGeometryCache, useMapGeometryCache } from '../../../data/mapGeometry';
import { Skeleton } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Button } from '../../../design/primitives';
import { formatBytes, SettingsBlock } from './settingsShared';

export function MapGeometrySettings() {
  const cache = useMapGeometryCache({ pollMs: 5_000 });
  const clear = useClearMapGeometryCache();
  return (
    <SettingsBlock id="map-geometry" title={<Trans>地图缓存</Trans>}
      description={<Trans>使用地图时按需生成缓存，地图更新后自动重新生成。</Trans>}
      actions={<Button variant="secondary" size="sm" disabled={clear.isPending || cache.isPending || cache.data?.files === 0}
        onClick={() => clear.mutate()}>
        {clear.isPending ? <Trans>正在清理…</Trans> : <Trans>清理缓存</Trans>}
      </Button>}
    >
      {cache.isPending ? <Skeleton /> : null}
      {cache.data !== undefined && <p role="status" className="text-sm text-neutral-600">
        {cache.data.files === 0 ? <Trans>暂无地图缓存</Trans> : <Trans>已缓存 {cache.data.files} 份地图 · 占用 {formatBytes(cache.data.bytes)}</Trans>}
      </p>}
      <p className="text-sm text-neutral-600"><Trans>清理不影响游戏文件，下次使用时会自动生成。</Trans></p>
      {cache.isError && <Alert variant="warning" action={{ label: <Trans>重试</Trans>, onAction: () => void cache.refetch() }}>
        <Trans>暂时无法读取缓存占用。</Trans> {dataErrorMessage(cache.error)}
      </Alert>}
      {clear.isError && <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => clear.mutate() }}><Trans>缓存未能完全清理，请重试。</Trans> {dataErrorMessage(clear.error)}</Alert>}
    </SettingsBlock>
  );
}
