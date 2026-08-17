/*
 * pages/agent — 「新建会话 · 直接接管当前任务」, inside the session drawer.
 *
 * The artboard's own point, verbatim: 「空会话不是空白：工作区里正在进行的对象
 * 就列在这里，引用一个就能开始改它」. So this pane is a title field and a picker,
 * and the picker's four groups are the four fields of
 * `AgentWorkspaceReferences` — 等待确认的方案 / 正在跑的录制任务 / 剪辑工程 /
 * 失败的导出.
 *
 * ── Why the picking happens before the session exists ─────────────────────
 *
 * `touchAgentObjectRef` needs a session id, so a reference cannot be recorded
 * until the session is created. The alternative — create the session the moment
 * the pane opens, then let every 引用 write straight through — would mean
 * opening a pane writes a row to the database, and backing out would leave an
 * empty session behind. So picking is local until 「新建会话」 is pressed, and
 * the writes happen in one run: create, then one touch per pick.
 *
 * The rows say 已引用 rather than 已选中 because that is the artboard's word on
 * this very board, and because it will be true by the time the pane closes.
 * `AgentReferenceRow` renders that state as text rather than as a button (it is
 * a state of the row, not a failed action), so undoing a mis-pick is the pane's
 * 「清空已选」, not a second click on the row.
 *
 * ── 接管, in one line ─────────────────────────────────────────────────────
 *
 * If one of the picks is a plan, the new session's address gets that plan:
 * 「新建一条会话不会丢掉上下文，也不需要重新生成方案——它可以直接接管当前那个」.
 * If none is, the patch names only the session and the plan already on screen
 * stays, because `patchAgentContext` clears nothing (invariant 4).
 *
 * ── Two rows of the artboard that are not drawn ───────────────────────────
 *
 * 「或者从头开始 ＋Demo ＋选手 ＋证据 ＋BGM」 and the 「可以直接说」 suggestion
 * cards. The first needs a context on `AgentSession` and there is none on the
 * wire (`{ id, title, created_at, updated_at, entries, refs }`); the second is
 * the composer's, which is block A. Both are omitted rather than mocked.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Plural, Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { dataErrorMessage } from '../../data/errors';
import type { ServiceActionState } from '../../data/serviceAction';
import {
  useAgentWorkspaceReferences,
  useCreateAgentSession,
  useTouchAgentObjectRef,
} from '../../data/sessions';
import { EmptyState, Skeleton } from '../../design/data';
import { Alert } from '../../design/feedback';
import { Button, Field, TextInput } from '../../design/primitives';
import { AgentReferenceRow } from '../../domain/agent';
import type { AgentObjectKind } from '../../shared/desktop/dto';
import type { AgentContextPatch } from './agentContract';
import {
  objectRefKey,
  selectedPlanId,
  selectedReferences,
  toObjectRefTouch,
  workspaceReferenceCount,
  workspaceReferenceGroups,
} from './sessionDrawerModel';

export interface NewSessionPaneProps {
  readonly updateContext: (patch: AgentContextPatch) => void;
  readonly service: ServiceActionState;
  /** Back to the list without writing anything. */
  readonly onCancel: () => void;
  /** The session exists and the address now names it. */
  readonly onCreated: () => void;
}

export function NewSessionPane({ updateContext, service, onCancel, onCreated }: NewSessionPaneProps) {
  const { i18n } = useLingui();

  const references = useAgentWorkspaceReferences();
  const createSession = useCreateAgentSession();
  const touchRef = useTouchAgentObjectRef();

  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [failure, setFailure] = useState<string | null>(null);
  /** Whether running `submit` again is safe — see its comment. */
  const [retryable, setRetryable] = useState(true);

  const groups = workspaceReferenceGroups(references.data);
  const total = workspaceReferenceCount(references.data);
  const referencesError = dataErrorMessage(references.error);
  const busy = createSession.isPending || touchRef.isPending;

  const pick = (kind: AgentObjectKind, id: string) => {
    setPicked((current) => new Set(current).add(objectRefKey(kind, id)));
  };

  /*
   * Create, then one touch per pick. The two halves fail differently, which is
   * why they are two `try` blocks rather than one:
   *
   *   creation failed        nothing exists; say so and stay put. Retrying is
   *                          safe, so the failure notice offers one.
   *   a touch failed         the session **does** exist. Retrying the whole run
   *                          would create a second one, so the address is
   *                          pointed at the session that was made, the pane
   *                          stays open, and the notice is a statement rather
   *                          than a retry — 引用 can be recorded again from the
   *                          conversation itself.
   */
  const submit = async () => {
    setFailure(null);
    const chosen = selectedReferences(references.data, picked);

    let sessionId: string;
    try {
      /* 「未命名」 is written here rather than left to the server: the artboard
         stamps a new session 「未命名 · 09:41」, and a row whose title is the
         empty string is a row with no accessible name at all. */
      const typed = title.trim();
      const session = await createSession.mutateAsync(typed === '' ? t`未命名` : typed);
      sessionId = session.id;
    } catch (cause) {
      setFailure(dataErrorMessage(cause) ?? t`新建会话没有成功`);
      setRetryable(true);
      return;
    }

    const planId = selectedPlanId(references.data, picked);
    // A patch clears nothing: with no plan picked, whatever plan the page was
    // already on stays, which is 「不会丢掉上下文」.
    updateContext(planId === null ? { session: sessionId } : { session: sessionId, plan: planId });

    for (const reference of chosen) {
      try {
        await touchRef.mutateAsync({
          sessionId,
          // The summary the server stores for this reference. Authored here,
          // through a macro, because `AgentWorkspaceReference` carries none and
          // `AgentObjectRefTouch.summary` is not nullable.
          touch: toObjectRefTouch(reference, t`在新建会话时引用`),
        });
      } catch (cause) {
        const detail = dataErrorMessage(cause) ?? '';
        setFailure(t`会话已经建好，但「${reference.label}」没有记进引用：${detail}`);
        setRetryable(false);
        return;
      }
    }

    onCreated();
  };

  return (
    <div data-agent-new-session className="flex flex-col gap-3.5">
      <Field
        label={<Trans>会话名称</Trans>}
        hint={<Trans>留空就叫「未命名」，随时可以改</Trans>}
      >
        {(control) => (
          <TextInput
            {...control}
            value={title}
            placeholder={t`未命名`}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        )}
      </Field>

      {failure === null ? null : (
        <Alert
          variant="danger"
          action={
            retryable
              ? { label: <Trans>重试</Trans>, onAction: () => void submit() }
              : {
                  label: <Trans>知道了</Trans>,
                  onAction: () => {
                    setFailure(null);
                  },
                }
          }
        >
          {failure}
        </Alert>
      )}

      <section className="flex flex-col gap-2.5">
        <header className="flex items-center gap-2.5">
          <h3 className="font-heading text-2xs tracking-widest text-neutral-600">
            <Trans>工作区里正在进行的</Trans>
          </h3>
          <span className="flex-1" />
          {picked.size === 0 ? null : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPicked(new Set<string>());
              }}
            >
              <Plural value={picked.size} other="清空已选 #" />
            </Button>
          )}
        </header>

        {referencesError === null ? null : (
          <Alert
            variant="danger"
            action={{ label: <Trans>重试</Trans>, onAction: () => void references.refetch() }}
          >
            <Trans>读不到工作区里正在进行的对象：{referencesError}</Trans>
          </Alert>
        )}

        {references.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton />
            <Skeleton width="92%" />
            <Skeleton width="96%" />
          </div>
        ) : null}

        {!references.isPending && referencesError === null && total === 0 ? (
          /* Empty is a normal answer here, not a failure: a workspace with
             nothing running has nothing to take over. */
          <EmptyState
            title={<Trans>工作区里没有正在进行的对象</Trans>}
            description={
              <Trans>新建一条空会话就行——想做什么直接说，Agent 会先生成一个方案。</Trans>
            }
            headingLevel={4}
            actions={
              <Button variant="primary" onClick={() => void submit()} {...createButtonProps(service, busy)}>
                <Trans>新建空会话</Trans>
                {service.suffix}
              </Button>
            }
          />
        ) : null}

        {groups.map((group) => (
          <section key={group.id} className="flex flex-col gap-2">
            <h4 className="text-2xs text-neutral-600">{i18n._(group.label)}</h4>
            {group.items.map((reference) => (
              <AgentReferenceRow
                key={objectRefKey(reference.kind, reference.id)}
                reference={reference}
                emphasis={group.emphasis}
                referenced={picked.has(objectRefKey(reference.kind, reference.id))}
                onReference={() => {
                  pick(reference.kind, reference.id);
                }}
              />
            ))}
          </section>
        ))}
      </section>

      <footer className="flex items-center gap-2 border-t border-divider pt-3">
        <p className="min-w-0 flex-1 text-2xs leading-normal text-neutral-600">
          <Trans>引用不会复制对象，也不会锁住它：会话和方案是多对多的。</Trans>
        </p>
        <Button size="sm" onClick={onCancel}>
          <Trans>取消</Trans>
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-new-session-submit=""
          onClick={() => void submit()}
          {...createButtonProps(service, busy)}
        >
          {picked.size === 0 ? (
            <Trans>新建会话</Trans>
          ) : (
            <Plural value={picked.size} other="新建并引用 # 个对象" />
          )}
          {service.suffix}
        </Button>
      </footer>
    </div>
  );
}

/**
 * 「需要服务的动作变为禁用并写明原因」, plus the in-flight guard. The service's
 * own reason wins when it is blocked — a user who has no service does not need
 * to be told the previous click is still running.
 */
function createButtonProps(
  service: ServiceActionState,
  busy: boolean,
): { disabled: boolean; disabledReason?: string } {
  if (service.blocked) return service.buttonProps;
  return busy ? { disabled: true, disabledReason: t`正在新建这条会话` } : { disabled: false };
}
