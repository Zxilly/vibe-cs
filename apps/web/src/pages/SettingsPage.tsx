/*
 * pages/ — 12 设置与诊断 (spec §7 `/settings?section=…`, phase 3g).
 *
 * §7 names the five sections and records the fifth-round rename: the fourth is
 * 「AI 与 Agent」, split into 模型 / 会话 / 行为边界. The section ids are the
 * addressable part, so they are fixed here and the labels travel with them.
 *
 * ── The seam phase 3g fills in ────────────────────────────────────────────
 *
 * Phase 3e owns exactly one of the five bodies — 「AI 与 Agent」, because the
 * Agent workspace's retention, take limit and storage controls are part of
 * §4.5 rather than of the settings page. The other four are 3g's, and the shape
 * of the hand-over is `SECTION_BODY`:
 *
 *   · one component per section id, `null` while nobody has written it;
 *   · the component takes **no props** — a section reads what it needs through
 *     `data/**` hooks, the way `AiAgentSection` reads `useAgentWorkspaceSettings`
 *     and `useAppConfig`. Threading a config document down from here would make
 *     every section re-render on every other section's write;
 *   · a `null` entry keeps rendering `PagePlaceholder`, so the shared
 *     `pageSkeleton.test.tsx` assertion (「本页在阶段 3g 实现」, with a way out)
 *     stays true for the four that have not landed. **Flipping that page's
 *     `built` flag is 3g's last step, not this one's**: `/settings` renders
 *     `app` by default and `app` is still a placeholder.
 *
 * So 3g adds four files under `pages/settings/`, writes four names into
 * `SECTION_BODY`, and touches nothing else here.
 *
 * The rail is `design/layout/SubNav`, which is the artboard's 190px column of
 * 38px rows and folds to tabs at §8's breakpoint on its own — there is no media
 * query in this file.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Page, SubNav, Toolbar, useCollapsed } from '../design/layout';
import { pickQueryValue } from './routeQuery';
import { AdvancedSection } from './settings/AdvancedSection';
import { AiAgentSection } from './settings/AiAgentSection';
import { AppSection } from './settings/AppSection';
import { FilesSection } from './settings/FilesSection';
import { GameSection } from './settings/GameSection';
import {
  SETTINGS_ITEM_SECTION,
  SETTINGS_SECTIONS,
  type SettingsItem,
  type SettingsSection,
} from './settings/settingsRoutes';

export { SETTINGS_SECTIONS, settingsPath } from './settings/settingsRoutes';
export type { SettingsItem, SettingsSection } from './settings/settingsRoutes';

/* The fifth round renamed two of these — 「文件与资料库」 and 「高级与诊断」 —
   in the 「补齐 · Agent 会话历史与设置」 board. */
const SECTION_LABEL: Record<SettingsSection, ReactNode> = {
  app: <Trans>应用</Trans>,
  files: <Trans>文件与资料库</Trans>,
  game: <Trans>游戏与录制</Trans>,
  ai: <Trans>AI 与 Agent</Trans>,
  advanced: <Trans>高级与诊断</Trans>,
};

/**
 * What each section renders. All five are written, so there is no absent arm:
 * a section that lost its component would be a compile error here rather than
 * a pane telling the reader which internal phase was meant to build it.
 */
const SECTION_BODY: Record<SettingsSection, ComponentType> = {
  app: AppSection,
  files: FilesSection,
  game: GameSection,
  ai: AiAgentSection,
  advanced: AdvancedSection,
};

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const item = params.get('item');
  const itemSection = item === null ? undefined : SETTINGS_ITEM_SECTION[item as SettingsItem];
  const section = itemSection ?? pickQueryValue(params.get('section'), SETTINGS_SECTIONS, 'app');
  const Body = SECTION_BODY[section];
  const collapsed = useCollapsed(undefined);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (item === null) return;
    const target = [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-setting-item], [data-setting]') ?? [])]
      .find((node) => node.dataset['settingItem'] === item || node.dataset['setting'] === item);
    if (target === undefined) return;
    target.dataset['settingTarget'] = 'true';
    target.classList.add('outline', 'outline-2', 'outline-accent', '-outline-offset-2', 'scroll-mt-3');
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    return () => {
      delete target.dataset['settingTarget'];
      target.classList.remove('outline', 'outline-2', 'outline-accent', '-outline-offset-2', 'scroll-mt-3');
    };
  }, [item, section]);

  useEffect(() => {
    if (itemSection === undefined || params.get('section') === itemSection) return;
    const next = new URLSearchParams(params);
    next.set('section', itemSection);
    setParams(next, { replace: true });
  }, [itemSection, params, setParams]);

  const sectionNav = (
    <SubNav
      label={t`设置分节`}
      activeId={section}
      items={SETTINGS_SECTIONS.map((id) => ({ id, label: SECTION_LABEL[id] }))}
      onSelect={(id) => {
        const next = new URLSearchParams(params);
        next.set('section', id);
        next.delete('item');
        setParams(next);
      }}
      collapsed={collapsed}
    />
  );

  return (
    <Page
      scroll={false}
      toolbar={<Toolbar title={<Trans>设置与诊断</Trans>} meta={SECTION_LABEL[section]} />}
      bar={collapsed ? sectionNav : null}
    >
      <div className="flex min-h-0 min-w-0 flex-1">
        {collapsed ? null : sectionNav}
        <div ref={contentRef} data-settings-content className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Body />
        </div>
      </div>
    </Page>
  );
}
