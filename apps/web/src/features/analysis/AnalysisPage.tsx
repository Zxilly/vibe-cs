import { currentLocale, msg, msgf } from '../../shared/i18n';
import {
  Activity,
  ArrowLeft,
  ArrowLeftRight,
  Award,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Crosshair,
  DollarSign,
  Flame,
  Grid3X3,
  ListFilter,
  Map as MapIcon,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Radio,
  ScanLine,
  Shield,
  Shirt,
  Sparkles,
  Swords,
  Target,
  TestTube2,
  Users,
  Zap,
} from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { commands, desktopMediaUrl, normalizeSide, readableError } from '../../shared/desktop/client';
import type {
  AnalysisWorkspace,
  CosmeticCatalog,
  CosmeticFieldName,
  CosmeticInspectionItem,
  CosmeticInspectionReport,
  CosmeticPlan,
  CosmeticRewriteResponse,
  DemoRecord,
  HeatPointRecord,
  Highlight,
  PlayerAnalysis,
  RadarOverviewRecord,
  ReplayCacheMetadata,
  ReplayFidelityMetadata,
  ReplayFrameRecord,
  TimelineEvent,
} from '../../shared/desktop/dto';
import { replayFrameDelayMs } from './replayClock';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import {
  averageKillDeathRatio,
  formatKillDeathRatioValue,
} from '../../shared/performanceMetrics';
import { worldPointsToRadarPercent } from '../../shared/radar';
import { runManagedPlaybackLaunch, useRuntimeStore } from '../../shared/stores/runtimeStore';
import { Badge, Button, Card, EmptyState, Notice, Spinner } from '../../shared/ui';
import { useQueueStore, type QueueItem } from '../queue/queueStore';
import { demoLifecyclePresentation } from '../library/libraryPresentation';
import {
  buildCosmeticRewriteRequest,
  cosmeticDraftsFromPatches,
  cosmeticFieldEditable,
  cosmeticItemKey,
  initialCosmeticDrafts,
  type CosmeticDrafts,
} from './cosmetics';
import {
  analysisInsightsForWorkspace,
  matchupsForPlayer,
  orderHighlightsForCompilation,
  teamPurchaseForSide,
} from './analysisInsights';
import { AiReviewPanel, type ReviewConfiguration } from './AiReviewPanel';
import { analysisBatchIds, runBatchAnalysis, type BatchAnalysisState } from './analysisBatch';
import { AnalysisLifecycleError, loadDemoAnalysis } from './analysisLoader';
import {
  readAnalysisNavigation,
  readAnalysisOpponent,
  updateAnalysisNavigation,
  type AnalysisNavigationPatch,
  type AnalysisTab,
} from './analysisNavigation';
import { roundReasonLabel, timelineEventItemEvidence } from './analysisEvidence';
import { buildOverviewEvidence } from './analysisOverview';
import { analysisScoreboardColumns, analysisScoreboardRows } from './analysisScoreboardPresentation';
import { PlayerEvidenceWorkspace } from './PlayerEvidenceWorkspace';
import { WeaponAnalysisWorkspace } from './WeaponAnalysisWorkspace';
import { UtilityAnalysisWorkspace } from './UtilityAnalysisWorkspace';
import { EconomyAnalysisWorkspace } from './EconomyAnalysisWorkspace';
import { DuelAnalysisWorkspace } from './DuelAnalysisWorkspace';
import { economyEvidenceActionContract } from './economyEvidenceActions';
import { playerEvidenceActionIntent } from './playerEvidenceActions';
import type { PlayerEvidenceRef } from './playerMatchEvidence';
import type { EconomyAtomicEvidence } from './economyEvidenceWorkspace';
import type { WeaponAtomicEvidence } from './weaponEvidenceWorkspace';
import type { UtilityAtomicEvidence } from './utilityEvidenceWorkspace';
import { buildRoundContext, type RoundContextGroup, type RoundEvidenceAvailability } from './roundContextModel';
import { evidenceRangeGroupId, roundNumberFromNavigationKey, roundSectionIsVisible, roundTickPercent, selectedGroupScrollTop, selectedRoundGroupId, tickDurationLabel } from './roundContextPresentation';
import {
  replayCacheLabel,
  replayEffectPresentation,
  replayFidelityPresentation,
  replayPlaybackControlPresentation,
  replayPlayerVitalPresentation,
} from './replayPresentation';
import { decodeReplayBinary } from './replayBinary';
import {
  filterHeatmapPoints,
  heatmapEvidenceIntent,
  nextHeatmapPointIndex,
  projectHeatmapPoints,
  summarizeHeatmapPoints,
  type HeatmapSide,
} from './heatmapPresentation';
import { replayWorldBounds, worldPointsToRelativePercent } from './replayCoordinates';
import { nextScopedFrameIndex, scopeReplayFrames } from './replayRoundScope';
import { replayWorkspaceDensity, type ReplayWorkspaceDensity } from './replayWorkspaceLayout';
import {
  analysisTabLayout,
  coreAnalysisTabs,
  secondaryAnalysisTabs,
} from './analysisWorkspaceLayout';

type CompilationMoment = {
  id: string;
  title: string;
  playerId: string;
  startTick: number;
  endTick: number;
  category: QueueItem['category'];
  highlightId?: string;
  hasVictimPov?: boolean;
};

const tabIcons: Record<AnalysisTab, typeof Activity> = {
  overview: Activity,
  players: Users,
  weapons: Crosshair,
  utility: TestTube2,
  economy: DollarSign,
  duels: Swords,
  insights: Zap,
  review: Bot,
  rounds: ListFilter,
  replay: MapIcon,
  heatmap: Flame,
  highlights: Sparkles,
  cosmetics: Shirt,
};

const playerInitials = (name: string) => name.slice(0, 2).toUpperCase();

const emptyWorkspace = (demoId: string): AnalysisWorkspace => ({
  demo_id: demoId,
  map_name: '',
  tick_rate: 0,
  duration_seconds: 0,
  teams: [],
  players: [],
  rounds: [],
  highlights: [],
});

const formatClock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
};

function findPlayerName(workspace: AnalysisWorkspace, id: string): string {
  return (workspace.players.find((player) => player.id === id)?.name ?? id) || msg("m0764");
}

export function AnalysisPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const demoId = params.get('demo') ?? '';
  const encodedBatch = params.get('demos');
  const batchIds = useMemo(() => demoId ? analysisBatchIds(demoId, encodedBatch) : [], [demoId, encodedBatch]);
  const batchKey = batchIds.join(',');
  const [batchStates, setBatchStates] = useState<Record<string, BatchAnalysisState>>({});
  const [workspace, setWorkspace] = useState<AnalysisWorkspace>(() => emptyWorkspace(demoId));
  const [source, setSource] = useState<'loading' | 'service' | 'error'>(demoId ? 'loading' : 'error');
  const [error, setError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<DemoRecord['status'] | null>(null);
  const [addedHighlight, setAddedHighlight] = useState<string | null>(null);
  const [recordingDefaults, setRecordingDefaults] = useState({
    pre_roll_seconds: 3,
    post_roll_seconds: 2.5,
  });
  const [reviewConfiguration, setReviewConfiguration] = useState<ReviewConfiguration>({
    status: 'loading',
    configured: false,
    provider: '',
    model: '',
  });
  const playerEvidenceWatchAction = useAsyncAction<unknown>();
  const runtimeSession = useRuntimeStore((state) => state.session);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void commands.getConfig(controller.signal)
      .then((config) => {
        if (!active) return;
        setRecordingDefaults({
          pre_roll_seconds: config.recording.pre_roll_seconds,
          post_roll_seconds: config.recording.post_roll_seconds,
        });
        setReviewConfiguration({
          status: 'ready',
          configured: Boolean(
            config.llm.provider.trim()
            && config.llm.model.trim()
            && config.llm.base_url.trim()
            && config.llm_has_api_key,
          ),
          provider: config.llm.provider,
          model: config.llm.model,
        });
      })
      .catch(() => {
        if (!active) return;
        setReviewConfiguration({
          status: 'error',
          configured: false,
          provider: '',
          model: '',
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (batchIds.length > 1) return undefined;
    if (!demoId) {
      setWorkspace(emptyWorkspace(''));
      setSource('error');
      setError(msg("m0895"));
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setSource('loading');
    setLifecycle(null);
    void loadDemoAnalysis(demoId, commands, controller.signal, {
      onLifecycle: (status) => {
        if (active) setLifecycle(status);
      },
    })
      .then((response) => {
        if (!active) return;
        setWorkspace(response);
        setSource('service');
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setWorkspace(emptyWorkspace(demoId));
        setSource('error');
        setError(readableError(cause));
        if (cause instanceof AnalysisLifecycleError) setLifecycle(cause.lifecycle);
        else setLifecycle((current) => current === 'analyzing' ? 'failed' : current);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [batchIds.length, demoId]);

  useEffect(() => {
    if (batchIds.length <= 1) {
      setBatchStates({});
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setBatchStates(Object.fromEntries(batchIds.map((id) => [id, { status: 'pending' }])));
    setSource('loading');
    setError(null);
    void runBatchAnalysis(
      batchIds,
      (id) => loadDemoAnalysis(id, commands, controller.signal),
      (id, state) => {
        if (!active) return;
        setBatchStates((current) => ({ ...current, [id]: state }));
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [batchIds, batchKey]);

  useEffect(() => {
    if (batchIds.length <= 1) return;
    const state = batchStates[demoId];
    if (state?.status === 'ready') {
      setWorkspace(state.workspace);
      setSource('service');
      setError(null);
    } else if (state?.status === 'error') {
      setWorkspace(emptyWorkspace(demoId));
      setSource('error');
      setError(state.message);
    } else {
      setWorkspace(emptyWorkspace(demoId));
      setSource('loading');
    }
  }, [batchIds.length, batchStates, demoId]);

  const navigation = readAnalysisNavigation(
    params,
    source === 'service'
      ? {
          roundNumbers: workspace.rounds.map((round) => round.number),
          playerIds: workspace.players.map((player) => player.id),
          roundTickRanges: workspace.rounds.map((round) => ({
            number: round.number,
            startTick: round.start_tick,
            endTick: round.end_tick,
          })),
        }
      : {},
  );
  const {
    tab,
    round: selectedRound,
    playerId: selectedPlayerId,
    tick: selectedTick,
    evidenceId: selectedEvidenceId,
  } = navigation;
  const selectedOpponentId = readAnalysisOpponent(
    params,
    source === 'service' ? workspace.players.map((player) => player.id) : [],
  );
  const navigateAnalysis = (patch: AnalysisNavigationPatch) => {
    setParams(updateAnalysisNavigation(params, patch));
  };
  const selectedPlayer = workspace.players.find((player) => player.id === selectedPlayerId) ?? workspace.players[0] ?? null;
  const teamA = workspace.players.filter((player) => player.team === 'A');
  const teamB = workspace.players.filter((player) => player.team === 'B');
  const finalRound = workspace.rounds.at(-1);
  const scoreA = finalRound?.team_a_score ?? workspace.teams.find((team) => team.side.toLocaleUpperCase() === 'A')?.score;
  const scoreB = finalRound?.team_b_score ?? workspace.teams.find((team) => team.side.toLocaleUpperCase() === 'B')?.score;
  const teamAName = workspace.teams.find((team) => team.side.toLocaleUpperCase() === 'A')?.name.trim() || 'TEAM A';
  const teamBName = workspace.teams.find((team) => team.side.toLocaleUpperCase() === 'B')?.name.trim() || 'TEAM B';
  const workspaceLayout = analysisTabLayout(tab);
  const addQueueItem = useQueueStore((state) => state.add);
  const addQueueItems = useQueueStore((state) => state.addMany);
  const batchReady = Object.values(batchStates).filter((state) => state.status === 'ready').length;
  const batchFailed = Object.values(batchStates).filter((state) => state.status === 'error').length;
  const lifecyclePresentation = lifecycle ? demoLifecyclePresentation(lifecycle) : null;

  const queueItemForCompilation = (moment: CompilationMoment): QueueItem => ({
    id: `analysis-${workspace.demo_id}-${moment.id}`,
    demoId: workspace.demo_id,
    ...(moment.highlightId ? { highlightId: moment.highlightId } : {}),
    ...(moment.hasVictimPov !== undefined ? { hasVictimPov: moment.hasVictimPov } : {}),
    demoName: workspace.map_name || msg("m0495"),
    playerId: moment.playerId,
    playerName: findPlayerName(workspace, moment.playerId),
    title: moment.title,
    category: moment.category,
    startTick: moment.startTick,
    endTick: moment.endTick,
    ...(workspace.tick_rate > 0 ? { tickRate: workspace.tick_rate } : {}),
    preRollSeconds: recordingDefaults.pre_roll_seconds,
    postRollSeconds: recordingDefaults.post_roll_seconds,
    perspective: 'pov',
    enabled: true,
    origin: 'demo',
  });

  const markCompilationAdded = (id: string) => {
    setAddedHighlight(id);
    window.setTimeout(() => setAddedHighlight(null), 1800);
  };

  const addCompilation = (moment: CompilationMoment) => {
    addQueueItem(queueItemForCompilation(moment));
    markCompilationAdded(moment.id);
  };

  const highlightMoment = (highlight: Highlight): CompilationMoment => ({
    id: highlight.id,
    title: highlight.label,
    playerId: highlight.player_id,
    startTick: highlight.start_tick,
    endTick: highlight.end_tick,
    category: highlight.kind === 'fail' ? 'custom' : highlight.category,
    highlightId: highlight.id,
    hasVictimPov: highlight.victims.length > 0,
  });

  const addHighlightCompilation = (highlights: Highlight[]) => {
    const ordered = orderHighlightsForCompilation(highlights);
    addQueueItems(ordered.map((highlight) => queueItemForCompilation(highlightMoment(highlight))));
    markCompilationAdded('compilation-batch');
  };

  const addHighlight = (highlight: Highlight) => {
    addQueueItem(queueItemForCompilation(highlightMoment(highlight)));
    markCompilationAdded(highlight.id);
  };

  const playerEvidenceIntent = (evidence: PlayerEvidenceRef) => selectedPlayer
    ? playerEvidenceActionIntent(workspace, selectedPlayer.id, evidence)
    : null;

  const watchPlayerEvidence = (evidence: PlayerEvidenceRef) => {
    const intent = playerEvidenceIntent(evidence);
    if (!intent) return;
    void playerEvidenceWatchAction.run(
      () => runManagedPlaybackLaunch(() => commands.playDemo(demoId, intent.watch)),
      msg("m0514"),
    );
  };

  const openPlayerEvidenceReplay = (evidence: PlayerEvidenceRef) => {
    const intent = playerEvidenceIntent(evidence);
    if (intent) navigateAnalysis(intent.replay);
  };

  const addPlayerEvidence = (evidence: PlayerEvidenceRef) => {
    const intent = playerEvidenceIntent(evidence);
    if (!intent) return;
    addCompilation(intent.compilation);
  };

  const watchWeaponEvidence = (evidence: WeaponAtomicEvidence) => {
    void playerEvidenceWatchAction.run(
      () => runManagedPlaybackLaunch(() => commands.playDemo(demoId, { start_tick: evidence.tick })),
      msg("m0514"),
    );
  };

  const addWeaponEvidence = (evidence: WeaponAtomicEvidence) => {
    if (!evidence.actor_id || !workspace.players.some((player) => player.id === evidence.actor_id)) return;
    addCompilation(playerEvidenceActionIntent(workspace, evidence.actor_id, evidence).compilation);
  };

  const watchUtilityEvidence = (evidence: UtilityAtomicEvidence) => {
    void playerEvidenceWatchAction.run(
      () => runManagedPlaybackLaunch(() => commands.playDemo(demoId, { start_tick: evidence.tick })),
      msg("m0514"),
    );
  };

  const addUtilityEvidence = (evidence: UtilityAtomicEvidence) => {
    if (!evidence.actor_id || !workspace.players.some((player) => player.id === evidence.actor_id)) return;
    addCompilation({
      ...playerEvidenceActionIntent(workspace, evidence.actor_id, evidence).compilation,
      category: 'utility',
    });
  };

  const watchEconomyEvidence = (evidence: EconomyAtomicEvidence) => {
    void playerEvidenceWatchAction.run(
      () => runManagedPlaybackLaunch(() => commands.playDemo(demoId, { start_tick: evidence.tick })),
      msg("m0514"),
    );
  };

  const addEconomyEvidence = (evidence: EconomyAtomicEvidence) => {
    const action = economyEvidenceActionContract(workspace, evidence, {
      serviceAvailable: source === 'service',
      runtimeIdle: runtimeSession === 'idle',
      watchPending: playerEvidenceWatchAction.state.status === 'loading',
      alreadyAdded: addedHighlight === evidence.evidence_id,
    });
    if (action.add.compilation) addCompilation(action.add.compilation);
  };

  return (
    <div className="page page--analysis" data-testid="analysis-page">
      <header className="analysis-match-header" data-testid="analysis-match-header">
        <div className="analysis-match-header__identity">
          <Link className="analysis-match-header__back" to="/library" aria-label={t('analysis.backLibrary')} title={t('analysis.backLibrary')}>
            <ArrowLeft size={18} />
          </Link>
          <div className="analysis-match-header__copy">
            <span className="eyebrow">MATCH INTELLIGENCE</span>
            <div className="analysis-match-header__title-row">
              <h1>{workspace.map_name ? workspace.map_name.replace('de_', '').toUpperCase() : t('analysis.title')}</h1>
              {source === 'service' && workspace.rounds.length > 0 ? <Badge tone="success">{msg("m0494")}</Badge> : null}
            </div>
            {scoreA !== undefined && scoreB !== undefined ? (
              <div className="analysis-match-header__score" aria-label={`${teamAName} ${scoreA}, ${teamBName} ${scoreB}`}>
                <span>{teamAName}</span><strong>{scoreA}</strong><i>:</i><strong>{scoreB}</strong><span>{teamBName}</span>
              </div>
            ) : <p>{t('analysis.description')}</p>}
          </div>
        </div>

        <div className="analysis-match-header__meta" aria-label={t('analysis.matchFacts')}>
          {workspace.duration_seconds > 0 ? <span><Clock3 size={15} />{formatClock(workspace.duration_seconds)}</span> : null}
          {workspace.tick_rate > 0 ? <span><Radio size={15} />{workspace.tick_rate} tick</span> : null}
          {workspace.rounds.length > 0 ? <span><ListFilter size={15} />{workspace.rounds.length} {t('analysis.roundCountLabel')}</span> : null}
          {workspace.highlights.length > 0 ? <span><Sparkles size={15} />{workspace.highlights.length} {t('analysis.highlightCountLabel')}</span> : null}
        </div>

        <div className="analysis-match-header__actions">
          <Link className="button button--secondary button--sm" to="/players"><Users size={15} />{t('analysis.playerDirectory')}</Link>
          {batchIds.length > 1 ? (
            <div className="analysis-demo-select">
            <span>{msg("m0578")}</span>
              <label>
                <select value={demoId} onChange={(event) => {
                    const next = updateAnalysisNavigation(params, { round: 1, playerId: null });
                    next.set('demo', event.target.value);
                    next.set('demos', batchKey);
                    setParams(next);
                  }} aria-label={msg("m0280")}>
                    {batchIds.map((id, index) => {
                      const state = batchStates[id];
                      const label = state?.status === 'ready' ? state.workspace.map_name.replace('de_', '').toUpperCase() : msgf("m0887", [index + 1]);
                      const status = state?.status === 'ready' ? msg("m0510") : state?.status === 'error' ? msg("m0425") : state?.status === 'loading' ? msg("m0263") : msg("m1062");
                      return <option value={id} key={id}>{label} · {status}</option>;
                    })}
                  </select>
                  <ChevronDown size={14} />
                </label>
            </div>
          ) : null}
        </div>
      </header>

      {batchIds.length > 1 ? <Notice tone={batchFailed > 0 ? 'warning' : batchReady === batchIds.length ? 'success' : 'info'} title={msg("m0645")}>{msg("m0510")} {batchReady} / {batchIds.length}{batchFailed > 0 ? msgf("m0003", [batchFailed]) : msg("m0007")}</Notice> : null}

      {source !== 'service' ? (
        <Notice
          tone={source === 'loading' ? 'info' : 'danger'}
          title={source === 'loading' && lifecyclePresentation ? t(lifecyclePresentation.labelKey) : source === 'loading' ? msg("m0865") : msg("m0262")}
        >
          {source === 'loading'
            ? <><Spinner />{lifecyclePresentation ? t(lifecyclePresentation.descriptionKey) : msg("m0874")}</>
            : error ?? msg("m0795")}
        </Notice>
      ) : null}

      <div className={`analysis-layout analysis-layout--${workspaceLayout.showsPlayerRail ? 'player-context' : 'full-width'}`}>
        {workspaceLayout.showsPlayerRail ? (
          <aside className="player-rail" aria-label={t('analysis.playerContext')}>
            <div className="player-rail__header">
              <span>{t('analysis.tab.players')}</span>
              <Badge tone="neutral">{workspace.players.length}</Badge>
            </div>
            <PlayerTeam label={teamAName} tone="blue" players={teamA} selectedId={selectedPlayer?.id ?? ''} onSelect={(id) => navigateAnalysis({ playerId: id })} />
            <PlayerTeam label={teamBName} tone="warning" players={teamB} selectedId={selectedPlayer?.id ?? ''} onSelect={(id) => navigateAnalysis({ playerId: id })} />
            <div className="player-rail__footer">
              <span>{msg("m0551")}</span>
              <strong>{formatKillDeathRatioValue(averageKillDeathRatio(workspace.players))}</strong>
            </div>
          </aside>
        ) : null}

        <section className="analysis-workspace">
          <AnalysisTabs tab={tab} highlightCount={workspace.highlights.length} onSelect={(nextTab) => navigateAnalysis({ tab: nextTab })} />

          <div className="analysis-view">
            {tab === 'overview' ? (
              <Overview
                workspace={workspace}
                player={selectedPlayer}
                onNavigate={navigateAnalysis}
                onSelectPlayer={(id) => navigateAnalysis({ playerId: id })}
              />
            ) : null}
            {tab === 'players' && selectedPlayer ? (
              <>
                {playerEvidenceWatchAction.state.status === 'error'
                  ? <Notice tone="danger">{playerEvidenceWatchAction.state.message}</Notice>
                  : null}
                <PlayerEvidenceWorkspace
                  workspace={workspace}
                  playerId={selectedPlayer.id}
                  focusedEvidenceId={selectedEvidenceId}
                  {...(addedHighlight ? { addedEvidenceIds: new Set([addedHighlight]) } : {})}
                  watchEnabled={source === 'service' && runtimeSession === 'idle' && playerEvidenceWatchAction.state.status !== 'loading'}
                  watchUnavailableReason={runtimeSession !== 'idle' ? msg("m0799") : msg("m1001")}
                  onWatch={watchPlayerEvidence}
                  onOpenReplay={openPlayerEvidenceReplay}
                  onAddProduction={addPlayerEvidence}
                />
              </>
            ) : null}
            {tab === 'weapons' ? (
              <>
                {playerEvidenceWatchAction.state.status === 'error'
                  ? <Notice tone="danger">{playerEvidenceWatchAction.state.message}</Notice>
                  : null}
                <WeaponAnalysisWorkspace
                  workspace={workspace}
                  selectedPlayerId={params.has('player') ? selectedPlayerId : null}
                  selectedRound={params.has('round') ? selectedRound : null}
                  serviceAvailable={source === 'service'}
                  runtimeIdle={runtimeSession === 'idle'}
                  watchPending={playerEvidenceWatchAction.state.status === 'loading'}
                  focusedEvidenceId={selectedEvidenceId}
                  {...(addedHighlight ? { addedEvidenceIds: new Set([addedHighlight]) } : {})}
                  onNavigate={navigateAnalysis}
                  onWatch={watchWeaponEvidence}
                  onAddProduction={addWeaponEvidence}
                />
              </>
            ) : null}
            {tab === 'utility' ? (
              <>
                {playerEvidenceWatchAction.state.status === 'error'
                  ? <Notice tone="danger">{playerEvidenceWatchAction.state.message}</Notice>
                  : null}
                <UtilityAnalysisWorkspace
                  workspace={workspace}
                  selectedPlayerId={params.has('player') ? selectedPlayerId : null}
                  selectedRound={params.has('round') ? selectedRound : null}
                  serviceAvailable={source === 'service'}
                  runtimeIdle={runtimeSession === 'idle'}
                  watchPending={playerEvidenceWatchAction.state.status === 'loading'}
                  focusedEvidenceId={selectedEvidenceId}
                  {...(addedHighlight ? { addedEvidenceIds: new Set([addedHighlight]) } : {})}
                  onNavigate={navigateAnalysis}
                  onWatch={watchUtilityEvidence}
                  onAddProduction={addUtilityEvidence}
                />
              </>
            ) : null}
            {tab === 'economy' ? (
              <>
                {playerEvidenceWatchAction.state.status === 'error'
                  ? <Notice tone="danger">{playerEvidenceWatchAction.state.message}</Notice>
                  : null}
                <EconomyAnalysisWorkspace
                  workspace={workspace}
                  selectedPlayerId={params.has('player') ? selectedPlayerId : null}
                  selectedRound={params.has('round') ? selectedRound : null}
                  serviceAvailable={source === 'service'}
                  runtimeIdle={runtimeSession === 'idle'}
                  watchPending={playerEvidenceWatchAction.state.status === 'loading'}
                  focusedEvidenceId={selectedEvidenceId}
                  {...(addedHighlight ? { addedEvidenceIds: new Set([addedHighlight]) } : {})}
                  onNavigate={navigateAnalysis}
                  onWatch={watchEconomyEvidence}
                  onAddProduction={addEconomyEvidence}
                />
              </>
            ) : null}
            {tab === 'duels' ? (
              <>
                {playerEvidenceWatchAction.state.status === 'error'
                  ? <Notice tone="danger">{playerEvidenceWatchAction.state.message}</Notice>
                  : null}
                <DuelAnalysisWorkspace
                  workspace={workspace}
                  selectedPlayerId={selectedPlayer?.id ?? null}
                  selectedOpponentId={selectedOpponentId}
                  selectedRound={params.has('round') ? selectedRound : null}
                  serviceAvailable={source === 'service'}
                  runtimeIdle={runtimeSession === 'idle'}
                  watchPending={playerEvidenceWatchAction.state.status === 'loading'}
                  focusedEvidenceId={selectedEvidenceId}
                  {...(addedHighlight ? { addedEvidenceIds: new Set([addedHighlight]) } : {})}
                  onNavigate={navigateAnalysis}
                  onWatch={watchPlayerEvidence}
                  onAddProduction={addPlayerEvidence}
                />
              </>
            ) : null}
            {tab === 'insights' ? <InsightsView workspace={workspace} selectedPlayer={selectedPlayer} /> : null}
            {tab === 'review' ? <AiReviewPanel key={demoId} demoId={demoId} workspace={workspace} selectedPlayer={selectedPlayer} source={source} configuration={reviewConfiguration} /> : null}
            {tab === 'rounds' ? <RoundsView workspace={workspace} demoId={demoId} playable={source === 'service'} selectedRound={selectedRound} selectedPlayer={selectedPlayer} selectedTick={selectedTick} selectedEvidenceId={selectedEvidenceId} addedId={addedHighlight} onSelectRound={(round) => navigateAnalysis({ round })} onPreviewRound={(round, tick, playerId) => navigateAnalysis({ tab: 'replay', round, tick: tick ?? null, playerId: playerId ?? null })} onCompile={addCompilation} /> : null}
            {tab === 'replay' ? <ReplayView demoId={demoId} workspace={workspace} source={source} roundNumber={selectedRound} targetTick={selectedTick} selectedPlayerId={selectedPlayerId} onSelectPlayer={(playerId) => navigateAnalysis({ playerId })} /> : null}
            {tab === 'heatmap' ? (
              <HeatmapView
                demoId={demoId}
                mapName={workspace.map_name}
                player={selectedPlayer}
                players={workspace.players}
                source={source}
                selectedRound={params.has('round') ? selectedRound : null}
                onNavigate={navigateAnalysis}
              />
            ) : null}
            {tab === 'highlights' ? (
              <HighlightsView
                highlights={workspace.highlights}
                workspace={workspace}
                addedId={addedHighlight}
                onAdd={addHighlight}
                onAddMany={addHighlightCompilation}
                onPreview={(highlight) => navigateAnalysis({
                  tab: 'replay',
                  round: highlight.round > 0 ? highlight.round : selectedRound,
                  playerId: highlight.player_id,
                  tick: highlight.start_tick,
                })}
              />
            ) : null}
            {tab === 'cosmetics' ? <CosmeticsView demoId={demoId} players={workspace.players} source={source} /> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function AnalysisTabs({
  tab,
  highlightCount,
  onSelect,
}: {
  tab: AnalysisTab;
  highlightCount: number;
  onSelect: (tab: AnalysisTab) => void;
}) {
  const { t } = useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const labels: Record<AnalysisTab, string> = {
    overview: t('analysis.tab.overview'),
    players: t('analysis.tab.players'),
    weapons: t('analysis.tab.weapons'),
    utility: t('analysis.tab.utility'),
    economy: t('analysis.tab.economy'),
    duels: t('analysis.tab.duels'),
    insights: t('analysis.tab.insights'),
    review: t('analysis.tab.review'),
    rounds: t('analysis.tab.rounds'),
    replay: t('analysis.tab.replay'),
    heatmap: t('analysis.tab.heatmap'),
    highlights: t('analysis.tab.highlights'),
    cosmetics: t('analysis.tab.cosmetics'),
  };
  const secondaryActive = analysisTabLayout(tab).group === 'secondary';

  useEffect(() => {
    if (!moreOpen) return undefined;
    const closeFromPointer = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('pointerdown', closeFromPointer);
    window.addEventListener('keydown', closeFromKeyboard);
    return () => {
      window.removeEventListener('pointerdown', closeFromPointer);
      window.removeEventListener('keydown', closeFromKeyboard);
    };
  }, [moreOpen]);

  const selectTab = (nextTab: AnalysisTab) => {
    setMoreOpen(false);
    onSelect(nextTab);
  };

  const renderTab = (id: AnalysisTab, inMenu = false) => {
    const Icon = tabIcons[id];
    return (
      <button
        type="button"
        key={id}
        role={inMenu ? 'menuitem' : undefined}
        className={`analysis-tab-button${tab === id ? ' is-active' : ''}`}
        aria-current={tab === id ? 'page' : undefined}
        data-testid={`analysis-tab-${id}`}
        onClick={() => selectTab(id)}
      >
        <Icon size={16} />
        <span>{labels[id]}</span>
        {id === 'highlights' && highlightCount > 0 ? <Badge tone="accent">{highlightCount}</Badge> : null}
      </button>
    );
  };

  return (
    <nav className="analysis-tabs" aria-label={t('analysis.navigationLabel')} data-testid="analysis-tabs">
      <div className="analysis-tabs__core">
        {coreAnalysisTabs.map((id) => renderTab(id))}
      </div>
      <div className="analysis-more" ref={moreRef}>
        <button
          type="button"
          className={`analysis-tab-button analysis-more__trigger${secondaryActive ? ' is-active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-label={secondaryActive ? `${t('analysis.tab.more')}: ${labels[tab]}` : t('analysis.tab.more')}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <MoreHorizontal size={17} />
          <span>{t('analysis.tab.more')}</span>
          {secondaryActive ? <small className="analysis-more__current">{labels[tab]}</small> : null}
          <ChevronDown size={14} />
        </button>
        {moreOpen ? (
          <div className="analysis-more__menu" role="menu" aria-label={t('analysis.moreTools')}>
            <span>{t('analysis.moreTools')}</span>
            {secondaryAnalysisTabs.map((id) => renderTab(id, true))}
          </div>
        ) : null}
      </div>
    </nav>
  );
}

function PlayerTeam({
  label,
  tone,
  players,
  selectedId,
  onSelect,
}: {
  label: string;
  tone: 'blue' | 'warning';
  players: PlayerAnalysis[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="player-team">
      <div className={`player-team__label player-team__label--${tone}`}><span />{label}</div>
      {players.map((player) => {
        const ratio = player.kill_death_ratio;
        return (
          <button
            type="button"
            key={player.id}
            className={selectedId === player.id ? 'is-active' : undefined}
            onClick={() => onSelect(player.id)}
          >
            <span className={`player-avatar player-avatar--${player.team.toLocaleLowerCase()}`}>{playerInitials(player.name)}</span>
            <span className="player-team__name"><strong>{player.name}</strong><small>{player.kills} / {player.deaths} / {player.assists}</small></span>
            <span className={`kd-ratio kd-ratio--${ratio >= 1.1 ? 'high' : ratio < 0.9 ? 'low' : 'mid'}`}>{formatKillDeathRatioValue(player.kill_death_ratio, 2)}</span>
          </button>
        );
      })}
    </div>
  );
}

function Overview({
  workspace,
  player,
  onNavigate,
  onSelectPlayer,
}: {
  workspace: AnalysisWorkspace;
  player: PlayerAnalysis | null;
  onNavigate: (patch: AnalysisNavigationPatch) => void;
  onSelectPlayer: (id: string) => void;
}) {
  const { t } = useI18n();
  if (!player) return <Card><EmptyState icon={<Users size={22} />} title={msg("m0904")} description={msg("m0259")} /></Card>;
  const roundWinsA = workspace.rounds.filter((round) => round.winner === 'A').length;
  const roundWinsB = workspace.rounds.length - roundWinsA;
  const evidence = buildOverviewEvidence(workspace, player.id);
  const keyHighlights = [...workspace.highlights]
    .filter((highlight) => highlight.kind !== 'timeline' && highlight.kind !== 'fail')
    .sort((left, right) => right.victims.length - left.victims.length
      || right.confidence - left.confidence
      || right.round - left.round
      || left.start_tick - right.start_tick)
    .slice(0, 5);
  const topHighlight = keyHighlights[0] ?? workspace.highlights[0];
  const topWeapon = evidence.weapons[0] ?? null;
  return (
    <div className="overview-view">
      <section className="metric-grid metric-grid--overview">
        <Card className="metric-card metric-card--featured">
          <div className="metric-card__icon"><Award size={18} /></div>
          <span>K/D</span><strong>{formatKillDeathRatioValue(player.kill_death_ratio, 2)}</strong>
          <small>{player.kills} K · {player.deaths} D</small>
        </Card>
        <Card className="metric-card"><div className="metric-card__icon"><Crosshair size={18} /></div><span>K / D / A</span><strong>{player.kills}<i>/</i>{player.deaths}<i>/</i>{player.assists}</strong><small>{player.assists} A</small></Card>
        <Card className="metric-card"><div className="metric-card__icon"><Target size={18} /></div><span>ADR</span><strong>{player.adr.toFixed(1)}</strong><small>{msg("m0883")}</small></Card>
        <Card className="metric-card"><div className="metric-card__icon"><Zap size={18} /></div><span>HEADSHOT</span><strong>{Math.round(player.headshot_rate * 100)}%</strong><small>{Math.round(player.kills * player.headshot_rate)} {msg("m0842")}</small></Card>
        <Card className="metric-card metric-card--extended"><div className="metric-card__icon"><Zap size={18} /></div><span>{t('analysis.overview.utility')}</span><strong>{evidence.utility.available ? evidence.utility.damage : '—'}</strong><small>{evidence.utility.available ? `${evidence.utility.throws} ${t('analysis.overview.throws')}` : t('analysis.overview.unavailable')}</small></Card>
        <Card className="metric-card metric-card--extended"><div className="metric-card__icon"><Swords size={18} /></div><span>{t('analysis.overview.topDuel')}</span><strong>{evidence.duel ? `${evidence.duel.kills}:${evidence.duel.deaths}` : '—'}</strong><small>{evidence.duel ? `${t('analysis.overview.vs')} ${evidence.duel.opponent_name}` : t('analysis.overview.unavailable')}</small></Card>
      </section>

      <div className="overview-columns">
        <Card className="round-momentum">
          <div className="card-heading"><div><span className="eyebrow">MATCH FLOW</span><h2>{msg("m0373")}</h2></div><Badge tone="neutral">{workspace.rounds.length} ROUNDS</Badge></div>
          <div className="round-strip" aria-label={msgf("m0022", [roundWinsA, roundWinsB])}>
            {workspace.rounds.map((round) => <span key={round.number} className={`round-block round-block--${round.winner.toLocaleLowerCase()}`} title={msgf("m0368", [round.number, round.reason])} />)}
          </div>
          <div className="round-strip__labels"><span>R1</span><span>{msg("m0165")}</span><span>R{workspace.rounds.length || '—'}</span></div>
          <div className="momentum-chart">
            {workspace.rounds.map((round) => (
              <div key={round.number} className="momentum-column"><span className={round.winner === 'A' ? 'team-a' : 'team-b'} style={{ height: `${45 + Math.min(50, Math.abs(round.team_a_score - round.team_b_score) * 6)}%` }} /></div>
            ))}
          </div>
          <div className="chart-legend"><span><i className="team-a" />TEAM A · {roundWinsA}</span><span><i className="team-b" />TEAM B · {roundWinsB}</span></div>
        </Card>

        <Card className="overview-evidence-focus">
          <div className="card-heading">
            <div><span className="eyebrow">PLAYER EVIDENCE</span><h2>{player.name} · {t('analysis.overview.evidence')}</h2><p>{t('analysis.overview.evidenceDescription')}</p></div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate({ tab: 'insights' })}>{t('analysis.overview.openInsights')}<ChevronRight size={15} /></Button>
          </div>
          <div className="overview-evidence-focus__grid">
            <div><Crosshair size={17} /><span><small>{t('analysis.overview.weapons')}</small><strong>{topWeapon ? topWeapon.name.replaceAll('_', ' ').toLocaleUpperCase() : '—'}</strong><em>{topWeapon ? `${topWeapon.kills} ${t('analysis.overview.kills')} · ${topWeapon.headshots} HS` : t('analysis.overview.unavailable')}</em></span></div>
            <div><Swords size={17} /><span><small>{t('analysis.overview.duels')}</small><strong>{evidence.duel ? `${evidence.duel.kills}:${evidence.duel.deaths} ${t('analysis.overview.vs')} ${evidence.duel.opponent_name}` : '—'}</strong><em>{evidence.duel ? `${evidence.duel.damage_dealt} / ${evidence.duel.damage_taken} ${t('analysis.overview.damage')}` : t('analysis.overview.unavailable')}</em></span></div>
            <div><Zap size={17} /><span><small>{t('analysis.overview.utility')}</small><strong>{evidence.utility.available ? `${evidence.utility.throws} ${t('analysis.overview.throws')}` : '—'}</strong><em>{evidence.utility.available ? evidence.utility.items.slice(0, 3).map((item) => `${item.name}×${item.count}`).join(' · ') : t('analysis.overview.unavailable')}</em></span></div>
            <div><CircleDot size={17} /><span><small>{t('analysis.overview.objectivesEconomy')}</small><strong>{evidence.objectives.plants} / {evidence.objectives.defuses}</strong><em>{evidence.economy.available ? `${t('analysis.overview.matchEconomy')} · ${evidence.economy.purchases} ${t('analysis.overview.purchases')}${evidence.economy.spend === null ? '' : ` · $${evidence.economy.spend.toLocaleString(currentLocale())}`}` : t('analysis.overview.unavailable')}</em></span></div>
          </div>
        </Card>
      </div>

      <div className="overview-evidence-grid">
        <PlayersTable players={workspace.players} selectedId={player.id} onSelect={onSelectPlayer} compact />
        <Card className="overview-key-moments">
          <div className="card-heading"><div><span className="eyebrow">MATCH EVIDENCE</span><h2>{t('analysis.overview.keyMoments')}</h2><p>{t('analysis.overview.keyMomentsDescription')}</p></div><Badge tone="neutral">{keyHighlights.length}</Badge></div>
          {keyHighlights.length > 0 ? (
            <div className="overview-key-moments__list">
              {keyHighlights.map((highlight) => {
                const owner = workspace.players.find((candidate) => candidate.id === highlight.player_id)?.name ?? highlight.player_id;
                return (
                  <article key={highlight.id}>
                    <span><strong>{highlight.label}</strong><small>R{highlight.round} · {owner} · {highlight.victims.length} {t('analysis.overview.victims')} · tick {highlight.start_tick}–{highlight.end_tick}</small></span>
                    <div>
                      <Button variant="ghost" size="sm" onClick={() => onNavigate({ tab: 'rounds', round: highlight.round, playerId: highlight.player_id })}>{t('analysis.overview.openRound')}</Button>
                      <Button variant="secondary" size="sm" onClick={() => onNavigate({ tab: 'replay', round: highlight.round, playerId: highlight.player_id, tick: highlight.start_tick })}><Play size={14} />{t('analysis.overview.openReplay')}</Button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : <EmptyState icon={<Sparkles size={22} />} title={t('analysis.overview.noKeyMoments')} description={msg("m0266")} />}
        </Card>
      </div>

      {topHighlight ? <Card className="insight-callout"><div className="insight-callout__icon"><Sparkles size={18} /></div><div><span className="eyebrow">TOP PARSED HIGHLIGHT</span><strong>{topHighlight.label}</strong><p>{msg("m0367")} {topHighlight.round} {msg("m0122")} {topHighlight.confidence.toFixed(2)} · tick {topHighlight.start_tick}–{topHighlight.end_tick}</p></div><Button variant="secondary" size="sm" onClick={() => onNavigate({ tab: 'highlights', round: topHighlight.round, playerId: topHighlight.player_id })}>{t('analysis.overview.allHighlights')}<ChevronRight size={15} /></Button></Card> : <Notice tone="info">{msg("m0266")}</Notice>}
    </div>
  );
}

function PlayersTable({ players, selectedId, onSelect, compact = false }: { players: PlayerAnalysis[]; selectedId: string; onSelect: (id: string) => void; compact?: boolean }) {
  if (players.length === 0) return <Card><EmptyState icon={<Users size={22} />} title={msg("m0903")} description={msg("m0261")} /></Card>;
  const rows = analysisScoreboardRows(players);
  return (
    <Card className={`players-table-card${compact ? ' players-table-card--compact' : ''}`}>
      <div className="card-heading"><div><span className="eyebrow">SCOREBOARD</span><h2>{msg("m0982")}</h2></div><Badge tone="neutral">{msg("m0655")}</Badge></div>
      <div className="data-table players-table">
        <div className="data-table__head">{analysisScoreboardColumns.map((column) => <span key={column}>{column === 'player' ? msg("m0978") : column}</span>)}</div>
        {rows.map((player) => (
          <button type="button" key={player.id} className={selectedId === player.id ? 'is-selected' : undefined} onClick={() => onSelect(player.id)}>
            <span className="data-player"><span className={`player-avatar player-avatar--${player.team.toLocaleLowerCase()}`}>{playerInitials(player.name)}</span><span><strong>{player.name}</strong><small>TEAM {player.team}</small></span></span>
            <span>{player.kills}</span><span>{player.deaths}</span><span>{player.assists}</span>
            <span className="kd-ratio-cell">{player.killDeathRatio}</span><span>{player.adr}</span><span>{player.headshotRate}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function InsightsView({ workspace, selectedPlayer }: { workspace: AnalysisWorkspace; selectedPlayer: PlayerAnalysis | null }) {
  const { t } = useI18n();
  const insights = analysisInsightsForWorkspace(workspace);
  const utility = selectedPlayer
    ? insights.player_utility.find((summary) => summary.player_id === selectedPlayer.id) ?? null
    : null;
  const matchups = selectedPlayer
    ? matchupsForPlayer(insights, selectedPlayer.id, workspace.players)
    : [];
  const capability = insights.availability;
  const unattributedPurchases = insights.round_economy.reduce(
    (total, round) => total + round.unattributed_purchase_count,
    0,
  );

  return (
    <div className="insights-view">
      <Card className="economy-insights-card">
        <div className="card-heading">
          <div><span className="eyebrow">ROUND ECONOMY EVIDENCE</span><h2>{msg("m1078")}</h2><p>{msg("m1081")}</p></div>
          <Badge tone={capability.purchase_events.available ? 'success' : 'warning'}>{capability.purchase_events.available ? msg("m1161") : msg("m1160")}</Badge>
        </div>
        {capability.purchase_events.available ? (
          <>
            <div className="economy-round-table">
              <div className="economy-round-table__head"><span>{msg("m0367")}</span><span>{t('analysis.insights.economy.tSide')}</span><span>{t('analysis.insights.economy.ctSide')}</span></div>
              {insights.round_economy.map((round) => {
                const terrorist = teamPurchaseForSide(round, 'T');
                const counterTerrorist = teamPurchaseForSide(round, 'CT');
                const renderSide = (team: typeof terrorist) => team ? (
                  <span><strong>{team.purchase_count} {msg("m0811")}</strong><small>{team.items.length > 0 ? team.items.map((item) => `${item.name}×${item.count}`).join(' · ') : msg("m0704")}{team.purchase_count > 0 ? ` · ${team.spend === null ? msg("m1272") : `$${team.spend.toLocaleString(currentLocale())}`}` : ''}</small></span>
                ) : <span><strong>{msg("m0146")}</strong><small>{msg("m0170")}</small></span>;
                return <div key={round.round}><span>R{round.round}</span>{renderSide(terrorist)}{renderSide(counterTerrorist)}</div>;
              })}
            </div>
            {!capability.purchase_spend.available ? <Notice tone="info">{msg("m1162")}</Notice> : null}
            {unattributedPurchases > 0 ? <Notice tone="warning">{msg("m0337")} {unattributedPurchases} {msg("m0812")}</Notice> : null}
          </>
        ) : <EmptyState icon={<ListFilter size={22} />} title={msg("m1077")} description={msg("m0809")} />}
      </Card>

      <div className="insight-detail-grid">
        <Card className="utility-insights-card">
          <div className="card-heading"><div><span className="eyebrow">UTILITY & DAMAGE</span><h2>{selectedPlayer ? msgf("m0097", [selectedPlayer.name]) : msg("m1253")}</h2></div><Zap size={16} /></div>
          {selectedPlayer && utility ? (
            <>
              <div className="insight-metrics">
                <div><span>{msg("m0651")}</span><strong>{capability.utility_events.available ? utility.throws : '—'}</strong><small>{capability.utility_events.available ? msgf("m0108", [utility.detonations]) : msg("m0985")}</small></div>
                <div><span>{msg("m1252")}</span><strong>{capability.utility_damage.available ? utility.damage : '—'}</strong><small>{capability.utility_damage.available ? msgf("m0107", [utility.damage_events]) : msg("m0766")}</small></div>
                <div><span>{msg("m1277")}</span><strong>{capability.flash_effects.available ? utility.players_flashed : '—'}</strong><small>{capability.flash_effects.available ? msgf("m0106", [utility.flash_events]) : msg("m0087")}</small></div>
                <div><span>{msg("m1103")}</span><strong>{utility.flash_duration_seconds === null ? '—' : `${utility.flash_duration_seconds.toFixed(1)}s`}</strong><small>{utility.flash_duration_seconds === null ? (utility.flash_events > 0 ? msg("m0169") : msg("m1123")) : msg("m0724")}</small></div>
              </div>
              {utility.items.length > 0 ? <div className="insight-item-list">{utility.items.map((item) => <Badge key={item.name} tone="neutral">{item.name} × {item.count}</Badge>)}</div> : null}
              <Notice tone="info">{msg("m0631")}</Notice>
            </>
          ) : <EmptyState icon={<Zap size={22} />} title={msg("m0905")} description={selectedPlayer ? msg("m0746") : msg("m1137")} />}
        </Card>

        <Card className="matchup-insights-card">
          <div className="card-heading"><div><span className="eyebrow">PLAYER MATCHUPS</span><h2>{selectedPlayer ? msgf("m0095", [selectedPlayer.name]) : msg("m0980")}</h2><p>{msg("m0343")}</p></div><Swords size={16} /></div>
          {capability.matchups.available && matchups.length > 0 ? (
            <div className="matchup-list">
              {matchups.map((matchup) => {
                const opponent = workspace.players.find((player) => player.id === matchup.opponent_id);
                return <div key={matchup.opponent_id}><span className={`player-avatar player-avatar--${opponent?.team.toLocaleLowerCase() ?? 'unknown'}`}>{playerInitials(opponent?.name ?? matchup.opponent_id)}</span><span><strong>{opponent?.name ?? matchup.opponent_id}</strong><small>{matchup.damage_dealt} {msg("m1185")} {matchup.damage_taken} {msg("m0650")} {matchup.damage_events} {msg("m0841")}</small></span><span><strong>{matchup.kills}:{matchup.deaths}</strong><small>{matchup.headshot_kills} {msg("m0843")}</small></span></div>;
              })}
            </div>
          ) : <EmptyState icon={<Swords size={22} />} title={msg("m0451")} description={msg("m0585")} />}
        </Card>
      </div>
    </div>
  );
}

const eventKindLabel: Record<TimelineEvent['kind'], string> = {
  round_start: msg("m0369"),
  round_end: msg("m0372"),
  kill: msg("m0252"),
  damage: msg("m0202"),
  bomb_plant: msg("m1020"),
  bomb_defuse: msg("m1014"),
  bomb_explode: msg("m1015"),
  grenade: msg("m0652"),
  purchase: msg("m1159"),
};

function eventEvidence(event: TimelineEvent, workspace: AnalysisWorkspace): string {
  const participants = [event.actor, event.target]
    .filter((value): value is string => Boolean(value))
    .map((playerId) => findPlayerName(workspace, playerId));
  const itemEvidence = timelineEventItemEvidence(event);
  const weapon = itemEvidence ? ` · ${itemEvidence}` : '';
  const flags = [event.headshot ? msg("m0949") : null, event.penetrated ? msg("m1054") : null].filter(Boolean).join(' · ');
  const detail = typeof event.detail === 'object' && event.detail !== null
    ? event.detail as Record<string, unknown>
    : {};
  const numericDetail = (...keys: string[]) => keys
    .map((key) => detail[key])
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const damage = event.kind === 'damage' ? numericDetail('dmg_health', 'damage') : undefined;
  const blindDuration = event.id.startsWith('player_blind-')
    ? numericDetail('blind_duration', 'blind_duration_full', 'duration')
    : undefined;
  const evidence = [
    damage !== undefined ? msgf("m0101", [Math.max(0, damage)]) : null,
    blindDuration !== undefined ? msgf("m1102", [Math.max(0, blindDuration).toFixed(1)]) : null,
  ].filter(Boolean).join(' · ');
  return `${participants.join(' → ') || `tick ${event.tick}`}${weapon}${flags ? ` · ${flags}` : ''}${evidence ? ` · ${evidence}` : ''}`;
}

type RoundEventFilter = 'all' | 'combat' | 'objectives' | 'utility' | 'economy';

function evidenceValue<T>(evidence: RoundEvidenceAvailability<T>): T | null {
  return evidence.state === 'unavailable' ? null : evidence.value;
}

function RoundsView({
  workspace,
  demoId,
  playable,
  selectedRound,
  selectedPlayer,
  selectedTick,
  selectedEvidenceId,
  addedId,
  onSelectRound,
  onPreviewRound,
  onCompile,
}: {
  workspace: AnalysisWorkspace;
  demoId: string;
  playable: boolean;
  selectedRound: number;
  selectedPlayer: PlayerAnalysis | null;
  selectedTick: number | null;
  selectedEvidenceId: string | null;
  addedId: string | null;
  onSelectRound: (round: number) => void;
  onPreviewRound: (round: number, tick?: number, playerId?: string | null) => void;
  onCompile: (moment: CompilationMoment) => void;
}) {
  const { locale, t } = useI18n();
  const [winnerFilter, setWinnerFilter] = useState<'all' | 'A' | 'B'>('all');
  const [eventFilter, setEventFilter] = useState<RoundEventFilter>('combat');
  const [requestedGroupId, setRequestedGroupId] = useState<string | null>(null);
  const ribbonRef = useRef<HTMLDivElement>(null);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const runtimeSession = useRuntimeStore((state) => state.session);
  const playAction = useAsyncAction<{ started: boolean; process_id: number }>();
  const visibleRounds = winnerFilter === 'all'
    ? workspace.rounds
    : workspace.rounds.filter((item) => item.winner === winnerFilter);
  const round = workspace.rounds.find((item) => item.number === selectedRound) ?? workspace.rounds[0];
  const visibleRoundIndex = round ? visibleRounds.findIndex((item) => item.number === round.number) : -1;
  const previousRound = visibleRoundIndex > 0 ? visibleRounds[visibleRoundIndex - 1] : undefined;
  const nextRound = visibleRoundIndex >= 0 ? visibleRounds[visibleRoundIndex + 1] : undefined;
  useEffect(() => {
    const ribbon = ribbonRef.current;
    if (!ribbon || !round) return;
    const item = Array.from(ribbon.querySelectorAll<HTMLElement>('[data-round-number]'))
      .find((candidate) => candidate.dataset.roundNumber === String(round.number));
    if (!item) return;
    const left = item.offsetLeft - ribbon.offsetLeft;
    const right = left + item.offsetWidth;
    if (left < ribbon.scrollLeft || right > ribbon.scrollLeft + ribbon.clientWidth) {
      ribbon.scrollTo({ left: Math.max(0, left - ((ribbon.clientWidth - item.offsetWidth) / 2)), behavior: 'auto' });
    }
  }, [round, visibleRounds.length, winnerFilter]);
  const baseContext = useMemo(
    () => round ? buildRoundContext(workspace, round.number, {
      event_id: selectedEvidenceId?.match(/\/event:(.+)$/u)?.[1] ?? null,
      player_id: selectedPlayer?.id ?? null,
      tick: selectedTick,
    }) : null,
    [round, selectedEvidenceId, selectedPlayer?.id, selectedTick, workspace],
  );
  const allGroups = baseContext?.sections.flatMap((section) => section.groups) ?? [];
  const selectedHighlightId = selectedEvidenceId?.match(/\/highlight:(.+)$/u)?.[1] ?? null;
  const selectedHighlight = selectedHighlightId
    ? workspace.highlights.find((highlight) => highlight.id === selectedHighlightId) ?? null
    : null;
  const highlightedGroupId = selectedHighlight ? evidenceRangeGroupId(
    allGroups.map((group) => ({
      id: group.id,
      startTick: group.start_tick,
      endTick: group.end_tick,
      actorIds: group.events.flatMap((event) => [event.actor, event.target])
        .filter((id): id is string => id !== null),
    })),
    selectedHighlight.start_tick,
    selectedHighlight.end_tick,
    selectedHighlight.player_id,
  ) : null;
  const resolvedGroupId = selectedRoundGroupId(
    allGroups.map((group) => group.id),
    requestedGroupId,
    selectedHighlight ? highlightedGroupId : baseContext?.focus?.matched_group_ids[0] ?? null,
  );
  const context = useMemo(() => {
    const group = allGroups.find((candidate) => candidate.id === resolvedGroupId);
    return round ? buildRoundContext(workspace, round.number, {
      event_id: group?.events[0]?.id ?? null,
      player_id: selectedPlayer?.id ?? null,
      tick: group?.start_tick ?? null,
    }) : null;
  }, [allGroups, resolvedGroupId, round, selectedPlayer?.id, workspace]);
  const selectedGroup = context?.sections
    .flatMap((section) => section.groups)
    .find((group) => group.id === resolvedGroupId) ?? null;
  useEffect(() => {
    const container = sectionsRef.current;
    if (!container || !resolvedGroupId) return;
    const frame = window.requestAnimationFrame(() => {
      const group = Array.from(container.querySelectorAll<HTMLElement>('[data-group-id]'))
        .find((candidate) => candidate.dataset.groupId === resolvedGroupId);
      if (!group) return;
      const nextScrollTop = selectedGroupScrollTop(
        container.scrollTop,
        container.clientHeight,
        group.offsetTop - container.offsetTop,
        group.offsetHeight,
      );
      if (nextScrollTop !== container.scrollTop) {
        container.scrollTo({ top: nextScrollTop, behavior: 'auto' });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resolvedGroupId, selectedRound]);
  const visibleSections = context?.sections.filter((section) => (
    roundSectionIsVisible(section.kind, section.groups.length, eventFilter)
  )) ?? [];
  const sectionLabels = {
    encounters: t('analysis.roundContext.encounters'),
    objective: t('analysis.roundContext.objective'),
    utility: t('analysis.roundContext.utility'),
    economy: t('analysis.roundContext.economy'),
    other: t('analysis.roundContext.other'),
  } as const;
  const groupTitle = (group: RoundContextGroup) => {
    if (group.encounter?.dominant_actor_id && group.encounter.kill_count > 0) {
      return `${findPlayerName(workspace, group.encounter.dominant_actor_id)} ${group.encounter.kill_count}K`;
    }
    const first = group.events[0];
    return first ? eventKindLabel[first.kind] : sectionLabels[group.kind];
  };
  const groupPlayerId = selectedGroup?.encounter?.dominant_actor_id
    ?? selectedGroup?.events.find((event) => Boolean(event.actor))?.actor
    ?? selectedPlayer?.id
    ?? null;
  const selectedParticipantIds = new Set(selectedGroup?.events.flatMap((event) => [event.actor, event.target].filter((value): value is string => Boolean(value))) ?? []);
  const selectedParticipants = context?.inspector.participants.filter((participant) => selectedParticipantIds.has(participant.player_id)) ?? [];
  const radarState = useRadarOverview(workspace.map_name, Boolean(round && selectedGroup));
  const positionedEvents = selectedGroup?.events.filter((event): event is TimelineEvent & { position: [number, number, number] } => event.position !== null) ?? [];
  const radarCoordinates = worldPointsToRadarPercent(
    positionedEvents.map((event) => [event.position[0], event.position[1]]),
    radarState.overview?.transform ?? null,
  );
  const radarImage = radarState.overview?.transform
    && radarState.overview.browser_displayable
    && radarState.overview.image_url
    ? desktopMediaUrl(radarState.overview.image_url)
    : null;
  const changeWinnerFilter = (side: 'all' | 'A' | 'B') => {
    setWinnerFilter(side);
    if (side === 'all' || round?.winner === side) return;
    const firstMatchingRound = workspace.rounds.find((item) => item.winner === side);
    if (firstMatchingRound) onSelectRound(firstMatchingRound.number);
  };
  const navigateRoundStrip = (event: ReactKeyboardEvent<HTMLButtonElement>, currentRound: number) => {
    const nextRoundNumber = roundNumberFromNavigationKey(
      visibleRounds.map((item) => item.number),
      currentRound,
      event.key,
    );
    if (nextRoundNumber === null) return;
    event.preventDefault();
    onSelectRound(nextRoundNumber);
    window.requestAnimationFrame(() => {
      const nextItem = Array.from(ribbonRef.current?.querySelectorAll<HTMLButtonElement>('[data-round-number]') ?? [])
        .find((candidate) => candidate.dataset.roundNumber === String(nextRoundNumber));
      nextItem?.focus();
    });
  };
  return (
    <div className="rounds-view round-context-canvas">
      <Card className="round-selector-card round-context-roundbar" data-testid="round-strip">
        <div className="round-context-roundbar__heading">
          <div><span className="eyebrow">ROUND CONTEXT</span><h2>{t('analysis.roundContext.roundSelection')}</h2></div>
          <div className="mini-segmented" aria-label={msg("m0656")}>
            {(['all', 'A', 'B'] as const).map((side) => <button type="button" key={side} className={winnerFilter === side ? 'is-active' : undefined} onClick={() => changeWinnerFilter(side)}>{side === 'all' ? msg("m0229") : `TEAM ${side}`}</button>)}
          </div>
        </div>
        <div ref={ribbonRef} className="round-grid round-context-ribbon" aria-label={msg("m0374")} role="tablist">
          {visibleRounds.map((item) => (
            <button type="button" role="tab" key={item.number} className={`${item.winner === 'A' ? 'team-a' : 'team-b'}${round?.number === item.number ? ' is-active' : ''}`} aria-current={round?.number === item.number ? 'step' : undefined} aria-selected={round?.number === item.number} aria-label={`${msg("m0367")} ${item.number} · TEAM ${item.winner} · ${roundReasonLabel(item.reason, locale) || msg("m0762")}`} tabIndex={round?.number === item.number ? 0 : -1} data-testid="round-strip-item" data-round-number={item.number} onKeyDown={(event) => navigateRoundStrip(event, item.number)} onClick={() => onSelectRound(item.number)}>
              <span>{item.number}</span><small>{item.winner}</small>
            </button>
          ))}
        </div>
        {visibleRounds.length === 0 ? <EmptyState icon={<ListFilter size={20} />} title={msg("m0893")} description={msg("m0586")} /> : null}
      </Card>
      {round ? (
        <div className="round-context-body" data-testid="round-workbench">
          <Card className="round-detail-card round-context-stream" data-testid="round-event-pane">
            <div className="round-detail-card__title round-context-stream__title">
              <div><span className={`team-token team-token--${round.winner.toLocaleLowerCase()}`}>TEAM {round.winner}</span><h2>{msg("m0367")} {round.number}</h2><p>{roundReasonLabel(round.reason, locale) || msg("m0762")} · tick {round.start_tick}–{round.end_tick}</p></div>
              <div>
                <Button className="round-context-nav-button" size="sm" variant="ghost" disabled={!previousRound} title={t('analysis.previousRound')} onClick={() => previousRound && onSelectRound(previousRound.number)}><ChevronLeft size={13} /><span>{t('analysis.previousRound')}</span></Button>
                <Button className="round-context-nav-button" size="sm" variant="ghost" disabled={!nextRound} title={t('analysis.nextRound')} onClick={() => nextRound && onSelectRound(nextRound.number)}><span>{t('analysis.nextRound')}</span><ChevronRight size={13} /></Button>
                <Button size="sm" title={t('analysis.openRoundReplay')} onClick={() => onPreviewRound(round.number, selectedGroup?.start_tick, groupPlayerId)}><MapIcon size={13} />{t('analysis.roundContext.spatialReplay')}</Button>
              </div>
            </div>
            {playAction.state.message ? <Notice tone={playAction.state.status === 'error' ? 'danger' : 'success'}>{playAction.state.message}</Notice> : null}

            <div className="round-context-ruler" aria-label={t('analysis.roundContext.tickRuler')} data-testid="round-time-ruler">
              <div><span>{round.start_tick}</span><span>{Math.round((round.start_tick + round.end_tick) / 2)}</span><span>{round.end_tick}</span></div>
              <i />
              {selectedGroup ? <b style={{ insetInlineStart: `${roundTickPercent(selectedGroup.start_tick, round.start_tick, round.end_tick)}%` }}><span>{selectedGroup.start_tick}</span></b> : null}
            </div>

            <div className="round-context-toolbar" data-testid="round-filter-toolbar">
              <div className="mini-segmented" aria-label={msg("m1066")}>
                {(['all', 'combat', 'objectives', 'utility', 'economy'] as const).map((filter) => <button type="button" key={filter} className={eventFilter === filter ? 'is-active' : undefined} onClick={() => setEventFilter(filter)}>{({ all: msg("m0229"), combat: msg("m0178"), objectives: msg("m1013"), utility: msg("m1250"), economy: msg("m1076") } as const)[filter]}</button>)}
              </div>
              <span>{t('analysis.roundContext.atomicEvidence')} · {context?.sections.reduce((sum, section) => sum + section.atomic_event_ids.length, 0) ?? 0}</span>
            </div>

            {visibleSections.length > 0 ? <div ref={sectionsRef} className="round-context-sections">{visibleSections.map((section) => (
              <section key={section.id} className="round-context-section">
                <header><span>{sectionLabels[section.kind]}</span><Badge tone="neutral">{section.groups.length}</Badge></header>
                <div>{section.groups.map((group) => {
                  const isSelected = group.id === selectedGroup?.id;
                  return <article key={group.id} className={`round-context-group${isSelected ? ' is-selected' : ''}`} data-testid="round-group" data-group-id={group.id} data-kind={group.kind} data-start-tick={group.start_tick} data-end-tick={group.end_tick}>
                    <button type="button" className="round-context-group__summary" aria-expanded={isSelected} onClick={() => setRequestedGroupId(group.id)}>
                      <span className={`event-dot${group.encounter?.kill_count || group.kind === 'objective' ? ' is-highlight' : ''}`} />
                      <time>+{formatClock(Math.max(0, group.start_tick - round.start_tick) / Math.max(1, workspace.tick_rate))}</time>
                      <span><strong>{groupTitle(group)}</strong><small>{tickDurationLabel(group.start_tick, group.end_tick, workspace.tick_rate)} · {group.atomic_event_ids.length} {t('analysis.roundContext.events')}</small></span>
                      {group.encounter?.weapon_names.length ? <span className="round-context-group__weapons">{group.encounter.weapon_names.join(' · ')}</span> : null}
                      <ChevronDown size={15} />
                    </button>
                    {isSelected ? <div className="round-context-atoms">{group.events.map((event) => {
                      const canCompile = Boolean(event.actor) && !['round_start', 'round_end'].includes(event.kind);
                      const compilationId = `event-${event.id}`;
                      const eventEvidenceId = `demo:${workspace.demo_id}/event:${event.id}`;
                      const focused = selectedEvidenceId === eventEvidenceId;
                      return <div key={event.id} className={`round-context-atom${focused ? ' is-focused' : ''}`} data-testid="round-event" data-event-id={event.id} data-evidence-id={eventEvidenceId} data-tick={event.tick} aria-current={focused ? 'true' : undefined}><time>{event.tick}</time><span><strong>{eventKindLabel[event.kind]}</strong><small>{eventEvidence(event, workspace)}</small></span>{event.headshot ? <Badge tone="accent">{msg("m0949")}</Badge> : null}{canCompile ? <Button size="sm" variant="ghost" title={msg("m0299")} onClick={() => onCompile({ id: compilationId, title: `${eventKindLabel[event.kind]} · ${eventEvidence(event, workspace)}`, playerId: event.actor!, startTick: Math.max(round.start_tick, event.tick - 128), endTick: Math.max(event.tick + 1, Math.min(round.end_tick, event.tick + 192)), category: event.kind === 'kill' ? 'entry' : event.kind === 'grenade' || event.kind.startsWith('bomb_') ? 'utility' : 'custom' })}>{addedId === compilationId ? <Check size={12} /> : <Plus size={12} />}</Button> : null}</div>;
                    })}</div> : null}
                  </article>;
                })}</div>
              </section>
            ))}</div> : <EmptyState icon={<ListFilter size={22} />} title={msg("m0892")} description={msg("m0774")} />}
          </Card>

          <Card className="round-context-spatial" data-testid="round-context-pane">
            <header><div><span className="eyebrow">SPATIAL EVIDENCE</span><h2>{t('analysis.roundContext.mapContext')}</h2></div><div className="round-context-spatial__actions"><span>{positionedEvents.length} {t('analysis.roundContext.positionedEvents')}</span><Badge tone={radarImage ? 'success' : 'neutral'}>{radarImage ? t('analysis.roundContext.mapCoordinates') : t('analysis.roundContext.unavailable')}</Badge><Button size="sm" variant="ghost" onClick={() => onPreviewRound(round.number, selectedGroup?.start_tick, groupPlayerId)}>{t('analysis.roundContext.openFullReplay')}<ChevronRight size={13} /></Button></div></header>
            <div className="round-context-spatial__body">
              <div className={`round-context-radar${radarImage ? ' has-radar-image' : ''}`} data-testid="round-radar">
                {radarImage ? <img src={radarImage} alt={msgf("m0111", [workspace.map_name])} /> : <div><Grid3X3 size={20} /><strong>{radarState.status === 'loading' ? t('analysis.replay.radarLoading') : t('analysis.roundContext.noSpatialEvidence')}</strong><span>{radarState.error ?? t('analysis.roundContext.noSpatialEvidenceDescription')}</span></div>}
                {radarCoordinates?.map((position, index) => {
                  const event = positionedEvents[index]!;
                  return <span key={event.id} className={`round-context-radar__event${event.kind === 'kill' || event.kind.startsWith('bomb_') ? ' is-highlight' : ''}`} style={{ left: `${position[0]}%`, top: `${position[1]}%` }} title={`${eventKindLabel[event.kind]} · ${event.actor ? findPlayerName(workspace, event.actor) : `tick ${event.tick}`} · tick ${event.tick}`}><CircleDot size={12} /></span>;
                })}
              </div>
              <div className="round-context-spatial__legend">{positionedEvents.length > 0 ? positionedEvents.map((event) => <button type="button" key={event.id} onClick={() => onPreviewRound(round.number, event.tick, event.actor)}><i className={event.kind === 'kill' || event.kind.startsWith('bomb_') ? 'is-highlight' : undefined} /><time>{event.tick}</time><span><strong>{eventKindLabel[event.kind]}</strong><small>{event.actor ? findPlayerName(workspace, event.actor) : t('analysis.roundContext.unavailable')}</small></span></button>) : <p>{t('analysis.roundContext.noSpatialEvidenceDescription')}</p>}</div>
            </div>
          </Card>

          <Card className="round-context-inspector" data-testid="round-inspector">
            <header><div><span className="eyebrow">EVIDENCE INSPECTOR</span><h2>{t('analysis.roundContext.evidenceDetails')}</h2></div><Badge tone="accent">tick {context?.inspector.at_tick ?? round.end_tick}</Badge></header>
            {selectedGroup ? <>
              <div className="round-context-inspector__focus"><span>{sectionLabels[selectedGroup.kind]}</span><strong>{groupTitle(selectedGroup)}</strong><small>{selectedGroup.start_tick}–{selectedGroup.end_tick} · {selectedGroup.atomic_event_ids.length} {t('analysis.roundContext.events')}</small></div>
              <div className="round-context-side-grid">{context?.inspector.sides.map((side) => {
                const purchases = evidenceValue(side.purchases);
                const spend = evidenceValue(side.spend);
                return <section key={side.side}><header><strong>{side.side}</strong><Badge tone={side.purchases.state === 'unavailable' ? 'neutral' : 'success'}>{side.purchases.state === 'available' ? t('analysis.roundContext.verified') : side.purchases.state === 'partial' ? t('analysis.roundContext.partial') : t('analysis.roundContext.unavailable')}</Badge></header><dl><div><dt>{t('analysis.roundContext.spend')}</dt><dd>{spend === null ? '—' : `$${spend.toLocaleString()}`}</dd></div><div><dt>{t('analysis.roundContext.purchases')}</dt><dd>{purchases?.count ?? '—'}</dd></div></dl>{purchases?.items.length ? <p>{purchases.items.slice(0, 4).map((item) => `${item.name} ×${item.count}`).join(' · ')}</p> : <p>{t('analysis.roundContext.noSnapshot')}</p>}</section>;
              })}</div>
              <section className="round-context-participants"><header><strong>{t('analysis.roundContext.participants')}</strong><Badge tone="neutral">{selectedParticipants.length}</Badge></header>{selectedParticipants.length ? <div>{selectedParticipants.map((participant) => <span key={participant.player_id}><i className={`player-avatar player-avatar--${participant.side.state === 'available' ? participant.side.value.toLocaleLowerCase() : 'unknown'}`}>{playerInitials(participant.name)}</i><b>{participant.name}</b><small>{participant.alive.state === 'available' && !participant.alive.value ? t('analysis.roundContext.knownDead') : t('analysis.roundContext.lifeUnknown')}</small></span>)}</div> : <p>{t('analysis.roundContext.noParticipants')}</p>}</section>
              <section className="round-context-inspector__events"><header><strong>{t('analysis.roundContext.atomicEvidence')}</strong><Badge tone="neutral">{selectedGroup.events.length}</Badge></header>{selectedGroup.events.map((event) => <button type="button" key={event.id} onClick={() => onPreviewRound(round.number, event.tick, event.actor)}><time>{event.tick}</time><span><strong>{eventKindLabel[event.kind]}</strong><small>{eventEvidence(event, workspace)}</small></span><ChevronRight size={13} /></button>)}</section>
              <footer data-testid="round-inspector-actions"><Button size="sm" variant="secondary" disabled={!playable || playAction.state.status === 'loading' || runtimeSession !== 'idle'} title={!playable ? msg("m1001") : runtimeSession !== 'idle' ? msg("m0799") : msg("m0390")} onClick={() => void playAction.run(() => runManagedPlaybackLaunch(() => commands.playDemo(demoId, { start_tick: selectedGroup.start_tick })), msg("m0514"))}>{playAction.state.status === 'loading' ? <Spinner /> : <Play size={13} />}{t('analysis.roundContext.watchGame')}</Button><Button size="sm" variant="secondary" onClick={() => onPreviewRound(round.number, selectedGroup.start_tick, groupPlayerId)}><MapIcon size={13} />{t('analysis.roundContext.open2d')}</Button><Button size="sm" disabled={!groupPlayerId} onClick={() => groupPlayerId && onCompile({ id: `group-${selectedGroup.id}`, title: `${msg("m0367")} ${round.number} · ${groupTitle(selectedGroup)}`, playerId: groupPlayerId, startTick: selectedGroup.start_tick, endTick: Math.max(selectedGroup.start_tick + 1, selectedGroup.end_tick), category: selectedGroup.kind === 'encounters' ? 'entry' : selectedGroup.kind === 'utility' || selectedGroup.kind === 'objective' ? 'utility' : 'custom' })}>{addedId === `group-${selectedGroup.id}` ? <Check size={13} /> : <Plus size={13} />}{addedId === `group-${selectedGroup.id}` ? msg("m0502") : t('analysis.roundContext.addProduction')}</Button></footer>
            </> : <EmptyState icon={<CircleDot size={22} />} title={t('analysis.roundContext.noSelection')} description={t('analysis.roundContext.noSelectionDescription')} />}
          </Card>
        </div>
      ) : null}
    </div>
  );
}

type RadarOverviewState = Readonly<{
  overview: RadarOverviewRecord | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
}>;

function useRadarOverview(mapName: string, enabled: boolean): RadarOverviewState {
  const [radarState, setRadarState] = useState<RadarOverviewState>({
    overview: null,
    status: 'idle',
    error: null,
  });

  useEffect(() => {
    if (!enabled || mapName.trim().length === 0) {
      setRadarState({ overview: null, status: 'idle', error: null });
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    setRadarState({ overview: null, status: 'loading', error: null });
    void commands.getRadarOverview(mapName, controller.signal)
      .then((response) => {
        if (active) setRadarState({ overview: response, status: 'ready', error: null });
      })
      .catch((cause: unknown) => {
        if (active && !controller.signal.aborted) {
          setRadarState({ overview: null, status: 'error', error: readableError(cause) });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, mapName]);

  return radarState;
}

function activeInputLabels(player: ReplayFrameRecord['players'][number]): string[] {
  if (!player.input) return [];
  return [
    player.input.forward ? 'W' : null,
    player.input.left ? 'A' : null,
    player.input.backward ? 'S' : null,
    player.input.right ? 'D' : null,
    player.input.jump ? msg("m1170") : null,
    player.input.crouch ? msg("m1171") : null,
    player.input.walk ? msg("m1296") : null,
    player.input.reload ? msg("m0660") : null,
    player.input.fire ? msg("m0559") : null,
    player.input.secondary_fire ? msg("m0353") : null,
  ].filter((label): label is string => label !== null);
}

function currentReplayWorkspaceDensity(): ReplayWorkspaceDensity {
  if (typeof window === 'undefined') return 'expanded';
  return replayWorkspaceDensity({ width: window.innerWidth, height: window.innerHeight });
}

function useReplayWorkspaceDensity(): ReplayWorkspaceDensity {
  const [density, setDensity] = useState<ReplayWorkspaceDensity>(currentReplayWorkspaceDensity);

  useEffect(() => {
    const handleResize = () => setDensity(currentReplayWorkspaceDensity());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return density;
}

function ReplayView({
  demoId,
  workspace,
  source,
  roundNumber,
  targetTick,
  selectedPlayerId,
  onSelectPlayer,
}: {
  demoId: string;
  workspace: AnalysisWorkspace;
  source: 'loading' | 'service' | 'error';
  roundNumber: number;
  targetTick: number | null;
  selectedPlayerId: string | null;
  onSelectPlayer: (playerId: string) => void;
}) {
  const { t } = useI18n();
  const [frames, setFrames] = useState<ReplayFrameRecord[]>([]);
  const [cache, setCache] = useState<ReplayCacheMetadata | null>(null);
  const [fidelity, setFidelity] = useState<ReplayFidelityMetadata | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [speed, setSpeed] = useState<0.5 | 1 | 2>(1);
  const [sideFilter, setSideFilter] = useState<'all' | 'A' | 'B'>('all');
  const radarState = useRadarOverview(workspace.map_name, source === 'service');
  const workspaceDensity = useReplayWorkspaceDensity();

  useEffect(() => {
    if (source !== 'service') {
      setFrames([]);
      setCache(null);
      setFidelity(null);
      setState('idle');
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setState('loading');
    setError(null);
    void commands.getReplayBinary(demoId, controller.signal).then(decodeReplayBinary).then((response) => {
      if (!active) return;
      setFrames(response.frames);
      setCache(response.cache);
      setFidelity(response.fidelity);
      setFrameIndex(0);
      setState('ready');
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      setFrames([]);
      setCache(null);
      setFidelity(null);
      setState('error');
      setError(readableError(cause));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [demoId, source]);

  const round = useMemo(
    () => workspace.rounds.find((item) => item.number === roundNumber) ?? workspace.rounds[0] ?? null,
    [roundNumber, workspace.rounds],
  );
  const roundScope = useMemo(
    () => round ? scopeReplayFrames(frames, round, targetTick) : { frames: [], initialIndex: 0 },
    [frames, round, targetTick],
  );
  const roundFrames = roundScope.frames;

  useEffect(() => {
    setPlaying(false);
    setFrameIndex(roundScope.initialIndex);
  }, [roundFrames, roundNumber, roundScope.initialIndex, targetTick]);

  const replayTickRate = fidelity?.tick_rate ?? workspace.tick_rate;
  const replayTimingMode = fidelity?.mode ?? 'entity_snapshots';
  const replayBounds = useMemo(() => replayWorldBounds(frames), [frames]);

  useEffect(() => {
    if (!playing || roundFrames.length < 2) return undefined;
    const current = roundFrames[Math.min(frameIndex, roundFrames.length - 1)];
    const next = roundFrames[frameIndex >= roundFrames.length - 1 ? 0 : frameIndex + 1];
    const delay = current && next
      ? replayFrameDelayMs(current.tick, next.tick, replayTickRate, speed, replayTimingMode)
      : 100;
    const timer = window.setTimeout(
      () => setFrameIndex((index) => nextScopedFrameIndex(index, roundFrames.length)),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [frameIndex, playing, replayTickRate, replayTimingMode, roundFrames, speed]);

  if (state === 'loading') return <Card><EmptyState icon={<Spinner />} title={msg("m0863")} description={msg("m0743")} /></Card>;
  if (state === 'error') return <Card><EmptyState icon={<CircleDot size={22} />} title={msg("m0017")} description={error ?? msg("m0778")} /></Card>;
  if (frames.length === 0) return <Card><EmptyState icon={<MapIcon size={22} />} title={msg("m0899")} description={msg("m0487")} /></Card>;
  if (roundFrames.length === 0) return <Card><EmptyState icon={<MapIcon size={22} />} title={t('analysis.replay.noRoundEvidence')} description={t('analysis.replay.noRoundEvidenceDescription')} /></Card>;

  const currentFrameIndex = Math.min(frameIndex, roundFrames.length - 1);
  const currentFrame = roundFrames[currentFrameIndex]!;
  const radar = radarState.overview;
  const radarTransform = radar?.transform ?? null;
  const visiblePlayers = sideFilter === 'all'
    ? currentFrame.players
    : currentFrame.players.filter((player) => normalizeSide(player.team) === sideFilter);
  const activeProjectiles = currentFrame.projectiles.filter((projectile) => projectile.active);
  const playerPoints: Array<[number, number]> = visiblePlayers.map((player) => [player.position[0], player.position[1]]);
  const projectilePoints: Array<[number, number]> = activeProjectiles.map((projectile) => [projectile.position[0], projectile.position[1]]);
  const bombPoints: Array<[number, number]> = currentFrame.bomb ? [[currentFrame.bomb.position[0], currentFrame.bomb.position[1]]] : [];
  const allPoints = [...playerPoints, ...projectilePoints, ...bombPoints];
  const allCoordinates = worldPointsToRadarPercent(allPoints, radarTransform)
    ?? worldPointsToRelativePercent(allPoints, replayBounds);
  const coordinates = allCoordinates.slice(0, playerPoints.length);
  const projectileCoordinates = allCoordinates.slice(playerPoints.length, playerPoints.length + projectilePoints.length);
  const bombCoordinate = currentFrame.bomb ? allCoordinates.at(-1) ?? null : null;
  const radarImage = radarTransform && radar?.browser_displayable && radar.image_url ? desktopMediaUrl(radar.image_url) : null;
  const startTick = round?.start_tick ?? roundFrames[0]?.tick ?? currentFrame.tick;
  const endTick = round?.end_tick ?? roundFrames.at(-1)?.tick ?? currentFrame.tick;
  const elapsed = replayTickRate > 0 ? (currentFrame.tick - startTick) / replayTickRate : 0;
  const total = replayTickRate > 0 ? (endTick - startTick) / replayTickRate : 0;
  const fidelityPresentation = fidelity ? replayFidelityPresentation(fidelity) : null;
  const playbackControl = replayPlaybackControlPresentation(replayTimingMode, speed);

  return (
    <div className="replay-layout" data-replay-density={workspaceDensity} data-testid="replay-workspace">
      <Card className="replay-map-card" data-testid="replay-stage">
        <div className="replay-map-toolbar" data-testid="replay-toolbar">
          <div>
            <Grid3X3 size={14} />
            <strong>{workspace.map_name ? workspace.map_name.replace('de_', '').toUpperCase() : 'MAP'}</strong>
            {radarTransform ? <Badge tone="neutral">{msg("m0397")}</Badge> : <Badge tone="neutral">{msg("m1023")}</Badge>}
            {cache ? <span title={cache.reason ?? `${cache.bytes.toLocaleString(currentLocale())} bytes`}><Badge tone={cache.state === 'hit' ? 'success' : cache.state === 'bypassed' ? 'warning' : 'neutral'}>{replayCacheLabel(cache)}</Badge></span> : null}
          </div>
          <div className="mini-segmented" aria-label={msg("m0658")}>
            {(['all', 'A', 'B'] as const).map((side) => <button type="button" key={side} className={sideFilter === side ? 'is-active' : undefined} onClick={() => setSideFilter(side)}>{side === 'all' ? msg("m0229") : `TEAM ${side}`}</button>)}
          </div>
        </div>
        {fidelity && fidelityPresentation ? (
          <div className="replay-fidelity" role="status" data-testid="replay-fidelity">
            <Badge tone={fidelityPresentation.tone}>{fidelityPresentation.label}</Badge>
            <span>{fidelityPresentation.description}</span>
            <small>{fidelity.frame_count.toLocaleString(currentLocale())} {t('analysis.replay.fidelity.frames')} · {fidelity.positioned_event_count.toLocaleString(currentLocale())} {t('analysis.replay.fidelity.positionedEvents')}</small>
          </div>
        ) : null}
        <div className={`replay-map${radarImage ? ' has-radar-image' : ' is-coordinate-plane'}`} data-testid="replay-canvas">
          {radarImage ? <img className="radar-map-image" src={radarImage} alt={msgf("m0111", [workspace.map_name])} /> : (
            <div className="replay-map__coordinate-note">
              <Grid3X3 size={16} />
              <strong>{radarState.status === 'loading' ? t('analysis.replay.radarLoading') : radarTransform ? t('analysis.replay.radarImageUnavailable') : t('analysis.replay.relativeCoordinates')}</strong>
              <span>{radarState.error ?? (radarTransform ? t('analysis.replay.radarImageUnavailableDescription') : t('analysis.replay.relativeCoordinatesDescription'))}</span>
            </div>
          )}
          {visiblePlayers.map((player, index) => {
            const position = coordinates[index] ?? [50, 50];
            const side = normalizeSide(player.team);
            const inputs = activeInputLabels(player);
            const vital = replayPlayerVitalPresentation(player);
            const selected = player.id === selectedPlayerId;
            return <button type="button" className={`replay-player replay-player--${side === 'A' ? 'a' : side === 'B' ? 'b' : 'unknown'}${selected ? ' is-selected' : ''}`} key={player.id} style={{ left: `${position[0]}%`, top: `${position[1]}%`, opacity: player.alive ? 1 : .35 }} title={`${player.name} · ${vital.healthLabel} · ${vital.statusLabel}${player.weapon ? ` · ${player.weapon}` : ''}${inputs.length > 0 ? ` · ${inputs.join('+')}` : ''}`} aria-pressed={selected} onClick={() => onSelectPlayer(player.id)}><span>{index + 1}</span><small>{player.name}</small></button>;
          })}
          {activeProjectiles.map((projectile, index) => {
            const position = projectileCoordinates[index] ?? [50, 50];
            const presentation = replayEffectPresentation(projectile.kind);
            return <span key={`${projectile.kind}-${projectile.position.join('-')}-${index}`} className={`replay-grenade replay-grenade--${presentation.className}${projectile.masks_vision ? ' is-utility-mask' : ''}`} style={{ left: `${position[0]}%`, top: `${position[1]}%` }} title={msgf("m0116", [presentation.label, presentation.eventOnly ? msg("m1351") : msg("m1352"), projectile.radius ? msgf("m0323", [projectile.radius.toFixed(0)]) : msg("m1353"), projectile.masks_vision ? msg("m1354") : ''])} />;
          })}
          {currentFrame.bomb && bombCoordinate ? <span className={`replay-bomb replay-bomb--${currentFrame.bomb.state === 'planted' || currentFrame.bomb.state === 'defused' || currentFrame.bomb.state === 'exploded' ? currentFrame.bomb.state : 'unknown'}`} style={{ left: `${bombCoordinate[0]}%`, top: `${bombCoordinate[1]}%` }} title={msgf("m0942", [currentFrame.bomb.state])}>B</span> : null}
        </div>
        <div className="replay-legend" aria-label={msg("m0378")} data-testid="replay-legend">
          {(['smoke', 'inferno', 'decoy', 'he', 'flash'] as const).map((kind) => { const item = replayEffectPresentation(kind); return <span key={kind}><i className={`replay-legend__dot replay-grenade--${item.className}`} />{item.label}</span>; })}
          <span><i className="replay-legend__bomb">B</i>{msg("m0943")}</span>
          <small>{msg("m0183")}</small>
        </div>
        <div className="replay-controls" data-testid="replay-transport">
          <Button size="sm" variant="ghost" disabled={roundFrames.length < 2} onClick={() => setPlaying((value) => !value)} aria-label={playing ? msg("m0730") : msg("m0674")} title={playing ? msg("m0730") : msg("m0674")}>{playing ? <Pause size={15} /> : <Play size={15} />}</Button>
          <span title={t('analysis.replay.timing.recordedClock')}>{formatClock(elapsed)}</span>
          <input type="range" min="0" max={Math.max(0, roundFrames.length - 1)} step="1" value={currentFrameIndex} onChange={(event) => setFrameIndex(Number(event.target.value))} aria-label={msg("m0376")} />
          <span title={t('analysis.replay.timing.recordedClock')}>{formatClock(total)}</span>
          <Button size="sm" title={playbackControl.description} onClick={() => setSpeed((current) => current === .5 ? 1 : current === 1 ? 2 : .5)}>{playbackControl.buttonLabel}</Button>
        </div>
      </Card>
      <Card className="replay-events" data-testid="replay-inspector">
        <div className="card-heading"><div><span className="eyebrow">FRAME EVIDENCE</span><h2>{msg("m0572")}</h2></div><ScanLine size={16} /></div>
        {visiblePlayers.map((player) => { const inputs = activeInputLabels(player); const vital = replayPlayerVitalPresentation(player); const selected = player.id === selectedPlayerId; return <div className={selected ? 'is-current' : undefined} key={player.id}><time>{vital.healthLabel}</time><span className="event-type-icon"><Crosshair size={13} /></span><p>{player.name}{selected ? ` · ${t('analysis.replay.focusedPlayer')}` : ''}{player.weapon ? ` · ${player.weapon}` : ''} · {vital.statusLabel}{inputs.length > 0 ? ` · ${inputs.join('+')}` : ''}</p></div>; })}
        {activeProjectiles.map((projectile, index) => { const item = replayEffectPresentation(projectile.kind); return <div key={`${projectile.kind}-${index}`}><time>{msg("m0680")}</time><span className="event-type-icon"><Zap size={13} /></span><p>{item.label}{item.eventOnly ? msg("m0004") : msg("m0006")}</p></div>; })}
        {currentFrame.bomb ? <div><time>{msg("m1013")}</time><span className="event-type-icon"><CircleDot size={13} /></span><p>{msg("m0941")} {currentFrame.bomb.state === 'planted' ? msg("m0509") : currentFrame.bomb.state === 'defused' ? msg("m0516") : currentFrame.bomb.state === 'exploded' ? msg("m0532") : currentFrame.bomb.state}</p></div> : null}
      </Card>
    </div>
  );
}

function HeatmapView({
  demoId,
  mapName,
  player,
  players,
  source,
  selectedRound,
  onNavigate,
}: {
  demoId: string;
  mapName: string;
  player: PlayerAnalysis | null;
  players: readonly PlayerAnalysis[];
  source: 'loading' | 'service' | 'error';
  selectedRound: number | null;
  onNavigate: (patch: AnalysisNavigationPatch) => void;
}) {
  const { t } = useI18n();
  const [points, setPoints] = useState<HeatPointRecord[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'all' | 'kills' | 'deaths' | 'movement' | 'utility'>('all');
  const [floor, setFloor] = useState<number | null>(null);
  const [side, setSide] = useState<HeatmapSide>('all');
  const [playerOnly, setPlayerOnly] = useState(false);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const playAction = useAsyncAction<unknown>();
  const runtimeSession = useRuntimeStore((runtime) => runtime.session);
  const radarState = useRadarOverview(mapName, source === 'service');

  useEffect(() => {
    if (source !== 'service') {
      setPoints([]);
      setState('idle');
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setState('loading');
    setError(null);
    void commands.getHeatmap(demoId, controller.signal).then((response) => {
      if (!active) return;
      setPoints(response);
      setState('ready');
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      setPoints([]);
      setState('error');
      setError(readableError(cause));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [demoId, source]);

  useEffect(() => {
    setSelectedPointId(null);
  }, [demoId, floor, mode, playerOnly, selectedRound, side]);

  if (state === 'loading') return <Card><EmptyState icon={<Spinner />} title={msg("m0870")} description={msg("m1052")} /></Card>;
  if (state === 'error') return <Card><EmptyState icon={<Flame size={22} />} title={msg("m0947")} description={error ?? msg("m0779")} /></Card>;
  if (points.length === 0) return <Card><EmptyState icon={<Flame size={22} />} title={msg("m0902")} description={msg("m0260")} /></Card>;

  const floors = [...new Set(points.map((point) => point.floor))].sort((left, right) => left - right);
  const rounds = [...new Set([
    ...points.flatMap((point) => point.round == null ? [] : [point.round]),
    ...(selectedRound === null ? [] : [selectedRound]),
  ])].sort((left, right) => left - right);
  const filtered = filterHeatmapPoints(points, {
    mode,
    floor,
    side,
    playerId: playerOnly && player ? player.id : null,
    round: selectedRound,
  });
  const radar = radarState.overview;
  const radarTransform = radar?.transform ?? null;
  const coordinates = projectHeatmapPoints(points, filtered, radarTransform);
  const radarImage = radarTransform && radar?.browser_displayable && radar.image_url ? desktopMediaUrl(radar.image_url) : null;
  const summary = summarizeHeatmapPoints(filtered);
  const selectedPoint = points.find((point) => point.id === selectedPointId) ?? null;
  const selectedIntent = selectedPoint ? heatmapEvidenceIntent(demoId, selectedPoint) : null;
  const selectedPlayerName = selectedPoint?.player_id
    ? players.find((candidate) => candidate.id === selectedPoint.player_id)?.name ?? selectedPoint.player_id
    : t('analysis.heatmap.playerUnavailable');
  const selectedRoundLabel = selectedPoint?.round == null
    ? t('analysis.heatmap.roundUnavailable')
    : `R${selectedPoint.round}`;
  const watchDisabled = runtimeSession !== 'idle' || playAction.state.status === 'loading';

  return (
    <div className="heatmap-layout">
      <Card className="heatmap-map-card">
        <div className="heatmap-toolbar">
          <div>
            <Flame size={15} />
            <strong>{msg("m0227")}</strong>
            {radarTransform ? <Badge tone="neutral">{msg("m0397")}</Badge> : <Badge tone="neutral">{msg("m1023")}</Badge>}
          </div>
          <div className="mini-segmented">
            {(['all', 'kills', 'deaths', 'movement', 'utility'] as const).map((item) => <button type="button" key={item} className={mode === item ? 'is-active' : undefined} onClick={() => setMode(item)}>{({ all: msg("m0229"), kills: msg("m0252"), deaths: msg("m0878"), movement: msg("m1045"), utility: msg("m1250") } as const)[item]}</button>)}
          </div>
          <label>
            <span className="sr-only">{t('analysis.heatmap.roundFilter')}</span>
            <select
              data-testid="heatmap-round-filter"
              value={selectedRound ?? 'all'}
              onChange={(event) => onNavigate({
                round: event.target.value === 'all' ? null : Number(event.target.value),
              })}
              aria-label={t('analysis.heatmap.roundFilter')}
            >
              <option value="all">{t('analysis.heatmap.allRounds')}</option>
              {rounds.map((round) => <option key={round} value={round}>R{round}</option>)}
            </select>
          </label>
          <label><span className="sr-only">{t('analysis.heatmap.sideFilter')}</span><select value={side} onChange={(event) => setSide(event.target.value as HeatmapSide)} aria-label={t('analysis.heatmap.sideFilter')}><option value="all">{t('analysis.heatmap.allSides')}</option><option value="T">{t('analysis.insights.economy.tSide')}</option><option value="CT">{t('analysis.insights.economy.ctSide')}</option></select></label>
          <Button size="sm" variant={playerOnly ? 'primary' : 'ghost'} disabled={!player} onClick={() => setPlayerOnly((value) => !value)}>{playerOnly ? msgf("m0180", [player?.name]) : msg("m1067")}</Button>
          <label>
            <span className="sr-only">{msg("m0833")}</span>
            <select value={floor ?? 'all'} onChange={(event) => setFloor(event.target.value === 'all' ? null : Number(event.target.value))}>
              <option value="all">{msg("m0232")}</option>
              {floors.map((value) => <option key={value} value={value}>{msg("m0833")} {value}</option>)}
            </select>
          </label>
        </div>
        {filtered.length > 0 ? (
          <div className={`heatmap-map heatmap-map--${mode}${radarImage ? ' has-radar-image' : ' is-coordinate-plane'}`} data-coordinate-space={radarTransform ? 'map-overview' : 'whole-artifact-relative'}>
            {radarImage ? <img className="radar-map-image" src={radarImage} alt={msgf("m0111", [mapName])} /> : (
              <div className="replay-map__coordinate-note">
                <MapIcon size={16} />
                <strong>{t('analysis.heatmap.relativeCoordinates')}</strong>
                <span>{t('analysis.heatmap.relativeCoordinatesDescription')}</span>
              </div>
            )}
            {filtered.map((point, pointIndex) => {
              const position = coordinates.get(point.id) ?? [50, 50];
              const weight = Math.max(.08, Math.min(1, point.weight));
              const size = 20 + weight * 56;
              const round = point.round == null ? t('analysis.heatmap.roundUnavailable') : `R${point.round}`;
              const playerIdentity = point.player_id ?? t('analysis.heatmap.playerUnavailable');
              const evidenceSide = point.side ?? t('analysis.heatmap.sideUnavailable');
              const label = `${point.kind} · ${round} · tick ${point.tick} · ${playerIdentity} · ${evidenceSide} · weight ${point.weight.toFixed(2)} · floor ${point.floor}`;
              return (
                <button
                  type="button"
                  key={point.id}
                  className={`heat-spot${selectedPointId === point.id ? ' is-selected' : ''}`}
                  data-testid="heatmap-point"
                  data-evidence-id={point.id}
                  data-heat-index={pointIndex}
                  style={{ left: `${position[0]}%`, top: `${position[1]}%`, width: size, height: size, opacity: .25 + weight * .65 }}
                  aria-label={label}
                  aria-pressed={selectedPointId === point.id}
                  tabIndex={selectedPointId === point.id || (selectedPointId === null && pointIndex === 0) ? 0 : -1}
                  title={label}
                  onClick={() => setSelectedPointId(point.id)}
                  onFocus={() => setSelectedPointId(point.id)}
                  onKeyDown={(event) => {
                    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown'
                      ? 1
                      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                        ? -1
                        : null;
                    if (direction === null) return;
                    event.preventDefault();
                    const nextIndex = nextHeatmapPointIndex(filtered.length, pointIndex, direction);
                    const nextPoint = filtered[nextIndex];
                    if (!nextPoint) return;
                    setSelectedPointId(nextPoint.id);
                    event.currentTarget.parentElement
                      ?.querySelector<HTMLButtonElement>(`[data-heat-index="${nextIndex}"]`)
                      ?.focus();
                  }}
                />
              );
            })}
          </div>
        ) : <EmptyState icon={<Flame size={20} />} title={msg("m0877")} description={msg("m0025")} />}
      </Card>
      <div className="heatmap-insights">
        <Card className="heatmap-evidence-card" data-testid="heatmap-evidence-inspector">
          <span className="eyebrow">EVIDENCE FOCUS</span>
          <h2>{t('analysis.heatmap.selectedEvidence')}</h2>
          {selectedPoint && selectedIntent ? (
            <>
              <dl>
                <div><dt>{t('analysis.heatmap.kind')}</dt><dd>{selectedPoint.kind}</dd></div>
                <div><dt>{t('analysis.heatmap.round')}</dt><dd>{selectedRoundLabel}</dd></div>
                <div><dt>Tick</dt><dd>{selectedPoint.tick}</dd></div>
                <div><dt>{t('analysis.heatmap.player')}</dt><dd>{selectedPlayerName}</dd></div>
                <div><dt>{t('analysis.heatmap.side')}</dt><dd>{selectedPoint.side ?? t('analysis.heatmap.sideUnavailable')}</dd></div>
                <div><dt>{t('analysis.heatmap.floor')}</dt><dd>{selectedPoint.floor}</dd></div>
              </dl>
              <code title={selectedIntent.evidenceId ?? selectedPoint.id}>{selectedIntent.evidenceId ?? selectedPoint.id}</code>
              <footer>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={watchDisabled}
                  title={runtimeSession !== 'idle' ? msg("m0799") : t('analysis.heatmap.watch')}
                  onClick={() => void playAction.run(
                    () => runManagedPlaybackLaunch(() => commands.playDemo(demoId, selectedIntent.watch)),
                    msg("m0514"),
                  )}
                >
                  {playAction.state.status === 'loading' ? <Spinner /> : <Play size={13} />}
                  {t('analysis.heatmap.watch')}
                </Button>
                <Button size="sm" variant="secondary" disabled={!selectedIntent.round} onClick={() => selectedIntent.round && onNavigate(selectedIntent.round)}>
                  <ListFilter size={13} />{t('analysis.heatmap.openRound')}
                </Button>
                <Button size="sm" disabled={!selectedIntent.replay} onClick={() => selectedIntent.replay && onNavigate(selectedIntent.replay)}>
                  <MapIcon size={13} />{t('analysis.heatmap.openReplay')}
                </Button>
              </footer>
              {playAction.state.status === 'error' ? <Notice tone="danger">{playAction.state.message}</Notice> : null}
            </>
          ) : <p>{t('analysis.heatmap.selectEvidence')}</p>}
        </Card>
        <Card>
          <span className="eyebrow">API EVIDENCE</span><h2>{msg("m1053")}</h2>
          <div className="ranked-list">{summary.kinds.slice(0, 4).map(({ kind, count }, index) => <div key={kind}><span>{index + 1}</span><strong>{kind || msg("m0752")}</strong><small>{count} {msg("m0944")}</small></div>)}</div>
        </Card>
        <Notice tone="info" title={msg("m0683")}>{msg("m0576")} {filtered.length} / {points.length} {msg("m0162")} {summary.floorCount} {msg("m0156")}{radarTransform ? msg("m0404") : msg("m1089")}</Notice>
      </div>
    </div>
  );
}

function HighlightsView({ highlights, workspace, addedId, onAdd, onAddMany, onPreview }: { highlights: Highlight[]; workspace: AnalysisWorkspace; addedId: string | null; onAdd: (highlight: Highlight) => void; onAddMany: (highlights: Highlight[]) => void; onPreview: (highlight: Highlight) => void }) {
  const [sideFilter, setSideFilter] = useState<'all' | 'A' | 'B'>('all');
  const [kindFilter, setKindFilter] = useState<Highlight['kind'] | 'all'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const kinds = [...new Set(highlights.map((highlight) => highlight.kind))];
  const filtered = highlights.filter((highlight) => {
    const player = workspace.players.find((item) => item.id === highlight.player_id);
    return (sideFilter === 'all' || player?.team === sideFilter)
      && (kindFilter === 'all' || highlight.kind === kindFilter);
  });
  const selectedHighlights = highlights.filter((highlight) => selectedIds.has(highlight.id));
  const collections = new Map<string, Highlight[]>();
  highlights.forEach((highlight) => highlight.tags.filter((tag) => tag.startsWith('collection:')).forEach((tag) => collections.set(tag, [...(collections.get(tag) ?? []), highlight])));
  const collectionLabel = (tag: string, items: Highlight[]) => {
    const [, kind, playerId, opponentId] = tag.split(':');
    const playerName = workspace.players.find((item) => item.id === playerId)?.name ?? playerId ?? msg("m0764");
    const opponentName = workspace.players.find((item) => item.id === opponentId)?.name ?? opponentId;
    return kind === 'kill_reel' ? msgf("m0092", [playerName, items.length]) : kind === 'death_reel' ? msgf("m0093", [playerName, items.length]) : msgf("m0104", [playerName, opponentName ?? msg("m1356"), items.length]);
  };
  const allFilteredSelected = filtered.length > 0 && filtered.every((highlight) => selectedIds.has(highlight.id));
  const toggleHighlight = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleFiltered = () => setSelectedIds((current) => {
    const next = new Set(current);
    filtered.forEach((highlight) => {
      if (allFilteredSelected) next.delete(highlight.id);
      else next.add(highlight.id);
    });
    return next;
  });
  const kindLabel: Record<Highlight['kind'], string> = {
    multi_kill: msg("m1213"),
    clutch: msg("m0879"),
    one_tap: msg("m0131"),
    wallbang: msg("m1055"),
    no_scope: msg("m1021"),
    knife: msg("m0255"),
    taser: msg("m0996"),
    defuse: msg("m0653"),
    fail: msg("m0426"),
    timeline: msg("m0718"),
  };
  return (
    <div className="highlights-view">
      <div className="highlights-header"><div><span className="eyebrow">PARSED MOMENTS</span><h2>{msg("m0268")}</h2><p>{msg("m0349")}</p></div><div className="compilation-actions"><Button size="sm" disabled={filtered.length === 0} onClick={toggleFiltered}>{allFilteredSelected ? msg("m0326") : msg("m1232")}</Button><Button size="sm" variant="primary" disabled={selectedHighlights.length === 0} onClick={() => { onAddMany(selectedHighlights); setSelectedIds(new Set()); }}><Plus size={13} />{msg("m0300")} {selectedHighlights.length}</Button><Link className="button button--secondary button--sm" to="/queue">{msg("m0641")}<ArrowLeftRight size={13} /></Link></div></div>
      <Card>
        <div className="field-row">
          <label><span>{msg("m1283")}</span><select value={sideFilter} onChange={(event) => setSideFilter(event.target.value as typeof sideFilter)}><option value="all">{msg("m0235")}</option><option value="A">TEAM A</option><option value="B">TEAM B</option></select></label>
          <label><span>{msg("m0274")}</span><select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)}><option value="all">{msg("m0230")}</option>{kinds.map((kind) => <option key={kind} value={kind}>{kindLabel[kind]}</option>)}</select></label>
          {collections.size > 0 ? <label><span>{msg("m1167")}</span><select defaultValue="" onChange={(event) => { const items = collections.get(event.target.value) ?? []; setSelectedIds(new Set(items.map((item) => item.id))); event.target.value = ''; }}><option value="" disabled>{msg("m1230")}</option>{[...collections.entries()].map(([tag, items]) => <option key={tag} value={tag}>{collectionLabel(tag, items)}</option>)}</select></label> : null}
        </div>
      </Card>
      {addedId === 'compilation-batch' ? <Notice tone="success">{msg("m0517")}</Notice> : null}
      {filtered.length > 0 ? <div className="highlight-list">
        {filtered.map((highlight, index) => {
          const player = workspace.players.find((candidate) => candidate.id === highlight.player_id);
          return <Card className={`highlight-card${selectedIds.has(highlight.id) ? ' is-selected' : ''}`} key={highlight.id}><label className={`highlight-card__rank rank-${index + 1}`}><input type="checkbox" checked={selectedIds.has(highlight.id)} onChange={() => toggleHighlight(highlight.id)} aria-label={msgf("m1226", [highlight.label])} /><span>{String(index + 1).padStart(2, '0')}</span></label><div className="highlight-card__preview"><div className="mini-crosshair"><span /><span /></div><Badge tone="accent">{highlight.round > 0 ? `R${highlight.round}` : msg("m0225")}</Badge><span>{workspace.tick_rate > 0 ? `${((highlight.end_tick - highlight.start_tick) / workspace.tick_rate).toFixed(1)}s` : '—'}</span></div><div className="highlight-card__main"><div><Badge tone={highlight.kind === 'fail' ? 'danger' : highlight.category === 'clutch' ? 'warning' : 'blue'}>{kindLabel[highlight.kind]}</Badge><span>{player?.name ?? highlight.player_id}{player ? ` · TEAM ${player.team}` : ''}</span></div><h3>{highlight.label}</h3><p>{highlight.description || msgf("m0256", [highlight.confidence.toFixed(2)])} · tick {highlight.start_tick.toLocaleString(currentLocale())}–{highlight.end_tick.toLocaleString(currentLocale())}</p>{highlight.tags.length > 0 ? <small>{highlight.tags.join(' · ')}</small> : null}</div><div className="highlight-card__actions"><Button size="sm" onClick={() => onPreview(highlight)}><Play size={13} />{msg("m0637")}</Button><Button size="sm" variant="primary" onClick={() => onAdd(highlight)}>{addedId === highlight.id ? <Check size={14} /> : <Plus size={14} />}{addedId === highlight.id ? msg("m0502") : msg("m0303")}</Button></div></Card>;
        })}
      </div> : <Card><EmptyState icon={<Sparkles size={22} />} title={msg("m0894")} description={msg("m0258")} /></Card>}
    </div>
  );
}

const cosmeticFieldLabels: Record<CosmeticFieldName, string> = {
  paint_kit: msg("m0917"),
  seed: msg("m0837"),
  wear: msg("m1036"),
  stat_trak: 'StatTrak',
};

function CosmeticPreviewImage({ source }: { source: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!source || failed) return <Swords size={20} />;
  return <img loading="lazy" src={source} alt="" onError={() => setFailed(true)} />;
}

function CosmeticsView({
  demoId,
  players,
  source,
}: {
  demoId: string;
  players: PlayerAnalysis[];
  source: 'loading' | 'service' | 'error';
}) {
  const [reload, setReload] = useState(0);
  const [inspection, setInspection] = useState<CosmeticInspectionReport | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<CosmeticDrafts>({});
  const [confirmed, setConfirmed] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CosmeticCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [plans, setPlans] = useState<CosmeticPlan[]>([]);
  const [planName, setPlanName] = useState('');
  const [planBusy, setPlanBusy] = useState(false);
  const [planNotice, setPlanNotice] = useState<{ tone: 'danger' | 'success'; message: string } | null>(null);
  const rewriteAction = useAsyncAction<CosmeticRewriteResponse>();
  const catalogItems = useMemo(
    () => new Map(catalog?.items.map((item) => [item.item_definition_index, item]) ?? []),
    [catalog],
  );
  const catalogPaints = useMemo(
    () => new Map(catalog?.paint_kits.map((paint) => [paint.id, paint]) ?? []),
    [catalog],
  );

  useEffect(() => {
    if (source !== 'service') {
      setInspection(null);
      setDrafts({});
      setCatalog(null);
      setPlans([]);
      setLoadState('idle');
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setLoadState('loading');
    setLoadError(null);
    void Promise.all([
      commands.inspectCosmetics(demoId, controller.signal),
      commands.getCosmeticCatalog(controller.signal)
        .then((value) => ({ value, error: null }))
        .catch((cause: unknown) => ({ value: null, error: readableError(cause) })),
      commands.listCosmeticPlans(demoId, controller.signal)
        .then((value) => ({ value, error: null }))
        .catch((cause: unknown) => ({ value: [], error: readableError(cause) })),
    ])
      .then(([report, catalogResult, plansResult]) => {
        if (!active) return;
        setInspection(report);
        setDrafts(initialCosmeticDrafts(report.items));
        setCatalog(catalogResult.value);
        setCatalogError(catalogResult.error);
        setPlans(plansResult.value);
        setPlanNotice(plansResult.error ? { tone: 'danger', message: msgf("m1151", [plansResult.error]) } : null);
        setConfirmed(false);
        setDraftError(null);
        rewriteAction.reset();
        setLoadState('ready');
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setLoadError(readableError(cause));
        setLoadState('error');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [demoId, reload, rewriteAction.reset, source]);

  if (source !== 'service') {
    return <Card><EmptyState icon={<Shirt size={24} />} title={msg("m1291")} description={msg("m1320")} /></Card>;
  }
  if (loadState === 'loading') {
    return <Card><EmptyState icon={<Spinner />} title={msg("m0856")} description={msg("m0852")} /></Card>;
  }
  if (loadState === 'error') {
    return <Card><EmptyState icon={<Shirt size={24} />} title={msg("m1318")} description={loadError ?? msg("m0791")} action={<Button size="sm" onClick={() => setReload((value) => value + 1)}>{msg("m1268")}</Button>} /></Card>;
  }
  if (!inspection || inspection.items.length === 0) {
    return <Card><EmptyState icon={<Shirt size={24} />} title={msg("m0898")} description={msg("m1107")} /></Card>;
  }

  const build = buildCosmeticRewriteRequest(inspection.items, drafts);
  const updateDraft = (item: CosmeticInspectionItem, field: CosmeticFieldName, value: string) => {
    const key = cosmeticItemKey(item);
    setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? initialCosmeticDrafts([item])[key]!), [field]: value },
    }));
    setConfirmed(false);
    setDraftError(null);
    rewriteAction.reset();
  };
  const applyRewrite = async () => {
    if (!build.request) {
      setDraftError(build.error);
      return;
    }
    if (!confirmed) {
      setDraftError(msg("m1133"));
      return;
    }
    if (!window.confirm(msgf("m0463", [build.request.patches.length, build.changedFields]))) return;
    setDraftError(null);
    await rewriteAction.run(
      () => commands.rewriteCosmetics(demoId, build.request!),
      msg("m1262"),
    );
    setConfirmed(false);
  };
  const savePlan = async () => {
    if (!build.request) {
      setDraftError(build.error);
      return;
    }
    if (!planName.trim()) {
      setPlanNotice({ tone: 'danger', message: msg("m1147") });
      return;
    }
    setPlanBusy(true);
    setPlanNotice(null);
    try {
      const plan = await commands.createCosmeticPlan(demoId, {
        name: planName.trim(),
        patches: build.request.patches,
      });
      setPlans((current) => [plan, ...current]);
      setPlanName('');
      setPlanNotice({ tone: 'success', message: msgf("m0490", [plan.name]) });
    } catch (cause: unknown) {
      setPlanNotice({ tone: 'danger', message: readableError(cause) });
    } finally {
      setPlanBusy(false);
    }
  };
  const loadPlan = (plan: CosmeticPlan) => {
    const nextDrafts = cosmeticDraftsFromPatches(inspection.items, plan.patches);
    const applicable = buildCosmeticRewriteRequest(inspection.items, nextDrafts);
    setDrafts(nextDrafts);
    setConfirmed(false);
    setDraftError(null);
    rewriteAction.reset();
    setPlanNotice({
      tone: 'success',
      message: applicable.request
        ? msgf("m0540", [plan.name])
        : msgf("m0541", [plan.name]),
    });
  };
  const deletePlan = async (plan: CosmeticPlan) => {
    if (!window.confirm(msgf("m0290", [plan.name]))) return;
    setPlanBusy(true);
    setPlanNotice(null);
    try {
      await commands.deleteCosmeticPlan(demoId, plan.id);
      setPlans((current) => current.filter((candidate) => candidate.id !== plan.id));
      setPlanNotice({ tone: 'success', message: msgf("m0501", [plan.name]) });
    } catch (cause: unknown) {
      setPlanNotice({ tone: 'danger', message: readableError(cause) });
    } finally {
      setPlanBusy(false);
    }
  };

  return (
    <div className="cosmetics-view">
      <Card>
        <div className="card-heading">
          <div><span className="eyebrow">DEMO INVENTORY</span><h2>{msg("m0038")}</h2><p>{msg("m0184")}</p></div>
          <Badge tone="blue"><Shield size={12} />{inspection.items.length} {msg("m0161")}</Badge>
        </div>
        <div className="cosmetics-evidence">
          <span>{msg("m0444")} <strong>{inspection.entity_updates.toLocaleString(currentLocale())}</strong></span>
          <span>{msg("m0148")} <strong>{inspection.distinct_entities.toLocaleString(currentLocale())}</strong></span>
          <span>{msg("m0036")} <strong>{inspection.demo_messages.toLocaleString(currentLocale())}</strong></span>
          <span>{msg("m1182")} <strong>{(inspection.input_bytes / 1024 / 1024).toFixed(1)} MB</strong></span>
        </div>
      </Card>

      <Card className="cosmetic-plan-card">
        <div className="card-heading">
          <div><span className="eyebrow">LOCAL CATALOG & PLANS</span><h2>{msg("m0805")}</h2><p>{msg("m0360")}</p></div>
          {catalog ? <Badge tone="blue">{catalog.items.length.toLocaleString(currentLocale())} {msg("m0972")} {catalog.paint_kits.length.toLocaleString(currentLocale())} {msg("m0916")}</Badge> : null}
        </div>
        {catalogError ? <Notice tone="warning">{msg("m1319")}{catalogError}{msg("m0128")}</Notice> : null}
        <div className="cosmetic-plan-controls">
          <label><span className="visually-hidden">{msg("m0701")}</span><input className="text-input" value={planName} maxLength={80} placeholder={msg("m0701")} onChange={(event) => setPlanName(event.target.value)} /></label>
          <Button size="sm" disabled={planBusy || !build.request} onClick={() => void savePlan()}>{msg("m0213")}</Button>
        </div>
        {plans.length > 0 ? <div className="cosmetic-plan-list">{plans.map((plan) => <div key={plan.id}><button type="button" disabled={planBusy} onClick={() => loadPlan(plan)}><strong>{plan.name}</strong><small>{plan.patches.length} {msg("m0160")} {new Date(plan.updated_at).toLocaleString(currentLocale())}</small></button><Button size="sm" variant="ghost" disabled={planBusy} onClick={() => void deletePlan(plan)}>{msg("m0284")}</Button></div>)}</div> : <small>{msg("m1198")}</small>}
        {planNotice ? <Notice tone={planNotice.tone}>{planNotice.message}</Notice> : null}
      </Card>

      <div className="cosmetic-editor-grid">
        {inspection.items.map((item) => {
          const key = cosmeticItemKey(item);
          const draft = drafts[key] ?? initialCosmeticDrafts([item])[key]!;
          const player = players.find((candidate) => candidate.id === item.owner.steam_id64);
          const catalogItem = catalogItems.get(item.item_definition_index);
          const compatiblePaints = (catalogItem?.paint_kit_ids ?? [])
            .map((id) => catalogPaints.get(id))
            .filter((paint): paint is NonNullable<typeof paint> => paint !== undefined);
          const selectedPaint = Number(draft.paint_kit);
          const hasSelectedImage = Number.isSafeInteger(selectedPaint)
            && (selectedPaint === 0 ? catalogItem?.base_image_available : catalogItem?.paint_kit_ids.includes(selectedPaint));
          return (
            <Card className="cosmetic-editor-card" key={key}>
              <div className="cosmetic-editor-card__heading">
                <span className="cosmetic-item-icon"><CosmeticPreviewImage key={hasSelectedImage ? selectedPaint : 'none'} source={hasSelectedImage ? commands.cosmeticImageUrl(item.item_definition_index, selectedPaint) : null} /></span>
                <div><strong>{catalogItem?.display_name ?? msgf("m0973", [item.item_definition_index])}</strong><small>#{item.item_definition_index} · {player?.name ?? `Steam ${item.owner.steam_id64}`} · {item.entity_handles.length} {msg("m0155")}</small></div>
                <Badge tone={item.match_basis === 'both' ? 'blue' : 'warning'}>{item.match_basis === 'both' ? msg("m0320") : msg("m1158")}</Badge>
              </div>
              <div className="cosmetic-fields">
                {(['paint_kit', 'seed', 'wear', 'stat_trak'] as const).map((field) => {
                  const editable = cosmeticFieldEditable(item, field);
                  const conflicting = item.conflicting_fields.includes(field);
                  return <label key={field}><span>{cosmeticFieldLabels[field]}{conflicting ? <Badge tone="warning">{msg("m0423")}</Badge> : null}</span>{field === 'paint_kit' && compatiblePaints.length > 0 ? <select className="text-input" value={draft.paint_kit} disabled={!editable} onChange={(event) => updateDraft(item, field, event.target.value)}><option value="">{msg("m0767")}</option>{item.paint_kit === 0 || catalogItem?.base_image_available ? <option value="0">{msg("m1330")}</option> : null}{draft.paint_kit && !catalogPaints.has(Number(draft.paint_kit)) ? <option value={draft.paint_kit}>{msg("m0561")} {draft.paint_kit}</option> : null}{compatiblePaints.map((paint) => <option key={paint.id} value={paint.id}>{paint.display_name} · #{paint.id}</option>)}</select> : <input className="text-input" type="number" min="0" max={field === 'wear' ? '1' : field === 'seed' ? '1000' : '4294967295'} step={field === 'wear' ? '0.000001' : '1'} value={draft[field]} placeholder={conflicting ? msg("m1184") : editable ? msg("m0767") : msg("m0145")} disabled={!editable} onChange={(event) => updateDraft(item, field, event.target.value)} />}</label>;
                })}
              </div>
              <small className="cosmetic-class-evidence">{item.class_names.join(' · ')}</small>
              {item.incompatible_fields.length > 0 ? <Notice tone="warning">{msg("m1201")}{item.incompatible_fields.map((field) => cosmeticFieldLabels[field]).join('、')}</Notice> : null}
            </Card>
          );
        })}
      </div>

      <Card className="cosmetic-confirmation">
        <div><Shield size={20} /><span><strong>{msg("m0441")}</strong><small>{msg("m1188")}</small></span></div>
        <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); setDraftError(null); }} />{msg("m0630")}</label>
        {draftError ? <Notice tone="danger">{draftError}</Notice> : null}
        {rewriteAction.state.message ? <Notice tone={rewriteAction.state.status === 'error' ? 'danger' : 'success'}>{rewriteAction.state.message}</Notice> : null}
        {rewriteAction.state.status === 'success' ? <Link className="button button--secondary button--sm" to={`/analysis?demo=${encodeURIComponent(rewriteAction.state.data.demo.id)}`}>{msg("m0639")}</Link> : null}
        <Button variant="primary" disabled={!confirmed || !build.request || rewriteAction.state.status === 'loading'} onClick={() => void applyRewrite()}>{rewriteAction.state.status === 'loading' ? <Spinner /> : <Shield size={13} />}{msg("m0988")}{build.request ? msgf("m1331", [build.changedFields]) : ''}</Button>
      </Card>
    </div>
  );
}
