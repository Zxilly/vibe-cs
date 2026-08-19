/*
 * pages/recording — block A, 片段列表 (the artboard's 340px left column).
 *
 * One row per `RecordingRequest`: the ordinal, the title, the length, the camera
 * style and 视角, whatever risks the plan carried over, and the tick window for
 * the selected one. Below the list, 「＋ 从高光添加片段」 and the two sentences
 * the artboard prints — both of which are behaviour, not decoration:
 *
 *   「相邻镜头会在导播预览中合并」 is `DirectorPlan.merged_item_count`, and the
 *   real number is printed rather than the artboard's phrasing. A page that
 *   repeated the sentence with no number would be describing a mechanism the
 *   reader cannot check against what is on screen.
 *
 *   「修改任何片段都会让当前预览计划失效，需要重新生成预览」 is `plan.dirty`. An
 *   edit changes the sha256 the lease is bound to, so this line switches from a
 *   statement about the future to a statement about now, and 「重新生成预览计划」
 *   appears beside it.
 *
 * ── Reordering, with a keyboard ───────────────────────────────────────────
 *
 * Pointer drag is HTML5 drag-and-drop over the rows, and `Alt+↑` / `Alt+↓` move
 * the focused row by one. The two go through the same `reorderShots`
 * (`domain/media/clipOrder`'s `moveItem`), so the pointer and the keyboard
 * cannot disagree about where a row lands, and a reorder that only a mouse can
 * perform is not a feature this list is allowed to ship — jsdom has no drag
 * events either, so the keyboard path is also the one that can be tested.
 *
 * ── The 422 case, drawn from the plan the page already holds ─────────────
 *
 * When `planRecordingFromAgentPlan` answers 422 `agent_plan_shots_unbound`
 * there are no items to list, and the structured body naming the offending
 * shots never reaches the renderer (the bridge flattens every error body). So
 * this block falls back to the *Agent* plan — which it can read for free, the
 * shell already fetched it — and lists the shots `agentPlanShotsNeedingBinding`
 * identifies. Same fact, arrived at from the side that has it.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAgentPlan } from '../../data/plans';
import { Empty, Skeleton } from '../../design/data';
import { StatusDot } from '../../design/feedback';
import { Button, cn } from '../../design/primitives';
import { formatShotDuration, formatTickRange } from '../../domain/agent';
import type { AgentPlan } from '../../shared/desktop/dto';
import { agentPlanHandoff } from '../agent/agentHandoff';
import {
  agentPlanShotsNeedingBinding,
  type RecordingBlockProps,
  type RecordingShot,
} from './recordingContract';
import { CAMERA_STYLE, SHOT_VIEW, nextShotIndex, shotDurationSeconds, shotViewOf } from './shotModel';

export function ShotListBlock({ agentPlanId, plan, selection, service }: RecordingBlockProps) {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const agentPlan = useAgentPlan(agentPlanId);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  /* `agentPlanId` is nullable on `RecordingBlockProps` because the bare
     `/recording` shares the type; no block is rendered there, so this branch is
     unreachable in practice and falls back to the Agent's own address rather
     than to a broken link. */
  const planHref = agentPlanId === null ? '/agent' : agentPlanHandoff(agentPlanId);

  const items = plan.items;
  const tickRateOf = tickRateIndex(agentPlan.data, items);

  const move = (from: number, delta: number) => {
    const to = nextShotIndex(from, delta, items.length);
    if (to < 0 || to === from) return;
    plan.reorder(from, to);
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLLIElement>, index: number, shotId: string) => {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      move(index, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const next = nextShotIndex(index, event.key === 'ArrowUp' ? -1 : 1, items.length);
      const target = items[next];
      if (target === undefined) return;
      event.preventDefault();
      selection.select(target.id);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selection.select(shotId);
    }
  };

  return (
    <section
      data-recording-block="shots"
      aria-label={t`片段列表`}
      className="flex w-[var(--w-panel)] min-h-0 flex-none flex-col border-r border-divider"
    >
      <header className="flex h-[var(--h-panel-head)] flex-none items-center gap-2 border-b border-divider px-4">
        <h2 className="font-heading text-sm tracking-caps">
          <Trans>片段列表</Trans>
        </h2>
        <span className="text-xs text-neutral-600">
          <Trans>拖动可排序，Alt+↑↓ 也可以</Trans>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        {plan.loading ? (
          <ul className="list-none" data-shot-list="loading">
            {Array.from({ length: 4 }, (_unused, index) => (
              <li key={index} className="border-b border-divider px-4 py-3">
                <Skeleton width="100%" />
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <UnboundShots
            plan={agentPlan.data ?? null}
            onOpenPlan={() => void navigate(planHref)}
          />
        ) : (
          <ul className="list-none" data-shot-list="ready" role="listbox" aria-label={t`片段`}>
            {items.map((item, index) => {
              const selected = item.id === selection.shotId;
              const view = shotViewOf(item);
              const seconds = shotDurationSeconds(item, tickRateOf(item));
              return (
                <li
                  key={item.id}
                  data-shot={item.id}
                  data-selected={selected}
                  tabIndex={0}
                  role="option"
                  aria-selected={selected}
                  draggable
                  onDragStart={() => setDragFrom(index)}
                  onDragOver={(event: DragEvent<HTMLLIElement>) => event.preventDefault()}
                  onDrop={(event: DragEvent<HTMLLIElement>) => {
                    event.preventDefault();
                    if (dragFrom !== null) plan.reorder(dragFrom, index);
                    setDragFrom(null);
                  }}
                  onDragEnd={() => setDragFrom(null)}
                  onClick={() => selection.select(item.id)}
                  onKeyDown={(event) => onRowKeyDown(event, index, item.id)}
                  className={cn(
                    'flex cursor-default gap-2.5 border-b border-divider px-4 py-3',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                    selected ? 'bg-accent-100 shadow-[inset_2px_0_0_var(--color-accent)]' : null,
                  )}
                >
                  {/* The artboard's ⠿. Decorative: the row itself is the drag
                      source and the keyboard handler, so a second control here
                      would be a tab stop that does nothing new. */}
                  <span
                    aria-hidden="true"
                    className={cn('text-sm', selected ? 'text-accent' : 'text-neutral-500')}
                  >
                    ⠿
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={cn('truncate text-sm', selected ? 'text-accent-900' : null)}
                      >
                        {ordinal(index)} {item.title}
                      </span>
                      {seconds === null ? null : (
                        <span className="flex-none font-mono text-xs">
                          {formatShotDuration(seconds)}
                        </span>
                      )}
                    </div>
                    <div
                      className={cn(
                        'mt-0.5 truncate text-xs',
                        selected ? 'text-accent-800' : 'text-neutral-600',
                      )}
                    >
                      {i18n._(CAMERA_STYLE[item.camera_style].label)}
                      {' · '}
                      {i18n._(SHOT_VIEW[view])}
                    </div>
                    {selected ? (
                      <div className="mt-1 font-mono text-2xs text-accent-700">
                        {formatTickRange(item.start_tick, item.end_tick)}
                      </div>
                    ) : null}
                    <ShotRisks planShots={agentPlan.data?.shots ?? []} shotId={item.id} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex-none border-t border-divider p-4">
        {/* Not gated on the service: this is a navigation, and 「需要服务的动作
            变为禁用」 is about actions that call one. Disabling a link because
            the service is down would be a reason that is not the reason. */}
        <Button variant="secondary" block onClick={() => void navigate(planHref)}>
          <Trans>＋ 从高光添加片段</Trans>
        </Button>
        {/* Honest about where the door leads: a shot is added to the *plan*, and
            the recording plan is regenerated from it. There is no route that
            appends an item to a minted lease, and pretending otherwise would be
            a button that appears to work once. */}
        <p className="mt-2 text-2xs leading-normal text-neutral-600">
          <Trans>在方案里挑高光加成镜头，回到这里重新生成预览计划。</Trans>
        </p>
      </div>

      <footer className="flex-none border-t border-divider p-4 text-xs leading-relaxed text-neutral-700">
        <MergeNote plan={plan} />
        {plan.dirty ? (
          <p className="mt-2 text-warn-text" data-shot-list-dirty="true">
            <Trans>片段已修改，当前预览计划已失效，需要重新生成预览。</Trans>{' '}
            <Button
              variant="ghost"
              size="sm"
              disabled={service.blocked}
              {...(service.buttonProps.disabledReason === undefined
                ? {}
                : { disabledReason: service.buttonProps.disabledReason })}
              onClick={plan.replan}
            >
              <Trans>重新生成预览计划</Trans>
            </Button>
          </p>
        ) : (
          <p className="mt-2">
            <Trans>修改任何片段都会让当前预览计划失效，需要重新生成预览。</Trans>
          </p>
        )}
      </footer>
    </section>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

function MergeNote({ plan }: { readonly plan: RecordingBlockProps['plan'] }) {
  const director = plan.plan?.director ?? null;
  if (director === null) {
    return (
      <p>
        <Trans>相邻镜头会在导播预览中合并。</Trans>
      </p>
    );
  }
  /* The real count, from `DirectorPlan.merged_item_count`. Zero is printed as
     「没有发生合并」 rather than omitted: the reader is being told what the
     preview did with their list, and 「0」 is an answer. */
  return director.merged_item_count === 0 ? (
    <p data-merged-items="0">
      <Trans>相邻镜头会在导播预览中合并，这份计划里没有发生合并。</Trans>
    </p>
  ) : (
    <p data-merged-items={director.merged_item_count}>
      <Trans>
        相邻镜头会在导播预览中合并，这份计划里合并了 {director.merged_item_count} 个片段。
      </Trans>
    </p>
  );
}

/**
 * 「穿墙风险已知悉」 — the risks the Agent recorded on the shot this queue item
 * came from.
 *
 * `RecordingRequest` has no `risks` field; `AgentPlanShot` does, and the server
 * reuses the shot identity when it builds the queue, so the two line up by id.
 * Nothing is rendered when the plan is not loaded or the shot carried none —
 * 「后端没有的字段一律省略」.
 */
function ShotRisks({
  planShots,
  shotId,
}: {
  readonly planShots: readonly AgentPlan['shots'][number][];
  readonly shotId: string;
}) {
  const risks = planShots.find((shot) => shot.id === shotId)?.risks ?? [];
  if (risks.length === 0) return null;
  return (
    <ul className="mt-1.5 flex list-none flex-col gap-1" data-shot-risks={risks.length}>
      {risks.map((risk) => (
        <li key={risk} className="flex items-center gap-1.5 text-xs text-warn-text">
          {/* The artboard's 7px hollow square in front of 「穿墙风险已知悉」. It
              repeats what the line already says, so it is decorative. */}
          <StatusDot status="warn" size="sm" />
          <span className="min-w-0 truncate">{risk}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What block A draws when there is no queue: the Agent plan's shots that have
 * no `recording` binding, which is the same set the 422 was about.
 */
function UnboundShots({
  plan,
  onOpenPlan,
}: {
  readonly plan: AgentPlan | null;
  readonly onOpenPlan: () => void;
}) {
  const unbound = plan === null ? [] : agentPlanShotsNeedingBinding(plan);

  if (unbound.length === 0) {
    return (
      <Empty
        className="m-4"
        title={<Trans>这份计划里还没有片段</Trans>}
        description={<Trans>方案里的镜头绑定好 Demo 与选手之后，这里会列出可录制的片段。</Trans>}
        actions={
          <Button variant="secondary" onClick={onOpenPlan}>
            <Trans>打开剪辑单</Trans>
          </Button>
        }
      />
    );
  }

  return (
    <div className="p-4" data-unbound-shots={unbound.length}>
      <p className="text-xs leading-relaxed text-warn-text">
        <Trans>下面这些镜头还没有绑定素材，方案要先给它们选好 Demo 与选手。</Trans>
      </p>
      <ul className="mt-3 list-none">
        {unbound.map((shot, index) => (
          <li key={shot.id} data-unbound-shot={shot.id} className="border-b border-divider py-2">
            <div className="truncate text-sm">
              {ordinal(index)} {shot.title}
            </div>
            <div className="mt-0.5 font-mono text-2xs text-neutral-600">
              {formatTickRange(shot.start_tick, shot.end_tick)}
            </div>
          </li>
        ))}
      </ul>
      <Button className="mt-3" variant="secondary" block onClick={onOpenPlan}>
        <Trans>打开剪辑单</Trans>
      </Button>
    </div>
  );
}

/* ── small helpers ───────────────────────────────────────────────────────── */

/** 「01」「02」 — the artboard's two-digit ordinal. */
function ordinal(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/**
 * The tick rate a shot's duration can be computed against.
 *
 * There is none on the wire for a `RecordingRequest`, but the Agent shot it came
 * from carries `duration_seconds`, computed server-side against the real rate.
 * Dividing that back out is exact for the shot it came from and is the only
 * honest source: assuming 64 would print a wrong number on every 128-tick Demo,
 * and the alternative — no duration column at all — loses the artboard's 「3.0s」.
 */
function tickRateIndex(
  plan: AgentPlan | undefined,
  items: readonly RecordingShot[],
): (item: RecordingShot) => number | null {
  const rates = new Map<string, number>();
  for (const shot of plan?.shots ?? []) {
    const ticks = shot.end_tick - shot.start_tick;
    if (ticks > 0 && shot.duration_seconds > 0) rates.set(shot.id, ticks / shot.duration_seconds);
  }
  /* A queue item whose own shot is not in the plan borrows the rate of any shot
     on the same Demo — one Demo has one tick rate, and this is the plan the
     queue was built from. */
  const byDemo = new Map<string, number>();
  for (const item of items) {
    const rate = rates.get(item.id);
    if (rate !== undefined && !byDemo.has(item.demo_id)) byDemo.set(item.demo_id, rate);
  }
  return (item) => rates.get(item.id) ?? byDemo.get(item.demo_id) ?? null;
}
