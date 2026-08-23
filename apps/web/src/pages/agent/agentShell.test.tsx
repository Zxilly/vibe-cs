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

import { AgentWorkspace } from '../AgentPage';
import { renderMarkup } from '../../test/render';
import { PANEL_WIDTH_PX } from '../../design/tokens.data';

function at(url: string): string {
  return renderMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/agent" element={<AgentWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the toolbar', () => {
  it('labels the empty workspace as ready to prepare a first draft', () => {
    const html = at('/agent');
    expect(html).toContain('准备创作');
    expect(html).toContain('Agent 创作');
  });

  it('keeps the address mode as state without showing result controls before a result exists', () => {
    expect(at('/agent')).toContain('data-agent-mode="changes"');
    expect(at('/agent?mode=inline')).toContain('data-agent-mode="inline"');
    expect(at('/agent?mode=takes')).toContain('data-agent-mode="takes"');
  });

  it('falls back to the changes state for a mode nobody defined', () => {
    expect(at('/agent?mode=diff')).toContain('data-agent-mode="changes"');
  });

  it('does not let a future recording action compete with the first-draft action', () => {
    const html = at('/agent?plan=P-118');
    expect(html).not.toContain('确认剪辑单并录制');
    expect(html).toContain('生成剪辑单');
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

  it('uses one start canvas until a plan or proposal exists', () => {
    const html = at('/agent');
    expect(html).toContain('data-agent-start-canvas');
    expect(html).not.toContain(`flex-basis:${String(PANEL_WIDTH_PX['--w-inspector-wide'])}px`);
  });
});
