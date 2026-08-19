/*
 * pages/agent — 会话抽屉 (artboard 「补齐 · Agent 会话历史与设置」, §4.5.1, §7).
 *
 * §7: 「会话抽屉是浮层，不是路由」, so nothing here reaches the address except
 * the one thing that is addressable — which session is selected. The drawer's
 * own open state belongs to the shell, its pane and its search box belong to
 * this component, and neither is ever written to the query string.
 *
 * ── The list is the server's answer, not a filter over a page ─────────────
 *
 * The search box sends `AgentSessionQuery.q` and the header prints
 * `AgentSessionPage.total`. See `sessionDrawerModel.ts` for why filtering the
 * fetched page on the client would answer a *smaller* question than the box
 * asks (「搜索会话、Demo 或选手」 reaches conversation text the list payload does
 * not even carry).
 *
 * ── 删除只删对话 ─────────────────────────────────────────────────────────
 *
 * §4.5.1, and the artboard's own footer: 「删除会话只删对话，不影响方案、任务和
 * 已生成的视频」. The confirmation says exactly that, and it is not decoration:
 * `useDeleteAgentSession` invalidates `qk.sessions.*` and deliberately not
 * `qk.plans.*`, and `sessionDrawer.interaction.test.tsx` asserts the *absence*
 * of that refetch. A deletion that invalidated plans would be the cache saying
 * 「会话拥有方案」, which is the relationship §4.5.1 says does not exist.
 *
 * ── 每条下方是它触及过的对象 ─────────────────────────────────────────────
 *
 * `AgentSessionRow` draws the chips; where a chip *goes* is this page's
 * knowledge, and `agentObjectDestination` holds it. A plan is a patch to the
 * address (no unmount, the session stays selected); the other three are routes.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { dataErrorMessage } from '../../data/errors';
import type { ServiceActionState } from '../../data/serviceAction';
import {
  useAgentSessionList,
  useDeleteAgentSession,
  useRenameAgentSession,
} from '../../data/sessions';
import { Empty, Skeleton } from '../../design/data';
import { Dialog, Drawer, Alert } from '../../design/feedback';
import { Button, Input, InputGroup, InputGroupAddon, InputGroupInput } from '../../design/primitives';
import { AgentSessionRow } from '../../domain/agent';
import type { AgentObjectRef, AgentSessionSummary } from '../../shared/desktop/dto';
import type { AgentContextPatch, AgentRouteContext } from './agentContract';
import { NewSessionPane } from './NewSessionPane';
import {
  SESSION_SEARCH_DEBOUNCE_MS,
  agentObjectDestination,
  sessionSearchQuery,
} from './sessionDrawerModel';

/** Which face the drawer is showing. Component state — §7 keeps it off the URL. */
type DrawerPane = 'list' | 'new';

export interface SessionDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly context: AgentRouteContext;
  readonly updateContext: (patch: AgentContextPatch) => void;
  readonly service: ServiceActionState;
  /**
   * The reader's 「今天」. Only tests pass it — the app takes the clock read
   * below, and `AgentSessionRow` falls back to the dated form when *nobody*
   * supplies one, which is why this must not simply be forwarded as-is.
   */
  readonly now?: Date | undefined;
}

export function SessionDrawer({
  open,
  onClose,
  context,
  updateContext,
  service,
  now,
}: SessionDrawerProps) {
  const navigate = useNavigate();

  const [pane, setPane] = useState<DrawerPane>('list');
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleting, setDeleting] = useState<AgentSessionSummary | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  /*
   * 「今天」, read once per opening of the drawer. `readSessionStamp` needs it to
   * ever answer 「09:02」 or 「昨天」 — with no `now` every row takes the dated
   * form, which is how a page silently loses two thirds of the artboard's three
   * stamps. Read here rather than inside the row because the row is pure, and
   * frozen for the life of the overlay because a clock that advanced mid-render
   * would make two rows disagree about which day it is.
   */
  const [clock] = useState(() => new Date());
  const readerNow = now ?? clock;

  /* One request per pause, not one per keystroke: the query key is the term, so
     an undebounced box would cache a page for every prefix the user typed. */
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(term);
    }, SESSION_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [term]);

  const list = useAgentSessionList(sessionSearchQuery(query));
  const rename = useRenameAgentSession();
  const remove = useDeleteAgentSession();

  const sessions = list.data?.items ?? [];
  const listError = dataErrorMessage(list.error);
  const searching = query.trim() !== '';

  const openSession = (session: AgentSessionSummary) => {
    // Only the session. A patch clears nothing, so the plan on screen survives
    // being read in a different conversation (§4.5.1: many-to-many).
    updateContext({ session: session.id });
    onClose();
  };

  const openObject = (objectRef: AgentObjectRef) => {
    const destination = agentObjectDestination(objectRef.kind, objectRef.id);
    if (destination.kind === 'plan') {
      updateContext({ plan: destination.planId });
      onClose();
      return;
    }
    onClose();
    void navigate(destination.to);
  };

  const commitRename = async (session: AgentSessionSummary) => {
    const next = renameTitle.trim();
    if (next === '' || next === session.title) {
      setRenamingId(null);
      return;
    }
    setWriteError(null);
    try {
      await rename.mutateAsync({ sessionId: session.id, title: next });
      setRenamingId(null);
    } catch (cause) {
      setWriteError(dataErrorMessage(cause) ?? t`重命名没有成功`);
    }
  };

  const commitDelete = async (session: AgentSessionSummary) => {
    setWriteError(null);
    try {
      await remove.mutateAsync(session.id);
      setDeleting(null);
      // The address must not keep naming a session that is gone.
      if (context.session === session.id) updateContext({ session: null });
    } catch (cause) {
      setWriteError(dataErrorMessage(cause) ?? t`删除没有成功`);
    }
  };

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={<Trans>对话</Trans>}
        description={
          pane === 'new' ? (
            <Trans>新建一条对话线程</Trans>
          ) : list.data === undefined ? undefined : (
            /* The server's `total`, not `items.length`: a limited page must not
               shrink 「共 14 条」. */
            <Trans>共 {list.data.total} 条</Trans>
          )
        }
        footer={
          pane === 'new' ? null : (
            <Button
              size="sm"
              variant="primary"
              data-session-new=""
              onClick={() => {
                setPane('new');
              }}
              {...service.buttonProps}
            >
              <Trans>新建对话</Trans>
              {service.suffix}
            </Button>
          )
        }
      >
        {pane === 'new' ? (
          <NewSessionPane
            updateContext={updateContext}
            service={service}
            onCancel={() => {
              setPane('list');
            }}
            onCreated={() => {
              setPane('list');
              onClose();
            }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <InputGroup size="sm" ground="bg">
              <InputGroupAddon>
                <Search strokeWidth={1.5} />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                value={term}
                aria-label={t`搜索会话、Demo 或选手`}
                placeholder={t`搜索会话、Demo 或选手`}
                onChange={(event) => {
                  setTerm(event.target.value);
                }}
              />
            </InputGroup>
            <p className="text-2xs text-neutral-600">
              <Trans>每条下方是它触及过的对象</Trans>
            </p>

            {writeError === null ? null : (
              <Alert
                variant="danger"
                action={{
                  label: <Trans>知道了</Trans>,
                  onAction: () => {
                    setWriteError(null);
                  },
                }}
              >
                {writeError}
              </Alert>
            )}

            {listError === null ? null : (
              <Alert
                variant="danger"
                action={{ label: <Trans>重试</Trans>, onAction: () => void list.refetch() }}
              >
                <Trans>读不到会话列表：{listError}</Trans>
              </Alert>
            )}

            {list.isPending ? (
              <div aria-busy="true" className="flex flex-col gap-2.5">
                <Skeleton />
                <Skeleton width="92%" />
                <Skeleton width="96%" />
                <Skeleton width="88%" />
              </div>
            ) : null}

            {!list.isPending && listError === null && sessions.length === 0 ? (
              <Empty
                title={searching ? <Trans>没有匹配的会话</Trans> : <Trans>还没有会话</Trans>}
                description={
                  searching ? (
                    <Trans>搜索会匹配会话名和对话正文。换一个词，或清空搜索看全部。</Trans>
                  ) : (
                    <Trans>会话是一条独立的对话线程，可以直接接管工作区里已有的方案和任务。</Trans>
                  )
                }
                headingLevel={3}
                actions={
                  searching ? (
                    <Button
                      onClick={() => {
                        setTerm('');
                      }}
                    >
                      <Trans>清空搜索</Trans>
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={() => {
                        setPane('new');
                      }}
                      {...service.buttonProps}
                    >
                      <Trans>新建对话</Trans>
                      {service.suffix}
                    </Button>
                  )
                }
              />
            ) : null}

            <ul className="flex flex-col">
              {sessions.map((session) => (
                <li key={session.id}>
                  <AgentSessionRow
                    session={session}
                    current={session.id === context.session}
                    onOpen={openSession}
                    onSelectRef={openObject}
                    now={readerNow}
                    actions={
                      renamingId === session.id ? (
                        <>
                          <Input
                            size="sm"
                            className="min-w-0 flex-1"
                            value={renameTitle}
                            aria-label={t`会话的新名称`}
                            onChange={(event) => {
                              setRenameTitle(event.target.value);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void commitRename(session);
                              if (event.key === 'Escape') setRenamingId(null);
                            }}
                          />
                          <Button
                            size="sm"
                            variant="primary"
                            data-session-rename-save=""
                            onClick={() => void commitRename(session)}
                            {...service.buttonProps}
                          >
                            <Trans>保存</Trans>
                            {service.suffix}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setRenamingId(null);
                            }}
                          >
                            <Trans>取消</Trans>
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            data-session-rename=""
                            onClick={() => {
                              setRenamingId(session.id);
                              setRenameTitle(session.title);
                            }}
                            {...service.buttonProps}
                          >
                            <Trans>重命名</Trans>
                            {service.suffix}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            data-session-delete=""
                            onClick={() => {
                              setDeleting(session);
                            }}
                            {...service.buttonProps}
                          >
                            <Trans>删除</Trans>
                            {service.suffix}
                          </Button>
                        </>
                      )
                    }
                  />
                </li>
              ))}
            </ul>

            <p className="text-2xs leading-normal text-neutral-600">
              <Trans>
                打开一条会话＝回到那次对话；它引用过的方案与任务如果还在，会显示它们此刻的状态（可能已被别的会话改过）。
              </Trans>
            </p>
          </div>
        )}
      </Drawer>

      {/* Dialog, not Drawer: 「Dialog 只承载不可逆动作与正式确认」. */}
      <Dialog
        open={deleting !== null}
        tone="destructive"
        title={<Trans>删除这条对话？</Trans>}
        confirmLabel={<Trans>删除对话</Trans>}
        confirmDisabled={remove.isPending}
        onClose={() => {
          setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting !== null) void commitDelete(deleting);
        }}
      >
        <Trans>
          「{deleting?.title ?? ''}」只是一条对话。删除它不会动它改过的方案、录制任务和已生成的视频——
          方案上的「改动来源」也会留着这条会话当时的名字，只是不能再回到那次对话了。
        </Trans>
      </Dialog>
    </>
  );
}
