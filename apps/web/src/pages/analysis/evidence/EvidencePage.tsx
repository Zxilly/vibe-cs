/*
 * pages/ — 05 证据检索 (spec §7 `/evidence?view=evidence|annotations`, phase 3d).
 *
 * Replaces the pre-redesign `/evidence-search`; the old address redirects here.
 *
 * ── What this file does and does not do ────────────────────────────────────
 *
 * The page fetches and arranges; the pieces render. Reads go through
 * `data/evidence.ts` (§2.1 rule 6), the annotation writes through
 * `data/match.ts`, the result rows are `domain/match`'s `EvidenceRow`, and the
 * sub-components under `pages/evidence/` hold the layout. The only judgement
 * that lives *here* is where each thing goes and what the failure of each read
 * or write means.
 *
 * ── The URL is the search form (§4.4) ──────────────────────────────────────
 *
 * No filter is held in React state. `evidenceSearchParams.ts` reads the address
 * bar into an `EvidenceSearchState` and writes it back, so back / forward walk
 * the search history and a pasted link reproduces a result set exactly. The one
 * exception is the not-yet-submitted text in the search box, which lives inside
 * `EvidenceConditions` and has no meaning until 「检索」 is pressed.
 *
 * ── Two faces, two Inspectors ──────────────────────────────────────────────
 *
 * The 证据 face lists search hits and its Inspector describes the current hit;
 * the 注释 face lists every note across every match and its Inspector
 * describes the current note. Each face has its own selection field in the
 * URL (`evidence`, `annotation`), and each falls back to its first row so the
 * panel never sits empty beside a full list — the fallback writes nothing.
 *
 * ── §8 collapse ────────────────────────────────────────────────────────────
 *
 * `Inspector` already folds itself into a 46px strip plus a drawer below
 * 1100px, but the *page* still has to put it in a different place: docked it is
 * a column beside the results, folded it is a strip under them. `useCollapsed`
 * (`design/layout`) is the same observation the Inspector makes, so the two
 * cannot disagree, and no media query is written here.
 *
 * A failed read renders as a `Notice` with a recovery action. The two actions
 * whose write path does not exist yet — 保存为视图, 导出结果 — and 批量注释,
 * which has no multi-selection to act on, are disabled with their own reason
 * spelled out.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { evidenceIndexState, unsupportedEvidenceFilters } from '../../../data/evidence';
import { useEvidenceAnnotations, useEvidenceSearch } from '../../../data/evidence';
import { dataErrorMessage } from '../../../data/errors';
import { useCreateMatchAnnotation, useUpdateMatchAnnotation } from '../../../data/match';
import type { ProjectCollectedClip } from '../../../domain/project/collectedClip';
import { Empty } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Page, SelectionBar, Toolbar, useCollapsed } from '../../../design/layout';
import { Button, Seg } from '../../../design/primitives';
import { EVIDENCE_KIND } from '../../../domain/match';
import type { EvidenceAnnotation, EvidenceSearchItem } from '../../../shared/desktop/dto';
import { EvidenceAnnotationDetail } from './EvidenceAnnotationDetail';
import { EvidenceAnnotations } from './EvidenceAnnotations';
import { EvidenceConditions } from './EvidenceConditions';
import { EvidenceDetail } from './EvidenceDetail';
import { EvidenceEmpty } from './EvidenceEmpty';
import { EvidenceResults } from './EvidenceResults';
import { conditionSummaryText } from './conditionSummary';
import { evidenceEventLabel } from './evidenceEventLabel';
import { evidenceKindOf } from './evidenceItems';
import { AddToProjectDialog, type AddedProjectTarget } from '../../../domain/project/AddToProjectDialog';
import {
  EVIDENCE_PAGE_SIZE,
  EVIDENCE_VIEWS,
  RECENT_WINDOW_DAYS,
  activeConditions,
  clearedConditions,
  isoDaysAgo,
  readEvidenceSearch,
  toEvidenceQuery,
  writeEvidenceSearch,
  type EvidenceSearchState,
  type EvidenceView,
} from './evidenceSearchParams';

export function EvidencePage() {
  const { i18n } = useLingui();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const collapsed = useCollapsed(undefined);
  const [pendingClip, setPendingClip] = useState<ProjectCollectedClip | null>(null);
  const [addedProject, setAddedProject] = useState<AddedProjectTarget | null>(null);

  /*
   * The bridge has no saved-view and no export route, and the results list has
   * no multi-selection for a batch to act on. Each action is disabled with the
   * reason that is true of *it* — hiding them would make the page look finished
   * when it is not, and one shared sentence made 「导出结果」 talk about notes.
   * Declared inside the component so the macros are evaluated against the
   * active locale rather than at import time.
   */
  const saveViewReason = t`现在还不能保存视图`;
  const exportReason = t`现在还不能导出结果`;
  const batchAnnotateReason = t`现在还不能批量注释`;

  const state = readEvidenceSearch(params);
  /* No `useMemo`: TanStack hashes a query key by value, so a fresh object per
     render is the same cache entry. Memoising it would only add a dependency
     list that has to be kept in step with `EvidenceSearchState`. */
  const searchQuery = toEvidenceQuery(state);

  /* The search runs in both views. Its `availability` block is what the top bar
     counts — 「248 场比赛 · 1 284 632 条规范化证据」 — so the annotations view
     would otherwise have to state a number it cannot know. */
  const search = useEvidenceSearch(searchQuery);
  const annotations = useEvidenceAnnotations(
    { page: state.page, page_size: EVIDENCE_PAGE_SIZE },
    { enabled: state.view === 'annotations' },
  );

  const commit = (next: EvidenceSearchState) => {
    setParams(writeEvidenceSearch(next));
  };

  const availability = search.data?.availability;
  const rows = search.data?.items ?? [];
  const requestedRow = rows.find((row) => row.evidence_id === state.evidenceId) ?? null;
  // A persistent inspector should describe the result set immediately. The
  // first visible row is a focus fallback only: it does not write the URL or
  // turn on the explicit-selection action bar.
  const activeRow = requestedRow ?? rows[0] ?? null;
  const hasExplicitSelection = state.evidenceId !== '' && requestedRow !== null;
  const conditions = activeConditions(state);
  const dateGap = availability
    ? unsupportedEvidenceFilters(availability).find((gap) => gap.field === 'match_date')
    : undefined;

  const annotationRows = annotations.data?.items ?? [];
  const activeAnnotation =
    annotationRows.find((annotation) => annotation.id === state.annotationId)
    ?? annotationRows[0]
    ?? null;

  /* The notes on the current hit, for the 证据 face's Inspector. Same cache
     family as the list, so a write on either face refreshes both. */
  const rowNotes = useEvidenceAnnotations(
    { evidence_id: activeRow?.evidence_id ?? '', page: 1, page_size: EVIDENCE_PAGE_SIZE },
    { enabled: state.view === 'evidence' && activeRow !== null },
  );
  const createNote = useCreateMatchAnnotation();
  const updateNote = useUpdateMatchAnnotation();

  const toggleReviewState = (annotation: EvidenceAnnotation) => {
    updateNote.mutate({
      id: annotation.id,
      body: annotation.body,
      tags: annotation.tags,
      reviewState: annotation.review_state === 'open' ? 'resolved' : 'open',
    });
  };

  const clearSelection = () => commit({ ...state, evidenceId: '' });

  /* Esc drops an explicit selection, the way it closes anything else a click
     opened. Not while the add-to-project dialog is up: that Esc is its. */
  useEffect(() => {
    if (!hasExplicitSelection || pendingClip !== null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setParams(writeEvidenceSearch({ ...readEvidenceSearch(params), evidenceId: '' }));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasExplicitSelection, pendingClip, params, setParams]);

  const openWorkspace = (row: EvidenceSearchItem, view: 'overview' | 'replay') => {
    /* §4.4: the workspace reads its whole context off the query string, so a
       jump from here is a URL and not a store write. */
    const target = new URLSearchParams({
      view,
      round: String(row.round),
      tick: String(row.tick),
      evidence: row.evidence_id,
    });
    void navigate(`/match/${encodeURIComponent(row.demo_id)}?${target.toString()}`);
  };

  const openAnnotation = (annotation: EvidenceAnnotation) => {
    const target = new URLSearchParams({
      view: 'review',
      round: String(annotation.round),
      tick: String(annotation.tick),
      evidence: annotation.evidence_id,
    });
    void navigate(`/match/${encodeURIComponent(annotation.demo_id)}?${target.toString()}`);
  };

  const collectedClip = (row: EvidenceSearchItem): ProjectCollectedClip => {
    const eventLabel = evidenceEventLabel(row);
    const what = i18n._(eventLabel ?? EVIDENCE_KIND[evidenceKindOf(row)].label);
    const subject = row.actor_name ?? row.actor_id ?? row.demo_display_name;
    const target = row.target_name ?? row.target_id;
    return evidenceCollectedClip(row, target === null ? `${subject} · ${what}` : `${subject} → ${target} · ${what}`);
  };

  const searchError = dataErrorMessage(search.error);
  const annotationsError = dataErrorMessage(annotations.error);
  const updateError = dataErrorMessage(updateNote.error);

  const detail =
    state.view === 'evidence' ? (
      <EvidenceDetail
        row={activeRow}
        onOpenWorkspace={(row) => openWorkspace(row, 'overview')}
        onLocate={(row) => openWorkspace(row, 'replay')}
        onAddToVideo={(row) => setPendingClip(collectedClip(row))}
        notes={rowNotes.data?.items ?? []}
        notesLoading={rowNotes.isPending && rowNotes.fetchStatus !== 'idle'}
        onCreateNote={(row, body) =>
          createNote.mutateAsync({
            demo_id: row.demo_id,
            evidence_id: row.evidence_id,
            round: row.round,
            tick: row.tick,
            body,
            tags: [],
          })
        }
        createPending={createNote.isPending}
        noteError={dataErrorMessage(createNote.error)}
        onDismissNoteError={() => createNote.reset()}
      />
    ) : (
      <EvidenceAnnotationDetail
        annotation={activeAnnotation}
        onOpenWorkspace={openAnnotation}
        onToggleReviewState={toggleReviewState}
        togglePending={updateNote.isPending}
      />
    );

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>证据检索</Trans>}
          meta={
            availability === undefined ? null : (
              <Trans>
                {availability.indexed_demos} 场比赛 · {availability.indexed_items} 条证据
              </Trans>
            )
          }
          /* §10.3 gap 2's arithmetic for a short-title page: at the fold the
             content column is 996px; 「证据检索」 ≈ 90 + a truncating meta + 更多
             62 + gaps ≈ 60 leaves well over the ~170px the two secondary
             buttons need, so both stay on the bar rather than folding. */
          inlineActionsWhenCollapsed={2}
          actions={[
            {
              id: 'save-view',
              label: <Trans>保存为视图</Trans>,
              control: (
                <Button variant="secondary" size="sm" disabled disabledReason={saveViewReason}>
                  <Trans>保存为视图</Trans>
                </Button>
              ),
              disabled: true,
            },
            {
              id: 'export',
              label: <Trans>导出结果</Trans>,
              control: (
                <Button variant="secondary" size="sm" disabled disabledReason={exportReason}>
                  <Trans>导出结果</Trans>
                </Button>
              ),
              disabled: true,
            },
          ]}
        >
          <Seg
            name="evidence-view"
            value={state.view}
            options={EVIDENCE_VIEWS.map((view) => ({
              value: view,
              label: view === 'annotations' ? <Trans>注释</Trans> : <Trans>证据</Trans>,
            }))}
            onChange={(view: EvidenceView) => commit({ ...state, view, page: 1 })}
            aria-label={t`证据检索视图`}
          />
        </Toolbar>
      }
      bar={
        state.view === 'evidence' ? (
          <EvidenceConditions
            state={state}
            onChange={commit}
            recentFrom={isoDaysAgo(new Date(), RECENT_WINDOW_DAYS)}
            {...(dateGap === undefined
              ? {}
              : {
                  dateDisabledReason:
                    dateGap.reason ?? t`这批证据没有比赛日期，无法按时间筛选`,
                })}
            summary={
              search.data === undefined ? null : (
                <Trans>命中 {search.data.total} 条 · 排序：时间倒序</Trans>
              )
            }
          />
        ) : null
      }
      footer={
        collapsed ? (
          detail
        ) : state.view !== 'evidence' || !hasExplicitSelection || activeRow === null ? null : (
          <SelectionBar
            summary={<Trans>已选 1 条证据</Trans>}
            primary={
              <Button variant="primary" size="sm" onClick={() => activeRow === null ? undefined : setPendingClip(collectedClip(activeRow))}>
                <Trans>加入作品</Trans>
              </Button>
            }
          >
            <Button variant="secondary" size="sm" onClick={clearSelection}>
              <Trans>清空选择</Trans>
            </Button>
            <Button variant="secondary" size="sm" disabled disabledReason={batchAnnotateReason}>
              <Trans>批量注释</Trans>
            </Button>
          </SelectionBar>
        )
      }
    >
      <>
      {addedProject === null ? null : (
        <Alert
          className="mx-4 mt-4"
          variant="success"
          action={{ label: <Trans>打开作品</Trans>, onAction: () => void navigate(`/projects/${encodeURIComponent(addedProject.id)}?step=select`) }}
        >
          <Trans>已加入「{addedProject.name}」</Trans>
        </Alert>
      )}
      {updateError === null ? null : (
        <Alert
          className="mx-4 mt-4"
          variant="danger"
          action={{ label: <Trans>知道了</Trans>, onAction: () => updateNote.reset() }}
        >
          <Trans>注释没有改成功：{updateError}</Trans>
        </Alert>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {state.view === 'evidence' ? (
            <EvidenceResults
              rows={rows}
              perspective={{ player: state.player }}
              total={search.data?.total ?? 0}
              page={state.page}
              onPageChange={(page) => commit({ ...state, page })}
              activeId={activeRow?.evidence_id ?? ''}
              /* Pressing the selected row again releases it — the button says
                 `aria-pressed`, so it toggles. */
              onSelect={(row) =>
                commit({ ...state, evidenceId: row.evidence_id === state.evidenceId ? '' : row.evidence_id })
              }
              onLocate={(row) => openWorkspace(row, 'replay')}
              onAddToVideo={(row) => setPendingClip(collectedClip(row))}
              loading={search.isPending}
              {...(searchError === null
                ? {}
                : { error: { message: searchError, onRetry: () => void search.refetch() } })}
              empty={
                availability === undefined ? null : (
                  <EvidenceEmpty
                    indexState={evidenceIndexState(availability)}
                    indexedItems={availability.indexed_items}
                    indexedDemos={availability.indexed_demos}
                    totalAnalyses={availability.total_analyses}
                    conditions={conditions}
                    conditionSummary={conditionSummaryText(conditions)}
                    onRetry={() => void search.refetch()}
                    {...(conditions.length === 0
                      ? {}
                      : { onClearConditions: () => commit(clearedConditions(state)) })}
                  />
                )
              }
            />
          ) : (
            <EvidenceAnnotations
              rows={annotationRows}
              total={annotations.data?.total ?? 0}
              page={state.page}
              onPageChange={(page) => commit({ ...state, page })}
              activeId={activeAnnotation?.id ?? ''}
              onSelect={(annotation) => commit({ ...state, annotationId: annotation.id })}
              onOpen={openAnnotation}
              onToggleReviewState={toggleReviewState}
              togglePending={updateNote.isPending}
              loading={annotations.isPending}
              {...(annotationsError === null
                ? {}
                : {
                    error: {
                      message: annotationsError,
                      onRetry: () => void annotations.refetch(),
                    },
                  })}
              empty={
                <Empty
                  className="m-7"
                  title={<Trans>还没有注释</Trans>}
                  description={
                    <Trans>
                      在证据视图里选一条结果，在右侧「注释」栏写下为什么它值得剪，注释就会出现在这里，并且跨比赛可检索。
                    </Trans>
                  }
                  actions={
                    <Button variant="secondary" onClick={() => commit({ ...state, view: 'evidence', page: 1 })}>
                      <Trans>回到证据视图</Trans>
                    </Button>
                  }
                />
              }
            />
          )}
        </div>
        {collapsed ? null : detail}
      </div>
      <AddToProjectDialog
        open={pendingClip !== null}
        clips={pendingClip === null ? [] : [pendingClip]}
        onClose={() => setPendingClip(null)}
        onAdded={setAddedProject}
      />
      </>
    </Page>
  );
}

/** The clip a hit becomes. `label` is the row's own words — 「Kael → Corvin ·
 *  击杀」 — because it is what the project's clip list and the undo history
 *  will print. */
function evidenceCollectedClip(row: EvidenceSearchItem, label: string): ProjectCollectedClip {
  return {
    id: `${row.demo_id}:evidence:${row.evidence_id}`,
    demoId: row.demo_id,
    matchLabel: row.demo_display_name,
    kind: 'evidence',
    label,
    round: row.round,
    playerId: row.actor_id,
    playerName: row.actor_name,
    tickRate: null,
    highlightId: row.source_kind === 'highlight' ? row.source_id : null,
    evidenceId: row.evidence_id,
    startTick: row.tick,
    endTick: row.end_tick,
    durationSeconds: null,
    addedAt: new Date().toISOString(),
  };
}
