import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { AgentBubble, type AgentAssistantEntry, type AgentUserEntry } from './AgentBubble';
import { ASSISTANT_ENTRY, USER_ENTRY } from './agentFixtures.testing';

const USER = USER_ENTRY as AgentUserEntry;
const ASSISTANT = ASSISTANT_ENTRY as AgentAssistantEntry;
const UTC = { timeZone: 'UTC' } as const;

describe('AgentBubble', () => {
  it('puts the user’s message on the right, on the accent plate', () => {
    const html = renderMarkup(<AgentBubble entry={USER} {...UTC} />);

    expect(html).toContain('data-agent-bubble="user"');
    expect(html).toContain('把它压到 30 秒以内');
    expect(html).toContain('ml-auto');
    expect(html).toContain('bg-accent-100');
  });

  it('puts the Agent’s on the left, inside a hairline', () => {
    const html = renderMarkup(<AgentBubble entry={ASSISTANT} {...UTC} />);

    expect(html).toContain('data-agent-bubble="assistant"');
    expect(html).not.toContain('ml-auto');
    expect(html).toContain('border-divider');
  });

  it('stamps the entry with its own time', () => {
    const html = renderMarkup(<AgentBubble entry={USER} {...UTC} />);

    expect(html).toContain('09:44');
    // The machine-readable instant travels with the human one.
    expect(html).toMatch(/<time[^>]*="2026-08-15T09:44:00\.000Z"/u);
  });

  it('names the speaker in words, so the side of the column is not the reading', () => {
    expect(renderMarkup(<AgentBubble entry={USER} {...UTC} />)).toContain('你');
    expect(renderMarkup(<AgentBubble entry={ASSISTANT} {...UTC} />)).toContain('Agent');
  });

  it('lists the Agent’s tool calls by the only typed thing they carry: the name', () => {
    const html = renderMarkup(<AgentBubble entry={ASSISTANT} {...UTC} />);

    expect(html).toContain('data-agent-work-trail');
    expect(html).toContain('read_match_structure');
    expect(html).toContain('read_spatial_evidence');
  });

  it('lets the caller replace the tool calls with steps it can label properly', () => {
    const html = renderMarkup(
      <AgentBubble
        entry={ASSISTANT}
        steps={[{ id: 'structure', label: '读取比赛结构', detail: '24 回合 · 10 名选手' }]}
        {...UTC}
      />,
    );

    expect(html).toContain('读取比赛结构');
    expect(html).not.toContain('read_match_structure');
  });

  it('draws no trail for a bubble with no tool calls', () => {
    const html = renderMarkup(<AgentBubble entry={{ ...ASSISTANT, tool_calls: [] }} {...UTC} />);

    expect(html).not.toContain('data-agent-work-trail');
  });

  it('carries the page’s proposal cards inside the bubble', () => {
    const html = renderMarkup(
      <AgentBubble entry={ASSISTANT} {...UTC}>
        <span>提案卡</span>
      </AgentBubble>,
    );

    expect(html).toContain('提案卡');
  });

  it('draws the inline actions the 手动编辑 artboard puts in a bubble', () => {
    const html = renderMarkup(
      <AgentBubble
        entry={ASSISTANT}
        actions={[
          { id: 'no', label: '不用', onAction: () => undefined },
          { id: 'yes', label: '加上', onAction: () => undefined, primary: true },
        ]}
        {...UTC}
      />,
    );

    expect(html).toContain('data-bubble-actions');
    expect(html).toContain('不用');
    expect(html).toContain('加上');
  });

  it('marks a streaming reply busy and gives it no timestamp it does not have', () => {
    const streaming: AgentAssistantEntry = { ...ASSISTANT, at: '', content: '我把第 2 个镜头' };
    const html = renderMarkup(<AgentBubble entry={streaming} streaming {...UTC} />);

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-bubble-state="streaming"');
    expect(html).toContain('我把第 2 个镜头');
    expect(html).not.toContain('<time');
  });

  it('shows a bar rather than an empty bubble before the first token arrives', () => {
    const html = renderMarkup(<AgentBubble entry={{ ...ASSISTANT, at: '', content: '' }} streaming {...UTC} />);

    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('data-bubble-content');
  });

  it('keeps failed and cancelled turns readable after a reload', () => {
    const failed = renderMarkup(
      <AgentBubble entry={{ ...ASSISTANT, content: '', status: 'failed', error: '模型连接失败' }} {...UTC} />,
    );
    const cancelled = renderMarkup(
      <AgentBubble entry={{ ...ASSISTANT, content: '', status: 'cancelled' }} {...UTC} />,
    );

    expect(failed).toContain('data-bubble-state="failed"');
    expect(failed).toContain('模型连接失败');
    expect(cancelled).toContain('data-bubble-state="cancelled"');
    expect(cancelled).toContain('这次回答已停止');
  });
});
