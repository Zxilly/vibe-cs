import { Crosshair, ExternalLink, MapPinned, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { desktopMediaUrl } from '../../shared/desktop/client';
import type {
  PlayerHeatmap,
  PlayerHeatmapPoint,
  RadarOverviewRecord,
} from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { worldPointsToRadarPercent } from '../../shared/radar';
import { Badge, Button, EmptyState, Notice } from '../../shared/ui';

type HeatmapKind = 'all' | 'kills' | 'deaths';

function relativeCoordinates(points: readonly PlayerHeatmapPoint[]): Array<[number, number]> {
  if (points.length === 0) return [];
  let minimumX = points[0]?.x ?? 0;
  let maximumX = minimumX;
  let minimumY = points[0]?.y ?? 0;
  let maximumY = minimumY;
  for (const point of points) {
    minimumX = Math.min(minimumX, point.x);
    maximumX = Math.max(maximumX, point.x);
    minimumY = Math.min(minimumY, point.y);
    maximumY = Math.max(maximumY, point.y);
  }
  const width = Math.max(1, maximumX - minimumX);
  const height = Math.max(1, maximumY - minimumY);
  const scale = Math.max(width, height);
  const xOffset = (scale - width) / 2;
  const yOffset = (scale - height) / 2;
  return points.map((point) => [
    ((point.x - minimumX + xOffset) / scale) * 86 + 7,
    (1 - ((point.y - minimumY + yOffset) / scale)) * 86 + 7,
  ]);
}

export function PlayerHeatmapWorkspace({
  heatmap,
  radar,
  kind,
  onKindChange,
  onClose,
}: {
  heatmap: PlayerHeatmap;
  radar: RadarOverviewRecord | null;
  kind: HeatmapKind;
  onKindChange: (kind: HeatmapKind) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(
    () => heatmap.points[0]?.evidence_id ?? null,
  );
  const visiblePoints = useMemo(
    () => kind === 'all' ? heatmap.points : heatmap.points.filter((point) => point.kind === kind),
    [heatmap.points, kind],
  );
  const selectedPoint = visiblePoints.find((point) => point.evidence_id === selectedEvidenceId)
    ?? visiblePoints[0]
    ?? null;
  const coordinateByEvidenceId = useMemo(() => {
    const coordinates = worldPointsToRadarPercent(
      heatmap.points.map((point) => [point.x, point.y] as const),
      radar?.transform ?? null,
    ) ?? relativeCoordinates(heatmap.points);
    return new Map(heatmap.points.map((point, index) => [
      point.evidence_id,
      coordinates[index] ?? [50, 50],
    ]));
  }, [heatmap.points, radar?.transform]);
  const radarImage = radar?.transform && radar.browser_displayable && radar.image_url
    ? desktopMediaUrl(radar.image_url)
    : null;

  return (
    <section className="player-heatmap-workspace" aria-label={t('players.heatmap.title')}>
      <header>
        <div>
          <MapPinned size={16} />
          <div><strong>{t('players.heatmap.title')}</strong><span>{heatmap.map_name}</span></div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={t('players.heatmap.close')}>
          <X size={13} />{t('players.heatmap.close')}
        </Button>
      </header>
      <div className="player-heatmap-workspace__toolbar" aria-label={t('players.heatmap.filter')}>
        {(['all', 'kills', 'deaths'] as const).map((candidate) => (
          <Button
            key={candidate}
            size="sm"
            variant={kind === candidate ? 'primary' : 'ghost'}
            aria-pressed={kind === candidate}
            onClick={() => onKindChange(candidate)}
          >{t(`players.heatmap.kind.${candidate}`)}</Button>
        ))}
        <span>{visiblePoints.length} / {heatmap.total}</span>
        <Badge tone={radar?.transform ? 'success' : 'neutral'}>
          {radar?.transform ? t('players.heatmap.localRadar') : t('players.heatmap.relativePlane')}
        </Badge>
      </div>

      {!heatmap.complete ? (
        <Notice tone="warning" title={t('players.heatmap.boundedTitle')}>
          {t('players.heatmap.boundedDescription')
            .replace('{maximum}', String(heatmap.maximum_points))
            .replace('{total}', String(heatmap.total))}
        </Notice>
      ) : heatmap.points.length === 0 ? (
        <EmptyState
          icon={<Crosshair size={24} />}
          title={t('players.heatmap.empty')}
          description={t('players.heatmap.emptyDescription')}
        />
      ) : (
        <div className="player-heatmap-workspace__body">
          <div
            className={`player-heatmap-map${radarImage ? ' has-radar-image' : ' is-coordinate-plane'}`}
            data-coordinate-space={radar?.transform ? 'map-overview' : 'whole-artifact-relative'}
          >
            {radarImage ? <img src={radarImage} alt={t('players.heatmap.radarAlt').replace('{map}', heatmap.map_name)} /> : null}
            {visiblePoints.map((point) => {
              const coordinate = coordinateByEvidenceId.get(point.evidence_id) ?? [50, 50];
              return (
                <button
                  type="button"
                  key={`${point.kind}:${point.evidence_id}`}
                  className={point.evidence_id === selectedPoint?.evidence_id ? 'is-selected' : undefined}
                  data-heat-kind={point.kind}
                  style={{ left: `${coordinate[0]}%`, top: `${coordinate[1]}%` }}
                  aria-label={t('players.heatmap.pointLabel')
                    .replace('{kind}', t(`players.heatmap.kind.${point.kind}`))
                    .replace('{round}', String(point.round))
                    .replace('{tick}', String(point.tick))}
                  onClick={() => setSelectedEvidenceId(point.evidence_id)}
                />
              );
            })}
          </div>
          {selectedPoint ? (
            <aside className="player-heatmap-evidence" aria-label={t('players.heatmap.evidence')}>
              <span className="eyebrow">{t(`players.heatmap.kind.${selectedPoint.kind}`)}</span>
              <strong>R{selectedPoint.round} · TICK {selectedPoint.tick}</strong>
              <span>{t('players.heatmap.floor').replace('{floor}', String(selectedPoint.floor))}</span>
              <small>{selectedPoint.evidence_id}</small>
              <nav>
                <Link to={selectedPoint.analysis_href}>{t('players.heatmap.round')}<ExternalLink size={12} /></Link>
                <Link to={selectedPoint.replay_href}>{t('players.heatmap.replay')}<ExternalLink size={12} /></Link>
              </nav>
            </aside>
          ) : null}
        </div>
      )}
      {!heatmap.coverage.projection_complete ? (
        <Notice tone="warning">
          {t('players.projection.incomplete')
            .replace('{projected}', String(heatmap.coverage.projected_demos))
            .replace('{total}', String(heatmap.coverage.total_analyses))}
        </Notice>
      ) : null}
      <p>{t('players.heatmap.truthBoundary')}</p>
    </section>
  );
}
