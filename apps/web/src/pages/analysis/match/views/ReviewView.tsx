/* Match conclusions, model commentary and evidence annotations. Annotation
 * writes require the selected evidence ID, round and tick. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { dataErrorMessage, toDataError } from '../../../../data/errors';
import {
  analysisIsMissing,
  useCreateMatchAnnotation,
  useDeleteMatchAnnotation,
  useGenerateMatchReview,
  useMatchAnalysis,
  useMatchAnnotations,
  useUpdateMatchAnnotation,
} from '../../../../data/match';
import { Empty, Skeleton } from '../../../../design/data';
import { Alert } from '../../../../design/feedback';
import { Button, Seg, Badge, Input } from '../../../../design/primitives';
import type { EvidenceAnnotation } from '../../../../shared/desktop/dto';
import { RouteLink } from '../../../shared/navigation/RouteLink';
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
  const annotationsError = toDataError(annotations.error, t`请重试`)?.message ?? null;
  const generateReview = () => {
    if (id === null) return;
    review.mutate({
      demoId: id,
      request: { scope: 'match', player_id: context.player, highlight_ids: [], tone: 'analytical' },
    });
  };

  if (analysisIsMissing(analysis.error)) {
    return (
      <Frame state="empty">
        <NotAnalysedState demoId={demoId} />
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
                  <Trans>我的注释</Trans>{annotations.data === undefined ? null : ` ${tally.total}`}
                </>
              ),
            },
          ]}
        />
        <div className="flex-1" aria-hidden="true" />
        <Button
          variant={tab === 'conclusions' ? 'primary' : 'secondary'}
          size="sm"
          disabled={id === null || analysis.data === undefined || review.isPending}
          {...(id === null
            ? { disabledReason: t`还没有打开一场比赛` }
            : analysis.data === undefined ? { disabledReason: t`等待比赛分析加载完成` } : {})}
          onClick={generateReview}
        >
          {review.isPending ? <Trans>正在生成…</Trans> : <Trans>生成 AI 点评</Trans>}
        </Button>
      </header>

      {tab === 'conclusions' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @min-[720px]/review:flex-row @min-[720px]/review:overflow-hidden">
          <section
            data-review-insights=""
            aria-label={t`自动洞察`}
            className="flex min-w-0 flex-none flex-col gap-3 border-b border-divider p-4 @min-[720px]/review:min-h-0 @min-[720px]/review:flex-1 @min-[720px]/review:overflow-y-auto @min-[720px]/review:overscroll-y-contain @min-[720px]/review:border-r @min-[720px]/review:border-b-0"
          >
            <Heading>
              <Trans>自动洞察</Trans>
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
            className="flex min-w-0 flex-none flex-col gap-3 p-4 @min-[720px]/review:min-h-0 @min-[720px]/review:flex-1 @min-[720px]/review:overflow-y-auto @min-[720px]/review:overscroll-y-contain"
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
                action={{ label: <Trans>重试</Trans>, onAction: generateReview, disabled: review.isPending }}
              >
                <Trans>生成点评失败：{dataErrorMessage(review.error) ?? t`服务没有给出原因`}</Trans>
              </Alert>
            )}

            {review.isPending ? (
              <p role="status" className="text-base leading-normal text-neutral-600"><Trans>正在生成点评…</Trans></p>
            ) : review.data === undefined && review.error == null ? (
              <p className="text-base leading-relaxed text-neutral-600">
                <Trans>
                  还没有点评。连接模型后即可生成。
                </Trans>
              </p>
            ) : review.data === undefined ? null : (
              <>
                <p className="max-w-[75ch] whitespace-pre-wrap break-words text-base leading-relaxed">
                  {review.data.commentary}
                </p>
                <Citations
                  ids={review.data.evidence_ids}
                  analysis={analysis.data}
                  updateContext={updateContext}
                />
                <p className="text-base leading-normal text-neutral-600">
                  <Trans>
                    由 {review.data.provider} 的 {review.data.model} 生成。
                  </Trans>
                  {review.data.cached ? (
                    <>
                      {' '}
                      <Trans>已复用同一批证据的上次点评。</Trans>
                    </>
                  ) : null}
                </p>
              </>
            )}

            <div className="border-t border-divider pt-3">
              <Heading level={3}>
                <Trans>我的注释</Trans>
              </Heading>
              <AnnotationPreview
                rows={rows}
                loading={annotations.isPending}
                error={annotationsError}
                onRetry={() => void annotations.refetch()}
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
          error={annotationsError}
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

      {gaps.length === 0 ? null : (
        <details className="border-t border-divider pt-3">
          <summary className="cursor-pointer text-sm text-neutral-600">
            <Trans>不可用的统计（{gaps.length}）</Trans>
          </summary>
          <div className="mt-2 divide-y divide-divider">
            {gaps.map((gap) => <UnavailableCard key={gap.id} gap={gap} />)}
          </div>
        </details>
      )}
    </>
  );
}

function InsightCard({
  id,
  title,
  detail,
  action,
}: {
  readonly id: string;
  readonly title: ReactNode;
  readonly detail: ReactNode;
  readonly action: ReactNode;
}) {
  return (
    <article
      data-insight={id}
      className="border-b border-divider pb-3"
    >
      <h3 className="mb-1 text-sm leading-normal">{title}</h3>
      <p className="text-base leading-relaxed text-neutral-600">{detail}</p>
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
      className="py-2 text-base leading-relaxed text-neutral-600"
    >
      <p>
        <CapabilityName gap={gap} />
      </p>
      {gap.reason === null ? (
        <p>
          <Trans>分析结果未提供原因。</Trans>
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
      <p className="text-base leading-relaxed text-neutral-700">
        <Trans>这段点评没有回引证据。</Trans>
      </p>
    );
  }

  return (
    <div className="text-base leading-relaxed text-neutral-700">
      <p>
        <Trans>引用了 {citations.length} 条证据：</Trans>
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
      <Trans>第 {citation.round} 回合</Trans>
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
  error,
  onRetry,
  onOpenAll,
}: {
  readonly rows: readonly EvidenceAnnotation[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onOpenAll: () => void;
}) {
  if (error !== null) {
    return <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
      <Trans>无法加载注释：{error}</Trans>
    </Alert>;
  }
  if (loading) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <Skeleton width="86%" />
        <Skeleton width="70%" />
        <span className="sr-only"><Trans>正在读取注释</Trans></span>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-base leading-relaxed text-neutral-600">
        <Trans>还没有注释。选择一个事件即可添加。</Trans>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex list-none flex-col gap-2">
        {rows.slice(0, 3).map((row) => (
          <li key={row.id} className="flex items-start gap-2 border-b border-divider py-2 text-base leading-normal">
            <span className="min-w-0 max-w-[75ch] flex-1 whitespace-pre-wrap break-words">{row.body}</span>
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
              ? { disabledReason: t`先在回放或回合中选择一个事件` }
              : {})}
          >
            <Trans>添加注释</Trans>
          </Button>
        </div>
        {anchor === null ? (
          <p className="text-base leading-normal text-neutral-600">
            <Trans>先选择一个事件，再添加注释。</Trans>
          </p>
        ) : (
          <p className="text-base leading-normal text-neutral-600">
            <Trans>
              注释将添加到第 {anchor.round} 回合的所选事件。
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
                <p className="min-w-0 max-w-[75ch] flex-1 whitespace-pre-wrap break-words text-base leading-normal">{row.body}</p>
                <StateTag state={row.review_state} />
              </div>
              <p className="mt-1 font-mono text-xs text-neutral-600">
                <Trans>
                  第 {row.round} 回合
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
  const annotationsError = toDataError(annotations.error, t`请重试`)?.message ?? null;
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
          : annotationsError !== null ? <Trans>注释加载失败</Trans>
            : annotations.data === undefined ? <Trans>正在读取注释</Trans>
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
          <section data-review-default-insight="" className="border border-accent-300 bg-accent-100 p-3">
            <h3 className="font-heading text-lg">
              <Trans>
                {opening.leaderName} 拿下了 {opening.roundsWithOpening} 个回合里的 {opening.leaderCount} 次首杀
              </Trans>
            </h3>
            <p className="mt-1 text-base leading-normal text-neutral-700">
              <Trans>首杀指每回合的第一次击杀。</Trans>
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
          <p className="text-base leading-normal text-neutral-700">
            {context.evidence === null ? (
              <Trans>在回放或回合视图中选择事件，再到「我的注释」添加注释。</Trans>
            ) : (
              <Trans>已选中事件，可在「我的注释」中添加注释。</Trans>
            )}
          </p>
        )}
        {annotationsError !== null ? (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void annotations.refetch() }}>
            <Trans>无法加载注释：{annotationsError}</Trans>
          </Alert>
        ) : annotations.data === undefined ? (
          <p role="status" className="text-base leading-normal text-neutral-600"><Trans>正在读取注释</Trans></p>
        ) : <dl className="flex flex-col gap-2">
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
        </dl>}
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
      className="@container/review m-4 flex min-h-0 min-w-0 flex-1 flex-col border border-divider min-[1400px]:m-6"
    >
      {children}
    </section>
  );
}

function Heading({ children, level = 2 }: { readonly children: ReactNode; readonly level?: 2 | 3 }) {
  const Tag = level === 2 ? 'h2' : 'h3';
  return <Tag className="text-sm font-medium">{children}</Tag>;
}

export const ReviewView: MatchViewModule = {
  id: 'review',
  Body: ReviewBody,
  Inspector: ReviewInspector,
};
