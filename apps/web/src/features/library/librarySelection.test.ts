import { describe, expect, it, vi } from 'vitest';

import type { DemoLifecycleStatus } from '../../shared/desktop/dto';
import {
  createLibrarySelectionPreflight,
  isDemoAnalyzable,
  librarySelectionIdentity,
  selectionNotice,
  reconcileLibrarySelection,
  toggleLibrarySelection,
} from './librarySelection';

function demo(id: string, status: DemoLifecycleStatus) {
  return { id, status };
}

describe('library analysis selection', () => {
  it.each([
    ['discovered', true],
    ['failed', true],
    ['indexing', false],
    ['analyzing', false],
    ['ready', false],
    ['missing', false],
  ] as const)('allows %s in an analysis batch: %s', (status, expected) => {
    expect(isDemoAnalyzable(status)).toBe(expected);
  });
});

describe('library explicit cross-page selection', () => {
  it('aborts an in-flight preflight on route leave without publishing state or navigation', async () => {
    let resolveDemo!: (value: { id: string; status: DemoLifecycleStatus }) => void;
    const deferredDemo = new Promise<{ id: string; status: DemoLifecycleStatus }>((resolve) => {
      resolveDemo = resolve;
    });
    const writeState = vi.fn();
    const navigate = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const preflight = createLibrarySelectionPreflight();

    const pending = preflight.run(
      ['deferred'],
      async (_id, signal) => {
        requestSignal = signal;
        return deferredDemo;
      },
      {
        onSuccess: () => {
          writeState();
          navigate();
        },
        onFailure: writeState,
      },
    );

    preflight.dispose();
    expect(requestSignal?.aborted).toBe(true);
    resolveDemo(demo('deferred', 'failed'));
    await pending;

    expect(writeState).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('accepts a new preflight after a Strict Mode effect cleanup and setup cycle', async () => {
    const onSuccess = vi.fn();
    const preflight = createLibrarySelectionPreflight();

    preflight.dispose();
    await preflight.run(
      ['current'],
      async (id) => demo(id, 'failed'),
      { onSuccess, onFailure: vi.fn() },
    );

    expect(onSuccess).toHaveBeenCalledWith({ validIds: ['current'], rejected: [] });
  });

  it('publishes only the latest preflight generation', async () => {
    let resolveFirst!: (value: { id: string; status: DemoLifecycleStatus }) => void;
    const firstDemo = new Promise<{ id: string; status: DemoLifecycleStatus }>((resolve) => {
      resolveFirst = resolve;
    });
    const firstSuccess = vi.fn();
    const currentSuccess = vi.fn();
    let firstSignal: AbortSignal | undefined;
    const preflight = createLibrarySelectionPreflight();

    const first = preflight.run(
      ['old'],
      async (_id, signal) => {
        firstSignal = signal;
        return firstDemo;
      },
      { onSuccess: firstSuccess, onFailure: vi.fn() },
    );
    await preflight.run(
      ['current'],
      async (id) => demo(id, 'failed'),
      { onSuccess: currentSuccess, onFailure: vi.fn() },
    );

    expect(firstSignal?.aborted).toBe(true);
    resolveFirst(demo('old', 'failed'));
    await first;
    expect(firstSuccess).not.toHaveBeenCalled();
    expect(currentSuccess).toHaveBeenCalledWith({ validIds: ['current'], rejected: [] });
  });

  it('binds membership to every directory filter while ignoring page, page size, sort, and columns', () => {
    const base = {
      search: ' major ',
      map: 'DE_MIRAGE',
      status: 'failed',
      matchSource: 'faceit',
      tagId: '11111111-1111-4111-8111-111111111111',
      sort: 'updated_desc',
      page: 1,
      pageSize: 20,
      columns: ['map'],
    } as const;

    expect(librarySelectionIdentity(base)).toBe(
      'major\u0000DE_MIRAGE\u0000failed\u0000faceit\u000011111111-1111-4111-8111-111111111111',
    );
    expect(librarySelectionIdentity({
      ...base,
      page: 5,
      pageSize: 200,
      sort: 'file_asc',
      columns: ['score', 'rounds'],
    } as never)).toBe(librarySelectionIdentity(base));
    expect(librarySelectionIdentity({ ...base, search: 'final' } as never))
      .not.toBe(librarySelectionIdentity(base));
    expect(librarySelectionIdentity({ ...base, map: 'de_mirage' } as never))
      .not.toBe(librarySelectionIdentity(base));
    expect(librarySelectionIdentity({ ...base, matchSource: 'valve' } as never))
      .not.toBe(librarySelectionIdentity(base));
    expect(librarySelectionIdentity({ ...base, tagId: '22222222-2222-4222-8222-222222222222' } as never))
      .not.toBe(librarySelectionIdentity(base));
  });

  it('keeps explicit IDs when another page is selected and enforces the analysis batch bound', () => {
    const selected = new Set(Array.from({ length: 12 }, (_, index) => `page-1-${index}`));

    expect(toggleLibrarySelection(selected, 'page-2-1')).toEqual({
      selectedIds: selected,
      changed: false,
      atLimit: true,
    });
    expect(toggleLibrarySelection(selected, 'page-1-4')).toEqual({
      selectedIds: new Set([...selected].filter((id) => id !== 'page-1-4')),
      changed: true,
      atLimit: false,
    });
    const eleven = new Set(Array.from({ length: 11 }, (_, index) => `demo-${index}`));
    expect(toggleLibrarySelection(eleven, 'demo-11')).toEqual({
      selectedIds: new Set([...eleven, 'demo-11']),
      changed: true,
      atLimit: true,
    });
  });

  it('preflights every canonical ID and preserves only service-confirmed analyzable demos', async () => {
    const requested: string[] = [];
    const result = await reconcileLibrarySelection(
      ['failed', 'deleted', 'ready', 'discovered'],
      async (id) => {
        requested.push(id);
        if (id === 'deleted') {
          const error = new Error('not found') as Error & { status: number };
          error.status = 404;
          throw error;
        }
        return demo(id, id as DemoLifecycleStatus);
      },
    );

    expect(requested).toEqual(['failed', 'deleted', 'ready', 'discovered']);
    expect(result.validIds).toEqual(['failed', 'discovered']);
    expect(result.rejected).toEqual([
      { id: 'deleted', reason: 'missing' },
      { id: 'ready', reason: 'not_analyzable' },
    ]);
  });

  it('fails closed when validation cannot prove whether a demo still exists', async () => {
    await expect(reconcileLibrarySelection(
      ['service-unavailable'],
      async () => {
        const error = new Error('offline') as Error & { status: number };
        error.status = 503;
        throw error;
      },
    )).rejects.toThrow('offline');
  });

  it('rejects a service response whose canonical id does not match the requested id', async () => {
    expect(await reconcileLibrarySelection(
      ['requested'],
      async () => demo('different', 'failed'),
    )).toEqual({
      validIds: [],
      rejected: [{ id: 'requested', reason: 'identity_mismatch' }],
    });
  });

  it('reports partial and empty preflight outcomes without claiming rejected demos were analyzed', () => {
    expect(selectionNotice(2, 1)).toEqual({
      tone: 'warning',
      key: 'library.selection.rejected',
      values: { count: 2, valid: 1 },
    });
    expect(selectionNotice(3, 0)).toEqual({
      tone: 'danger',
      key: 'library.selection.noneValid',
      values: {},
    });
    expect(selectionNotice(0, 3)).toBeNull();
  });
});
