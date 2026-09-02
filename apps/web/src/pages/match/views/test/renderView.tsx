/*
 * Test-only harness for a single match view.
 *
 * `pages/match/test/renderWorkspace.tsx` mounts the whole shell, which is what
 * the shell's own tests need. A view test wants the opposite: the view alone,
 * with the five props `MatchViewProps` promises and a router under it (three of
 * these views use `RouteLink` or `useNavigate`), so an assertion is about the
 * view and not about the rail beside it.
 *
 * The queries themselves are replaced per file with `vi.mock('…/data/match')`.
 * Stubbing the IPC client instead would leave every read pending through a
 * synchronous `renderToStaticMarkup`, which would make every `markup` test an
 * assertion about the loading state — see `queryResult` below for the shape the
 * mocks return.
 */

import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { renderInteractive, renderMarkup } from '../../../../test/render';
import type { MatchContextPatch, MatchWorkspaceContext } from '../../workspaceContext';
import type { MatchContextUpdateOptions, MatchViewProps } from '../../viewContract';
import { DEMO_ID } from './fixtures';

export const ADD_TO_VIDEO_REASON = '录制队列尚未接通';

export interface ViewPropsOverrides {
  readonly context?: Partial<MatchWorkspaceContext> | undefined;
  readonly updateContext?:
    | ((patch: MatchContextPatch, options?: MatchContextUpdateOptions) => void)
    | undefined;
  readonly collapsed?: boolean | undefined;
  readonly onAdd?: ((selection: unknown) => void) | undefined;
  readonly addDisabled?: boolean | undefined;
}

/** The five props the shell hands a view, with the workspace's real defaults. */
export function viewProps(overrides: ViewPropsOverrides = {}): MatchViewProps {
  return {
    demoId: DEMO_ID,
    context: {
      view: 'replay',
      round: null,
      player: null,
      tick: null,
      evidence: null,
      ...overrides.context,
    },
    updateContext: overrides.updateContext ?? vi.fn(),
    addToVideo: {
      disabled: overrides.addDisabled ?? true,
      ...((overrides.addDisabled ?? true) ? { disabledReason: ADD_TO_VIDEO_REASON } : {}),
      ...(overrides.onAdd === undefined ? {} : { onAdd: overrides.onAdd }),
    },
    collapsed: overrides.collapsed ?? false,
  };
}

export function markupView(node: ReactElement): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

export function renderView(node: ReactElement): RenderResult {
  return renderInteractive(<MemoryRouter>{node}</MemoryRouter>);
}

/**
 * The slice of a TanStack query result these views read, in a settled shape.
 *
 * Deliberately not the whole `UseQueryResult`: a mock that claimed to be one
 * would be a hundred fields of lies, and the cast is confined to this one
 * helper instead of appearing in every test file.
 */
export function queryResult<T>(
  data: T | undefined,
  overrides: { readonly isPending?: boolean; readonly error?: unknown } = {},
): unknown {
  return {
    data,
    error: overrides.error ?? null,
    isPending: overrides.isPending ?? false,
    isError: (overrides.error ?? null) !== null,
    isFetching: false,
    refetch: vi.fn(),
  };
}

/** The same, for a mutation that has not been fired. */
export function mutationResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: undefined,
    error: null,
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}
