/*
 * pages/agent — the three shapes of block A (「Agent 形态 · 第二轮」, §7's
 * `?mode=changes|inline|takes`).
 *
 * ── What is the same in all three, and why ────────────────────────────────
 *
 * The conversation. All three shapes render the same `AgentTranscript` under
 * the head this file draws, so switching shape never hides a message, an
 * `workspace_edit` notice or the reply that is arriving. That is not what the
 * artboards literally draw — 2a and 2c have no conversation column at all — and
 * the deviation is deliberate: on those boards the transcript lives in a
 * *different* column of a 1920px frame, and this block is one column of a split
 * pane whose other half is the plan panel. Dropping the transcript in two of
 * three shapes would mean the only record of 「你在方案上做了 2 处改动，Agent 已
 * 知悉」 disappears when the user picks a different shape, and §4.5.2 makes that
 * line the whole mechanism by which the Agent is kept honest.
 *
 * So the *shape* is what changes above the transcript:
 *
 *   changes  2a — how many changes are waiting, and against which revision.
 *            The proposals themselves are drawn in the transcript as full
 *            change cards, which is where 「逐条接受或拒绝」 happens.
 *   inline   2b — the shot picker. Selecting a shot narrows every change card
 *            to that shot (「只影响这一个镜头」) and scopes the composer to it.
 *   takes    2c — real recorded Takes for one shot, side by side, with the
 *            persisted Composition selection called out explicitly.
 *
 * ── The selection is not in the address ──────────────────────────────────
 *
 * §7 fixes `/agent`'s query as `plan / session / mode` and nothing else, so the
 * selected shot is block state, held by `AgentConversationBlock` above these
 * three so a shape switch does not clear it. Adding a fourth parameter would be
 * inventing an address that no other part of the product writes or reads.
 *
 * ── The plan picker ──────────────────────────────────────────────────────
 *
 * `?plan=` is absent on a bare `/agent`, and two of the three shapes are about
 * a plan. Rather than an empty box, the head offers the plans the backend has
 * (`useAgentPlanList`, which `agentContract.ts` assigns to this block) as the
 * recovery action every empty state owes the user. Picking one is a navigation
 * — `updateContext({ plan })` — and clears nothing else (invariant 4).
 */

import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useState, type ComponentType, type ReactNode } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useNativeShell } from '../../data/nativeShell';
import {
  useAgentComposition,
  useAgentPlanList,
  useAgentTakes,
  usePutAgentComposition,
} from '../../data/plans';
import { Empty, Skeleton } from '../../design/data';
import { Alert, Dialog } from '../../design/feedback';
import { Button, Badge, cn } from '../../design/primitives';
import {
  AGENT_PLAN_STATUS,
  PlanShotRow,
  PlanShotRowSkeleton,
  formatShotDuration,
  planDuration,
} from '../../domain/agent';
import type { AgentPlan, AgentPlanShot, AgentTake, CompositionItem } from '../../shared/desktop/dto';
import type { AgentContextPatch, AgentMode, AgentRouteContext } from './agentContract';

export interface ConversationModeProps {
  readonly context: AgentRouteContext;
  readonly updateContext: (patch: AgentContextPatch) => void;
  readonly plan: AgentPlan | undefined;
  readonly planPending: boolean;
  /** Across every proposal in the session — the 「3 项变更待处理」 count. */
  readonly pendingChanges: number;
  /** Counted apart from `pendingChanges`; see `conversationModel.staleTotal`. */
  readonly staleChanges: number;
  readonly selectedShotId: string | null;
  readonly onSelectShot: (shot: AgentPlanShot) => void;
  readonly collapsed: boolean;
}

/* ── changes (2a) ────────────────────────────────────────────────────────── */

function ChangesHead({ plan, planPending, pendingChanges, staleChanges }: ConversationModeProps) {
  const { i18n } = useLingui();

  if (planPending) return <HeadSkeleton lines={1} />;

  return (
    <div data-agent-mode-head="changes" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <Badge variant={pendingChanges > 0 ? 'accent' : 'neutral'}>
        {pendingChanges > 0 ? (
          <Trans>{pendingChanges} 项变更待处理</Trans>
        ) : (
          <Trans>没有待处理的变更</Trans>
        )}
      </Badge>

      {staleChanges === 0 ? null : (
        <Badge data-changes-stale="" variant="outline">
          <Trans>{staleChanges} 项已过期</Trans>
        </Badge>
      )}

      {plan === undefined ? (
        /* Without a revision nothing can be called expired (§4.5.3 ③), and a
           card that silently offers 接受 in that state would be the failure the
           rule exists to prevent. So the block says it out loud. */
        <span data-changes-no-plan="" className="text-neutral-700">
          <Trans>没有选中方案，无法判断这些变更是否仍然成立</Trans>
        </span>
      ) : (
        <>
          <span className="font-mono text-neutral-700">
            <Trans>当前 {formatShotDuration(planDuration(plan.shots))}</Trans>
          </span>
          <span className="font-mono text-neutral-700">
            <Trans>第 {plan.revision} 版</Trans>
          </span>
          <span className="text-neutral-600">{i18n._(AGENT_PLAN_STATUS[plan.status].label)}</span>
        </>
      )}
    </div>
  );
}

/* ── inline (2b) ─────────────────────────────────────────────────────────── */

function InlineHead({
  context,
  updateContext,
  plan,
  planPending,
  selectedShotId,
  onSelectShot,
}: ConversationModeProps) {
  if (planPending) {
    return (
      <div data-agent-mode-head="inline" className="flex gap-3 overflow-x-auto">
        {[0, 1, 2].map((index) => (
          <PlanShotRowSkeleton key={index} density="compact" className="w-64 flex-none" />
        ))}
      </div>
    );
  }

  if (plan === undefined) {
    return (
      <PlanPicker
        context={context}
        updateContext={updateContext}
        title={<Trans>就地编辑需要一份剪辑单</Trans>}
        description={<Trans>这个形态把对话附着在某一个镜头上，先选一个方案，它的镜头才会出现在这里。</Trans>}
      />
    );
  }

  if (plan.shots.length === 0) {
    return (
      <p data-agent-mode-head="inline" className="text-xs text-neutral-700">
        <Trans>这个方案还没有镜头，先让 Agent 出一版，或在右侧手动添加。</Trans>
      </p>
    );
  }

  return (
    /* The band scrolls inside this block, never the page — 「横向滚动必须发生在
       容器内部」. */
    <div data-agent-mode-head="inline" className="flex gap-3 overflow-x-auto pb-1">
      {plan.shots.map((shot, index) => (
        <PlanShotRow
          key={shot.id}
          shot={shot}
          index={index + 1}
          density="compact"
          selected={shot.id === selectedShotId}
          onSelect={onSelectShot}
          className="w-64 flex-none"
        />
      ))}
    </div>
  );
}

/* ── takes (2c) ──────────────────────────────────────────────────────────── */

function TakesHead({ context, updateContext, plan, planPending }: ConversationModeProps) {
  const shell = useNativeShell();
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [replace, setReplace] = useState<AgentTake | null>(null);
  const takes = useAgentTakes(plan?.id ?? null);
  const composition = useAgentComposition(plan?.id ?? null);
  const putComposition = usePutAgentComposition(plan?.id ?? '');

  if (planPending) return <HeadSkeleton lines={3} />;

  if (plan === undefined) {
    return (
      <PlanPicker
        context={context}
        updateContext={updateContext}
        title={<Trans>候选片段需要一份剪辑单</Trans>}
        description={<Trans>这个形态比较同一镜头的真实录制结果，并决定最终成片使用哪一条。</Trans>}
      />
    );
  }

  const failure = dataErrorMessage(takes.error) ?? dataErrorMessage(composition.error);
  if (failure !== null) {
    return (
      <Alert
        variant="danger"
        action={{
          label: <Trans>重试</Trans>,
          onAction: () => void Promise.all([takes.refetch(), composition.refetch()]),
        }}
      >
        <Trans>读不到候选片段：{failure}</Trans>
      </Alert>
    );
  }
  if (takes.isPending || composition.isPending) return <HeadSkeleton lines={3} />;

  const activeShots = plan.shots.filter((shot) => shot.removed_by === null);
  const selectedShot =
    activeShots.find((shot) => shot.id === selectedShotId) ?? activeShots[0] ?? null;
  const visibleTakes = (takes.data ?? []).filter((take) => take.shot_id === selectedShot?.id);
  const selectedByShot = new Map(
    (composition.data?.items ?? []).map((item) => [item.shot_id, item.take_id]),
  );
  const compositionSelectionConfirmed = ['confirmed', 'exporting', 'exported'].includes(
    composition.data?.status ?? '',
  );

  const selectTake = (take: AgentTake, replaceConfirmed: boolean) => {
    const selected = new Map(selectedByShot);
    selected.set(take.shot_id, take.id);
    const items = activeShots.flatMap((shot): CompositionItem[] => {
      const takeId = selected.get(shot.id);
      return takeId === undefined
        ? []
        : [{ shot_id: shot.id, take_id: takeId, order: 0 }];
    }).map((item, order) => ({ ...item, order }));
    const complete = activeShots.length > 0 && items.length === activeShots.length;
    putComposition.mutate({
      expected_plan_revision: plan.revision,
      status: complete ? 'confirmed' : 'draft',
      items,
      replace_confirmed: replaceConfirmed,
    });
  };

  const requestSelection = (take: AgentTake) => {
    const changingConfirmed = compositionSelectionConfirmed
      && selectedByShot.get(take.shot_id) !== take.id;
    if (changingConfirmed) setReplace(take);
    else selectTake(take, false);
  };

  return (
    <div data-agent-mode-head="takes" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-700">
        <Badge variant={compositionSelectionConfirmed ? 'accent' : 'neutral'}>
          {compositionSelectionConfirmed
            ? <Trans>成片选择已确认</Trans>
            : <Trans>成片选择未完成</Trans>}
        </Badge>
        <span><Trans>已选择 {composition.data?.items.length ?? 0} / {activeShots.length} 个镜头</Trans></span>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {activeShots.map((shot, index) => (
          <PlanShotRow
            key={shot.id}
            shot={shot}
            index={index + 1}
            density="compact"
            selected={shot.id === selectedShot?.id}
            onSelect={() => setSelectedShotId(shot.id)}
            className="w-56 flex-none"
          />
        ))}
      </div>

      {selectedShot === null ? (
        <p className="text-xs text-neutral-700"><Trans>这份剪辑单没有需要成片的镜头。</Trans></p>
      ) : visibleTakes.length === 0 ? (
        <p className="border border-divider p-3 text-xs text-neutral-700">
          <Trans>「{selectedShot.title}」还没有录制结果。确认剪辑单并完成录制后，Take 会自动出现在这里。</Trans>
        </p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {visibleTakes.map((take) => {
            const selected = selectedByShot.get(take.shot_id) === take.id;
            const source = shell.mediaSrc(take.stream_url);
            return (
              <article
                key={take.id}
                data-agent-take={take.id}
                className={cn('w-80 flex-none border p-2', selected ? 'border-accent' : 'border-divider')}
              >
                {source === null ? (
                  <div className="flex aspect-video items-center justify-center bg-neutral-100 p-3 text-center text-xs text-neutral-600">
                    <Trans>只有 Desktop 能播放本机 Take。</Trans>
                  </div>
                ) : (
                  <video
                    src={source}
                    aria-label={`${take.label} · ${selectedShot.title}`}
                    controls
                    preload="metadata"
                    className="aspect-video w-full bg-black"
                  />
                )}
                <div className="mt-2 flex items-center gap-2">
                  <strong className="min-w-0 flex-1 truncate text-sm">{take.label}</strong>
                  <span className="font-mono text-xs text-neutral-600">
                    {formatShotDuration(take.duration_seconds)}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant={selected ? 'secondary' : 'primary'}
                  disabled={selected || putComposition.isPending}
                  onClick={() => requestSelection(take)}
                  className="mt-2 w-full"
                >
                  {selected ? <Trans>成片正在使用</Trans> : <Trans>用于成片</Trans>}
                </Button>
              </article>
            );
          })}
        </div>
      )}

      {dataErrorMessage(putComposition.error) === null ? null : (
        <Alert
          variant="danger"
          action={{ label: <Trans>关闭</Trans>, onAction: () => putComposition.reset() }}
        >
          <Trans>保存成片选择失败：{dataErrorMessage(putComposition.error)}</Trans>
        </Alert>
      )}

      <Dialog
        open={replace !== null}
        title={<Trans>更换已确认的成片片段？</Trans>}
        confirmLabel={<Trans>确认更换</Trans>}
        onClose={() => setReplace(null)}
        onConfirm={() => {
          if (replace !== null) selectTake(replace, true);
          setReplace(null);
        }}
      >
        <Trans>这会更新最终 Composition 的 Take 选择；原录制结果仍会保留，可随时换回。</Trans>
      </Dialog>
    </div>
  );
}

/* ── the shared pieces ───────────────────────────────────────────────────── */

/**
 * Total over `AgentMode`, so a fourth shape cannot be added without deciding
 * what sits above its transcript — the `matchEnums.ts` rule applied to a
 * component table.
 */
export const AGENT_MODE_HEAD: Readonly<Record<AgentMode, ComponentType<ConversationModeProps>>> = {
  changes: ChangesHead,
  inline: InlineHead,
  takes: TakesHead,
};

function HeadSkeleton({ lines }: { readonly lines: number }) {
  return (
    <div data-agent-mode-head="loading" role="status" aria-busy="true" className="flex flex-col gap-2">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={index === 0 ? '46%' : '78%'} />
      ))}
    </div>
  );
}

interface PlanPickerProps {
  readonly context: AgentRouteContext;
  readonly updateContext: (patch: AgentContextPatch) => void;
  readonly title: ReactNode;
  readonly description: ReactNode;
}

/** The 「先选一个方案」 recovery, built from the plans the backend actually has. */
function PlanPicker({ context, updateContext, title, description }: PlanPickerProps) {
  const { i18n } = useLingui();
  const plans = useAgentPlanList({ limit: 6 });
  const failure = dataErrorMessage(plans.error);

  if (failure !== null) {
    return (
      <Alert
        variant="danger"
        action={{ label: <Trans>重试</Trans>, onAction: () => void plans.refetch() }}
      >
        <Trans>读不到方案列表：{failure}</Trans>
      </Alert>
    );
  }

  if (plans.isPending) return <HeadSkeleton lines={2} />;

  const items = plans.data ?? [];

  if (items.length === 0) {
    return (
      <Empty
        title={title}
        description={<Trans>还没有任何方案。先在对话里说清楚你要的片子，Agent 会给出第一版。</Trans>}
        actions={
          <Button variant="secondary" onClick={() => updateContext({ mode: 'changes' })}>
            <Trans>回到修改列表</Trans>
          </Button>
        }
      />
    );
  }

  return (
    <div data-plan-picker="" className="flex flex-col gap-2">
      <p className="text-sm">{title}</p>
      <p className="text-xs leading-normal text-neutral-700">{description}</p>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <Button
            key={item.id}
            size="sm"
            data-plan-option={item.id}
            className={cn(item.id === context.plan && 'border-accent')}
            onClick={() => updateContext({ plan: item.id })}
          >
            {item.title}
            <span className="font-mono text-2xs text-neutral-600">
              {i18n._(AGENT_PLAN_STATUS[item.status].label)}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
