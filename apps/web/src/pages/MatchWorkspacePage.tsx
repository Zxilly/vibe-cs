/*
 * pages/ — 03 比赛工作区 (spec §7 `/match/:demoId?view=…`, phase 3c).
 *
 * §7 promotes the demo id from a query to a path segment, which is what makes
 * the crumb 「资料库 › Aurora vs Meridian › 概览」 expressible at all — the match
 * is a first-class identity, not a filter on the analysis page.
 *
 * ── What this file owns ────────────────────────────────────────────────────
 *
 * The shell, and only the shell: the context bar, the view rail, the Inspector
 * frame, and the address. The nine views are `pages/match/views/*` and are
 * addressed through the exhaustive registry in `pages/match/viewContract.ts` —
 * which is also where the contract they are written against is documented.
 *
 * Three things are deliberately constant across all nine views, because the
 * reference draws them that way:
 *
 *   `domain/match/MatchContextBar`   the identity of the match
 *   `design/layout/SubNav`           the 190px rail (`--w-subnav`)
 *   `design/layout/Inspector`        the 380px detail panel
 *
 * ── §8, all three collapse rules at once ───────────────────────────────────
 *
 * This is the only page in the product where all three fire:
 *
 *   rule 1  the shell's side nav folds — `app/`, not here
 *   rule 2  the Inspector becomes a 46px summary strip plus a drawer, so it
 *           moves out of the content row and into `Page`'s footer slot
 *   rule 3  the rail becomes a row of top tabs, so it moves out of the content
 *           row and into `Page`'s bar slot
 *
 * `SubNav` and `Inspector` each implement their own fold; what a component
 * cannot do is re-parent itself, so the *placement* is decided here. Both are
 * handed the same `collapsed` value, observed once with `useCollapsed`, because
 * two independent subscriptions can be read in different states mid-transition
 * and the two halves must fold together. No media query is written in this
 * file.
 *
 * The context bar folds on its own, later, at `CONTEXT_BAR_BREAKPOINT_PX`
 * (1600) — crossing 1100 upward makes the content column *narrower*, which
 * §10.3 deviation 1 explains. That is the component's business and is not
 * repeated here.
 *
 * ── Where the data comes from ──────────────────────────────────────────────
 *
 * Two reads, both shared with the views by query key rather than by props:
 *
 *   `useDemo`           the library record — map, date, team names and the
 *                       final score. It answers even for a demo that has never
 *                       been analysed, which is the state the bar has to look
 *                       right in.
 *   `useMatchAnalysis`  the parsed match. The bar prefers it where it has an
 *                       answer (tick rate, real round count), and the rail's
 *                       「高光 18」 badge is its highlight count.
 *
 * The shell does **not** render the analysis's loading or error states: eight
 * of the nine views call the same hook and each renders its own three states
 * next to the thing that failed (§4.1 sets `throwOnError: false` for exactly
 * that). What the shell does own is the failure of the *identity* read — if the
 * demo record cannot be fetched the bar says so in place and keeps 「‹ 资料库」
 * reachable, which is what a user whose workspace failed to open needs.
 *
 * ── 「加入作品」 is one workspace action ────────────────────────────────────
 *
 * Scoreboard rows, highlights, rounds and Inspector footers all call the same
 * action. It opens one project picker and writes the selection to the client-
 * side project collection; no view keeps its own queue or its own feedback.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useDemo } from '../data/demos';
import { dataErrorMessage } from '../data/errors';
import { useMatchAnalysis } from '../data/match';
import type { ProjectCollectedClip } from '../domain/project/collectedClip';
import { Alert } from '../design/feedback';
import { Page, SubNav, useCollapsed, type SubNavItem } from '../design/layout';
import { Button } from '../design/primitives';
import { MatchContextBar } from '../domain/match';
import { MatchInspectorPanel } from './match/MatchInspectorPanel';
import { focusedPlayers, matchIdentity, matchTeams, roundLabel } from './match/matchModel';
import {
  MATCH_VIEW,
  MATCH_VIEW_IDS,
  MATCH_VIEWS,
  type MatchContextUpdateOptions,
  type MatchVideoAction,
  type MatchViewId,
  type MatchViewProps,
} from './match/viewContract';
import { AddToProjectDialog, type AddedProjectTarget } from './project/AddToProjectDialog';
import {
  patchWorkspaceContext,
  readWorkspaceContext,
  writeWorkspaceContext,
  type MatchContextPatch,
} from './match/workspaceContext';

export function MatchWorkspacePage() {
  const { demoId = '' } = useParams<{ demoId: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { i18n } = useLingui();
  const collapsed = useCollapsed(undefined);
  const [pendingClips, setPendingClips] = useState<readonly ProjectCollectedClip[]>([]);
  const [addedProject, setAddedProject] = useState<AddedProjectTarget | null>(null);

  const context = readWorkspaceContext(params);
  const view = MATCH_VIEWS[context.view];

  const id = demoId === '' ? null : demoId;
  const demo = useDemo(id);
  const analysis = useMatchAnalysis(id);

  const updateContext = (patch: MatchContextPatch, options?: MatchContextUpdateOptions) => {
    setParams(writeWorkspaceContext(patchWorkspaceContext(context, patch)), {
      replace: options?.replace === true,
    });
  };

  const matchLabel = demo.data?.display_name ?? demoId;
  const addToVideo: MatchVideoAction = {
    disabled: false,
    onAdd: (selection) => setPendingClips([collectedClip(demoId, matchLabel, selection)]),
    onAddMany: (selections) => setPendingClips(selections.map((selection) => collectedClip(demoId, matchLabel, selection))),
  };

  const viewProps: MatchViewProps = {
    demoId,
    context,
    updateContext,
    addToVideo,
    collapsed,
  };

  const identity = matchIdentity(demoId, { demo: demo.data, analysis: analysis.data });
  const { teamA, teamB } = matchTeams({ demo: demo.data, analysis: analysis.data });
  const focus = focusedPlayers(analysis.data, context.player).map((player) => ({
    ...player,
    onRemove: () => updateContext({ player: null }),
  }));

  const highlightCount = analysis.data?.highlights.length ?? null;
  const items: readonly SubNavItem[] = MATCH_VIEW_IDS.map((viewId) => ({
    id: viewId,
    label: i18n._(MATCH_VIEW[viewId].label),
    /* The count is drawn only once it is known. A badge that reads 0 while the
       analysis is still loading is a claim, not a placeholder. */
    ...(viewId === 'highlights' && highlightCount !== null ? { badge: highlightCount } : {}),
  }));

  const identityError = dataErrorMessage(demo.error);
  const round = roundLabel(context.round);

  /* `SubNav` speaks in plain ids because it is a design-layer component and
     knows nothing about §7. Narrowing here rather than casting means a rail
     item that ever stopped matching the union would be ignored instead of
     writing an unreachable `?view=` into the address. */
  const selectView = (next: string) => {
    const target = MATCH_VIEW_IDS.find((candidate): candidate is MatchViewId => candidate === next);
    if (target !== undefined) updateContext({ view: target });
  };

  const inspector =
    view.Inspector === undefined ? (
      <MatchInspectorPanel
        title={<Trans>选中项</Trans>}
        summary={<Trans>未选中任何内容</Trans>}
        addToVideo={addToVideo}
        collapsed={collapsed}
      >
        <p className="text-sm text-neutral-700">
          <Trans>
            在左侧选择回合、选手或证据，详情会显示在这里。
            选择也会写入地址，方便分享和后退。
          </Trans>
        </p>
      </MatchInspectorPanel>
    ) : (
      <view.Inspector {...viewProps} />
    );

  return (
    <Page
      scroll={false}
      toolbar={
        <MatchContextBar
          match={identity}
          teamA={teamA}
          teamB={teamB}
          {...(round === null ? {} : { roundRange: <Trans>当前 {round}</Trans> })}
          focusedPlayers={focus}
          loading={demo.isPending}
          {...(identityError === null
            ? {}
            : {
                failure: {
                  message: identityError,
                  onRetry: () => void demo.refetch(),
                },
              })}
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateContext({ view: 'review' })}
              >
                <Trans>AI 点评</Trans>
              </Button>
              {/* §8's non-negotiable line: the primary action is visible at
                  every width and never enters an overflow menu. `MatchContextBar`
                  keeps its `actions` slot out of the fold for that reason. */}
              <Button variant="primary" size="sm" onClick={() => void navigate('/projects/new?step=shotlist')}>
                <Trans>新建作品</Trans>
              </Button>
            </>
          }
        />
      }
      /* §8 rule 3: folded, the rail is a row of tabs under the context bar. */
      bar={
        collapsed ? (
          <SubNav
            items={items}
            activeId={context.view}
            onSelect={selectView}
            label={t`比赛工作区视图`}
            collapsed
          />
        ) : null
      }
      /* §8 rule 2: folded, the Inspector is a 46px summary strip at the bottom
         plus a drawer it pulls out. */
      footer={collapsed ? inspector : null}
    >
      <>
      {addedProject === null ? null : (
        <Alert
          className="mx-4 mt-4"
          variant="success"
          action={{
            label: <Trans>打开作品</Trans>,
            onAction: () => void navigate(`/projects/${encodeURIComponent(addedProject.id)}?step=select`),
          }}
        >
          <Trans>已加入「{addedProject.name}」</Trans>
        </Alert>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        {collapsed ? null : (
          <SubNav
            items={items}
            activeId={context.view}
            onSelect={selectView}
            label={t`比赛工作区视图`}
            collapsed={false}
          />
        )}
        <main
          data-match-content=""
          /* The demo id is on the frame, not in a caption: the artboard's bar
             says 「Aurora 13 : 11 Meridian」, never the file id, but a test (and
             a bug report) still has to be able to see which match is open. */
          data-match-demo={demoId}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"
        >
          <view.Body {...viewProps} />
        </main>
        {collapsed ? null : inspector}
      </div>
      <AddToProjectDialog
        open={pendingClips.length > 0}
        clips={pendingClips}
        onClose={() => setPendingClips([])}
        onAdded={setAddedProject}
      />
      </>
    </Page>
  );
}

function collectedClip(
  demoId: string,
  matchLabel: string,
  selection: Parameters<NonNullable<MatchVideoAction['onAdd']>>[0],
): ProjectCollectedClip {
  const kind = selection.highlightId !== undefined
    ? 'highlight'
    : selection.evidenceId !== undefined
      ? 'evidence'
      : selection.round !== undefined
        ? 'round'
        : selection.playerId !== undefined ? 'player' : 'selection';
  const identity = selection.highlightId
    ?? selection.evidenceId
    ?? (selection.round === undefined ? undefined : `round-${String(selection.round)}`)
    ?? selection.playerId
    ?? `${String(selection.startTick ?? 'start')}-${String(selection.endTick ?? 'end')}`;
  const label = selection.label
    ?? (kind === 'highlight' ? `高光 ${identity}`
      : kind === 'evidence' ? `证据 ${identity}`
        : kind === 'round' ? `第 ${String(selection.round)} 回合`
          : kind === 'player' ? `选手 ${String(selection.playerId)}` : '比赛片段');
  const durationSeconds = selection.startTick === undefined
    || selection.endTick === undefined
    || selection.tickRate === undefined
    || selection.tickRate <= 0
    ? null
    : Math.max(0, (selection.endTick - selection.startTick) / selection.tickRate + 2.5);
  return {
    id: `${demoId}:${kind}:${identity}`,
    demoId,
    matchLabel,
    kind,
    label,
    round: selection.round ?? null,
    playerId: selection.playerId ?? null,
    highlightId: selection.highlightId ?? null,
    evidenceId: selection.evidenceId ?? null,
    startTick: selection.startTick ?? null,
    endTick: selection.endTick ?? null,
    durationSeconds,
    addedAt: new Date().toISOString(),
  };
}
