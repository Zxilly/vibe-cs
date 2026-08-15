/*
 * pages/ — 07 Agent 创作 (spec §7 `/agent?plan=&session=&mode=…`, phase 3e).
 *
 * §7's note on this route is a design decision worth keeping in front of the
 * phase 3e owner: 「顶栏主体是『方案』，会话切换器在左列顶部；会话抽屉是浮层，
 * 不是路由」. So `?session=` selects a session, it does not open one — the
 * drawer's open state stays component state, and only `plan`, `session` and
 * `mode` are addressable.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';
import { pickQueryValue } from './routeQuery';

const AGENT_MODES = ['changes', 'inline', 'takes'] as const;

const MODE_LABEL: Record<(typeof AGENT_MODES)[number], ReactNode> = {
  changes: <Trans>变更列表</Trans>,
  inline: <Trans>就地编辑</Trans>,
  takes: <Trans>候选镜头</Trans>,
};

export function AgentPage() {
  const [params] = useSearchParams();
  const mode = pickQueryValue(params.get('mode'), AGENT_MODES, 'changes');

  return (
    <Page
      toolbar={<Toolbar title={<Trans>Agent 创作</Trans>} meta={MODE_LABEL[mode]} />}
    >
      <PagePlaceholder
        phase="3e"
        description={
          <Trans>
            创作页承载方案、会话与修订：Agent 提出变更，你逐条接受或改写，确认后才进入录制。
          </Trans>
        }
      />
    </Page>
  );
}
