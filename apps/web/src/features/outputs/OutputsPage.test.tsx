import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import {
  boundedOutputPage,
  canCommitOutputLoad,
  canDismissOutputConfirmation,
  ConfirmationDialog,
  OutputZeroActions,
  outputWorkspacePresentation,
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

  it('collapses a truly empty output library without hiding filtered-empty controls', () => {
    expect(outputWorkspacePresentation({
      loading: false,
      itemCount: 0,
      total: 0,
      hasFilters: false,
      loadFailed: false,
    })).toEqual({
      mode: 'zero',
      showFilters: false,
      showCollectionControls: false,
      showStagedCleanup: true,
    });

    expect(outputWorkspacePresentation({
      loading: false,
      itemCount: 0,
      total: 0,
      hasFilters: true,
      loadFailed: false,
    })).toEqual({
      mode: 'filtered-empty',
      showFilters: true,
      showCollectionControls: false,
      showStagedCleanup: false,
    });

    expect(outputWorkspacePresentation({
      loading: false,
      itemCount: 1,
      total: 1,
      hasFilters: false,
      loadFailed: false,
    })).toEqual({
      mode: 'results',
      showFilters: true,
      showCollectionControls: true,
      showStagedCleanup: false,
    });

    expect(outputWorkspacePresentation({
      loading: false,
      itemCount: 0,
      total: 0,
      hasFilters: false,
      loadFailed: true,
    })).toEqual({
      mode: 'error',
      showFilters: false,
      showCollectionControls: false,
      showStagedCleanup: false,
    });
  });

  it('returns to the last real page after cleanup removes an entire trailing page', () => {
    expect(boundedOutputPage(2, 30, 30)).toBe(1);
    expect(boundedOutputPage(2, 31, 30)).toBe(2);
    expect(boundedOutputPage(1, 0, 30)).toBe(1);
  });

  it('keeps staged-file recovery reachable in a truly empty output library', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <OutputZeroActions working={false} onCleanupStaged={() => undefined} />
      </MemoryRouter>,
    );

    expect(markup).toContain('href="/production"');
    expect(markup).toContain('data-action="cleanup-staged"');
  });
});
