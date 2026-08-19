import { Trans } from '@lingui/react/macro';

import { useProjectCollections, type ProjectCollectedClip } from '../../data/projectCollections';
import { Empty } from '../../design/data';
import { Badge, Button } from '../../design/primitives';
import type { ProjectViewModel } from '../../domain/project/projectViewModel';
import { RouteLink } from '../RouteLink';

export function ProjectSelectStep({ project }: { readonly project: ProjectViewModel }) {
  const collections = useProjectCollections();
  const clips = collections.state[project.id] ?? [];
  const matches = groupByMatch(clips);

  if (clips.length === 0) {
    return (
      <Empty
        className="m-7"
        title={<Trans>这份作品还没有收集片段</Trans>}
        description={<Trans>从比赛工作区的高光、回合或证据点击「加入作品」，片段会按比赛汇总到这里。</Trans>}
        actions={<RouteLink to="/library"><Trans>选择一场比赛</Trans></RouteLink>}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-7" data-project-selection={clips.length}>
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="font-heading text-lg"><Trans>已收集片段</Trans></h2>
        <span className="text-xs text-neutral-600"><Trans>{matches.length} 场比赛 · {clips.length} 个片段</Trans></span>
      </div>
      <div className="flex flex-col gap-5">
        {matches.map((match) => (
          <section key={match.demoId} className="border border-divider" data-collected-match={match.demoId}>
            <header className="flex items-center gap-3 border-b border-divider px-4 py-3">
              <h3 className="font-heading text-base">{match.label}</h3>
              <Badge variant="neutral"><Trans>{match.clips.length} 个片段</Trans></Badge>
              <div className="flex-1" aria-hidden="true" />
              <RouteLink to={`/match/${encodeURIComponent(match.demoId)}`} size="sm"><Trans>打开比赛</Trans></RouteLink>
            </header>
            <ul className="m-0 list-none p-0">
              {match.clips.map((clip) => (
                <li key={clip.id} className="flex items-center gap-3 border-b border-divider px-4 py-3 last:border-b-0" data-collected-clip={clip.id}>
                  <Badge variant="accent">{kindLabel(clip.kind)}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{clip.label}</p>
                    <p className="mt-0.5 text-xs text-neutral-600">{clipMeta(clip)}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => collections.remove(project.id, clip.id)}>
                    <Trans>移除</Trans>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function groupByMatch(clips: readonly ProjectCollectedClip[]) {
  const groups = new Map<string, { demoId: string; label: string; clips: ProjectCollectedClip[] }>();
  for (const clip of clips) {
    const group = groups.get(clip.demoId);
    if (group === undefined) groups.set(clip.demoId, { demoId: clip.demoId, label: clip.matchLabel, clips: [clip] });
    else group.clips.push(clip);
  }
  return [...groups.values()];
}

function kindLabel(kind: ProjectCollectedClip['kind']) {
  switch (kind) {
    case 'highlight': return <Trans>高光</Trans>;
    case 'round': return <Trans>回合</Trans>;
    case 'evidence': return <Trans>证据</Trans>;
    case 'player': return <Trans>选手</Trans>;
    case 'selection': return <Trans>片段</Trans>;
  }
}

function clipMeta(clip: ProjectCollectedClip): string {
  const facts: string[] = [];
  if (clip.round !== null) facts.push(`R${String(clip.round)}`);
  if (clip.startTick !== null) {
    facts.push(clip.endTick === null ? `tick ${String(clip.startTick)}` : `tick ${String(clip.startTick)}–${String(clip.endTick)}`);
  }
  return facts.join(' · ');
}
