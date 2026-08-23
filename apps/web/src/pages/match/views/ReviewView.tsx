/*
 * pages/match/views — Review 与注释 (`?view=review`), artboard 「补齐 · 比赛工作区
 * 子视图 · Review 与结论」.
 *
 * §7 merges the retired `insights` tab into this view: 「自动洞察和 AI 点评都是
 * 结论层，应该并排出现并同样标注证据」. So the panel is two columns — rule-derived
 * insights on the left, the model's prose on the right — under one segmented
 * control that also reaches 我的注释.
 *
 * The rules are in `reviewModel.ts`, with the argument for why the artboard's
 * three example insights are not the three drawn here (two of the three need
 * joins the wire does not have). Every card states the count it was derived
 * from and links to the evidence, which is the artboard's own condition:
 * 「两者都必须标注证据」.
 *
 * ── Writing an annotation ──────────────────────────────────────────────────
 *
 * §10.4 gap 16 recorded that `DesktopClient` carried no evidence writes and
 * that `/evidence` therefore shipped with its annotate buttons disabled. The
 * `Pick` was widened for this phase and `data/match.ts` declares the three
 * mutations, so annotating **works here**.
 *
 * What it still needs is an anchor. `CreateEvidenceAnnotation` requires an
 * `evidence_id`, a `round` and a `tick` — an annotation hangs off one
 * tick-level fact, not off a match — and all three are already in the address
 * (§4.4). So the composer is enabled exactly when the address carries a
 * selection and disabled with that sentence when it does not, rather than
 * inventing a tick to hang the note on.
 *
 * ── What is disabled, and why ──────────────────────────────────────────────
 *
 *   导出 HTML   no command. The bridge has no review-export route at all —
 *               not under `reviewDemo`, which returns prose, and not under
 *               outputs. Disabled with the reason; reported.
 *   语气        the artboard draws 「语气：专业」 as a `Tag`, not a control, so
 *               the request is sent with `tone: 'analytical'` and the tag says
 *               so. `LlmReviewTone` has three members and no artboard picks
 *               between them; a picker here would be a control the design has
 *               not drawn.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { dataErrorMessage } from '../../../data/errors';
import {
  analysisIsMissing,
  useCreateMatchAnnotation,
  useDeleteMatchAnnotation,
  useGenerateMatchReview,
  useMatchAnalysis,
  useMatchAnnotations,
  useUpdateMatchAnnotation,
} from '../../../data/match';
import { Empty, Skeleton } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Button, Seg, Badge, Input } from '../../../design/primitives';
import { formatTickCount } from '../../../domain/match';
import type { EvidenceAnnotation } from '../../../shared/desktop/dto';
import { RouteLink } from '../../RouteLink';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import { NotAnalysedState } from './viewChrome';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import {
  annotationTally,
  capabilityGaps,
  matchupInsight,
  openingKillInsight,
  resolveCitations,
  utilityInsight,
  type CapabilityGap,
  type EvidenceCitation,
} from './reviewModel';

type ReviewTab = 'conclusions' | 'annotations';

/**
 * The tab is local state and not a URL parameter.
 *
 * §4.4 fixes the address at five parameters and `workspaceContext.ts` is not
 * this phase's file to widen. The consequence is honest and small: a link to
 * 「Review」 opens on 结论, which is the face the artboard draws, and the
 * annotation list is one keystroke away.
 */
const DEFAULT_TAB: ReviewTab = 'conclusions';

/* ── the body ────────────────────────────────────────────────────────────── */

function ReviewBody({ demoId, context, updateContext }: MatchViewProps) {
  const id = demoId === '' ? null : demoId;
  const analysis = useMatchAnalysis(id);
  const annotations = useMatchAnnotations(id);
  const review = useGenerateMatchReview();

  const [tab, setTab] = useState<ReviewTab>(DEFAULT_TAB);

  const rows = annotations.data?.items ?? [];
  const tally = annotationTally(rows);

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
            <Trans>读不到这场比赛的分析结果：{failure}</Trans>
          </Alert>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <header className="flex min-h-[var(--h-bar)] flex-none flex-wrap items-center gap-2.5 border-b border-divider px-3.5 py-2">
        <Seg
          name="review-tab"
          size="sm"
          aria-label={t`Review 分区`}
          value={tab}
          onChange={(value) => setTab(value as ReviewTab)}
          options={[
            { value: 'conclusions', label: <Trans>结论</Trans> },
            {
              value: 'annotations',
              label: (
                <>
                  <Trans>我的注释</Trans> {tally.total}
                </>
              ),
            },
          ]}
        />
        <div className="flex-1" aria-hidden="true" />
        <Button
          variant="secondary"
          size="sm"
          disabled
          disabledReason={t`暂不支持导出复盘网页`}
        >
          <Trans>导出 HTML</Trans>
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={id === null || review.isPending}
          {...(id === null ? { disabledReason: t`还没有打开一场比赛` } : {})}
          onClick={() => {
            if (id === null) return;
            review.mutate({
              demoId: id,
              request: { scope: 'match', player_id: context.player, highlight_ids: [], tone: 'analytical' },
            });
          }}
        >
          {review.isPending ? <Trans>正在生成…</Trans> : <Trans>生成 AI 点评</Trans>}
        </Button>
      </header>

      {tab === 'conclusions' ? (
        <div className="flex min-h-0 flex-1">
          <section
            data-review-insights=""
            aria-label={t`自动洞察`}
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-y-contain border-r border-divider p-3.5"
          >
            <Heading>
              <Trans>自动洞察 · 由规则从证据推出</Trans>
            </Heading>
            {analysis.isPending ? (
              <>
                <Skeleton width="88%" />
                <Skeleton width="72%" />
                <Skeleton width="80%" />
              </>
            ) : (
              <InsightCards analysis={analysis.data} updateContext={updateContext} />
            )}
          </section>

          <section
            data-review-commentary=""
            aria-label={t`AI 点评`}
            className="flex w-[var(--w-inspector-wide)] min-h-0 flex-none flex-col gap-3 overflow-y-auto overscroll-y-contain p-3.5"
          >
            <div className="flex items-center gap-2">
              <Heading>
                <Trans>AI 点评</Trans>
              </Heading>
              <Badge variant="neutral">
                <Trans>语气：专业</Trans>
              </Badge>
            </div>

            {review.error === null || review.error === undefined ? null : (
              <Alert
                variant="danger"
                action={{ label: <Trans>重试</Trans>, onAction: () => review.reset() }}
                detail={<Trans>没有写入任何东西；自动洞察不受影响。</Trans>}
              >
                <Trans>生成点评失败：{dataErrorMessage(review.error) ?? t`服务没有给出原因`}</Trans>
              </Alert>
            )}

            {review.data === undefined ? (
              <p className="text-xs leading-relaxed text-neutral-600">
                <Trans>
                  还没有生成点评。没有配置模型时这一栏不会有内容，自动洞察不受影响。
                </Trans>
              </p>
            ) : (
              <>
                <p className="border border-accent-300 bg-accent-100 p-3 text-sm leading-relaxed">
                  {review.data.commentary}
                </p>
                <Citations
                  ids={review.data.evidence_ids}
                  analysis={analysis.data}
                  updateContext={updateContext}
                />
                <p className="text-2xs leading-normal text-neutral-600">
                  <Trans>
                    由 {review.data.provider} 的 {review.data.model} 生成。
                  </Trans>
                  {review.data.cached ? (
                    <>
                      {' '}
                      <Trans>这次直接用了同一批证据上次的结果。</Trans>
                    </>
                  ) : null}
                </p>
              </>
            )}

            <div className="border-t border-divider pt-3">
              <Heading>
                <Trans>我的注释</Trans>
              </Heading>
              <AnnotationPreview
                rows={rows}
                loading={annotations.isPending}
                onOpenAll={() => setTab('annotations')}
              />
            </div>
          </section>
        </div>
      ) : (
        <AnnotationsPanel
          demoId={demoId}
          context={context}
          rows={rows}
          loading={annotations.isPending}
          error={dataErrorMessage(annotations.error)}
          onRetry={() => void annotations.refetch()}
        />
      )}
    </Frame>
  );
}

/* ── the insight cards ───────────────────────────────────────────────────── */

function InsightCards({
  analysis,
  updateContext,
}: {
  readonly analysis: Parameters<typeof openingKillInsight>[0];
  readonly updateContext: MatchViewProps['updateContext'];
}) {
  const opening = useMemo(() => openingKillInsight(analysis), [analysis]);
  const matchup = useMemo(() => matchupInsight(analysis), [analysis]);
  const utility = useMemo(() => utilityInsight(analysis), [analysis]);
  const gaps = useMemo(() => capabilityGaps(analysis), [analysis]);

  if (opening === null && matchup === null && utility === null && gaps.length === 0) {
    return (
      <Empty
        title={<Trans>这场还推不出结论</Trans>}
        description={<Trans>这场比赛既没有解析出击杀，也没有道具与对位数据。</Trans>}
        actions={
          <Button variant="secondary" onClick={() => updateContext({ view: 'rounds' })}>
            <Trans>逐回合看</Trans>
          </Button>
        }
      />
    );
  }

  return (
    <>
      {opening === null ? null : (
        <InsightCard
          id="opening-kills"
          current
          title={
            <Trans>
              {opening.leaderName} 拿下了 {opening.roundsWithOpening} 个回合里的 {opening.leaderCount} 次首杀
            </Trans>
          }
          detail={<Trans>首杀取每个回合最早的一次击杀事件。</Trans>}
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                updateContext({ player: opening.leaderId, round: opening.round, tick: opening.tick })
              }
            >
              <Trans>定位到第 {opening.round} 回合的首杀</Trans>
            </Button>
          }
        />
      )}

      {matchup === null ? null : (
        <InsightCard
          id="matchup"
          title={
            <Trans>
              {matchup.playerName} 对位 {matchup.opponentName} 打出 {matchup.kills} 比 {matchup.deaths}
            </Trans>
          }
          detail={<Trans>这场共记录了 {matchup.pairCount} 组对位。</Trans>}
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateContext({ view: 'duels', player: matchup.playerId })}
            >
              <Trans>看对位</Trans>
            </Button>
          }
        />
      )}

      {utility === null ? null : (
        <InsightCard
          id="utility"
          title={
            <Trans>
              {utility.playerName} 的道具打出 {utility.damage} 点伤害
            </Trans>
          }
          detail={
            utility.playersFlashed === null ? (
              <Trans>共投出 {utility.throws} 个道具。</Trans>
            ) : (
              <Trans>
                共投出 {utility.throws} 个道具，闪到 {utility.playersFlashed} 人次。
              </Trans>
            )
          }
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateContext({ view: 'utility', player: utility.playerId })}
            >
              <Trans>看道具与经济</Trans>
            </Button>
          }
        />
      )}

      {gaps.map((gap) => (
        <UnavailableCard key={gap.id} gap={gap} />
      ))}
    </>
  );
}

function InsightCard({
  id,
  title,
  detail,
  action,
  current = false,
}: {
  readonly id: string;
  readonly title: ReactNode;
  readonly detail: ReactNode;
  readonly action: ReactNode;
  readonly current?: boolean | undefined;
}) {
  return (
    <article
      data-insight={id}
      aria-current={current ? true : undefined}
      className={
        current
          ? 'border border-accent-300 bg-accent-100 px-3.5 py-3 shadow-[inset_2px_0_0_var(--color-accent)]'
          : 'border border-divider px-3.5 py-3'
      }
    >
      <h4 className="mb-1 text-sm leading-normal">{title}</h4>
      <p className="text-xs leading-relaxed text-neutral-700">{detail}</p>
      <div className="mt-1.5">{action}</div>
    </article>
  );
}

/**
 * The artboard's dashed card — 「…不可用：…不用推算值填空」 — with the service's own
 * sentence in it. Names are spelled out per capability rather than derived from
 * the id: `msg` is a compile-time macro and a helper that formatted these would
 * leave the extractor nothing to read (§10.4 deviation 3).
 */
function UnavailableCard({ gap }: { readonly gap: CapabilityGap }) {
  return (
    <article
      data-insight-gap={gap.id}
      className="border border-dashed border-neutral-400 px-3.5 py-3 text-xs leading-relaxed text-neutral-600"
    >
      <p>
        <CapabilityName gap={gap} />
      </p>
      {gap.reason === null ? (
        <p>
          <Trans>服务没有说明原因；这一项不用推算值填空。</Trans>
        </p>
      ) : (
        <p>{gap.reason}</p>
      )}
    </article>
  );
}

function CapabilityName({ gap }: { readonly gap: CapabilityGap }) {
  switch (gap.id) {
    case 'matchups':
      return <Trans>对位统计不可用</Trans>;
    case 'utility_events':
      return <Trans>道具投掷统计不可用</Trans>;
    case 'utility_damage':
      return <Trans>道具伤害归因不可用</Trans>;
    case 'flash_effects':
      return <Trans>闪光效果统计不可用</Trans>;
    case 'purchase_events':
      return <Trans>购买事件统计不可用</Trans>;
    case 'purchase_spend':
      return <Trans>购买金额统计不可用</Trans>;
    default:
      return <Trans>这一项统计不可用</Trans>;
  }
}

/* ── citations ───────────────────────────────────────────────────────────── */

function Citations({
  ids,
  analysis,
  updateContext,
}: {
  readonly ids: readonly string[];
  readonly analysis: Parameters<typeof resolveCitations>[1];
  readonly updateContext: MatchViewProps['updateContext'];
}) {
  const citations = useMemo(() => resolveCitations(ids, analysis), [ids, analysis]);

  if (citations.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-neutral-700">
        <Trans>这段点评没有回引证据。</Trans>
      </p>
    );
  }

  return (
    <div className="text-xs leading-relaxed text-neutral-700">
      <p>
        <Trans>引用了 {citations.length} 条证据，全部属于发送给模型的集合：</Trans>
      </p>
      <ul data-review-citations="" className="mt-1 flex list-none flex-wrap gap-x-3 gap-y-1">
        {citations.map((citation) => (
          <li key={citation.id}>
            <CitationLink citation={citation} updateContext={updateContext} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CitationLink({
  citation,
  updateContext,
}: {
  readonly citation: EvidenceCitation;
  readonly updateContext: MatchViewProps['updateContext'];
}) {
  if (citation.kind === 'unknown') {
    /* Still listed: the claim is that every id the model was given is shown.
       It is not a link because there is nowhere in this match to go. */
    return (
      <span data-citation="unknown" className="font-mono">
        {citation.id}
      </span>
    );
  }

  const label =
    citation.kind === 'highlight' ? (
      <Trans>
        R{citation.round} · {citation.label}
      </Trans>
    ) : citation.actor === null ? (
      <Trans>R{citation.round} · tick {formatTickCount(citation.tick)}</Trans>
    ) : citation.target === null ? (
      <Trans>
        R{citation.round} · {citation.actor}
      </Trans>
    ) : (
      <Trans>
        R{citation.round} · {citation.actor} → {citation.target}
      </Trans>
    );

  return (
    <Button
      variant="ghost"
      size="sm"
      data-citation={citation.kind}
      onClick={() =>
        updateContext({ round: citation.round, tick: citation.tick, evidence: citation.id })
      }
    >
      {label}
    </Button>
  );
}

/* ── annotations ─────────────────────────────────────────────────────────── */

function AnnotationPreview({
  rows,
  loading,
  onOpenAll,
}: {
  readonly rows: readonly EvidenceAnnotation[];
  readonly loading: boolean;
  readonly onOpenAll: () => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton width="86%" />
        <Skeleton width="70%" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-neutral-600">
        <Trans>还没有注释。注释挂在具体的 tick 上，先在回放或回合里选中一条证据。</Trans>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex list-none flex-col gap-2">
        {rows.slice(0, 3).map((row) => (
          <li key={row.id} className="border border-divider px-3 py-2 text-sm">
            <span className="mr-2">{row.body}</span>
            <StateTag state={row.review_state} />
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" onClick={onOpenAll}>
        <Trans>查看全部 {rows.length} 条</Trans>
      </Button>
    </div>
  );
}

function StateTag({ state }: { readonly state: EvidenceAnnotation['review_state'] }) {
  /* The artboard's own two tones: 待处理 is `tag-outline`, 已处理 `tag-neutral`. */
  return state === 'open' ? (
    <Badge variant="outline">
      <Trans>待处理</Trans>
    </Badge>
  ) : (
    <Badge variant="neutral">
      <Trans>已处理</Trans>
    </Badge>
  );
}

function AnnotationsPanel({
  demoId,
  context,
  rows,
  loading,
  error,
  onRetry,
}: {
  readonly demoId: string;
  readonly context: MatchViewProps['context'];
  readonly rows: readonly EvidenceAnnotation[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
}) {
  const create = useCreateMatchAnnotation();
  const update = useUpdateMatchAnnotation();
  const remove = useDeleteMatchAnnotation();
  const [draft, setDraft] = useState('');

  /* Every field `CreateEvidenceAnnotation` demands, straight out of §4.4's
     address. Missing any one of them is what disables the composer. */
  const anchor =
    context.evidence !== null && context.round !== null && context.tick !== null
      ? { evidenceId: context.evidence, round: context.round, tick: context.tick }
      : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (anchor === null || draft.trim() === '') return;
    create.mutate(
      {
        demo_id: demoId,
        evidence_id: anchor.evidenceId,
        round: anchor.round,
        tick: anchor.tick,
        body: draft.trim(),
        tags: [],
      },
      { onSuccess: () => setDraft('') },
    );
  };

  const writeError =
    dataErrorMessage(create.error) ?? dataErrorMessage(update.error) ?? dataErrorMessage(remove.error);

  return (
    <div data-review-annotations="" className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={submit} className="flex flex-none flex-col gap-2 border-b border-divider p-3.5">
        <div className="flex items-center gap-2.5">
          <Input
            size="sm"
            ground="bg"
            value={draft}
            aria-label={t`注释内容`}
            placeholder={t`例如：R21 的穿墙点可做教学`}
            disabled={anchor === null}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={anchor === null || draft.trim() === '' || create.isPending}
            {...(anchor === null
              ? { disabledReason: t`注释要挂在具体的 tick 上：先在回放或回合里选中一条证据` }
              : {})}
          >
            <Trans>添加注释</Trans>
          </Button>
        </div>
        {anchor === null ? (
          <p className="text-2xs leading-normal text-neutral-600">
            <Trans>注释挂在一条证据的 tick 上，所以要先选中一条证据。</Trans>
          </p>
        ) : (
          <p className="text-2xs leading-normal text-neutral-600">
            <Trans>
              将挂在第 {anchor.round} 回合 tick {formatTickCount(anchor.tick)} 的证据上。
            </Trans>
          </p>
        )}
      </form>

      {writeError === null ? null : (
        <div className="flex-none p-3.5">
          <Alert
            variant="danger"
            action={{
              label: <Trans>知道了</Trans>,
              onAction: () => {
                create.reset();
                update.reset();
                remove.reset();
              },
            }}
          >
            <Trans>注释没有写成功：{writeError}</Trans>
          </Alert>
        </div>
      )}

      {error !== null ? (
        <div className="p-3.5">
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
            <Trans>读不到注释：{error}</Trans>
          </Alert>
        </div>
      ) : loading ? (
        <div className="flex flex-col gap-2 p-3.5">
          <Skeleton width="88%" />
          <Skeleton width="74%" />
          <Skeleton width="80%" />
        </div>
      ) : rows.length === 0 ? (
        <Empty
          className="m-3.5"
          title={<Trans>这场还没有注释</Trans>}
          description={<Trans>注释会同时出现在证据检索里，可以跨比赛检索。</Trans>}
          actions={
            <RouteLink to="/evidence?view=annotations">
              <Trans>去证据检索看全部注释</Trans>
            </RouteLink>
          }
        />
      ) : (
        <ul className="min-h-0 flex-1 list-none overflow-y-auto overscroll-y-contain p-3.5">
          {rows.map((row) => (
            <li key={row.id} className="mb-2 border border-divider px-3.5 py-3">
              <div className="flex items-start gap-2.5">
                <p className="min-w-0 flex-1 break-words text-sm">{row.body}</p>
                <StateTag state={row.review_state} />
              </div>
              <p className="mt-1 font-mono text-2xs text-neutral-600">
                <Trans>
                  R{row.round} · tick {formatTickCount(row.tick)}
                </Trans>
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({
                      id: row.id,
                      body: row.body,
                      tags: row.tags,
                      reviewState: row.review_state === 'open' ? 'resolved' : 'open',
                    })
                  }
                >
                  {row.review_state === 'open' ? (
                    <Trans>标记已处理</Trans>
                  ) : (
                    <Trans>重新打开</Trans>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(row.id)}
                >
                  <Trans>删除</Trans>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── the Inspector ───────────────────────────────────────────────────────── */

function ReviewInspector({
  demoId,
  context,
  updateContext,
  addToVideo,
  collapsed,
}: MatchViewProps) {
  const id = demoId === '' ? null : demoId;
  const analysis = useMatchAnalysis(id);
  const annotations = useMatchAnnotations(id);
  const tally = annotationTally(annotations.data?.items);
  const opening = useMemo(() => openingKillInsight(analysis.data), [analysis.data]);
  const showDefaultInsight =
    opening !== null
    && context.evidence === null
    && context.round === null
    && context.player === null
    && context.tick === null;

  return (
    <MatchInspectorPanel
      title={showDefaultInsight ? <Trans>自动洞察</Trans> : <Trans>结论与注释</Trans>}
      summary={
        showDefaultInsight
          ? <Trans>{opening.leaderName} · {opening.leaderCount} 次首杀</Trans>
          : <Trans>注释 {tally.total} 条</Trans>
      }
      addToVideo={addToVideo}
      selection={{
        ...(context.round === null ? {} : { round: context.round }),
        ...(context.player === null ? {} : { playerId: context.player }),
        ...(context.tick === null ? {} : { startTick: context.tick }),
      }}
      collapsed={collapsed}
    >
      <div className="flex flex-col gap-3 text-sm">
        {showDefaultInsight ? (
          <section data-review-default-insight="" className="border-l-2 border-accent pl-3">
            <h3 className="font-heading text-lg">
              <Trans>
                {opening.leaderName} 拿下了 {opening.roundsWithOpening} 个回合里的 {opening.leaderCount} 次首杀
              </Trans>
            </h3>
            <p className="mt-1 text-xs leading-normal text-neutral-700">
              <Trans>首杀取每个回合最早的一次击杀事件；这是规则洞察，不是 AI 生成内容。</Trans>
            </p>
            <Button
              className="mt-2"
              variant="secondary"
              size="sm"
              onClick={() =>
                updateContext({
                  player: opening.leaderId,
                  round: opening.round,
                  tick: opening.tick,
                })
              }
            >
              <Trans>定位到第 {opening.round} 回合的首杀</Trans>
            </Button>
          </section>
        ) : (
          <p className="text-neutral-700">
            {context.evidence === null ? (
              <Trans>地址里还没有选中的证据，所以现在不能新建注释。</Trans>
            ) : (
              <Trans>当前锚点是一条证据，可以在「我的注释」里为它写注释。</Trans>
            )}
          </p>
        )}
        <dl className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-neutral-700">
              <Trans>待处理</Trans>
            </dt>
            <dd className="font-mono">{tally.open}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-neutral-700">
              <Trans>已处理</Trans>
            </dt>
            <dd className="font-mono">{tally.resolved}</dd>
          </div>
        </dl>
      </div>
    </MatchInspectorPanel>
  );
}

/* ── frame ───────────────────────────────────────────────────────────────── */

/**
 * Same probes as `viewChrome.tsx`'s `ViewFrame` — see the note on 高光's frame.
 */
function Frame({ state = 'ready', children }: { readonly state?: string; readonly children: ReactNode }) {
  return (
    <section
      data-match-view="review"
      data-match-view-state={state}
      className="m-6 flex min-h-0 min-w-0 flex-1 flex-col border border-divider"
    >
      {children}
    </section>
  );
}

function Heading({ children }: { readonly children: ReactNode }) {
  return <h3 className="font-heading text-2xs tracking-caps text-neutral-600">{children}</h3>;
}

export const ReviewView: MatchViewModule = {
  id: 'review',
  Body: ReviewBody,
  Inspector: ReviewInspector,
};
