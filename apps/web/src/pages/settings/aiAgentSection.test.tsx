/*
 * `markup` project — 设置 · AI 与 Agent, and the seam that mounts it.
 *
 * Rendered with an empty cache and no service, which is the honest first frame:
 * the three blocks exist, the locked switch is already true (it is a rule, not
 * a stored value, so it needs nothing from the backend), and every stored field
 * is a skeleton rather than a zero.
 */

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { SettingsPage } from '../SettingsPage';
import { AiAgentSection } from './AiAgentSection';

function section(): string {
  return renderMarkup(<AiAgentSection />);
}

function settingsAt(url: string): string {
  return renderMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the three blocks the fifth round split the section into', () => {
  it('draws 模型 / 会话 / 行为边界', () => {
    const html = section();
    expect(html).toContain('模型');
    expect(html).toContain('会话');
    expect(html).toContain('行为边界');
  });

  /* The stored controls — the retention `Seg`, the take slider and 立即应用 —
     only exist once `getAgentWorkspaceSettings` has answered, so they are
     asserted in `aiAgentSection.interaction.test.tsx` where a stub can answer.
     What belongs here is that their *absence* is a skeleton rather than a
     control showing made-up defaults. */
  it('offers 导出 and 清空会话 whatever the settings read says', () => {
    const html = section();
    expect(html).toContain('data-setting-action="clear"');
    expect(html).toContain('data-setting-action="export"');
  });

  it('disables the service-backed actions and writes the reason', () => {
    const html = section();
    expect(html).toContain('· 需要服务');
    expect(html).toContain('此动作当前不可用');
  });
});

describe('§4.5.3 rule ① on the panel', () => {
  it('draws 录制前始终由你确认 on, unreachable, with the reason beside it', () => {
    const html = section();
    expect(html).toContain('data-setting="recording-confirmation"');
    expect(html).toContain('aria-checked="true"');
    /* `design/primitives/Toggle`'s `locked` treatment: the switch reports
       itself disabled to assistive technology and refuses the click, rather
       than being greyed out as if a setting had failed to load. */
    expect(html).toContain('data-locked="true"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('不可关闭');
    expect(html).toContain('必须有一次人工确认');
  });
});

describe('the empty cache', () => {
  it('shows skeletons rather than zeroes for the stored fields', () => {
    const html = section();
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('0 B');
    expect(html).not.toContain('role="progressbar"');
  });
});

describe('the settings seam', () => {
  it('mounts the section at ?section=ai', () => {
    const html = settingsAt('/settings?section=ai');
    expect(html).toContain('data-settings-section="ai"');
    expect(html).toContain('AI 与 Agent');
    expect(html).not.toContain('本页在阶段 3g 实现');
  });

  it('renders each section’s own body, and never the AI one by accident', () => {
    /* All five landed in phase 3g. What is still worth pinning is that the
       rail's selection actually changes the body: an `?section=` that fell
       through to a default would look like a working page. */
    /* Each marker is a *block heading*, which renders before the config
       arrives. A row label would not: with no service these panes are all
       skeletons, and asserting on one would be asserting that the fetch
       resolved rather than that the right section mounted. */
    for (const [id, marker] of [
      ['app', '外观与语言'],
      ['files', '监听目录'],
      ['game', '录制默认值'],
      ['advanced', '依赖检查'],
    ] as const) {
      const html = settingsAt(`/settings?section=${id}`);
      expect(html).toContain(marker);
      expect(html).not.toContain('data-settings-section="ai"');
      expect(html).not.toContain('本页在阶段 3g 实现');
    }
  });

  it('keeps §7’s five sections reachable from the rail', () => {
    const html = settingsAt('/settings');
    expect(html).toContain('data-subnav="rail"');
    for (const id of ['app', 'files', 'game', 'ai', 'advanced']) {
      expect(html).toContain(`data-subnav-item="${id}"`);
    }
  });
});
