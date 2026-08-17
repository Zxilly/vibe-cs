/*
 * `markup` project — the `/agent` shell: what it renders before any of the
 * three blocks exists.
 *
 * The per-page skeleton assertions (Page slots, the phase notice, no invented
 * data) live in `pages/pageSkeleton.test.tsx` for all fifteen routes. What is
 * here is specific to this page: the toolbar's subject, the mode read out of
 * `?mode=`, both block placeholders, and the main action's written reason.
 */

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AgentPage } from '../AgentPage';
import { renderMarkup } from '../../test/render';
import { PANEL_WIDTH_PX } from '../../design/tokens.data';

function at(url: string): string {
  return renderMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/agent" element={<AgentPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the toolbar', () => {
  it('says no plan is selected instead of pretending to load one', () => {
    const html = at('/agent');
    expect(html).toContain('尚未选择方案');
    expect(html).toContain('Agent 创作');
  });

  it('prints the mode the address asked for', () => {
    expect(at('/agent')).toContain('变更列表');
    expect(at('/agent?mode=inline')).toContain('就地编辑');
    expect(at('/agent?mode=takes')).toContain('候选镜头');
  });

  it('falls back to 变更列表 for a mode nobody defined', () => {
    expect(at('/agent?mode=diff')).toContain('变更列表');
  });

  it('keeps 「确认并生成视频」 on the bar, disabled, with the reason attached', () => {
    const html = at('/agent?plan=P-118');
    expect(html).toContain('确认并生成视频');
    expect(html).toContain('disabled');
    /* 「不隐藏、不静默失败」 — the reason is on the element, not in a tooltip
       nobody can read. This markup renders before the bridge answers, so the
       reason here is the service one; the two plan-shaped refusals are pinned
       in `agentShell.interaction.test.tsx`, which has a plan to refuse. */
    expect(html).toContain('正在连接本地服务');
  });
});

describe('the three blocks', () => {
  /* Phase 3e landed the blocks themselves, so the placeholder this used to
     assert is gone. What is left for the shell to prove is that the content
     column is block A and that it received the address — the blocks' own
     contents are asserted in their own files. */
  it('mounts the conversation block in the content column', () => {
    const html = at('/agent?mode=takes');
    expect(html).toContain('data-agent-block="conversation"');
    expect(html).toContain('data-agent-mode="takes"');
  });

  it('renders the plan panel as the page\'s companion column', () => {
    // The §3.5 token, in the real pixels `SplitPane` now opens at.
    expect(at('/agent')).toContain(`flex-basis:${String(PANEL_WIDTH_PX['--w-inspector-wide'])}px`);
  });
});
