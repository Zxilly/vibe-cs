/*
 * pages/ — 12 设置与诊断 (spec §7 `/settings?section=…`, phase 3g).
 *
 * §7 names the five sections and records the fifth-round rename: the fourth is
 * 「AI 与 Agent」, split into 模型 / 会话 / 行为边界. The section ids are the
 * addressable part, so they are fixed here and the labels travel with them.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';
import { pickQueryValue } from './routeQuery';

export const SETTINGS_SECTIONS = ['app', 'files', 'game', 'ai', 'advanced'] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const SECTION_LABEL: Record<SettingsSection, ReactNode> = {
  app: <Trans>应用</Trans>,
  files: <Trans>文件与目录</Trans>,
  game: <Trans>游戏与录制</Trans>,
  ai: <Trans>AI 与 Agent</Trans>,
  advanced: <Trans>高级</Trans>,
};

export function SettingsPage() {
  const [params] = useSearchParams();
  const section = pickQueryValue(params.get('section'), SETTINGS_SECTIONS, 'app');

  return (
    <Page
      toolbar={<Toolbar title={<Trans>设置与诊断</Trans>} meta={SECTION_LABEL[section]} />}
    >
      <PagePlaceholder
        phase="3g"
        description={
          <Trans>设置分应用、文件与目录、游戏与录制、AI 与 Agent、高级五节，诊断信息也在这一页。</Trans>
        }
      />
    </Page>
  );
}
