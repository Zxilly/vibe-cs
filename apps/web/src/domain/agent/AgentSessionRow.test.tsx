import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { AgentSessionRow } from './AgentSessionRow';
import { SESSION_SUMMARY } from './agentFixtures.testing';

const UTC = { timeZone: 'UTC' } as const;
const NOW = new Date('2026-08-15T10:00:00.000Z');

describe('AgentSessionRow', () => {
  it('writes the title, the stamp and how much conversation is behind it', () => {
    const html = renderMarkup(<AgentSessionRow session={SESSION_SUMMARY} now={NOW} {...UTC} />);

    expect(html).toContain('Kael 的 1v3');
    expect(html).toContain('09:02');
    expect(html).toContain('共 18 条对话');
  });

  it('lists the objects the session touched — 「每条下方是它触及过的对象」', () => {
    const html = renderMarkup(<AgentSessionRow session={SESSION_SUMMARY} now={NOW} {...UTC} />);

    expect(html).toContain('data-session-refs="2"');
    expect(html).toContain('方案 #P-118');
    expect(html).toContain('改过 2 次');
    expect(html).toContain('录制任务 #A-2481');
  });

  it('marks the session the page is currently in', () => {
    const html = renderMarkup(<AgentSessionRow session={SESSION_SUMMARY} current now={NOW} {...UTC} />);

    expect(html).toContain('data-session-current');
    expect(html).toContain('当前');
    expect(html).toContain('aria-current="true"');
  });

  it('says 「昨天」 in words, and keeps the time in the title', () => {
    const yesterday = { ...SESSION_SUMMARY, updated_at: '2026-08-14T21:40:00.000Z' };
    const html = renderMarkup(<AgentSessionRow session={yesterday} now={NOW} {...UTC} />);

    expect(html).toContain('data-stamp="yesterday"');
    expect(html).toContain('昨天');
    expect(html).toContain('title="21:40"');
  });

  it('falls back to the date for an older session', () => {
    const older = { ...SESSION_SUMMARY, updated_at: '2026-08-13T18:00:00.000Z' };
    const html = renderMarkup(<AgentSessionRow session={older} now={NOW} {...UTC} />);

    expect(html).toContain('08-13');
  });

  it('draws no ref list for a session that has touched nothing', () => {
    const html = renderMarkup(<AgentSessionRow session={{ ...SESSION_SUMMARY, refs: [] }} now={NOW} {...UTC} />);

    expect(html).not.toContain('data-session-refs');
  });

  it('carries the page’s own row actions', () => {
    const html = renderMarkup(
      <AgentSessionRow session={SESSION_SUMMARY} now={NOW} actions={<span>重命名</span>} {...UTC} />,
    );

    expect(html).toContain('重命名');
  });

  it('clips a long title instead of pushing the drawer wide', () => {
    const html = renderMarkup(
      <AgentSessionRow
        session={{ ...SESSION_SUMMARY, title: 'Kael 的 1v3 · 一个长到必须截断的会话标题' }}
        now={NOW}
        {...UTC}
      />,
    );

    expect(html).toContain('truncate');
  });
});
