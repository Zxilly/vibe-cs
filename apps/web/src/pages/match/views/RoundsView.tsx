/*
 * pages/match/views — 回合 (`?view=rounds`).
 *
 * §7's merge table sends two retired tabs here, and the supplement artboard
 * draws the destination as one cell titled 「回合逐条详情 · 含人数曲线与目标事件」:
 *
 *   advantage → 回合逐条详情 · 人数曲线   「人数优势本身就是回合内的时间序列，
 *                                          脱离回合看没有意义」
 *   objective → 回合逐条详情 · 事件轴     「下包、拆包、爆炸已经在回合事件轴上，
 *                                          单独一页是重复」
 *
 * So the body is: the strip to pick a round with, the picked round's header
 * (「第 21 回合 · Aurora 胜 · 拆包」 with ‹ R20 / R22 ›), the survivor curve with
 * the objective markers on it, and the round's event table. The Inspector is the
 * same round, in the shape 「03 比赛工作区」 draws it — 回合内证据 plus 注释.
 *
 * ── This is the densest of the three ─────────────────────────────────────
 *
 * §10.3 measured 30 cells at 2 rows × 15 columns in a 380px Inspector, and this
 * view carries the strip *and* a table *and* an Inspector list at once. Three
 * rules, each visible in the markup:
 *
 *   · every scroll happens inside its own container (`DataTable` already owns
 *     one; the Inspector list gets `overflow-y-auto` and `overscroll-y-contain`)
 *     — `base.css` sets `overflow: hidden` on `body`, so a page-level scroll
 *     would silently clip;
 *   · nothing is cut without saying so: the event count under the table is the
 *     round's *total*, and it names what the table leaves out;
 *   · `RoundTimeline` plans its own packing (`planRoundStrip`), so the strip is
 *     handed the rounds and left alone.
 *
 * ── Two colours, three channels ──────────────────────────────────────────
 *
 * The curve draws team A solid and team B dashed, with a legend naming both, so
 * §6.2's 「不要用颜色单独承载含义」 holds: the shape says which line is which
 * before the hue does, and the table under it says it in words.
 *
 * ── What the artboard asks for and the wire cannot answer ────────────────
 *
 * The 回合内事件 table has a 位置 column reading 「中路」「A 大道」.
 * `TimelineEvent.position` is a world coordinate triple and nothing in the
 * product maps one onto a callout name, so the column is omitted rather than
 * filled with three floats under a heading that promises a place. 「剩余 1.8 秒」
 * in the artboard's round header is a defuse timer the wire does not carry
 * either; the header states the end reason instead.
 */

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { DataTable, Empty, Skeleton, type DataTableColumn } from '../../../design/data';
import { Button, Badge } from '../../../design/primitives';
import {
  EvidenceRow,
  ROUND_END_REASON,
  RoundTimeline,
  formatTickClock,
  type EvidenceItem,
} from '../../../domain/match';
import { useRoundReview } from '../../../data/match';
import type { AnalysisWorkspace } from '../../../shared/desktop/viewModels';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import { roundSummaries } from '../matchModel';
import type { MatchContextPatch } from '../workspaceContext';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import { teamNames } from './matchAggregates';
import {
  buildRoundDetail,
  curvePolylines,
  roundNeighbours,
  survivorCurve,
  type RoundDetail,
  type RoundMoment,
} from './roundDetail';
import { SelectedRoundLine, useAnalysisGate, ViewFrame, ViewPanel } from './viewChrome';

/* ── words for the closed vocabularies ───────────────────────────────────── */

function MomentLabel({ moment }: { readonly moment: RoundMoment }) {
  if (moment.kind === 'bomb_plant') return <Trans>下包</Trans>;
  if (moment.kind === 'bomb_defuse') return <Trans>拆包</Trans>;
  if (moment.kind === 'bomb_explode') return <Trans>炸弹引爆</Trans>;
  return <Trans>击杀</Trans>;
}

/**
 * 「爆头」「穿墙」 — the qualifiers `EvidenceRow` prints after the weapon, in the
 * order 「05 证据检索」 draws them.
 */
function momentQualifiers(moment: RoundMoment): ReactNode {
  if (!moment.headshot && !moment.penetrated) return undefined;
  return (
    <>
      {moment.penetrated ? <Trans>穿墙</Trans> : null}
      {moment.penetrated && moment.headshot ? ' · ' : null}
      {moment.headshot ? <Trans>爆头</Trans> : null}
    </>
  );
}

/**
 * One moment as the row model `domain/match/EvidenceRow` takes.
 *
 * `objectiveLabel` is passed in rather than built here because it is copy, and
 * copy has to be written inside a Lingui macro at the point it is authored — a
 * macro folded into a helper extracts to nothing (§10.4 deviation 3).
 */
function toEvidenceItem(moment: RoundMoment, objectiveLabel: ReactNode): EvidenceItem {
  const qualifiers = momentQualifiers(moment);
  return {
    id: moment.id,
    tick: moment.tick,
    kind: moment.evidenceKind,
    ...(moment.actor === null ? {} : { actor: moment.actor }),
    ...(moment.target === null ? {} : { target: moment.target }),
    ...(moment.weapon === null ? {} : { weapon: moment.weapon }),
    ...(moment.kind === 'kill'
      ? qualifiers === undefined
        ? {}
        : { description: qualifiers }
      : { description: objectiveLabel }),
    context: `${moment.aliveA} v ${moment.aliveB}`,
  };
}

/* ── the survivor curve ──────────────────────────────────────────────────── */

export interface SurvivorAxisProps {
  readonly detail: RoundDetail;
  readonly tickRate: number;
  readonly teamAName: ReactNode;
  readonly teamBName: ReactNode;
}

/**
 * 「人数与事件轴 · 每一次变化都来自一条死亡或目标事件」.
 *
 * The lines are a `viewBox="0 0 1 1"` unit box stretched by `preserveAspect
 * Ratio="none"`, with `vector-effect="non-scaling-stroke"` so the stroke stays
 * one hairline instead of being scaled into a wedge. The arithmetic that puts a
 * point anywhere is `survivorCurve` / `curvePolylines`, which are pure and
 * pinned in the node project — including the zero-length round that would
 * otherwise divide by zero here.
 *
 * The chart is `aria-hidden`: it restates the event table underneath it, and a
 * screen reader reading a polyline's point list learns nothing. The table is the
 * accessible form, and the counts are in every row of it.
 */
export function SurvivorAxis({ detail, tickRate, teamAName, teamBName }: SurvivorAxisProps) {
  const points = survivorCurve(detail);
  const lines = curvePolylines(detail, points);
  const span = Math.max(1, detail.endTick - detail.startTick);

  return (
    <div data-match-survivor-axis="" className="flex flex-col gap-2 px-3.5 py-3">
      <div className="relative">
        <svg
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          aria-hidden="true"
          className="h-24 w-full border border-divider"
        >
          <polyline
            points={lines.a}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          {/* Dashed, not merely a second hue — §6.2. */}
          <polyline
            points={lines.b}
            fill="none"
            stroke="var(--color-team-b)"
            strokeWidth={2}
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {detail.objectives.map((moment) => (
          <span
            key={moment.id}
            data-match-objective-marker={moment.kind}
            className="pointer-events-none absolute top-0 h-full border-l border-dashed border-neutral-500"
            style={{ left: `${(moment.offsetTick / span) * 100}%` }}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-neutral-700">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-0.5 w-5 flex-none bg-accent" />
          <Trans>{teamAName} 存活</Trans>
        </span>
        <span className="flex items-center gap-1.5">
          {/* The legend swatch is dashed the way the line is, so the legend
              teaches the shape and not only the hue. */}
          <span
            aria-hidden="true"
            className="h-0 w-5 flex-none border-t-2 border-dashed border-team-b"
          />
          <Trans>{teamBName} 存活</Trans>
        </span>
        {detail.objectives.map((moment) => (
          <span key={moment.id} className="flex items-center gap-1.5 font-mono">
            <MomentLabel moment={moment} />
            {formatTickClock(moment.offsetTick, tickRate)}
          </span>
        ))}
        {detail.unattributedKills > 0 ? (
          <span data-match-unattributed="" className="text-warn-text">
            <Trans>{detail.unattributedKills} 条击杀没能归属到队伍，曲线未计入</Trans>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ── the round body ──────────────────────────────────────────────────────── */

export interface RoundDetailPanelsProps {
  readonly detail: RoundDetail;
  readonly tickRate: number;
  readonly teamAName: ReactNode;
  readonly teamBName: ReactNode;
  readonly previousRound: number | null;
  readonly nextRound: number | null;
  readonly selectedTick: number | null;
  readonly onUpdateContext: (patch: MatchContextPatch) => void;
}

export function RoundDetailPanels({
  detail,
  tickRate,
  teamAName,
  teamBName,
  previousRound,
  nextRound,
  selectedTick,
  onUpdateContext,
}: RoundDetailPanelsProps) {
  const { i18n } = useLingui();
  const reason = ROUND_END_REASON[detail.reason];
  const winnerName = detail.winner === 'a' ? teamAName : teamBName;

  const columns: readonly DataTableColumn<RoundMoment>[] = [
    {
      id: 'time',
      header: <Trans>时间</Trans>,
      variant: 'numeric',
      width: '5.5rem',
      cell: (moment) => formatTickClock(moment.offsetTick, tickRate),
    },
    {
      id: 'event',
      header: <Trans>事件</Trans>,
      truncate: true,
      cell: (moment) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex-none text-neutral-700">
            <MomentLabel moment={moment} />
          </span>
          <span className="min-w-0 truncate">
            {moment.actor ?? ''}
            {moment.target === null ? '' : ` → ${moment.target}`}
            {moment.weapon === null ? '' : ` · ${moment.weapon}`}
          </span>
          {moment.headshot ? (
            <Badge variant="neutral">
              <Trans>爆头</Trans>
            </Badge>
          ) : null}
          {moment.penetrated ? (
            <Badge variant="neutral">
              <Trans>穿墙</Trans>
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: 'alive',
      header: <Trans>人数</Trans>,
      variant: 'numeric',
      width: '6rem',
      cell: (moment) => (
        <span className="flex items-center justify-end gap-1.5">
          {`${moment.aliveA} v ${moment.aliveB}`}
          {moment.attributed ? null : (
            <Badge variant="outline">
              <Trans>未归属</Trans>
            </Badge>
          )}
        </span>
      ),
    },
    {
      id: 'locate',
      headerLabel: i18n._(LOCATE_COLUMN),
      align: 'end',
      width: '5.5rem',
      hideable: false,
      cell: (moment) => (
        <Button
          variant="ghost"
          size="sm"
          data-match-locate={moment.tick}
          /* 「定位」 writes the playhead and nothing else. It does not write
             `evidence`: that parameter names an `EvidenceSearchItem.evidence_id`
             from the evidence index, and a `TimelineEvent.id` is not one — the
             two id spaces are built by different passes. */
          onClick={() => onUpdateContext({ tick: moment.tick })}
        >
          <Trans>定位</Trans>
        </Button>
      ),
    },
  ];

  return (
    <>
      <ViewPanel
        id="round-detail"
        title={<Trans>第 {detail.number} 回合</Trans>}
        hint={
          <>
            <Trans>{winnerName} 胜</Trans>
            {` · ${i18n._(reason.label)} · ${detail.teamAScore}:${detail.teamBScore}`}
          </>
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              data-match-round-previous=""
              {...(previousRound === null
                ? { disabled: true, disabledReason: i18n._(FIRST_ROUND) }
                : {})}
              onClick={() => {
                if (previousRound !== null) onUpdateContext({ round: previousRound });
              }}
            >
              <Trans>上一回合</Trans>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-match-round-next=""
              {...(nextRound === null ? { disabled: true, disabledReason: i18n._(LAST_ROUND) } : {})}
              onClick={() => {
                if (nextRound !== null) onUpdateContext({ round: nextRound });
              }}
            >
              <Trans>下一回合</Trans>
            </Button>
          </>
        }
      >
        <SurvivorAxis
          detail={detail}
          tickRate={tickRate}
          teamAName={teamAName}
          teamBName={teamBName}
        />
      </ViewPanel>

      <ViewPanel
        id="round-events"
        title={<Trans>回合内事件</Trans>}
        hint={
          detail.moments.length === detail.eventCount ? (
            <Trans>共 {detail.eventCount} 条</Trans>
          ) : (
            /* Never a silent truncation: the table shows the kills and the
               objective events, and the line says how many of the round's
               events that is. 伤害与购买 belong to 道具与经济. */
            <Trans>
              击杀与目标事件 {detail.moments.length} 条 · 本回合共 {detail.eventCount} 条事件
            </Trans>
          )
        }
      >
        <DataTable
          caption={<Trans>第 {detail.number} 回合的击杀与目标事件</Trans>}
          columns={columns}
          rows={detail.moments}
          rowId={(moment) => moment.id}
          activeRowId={
            selectedTick === null
              ? null
              : (detail.moments.find((moment) => moment.tick === selectedTick)?.id ?? null)
          }
          onRowActivate={(_id, moment) => onUpdateContext({ tick: moment.tick })}
          className="max-h-96"
          empty={
            <Empty
              headingLevel={4}
              className="border-0"
              title={<Trans>这一回合没有击杀或目标事件</Trans>}
              description={<Trans>可能是一次很快结束的回合，也可能是解析结果不完整。</Trans>}
              actions={
                <Button variant="secondary" onClick={() => onUpdateContext({ view: 'replay' })}>
                  <Trans>在 2D 回放里查看</Trans>
                </Button>
              }
            />
          }
        />
      </ViewPanel>
    </>
  );
}

/*
 * Module-level descriptors rather than `t` calls: `t` resolves against whatever
 * locale is active at *import* time, which for a module constant is before the
 * catalogue is activated. 「定位」 carries no `context` on purpose — it is the
 * same word with the same meaning `domain/match/EvidenceRow` already publishes
 * (seek the workspace to this moment), so the two share one catalogue entry
 * instead of drifting into two translations of one action.
 */
const LOCATE_COLUMN = msg`定位`;
const FIRST_ROUND = msg`已经是第一个回合`;
const LAST_ROUND = msg`已经是最后一个回合`;

/* ── the body ────────────────────────────────────────────────────────────── */

export interface RoundsBodyProps {
  readonly analysis: AnalysisWorkspace;
  readonly tickRate: number;
  readonly selectedRound: number | null;
  readonly selectedTick: number | null;
  readonly onUpdateContext: (patch: MatchContextPatch) => void;
}

export function RoundsPanels({
  analysis,
  tickRate,
  selectedRound,
  selectedTick,
  onUpdateContext,
}: RoundsBodyProps) {
  const names = teamNames(analysis);
  const teamAName = names.a === '' ? <Trans>队伍 A</Trans> : names.a;
  const teamBName = names.b === '' ? <Trans>队伍 B</Trans> : names.b;

  const firstRound = [...analysis.rounds].sort((left, right) => left.number - right.number)[0];
  const effectiveRound = selectedRound ?? firstRound?.number ?? null;
  const detail = effectiveRound === null ? null : buildRoundDetail(analysis, effectiveRound);
  const neighbours = roundNeighbours(analysis.rounds, effectiveRound);

  return (
    <>
      <RoundTimeline
        rounds={roundSummaries(analysis)}
        teamAName={teamAName}
        teamBName={teamBName}
        selectedRound={effectiveRound}
        onSelectRound={(round) => onUpdateContext({ round })}
        emptyActions={
          <Button variant="secondary" onClick={() => onUpdateContext({ view: 'overview' })}>
            <Trans>回到概览</Trans>
          </Button>
        }
      />

      {detail === null ? (
        <ViewPanel id="round-detail" title={<Trans>逐回合详情</Trans>}>
          <Empty
            headingLevel={4}
            className="m-3.5"
            title={
              selectedRound === null ? (
                <Trans>先选一个回合</Trans>
              ) : (
                <Trans>这场比赛没有第 {selectedRound} 回合</Trans>
              )
            }
            description={
              <Trans>
                在上面的回合时间线里点一格，这里会显示那一回合的人数曲线、目标事件与逐条证据。
              </Trans>
            }
            actions={
              firstRound === undefined ? (
                <Button variant="secondary" onClick={() => onUpdateContext({ view: 'overview' })}>
                  <Trans>回到概览</Trans>
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => onUpdateContext({ round: firstRound.number })}
                >
                  <Trans>打开第 {firstRound.number} 回合</Trans>
                </Button>
              )
            }
          />
        </ViewPanel>
      ) : (
        <RoundDetailPanels
          detail={detail}
          tickRate={tickRate}
          teamAName={teamAName}
          teamBName={teamBName}
          previousRound={neighbours.previous}
          nextRound={neighbours.next}
          selectedTick={selectedTick}
          onUpdateContext={onUpdateContext}
        />
      )}
    </>
  );
}

function RoundsBody({ demoId, context, updateContext }: MatchViewProps) {
  const gate = useAnalysisGate(demoId);

  return (
    <ViewFrame view="rounds" state={gate.state}>
      <SelectedRoundLine round={context.round} />
      {gate.analysis === undefined ? (
        <ViewPanel id="round-detail" title={<Trans>逐回合详情</Trans>}>
          {gate.fallback}
        </ViewPanel>
      ) : (
        <RoundsPanels
          analysis={gate.analysis}
          tickRate={gate.tickRate}
          selectedRound={context.round}
          selectedTick={context.tick}
          onUpdateContext={updateContext}
        />
      )}
    </ViewFrame>
  );
}

/* ── the Inspector ───────────────────────────────────────────────────────── */

export interface RoundInspectorBodyProps {
  readonly demoId: string;
  readonly detail: RoundDetail;
  readonly tickRate: number;
  readonly teamAName: ReactNode;
  readonly teamBName: ReactNode;
  readonly selectedTick: number | null;
  readonly onUpdateContext: (patch: MatchContextPatch) => void;
}

/**
 * 「选中：第 21 回合」 — the panel 「03 比赛工作区」 draws: the round's own tags, the
 * 回合内证据 list, and the 注释 block.
 *
 * The note is `useRoundReview` — *round* metadata, one comment plus tags per
 * round, which `data/match.ts` is careful to distinguish from an evidence
 * annotation. Reading it here costs nothing beyond the first view that asks:
 * Review reads the same key.
 */
export function RoundInspectorBody({
  demoId,
  detail,
  tickRate,
  teamAName,
  teamBName,
  selectedTick,
  onUpdateContext,
}: RoundInspectorBodyProps) {
  const { i18n } = useLingui();
  const review = useRoundReview(demoId === '' ? null : demoId, detail.number);
  const reason = ROUND_END_REASON[detail.reason];
  const winnerName = detail.winner === 'a' ? teamAName : teamBName;
  const objectiveLabel = <Trans>目标事件</Trans>;
  const comment = review.data?.comment.trim() ?? '';
  const tags = review.data?.tags ?? [];

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="accent">
          <Trans>{winnerName} 胜</Trans>
        </Badge>
        <Badge variant="neutral">{i18n._(reason.label)}</Badge>
        <Badge variant="outline">{`${detail.teamAScore}:${detail.teamBScore}`}</Badge>
      </div>

      <section className="flex min-h-0 flex-col gap-2">
        <h4 className="flex items-baseline gap-2 font-heading text-sm tracking-wide">
          <Trans>回合内证据</Trans>
          <span className="font-mono text-xs text-neutral-600">{detail.moments.length}</span>
        </h4>
        {detail.moments.length === 0 ? (
          <p className="text-xs text-neutral-700">
            <Trans>这一回合没有击杀或目标事件。</Trans>
          </p>
        ) : (
          <ul
            data-match-round-evidence=""
            className="min-h-0 list-none overflow-y-auto overscroll-y-contain border border-divider"
          >
            {detail.moments.map((moment) => (
              <li key={moment.id}>
                <EvidenceRow
                  evidence={toEvidenceItem(moment, objectiveLabel)}
                  tickRate={tickRate}
                  selected={selectedTick !== null && selectedTick === moment.tick}
                  onLocate={() => onUpdateContext({ tick: moment.tick })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="font-heading text-sm tracking-wide">
          <Trans>注释</Trans>
        </h4>
        {review.isPending ? (
          <Skeleton className="h-[var(--h-row)]" />
        ) : comment === '' && tags.length === 0 ? (
          <p className="text-xs text-neutral-700">
            <Trans>这一回合还没有注释。</Trans>
          </p>
        ) : (
          <>
            {comment === '' ? null : <p className="text-sm text-neutral-800">{comment}</p>}
            {tags.length === 0 ? null : (
              <div className="flex flex-wrap items-center gap-1.5">
                {tags.map((tag) => (
                  <Badge key={tag.id} variant="neutral">
                    {tag.name}
                  </Badge>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function RoundsInspector({ demoId, context, updateContext, addToVideo, collapsed }: MatchViewProps) {
  const gate = useAnalysisGate(demoId);
  const firstRound = gate.analysis === undefined
    ? undefined
    : [...gate.analysis.rounds].sort((left, right) => left.number - right.number)[0];
  const effectiveRound = context.round ?? firstRound?.number ?? null;
  const detail =
    gate.analysis === undefined || effectiveRound === null
      ? null
      : buildRoundDetail(gate.analysis, effectiveRound);
  const names = gate.analysis === undefined ? { a: '', b: '' } : teamNames(gate.analysis);
  const teamAName = names.a === '' ? <Trans>队伍 A</Trans> : names.a;
  const teamBName = names.b === '' ? <Trans>队伍 B</Trans> : names.b;

  if (detail === null) {
    return (
      <MatchInspectorPanel
        title={<Trans>选中项</Trans>}
        summary={<Trans>未选中任何回合</Trans>}
        addToVideo={addToVideo}
        collapsed={collapsed}
      >
        <p className="text-sm text-neutral-700">
          <Trans>在回合时间线里点一格，这一回合的证据与注释会出现在这里。</Trans>
        </p>
      </MatchInspectorPanel>
    );
  }

  return (
    <MatchInspectorPanel
      title={<Trans>选中：第 {detail.number} 回合</Trans>}
      summary={<Trans>第 {detail.number} 回合 · {detail.moments.length} 条证据</Trans>}
      addToVideo={addToVideo}
      addLabel={<Trans>把这个回合加入作品</Trans>}
      selection={{ round: detail.number, startTick: detail.startTick, endTick: detail.endTick }}
      collapsed={collapsed}
      secondaryActions={
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => updateContext({ view: 'replay', tick: detail.startTick })}
          >
            <Trans>2D 回放</Trans>
          </Button>
          <Button variant="secondary" size="sm" onClick={() => updateContext({ view: 'review' })}>
            <Trans>添加注释</Trans>
          </Button>
        </>
      }
    >
      <RoundInspectorBody
        demoId={demoId}
        detail={detail}
        tickRate={gate.tickRate}
        teamAName={teamAName}
        teamBName={teamBName}
        selectedTick={context.tick}
        onUpdateContext={updateContext}
      />
    </MatchInspectorPanel>
  );
}

export const RoundsView: MatchViewModule = {
  id: 'rounds',
  Body: RoundsBody,
  Inspector: RoundsInspector,
};
