/** Editing workbench: project activity, recovery actions and recent work. */

import { Trans } from '@lingui/react/macro';
import { ArrowRight, FolderOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useProjects } from '../../../data/projects';
import { Page, Toolbar } from '../../../design/layout';
import { Button } from '../../../design/primitives';
import { ActiveProjectsPanel } from './ActiveProjectsPanel';
import { EnvironmentNotice } from './EnvironmentNotice';
import { FirstRunStrip, useEmptyLibrary } from '../../shared/onboarding/FirstRunStrip';
import { HomeFailureNotice } from './HomeFailureNotice';
import { RecentDemosPanel } from './RecentDemosPanel';
import { RouteLink } from '../../shared/navigation/RouteLink';

export interface HomePageProps {
  /** The shell's first-run mode choice; the page only decides where it sits. */
  readonly intro?: ReactNode;
}

/*
 * Where to start depends on what already exists, and only a *successful*
 * empty read counts as "nothing": a pending or failed read keeps the
 * returning-user layout, so nobody with work is told to start over.
 *
 *   existing 作品    继续 comes first; 开始选材 follows.
 *   Demos, no 作品    继续 has nothing to continue and is left out; 开始选材
 *                    leads and says how its rows become the first 作品.
 *   empty library    the first-run panel takes the one primary action
 *                    (import, in place). 新建作品 stays reachable as a
 *                    secondary toolbar action — an empty 作品 is still a
 *                    valid start, just not the one to lead with when there is
 *                    no material to put in it.
 */
export function HomePage({ intro }: HomePageProps = {}) {
  const navigate = useNavigate();
  const libraryEmpty = useEmptyLibrary();
  const projects = useProjects();
  const noProjects = projects.isSuccess && projects.data.length === 0;
  const newProject = () => void navigate('/projects/new');

  return (
    <Page
      scroll={false}
      toolbar={
        libraryEmpty ? (
          <Toolbar
            title={<Trans>工作台</Trans>}
            actions={[{
              id: 'new-project',
              label: <Trans>新建作品</Trans>,
              onSelect: newProject,
              control: <Button onClick={newProject}><Trans>新建作品</Trans></Button>,
            }]}
            inlineActionsWhenCollapsed={1}
          />
        ) : (
          <Toolbar
            title={<Trans>工作台</Trans>}
            primary={
              <Button variant="primary" size="md" onClick={newProject}>
                <Trans>新建作品</Trans>
              </Button>
            }
          />
        )
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6" data-home-layout="three-sections">
        {intro}

        {noProjects ? null : (
          <section className="flex flex-col gap-3" data-home-block="continue">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-medium"><Trans>继续</Trans></h2>
              <Button asChild variant="ghost" size="sm"><RouteLink to="/projects" className="no-underline"><Trans>全部作品</Trans><ArrowRight size={14} aria-hidden="true" /></RouteLink></Button>
            </div>
            <ActiveProjectsPanel />
          </section>
        )}

        <FirstRunStrip />
        {libraryEmpty ? null : (
          <section
            className={noProjects ? 'flex flex-col gap-3' : 'flex flex-col gap-3 border-t border-divider pt-5'}
            data-home-block="new"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <h2 className="text-lg font-medium"><Trans>开始选材</Trans></h2>
                {noProjects ? (
                  <p className="text-sm text-neutral-600">
                    <Trans>打开一场可选材的比赛，挑选片段加入作品，第一份作品就从这里开始。</Trans>
                  </p>
                ) : null}
              </div>
              <Button asChild variant="secondary" size="sm"><RouteLink to="/library" className="no-underline"><FolderOpen size={16} aria-hidden="true" /><Trans>打开 Demo 资料库</Trans></RouteLink></Button>
            </div>
            <RecentDemosPanel />
          </section>
        )}

        <EnvironmentNotice />
        <HomeFailureNotice />
      </div>
    </Page>
  );
}
