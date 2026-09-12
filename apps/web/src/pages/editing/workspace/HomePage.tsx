/** Editing workbench: project activity, recovery actions and recent work. */

import { Trans } from '@lingui/react/macro';
import { useNavigate } from 'react-router-dom';

import { Page, Toolbar } from '../../../design/layout';
import { Button } from '../../../design/primitives';
import { ActiveProjectsPanel } from './ActiveProjectsPanel';
import { EnvironmentNotice } from './EnvironmentNotice';
import { FirstRunStrip } from '../../shared/onboarding/FirstRunStrip';
import { HomeFailureNotice } from './HomeFailureNotice';
import { RouteLink } from '../../shared/navigation/RouteLink';

export function HomePage() {
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
        <EnvironmentNotice />
        <HomeFailureNotice />

        <section className="flex flex-col gap-3 border-t border-divider pt-5" data-home-block="continue">
          <h2 className="text-lg font-medium"><Trans>继续</Trans></h2>
          <ActiveProjectsPanel />
        </section>

        <section className="flex flex-col gap-3 border-t border-divider pt-5" data-home-block="new">
          <div className="flex flex-wrap items-center gap-3">
            <RouteLink to="/library" size="sm"><Trans>导入 Demo</Trans></RouteLink>
          </div>
          <FirstRunStrip />
        </section>
      </div>
    </Page>
  );
}
