import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AgentProposalConfirmation } from './AgentPage';

describe('AgentProposalConfirmation', () => {
  it('keeps guarded proposal mutations inside the CDP-visible app UI', () => {
    const markup = renderToStaticMarkup(
      <AgentProposalConfirmation
        message="确认保存这个镜头方案？"
        target="Demo demo-1 · 1 镜头"
        actionLabel="保存录制方案"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('Demo demo-1 · 1 镜头');
    expect(markup).toContain('取消');
    expect(markup).toContain('保存录制方案');
    expect(markup).not.toContain('HLAE');
  });
});
