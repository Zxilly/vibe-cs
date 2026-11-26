/** Compact recent-match launcher so 开始选材 is immediately useful once demos exist. */

import { Trans } from '@lingui/react/macro';
import { ArrowRight, Crosshair } from 'lucide-react';

import { useDemoList } from '../../../data/demos';
import { Badge } from '../../../design/primitives';
import { formatTaskClock } from '../../../domain/task';
import type { DemoDisplayStatus } from '../../../shared/desktop/viewModels';
import { RouteLink } from '../../shared/navigation/RouteLink';

const SHOWN = 4;

const MAP_LABELS: Readonly<Record<string, string>> = {
  de_mirage: 'Mirage',
  de_inferno: 'Inferno',
  de_dust2: 'Dust II',
  de_nuke: 'Nuke',
  de_overpass: 'Overpass',
  de_ancient: 'Ancient',
  de_anubis: 'Anubis',
  de_vertigo: 'Vertigo',
  de_train: 'Train',
  de_cache: 'Cache',
};

function displayMapName(mapName: string): string | null {
  if (mapName.trim() === '') return null;
  const key = mapName.trim().toLowerCase();
  return MAP_LABELS[key] ?? mapName.replace(/^de_/iu, '');
}

function demoStatusPriority(status: DemoDisplayStatus): number {
  return status === 'ready' ? 0 : status === 'parsing' ? 1 : 2;
}

export function RecentDemosPanel() {
  const demos = useDemoList({ page: 1, page_size: SHOWN });
  const items = demos.data?.items ?? [];

  if (demos.isPending || demos.error !== null || items.length === 0) return null;

  const sorted = [...items]
    .sort((left, right) => (
      demoStatusPriority(left.status) - demoStatusPriority(right.status)
      || right.updated_at.localeCompare(left.updated_at)
    ))
    .slice(0, SHOWN);

  return (
    <ul
      className="grid grid-cols-1 gap-2.5 md:grid-cols-2"
      data-home-block="recent-demos"
    >
      {sorted.map((demo) => {
        const ready = demo.status === 'ready';
        const map = displayMapName(demo.map_name);
        const score = demo.score_team_a !== null && demo.score_team_b !== null
          ? `${demo.score_team_a}:${demo.score_team_b}`
          : null;
        const target = ready ? `/match/${encodeURIComponent(demo.id)}` : '/library';
        const stamp = demo.match_date ?? demo.updated_at;

        return (
          <li
            key={demo.id}
            className="group relative flex items-center gap-3 rounded-lg border border-divider bg-bg px-3.5 py-2.5 text-sm transition-colors hover:border-neutral-500 hover:bg-neutral-100 focus-within:border-accent"
          >
            <span
              className="grid size-8 flex-none place-items-center rounded-md border border-divider bg-surface-chrome text-neutral-600 transition-colors group-hover:border-accent-300 group-hover:bg-accent-100 group-hover:text-accent-700"
              aria-hidden="true"
            >
              <Crosshair className="size-4" strokeWidth={1.6} aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <RouteLink
                to={target}
                title={demo.display_name}
                className="truncate font-medium text-text no-underline after:absolute after:inset-0"
              >
                {demo.display_name}
              </RouteLink>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-neutral-600">
                {map === null ? null : <span>{map}</span>}
                {score === null ? null : <span className="font-mono">{score}</span>}
                {stamp ? <time dateTime={stamp}>{formatTaskClock(stamp, { now: new Date() })}</time> : null}
              </div>
            </div>
            <div className="flex flex-none items-center gap-2">
              <Badge size="sm" variant={ready ? 'accent' : 'neutral'} className="rounded-sm">
                {ready ? <Trans>可选材</Trans> : demo.status === 'parsing' ? <Trans>分析中</Trans> : <Trans>待分析</Trans>}
              </Badge>
              <ArrowRight className="size-3.5 text-neutral-500 transition-colors group-hover:text-accent-700" aria-hidden="true" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
