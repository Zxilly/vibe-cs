/*
 * pages/ — 02 Demo 资料库 (spec §7 `/library?view=table|card`, phase 3b).
 *
 * The artboard's toolbar is 「Demo 资料库 · 248 场 · 3 个监听目录 … 导入 Demo」:
 * title, a muted count line, a table/card switch, and 导入 Demo as the primary
 * action. Counts need `data/demos.ts` and 导入 Demo needs a file dialog, so this
 * round wires the part that is already decidable — which of the two §7 views
 * the address selects — and leaves the rest of the bar to phase 3b.
 */

import { Trans } from '@lingui/react/macro';
import { useSearchParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';
import { pickQueryValue } from './routeQuery';

const LIBRARY_VIEWS = ['table', 'card'] as const;

export function LibraryPage() {
  const [params] = useSearchParams();
  const view = pickQueryValue(params.get('view'), LIBRARY_VIEWS, 'table');

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>Demo 资料库</Trans>}
          meta={view === 'card' ? <Trans>卡片视图</Trans> : <Trans>表格视图</Trans>}
        />
      }
    >
      <PagePlaceholder
        phase="3b"
        description={
          <Trans>
            资料库列出已导入的比赛，右侧 Inspector 承载单场详情，导入与目录监听也在这一页。
          </Trans>
        }
      />
    </Page>
  );
}
