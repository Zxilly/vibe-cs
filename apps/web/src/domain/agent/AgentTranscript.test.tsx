import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { AgentTranscript } from './AgentTranscript';
import { ASSISTANT_ENTRY, EDIT_ENTRY, USER_ENTRY, makeTranscript } from './agentFixtures.testing';

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

const ENTRIES = [USER_ENTRY, ASSISTANT_ENTRY, EDIT_ENTRY];
const UTC = { timeZone: 'UTC' } as const;

describe('AgentTranscript', () => {
  it('draws two bubbles and one grey line for the three entry kinds', () => {
    const html = renderMarkup(<AgentTranscript entries={ENTRIES} label="会话" {...UTC} />);

    expect(occurrences(html, 'data-agent-bubble=')).toBe(2);
    expect(occurrences(html, 'data-workspace-edit-line=')).toBe(1);
  });

  it('never turns an edit notice into a bubble, whatever the order', () => {
    const html = renderMarkup(<AgentTranscript entries={[EDIT_ENTRY]} label="会话" {...UTC} />);

    expect(html).toContain('data-workspace-edit-line');
    expect(html).not.toContain('data-agent-bubble');
  });

  it('scrolls inside its own column rather than past the shell', () => {
    const html = renderMarkup(<AgentTranscript entries={ENTRIES} label="会话" {...UTC} />);

    expect(html).toContain('overflow-y-auto');
    // …and it has to be allowed to shrink, or the scroll never engages.
    expect(html).toContain('min-h-0');
  });

  it('is a log, and says which session it is', () => {
    const html = renderMarkup(<AgentTranscript entries={ENTRIES} label="会话 · Kael 的 1v3" {...UTC} />);

    expect(html).toContain('role="log"');
    expect(html).toContain('aria-label="会话 · Kael 的 1v3"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-relevant="additions text"');
  });

  it('asks the page what to hang under each bubble', () => {
    const html = renderMarkup(
      <AgentTranscript
        entries={ENTRIES}
        label="会话"
        renderExtras={(entry) => (entry.kind === 'assistant' ? { children: <span>变更卡插槽</span> } : undefined)}
        {...UTC}
      />,
    );

    // Only the assistant entry asked for extras, and only it got them.
    expect(occurrences(html, '变更卡插槽')).toBe(1);
  });

  it('shows the caller’s empty state instead of an empty scroller', () => {
    const html = renderMarkup(<AgentTranscript entries={[]} label="会话" empty={<span>还没有对话</span>} />);

    expect(html).toContain('data-agent-transcript="empty"');
    expect(html).toContain('还没有对话');
  });

  it('appends the reply still arriving, which is not an entry yet', () => {
    const html = renderMarkup(
      <AgentTranscript entries={ENTRIES} streamingContent="我把第 2 个镜头" label="会话" {...UTC} />,
    );

    expect(html).toContain('data-bubble-state="streaming"');
    expect(html).toContain('我把第 2 个镜头');
  });

  it('does not duplicate the persisted streaming turn beside its live bubble', () => {
    const pending = {
      ...ASSISTANT_ENTRY,
      id: 'pending-turn',
      content: '',
      status: 'streaming' as const,
    };
    const html = renderMarkup(
      <AgentTranscript entries={[USER_ENTRY, pending]} streamingContent="正在生成" label="会话" {...UTC} />,
    );

    expect(occurrences(html, 'data-agent-bubble="assistant"')).toBe(1);
    expect(html).toContain('正在生成');
  });

  it('is not empty while a reply is streaming into an empty session', () => {
    const html = renderMarkup(
      <AgentTranscript entries={[]} streamingContent="正在想" label="会话" empty={<span>还没有对话</span>} />,
    );

    expect(html).not.toContain('data-agent-transcript="empty"');
    expect(html).toContain('正在想');
  });

  it('keeps the order the session returned', () => {
    const html = renderMarkup(<AgentTranscript entries={makeTranscript(8)} label="会话" {...UTC} />);
    const first = html.indexOf('data-entry="entry-0"');
    const last = html.indexOf('data-entry="entry-6"');

    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
  });
});
