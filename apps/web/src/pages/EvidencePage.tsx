/*
 * pages/ — 05 证据检索 (spec §7 `/evidence?view=evidence|annotations`, phase 3d).
 *
 * Replaces the pre-redesign `/evidence-search`; the old address redirects here.
 */

import { Trans } from '@lingui/react/macro';
import { useSearchParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';
import { pickQueryValue } from './routeQuery';

const EVIDENCE_VIEWS = ['evidence', 'annotations'] as const;

export function EvidencePage() {
  const [params] = useSearchParams();
  const view = pickQueryValue(params.get('view'), EVIDENCE_VIEWS, 'evidence');

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>证据检索</Trans>}
          meta={view === 'annotations' ? <Trans>注释</Trans> : <Trans>证据</Trans>}
        />
      }
    >
      <PagePlaceholder
        phase="3d"
        description={
          <Trans>按选手、事件类型和时间范围跨比赛检索证据，命中的片段可以直接加入视频。</Trans>
        }
      />
    </Page>
  );
}
