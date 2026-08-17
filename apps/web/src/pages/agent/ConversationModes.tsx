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
 *   takes    2c — the plan's versions, side by side. See `takesModel.ts`: there
 *            are exactly two on the wire and they are not called takes.
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

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { ComponentType, ReactNode } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useAgentPlanList } from '../../data/plans';
import { EmptyState, Skeleton } from '../../design/data';
import { Notice } from '../../design/feedback';
import { Button, Tag, cn } from '../../design/primitives';
import {
  AGENT_PLAN_STATUS,
  PlanShotRow,
  PlanShotRowSkeleton,
  PlanStrip,
  TakeCard,
  formatShotDuration,
  formatSignedSeconds,
  planDuration,
  planShotCount,
  type TakeMetric,
  type TakeShotPick,
} from '../../domain/agent';
import type { AgentPlan, AgentPlanShot } from '../../shared/desktop/dto';
import type { AgentContextPatch, AgentMode, AgentRouteContext } from './agentContract';
import { formatSignedCount, planVersionFacts, planVersions } from './takesModel';

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
      <Tag tone={pendingChanges > 0 ? 'accent' : 'neutral'}>
        {pendingChanges > 0 ? (
          <Trans>{pendingChanges} 项变更待处理</Trans>
        ) : (
          <Trans>没有待处理的变更</Trans>
        )}
      </Tag>

      {staleChanges === 0 ? null : (
        <Tag data-changes-stale="" tone="outline">
          <Trans>{staleChanges} 项已过期</Trans>
        </Tag>
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
        title={<Trans>就地编辑需要一个方案</Trans>}
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
  if (planPending) return <HeadSkeleton lines={3} />;

  if (plan === undefined) {
    return (
      <PlanPicker
        context={context}
        updateContext={updateContext}
        title={<Trans>候选镜头需要一个方案</Trans>}
        description={<Trans>这个形态并排比较同一个方案的几个版本，先选一个方案。</Trans>}
      />
    );
  }

  const versions = planVersions(plan);
  const baseline = versions.length > 1 ? (versions[0] ?? null) : null;
  const pickReason = t`暂不支持从不同版本里挑镜头合成`;

  return (
    <div data-agent-mode-head="takes" className="flex flex-col gap-2">
      {/* Not a `Notice`: nothing failed and there is nothing to recover from —
          this is a standing fact about the contract (gap 8). */}
      <p data-takes-gap="" className="text-xs leading-normal text-neutral-700">
        <Trans>
          这里比较的是方案自己的两个版本：Agent 出的那一版，和你现在编辑的这一版。
        </Trans>
      </p>

      {versions.length === 1 ? (
        <p data-takes-single="" className="text-xs text-neutral-700">
          <Trans>这个方案还没有偏离 Agent 版本，只有一个版本可比。</Trans>
        </p>
      ) : null}

      <div className="flex gap-3 overflow-x-auto pb-1">
        {versions.map((version) => {
          const facts = planVersionFacts(version, baseline);
          const label = version.current ? t`当前` : t`Agent 版本`;
          const metrics: TakeMetric[] = [
            {
              id: 'duration',
              label: <Trans>总时长</Trans>,
              value: formatShotDuration(facts.durationSeconds),
            },
            { id: 'shots', label: <Trans>镜头数</Trans>, value: String(facts.shotCount) },
            {
              id: 'risky',
              label: <Trans>标注风险的镜头</Trans>,
              value: String(facts.riskyShotCount),
              ...(facts.riskyShotCount > 0 ? { tone: 'warn' as const } : {}),
            },
            ...(facts.userShotCount === 0
              ? []
              : [
                  {
                    id: 'edited',
                    label: <Trans>你改过的镜头</Trans>,
                    value: String(facts.userShotCount),
                  },
                ]),
            ...(facts.durationDeltaSeconds === null
              ? []
              : [
                  {
                    id: 'duration-delta',
                    label: <Trans>与 Agent 版本：时长</Trans>,
                    value: formatSignedSeconds(facts.durationDeltaSeconds),
                  },
                ]),
            ...(facts.shotCountDelta === null
              ? []
              : [
                  {
                    id: 'shots-delta',
                    label: <Trans>镜头数</Trans>,
                    value: formatSignedCount(facts.shotCountDelta),
                  },
                ]),
          ];

          const picks: TakeShotPick[] = version.shots.map((shot, index) => ({
            shot,
            index: index + 1,
            picked: shot.removed_by === null,
            disabledReason: pickReason,
          }));

          return (
            <TakeCard
              key={version.id}
              className="w-80 flex-none"
              label={label}
              summary={
                <>
                  {formatShotDuration(facts.durationSeconds)}
                  {' · '}
                  <Trans>{planShotCount(version.shots)} 个镜头</Trans>
                  {' · '}
                  <Trans>第 {version.revision} 版</Trans>
                </>
              }
              badge={version.current ? <Trans>正在编辑</Trans> : <Trans>基准</Trans>}
              selected={version.current}
              strip={
                <PlanStrip
                  shots={version.shots}
                  height="sm"
                  label={version.current ? t`当前版本的镜头带` : t`Agent 版本的镜头带`}
                />
              }
              shots={picks}
              metrics={metrics}
            />
          );
        })}
      </div>
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
      <Notice
        tone="danger"
        action={{ label: <Trans>重试</Trans>, onAction: () => void plans.refetch() }}
      >
        <Trans>读不到方案列表：{failure}</Trans>
      </Notice>
    );
  }

  if (plans.isPending) return <HeadSkeleton lines={2} />;

  const items = plans.data ?? [];

  if (items.length === 0) {
    return (
      <EmptyState
        title={title}
        description={<Trans>还没有任何方案。先在对话里说清楚你要的片子，Agent 会给出第一版。</Trans>}
        actions={
          <Button variant="secondary" onClick={() => updateContext({ mode: 'changes' })}>
            <Trans>回到变更列表</Trans>
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
