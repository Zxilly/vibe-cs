/*
 * pages/ — 08 录制计划与镜头预览 (spec §7 `/recording/:taskId?`, §4.3, §4.5.3,
 * phase 3f).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  `:taskId` is an **Agent plan id**, not a recording task id
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The comment that stood here until phase 3f said the parametrised address was
 * 「a single recording task」. It was wrong, and the artboard says so twice: the
 * top bar reads 「Kael_Mirage_1v3 · 4 个片段 · 42 秒 · 来自方案 #P-118」 with a
 * 「返回方案」 door beside it, and everything under it — the shot list, the
 * director preview, the pre-recording checks, 开始录制 — describes **a plan that
 * has not been recorded yet**.
 *
 * A recording that is already running is a different object and already has a
 * first-class address: `/delivery/task/:taskId` (§7), with the stage log, the
 * retry notice and the outputs on it. Building a second task detail here would
 * be two screens for one object, and the two would drift — which is the exact
 * failure §2's 「一个对象一个地址」 exists to prevent. So:
 *
 *   `/recording`            the recordable plans, plus the recent recording
 *                           tasks. A task row links to `/delivery/task/:id`.
 *   `/recording/<planId>`   the artboard, in full.
 *   「返回方案」              `/agent?plan=<planId>` (`agentPlanHandoff`).
 *   「开始录制」 succeeds     `/delivery/task/<jobId>`.
 *
 * This file is the shell and nothing else. What each block receives, what the
 * eight check rows mean and how a per-shot `presentation` resolves are all in
 * `pages/recording/recordingContract.ts`, which is where a block owner starts.
 *
 * ── What the shell keeps for itself, and why it cannot be kept twice ──────
 *
 * **The plan lease.** `POST /api/recording/plan` mints a five-minute lease
 * holding the director's merge result; it is a mutation result, not a query, so
 * there is exactly one and it lives here. It is minted **once per Agent plan
 * id** and never re-minted on its own: a silent re-plan swaps the director's
 * output under a preview the user is reading, so what they confirm would not be
 * what they saw. 「重新生成预览计划」 is a button.
 *
 * **The edited shots and `dirty`.** Editing a shot changes the sha256 the lease
 * is bound to, so an edit does two things at once: it disables 开始录制 with a
 * written reason, and it changes `recordingShotSignature(items)`, which makes
 * the previous check list *vanish* rather than go quietly stale.
 *
 * **The one selection**, because block A's list, block B's preview and block D's
 * inspector are one selection on the artboard.
 *
 * **The one 开始录制.** §4.5.3 rule ①. It is rendered by block C, under the
 * check list, because that is the only place `blocking` is known — and it is
 * `flex-none` at the foot of a `min-h-0` column, so it is visible at every width
 * and never enters an overflow menu (§8). The data layer enforces the same rule
 * from below: `useExecuteRecordingPlan` demands a branded confirmation only
 * `confirmRecordingStart` can mint, and this file is its one caller.
 *
 * **The camera desk**, so block B's schematic and block D's 「在游戏里预览」
 * compile the same path once instead of twice.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { dataErrorMessage } from '../data/errors';
import { useAgentPlan } from '../data/plans';
import {
  agentPlanRecordingRefusal,
  confirmRecordingStart,
  isRecordingPlanLost,
  recordingPlanLoss,
  useExecuteRecordingPlan,
  usePlanRecordingFromAgentPlan,
  useRecordingPlanExpiry,
  useRecordingPreflight,
} from '../data/recording';
import { useServiceAction } from '../data/serviceAction';
import { Alert } from '../design/feedback';
import { Page, Toolbar, useCollapsed } from '../design/layout';
import type { RecordingPlanResponse, RecordingRequest } from '../shared/desktop/dto';
import { agentPlanHandoff } from './agent/agentHandoff';
import { RouteLink } from './RouteLink';
import { DirectorPreviewBlock } from './recording/DirectorPreviewBlock';
import { PreflightBlock } from './recording/PreflightBlock';
import { ShotInspectorBlock } from './recording/ShotInspectorBlock';
import { ShotListBlock } from './recording/ShotListBlock';
import { useCameraDesk } from './recording/cameraDesk';
import { reorderShots } from './recording/shotModel';
import {
  identifiedShots,
  recordingShotSignature,
  recordingTaskHref,
  type RecordingBlockProps,
  type RecordingGuardedAction,
  type RecordingPlanState,
  type RecordingShot,
  type RecordingStartDesk,
} from './recording/recordingContract';

/* ── the artboard ────────────────────────────────────────────────────────── */

export interface RecordingPlanWorkspaceProps {
  readonly agentPlanId: string;
  readonly embedded?: boolean | undefined;
  readonly successTarget?: string | undefined;
  readonly backTarget?: string | undefined;
}

export function RecordingPlanWorkspace({
  agentPlanId,
  embedded = false,
  successTarget,
  backTarget,
}: RecordingPlanWorkspaceProps) {
  const navigate = useNavigate();
  const collapsed = useCollapsed(undefined);
  const service = useServiceAction();

  const agentPlan = useAgentPlan(agentPlanId);
  const planning = usePlanRecordingFromAgentPlan();
  const execute = useExecuteRecordingPlan();

  /* The lease, and the shots as edited. Two pieces of state rather than one
     because they diverge on purpose: `dirty` *is* the divergence. */
  const [mintedPlan, setMintedPlan] = useState<{
    readonly sourcePlanId: string;
    readonly value: RecordingPlanResponse;
  } | null>(null);
  const [items, setItems] = useState<readonly RecordingShot[]>(EMPTY_ITEMS);
  const [dirty, setDirty] = useState(false);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);

  const plan = mintedPlan?.sourcePlanId === agentPlanId ? mintedPlan.value : null;
  const expiry = useRecordingPlanExpiry(plan);

  const acceptMintedPlan = useCallback((minted: RecordingPlanResponse) => {
    const shots = identifiedShots(minted.items);
    setMintedPlan({ sourcePlanId: agentPlanId, value: minted });
    setItems(shots);
    setDirty(false);
    setSelectedShotId((current) =>
      current !== null && shots.some((item) => item.id === current)
        ? current
        : (shots[0]?.id ?? null),
    );
  }, [agentPlanId]);

  /*
   * Mint the lease once for this address.
   *
   * The in-flight Promise is retained across React StrictMode's development
   * effect replay. The first effect is cleaned up before its per-call mutation
   * callback may run; retaining the Promise lets the replay attach a live
   * consumer without minting a second lease or leaving this screen forever in
   * 「正在生成」. A query would still be wrong because refetching silently swaps
   * the director result under a preview the user is reviewing.
   */
  const pendingMint = useRef<{
    readonly planId: string;
    readonly promise: Promise<RecordingPlanResponse>;
  } | null>(null);
  const mintPlan = planning.mutateAsync;
  useEffect(() => {
    if (service.blocked || plan !== null) return undefined;
    const existing = pendingMint.current;
    const promise = existing?.planId === agentPlanId
      ? existing.promise
      : mintPlan(agentPlanId);
    pendingMint.current = { planId: agentPlanId, promise };
    let active = true;
    void promise
      .then((minted) => {
        if (active) acceptMintedPlan(minted);
      })
      // `useMutation` already exposes the rejection as `planning.error`.
      // Consume this Promise branch so the same failure is not also reported
      // as an unhandled rejection by the WebView.
      .catch(() => undefined)
      .finally(() => {
        if (pendingMint.current?.promise === promise) pendingMint.current = null;
      });
    return () => {
      active = false;
    };
  }, [acceptMintedPlan, agentPlanId, mintPlan, plan, service.blocked]);

  const replan = useCallback(() => {
    pendingMint.current = null;
    planning.mutate(agentPlanId, {
      onSuccess: acceptMintedPlan,
    });
  }, [acceptMintedPlan, agentPlanId, planning]);

  const editShot = useCallback((shotId: string, patch: Partial<RecordingRequest>) => {
    if (Object.keys(patch).length === 0) return;
    // `id` is restated after the patch: an edit never changes a shot's
    // identity, and `Partial<RecordingRequest>` would otherwise allow the wire
    // type's nullable `id` to overwrite it.
    setItems((current) => current.map(
      (item) => (item.id === shotId ? { ...item, ...patch, id: item.id } : item),
    ));
    setDirty(true);
  }, []);

  const editEveryShot = useCallback((patch: Partial<RecordingRequest>) => {
    if (Object.keys(patch).length === 0) return;
    setItems((current) => current.map((item) => ({ ...item, ...patch, id: item.id })));
    setDirty(true);
  }, []);

  /* `reorderShots` is `domain/media/clipOrder`'s `moveItem`, reused rather than
     re-derived — the strip on 「09」 and the list on 「08」 answer 「拖到哪里」 the
     same way, and two implementations would eventually disagree at the ends. */
  const reorder = useCallback((from: number, to: number) => {
    if (from === to) return;
    setItems((current) => reorderShots(current, from, to));
    setDirty(true);
  }, []);

  const removeShot = useCallback((shotId: string) => {
    setItems((current) => current.filter((item) => item.id !== shotId));
    setDirty(true);
    setSelectedShotId((current) => (current === shotId ? null : current));
  }, []);

  const signature = useMemo(() => recordingShotSignature(items), [items]);
  const preflight = useRecordingPreflight(plan?.plan_id ?? null, signature);

  const selectedShot = items.find((item) => item.id === selectedShotId) ?? null;
  const camera = useCameraDesk({
    shot: selectedShot,
    service,
    preflight: preflight.result,
  });

  const planState: RecordingPlanState = {
    plan,
    items,
    // Once a lease has been accepted, a stale mutation observer must not turn
    // the already-rendered shot list back into skeletons. The local lease is
    // the authoritative presence signal; pending matters only before it lands.
    loading: plan === null && planning.isPending,
    error: planning.error,
    dirty,
    expired: expiry.expired,
    remainingMs: expiry.remainingMs,
    replan,
    editShot,
    editEveryShot,
    reorder,
    removeShot,
  };

  const start: RecordingStartDesk = {
    action: startGate({
      service: service.blocked ? service.buttonProps : null,
      hasPlan: plan !== null,
      dirty,
      expired: expiry.expired,
      shotCount: items.length,
      preflightReady: preflight.status === 'ready',
      blocking: preflight.result?.blocking ?? 0,
      starting: execute.isPending,
    }),
    shotCount: plan === null ? null : items.length,
    starting: execute.isPending,
    error: execute.error,
    start: (offlineInsecureAcknowledged) => {
      if (plan === null) return;
      execute.mutate(
        confirmRecordingStart({ planId: plan.plan_id, offlineInsecureAcknowledged }),
        {
          onSuccess: (result) => {
            void navigate(successTarget ?? recordingTaskHref(result.job_id));
          },
        },
      );
    },
  };

  const blockProps: RecordingBlockProps = {
    agentPlanId,
    plan: planState,
    selection: { shotId: selectedShotId, select: setSelectedShotId },
    preflight,
    start,
    service,
    collapsed,
  };

  const planFailure = planFailureNotice({
    error: planning.error,
    onReplan: replan,
    onOpenPlan: () => void navigate(agentPlanHandoff(agentPlanId)),
  });
  const agentFailure = dataErrorMessage(agentPlan.error);
  const estimated = plan?.estimated_seconds ?? null;
  const returnTarget = backTarget ?? agentPlanHandoff(agentPlanId);

  return (
    <RecordingFrame
      embedded={embedded}
      toolbar={
        <Toolbar
          height={embedded ? 'bar' : 'topbar'}
          title={
            embedded
              ? <Trans>录制准备</Trans>
              : (agentPlan.data?.title ?? <Trans>录制计划</Trans>)
          }
          meta={
            <>
              {plan === null ? (
                <Trans>正在从方案生成预览计划</Trans>
              ) : estimated === null ? (
                <Trans>{items.length} 个片段</Trans>
              ) : (
                <Trans>
                  {items.length} 个片段 · {Math.round(estimated)} 秒
                </Trans>
              )}
              {' · '}
              <Trans>来自方案 #{agentPlanId}</Trans>
            </>
          }
          actions={embedded ? [] : [
            {
              id: 'back-to-plan',
              label: <Trans>返回剪辑单</Trans>,
              control: (
                <RouteLink to={returnTarget} size="sm">
                  <Trans>返回剪辑单</Trans>
                </RouteLink>
              ),
              onSelect: () => void navigate(returnTarget),
            },
          ]}
        />
      }
    >
      {agentFailure === null ? null : (
        <Alert
          className="mx-7 mt-5"
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: () => void agentPlan.refetch() }}
        >
          <Trans>读不到这个方案：{agentFailure}</Trans>
        </Alert>
      )}
      {planFailure}
      {expiry.expired && plan !== null ? (
        <Alert
          className="mx-7 mt-5"
          variant="warning"
          detail={<Trans>预览计划只保留五分钟，重新生成后导播预览与录制前校验都会重算。</Trans>}
          action={{
            label: <Trans>重新生成预览计划</Trans>,
            onAction: replan,
            ...(service.blocked ? { disabled: true } : {}),
          }}
        >
          <Trans>这份预览计划已经过期。</Trans>
        </Alert>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1">
        <ShotListBlock {...blockProps} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DirectorPreviewBlock {...blockProps} camera={camera} />
          <PreflightBlock {...blockProps} />
        </div>
        <ShotInspectorBlock {...blockProps} camera={camera} />
      </div>
    </RecordingFrame>
  );
}

function RecordingFrame({
  embedded,
  toolbar,
  children,
}: {
  readonly embedded: boolean;
  readonly toolbar: ReactNode;
  readonly children: ReactNode;
}) {
  if (embedded) {
    return (
      <section data-recording-plan className="flex min-h-0 flex-1 flex-col">
        {toolbar}
        {children}
      </section>
    );
  }
  return <Page scroll={false} toolbar={toolbar}>{children}</Page>;
}

/* ── the two failures a plan mint can end in ─────────────────────────────── */

const EMPTY_ITEMS: readonly RecordingShot[] = [];

function planFailureNotice(input: {
  readonly error: unknown;
  readonly onReplan: () => void;
  readonly onOpenPlan: () => void;
}) {
  if (input.error === null || input.error === undefined) return null;

  /*
   * 422 — the plan cannot become a queue. **The structured body never arrives**:
   * the desktop bridge flattens every error body to `{status, code, message}`,
   * so the route's `shots` array is dropped in transit. The page does not need
   * it: the code decides the sentence, and block A marks the shots itself from
   * the plan it is already holding (`recording === null` is an unbound shot).
   */
  const refusal = agentPlanRecordingRefusal(input.error);
  if (refusal !== null) {
    return (
      <Alert
        className="mx-7 mt-5"
        variant="warning"
        detail={
          refusal === 'shots_unbound' ? (
            <Trans>在方案里给这些镜头选好 Demo 与选手之后，这一页就能生成预览计划。</Trans>
          ) : (
            <Trans>方案里的镜头都被移除了，先在方案里恢复或新增一个镜头。</Trans>
          )
        }
        action={{ label: <Trans>打开剪辑单</Trans>, onAction: input.onOpenPlan }}
      >
        {refusal === 'shots_unbound' ? (
          <Trans>方案里有镜头还没有绑定素材，暂时不能转成录制计划。</Trans>
        ) : (
          <Trans>这个方案里没有可录制的镜头。</Trans>
        )}
      </Alert>
    );
  }

  const loss = recordingPlanLoss(input.error);
  if (loss !== null || isRecordingPlanLost(input.error)) {
    return (
      <Alert
        className="mx-7 mt-5"
        variant="warning"
        action={{ label: <Trans>重新生成预览计划</Trans>, onAction: input.onReplan }}
      >
        {loss === 'expired' ? (
          <Trans>这份预览计划已经过期。</Trans>
        ) : (
          <Trans>这份预览计划已经不在了，本地服务可能重启过。</Trans>
        )}
      </Alert>
    );
  }

  const message = dataErrorMessage(input.error);
  return (
    <Alert
      className="mx-7 mt-5"
      variant="danger"
      action={{ label: <Trans>重试</Trans>, onAction: input.onReplan }}
    >
      <Trans>生成预览计划失败：{message ?? ''}</Trans>
    </Alert>
  );
}

/* ── 开始录制's gate ─────────────────────────────────────────────────────── */

/**
 * Every reason 开始录制 is unavailable, in the order a reader would ask them.
 *
 * Exported for its own unit test: the ordering *is* the behaviour — a dirty plan
 * whose stale check list happened to say `blocking: 0` must report the edit,
 * not the check list, or the user re-runs a probe that was never the problem.
 *
 * **`blocking > 0` is the only thing the check list contributes.** A `warning`
 * row never disables anything; that is the whole contract of `RecordingPreflight`
 * and nothing here adds a condition on top of one.
 */
export function startGate(input: {
  readonly service: RecordingGuardedAction | null;
  readonly hasPlan: boolean;
  readonly dirty: boolean;
  readonly expired: boolean;
  readonly shotCount: number;
  readonly preflightReady: boolean;
  readonly blocking: number;
  readonly starting: boolean;
}): RecordingGuardedAction {
  if (input.service !== null) return input.service;
  if (input.starting) return { disabled: true, disabledReason: t`正在启动录制` };
  if (!input.hasPlan) return { disabled: true, disabledReason: t`还没有预览计划，先生成一份` };
  if (input.shotCount === 0) return { disabled: true, disabledReason: t`这份计划里没有片段` };
  if (input.dirty) {
    return { disabled: true, disabledReason: t`片段已修改，需要重新生成预览计划` };
  }
  if (input.expired) {
    return { disabled: true, disabledReason: t`预览计划已过期，需要重新生成` };
  }
  if (!input.preflightReady) {
    return { disabled: true, disabledReason: t`先运行录制前校验` };
  }
  if (input.blocking > 0) {
    return { disabled: true, disabledReason: t`录制前校验有阻塞项，先解决它们` };
  }
  return { disabled: false };
}
