import { Trans } from '@lingui/react/macro';
import { useParams } from 'react-router-dom';

import { Empty } from '../design/data';
import { Page, Toolbar } from '../design/layout';
import { RouteLink } from './RouteLink';

/** IA-06 only makes card destinations live; IA-07 replaces this body with the step workspace. */
export function ProjectWorkspacePage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return (
    <Page toolbar={<Toolbar title={<Trans>作品工作区</Trans>} meta={projectId} />}>
      <div className="p-7">
        <Empty
          title={<Trans>作品工作区</Trans>}
          description={<Trans>选材、剪辑单、录制与导出会在这里汇合。</Trans>}
          actions={<RouteLink to="/projects"><Trans>返回作品列表</Trans></RouteLink>}
        />
      </div>
    </Page>
  );
}
