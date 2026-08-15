/*
 * pages/ — 10 多轨编辑器 (spec §7 `/editor/:projectId?`, phase 3f).
 *
 * Replaces the pre-redesign `/studio/editor`; the old address redirects here.
 * `/studio` itself is retired without one (§7).
 *
 * The timeline this page will host is `design/timeline/` — the phase 0.5
 * prototype. Its open questions (frame grid, trimming, auto-scroll,
 * virtualisation) are 3f's to answer; nothing here presumes an answer.
 */

import { Trans } from '@lingui/react/macro';
import { useParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';

export function EditorPage() {
  const { projectId } = useParams<{ projectId?: string }>();

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>多轨编辑器</Trans>}
          meta={projectId === undefined ? <Trans>全部工程</Trans> : projectId}
        />
      }
    >
      <PagePlaceholder
        phase="3f"
        description={
          <Trans>编辑器是剃刀、滑移、波纹删除、吸附与多轨拖拽的地方，时间轴在这一阶段接上真实素材。</Trans>
        }
      />
    </Page>
  );
}
