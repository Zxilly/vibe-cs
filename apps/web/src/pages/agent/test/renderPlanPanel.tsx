/*
 * Test-only harness for block B.
 *
 * The plan panel is an `AgentBlock`, so it takes the eight props the shell hands
 * every block and reads two queries of its own. Those two are replaced per file
 * with `vi.mock('…/data/plans')` and `vi.mock('…/data/sessions')` — stubbing the
 * IPC client instead would leave both reads pending through a synchronous
 * `renderToStaticMarkup`, and every `markup` assertion would be about the
 * skeleton.
 *
 * `recordingNotifier` is the other half: a stand-in for the page's one
 * `EditNotifierHandle` that keeps every `record` and every `flush` reason, so a
 * test can say 「这次编辑写了一条 duration_seconds 的变更」 without a timer, a
 * mutation or a real five-second window anywhere near it.
 */

import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import type {
  EditFlushReason,
  EditNotifierHandle,
  PendingPlanEdit,
  PlanEditRecord,
} from '../../../data/editNotifier';
import type { AgentChatSend, AgentChatStream } from '../../../data/sessions';
import type { ServiceActionState } from '../../../data/serviceAction';
import { renderInteractive, renderMarkup } from '../../../test/render';
import type {
  AgentBlockProps,
  AgentChangeDesk,
  AgentContextPatch,
  AgentGuardedAction,
  AgentRouteContext,
} from '../agentContract';
import { inertChangeDesk } from './changeDeskHost';

export interface RecordingNotifier extends EditNotifierHandle {
  /** Every edit handed to the notifier, in order. */
  readonly records: PlanEditRecord[];
  /** Every flush, by reason — the eight occasions of §4.5.4. */
  readonly flushes: EditFlushReason[];
}

export function recordingNotifier(): RecordingNotifier {
  const records: PlanEditRecord[] = [];
  const flushes: EditFlushReason[] = [];
  let buffer: PendingPlanEdit | null = null;

  return {
    records,
    flushes,
    record: (edit) => {
      records.push(edit);
      buffer = {
        planId: edit.planId,
        changes: [...(buffer?.changes ?? []), edit.change],
        shots: edit.shots,
        note: edit.note ?? null,
        openedAt: 0,
      };
    },
    flush: (reason) => {
      flushes.push(reason);
      buffer = null;
      return Promise.resolve();
    },
    peek: () => buffer,
  };
}

export interface BlockPropsOverrides {
  readonly context?: Partial<AgentRouteContext> | undefined;
  readonly updateContext?: ((patch: AgentContextPatch) => void) | undefined;
  readonly editNotifier?: EditNotifierHandle | undefined;
  readonly changes?: AgentChangeDesk | undefined;
  readonly chat?: Partial<AgentChatStream> | undefined;
  readonly service?: Partial<ServiceActionState> | undefined;
  readonly edit?: AgentGuardedAction | undefined;
  readonly readiness?: AgentGuardedAction | undefined;
  readonly confirm?: AgentGuardedAction | undefined;
  readonly collapsed?: boolean | undefined;
}

/** The shell's own defaults: a plan, a session, and 确认 disabled with gap 1. */
export const CONFIRM_REASON = '方案的镜头没有带上 Demo 与选手，暂时不能转成录制任务';

export function blockProps(overrides: BlockPropsOverrides = {}): AgentBlockProps {
  return {
    context: {
      plan: 'P-118',
      session: 'session-kael',
      mode: 'changes',
      ...overrides.context,
    },
    updateContext: overrides.updateContext ?? vi.fn(),
    editNotifier: overrides.editNotifier ?? recordingNotifier(),
    /* Inert by default — the `markup` project presses nothing. An interaction
       test wraps the block in `ChangeDeskHost` and passes the real desk. */
    changes: overrides.changes ?? inertChangeDesk(),
    chat: {
      streaming: false,
      draft: '',
      error: null,
      send: vi.fn((_input: AgentChatSend) => Promise.resolve()),
      cancel: vi.fn(),
      ...overrides.chat,
    },
    service: {
      blocked: false,
      buttonProps: { disabled: false },
      suffix: undefined,
      ...overrides.service,
    },
    edit: overrides.edit ?? { disabled: false },
    readiness: overrides.readiness ?? { disabled: false },
    confirm: overrides.confirm ?? { disabled: true, disabledReason: CONFIRM_REASON },
    collapsed: overrides.collapsed ?? false,
  };
}

export function markupPanel(node: ReactElement): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

export function renderPanel(node: ReactElement): RenderResult {
  return renderInteractive(<MemoryRouter>{node}</MemoryRouter>);
}

/**
 * The slice of a TanStack query result the panel reads, settled. Not the whole
 * `UseQueryResult`: a mock claiming to be one would be a hundred fields of lies,
 * and the cast stays in this one helper.
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
    refetch: vi.fn(() => Promise.resolve({ data })),
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
