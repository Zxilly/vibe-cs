/*
 * pages/match/views — 高光 (`?view=highlights`), artboard 「补齐 · 比赛工作区子视图 ·
 * 高光列表」.
 *
 * §7 merges the retired `clutches` tab into this view: 「残局是一种高光标签，和
 * 多杀、穿墙同级」. So 残局 is one option of the type filter and not a sub-view,
 * which is exactly what `domain/match/matchEnums`'s `HighlightKind` already
 * encodes.
 *
 * The artboard's table is 「checkbox / 回合 / 类型 / 选手 / 说明 / tick 区间 /
 * 加入视频」 — column for column what `domain/match/HighlightRow` draws at its
 * default density, which is the density that component exists for. The rows are
 * therefore `HighlightRow`s and not a page-local `<table>`: the same row appears
 * in the player profile and in the Agent's citation list, and three spellings of
 * one row is the drift `domain/` was created to stop.
 *
 * ── The batch action, and where it can go ──────────────────────────────────
 *
 * The strip under the list is `design/layout/SelectionBar` with the artboard's
 * two actions:
 *
 *   加入录制队列        disabled, with the workspace's one reason. The queue is
 *                       not server state (`data/match.ts` gap 2) and the shell
 *                       hands every view the same `addToVideo` so the nine of
 *                       them say one sentence.
 *   用 Agent 制作视频   **creates a plan from the selection and opens it.**
 *
 * ── The selection now travels, and how ────────────────────────────────────
 *
 * This note used to say the opposite: §7 fixes `/agent`'s query as
 * `plan / session / mode`, there is no parameter for a set of highlights, and a
 * fourth one would put the route table and the implementation out of step. All
 * of that is still true — what changed is that the selection no longer needs a
 * parameter. §10.6 settled the shape (the sender creates the object and
 * navigates to it) and phase 3f-be supplied the payload: `AgentPlanShot`
 * carries `recording` with `demo_id` / `player_id` / `highlight_id`, so N
 * selected highlights become N **bound** shots of a real plan.
 *
 * `useAgentVideoHandoff` owns both steps. What this view owns is the mapping
 * from its rows to `HighlightHandoffSource` — which is why it reads
 * `analysis.data.highlights` rather than the `HighlightCandidate` rows on
 * screen: `player_id` is dropped on the way to a row (the row shows a *name*)
 * and `demo_id` never was on one.
 *
 * A selection that cannot be bound — no Demo, a player the analysis identifies
 * some way other than a SteamID64, a zero-length window — **disables the action
 * and says which**, rather than creating a plan the recording page could only
 * refuse.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState, type ReactNode } from 'react';

import { dataErrorMessage } from '../../../data/errors';
import { analysisIsMissing, useMatchAnalysis } from '../../../data/match';
import { useServiceAction, type ServiceActionState } from '../../../data/serviceAction';
import { Empty } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Button, Seg, Badge } from '../../../design/primitives';
import { SelectionBar } from '../../../design/layout';
import {
  HIGHLIGHT_KIND,
  HighlightRow,
  HighlightRowSkeleton,
  formatTickRange,
  formatTickRangeSeconds,
  type HighlightKind,
} from '../../../domain/match';
import {
  handoffRefusalFor,
  type HighlightHandoffSource,
} from '../../agent/agentHandoff';
import { useAgentVideoHandoff } from '../../agent/useAgentVideoHandoff';
import type { AnalysisWorkspace } from '../../../shared/desktop/viewModels';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import { NotAnalysedState } from './viewChrome';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import {
  currentHighlightId,
  filterHighlights,
  highlightKindCounts,
  matchHighlights,
  toggleSelected,
  visibleSelection,
} from './highlightModel';

type FilterValue = 'all' | HighlightKind;

/* ── the body ────────────────────────────────────────────────────────────── */

function HighlightsBody({ demoId, context, updateContext, addToVideo }: MatchViewProps) {
  const id = demoId === '' ? null : demoId;
  const analysis = useMatchAnalysis(id);
  const service = useServiceAction();
  const { i18n } = useLingui();

  const [filter, setFilter] = useState<FilterValue>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const highlights = useMemo(() => matchHighlights(analysis.data), [analysis.data]);
  const counts = useMemo(() => highlightKindCounts(highlights), [highlights]);
  const visible = useMemo(
    () => filterHighlights(highlights, filter === 'all' ? null : filter),
    [highlights, filter],
  );
  const batch = useMemo(() => visibleSelection(selected, visible), [selected, visible]);
  const current = currentHighlightId(highlights, context.round, context.tick);

  /*
   * The handoff's payload, built from the *wire* highlights rather than from
   * the rows: a row shows a player's name, and the plan needs their SteamID64.
   */
  const handoff = useAgentVideoHandoff();
  const handoffSources = useMemo(
    () => handoffSourcesFor(analysis.data, batch.map((entry) => entry.id)),
    [analysis.data, batch],
  );
  const handoffGate = handoffGuard({
    sources: handoffSources,
    selected: batch.length,
    pending: handoff.pending,
    service,
  });

  if (analysisIsMissing(analysis.error)) {
    return (
      <Frame state="empty">
        <NotAnalysedState demoId={demoId} />
      </Frame>
    );
  }

  const failure = dataErrorMessage(analysis.error);
  if (failure !== null) {
    return (
      <Frame state="error">
        <div className="p-3.5">
          <Alert
            variant="danger"
            action={{ label: <Trans>重试</Trans>, onAction: () => void analysis.refetch() }}
            detail={<Trans>没有任何数据被改动，重试是安全的。</Trans>}
          >
            <Trans>读不到这场比赛的高光：{failure}</Trans>
          </Alert>
        </div>
      </Frame>
    );
  }

  if (analysis.isPending) {
    return (
      <Frame state="loading">
        <div data-highlights="loading" className="min-h-0 flex-1 overflow-y-auto">
          {Array.from({ length: 8 }, (_, index) => (
            <HighlightRowSkeleton key={index} />
          ))}
        </div>
      </Frame>
    );
  }

  if (highlights.length === 0) {
    return (
      <Frame state="empty">
        <Empty
          className="m-3.5"
          title={<Trans>这场比赛没有检出高光</Trans>}
          description={<Trans>检测器在这场里没有找到残局、多杀或穿墙这类可以单独成片的片段。</Trans>}
          actions={
            <Button variant="secondary" onClick={() => updateContext({ view: 'rounds' })}>
              <Trans>逐回合看</Trans>
            </Button>
          }
        />
      </Frame>
    );
  }

  return (
    <Frame>
      {/* The chip row of the artboard, as a real radio group: a filter has to be
          reachable by keyboard, and a `Tag` is a label, not a control. */}
      <header className="flex min-h-[var(--h-bar)] flex-none flex-wrap items-center gap-2.5 border-b border-divider px-3.5 py-2">
        <Seg
          name="highlight-kind"
          size="sm"
          aria-label={t`高光类型`}
          value={filter}
          onChange={(value) => setFilter(value as FilterValue)}
          options={[
            { value: 'all', label: <><Trans>全部</Trans> {highlights.length}</> },
            ...counts.map((entry) => ({
              value: entry.kind,
              label: (
                <>
                  {i18n._(HIGHLIGHT_KIND[entry.kind].label)} {entry.count}
                </>
              ),
            })),
          ]}
        />
        <div className="flex-1" aria-hidden="true" />
        <p className="text-xs text-neutral-600">
          <Trans>按回合排序</Trans>
        </p>
      </header>

      {visible.length === 0 ? (
        <Empty
          className="m-3.5"
          title={<Trans>这个类型下没有高光</Trans>}
          description={<Trans>其余类型仍然有 {highlights.length} 条。</Trans>}
          actions={
            <Button variant="secondary" onClick={() => setFilter('all')}>
              <Trans>显示全部</Trans>
            </Button>
          }
        />
      ) : (
        <ul data-highlights="list" className="min-h-0 flex-1 list-none overflow-y-auto overscroll-y-contain">
          {visible.map((highlight) => (
            <li key={highlight.id}>
              <HighlightRow
                highlight={highlight}
                selected={selected.has(highlight.id)}
                onSelectedChange={(next) =>
                  setSelected((current_) => toggleSelected(current_, highlight.id, next))
                }
                current={highlight.id === current}
                action={
                  <span className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => updateContext({ round: highlight.round, tick: highlight.startTick })}
                    >
                      <Trans>定位</Trans>
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={addToVideo.disabled}
                      {...(addToVideo.disabledReason === undefined
                        ? {}
                        : { disabledReason: addToVideo.disabledReason })}
                      onClick={() =>
                        addToVideo.onAdd?.({
                          round: highlight.round,
                          highlightId: highlight.id,
                          startTick: highlight.startTick,
                          endTick: highlight.endTick,
                        })
                      }
                    >
                      <Trans>加入视频</Trans>
                    </Button>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      )}

      <footer className="flex-none">
        <p className="border-t border-divider px-3.5 py-2 text-xs text-neutral-600">
          <Trans>
            共 {highlights.length} 条高光，当前筛出 {visible.length} 条。
          </Trans>
        </p>
        {batch.length === 0 ? null : (
          <SelectionBar
            summary={<Trans>已选 {batch.length} 条</Trans>}
            primary={
              <Button
                variant="primary"
                size="sm"
                data-agent-handoff="true"
                disabled={handoffGate.disabled}
                {...(handoffGate.disabledReason === undefined
                  ? {}
                  : { disabledReason: handoffGate.disabledReason })}
                onClick={() => {
                  void handoff.run({
                    title: handoffTitle(analysis.data, batch.length),
                    highlights: handoffSources,
                  });
                }}
              >
                <Trans>新建作品</Trans>
              </Button>
            }
          >
            <Button variant="secondary" size="sm" onClick={() => setSelected(new Set())}>
              {/* 清空 rather than 清除: `PlayersPage` and `PlayerComparePanel`
                  already publish this exact sentence, and one catalogue entry
                  for one action is the point. */}
              <Trans>清空选择</Trans>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={addToVideo.disabled}
              {...(addToVideo.disabledReason === undefined
                ? {}
                : { disabledReason: addToVideo.disabledReason })}
              onClick={() => {
                for (const highlight of batch) {
                  addToVideo.onAdd?.({
                    round: highlight.round,
                    highlightId: highlight.id,
                    startTick: highlight.startTick,
                    endTick: highlight.endTick,
                  });
                }
              }}
            >
              <Trans>加入录制队列</Trans>
            </Button>
          </SelectionBar>
        )}
      </footer>
    </Frame>
  );
}

/* ── the Inspector ───────────────────────────────────────────────────────── */

function HighlightsInspector({ demoId, context, addToVideo, collapsed }: MatchViewProps) {
  const { i18n } = useLingui();
  const id = demoId === '' ? null : demoId;
  const analysis = useMatchAnalysis(id);
  const highlights = useMemo(() => matchHighlights(analysis.data), [analysis.data]);
  const currentId = currentHighlightId(highlights, context.round, context.tick);
  const highlight = highlights.find((entry) => entry.id === currentId) ?? null;

  if (highlight === null) {
    return (
      <MatchInspectorPanel
        title={<Trans>未选中高光</Trans>}
        summary={<Trans>共 {highlights.length} 条高光</Trans>}
        addToVideo={addToVideo}
        collapsed={collapsed}
      >
        <p className="text-sm text-neutral-700">
          <Trans>点一行的「定位」，这里会显示那条高光的回合、选手与 tick 区间，并且随地址一起可分享。</Trans>
        </p>
      </MatchInspectorPanel>
    );
  }

  const seconds = formatTickRangeSeconds(highlight.startTick, highlight.endTick, highlight.tickRate);

  return (
    <MatchInspectorPanel
      title={<Trans>选中：第 {highlight.round} 回合的高光</Trans>}
      summary={highlight.label ?? i18n._(HIGHLIGHT_KIND[highlight.kind].label)}
      addToVideo={addToVideo}
      addLabel={<Trans>把这条高光加入视频</Trans>}
      selection={{
        round: highlight.round,
        highlightId: highlight.id,
        startTick: highlight.startTick,
        endTick: highlight.endTick,
      }}
      collapsed={collapsed}
    >
      <dl className="flex flex-col gap-3 text-sm">
        <Row label={<Trans>类型</Trans>}>
          <Badge variant="accent">{highlight.label ?? i18n._(HIGHLIGHT_KIND[highlight.kind].label)}</Badge>
        </Row>
        {highlight.subject === undefined ? null : (
          <Row label={<Trans>选手</Trans>}>{highlight.subject}</Row>
        )}
        {highlight.description === undefined ? null : (
          <Row label={<Trans>说明</Trans>}>{highlight.description}</Row>
        )}
        <Row label={<Trans>tick 区间</Trans>}>
          <span className="font-mono text-xs">
            {formatTickRange(highlight.startTick, highlight.endTick)}
          </span>
        </Row>
        <Row label={<Trans>时长</Trans>}>
          <Trans>{seconds} 秒</Trans>
        </Row>
      </dl>
    </MatchInspectorPanel>
  );
}

/* ── small pieces ────────────────────────────────────────────────────────── */

/**
 * The bordered block the supplement artboard draws every sub-view in.
 *
 * `data-match-view` and `data-match-view-state` are the two probes the other
 * views expose through `viewChrome.tsx`'s `ViewFrame`; they are spelled the
 * same here so a test or a bug report reads any of the nine the same way. The
 * frames themselves have not been consolidated yet — see the report.
 */
function Frame({ state = 'ready', children }: { readonly state?: string; readonly children: ReactNode }) {
  return (
    <section
      data-match-view="highlights"
      data-match-view-state={state}
      className="m-6 flex min-h-0 min-w-0 flex-1 flex-col border border-divider"
    >
      {children}
    </section>
  );
}

/* ── the handoff's payload ───────────────────────────────────────────────── */

/**
 * The selected highlights, in the shape `agentPlanDraftFromHighlights` binds.
 *
 * Read from `AnalysisWorkspace` rather than from the rows: `HighlightCandidate`
 * carries `subject` (a *name*, resolved for display) where the plan needs
 * `player_id`, and it never carried the Demo at all. Order follows the
 * selection's own order, which is round order — the order the video will play
 * in unless the recording page is told otherwise.
 */
export function handoffSourcesFor(
  analysis: AnalysisWorkspace | undefined,
  selectedIds: readonly string[],
): HighlightHandoffSource[] {
  if (analysis === undefined) return [];
  const wanted = new Set(selectedIds);
  const byId = new Map(analysis.highlights.map((highlight) => [highlight.id, highlight]));

  return selectedIds
    .filter((id) => wanted.has(id) && byId.has(id))
    .map((id) => {
      const highlight = byId.get(id) as AnalysisWorkspace['highlights'][number];
      const label = highlight.label.trim();
      return {
        highlightId: highlight.id,
        title: label === '' ? highlight.description.trim() : label,
        demoId: analysis.demo_id,
        playerId: highlight.player_id,
        startTick: highlight.start_tick,
        endTick: highlight.end_tick,
        tickRate: Number.isFinite(analysis.tick_rate) ? analysis.tick_rate : null,
        ...(highlight.description.trim() === '' ? {} : { rationale: highlight.description.trim() }),
      };
    });
}

/**
 * 「禁用并写明原因」 for the handoff, in the order a reader would ask.
 *
 * The three refusals are separate sentences because they are separate problems
 * with separate fixes: a missing Demo is an analysis that has not landed, a
 * player the analysis identifies some other way is a Demo this build cannot
 * bind, and a zero-length window is a detector artefact.
 */
export function handoffGuard(input: {
  readonly sources: readonly HighlightHandoffSource[];
  readonly selected: number;
  readonly pending: boolean;
  readonly service: ServiceActionState;
}): { disabled: boolean; disabledReason?: string } {
  if (input.service.blocked) return input.service.buttonProps;
  if (input.pending) return { disabled: true, disabledReason: t`正在建立方案` };
  if (input.sources.length === 0 || input.sources.length !== input.selected) {
    return { disabled: true, disabledReason: t`这些高光还读不到完整的解析结果，无法建立方案` };
  }
  for (const source of input.sources) {
    const refusal = handoffRefusalFor(source);
    if (refusal === 'no_demo') {
      return { disabled: true, disabledReason: t`这条高光没有关联的 Demo，无法建立方案` };
    }
    if (refusal === 'no_player') {
      return { disabled: true, disabledReason: t`这条高光的选手没有可用的 SteamID，无法建立方案` };
    }
    if (refusal === 'empty_window') {
      return { disabled: true, disabledReason: t`这条高光的 tick 区间是空的，无法建立方案` };
    }
  }
  return { disabled: false };
}

/** 「Mirage · 3 条高光」 — the plan's title, from what the sender knows. */
export function handoffTitle(analysis: AnalysisWorkspace | undefined, count: number): string {
  const map = analysis?.map_name ?? '';
  return map === '' ? t`${count} 条高光` : t`${map} · ${count} 条高光`;
}

function Row({ label, children }: { readonly label: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-heading text-2xs tracking-caps text-neutral-600">{label}</dt>
      <dd className="min-w-0 break-words text-text">{children}</dd>
    </div>
  );
}

export const HighlightsView: MatchViewModule = {
  id: 'highlights',
  Body: HighlightsBody,
  Inspector: HighlightsInspector,
};
