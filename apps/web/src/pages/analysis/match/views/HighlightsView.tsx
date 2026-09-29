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
 * from its rows to `HighlightHandoffSource`. `HighlightCandidate` retains the
 * stable player id as well as the display name so the ordinary 「加入作品」
 * path can produce the same recordable Capture Intent; `demo_id` remains owned
 * by the enclosing match workspace.
 *
 * A selection that cannot be bound — no Demo, a player the analysis identifies
 * some way other than a SteamID64, a zero-length window — **disables the action
 * and says which**, rather than creating a plan the recording page could only
 * refuse.
 *
 * ── One selection, two halves ─────────────────────────────────────────────
 *
 * The checked rows are not an address, so they live in React state — but the
 * Inspector is a sibling of the list, rendered by the shell, and an Inspector
 * that keeps offering 「把这条高光加入作品」 for one row while the strip under
 * the list offers 「加入作品」 for two is two primary actions with two scopes on
 * one screen. So the set is held in `HighlightBatch`, which the module's
 * `Provider` scopes around both halves: while rows are checked the Inspector
 * describes *that* set and carries the one primary action for it, and the
 * strip's own button steps down to a secondary.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { analysisIsMissing, useMatchAnalysis } from '../../../../data/match';
import { Empty, Pagination } from '../../../../design/data';
import { Button, Seg, Badge, Kbd } from '../../../../design/primitives';
import { SelectionBar } from '../../../../design/layout';
import {
  HIGHLIGHT_KIND,
  HighlightRow,
  HighlightRowSkeleton,
  formatTickRangeSeconds,
  type HighlightKind,
} from '../../../../domain/match';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import { HighlightPreview } from './HighlightPreview';
import { NotAnalysedState } from './viewChrome';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import {
  currentHighlightId,
  filterHighlights,
  HIGHLIGHT_PAGE_SIZE,
  highlightPage,
  highlightSelection,
  highlightKindCounts,
  matchHighlights,
  toggleSelected,
  visibleSelection,
} from './highlightModel';

type FilterValue = 'all' | HighlightKind;

/* ── the batch selection ─────────────────────────────────────────────────── */

interface HighlightBatch {
  readonly selected: ReadonlySet<string>;
  readonly setSelected: (next: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => void;
  /** The Inspector preview's play state: the list's Space and the preview's
      button are one control. */
  readonly previewPlaying: boolean;
  readonly setPreviewPlaying: (playing: boolean) => void;
}

const NO_BATCH: HighlightBatch = {
  selected: new Set(),
  setSelected: () => undefined,
  previewPlaying: false,
  setPreviewPlaying: () => undefined,
};
const HighlightBatchContext = createContext<HighlightBatch>(NO_BATCH);

function HighlightBatchProvider({ children }: { readonly children: ReactNode }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const batch = useMemo<HighlightBatch>(
    () => ({ selected, setSelected, previewPlaying, setPreviewPlaying }),
    [selected, previewPlaying],
  );
  return <HighlightBatchContext.Provider value={batch}>{children}</HighlightBatchContext.Provider>;
}

/**
 * Whether the focused element owns a key the list would otherwise answer: a
 * field, an open menu or dialog, a radio group's arrows, a button's Space.
 */
function ownsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return true;
  if ((key === 'ArrowUp' || key === 'ArrowDown') && target.closest('[role="radiogroup"], [role="tablist"]')) return true;
  return key === ' ' && target.closest('button, a, [role="button"], [role="checkbox"], [role="radio"]') !== null;
}

/* ── the body ────────────────────────────────────────────────────────────── */

function HighlightsBody({ demoId, context, updateContext, addToVideo }: MatchViewProps) {
  const id = demoId === '' ? null : demoId;
  const analysis = useMatchAnalysis(id);
  const { i18n } = useLingui();

  const [filter, setFilter] = useState<FilterValue>('all');
  const [page, setPage] = useState(1);
  const { selected, setSelected, previewPlaying, setPreviewPlaying } = useContext(HighlightBatchContext);
  const listRef = useRef<HTMLUListElement>(null);

  const highlights = useMemo(() => matchHighlights(analysis.data), [analysis.data]);
  const counts = useMemo(() => highlightKindCounts(highlights), [highlights]);
  const visible = useMemo(
    () => filterHighlights(highlights, filter === 'all' ? null : filter),
    [highlights, filter],
  );
  const current = context.highlight ?? currentHighlightId(highlights, context.round, context.tick, context.player);
  const pageCount = Math.max(1, Math.ceil(visible.length / HIGHLIGHT_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageHighlights = useMemo(
    () => highlightPage(visible, currentPage),
    [visible, currentPage],
  );
  const focusedCurrent = current ?? highlights[0]?.id ?? null;
  useEffect(() => {
    if (current !== null) listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [current, currentPage, pageHighlights]);
  const batch = useMemo(
    () => visibleSelection(selected, pageHighlights),
    [selected, pageHighlights],
  );

  useEffect(() => {
    if (current === null) return;
    const index = visible.findIndex((highlight) => highlight.id === current);
    if (index >= 0) setPage(Math.floor(index / HIGHLIGHT_PAGE_SIZE) + 1);
  }, [current, visible]);

  /* Picking is repetitive, so the list answers the keyboard while focus is not
     in something that owns the key: ↑/↓ step through the visible highlights
     and start the preview, Space plays or pauses it, A adds the current one,
     X ticks it for the batch. */
  const keys = useRef({ visible, focusedCurrent, previewPlaying, addToVideo, updateContext });
  keys.current = { visible, focusedCurrent, previewPlaying, addToVideo, updateContext };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (!['ArrowUp', 'ArrowDown', ' ', 'a', 'x'].includes(key) || ownsKey(event.target, key)) return;
      const state = keys.current;
      const index = state.visible.findIndex((highlight) => highlight.id === state.focusedCurrent);
      const here = state.visible[index] ?? null;
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        const step = key === 'ArrowDown' ? 1 : -1;
        const next = state.visible[Math.min(state.visible.length - 1, Math.max(0, index + step))];
        if (next === undefined) return;
        event.preventDefault();
        state.updateContext(
          { highlight: next.id, round: next.round, player: next.playerId ?? null },
          { replace: true },
        );
        setPreviewPlaying(true);
        return;
      }
      if (here === null) return;
      event.preventDefault();
      if (key === ' ') setPreviewPlaying(!state.previewPlaying);
      else if (key === 'a') {
        if (!state.addToVideo.disabled) state.addToVideo.onAdd?.(highlightSelection(here));
      } else setSelected((current_) => toggleSelected(current_, here.id, !current_.has(here.id)));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setPreviewPlaying, setSelected]);

  /*
   * The handoff's payload, built from the *wire* highlights rather than from
   * the rows: a row shows a player's name, and the plan needs their SteamID64.
   */
  if (analysisIsMissing(analysis.error)) {
    return (
      <Frame state="empty">
        <NotAnalysedState demoId={demoId} />
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
          description={<Trans>没有找到残局、多杀或穿墙等高光。</Trans>}
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
          onChange={(value) => {
            setFilter(value as FilterValue);
            setPage(1);
          }}
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
        <p data-highlights-keys="" className="flex items-center gap-1.5 text-xs text-neutral-600">
          <Kbd>↑</Kbd><Kbd>↓</Kbd> <Trans>切换</Trans>
          <Kbd><Trans>空格</Trans></Kbd> <Trans>预览</Trans>
          <Kbd>A</Kbd> <Trans>加入</Trans>
          <Kbd>X</Kbd> <Trans>勾选</Trans>
          <span aria-hidden="true">·</span>
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
        <ul
          ref={listRef}
          data-highlights="list"
          data-highlights-page={currentPage}
          className="min-h-0 flex-1 list-none overflow-y-auto overscroll-y-contain"
        >
          {pageHighlights.map((highlight) => (
            <li key={highlight.id}>
              <HighlightRow
                highlight={highlight}
                selected={selected.has(highlight.id)}
                onSelectedChange={(next) =>
                  setSelected((current_) => toggleSelected(current_, highlight.id, next))
                }
                current={highlight.id === focusedCurrent}
                action={
                  <span className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => updateContext({ highlight: highlight.id, round: highlight.round, tick: highlight.startTick, player: highlight.playerId ?? null })}
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
                        addToVideo.onAdd?.(highlightSelection(highlight))
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

      <footer className="flex-none">
        <Pagination
          page={currentPage}
          pageSize={HIGHLIGHT_PAGE_SIZE}
          total={visible.length}
          summary={<Trans>共 {highlights.length} 条高光，当前筛出 {visible.length} 条</Trans>}
          onPageChange={(next) => {
            setPage(next);
            setSelected(new Set());
          }}
        />
        {batch.length === 0 ? null : (
          <SelectionBar
            summary={<Trans>已选 {batch.length} 条</Trans>}
            /* Secondary, not primary: the Inspector carries the one primary
               action for this set (see the header), and two blue buttons for
               one set on one screen is the thing being avoided. */
            primary={
              <Button
                variant="secondary"
                size="sm"
                disabled={addToVideo.disabled}
                {...(addToVideo.disabledReason === undefined
                  ? {}
                  : { disabledReason: addToVideo.disabledReason })}
                onClick={() => {
                  addToVideo.onAddMany?.(batch.map(highlightSelection));
                }}
              >
                <Trans>加入作品</Trans>
              </Button>
            }
          >
            <Button variant="secondary" size="sm" onClick={() => setSelected(new Set())}>
              {/* 清空 rather than 清除: `PlayersPage` and `PlayerComparePanel`
                  already publish this exact sentence, and one catalogue entry
                  for one action is the point. */}
              <Trans>清空选择</Trans>
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
  const { selected, setSelected, previewPlaying, setPreviewPlaying } = useContext(HighlightBatchContext);
  const batch = useMemo(() => visibleSelection(selected, highlights), [selected, highlights]);
  const currentId = context.highlight ?? currentHighlightId(highlights, context.round, context.tick, context.player)
    ?? highlights[0]?.id
    ?? null;
  const highlight = highlights.find((entry) => entry.id === currentId) ?? null;

  if (batch.length > 0) {
    return (
      <MatchInspectorPanel
        title={<Trans>已选 {batch.length} 条高光</Trans>}
        summary={<Trans>勾选的 {batch.length} 条会一起加入</Trans>}
        addToVideo={addToVideo}
        addLabel={<Trans>把已选 {batch.length} 条加入作品</Trans>}
        batch={batch.map(highlightSelection)}
        collapsed={collapsed}
        secondaryActions={
          <Button variant="secondary" size="sm" grow onClick={() => setSelected(new Set())}>
            <Trans>清空选择</Trans>
          </Button>
        }
      >
        <ul data-highlights-batch="" className="flex list-none flex-col gap-2 text-sm">
          {batch.map((entry) => (
            <li key={entry.id} className="flex items-baseline gap-2">
              <span className="flex-none font-mono text-xs text-neutral-700">R{entry.round}</span>
              <span className="min-w-0 truncate">
                {entry.subject === undefined ? null : <>{entry.subject} · </>}
                {entry.label ?? i18n._(HIGHLIGHT_KIND[entry.kind].label)}
              </span>
            </li>
          ))}
        </ul>
      </MatchInspectorPanel>
    );
  }

  if (highlight === null) {
    return (
      <MatchInspectorPanel
        title={<Trans>未选中高光</Trans>}
        summary={<Trans>共 {highlights.length} 条高光</Trans>}
        addToVideo={addToVideo}
        collapsed={collapsed}
      >
        <p className="text-sm text-neutral-700">
          {highlights.length === 0 ? (
            <Trans>这场比赛没有检出高光，这里没有可以加入作品的片段。</Trans>
          ) : (
            <Trans>选择高光查看详情。</Trans>
          )}
        </p>
      </MatchInspectorPanel>
    );
  }

  const seconds = formatTickRangeSeconds(highlight.startTick, highlight.endTick, highlight.tickRate);

  return (
    <MatchInspectorPanel
      title={<Trans>选中：第 {highlight.round} 回合的高光</Trans>}
      summary={<>{highlight.subject} · {highlight.label ?? i18n._(HIGHLIGHT_KIND[highlight.kind].label)}</>}
      addToVideo={addToVideo}
      addLabel={<Trans>把这条高光加入作品</Trans>}
      selection={highlightSelection(highlight)}
      collapsed={collapsed}
    >
      <HighlightPreview
        demoId={demoId}
        highlight={highlight}
        playing={previewPlaying}
        onPlayingChange={setPreviewPlaying}
      />
      <dl className="mt-4 flex flex-col gap-3 text-sm">
        <Row label={<Trans>类型</Trans>}>
          <Badge variant="accent">{highlight.label ?? i18n._(HIGHLIGHT_KIND[highlight.kind].label)}</Badge>
        </Row>
        {highlight.subject === undefined ? null : (
          <Row label={<Trans>选手</Trans>}>{highlight.subject}</Row>
        )}
        {highlight.description === undefined ? null : (
          <Row label={<Trans>说明</Trans>}>{highlight.description}</Row>
        )}
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

function Row({ label, children }: { readonly label: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-heading text-xs tracking-caps text-neutral-600">{label}</dt>
      <dd className="min-w-0 break-words text-text">{children}</dd>
    </div>
  );
}

export const HighlightsView: MatchViewModule = {
  inspectorMode: 'persistent',
  id: 'highlights',
  Body: HighlightsBody,
  Inspector: HighlightsInspector,
  Provider: HighlightBatchProvider,
};
