import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { AgentObjectRefChip } from './AgentObjectRefChip';
import { OBJECT_REF_PLAN, OBJECT_REF_TASK } from './agentFixtures.testing';

describe('AgentObjectRefChip', () => {
  it('prints the server’s label as it arrived', () => {
    const html = renderMarkup(<AgentObjectRefChip objectRef={OBJECT_REF_PLAN} />);

    expect(html).toContain('方案 #P-118');
    expect(html).toContain('data-agent-object-ref="P-118"');
    expect(html).toContain('data-object-kind="plan"');
  });

  it('says the kind through an icon plus a screen-reader word, not a prefix', () => {
    const html = renderMarkup(<AgentObjectRefChip objectRef={OBJECT_REF_TASK} />);

    // 「录制任务 #A-2481」 must not become 「录制任务 录制任务 #A-2481」.
    expect(html.split('录制任务').length - 1).toBe(2);
    expect(html).toContain('sr-only');
  });

  it('shows 「改过 N 次」 only when there is more than one touch', () => {
    expect(renderMarkup(<AgentObjectRefChip objectRef={OBJECT_REF_PLAN} />)).toContain('改过 2 次');
    // 「改过 1 次」 is noise on every chip in the drawer.
    expect(renderMarkup(<AgentObjectRefChip objectRef={OBJECT_REF_TASK} />)).not.toContain('改过');
  });

  it('never prints the free-text status, which has no closed set behind it', () => {
    const html = renderMarkup(<AgentObjectRefChip objectRef={OBJECT_REF_PLAN} />);

    expect(html).not.toContain('等待确认');
    expect(html).not.toContain('data-status');
  });

  it('is a span until it does something, then a button', () => {
    expect(renderMarkup(<AgentObjectRefChip objectRef={OBJECT_REF_PLAN} />)).not.toContain('<button');
    expect(renderMarkup(<AgentObjectRefChip objectRef={OBJECT_REF_PLAN} onSelect={() => undefined} />)).toContain(
      '<button',
    );
  });

  it('clips a long label rather than pushing the row wide', () => {
    const html = renderMarkup(
      <AgentObjectRefChip objectRef={{ ...OBJECT_REF_PLAN, label: '方案 #P-118 · 一个长到必须截断的方案名' }} />,
    );

    expect(html).toContain('truncate');
  });
});
