/*
 * pages/match/views — 概览 (`?view=overview`), the §7 default face of the
 * workspace.
 *
 * 「03 比赛工作区 · 概览」 draws three blocks down the content column: a strip of
 * derived numbers, the 回合时间线, and a table. This is the only summary view of
 * the nine, so the rule it is built on is that **every block is a way into the
 * view that owns it** — a cell of the round strip opens 回合 on that round, a
 * highlight row opens 高光 on that round, the head of each panel walks to the
 * whole thing. 概览 answers 「这场比赛发生了什么」 and then gets out of the way.
 *
 * Those jumps go through `props.updateContext`, never through `navigate`: it is
 * the §4.4 address, so the walk from 概览 to 回合 is in the back stack and in a
 * copied link (`viewContract.ts` states the contract).
 *
 * ── What the artboard draws here that this view does not ──────────────────
 *
 *   * **The 记分板 table.** The artboard puts the full ten-player scoreboard on
 *     概览, and §7 also gives the roster to 玩家 and to 队伍. Drawing it three
 *     times would be three tables that agree today; the roster goes to 队伍,
 *     which is the view §7 created for it (「队伍（阵营 · 经济 · 回合）」).
 *   * **A second `Scoreboard`.** `MatchContextBar` renders one at *every* width —
 *     it is on the 「keep」 side of that component's own fold — and it is pinned
 *     above this view by `Page`'s toolbar slot. Repeating it here would put the
 *     same 「Aurora 13 : 11 Meridian」 twice on one screen, and
 *     `matchWorkspace.interaction.test.tsx` reads the bar's copy by name.
 *   * **半场比分.** `Scoreboard` takes `periods` and nothing on the wire says
 *     where a half ended — see `matchAggregates.ts`. So even the bar's copy is
 *     the aggregate only; the halves are omitted rather than split at round 12,
 *     which would be the MR12 rule applied to a document that never states its
 *     own format. Reported as a contract gap.
 *   * **「残局 3 / 5」.** Won-over-attempted needs a per-clutch outcome the wire
 *     does not carry. The count of clutch candidates is offered instead, under a
 *     label that says it is a count of candidates.
 *   * **「空间证据 可用（含路线与朝向）」.** 朝向 is a replay-frame field this view
 *     does not read. What the analysis document itself answers is how many of
 *     its events carry a position, so that is what is printed.
 *
 * ── No Inspector ─────────────────────────────────────────────────────────
 *
 * The artboard draws 概览 with 「选中：第 21 回合」 in the panel, but on this view
 * a round click is a *jump*, not a selection — the round detail it would show is
 * the entire body of 回合. So the module exports no `Inspector` and the shell
 * shows its own 「在左侧选择一个回合…」 panel, which is the honest description of
 * a summary page. `matchWorkspace.test.tsx` pins that panel for `/match/:id`.
 *
 * ── Why the body is split in two ─────────────────────────────────────────
 *
 * `OverviewBody` is the half that reads; `OverviewPanels` is the half that
 * draws, and it takes the analysis document as a prop. The `markup` project
 * renders with `renderToStaticMarkup`, which never resolves a promise, so a
 * markup test that mounted the reading half could only ever assert on the
 * skeleton. Every view in this directory is split the same way.
 */

import { Trans } from '@lingui/react/macro';

import { Button } from '../../../design/primitives';
import { HighlightRow, RoundTimeline } from '../../../domain/match';
import type { AnalysisWorkspace } from '../../../shared/desktop/viewModels';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import { roundSummaries } from '../matchModel';
import type { MatchContextPatch } from '../workspaceContext';
import type { MatchVideoAction, MatchViewModule, MatchViewProps } from '../viewContract';
import {
  matchOverviewFacts,
  playerDirectory,
  rankedHighlights,
  signedDelta,
  teamNames,
  toHighlightCandidate,
} from './matchAggregates';
import {
  MetricStrip,
  SelectedRoundLine,
  useAnalysisGate,
  ViewFrame,
  ViewPanel,
  type ViewMetric,
} from './viewChrome';

/**
 * How many 关键时刻 rows 概览 shows.
 *
 * `domain/densityFixtures.ts` records 18 highlights per match ([画板], 「高光
 * 18」). Five is what fits under the strip and the timeline at the §8 fold
 * without the page having to scroll to reach the third block, and the panel head
 * prints the *total* beside 「查看全部」 — a truncation that does not say what it
 * truncated is the failure §10.3 named.
 */
export const HIGHLIGHT_PREVIEW = 5;

export interface OverviewPanelsProps {
  readonly analysis: AnalysisWorkspace;
  readonly tickRate: number;
  /** The §4.4 selection. Only ever read here; a click writes a new one. */
  readonly selectedRound: number | null;
  readonly onUpdateContext: (patch: MatchContextPatch) => void;
  readonly addToVideo: MatchVideoAction;
}

export function OverviewPanels({
  analysis,
  tickRate,
  selectedRound,
  onUpdateContext,
  addToVideo,
}: OverviewPanelsProps) {
  const facts = matchOverviewFacts(analysis);
  const names = teamNames(analysis);
  const directory = playerDirectory(analysis.players);
  const preview = rankedHighlights(analysis.highlights, HIGHLIGHT_PREVIEW);

  const teamAName = names.a === '' ? <Trans>队伍 A</Trans> : names.a;
  const teamBName = names.b === '' ? <Trans>队伍 B</Trans> : names.b;

  const metrics: ViewMetric[] = [];
  if (facts.rounds > 0) {
    metrics.push({
      id: 'rounds-won',
      label: <Trans>回合胜负</Trans>,
      value: `${facts.won.a} - ${facts.won.b}`,
      detail: <Trans>共 {facts.rounds} 回合</Trans>,
    });
  }
  if (facts.opening.rounds > 0) {
    metrics.push({
      id: 'opening-kills',
      label: <Trans>首杀差</Trans>,
      value: signedDelta(facts.opening.a - facts.opening.b),
      detail:
        facts.opening.unattributed > 0 ? (
          <Trans>
            {facts.opening.rounds} 个回合有首杀 · {facts.opening.unattributed} 条未归属
          </Trans>
        ) : (
          <Trans>{facts.opening.rounds} 个回合有首杀</Trans>
        ),
    });
  }
  if (facts.highlights > 0) {
    metrics.push({
      id: 'clutch-candidates',
      label: <Trans>残局候选</Trans>,
      value: String(facts.clutchCandidates),
      detail: <Trans>按高光类型统计，胜负未记录</Trans>,
    });
    metrics.push({
      id: 'highlights',
      label: <Trans>高光候选</Trans>,
      value: String(facts.highlights),
    });
  }
  if (facts.spatial.total > 0) {
    metrics.push({
      id: 'spatial',
      label: <Trans>带坐标证据</Trans>,
      value: `${facts.spatial.positioned} / ${facts.spatial.total}`,
      detail: <Trans>可以画进 2D 回放的事件</Trans>,
    });
  }

  return (
    <>
      <ViewPanel
        id="summary"
        title={<Trans>本场结果</Trans>}
        hint={<Trans>都由这次分析的回合与事件推出</Trans>}
      >
        <MetricStrip metrics={metrics} />
      </ViewPanel>

      {/* The strip is `domain/match`'s and draws its own panel, head included.
          A click is a jump: 「点击回合进入逐回合复盘」 is the component's own hint,
          and 逐回合复盘 is the body of 回合. */}
      <RoundTimeline
        rounds={roundSummaries(analysis)}
        teamAName={teamAName}
        teamBName={teamBName}
        selectedRound={selectedRound}
        onSelectRound={(round) => onUpdateContext({ view: 'rounds', round })}
        emptyActions={
          <Button variant="secondary" onClick={() => onUpdateContext({ view: 'rounds' })}>
            <Trans>打开回合视图</Trans>
          </Button>
        }
      />

      <ViewPanel
        id="key-moments"
        title={<Trans>关键时刻</Trans>}
        hint={<Trans>按检出置信度排序</Trans>}
        actions={
          preview.length === 0 ? undefined : (
            <Button variant="ghost" size="sm" onClick={() => onUpdateContext({ view: 'highlights' })}>
              <Trans>查看全部 {facts.highlights} 条</Trans>
            </Button>
          )
        }
      >
        {preview.length === 0 ? (
          <p className="px-3.5 py-3 text-sm text-neutral-700">
            <Trans>这次分析没有检出高光候选。回合时间线仍然可以逐回合复盘。</Trans>
          </p>
        ) : (
          <ul
            data-match-key-moments=""
            className="min-h-0 list-none overflow-y-auto overscroll-y-contain"
          >
            {preview.map((highlight) => (
              <li key={highlight.id}>
                <HighlightRow
                  highlight={toHighlightCandidate(highlight, directory)}
                  current={highlight.id === preview[0]?.id}
                  tickRate={tickRate}
                  action={
                    <span className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        data-match-open-highlight={highlight.id}
                        onClick={() =>
                          onUpdateContext({ view: 'highlights', round: highlight.round })
                        }
                      >
                        <Trans>查看</Trans>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={addToVideo.disabled}
                        {...(addToVideo.disabledReason === undefined
                          ? {}
                          : { disabledReason: addToVideo.disabledReason })}
                        onClick={() =>
                          addToVideo.onAdd?.({
                            round: highlight.round,
                            highlightId: highlight.id,
                            playerId: highlight.player_id,
                            startTick: highlight.start_tick,
                            endTick: highlight.end_tick,
                            ...(tickRate === undefined ? {} : { tickRate }),
                          })
                        }
                      >
                        <Trans>加入作品</Trans>
                      </Button>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </ViewPanel>
    </>
  );
}

function OverviewBody({ demoId, context, updateContext, addToVideo }: MatchViewProps) {
  const gate = useAnalysisGate(demoId);

  return (
    <ViewFrame view="overview" state={gate.state}>
      <SelectedRoundLine round={context.round} />
      {gate.analysis === undefined ? (
        <ViewPanel id="summary" title={<Trans>概览</Trans>}>
          {gate.fallback}
        </ViewPanel>
      ) : (
        <OverviewPanels
          analysis={gate.analysis}
          tickRate={gate.tickRate}
          selectedRound={context.round}
          onUpdateContext={updateContext}
          addToVideo={addToVideo}
        />
      )}
    </ViewFrame>
  );
}

function OverviewInspector({
  demoId,
  updateContext,
  addToVideo,
  collapsed,
}: MatchViewProps) {
  const gate = useAnalysisGate(demoId);
  const highlight = gate.analysis === undefined
    ? undefined
    : rankedHighlights(gate.analysis.highlights, 1)[0];

  if (highlight === undefined || gate.analysis === undefined) {
    return (
      <MatchInspectorPanel
        title={<Trans>选中项</Trans>}
        summary={<Trans>没有关键时刻可预览</Trans>}
        addToVideo={addToVideo}
        collapsed={collapsed}
      >
        <p className="text-sm text-neutral-700">
          <Trans>选择一个回合、选手或高光后，这里会显示可定位、可加入作品的真实上下文。</Trans>
        </p>
      </MatchInspectorPanel>
    );
  }

  const candidate = toHighlightCandidate(
    highlight,
    playerDirectory(gate.analysis.players),
  );
  const label = candidate.label ?? candidate.kind;

  return (
    <MatchInspectorPanel
      title={<Trans>关键时刻 · 第 {candidate.round} 回合</Trans>}
      summary={label}
      addToVideo={addToVideo}
      addLabel={<Trans>把这条高光加入作品</Trans>}
      selection={{
        round: candidate.round,
        highlightId: candidate.id,
        startTick: candidate.startTick,
        endTick: candidate.endTick,
      }}
      secondaryActions={
        <Button
          variant="secondary"
          size="sm"
          grow
          onClick={() =>
            updateContext({
              view: 'highlights',
              round: candidate.round,
              tick: candidate.startTick,
            })
          }
        >
          <Trans>查看高光</Trans>
        </Button>
      }
      collapsed={collapsed}
    >
      <div className="border-l-2 border-accent pl-3">
        <h3 className="font-heading text-xl">{label}</h3>
        <p className="text-xs text-neutral-700">
          {candidate.subject ?? <Trans>未归属选手</Trans>}
        </p>
      </div>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-neutral-600"><Trans>回合</Trans></dt>
          <dd className="font-mono text-xs">R{candidate.round}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-neutral-600"><Trans>tick 区间</Trans></dt>
          <dd className="font-mono text-xs">
            {candidate.startTick}–{candidate.endTick}
          </dd>
        </div>
        {candidate.description === undefined ? null : (
          <div className="border-t border-divider pt-3 text-xs leading-normal text-neutral-700">
            {candidate.description}
          </div>
        )}
      </dl>
    </MatchInspectorPanel>
  );
}

export const OverviewView: MatchViewModule = {
  id: 'overview',
  Body: OverviewBody,
  Inspector: OverviewInspector,
};
