import { ChartNoAxesCombined, ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import type { PlayerMatchPage } from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Button } from '../../shared/ui';
import { derivePlayerTrend, type PlayerTrendMetric } from './playerTrend';

const metrics: PlayerTrendMetric[] = ['adr', 'kd', 'kills', 'damage'];

function formatMetric(value: number | null, metric: PlayerTrendMetric): string {
  if (value === null) return '—';
  return metric === 'kills' || metric === 'damage' ? value.toFixed(0) : value.toFixed(2);
}

function chartSegments(values: Array<number | null>): number[][] {
  const result: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) result.push(current);
      current = [];
    } else {
      current.push(index);
    }
  });
  if (current.length > 0) result.push(current);
  return result;
}

export function PlayerTrendWorkspace({ matches }: { matches: PlayerMatchPage }) {
  const { t } = useI18n();
  const [metric, setMetric] = useState<PlayerTrendMetric>('adr');
  const trend = useMemo(() => derivePlayerTrend(matches, metric), [matches, metric]);
  const range = Math.max(1, (trend.maximum ?? 0) - (trend.minimum ?? 0));
  const chartPoint = (index: number, value: number) => ({
    x: trend.points.length <= 1 ? 50 : 4 + (index / (trend.points.length - 1)) * 92,
    y: 92 - ((value - (trend.minimum ?? value)) / range) * 84,
  });

  return (
    <section className="player-trend-workspace" data-trend-metric={metric} aria-label={t('players.trend.title')}>
      <header>
        <div><ChartNoAxesCombined size={16} /><strong>{t('players.trend.title')}</strong></div>
        <span>{trend.window.first}–{trend.window.last} / {trend.window.total}</span>
      </header>
      <div className="player-trend-workspace__metrics" aria-label={t('players.trend.metric')}>
        {metrics.map((candidate) => (
          <Button
            key={candidate}
            size="sm"
            variant={candidate === metric ? 'primary' : 'ghost'}
            aria-pressed={candidate === metric}
            onClick={() => setMetric(candidate)}
          >{t(`players.trend.metric.${candidate}`)}</Button>
        ))}
      </div>
      <div className="player-trend-chart">
        <svg viewBox="0 0 100 100" role="img" aria-label={t('players.trend.chart')} preserveAspectRatio="none">
          {[25, 50, 75].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} />)}
          {chartSegments(trend.points.map((point) => point.value)).map((segment) => (
            <polyline
              key={segment.join(':')}
              points={segment.map((index) => {
                const value = trend.points[index]?.value ?? 0;
                const point = chartPoint(index, value);
                return `${point.x},${point.y}`;
              }).join(' ')}
            />
          ))}
          {trend.points.map((point, index) => point.value === null ? null : (() => {
            const position = chartPoint(index, point.value);
            return <circle key={point.demoId} cx={position.x} cy={position.y} r="2" />;
          })())}
        </svg>
        <span className="player-trend-chart__max">{formatMetric(trend.maximum, metric)}</span>
        <span className="player-trend-chart__min">{formatMetric(trend.minimum, metric)}</span>
      </div>
      {trend.comparison ? (
        <dl className="player-trend-comparison">
          <div><dt>{t('players.trend.prior').replace('{count}', String(trend.comparison.sampleSize))}</dt><dd>{formatMetric(trend.comparison.priorAverage, metric)}</dd></div>
          <div><dt>{t('players.trend.recent').replace('{count}', String(trend.comparison.sampleSize))}</dt><dd>{formatMetric(trend.comparison.recentAverage, metric)}</dd></div>
          <div><dt>{t('players.trend.delta')}</dt><dd>{trend.comparison.delta >= 0 ? '+' : ''}{formatMetric(trend.comparison.delta, metric)}</dd></div>
        </dl>
      ) : null}
      <ol className="player-trend-points">
        {trend.points.map((point) => (
          <li key={point.demoId}>
            <Link to={point.href} title={point.demoName}>
              <span>{point.demoName}</span>
              <strong>{formatMetric(point.value, metric)}</strong>
              <small>{point.matchDate ? t('players.trend.matchDated') : t('players.matches.dateUnavailable')} · {point.mapName ?? '—'}</small>
              <ExternalLink size={11} />
            </Link>
          </li>
        ))}
      </ol>
      <p>{t('players.trend.truthBoundary')}</p>
    </section>
  );
}
