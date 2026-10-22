import { t } from '@lingui/core/macro';
import { FileVideo2, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Plural, Trans } from '@lingui/react/macro';
import { useHref, useNavigate } from 'react-router-dom';

import { useCreateProject, useProjects, useProjectDeliveryGate } from '../../../data/projects';
import { Empty, Skeleton } from '../../../design/data';
import { Alert, StatusDot, type StatusDotStatus } from '../../../design/feedback';
import { Page, Toolbar } from '../../../design/layout';
import { Button, InputGroup, InputGroupAddon, InputGroupInput, NativeSelect } from '../../../design/primitives';
import { formatTimecode } from '../../../design/timeline';
import type { Project, ProjectDeliveryGate } from '../../../shared/desktop/dto';
import { ProjectOutputLink } from '../../../domain/project/ProjectOutputLink';
import { formatTaskClock } from '../../../domain/task';
import { RouteLink } from '../../shared/navigation/RouteLink';

export function ProjectsPage() {
  const navigate = useNavigate();
  const projects = useProjects();
  const create = useCreateProject();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'updated' | 'name'>('updated');
  const rows = useMemo(() => [...(projects.data ?? [])]
    .filter((project) => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === 'name'
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      : b.updated_at.localeCompare(a.updated_at)), [projects.data, query, sort]);

  const createProject = () => {
    create.mutate(
      { name: t`新作品`, width: 1920, height: 1080, fps: 60, source_demo_ids: [] },
      { onSuccess: (project) => void navigate(`/projects/${encodeURIComponent(project.id)}`) },
    );
  };
  const newProject = (
    <Button variant="primary" size="md" disabled={create.isPending} aria-busy={create.isPending} onClick={createProject}>
      <Plus size={16} aria-hidden="true" />
      {create.isPending ? <Trans>正在创建…</Trans> : <Trans>新建作品</Trans>}
    </Button>
  );

  const search = query.trim();
  const searching = search !== '';

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>作品</Trans>}
          meta={projects.data === undefined ? undefined : <Plural value={rows.length} other="# 个作品" />}
          primary={projects.data?.length === 0 ? undefined : newProject}
        >
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <InputGroup className="max-w-72">
              <InputGroupAddon><Search size={14} aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput type="search" aria-label={t`搜索作品`} placeholder={t`搜索作品…`} value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
            </InputGroup>
            <NativeSelect aria-label={t`作品排序`} size="sm" className="w-32 flex-none" value={sort} onChange={(event) => setSort(event.currentTarget.value as 'updated' | 'name')}>
              <option value="updated"><Trans>最近更新</Trans></option>
              <option value="name"><Trans>名称</Trans></option>
            </NativeSelect>
          </div>
        </Toolbar>
      }
    >
      <div className="flex flex-col gap-5 p-6" data-projects-list>
        {projects.error === null ? null : (
          <Alert variant="danger" action={{ label: projects.isFetching ? <Trans>正在加载…</Trans> : <Trans>重新加载</Trans>, disabled: projects.isFetching, onAction: () => void projects.refetch() }}>
            <Trans>作品列表暂时读不到。</Trans>
          </Alert>
        )}
        {create.error === null ? null : (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, disabled: create.isPending, onAction: createProject }}>
            <Trans>没有创建作品。</Trans>
          </Alert>
        )}

        {projects.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-3">
            <p className="text-sm text-neutral-600"><Trans>正在加载作品…</Trans></p>
            <div className="flex flex-col gap-px border border-divider bg-divider">
              {[0, 1, 2].map((index) => <Skeleton key={index} className="h-[var(--h-row-task)] bg-bg" />)}
            </div>
          </div>
        ) : projects.data === undefined ? null : rows.length === 0 ? searching ? (
          /* A miss is the search's, not the library's: the way out is clearing
             it, and the toolbar already holds the one primary 新建作品. */
          <Empty
            title={<Trans>没有匹配的作品</Trans>}
            description={<Trans>没有名字包含「{search}」的作品。</Trans>}
            actions={
              <Button variant="secondary" onClick={() => setQuery('')}>
                <Trans>清空搜索</Trans>
              </Button>
            }
          />
        ) : (
          <Empty title={<Trans>还没有作品</Trans>} description={<Trans>新建作品后，添加素材开始剪辑。</Trans>} actions={newProject} />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{rows.map((project) => <ProjectCard key={project.id} project={project} />)}</div>
        )}
      </div>
    </Page>
  );
}

/**
 * The card's single material status, read from the same delivery gate the editor
 * header reads: a blocker the recorder can fill is 待录制, any other blocker
 * has to be fixed in the editor, and a gate that is not ready with no blockers
 * is a Timeline without clips.
 */
function nextStep(project: Project, gate: ProjectDeliveryGate): { readonly status: StatusDotStatus; readonly text: string } {
  if (gate.ready) return { status: 'ok', text: t`可以导出` };
  if (gate.blockers.length === 0) return { status: 'idle', text: t`待添加片段` };
  const captured = new Set(project.document.tracks.flatMap((track) => track.clips).filter((clip) => clip.capture_intent !== null).map((clip) => clip.id));
  const recordable = gate.blockers.filter((blocker) => (blocker.state === 'unrecorded' || blocker.state === 'stale') && captured.has(blocker.clip_id)).length;
  return recordable > 0
    ? { status: 'warn', text: t`${recordable} 段待录制` }
    : { status: 'warn', text: t`${gate.blockers.length} 段素材需检查` };
}

function ProjectCard({ project }: { readonly project: Project }) {
  const gate = useProjectDeliveryGate(project.id);
  const editorHref = useHref(`/projects/${encodeURIComponent(project.id)}`);
  const clips = project.document.tracks.flatMap((track) => track.clips).filter((clip) => clip.placement.enabled && clip.text === null);
  const currentGate = gate.data?.revision === project.revision ? gate.data : null;
  const step = currentGate === null || gate.error !== null ? null : nextStep(project, currentGate);
  /*
   * The whole card is the title link's hit area — `after:` stretches the one
   * real anchor over the card, so middle-click, the status bar and the focus
   * ring all stay the anchor's, and nothing is nested inside it. 继续剪辑 and
   * the 成片 link are lifted above that layer so they still take their own click.
   */
  return <article className="relative flex min-w-0 flex-col gap-4 rounded-lg border border-divider bg-bg p-4 transition-colors hover:border-neutral-500 focus-within:border-accent" data-project-card={project.id}>
    <div className="flex min-w-0 items-start gap-3">
      <FileVideo2 size={20} strokeWidth={1.5} className="mt-0.5 flex-none text-neutral-600" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <RouteLink to={`/projects/${encodeURIComponent(project.id)}`} title={project.name} className="block truncate text-base font-medium text-text no-underline after:absolute after:inset-0 after:rounded-lg">{project.name}</RouteLink>
        <p className="mt-1 text-xs tabular-nums text-neutral-600">{project.document.width} × {project.document.height} · {project.document.fps} fps</p>
      </div>
    </div>
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-600">
        <span>
          {clips.length === 0 ? <Trans>还没有素材</Trans> : <Plural value={clips.length} other="# 段素材" />}
        </span>
        <span className="font-mono tabular-nums" aria-label={t`时长`}>{formatTimecode(project.document.duration_seconds)}</span>
      </div>
      {step === null ? <p className="text-xs text-neutral-600">{gate.error !== null ? <Trans>素材状态暂时不可用</Trans> : gate.isFetching ? <Trans>正在检查素材…</Trans> : <Trans>素材状态待更新</Trans>}</p> : <p data-project-next-step={step.status} className="flex min-w-0 items-center gap-2 text-sm text-text">
        <StatusDot status={step.status} /><span className="min-w-0 truncate">{step.text}</span>
      </p>}
    </div>
    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-divider pt-3">
      <time dateTime={project.updated_at} title={t`最近更新`} className="text-xs tabular-nums text-neutral-600">{formatTaskClock(project.updated_at, { now: new Date() })}</time>
      <div className="flex items-center gap-2">
        <ProjectOutputLink projectId={project.id} inline className="relative z-10" />
        <Button asChild size="sm" variant="ghost" className="relative z-10 flex-none">
          <a href={editorHref} data-project-continue><Trans>继续剪辑</Trans></a>
        </Button>
      </div>
    </div>
  </article>;
}
