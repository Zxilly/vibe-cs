import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { WorkspaceEditLine } from './WorkspaceEditLine';
import { EDIT_NOTICE } from './agentFixtures.testing';

const UTC = { timeZone: 'UTC' } as const;

describe('WorkspaceEditLine', () => {
  it('is a line, not a bubble — §4.5.2 says so in as many words', () => {
    const html = renderMarkup(<WorkspaceEditLine notice={EDIT_NOTICE} {...UTC} />);

    expect(html).toContain('data-workspace-edit-line="P-118"');
    expect(html).not.toContain('data-agent-bubble');
  });

  it('writes the artboard’s sentence: 时刻 · 对象 · 改动数 · 已知悉', () => {
    const html = renderMarkup(<WorkspaceEditLine notice={EDIT_NOTICE} {...UTC} />);

    expect(html).toContain('09:47');
    expect(html).toContain('方案');
    expect(html).toContain('2 处改动');
    expect(html).toContain('Agent 已知悉');
  });

  it('names the object kind from the closed set, so a new kind cannot render blank', () => {
    const html = renderMarkup(
      <WorkspaceEditLine notice={{ ...EDIT_NOTICE, object: { kind: 'edit_project', id: 'E-1' } }} {...UTC} />,
    );

    expect(html).toContain('剪辑工程');
  });

  it('keeps the original folded away by default — 「可见，只是不打扰」', () => {
    const html = renderMarkup(<WorkspaceEditLine notice={EDIT_NOTICE} {...UTC} />);

    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('查看发给 Agent 的内容');
    expect(html).not.toContain('data-workspace-edit-original');
  });

  it('shows the typed notice when it opens, not a paraphrase of it', () => {
    const html = renderMarkup(<WorkspaceEditLine notice={EDIT_NOTICE} defaultExpanded {...UTC} />);

    expect(html).toContain('data-workspace-edit-original');
    expect(html).toContain('&quot;type&quot;: &quot;workspace_edit&quot;');
    expect(html).toContain('plan#P-118');
    expect(html).toContain('&quot;revision&quot;: 7');
    expect(html).toContain('起手那段留给建立镜头交代');
  });

  it('scrolls the original sideways inside its own box', () => {
    const html = renderMarkup(<WorkspaceEditLine notice={EDIT_NOTICE} defaultExpanded {...UTC} />);

    expect(html).toContain('overflow-x-auto');
  });

  it('prefers the entry’s stamp when it differs from the notice’s', () => {
    const html = renderMarkup(
      <WorkspaceEditLine notice={EDIT_NOTICE} at="2026-08-15T10:15:00.000Z" {...UTC} />,
    );

    expect(html).toContain('10:15');
  });

  it('handles a notice with a single change without a plural mismatch', () => {
    const one = { ...EDIT_NOTICE, changes: EDIT_NOTICE.changes.slice(0, 1) };
    const html = renderMarkup(<WorkspaceEditLine notice={one} {...UTC} />);

    expect(html).toContain('1 处改动');
  });

  it('labels the one-time Agent generation without calling it a user edit', () => {
    const generated = {
      ...EDIT_NOTICE,
      by: 'agent' as const,
      changes: [{
        shot: 1,
        op: 'inserted' as const,
        field: null,
        from: null,
        to: 'Ace',
      }],
    };
    const html = renderMarkup(<WorkspaceEditLine notice={generated} {...UTC} />);

    expect(html).toContain('Agent 为方案生成了 1 个镜头');
    expect(html).toContain('查看生成记录');
    expect(html).not.toContain('你在方案上做了');
  });
});
