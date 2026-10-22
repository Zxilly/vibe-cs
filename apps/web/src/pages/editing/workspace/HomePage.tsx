/** Editing workbench: project activity, recovery actions and recent work. */

import { Trans } from '@lingui/react/macro';
import { ArrowRight, FolderOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { Page, Toolbar } from '../../../design/layout';
import { Button } from '../../../design/primitives';
import { ActiveProjectsPanel } from './ActiveProjectsPanel';
import { EnvironmentNotice } from './EnvironmentNotice';
import { FirstRunStrip } from '../../shared/onboarding/FirstRunStrip';
import { HomeFailureNotice } from './HomeFailureNotice';
import { RouteLink } from '../../shared/navigation/RouteLink';

export interface HomePageProps {
  /** The shell's first-run mode choice; the page only decides where it sits. */
  readonly intro?: ReactNode;
}

export function HomePage({ intro }: HomePageProps = {}) {
  const navigate = useNavigate();

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>工作台</Trans>}
          primary={
            <Button variant="primary" size="md" onClick={() => void navigate('/projects/new?step=shotlist')}>
              <Trans>新建作品</Trans>
            </Button>
          }
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6" data-home-layout="three-sections">
        {intro}

        <section className="flex flex-col gap-3" data-home-block="continue">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium"><Trans>继续</Trans></h2>
            <Button asChild variant="ghost" size="sm"><RouteLink to="/projects" className="no-underline"><Trans>全部作品</Trans><ArrowRight size={14} aria-hidden="true" /></RouteLink></Button>
          </div>
          <ActiveProjectsPanel />
        </section>

        <section className="flex flex-col gap-3 border-t border-divider pt-5" data-home-block="new">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium"><Trans>开始选材</Trans></h2>
            <Button asChild variant="secondary" size="sm"><RouteLink to="/library" className="no-underline"><FolderOpen size={16} aria-hidden="true" /><Trans>打开 Demo 资料库</Trans></RouteLink></Button>
          </div>
          <FirstRunStrip />
        </section>

        <EnvironmentNotice />
        <HomeFailureNotice />
      </div>
    </Page>
  );
}
