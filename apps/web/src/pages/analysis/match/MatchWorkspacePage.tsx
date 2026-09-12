/** Match identity, view navigation and URL-owned selection.
 * Evidence collection writes through the shared AddToProjectDialog. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useDemo } from '../../../data/demos';
import { dataErrorMessage } from '../../../data/errors';
import { useMatchAnalysis } from '../../../data/match';
import { collectedClipRange, type ProjectCollectedClip } from '../../../domain/project/collectedClip';
import { Alert } from '../../../design/feedback';
import { Page, SubNav, useCollapsed, type SubNavItem } from '../../../design/layout';
import { Button } from '../../../design/primitives';
import { MatchContextBar } from '../../../domain/match';
import { focusedPlayers, matchIdentity, matchTeams, roundLabel } from './matchModel';
import {
  MATCH_VIEW,
  MATCH_VIEW_IDS,
  MATCH_VIEWS,
  type MatchContextUpdateOptions,
  type MatchVideoAction,
  type MatchViewId,
  type MatchViewProps,
} from './viewContract';
import { AddToProjectDialog, type AddedProjectTarget } from '../../../domain/project/AddToProjectDialog';
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
    onAdd: (selection) => setPendingClips([collectedClip(demoId, matchLabel, selection, analysis.data?.players.find((player) => player.id === selection.playerId)?.name ?? null)]),
    onAddMany: (selections) => setPendingClips(selections.map((selection) => collectedClip(demoId, matchLabel, selection, analysis.data?.players.find((player) => player.id === selection.playerId)?.name ?? null))),
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

  const hasSelection = context.round !== null || context.player !== null
    || context.tick !== null || context.evidence !== null || context.highlight !== null;
  const inspector =
    view.Inspector === undefined || (view.inspectorMode !== 'persistent' && !hasSelection) ? null : (
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
        preferredProjectId={preferredProjectId}
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
  const label = selection.label
    ?? (kind === 'highlight' ? `高光 ${identity}`
      : kind === 'evidence' ? `证据 ${identity}`
        : kind === 'round' ? `第 ${String(selection.round)} 回合`
          : kind === 'player' ? `选手 ${String(selection.playerId)}` : '比赛片段');
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
