/*
 * pages/ — 09 快速合辑 (spec §7 `/montage/:projectId?`, phase 3f).
 */

import { Trans } from '@lingui/react/macro';
import { useParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';

export function MontagePage() {
  const { projectId } = useParams<{ projectId?: string }>();

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>快速合辑</Trans>}
          meta={projectId === undefined ? <Trans>全部合辑</Trans> : projectId}
        />
      }
    >
      <PagePlaceholder
        phase="3f"
        description={
          <Trans>合辑用一条模板把选中的片段串起来，不进多轨编辑器也能直接导出。</Trans>
        }
      />
    </Page>
  );
}
