import { beforeEach, describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { AgentRail } from './AgentRail';
import { resetShellStore } from './shellStore';

beforeEach(() => {
  resetShellStore();
});

describe('AgentRail, collapsed', () => {
  it('is the 46px strip Frame draws, and it is the default', () => {
    const html = renderMarkup(<AgentRail />);

    expect(html).toContain('data-agent-rail="collapsed"');
    expect(html).toContain('w-[var(--w-agent-rail)]');
    expect(html).toContain('AI 工作台');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('border-l border-divider');
  });

  it('carries the 「N 待确认」 badge, and drops it at zero', () => {
    expect(renderMarkup(<AgentRail pendingCount={2} />)).toContain('2 待确认');
    expect(renderMarkup(<AgentRail />)).not.toContain('待确认');
  });

  it('says what the button controls', () => {
    const html = renderMarkup(<AgentRail />);

    expect(html).toContain('data-agent-rail-toggle="expand"');
    expect(html).toContain('aria-controls=');
  });
});

describe('AgentRail, expanded', () => {
  it('opens to the Inspector width the spec assigns it', () => {
    const html = renderMarkup(<AgentRail expanded />);

    expect(html).toContain('data-agent-rail="expanded"');
    expect(html).toContain('w-[var(--w-inspector)]');
    expect(html).toContain('h-[var(--h-panel-head)]');
  });

  it('squeezes the page rather than floating over it — the shell contract', () => {
    const html = renderMarkup(<AgentRail expanded />);

    // An in-flow column: no positioning, no scrim, no elevation, and no claim
    // that the rest of the page has gone inert. Every overlay in this system
    // (Dialog, Drawer) has at least one of those; this must have none.
    expect(html).not.toContain('fixed');
    expect(html).not.toContain('absolute');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('shadow-[var(--shadow-lg)]');
    expect(html).toContain('flex-none');
  });

  it('has a header, a labelled region and a close action', () => {
    const html = renderMarkup(<AgentRail expanded />);

    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('data-agent-rail-toggle="collapse"');
    expect(html).toContain('aria-label="收起 AI 工作台"');
    expect(html).toContain('aria-expanded="true"');
  });

  it('holds a body slot for phase 3e and states the boundary in the meantime', () => {
    const html = renderMarkup(
      <AgentRail expanded>
        <p>上下文</p>
      </AgentRail>,
    );

    expect(html).toContain('data-agent-rail-body');
    expect(html).toContain('<p>上下文</p>');
    // The artboard's own footnote.
    expect(html).toContain('这里只显示进度和入口');
  });

  it('renders an empty body without complaint', () => {
    expect(renderMarkup(<AgentRail expanded />)).toContain('data-agent-rail-body');
  });
});
