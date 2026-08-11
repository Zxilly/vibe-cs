import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  canCommitOutputLoad,
  canDismissOutputConfirmation,
  ConfirmationDialog,
} from './OutputsPage';

describe('outputs asynchronous guards', () => {
  it('rejects stale and aborted list responses', () => {
    expect(canCommitOutputLoad(7, 7, false)).toBe(true);
    expect(canCommitOutputLoad(6, 7, false)).toBe(false);
    expect(canCommitOutputLoad(7, 7, true)).toBe(false);
  });

  it('keeps a destructive confirmation modal locked while work is active', () => {
    const onCancel = vi.fn();
    const markup = renderToStaticMarkup(
      <ConfirmationDialog
        open
        title="确认删除"
        description="正在处理"
        confirmLabel="删除"
        working
        onCancel={onCancel}
        onConfirm={() => undefined}
      />,
    );

    expect(canDismissOutputConfirmation(true)).toBe(false);
    expect(canDismissOutputConfirmation(false)).toBe(true);
    expect(markup).toContain('aria-busy="true"');
    expect(markup.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
