/*
 * Test-only harness for block A.
 *
 * `pages/agent/agentShell.*.test.tsx` mounts the whole `/agent` shell, which is
 * what the shell's own assertions need. A block test wants the opposite: the
 * block alone with the eight props `AgentBlockProps` promises, so a failure
 * names the block and not the toolbar above it.
 *
 * The queries are replaced per file with `vi.mock('…/data/plans')` and
 * `vi.mock('…/data/sessions')`. Stubbing the IPC client instead would leave
 * every read pending through a synchronous `renderToStaticMarkup`, which would
 * turn every `markup` assertion into an assertion about the loading state —
 * the reason `pages/match/views/test/renderView.tsx` made the same choice, and
 * `queryResult` below is its shape.
 *
 * The one exception is the end-to-end stale test, which needs the real
 * `useAgentChatStream` and the real cache and therefore mounts `AgentPage`
 * against a fake `DesktopClient` instead of using this file.
 */

import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import type { EditNotifierHandle } from '../../../data/editNotifier';
import type { ServiceActionState } from '../../../data/serviceAction';
import type { AgentChatStream } from '../../../data/sessions';
import { renderInteractive, renderMarkup } from '../../../test/render';
import type {
  AgentBlockProps,
  AgentChangeDesk,
  AgentContextPatch,
  AgentContextUpdateOptions,
  AgentGuardedAction,
  AgentRouteContext,
} from '../agentContract';
import { inertChangeDesk } from './changeDeskHost';

export const SERVICE_OFFLINE_REASON = '本地服务未连接';

/** A stream that is not streaming, with every method recorded. */
export function chatStub(overrides: Partial<AgentChatStream> = {}): AgentChatStream {
  return {
    streaming: false,
    draft: '',
    error: null,
    send: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(),
    ...overrides,
  };
}

/** The notifier the shell owns. A block must only ever `record` through it. */
export function editNotifierStub(): EditNotifierHandle {
  return {
    record: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    peek: vi.fn(() => null),
  };
}

export function serviceStub(blocked = false): ServiceActionState {
  if (!blocked) return { blocked: false, buttonProps: { disabled: false }, suffix: undefined };
  return {
    blocked: true,
    buttonProps: { disabled: true, disabledReason: SERVICE_OFFLINE_REASON },
    suffix: ' · 需要服务',
  };
}

export interface BlockPropsOverrides {
  readonly context?: Partial<AgentRouteContext> | undefined;
  readonly updateContext?:
    | ((patch: AgentContextPatch, options?: AgentContextUpdateOptions) => void)
    | undefined;
  readonly editNotifier?: EditNotifierHandle | undefined;
  readonly changes?: AgentChangeDesk | undefined;
  readonly chat?: AgentChatStream | undefined;
  readonly service?: ServiceActionState | undefined;
  readonly edit?: AgentGuardedAction | undefined;
  readonly readiness?: AgentGuardedAction | undefined;
  readonly collapsed?: boolean | undefined;
}

/** The props the shell hands a block, with the page's real defaults. */
export function blockProps(overrides: BlockPropsOverrides = {}): AgentBlockProps {
  return {
    context: { plan: 'P-118', session: 'S-1', mode: 'changes', ...overrides.context },
    updateContext: overrides.updateContext ?? vi.fn(),
    editNotifier: overrides.editNotifier ?? editNotifierStub(),
    /* Inert by default — the `markup` project presses nothing. An interaction
       test wraps the block in `ChangeDeskHost` and passes the real desk. */
    changes: overrides.changes ?? inertChangeDesk(),
    chat: overrides.chat ?? chatStub(),
    service: overrides.service ?? serviceStub(),
    edit: overrides.edit ?? { disabled: false },
    readiness: overrides.readiness ?? { disabled: false },
    /* The shell's own state this round: gap 1, no Demo on a plan. */
    confirm: { disabled: true, disabledReason: '方案的镜头没有带上 Demo 与选手' },
    collapsed: overrides.collapsed ?? false,
  };
}

export function markupBlock(node: ReactElement): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

export function renderBlock(node: ReactElement): RenderResult {
  return renderInteractive(<MemoryRouter>{node}</MemoryRouter>);
}

/**
 * The slice of a TanStack query result this block reads, settled.
 *
 * Deliberately not a whole `UseQueryResult`: a mock claiming to be one would be
 * a hundred fields of lies, and the cast stays in this one helper.
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
