/*
 * pages/ — 恢复中心 (spec §7 `/recovery`, phase 3g).
 *
 * Frame draws no rail entry for it, so the ways in are the command palette
 * (`page.recovery`) and a link from 设置与诊断, which is the entry it lights.
 * That is recorded in `shell/navigation.tsx`; the link from settings is 3g's.
 */

import { Trans } from '@lingui/react/macro';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';
import { RouteLink } from './RouteLink';

export function RecoveryPage() {
  return (
    <Page
      toolbar={
        <Toolbar
          leading={
            <RouteLink to="/settings">
              <Trans>‹ 设置与诊断</Trans>
            </RouteLink>
          }
          title={<Trans>恢复中心</Trans>}
          meta={<Trans>数据库、缓存与中断任务的修复</Trans>}
        />
      }
    >
      <PagePlaceholder
        phase="3g"
        description={
          <Trans>恢复中心处理损坏的索引、残留的中间文件和被中断的任务，每一项都写明它会动什么。</Trans>
        }
      />
    </Page>
  );
}
