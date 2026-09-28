/** Editing workbench: project activity, recovery actions and recent work. */

import { Trans } from '@lingui/react/macro';
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
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6" data-home-layout="three-sections">
        {intro}
        <EnvironmentNotice />
        <HomeFailureNotice />

        <section className="flex flex-col gap-3 border-t border-divider pt-5" data-home-block="continue">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium"><Trans>继续</Trans></h2>
            <RouteLink to="/projects" size="sm"><Trans>全部作品</Trans></RouteLink>
          </div>
          <ActiveProjectsPanel />
        </section>

        <section className="flex flex-col gap-3 border-t border-divider pt-5" data-home-block="new">
          <h2 className="text-lg font-medium"><Trans>开始选材</Trans></h2>
          <p className="max-w-prose text-sm leading-relaxed text-neutral-600"><Trans>从 Demo 中找到精彩片段，加入作品后录制并导出成片。</Trans></p>
          <div className="flex flex-wrap items-center gap-3">
            <RouteLink to="/library" size="sm"><Trans>导入 Demo</Trans></RouteLink>
          </div>
          <FirstRunStrip />
        </section>
      </div>
    </Page>
  );
}
