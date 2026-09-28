/** Match identity, view navigation and URL-owned selection.
 * Collection goes straight into the target project (`useQuickAddToProject`);
 * the shared AddToProjectDialog only asks when there is no target yet.
 *
 * A failed analysis read is rendered here, once, in place of the view body and
 * without an Inspector: nine views each drawing their own red box drifted into
 * four wordings and three left edges, and an Inspector that still offered
 * 「这一段没有可列出的事件」 beside a failure was calling a broken read an empty
 * one. The 404 stays with the views — three of them are full-bleed and place
 * the 「开始分析」 recovery inside their own frame. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { Fragment, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useDemo } from '../../../data/demos';
import { dataErrorMessage } from '../../../data/errors';
import { analysisIsMissing, useMatchAnalysis } from '../../../data/match';
import { collectedClipRange, type ProjectCollectedClip } from '../../../domain/project/collectedClip';
import { useCreateDemoProject } from '../../../domain/project/createDemoProject';
import { Alert } from '../../../design/feedback';
import { Page, SubNav, useCollapsed, type SubNavItem } from '../../../design/layout';
import { Button } from '../../../design/primitives';
import { MatchContextBar } from '../../../domain/match';
import { focusedPlayers, matchIdentity, matchTeams, roundLabel } from './matchModel';
import { AnalysisFailure } from './views/viewChrome';
import {
  MATCH_VIEW,
  MATCH_VIEW_IDS,
  MATCH_VIEWS,
  type MatchContextUpdateOptions,
  type MatchVideoAction,
  type MatchViewId,
  type MatchViewProps,
} from './viewContract';
import { AddToProjectDialog } from '../../../domain/project/AddToProjectDialog';
import { CollectTargetBar, useQuickAddToProject } from '../../../domain/project/quickAdd';
import {
  patchWorkspaceContext,
  readWorkspaceContext,
  writeWorkspaceContext,
  type MatchContextPatch,
} from './workspaceContext';

export function MatchWorkspacePage() {
  const { demoId = '' } = useParams<{ demoId: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { i18n } = useLingui();
  const collapsed = useCollapsed(undefined);
  const [preferredProjectId] = useState(() => params.get('project'));
  const [pendingClips, setPendingClips] = useState<readonly ProjectCollectedClip[]>([]);
  const quickAdd = useQuickAddToProject(preferredProjectId);

  const context = readWorkspaceContext(params);
  const view = MATCH_VIEWS[context.view];

  const id = demoId === '' ? null : demoId;
  const demo = useDemo(id);
  const analysis = useMatchAnalysis(id);
  const demoProject = useCreateDemoProject();

  const updateContext = (patch: MatchContextPatch, options?: MatchContextUpdateOptions) => {
    setParams(writeWorkspaceContext(patchWorkspaceContext(context, patch)), {
      replace: options?.replace === true,
    });
  };

  const matchLabel = demo.data?.display_name ?? demoId;
  const toClip = (selection: Parameters<NonNullable<MatchVideoAction['onAdd']>>[0]) =>
    collectedClip(demoId, matchLabel, selection, analysis.data?.players.find((player) => player.id === selection.playerId)?.name ?? null);
  /* Every 加入作品 on this page — row, Inspector, batch bar, replay range —
     lands here, so they all behave the same: straight in with 「撤销」, and the
     dialog only when there is nowhere to put the clips yet. */
  const collect = (clips: readonly ProjectCollectedClip[]) => {
    if (!quickAdd.add(clips)) setPendingClips(clips);
  };
  const addToVideo: MatchVideoAction = {
    disabled: quickAdd.pending,
    ...(quickAdd.pending ? { disabledReason: t`正在加入作品` } : {}),
    onAdd: (selection) => collect([toClip(selection)]),
    onAddMany: (selections) => collect(selections.map(toClip)),
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

  /* A rejection other than 「还没分析」, with nothing to draw in its place. A
     refetch that failed over a document already read is not this: the views
     keep drawing what they have. */
  const failure = analysis.data === undefined && analysis.error !== null && !analysisIsMissing(analysis.error)
    ? analysis.error
    : null;
  const hasSelection = context.round !== null || context.player !== null
    || context.tick !== null || context.evidence !== null || context.highlight !== null;
  const inspector =
    failure !== null || view.Inspector === undefined || (view.inspectorMode !== 'persistent' && !hasSelection)
      ? null
      : <view.Inspector {...viewProps} />;
  /* Transient state a view's two halves share — the 高光 batch selection — is
     scoped by the view's own Provider, wrapped around both halves here because
     the shell is the one component that renders both. */
  const Provider = view.Provider ?? Fragment;

  const createProject = () => {
    if (demo.data === undefined) return;
    void demoProject.create([demo.data])
      .then((project) => void navigate(`/projects/${encodeURIComponent(project.id)}`))
      .catch(() => undefined);
  };
  const createDisabledReason = demo.data === undefined
    ? t`比赛信息还没读出来`
    : demoProject.pending ? t`正在新建作品` : undefined;

  return (
    <Provider>
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
              {/* Visible at every width and never in an overflow menu —
                  `MatchContextBar` keeps its `actions` slot out of the fold for
                  that reason. It stays secondary: the view's single primary is
                  the Inspector's contextual 「加入作品」 for the selected
                  moment, and a second filled button here would compete with it.
                  The project it creates starts from *this* match — named after
                  it, listing the Demo as its source, the whole match on the
                  Story track — the same project a 资料库 row creates. */}
              <Button
                variant="secondary"
                size="sm"
                disabled={createDisabledReason !== undefined}
                {...(createDisabledReason === undefined ? {} : { disabledReason: createDisabledReason })}
                onClick={createProject}
              >
                <Trans>用这场比赛新建作品</Trans>
              </Button>
            </>
          }
        />
      }
      /* The same view navigation stays above the data in both layouts. */
      bar={
          <SubNav
            items={items}
            activeId={context.view}
            onSelect={selectView}
            label={t`比赛工作区视图`}
            orientation="tabs"
            visibleTabs={collapsed ? 5 : items.length}
          />
      }
      /* §8 rule 2: folded, the Inspector is a 46px summary strip at the bottom
         plus a drawer it pulls out. */
      footer={collapsed ? inspector : null}
    >
      <>
      {dataErrorMessage(demoProject.error) === null ? null : (
        <Alert
          className="mx-4 mt-4"
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: createProject }}
          detail={<Trans>没有创建任何作品。</Trans>}
        >
          <Trans>作品没能新建：{dataErrorMessage(demoProject.error)}</Trans>
        </Alert>
      )}
      <CollectTargetBar quickAdd={quickAdd} />
      <div className="flex min-h-0 min-w-0 flex-1">
        <main
          data-match-content=""
          /* The demo id is on the frame, not in a caption: the artboard's bar
             says 「Aurora 13 : 11 Meridian」, never the file id, but a test (and
             a bug report) still has to be able to see which match is open. */
          data-match-demo={demoId}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"
        >
          {failure === null ? (
            <view.Body {...viewProps} />
          ) : (
            <AnalysisFailure
              view={context.view}
              title={i18n._(MATCH_VIEW[context.view].label)}
              demoId={demoId}
              error={failure}
              onRetry={() => void analysis.refetch()}
            />
          )}
        </main>
        {collapsed ? null : inspector}
      </div>
      <AddToProjectDialog
        open={pendingClips.length > 0}
        clips={pendingClips}
        preferredProjectId={preferredProjectId}
        onClose={() => setPendingClips([])}
        onAdded={(project) => quickAdd.retarget(project, pendingClips.length)}
      />
      </>
    </Page>
    </Provider>
  );
}

function collectedClip(
  demoId: string,
  matchLabel: string,
  selection: Parameters<NonNullable<MatchVideoAction['onAdd']>>[0],
  playerName: string | null,
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
  /* The label is the clip's name on the timeline and the undo summary, so it
     says what a person would: the player's name, and the id only when the
     analysis knows no name for it. */
  const label = selection.label
    ?? (kind === 'highlight' ? `高光 ${identity}`
      : kind === 'evidence' ? `证据 ${identity}`
        : kind === 'round' ? `第 ${String(selection.round)} 回合`
          : kind === 'player'
            ? (playerName === null ? `选手 ${String(selection.playerId)}` : `${playerName} · POV`)
            : '比赛片段');
  const range = collectedClipRange({ startTick: selection.startTick ?? null, endTick: selection.endTick ?? null, tickRate: selection.tickRate ?? null });
  const durationSeconds = range === null ? null : range.recordingEnd - range.recordingStart;
  return {
    id: `${demoId}:${kind}:${identity}`,
    demoId,
    matchLabel,
    kind,
    label,
    round: selection.round ?? null,
    playerId: selection.playerId ?? null,
    playerName,
    tickRate: selection.tickRate ?? null,
    highlightId: selection.highlightId ?? null,
    evidenceId: selection.evidenceId ?? null,
    startTick: selection.startTick ?? null,
    endTick: selection.endTick ?? null,
    durationSeconds,
    addedAt: new Date().toISOString(),
  };
}
