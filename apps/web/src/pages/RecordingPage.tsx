/*
 * pages/ — 08 录制计划与镜头预览 (spec §7 `/recording/:taskId?`, phase 3f).
 *
 * The id is optional: the bare path is the plan list, the parametrised one is a
 * single recording task. That is why the rail links to `/recording` and the
 * command palette registers it as a static destination.
 *
 * Replaces the pre-redesign `/queue`, whose label was already 「录制计划」; the
 * old address redirects here.
 */

import { Trans } from '@lingui/react/macro';
import { useParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';

export function RecordingPage() {
  const { taskId } = useParams<{ taskId?: string }>();

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>录制计划</Trans>}
          meta={taskId === undefined ? <Trans>全部录制任务</Trans> : taskId}
        />
      }
    >
      <PagePlaceholder
        phase="3f"
        description={
          <Trans>录制页把镜头逐个排好并给出预览，确认后交给游戏内录制，进度回到任务记录。</Trans>
        }
      />
    </Page>
  );
}
