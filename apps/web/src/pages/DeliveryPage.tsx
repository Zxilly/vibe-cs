/*
 * pages/ — 11 输出与任务记录 (spec §7 `/delivery?view=outputs|tasks`, phase 3a).
 *
 * §7 merges the pre-redesign `/outputs` and `/activity` into one route with two
 * views, and Frame lists both as separate rail entries pointing at the same
 * path with different queries — which is why `shell/navigation.tsx` matches on
 * the query as well as the pathname. Both old addresses redirect here.
 */

import { Trans } from '@lingui/react/macro';
import { useSearchParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';
import { pickQueryValue } from './routeQuery';

const DELIVERY_VIEWS = ['outputs', 'tasks'] as const;

export function DeliveryPage() {
  const [params] = useSearchParams();
  const view = pickQueryValue(params.get('view'), DELIVERY_VIEWS, 'outputs');

  return (
    <Page
      toolbar={
        <Toolbar
          title={view === 'tasks' ? <Trans>任务记录</Trans> : <Trans>输出</Trans>}
          meta={
            view === 'tasks' ? (
              <Trans>分析、录制与导出的执行记录</Trans>
            ) : (
              <Trans>已生成的成片，链接回它的来源任务</Trans>
            )
          }
        />
      }
    >
      <PagePlaceholder
        phase="3a"
        description={
          <Trans>交付页把成片和产生它的任务放在一起：从一条输出可以回到它的阶段日志，反过来也一样。</Trans>
        }
      />
    </Page>
  );
}
