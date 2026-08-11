import { currentLocale, msg, msgf } from '../../shared/i18n';
import {
  Activity,
  ArrowLeft,
  ArrowLeftRight,
  Award,
  Bot,
  Calendar,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  Crosshair,
  Flame,
  Grid3X3,
  ListFilter,
  Map as MapIcon,
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
  Users,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api, apiMediaUrl, normalizeSide, readableError } from '../../shared/api/client';
import type {
  AnalysisWorkspace,
  CosmeticCatalog,
  CosmeticFieldName,
  CosmeticInspectionItem,
  CosmeticInspectionReport,
  CosmeticPlan,
  CosmeticRewriteResponse,
  HeatPointRecord,
  Highlight,
  PlayerAnalysis,
  RadarOverviewRecord,
  ReplayCacheMetadata,
  ReplayFrameRecord,
  TimelineEvent,
} from '../../shared/api/dto';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import { worldPointsToRadarPercent } from '../../shared/radar';
import { runManagedPlaybackLaunch, useRuntimeStore } from '../../shared/stores/runtimeStore';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Spinner } from '../../shared/ui';
import { useQueueStore, type QueueItem } from '../queue/queueStore';
import {
  buildCosmeticRewriteRequest,
  cosmeticDraftsFromPatches,
  cosmeticFieldEditable,
  cosmeticItemKey,
  initialCosmeticDrafts,
  type CosmeticDrafts,
} from './cosmetics';
import {
  matchupsForPlayer,
  normalizeAnalysisInsights,
  orderHighlightsForCompilation,
  teamPurchaseForSide,
} from './analysisInsights';
import { AiReviewPanel, type ReviewConfiguration } from './AiReviewPanel';
import { analysisBatchIds, runBatchAnalysis, type BatchAnalysisState } from './analysisBatch';
import { replayCacheLabel, replayEffectPresentation } from './replayPresentation';
import { decodeReplayBinary } from './replayBinary';

type AnalysisTab = 'overview' | 'players' | 'insights' | 'review' | 'rounds' | 'replay' | 'heatmap' | 'highlights' | 'cosmetics';

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

const tabs: Array<{ id: AnalysisTab; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: msg("m0618"), icon: Activity },
  { id: 'players', label: msg("m0978"), icon: Users },
  { id: 'insights', label: msg("m0919"), icon: Zap },
  { id: 'review', label: msg("m0023"), icon: Bot },
  { id: 'rounds', label: msg("m0371"), icon: ListFilter },
  { id: 'replay', label: msg("m0016"), icon: MapIcon },
  { id: 'heatmap', label: msg("m0946"), icon: Flame },
  { id: 'highlights', label: msg("m1070"), icon: Sparkles },
  { id: 'cosmetics', label: msg("m1317"), icon: Shirt },
];

const playerInitials = (name: string) => name.slice(0, 2).toUpperCase();
const formatRating = (rating: number) => rating.toFixed(2);

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
  const tabLabels: Record<AnalysisTab, string> = {
    overview: t('analysis.tab.overview'),
    players: t('analysis.tab.players'),
    insights: t('analysis.tab.insights'),
    review: t('analysis.tab.review'),
    rounds: t('analysis.tab.rounds'),
    replay: t('analysis.tab.replay'),
    heatmap: t('analysis.tab.heatmap'),
    highlights: t('analysis.tab.highlights'),
    cosmetics: t('analysis.tab.cosmetics'),
  };
  const [params, setParams] = useSearchParams();
  const demoId = params.get('demo') ?? '';
  const encodedBatch = params.get('demos');
  const batchIds = useMemo(() => demoId ? analysisBatchIds(demoId, encodedBatch) : [], [demoId, encodedBatch]);
  const batchKey = batchIds.join(',');
  const [batchStates, setBatchStates] = useState<Record<string, BatchAnalysisState>>({});
  const [workspace, setWorkspace] = useState<AnalysisWorkspace>(() => emptyWorkspace(demoId));
  const [source, setSource] = useState<'loading' | 'service' | 'error'>(demoId ? 'loading' : 'error');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<AnalysisTab>('overview');
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [addedHighlight, setAddedHighlight] = useState<string | null>(null);
  const [recordingDefaults, setRecordingDefaults] = useState({
    pre_roll_seconds: 3,
    post_roll_seconds: 2.5,
    show_keyboard: false,
  });
  const [reviewConfiguration, setReviewConfiguration] = useState<ReviewConfiguration>({
    status: 'loading',
    configured: false,
    provider: '',
    model: '',
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void api.getConfig(controller.signal)
      .then((config) => {
        if (!active) return;
        setRecordingDefaults({
          pre_roll_seconds: config.recording.pre_roll_seconds,
          post_roll_seconds: config.recording.post_roll_seconds,
          show_keyboard: config.recording.show_keyboard,
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
    void api.analyzeDemo(demoId, controller.signal)
      .then((response) => {
        if (!active) return;
        setWorkspace(response);
        setSelectedPlayerId(response.players[0]?.id ?? '');
        setSource('service');
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setWorkspace(emptyWorkspace(demoId));
        setSource('error');
        setError(readableError(cause));
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
      (id) => api.analyzeDemo(id, controller.signal),
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
      setSelectedPlayerId(state.workspace.players[0]?.id ?? '');
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

  const selectedPlayer = workspace.players.find((player) => player.id === selectedPlayerId) ?? workspace.players[0] ?? null;
  const teamA = workspace.players.filter((player) => player.team === 'A');
  const teamB = workspace.players.filter((player) => player.team === 'B');
  const finalRound = workspace.rounds.at(-1);
  const scoreA = finalRound?.team_a_score ?? workspace.teams.find((team) => team.side.toLocaleUpperCase() === 'A')?.score;
  const scoreB = finalRound?.team_b_score ?? workspace.teams.find((team) => team.side.toLocaleUpperCase() === 'B')?.score;
  const addQueueItem = useQueueStore((state) => state.add);
  const addQueueItems = useQueueStore((state) => state.addMany);
  const batchReady = Object.values(batchStates).filter((state) => state.status === 'ready').length;
  const batchFailed = Object.values(batchStates).filter((state) => state.status === 'error').length;

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
    playbackSpeed: 1,
    perspective: 'pov',
    showKeyboard: recordingDefaults.show_keyboard,
    showKillFx: true,
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

  return (
    <div className="page page--analysis">
      <PageHeader
        eyebrow="MATCH INTELLIGENCE"
        title={t('analysis.title')}
        description={t('analysis.description')}
        actions={
          <>
            <Link className="button button--secondary button--md" to="/library"><ArrowLeft size={14} />{t('analysis.backLibrary')}</Link>
            <Link className="button button--secondary button--md" to="/players"><Users size={14} />{t('analysis.playerDirectory')}</Link>
            <div className="analysis-demo-select">
            <span>{msg("m0578")}</span>
            {batchIds.length > 1 ? (
              <label>
                <select value={demoId} onChange={(event) => setParams({ demo: event.target.value, demos: batchKey })} aria-label={msg("m0280")}>
                  {batchIds.map((id, index) => {
                    const state = batchStates[id];
                    const label = state?.status === 'ready' ? state.workspace.map_name.replace('de_', '').toUpperCase() : msgf("m0887", [index + 1]);
                    const status = state?.status === 'ready' ? msg("m0510") : state?.status === 'error' ? msg("m0425") : state?.status === 'loading' ? msg("m0263") : msg("m1062");
                    return <option value={id} key={id}>{label} · {status}</option>;
                  })}
                </select>
                <ChevronDown size={14} />
              </label>
            ) : (
              <button type="button" disabled title={msg("m1129")}>
                <strong>{workspace.map_name ? workspace.map_name.replace('de_', '').toUpperCase() : msg("m1063")}</strong>
                <ChevronDown size={14} />
              </button>
            )}
            </div>
          </>
        }
      />

      {batchIds.length > 1 ? <Notice tone={batchFailed > 0 ? 'warning' : batchReady === batchIds.length ? 'success' : 'info'} title={msg("m0645")}>{msg("m0510")} {batchReady} / {batchIds.length}{batchFailed > 0 ? msgf("m0003", [batchFailed]) : msg("m0007")}</Notice> : null}

      {source !== 'service' ? (
        <Notice tone={source === 'loading' ? 'info' : 'danger'} title={source === 'loading' ? msg("m0865") : msg("m0262")}>
          {source === 'loading' ? <><Spinner />{msg("m0874")}</> : error ?? msg("m0795")}
        </Notice>
      ) : null}

      <div className="analysis-layout">
        <aside className="player-rail">
          <div className="player-rail__header">
            <span>PLAYERS</span>
            <Badge tone="neutral">{workspace.players.length}</Badge>
          </div>
          <PlayerTeam label="TEAM A" tone="blue" players={teamA} selectedId={selectedPlayer?.id ?? ''} onSelect={setSelectedPlayerId} />
          <PlayerTeam label="TEAM B" tone="warning" players={teamB} selectedId={selectedPlayer?.id ?? ''} onSelect={setSelectedPlayerId} />
          <div className="player-rail__footer">
            <span>{msg("m0551")}</span>
            <strong>{workspace.players.length > 0 ? (workspace.players.reduce((sum, player) => sum + player.rating, 0) / workspace.players.length).toFixed(2) : '—'}</strong>
          </div>
        </aside>

        <section className="analysis-workspace">
          <header className="analysis-summary-bar">
            <div className="analysis-match-score">
              <div><span>TEAM A</span><strong>{scoreA ?? '—'}</strong></div>
              <div className="analysis-map-name"><MapIcon size={14} /><strong>{workspace.map_name ? workspace.map_name.replace('de_', '').toUpperCase() : '—'}</strong><span>{workspace.rounds.length > 0 ? msg("m0494") : msg("m0705")}</span></div>
              <div><strong>{scoreB ?? '—'}</strong><span>TEAM B</span></div>
            </div>
            <div className="analysis-match-meta">
              <span><Calendar size={13} />—</span>
              <span><Clock3 size={13} />{formatClock(workspace.duration_seconds)}</span>
              <span><Radio size={13} />{workspace.tick_rate > 0 ? `${workspace.tick_rate} tick` : '—'}</span>
            </div>
          </header>

          <nav className="analysis-tabs" aria-label={msg("m0270")}>
            {tabs.map(({ id, icon: Icon }) => (
              <button
                type="button"
                key={id}
                className={tab === id ? 'is-active' : undefined}
                aria-current={tab === id ? 'page' : undefined}
                onClick={() => setTab(id)}
              >
                <Icon size={14} />{tabLabels[id]}
                {id === 'highlights' ? <Badge tone="accent">{workspace.highlights.length}</Badge> : null}
              </button>
            ))}
          </nav>

          <div className="analysis-view">
            {tab === 'overview' ? <Overview workspace={workspace} player={selectedPlayer} /> : null}
            {tab === 'players' ? <PlayersTable players={workspace.players} selectedId={selectedPlayer?.id ?? ''} onSelect={setSelectedPlayerId} /> : null}
            {tab === 'insights' ? <InsightsView workspace={workspace} selectedPlayer={selectedPlayer} /> : null}
            {tab === 'review' ? <AiReviewPanel key={demoId} demoId={demoId} workspace={workspace} selectedPlayer={selectedPlayer} source={source} configuration={reviewConfiguration} /> : null}
            {tab === 'rounds' ? <RoundsView workspace={workspace} demoId={demoId} playable={source === 'service'} selectedPlayer={selectedPlayer} addedId={addedHighlight} onCompile={addCompilation} /> : null}
            {tab === 'replay' ? <ReplayView demoId={demoId} workspace={workspace} source={source} /> : null}
            {tab === 'heatmap' ? <HeatmapView demoId={demoId} mapName={workspace.map_name} player={selectedPlayer} source={source} /> : null}
            {tab === 'highlights' ? (
              <HighlightsView
                highlights={workspace.highlights}
                workspace={workspace}
                addedId={addedHighlight}
                onAdd={addHighlight}
                onAddMany={addHighlightCompilation}
                onPreview={() => setTab('replay')}
              />
            ) : null}
            {tab === 'cosmetics' ? <CosmeticsView demoId={demoId} players={workspace.players} source={source} /> : null}
          </div>
        </section>
      </div>
    </div>
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
      {players.map((player) => (
        <button
          type="button"
          key={player.id}
          className={selectedId === player.id ? 'is-active' : undefined}
          onClick={() => onSelect(player.id)}
        >
          <span className={`player-avatar player-avatar--${player.team.toLocaleLowerCase()}`}>{playerInitials(player.name)}</span>
          <span className="player-team__name"><strong>{player.name}</strong><small>{player.kills} / {player.deaths} / {player.assists}</small></span>
          <span className={`rating rating--${player.rating >= 1.1 ? 'high' : player.rating < 0.9 ? 'low' : 'mid'}`}>{formatRating(player.rating)}</span>
        </button>
      ))}
    </div>
  );
}

function Overview({ workspace, player }: { workspace: AnalysisWorkspace; player: PlayerAnalysis | null }) {
  if (!player) return <Card><EmptyState icon={<Users size={22} />} title={msg("m0904")} description={msg("m0259")} /></Card>;
  const roundWinsA = workspace.rounds.filter((round) => round.winner === 'A').length;
  const roundWinsB = workspace.rounds.length - roundWinsA;
  const topHighlight = workspace.highlights[0];
  return (
    <div className="overview-view">
      <section className="metric-grid">
        <Card className="metric-card metric-card--featured">
          <div className="metric-card__icon"><Award size={18} /></div>
          <span>PLAYER RATING</span><strong>{formatRating(player.rating)}</strong>
          <small>{msg("m0267")}</small>
        </Card>
        <Card className="metric-card"><div className="metric-card__icon"><Crosshair size={18} /></div><span>K / D / A</span><strong>{player.kills}<i>/</i>{player.deaths}<i>/</i>{player.assists}</strong><small>{(player.kills / Math.max(1, player.deaths)).toFixed(2)} K/D</small></Card>
        <Card className="metric-card"><div className="metric-card__icon"><Target size={18} /></div><span>ADR</span><strong>{player.adr.toFixed(1)}</strong><small>{msg("m0883")}</small></Card>
        <Card className="metric-card"><div className="metric-card__icon"><Zap size={18} /></div><span>HEADSHOT</span><strong>{Math.round(player.headshot_rate * 100)}%</strong><small>{Math.round(player.kills * player.headshot_rate)} {msg("m0842")}</small></Card>
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

        <Card className="impact-card">
          <div className="card-heading"><div><span className="eyebrow">IMPACT</span><h2>{msg("m0610")}</h2></div><CircleDot size={16} /></div>
          <EmptyState icon={<CircleDot size={22} />} title={msg("m0731")} description={msg("m0564")} />
        </Card>
      </div>

      {topHighlight ? <Card className="insight-callout"><div className="insight-callout__icon"><Sparkles size={18} /></div><div><span className="eyebrow">TOP PARSED HIGHLIGHT</span><strong>{topHighlight.label}</strong><p>{msg("m0367")} {topHighlight.round} {msg("m0122")} {topHighlight.confidence.toFixed(2)} · tick {topHighlight.start_tick}–{topHighlight.end_tick}</p></div></Card> : <Notice tone="info">{msg("m0266")}</Notice>}
    </div>
  );
}

function PlayersTable({ players, selectedId, onSelect }: { players: PlayerAnalysis[]; selectedId: string; onSelect: (id: string) => void }) {
  if (players.length === 0) return <Card><EmptyState icon={<Users size={22} />} title={msg("m0903")} description={msg("m0261")} /></Card>;
  return (
    <Card className="players-table-card">
      <div className="card-heading"><div><span className="eyebrow">SCOREBOARD</span><h2>{msg("m0982")}</h2></div><Badge tone="neutral">{msg("m0655")}</Badge></div>
      <div className="data-table players-table">
        <div className="data-table__head"><span>{msg("m0978")}</span><span>K</span><span>D</span><span>A</span><span>K/D</span><span>ADR</span><span>HS%</span><span>Rating</span></div>
        {[...players].sort((a, b) => b.rating - a.rating).map((player) => (
          <button type="button" key={player.id} className={selectedId === player.id ? 'is-selected' : undefined} onClick={() => onSelect(player.id)}>
            <span className="data-player"><span className={`player-avatar player-avatar--${player.team.toLocaleLowerCase()}`}>{playerInitials(player.name)}</span><span><strong>{player.name}</strong><small>TEAM {player.team}</small></span></span>
            <span>{player.kills}</span><span>{player.deaths}</span><span>{player.assists}</span>
            <span>{(player.kills / Math.max(1, player.deaths)).toFixed(2)}</span><span>{player.adr.toFixed(1)}</span><span>{Math.round(player.headshot_rate * 100)}%</span><span className="rating-cell">{player.rating.toFixed(2)}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function InsightsView({ workspace, selectedPlayer }: { workspace: AnalysisWorkspace; selectedPlayer: PlayerAnalysis | null }) {
  const insights = normalizeAnalysisInsights(workspace.insights);
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
              <div className="economy-round-table__head"><span>{msg("m0367")}</span><span>{msg("m0078")}</span><span>{msg("m0079")}</span></div>
              {insights.round_economy.map((round) => {
                const teamA = teamPurchaseForSide(round, 'A');
                const teamB = teamPurchaseForSide(round, 'B');
                const renderTeam = (team: typeof teamA) => team ? (
                  <span><strong>{team.purchase_count} {msg("m0811")}</strong><small>{team.items.length > 0 ? team.items.map((item) => `${item.name}×${item.count}`).join(' · ') : msg("m0704")} · {team.spend === null ? msg("m1272") : `$${team.spend.toLocaleString(currentLocale())}`}</small></span>
                ) : <span><strong>{msg("m0146")}</strong><small>{msg("m0170")}</small></span>;
                return <div key={round.round}><span>R{round.round}</span>{renderTeam(teamA)}{renderTeam(teamB)}</div>;
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

function eventEvidence(event: TimelineEvent): string {
  const participants = [event.actor, event.target].filter((value): value is string => Boolean(value));
  const weapon = event.weapon ? ` · ${event.weapon}` : '';
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

function eventMatchesFilter(event: TimelineEvent, filter: RoundEventFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'combat') return event.kind === 'kill' || event.kind === 'damage';
  if (filter === 'objectives') return event.kind.startsWith('bomb_');
  if (filter === 'utility') return event.kind === 'grenade';
  return event.kind === 'purchase';
}

function RoundsView({
  workspace,
  demoId,
  playable,
  selectedPlayer,
  addedId,
  onCompile,
}: {
  workspace: AnalysisWorkspace;
  demoId: string;
  playable: boolean;
  selectedPlayer: PlayerAnalysis | null;
  addedId: string | null;
  onCompile: (moment: CompilationMoment) => void;
}) {
  const [selectedRound, setSelectedRound] = useState(workspace.rounds[15]?.number ?? 1);
  const [winnerFilter, setWinnerFilter] = useState<'all' | 'A' | 'B'>('all');
  const [eventFilter, setEventFilter] = useState<RoundEventFilter>('all');
  const runtimeSession = useRuntimeStore((state) => state.session);
  const playAction = useAsyncAction<{ started: boolean; process_id: number }>();
  const visibleRounds = winnerFilter === 'all'
    ? workspace.rounds
    : workspace.rounds.filter((item) => item.winner === winnerFilter);
  const round = visibleRounds.find((item) => item.number === selectedRound) ?? visibleRounds[0];
  const visibleEvents = round?.events.filter((event) => eventMatchesFilter(event, eventFilter)) ?? [];
  return (
    <div className="rounds-view">
      <Card className="round-selector-card">
        <div className="card-heading">
          <div><span className="eyebrow">ROUND TIMELINE</span><h2>{msg("m0374")}</h2></div>
          <div className="mini-segmented" aria-label={msg("m0656")}>
            {(['all', 'A', 'B'] as const).map((side) => <button type="button" key={side} className={winnerFilter === side ? 'is-active' : undefined} onClick={() => setWinnerFilter(side)}>{side === 'all' ? msg("m0229") : `TEAM ${side}`}</button>)}
          </div>
        </div>
        <div className="round-grid">
          {visibleRounds.map((item) => (
            <button type="button" key={item.number} className={`${item.winner === 'A' ? 'team-a' : 'team-b'}${round?.number === item.number ? ' is-active' : ''}`} onClick={() => setSelectedRound(item.number)}>
              <span>{item.number}</span><small>{item.winner}</small>
            </button>
          ))}
        </div>
        {visibleRounds.length === 0 ? <EmptyState icon={<ListFilter size={20} />} title={msg("m0893")} description={msg("m0586")} /> : null}
      </Card>
      {round ? (
        <Card className="round-detail-card">
          <div className="round-detail-card__title">
            <div><span className={`team-token team-token--${round.winner.toLocaleLowerCase()}`}>TEAM {round.winner}</span><h2>{msg("m0367")} {round.number}</h2><p>{round.reason || msg("m0762")}</p></div>
            <div>
              <Button size="sm" disabled={!selectedPlayer} title={selectedPlayer ? msgf("m0194", [selectedPlayer.name]) : msg("m1136")} onClick={() => selectedPlayer && onCompile({ id: `round-${round.number}-${selectedPlayer.id}`, title: msgf("m0368", [round.number, round.reason || msg("m1350")]), playerId: selectedPlayer.id, startTick: round.start_tick, endTick: Math.max(round.start_tick + 1, round.end_tick), category: 'custom' })}>{addedId === `round-${round.number}-${selectedPlayer?.id}` ? <Check size={13} /> : <Plus size={13} />}{msg("m0301")}</Button>
              <Button size="sm" disabled={!playable || playAction.state.status === 'loading' || runtimeSession !== 'idle'} title={!playable ? msg("m1001") : runtimeSession !== 'idle' ? msg("m0799") : msg("m0390")} onClick={() => void playAction.run(() => runManagedPlaybackLaunch(() => api.playDemo(demoId, { start_tick: round.start_tick })), msg("m0514"))}>{playAction.state.status === 'loading' ? <Spinner /> : <Play size={13} />}{msg("m0676")}</Button>
            </div>
          </div>
          {playAction.state.message ? <Notice tone={playAction.state.status === 'error' ? 'danger' : 'success'}>{playAction.state.message}</Notice> : null}
          <div className="mini-segmented" aria-label={msg("m1066")}>
            {(['all', 'combat', 'objectives', 'utility', 'economy'] as const).map((filter) => <button type="button" key={filter} className={eventFilter === filter ? 'is-active' : undefined} onClick={() => setEventFilter(filter)}>{({ all: msg("m0229"), combat: msg("m0178"), objectives: msg("m1013"), utility: msg("m1250"), economy: msg("m1076") } as const)[filter]}</button>)}
          </div>
          {visibleEvents.length > 0 ? <div className="event-timeline">{visibleEvents.map((event) => {
            const canCompile = Boolean(event.actor) && !['round_start', 'round_end'].includes(event.kind);
            const compilationId = `event-${event.id}`;
            return <div key={event.id}><span className={`event-dot${event.kind === 'kill' || event.kind.startsWith('bomb_') ? ' is-highlight' : ''}`} /><time>{formatClock(event.seconds)}</time><div><strong>{eventKindLabel[event.kind]}</strong><p>{eventEvidence(event)}</p></div>{event.headshot ? <Badge tone="accent">{msg("m0949")}</Badge> : null}{canCompile ? <Button size="sm" onClick={() => onCompile({ id: compilationId, title: `${eventKindLabel[event.kind]} · ${eventEvidence(event)}`, playerId: event.actor!, startTick: Math.max(round.start_tick, event.tick - 128), endTick: Math.max(event.tick + 1, Math.min(round.end_tick, event.tick + 192)), category: event.kind === 'kill' ? 'entry' : event.kind === 'grenade' || event.kind.startsWith('bomb_') ? 'utility' : 'custom' })}>{addedId === compilationId ? <Check size={12} /> : <Plus size={12} />}{msg("m0299")}</Button> : null}</div>;
          })}</div> : <EmptyState icon={<ListFilter size={22} />} title={msg("m0892")} description={msg("m0774")} />}
        </Card>
      ) : null}
    </div>
  );
}

function normalizeCoordinates(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length === 0) return [];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = Math.max(1, maxX - minX);
  const rangeY = Math.max(1, maxY - minY);
  return points.map(([x, y]) => [10 + ((x - minX) / rangeX) * 80, 10 + ((y - minY) / rangeY) * 80]);
}

function useRadarOverview(mapName: string, enabled: boolean): RadarOverviewRecord | null {
  const [overview, setOverview] = useState<RadarOverviewRecord | null>(null);

  useEffect(() => {
    if (!enabled || mapName.trim().length === 0) {
      setOverview(null);
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    setOverview(null);
    void api.getRadarOverview(mapName, controller.signal)
      .then((response) => {
        if (active) setOverview(response);
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setOverview(null);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, mapName]);

  return overview;
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

function ReplayView({ demoId, workspace, source }: { demoId: string; workspace: AnalysisWorkspace; source: 'loading' | 'service' | 'error' }) {
  const [frames, setFrames] = useState<ReplayFrameRecord[]>([]);
  const [cache, setCache] = useState<ReplayCacheMetadata | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [speed, setSpeed] = useState<0.5 | 1 | 2>(1);
  const [sideFilter, setSideFilter] = useState<'all' | 'A' | 'B'>('all');
  const radar = useRadarOverview(workspace.map_name, source === 'service');

  useEffect(() => {
    if (source !== 'service') {
      setFrames([]);
      setCache(null);
      setState('idle');
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setState('loading');
    setError(null);
    void api.getReplayBinary(demoId, controller.signal).then(decodeReplayBinary).then((response) => {
      if (!active) return;
      setFrames(response.frames);
      setCache(response.cache);
      setFrameIndex(0);
      setState('ready');
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      setFrames([]);
      setCache(null);
      setState('error');
      setError(readableError(cause));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [demoId, source]);

  useEffect(() => {
    if (!playing || frames.length < 2) return undefined;
    const timer = window.setInterval(() => setFrameIndex((current) => current >= frames.length - 1 ? 0 : current + 1), 100 / speed);
    return () => window.clearInterval(timer);
  }, [frames.length, playing, speed]);

  if (state === 'loading') return <Card><EmptyState icon={<Spinner />} title={msg("m0863")} description={msg("m0743")} /></Card>;
  if (state === 'error') return <Card><EmptyState icon={<CircleDot size={22} />} title={msg("m0017")} description={error ?? msg("m0778")} /></Card>;
  if (frames.length === 0) return <Card><EmptyState icon={<MapIcon size={22} />} title={msg("m0899")} description={msg("m0487")} /></Card>;

  const currentFrame = frames[Math.min(frameIndex, frames.length - 1)] ?? frames[0]!;
  const radarTransform = radar?.transform ?? null;
  const visiblePlayers = sideFilter === 'all'
    ? currentFrame.players
    : currentFrame.players.filter((player) => normalizeSide(player.team) === sideFilter);
  const activeProjectiles = currentFrame.projectiles.filter((projectile) => projectile.active);
  const playerPoints: Array<[number, number]> = visiblePlayers.map((player) => [player.position[0], player.position[1]]);
  const projectilePoints: Array<[number, number]> = activeProjectiles.map((projectile) => [projectile.position[0], projectile.position[1]]);
  const bombPoints: Array<[number, number]> = currentFrame.bomb ? [[currentFrame.bomb.position[0], currentFrame.bomb.position[1]]] : [];
  const allPoints = [...playerPoints, ...projectilePoints, ...bombPoints];
  const allCoordinates = worldPointsToRadarPercent(allPoints, radarTransform) ?? normalizeCoordinates(allPoints);
  const coordinates = allCoordinates.slice(0, playerPoints.length);
  const projectileCoordinates = allCoordinates.slice(playerPoints.length, playerPoints.length + projectilePoints.length);
  const bombCoordinate = currentFrame.bomb ? allCoordinates.at(-1) ?? null : null;
  const radarImage = radarTransform && radar?.browser_displayable && radar.image_url ? apiMediaUrl(radar.image_url) : null;
  const startTick = frames[0]?.tick ?? currentFrame.tick;
  const endTick = frames.at(-1)?.tick ?? currentFrame.tick;
  const elapsed = workspace.tick_rate > 0 ? (currentFrame.tick - startTick) / workspace.tick_rate : 0;
  const total = workspace.tick_rate > 0 ? (endTick - startTick) / workspace.tick_rate : 0;

  return (
    <div className="replay-layout">
      <Card className="replay-map-card">
        <div className="replay-map-toolbar">
          <div>
            <Grid3X3 size={14} />
            <strong>{workspace.map_name ? workspace.map_name.replace('de_', '').toUpperCase() : 'MAP'}</strong>
            {radarTransform ? <Badge tone="neutral">{msg("m0397")}</Badge> : <Badge tone="neutral">{msg("m1023")}</Badge>}
            {cache ? <span title={cache.reason ?? msgf("m1082", [cache.version, cache.bytes.toLocaleString(currentLocale())])}><Badge tone={cache.state === 'hit' ? 'success' : cache.state === 'bypassed' ? 'warning' : 'neutral'}>{replayCacheLabel(cache)}</Badge></span> : null}
          </div>
          <div className="mini-segmented" aria-label={msg("m0658")}>
            {(['all', 'A', 'B'] as const).map((side) => <button type="button" key={side} className={sideFilter === side ? 'is-active' : undefined} onClick={() => setSideFilter(side)}>{side === 'all' ? msg("m0229") : `TEAM ${side}`}</button>)}
          </div>
        </div>
        <div className={`replay-map${radarImage ? ' has-radar-image' : ''}`}>
          {radarImage ? <img className="radar-map-image" src={radarImage} alt={msgf("m0111", [workspace.map_name])} /> : (
            <>
              <div className="replay-map__site replay-map__site--a">A</div>
              <div className="replay-map__site replay-map__site--b">B</div>
              <div className="replay-map__paths"><span /><span /><span /><span /><span /></div>
            </>
          )}
          {visiblePlayers.map((player, index) => {
            const position = coordinates[index] ?? [50, 50];
            const side = normalizeSide(player.team);
            const inputs = activeInputLabels(player);
            return <button type="button" className={`replay-player replay-player--${side === 'A' ? 'a' : side === 'B' ? 'b' : 'unknown'}`} key={player.id} style={{ left: `${position[0]}%`, top: `${position[1]}%`, opacity: player.alive ? 1 : .35 }} title={`${player.name} · HP ${player.health} · ${player.weapon}${inputs.length > 0 ? ` · ${inputs.join('+')}` : ''}`}><span>{index + 1}</span><small>{player.name}</small></button>;
          })}
          {activeProjectiles.map((projectile, index) => {
            const position = projectileCoordinates[index] ?? [50, 50];
            const presentation = replayEffectPresentation(projectile.kind);
            return <span key={`${projectile.kind}-${projectile.position.join('-')}-${index}`} className={`replay-grenade replay-grenade--${presentation.className}${projectile.masks_vision ? ' is-utility-mask' : ''}`} style={{ left: `${position[0]}%`, top: `${position[1]}%` }} title={msgf("m0116", [presentation.label, presentation.eventOnly ? msg("m1351") : msg("m1352"), projectile.radius ? msgf("m0323", [projectile.radius.toFixed(0)]) : msg("m1353"), projectile.masks_vision ? msg("m1354") : ''])} />;
          })}
          {currentFrame.bomb && bombCoordinate ? <span className={`replay-bomb replay-bomb--${currentFrame.bomb.state === 'planted' || currentFrame.bomb.state === 'defused' || currentFrame.bomb.state === 'exploded' ? currentFrame.bomb.state : 'unknown'}`} style={{ left: `${bombCoordinate[0]}%`, top: `${bombCoordinate[1]}%` }} title={msgf("m0942", [currentFrame.bomb.state])}>B</span> : null}
        </div>
        <div className="replay-legend" aria-label={msg("m0378")}>
          {(['smoke', 'inferno', 'decoy', 'he', 'flash'] as const).map((kind) => { const item = replayEffectPresentation(kind); return <span key={kind}><i className={`replay-legend__dot replay-grenade--${item.className}`} />{item.label}</span>; })}
          <span><i className="replay-legend__bomb">B</i>{msg("m0943")}</span>
          <small>{msg("m0183")}</small>
        </div>
        <div className="replay-controls">
          <Button size="sm" variant="ghost" disabled={frames.length < 2} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={15} /> : <Play size={15} />}</Button>
          <span>{formatClock(elapsed)}</span>
          <input type="range" min="0" max={Math.max(0, frames.length - 1)} step="1" value={frameIndex} onChange={(event) => setFrameIndex(Number(event.target.value))} aria-label={msg("m0376")} />
          <span>{formatClock(total)}</span>
          <Button size="sm" onClick={() => setSpeed((current) => current === .5 ? 1 : current === 1 ? 2 : .5)}>{speed.toFixed(1)}×</Button>
        </div>
      </Card>
      <Card className="replay-events">
        <div className="card-heading"><div><span className="eyebrow">FRAME EVIDENCE</span><h2>{msg("m0572")}</h2></div><ScanLine size={16} /></div>
        {visiblePlayers.map((player) => { const inputs = activeInputLabels(player); return <div key={player.id}><time>HP {player.health}</time><span className="event-type-icon"><Crosshair size={13} /></span><p>{player.name} · {player.weapon} · {player.alive ? msg("m0440") : msg("m1282")}{inputs.length > 0 ? ` · ${inputs.join('+')}` : ''}</p></div>; })}
        {activeProjectiles.map((projectile, index) => { const item = replayEffectPresentation(projectile.kind); return <div key={`${projectile.kind}-${index}`}><time>{msg("m0680")}</time><span className="event-type-icon"><Zap size={13} /></span><p>{item.label}{item.eventOnly ? msg("m0004") : msg("m0006")}</p></div>; })}
        {currentFrame.bomb ? <div><time>{msg("m1013")}</time><span className="event-type-icon"><CircleDot size={13} /></span><p>{msg("m0941")} {currentFrame.bomb.state === 'planted' ? msg("m0509") : currentFrame.bomb.state === 'defused' ? msg("m0516") : currentFrame.bomb.state === 'exploded' ? msg("m0532") : currentFrame.bomb.state}</p></div> : null}
      </Card>
    </div>
  );
}

function HeatmapView({ demoId, mapName, player, source }: { demoId: string; mapName: string; player: PlayerAnalysis | null; source: 'loading' | 'service' | 'error' }) {
  const [points, setPoints] = useState<HeatPointRecord[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'all' | 'kills' | 'deaths' | 'movement' | 'utility'>('all');
  const [floor, setFloor] = useState<number | null>(null);
  const [team, setTeam] = useState<'all' | 'A' | 'B'>('all');
  const [playerOnly, setPlayerOnly] = useState(false);
  const radar = useRadarOverview(mapName, source === 'service');

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
    void api.getHeatmap(demoId, controller.signal).then((response) => {
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

  if (state === 'loading') return <Card><EmptyState icon={<Spinner />} title={msg("m0870")} description={msg("m1052")} /></Card>;
  if (state === 'error') return <Card><EmptyState icon={<Flame size={22} />} title={msg("m0947")} description={error ?? msg("m0779")} /></Card>;
  if (points.length === 0) return <Card><EmptyState icon={<Flame size={22} />} title={msg("m0902")} description={msg("m0260")} /></Card>;

  const floors = [...new Set(points.map((point) => point.floor))].sort((left, right) => left - right);
  const filtered = points.filter((point) => {
    const event = (point.event_kind ?? point.kind).toLocaleLowerCase();
    const matchesMode = mode === 'all'
      || (mode === 'kills' && event.includes('kill'))
      || (mode === 'deaths' && event.includes('death'))
      || (mode === 'movement' && event === 'movement')
      || (mode === 'utility' && (event.includes('grenade') || event.includes('bomb')));
    return matchesMode
      && (floor === null || point.floor === floor)
      && (team === 'all' || normalizeSide(point.team ?? '') === team)
      && (!playerOnly || (player !== null && point.player_id === player.id));
  });
  const radarTransform = radar?.transform ?? null;
  const heatPoints: Array<[number, number]> = filtered.map((point) => [point.x, point.y]);
  const coordinates = worldPointsToRadarPercent(heatPoints, radarTransform) ?? normalizeCoordinates(heatPoints);
  const radarImage = radarTransform && radar?.browser_displayable && radar.image_url ? apiMediaUrl(radar.image_url) : null;
  const floorCounts = new Map<number, number>();
  points.forEach((point) => floorCounts.set(point.floor, (floorCounts.get(point.floor) ?? 0) + 1));
  const kindCounts = new Map<string, number>();
  points.forEach((point) => kindCounts.set(point.kind, (kindCounts.get(point.kind) ?? 0) + 1));

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
          <label><span className="sr-only">{msg("m1283")}</span><select value={team} onChange={(event) => setTeam(event.target.value as typeof team)}><option value="all">{msg("m0235")}</option><option value="A">TEAM A</option><option value="B">TEAM B</option></select></label>
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
          <div className={`heatmap-map heatmap-map--${mode}${radarImage ? ' has-radar-image' : ''}`}>
            {radarImage ? <img className="radar-map-image" src={radarImage} alt={msgf("m0111", [mapName])} /> : (
              <>
                <div className="replay-map__site replay-map__site--a">A</div>
                <div className="replay-map__site replay-map__site--b">B</div>
                <div className="replay-map__paths"><span /><span /><span /><span /><span /></div>
              </>
            )}
            {filtered.map((point, index) => {
              const position = coordinates[index] ?? [50, 50];
              const weight = Math.max(.08, Math.min(1, point.weight));
              const size = 20 + weight * 56;
              return <span key={`${point.x}-${point.y}-${index}`} className="heat-spot" style={{ left: `${position[0]}%`, top: `${position[1]}%`, width: size, height: size, opacity: .25 + weight * .65 }} title={`${point.kind} · weight ${point.weight.toFixed(2)} · floor ${point.floor}`} />;
            })}
          </div>
        ) : <EmptyState icon={<Flame size={20} />} title={msg("m0877")} description={msg("m0025")} />}
      </Card>
      <div className="heatmap-insights">
        <Card>
          <span className="eyebrow">API EVIDENCE</span><h2>{msg("m1053")}</h2>
          <div className="ranked-list">{[...kindCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([kind, count], index) => <div key={kind}><span>{index + 1}</span><strong>{kind || msg("m0752")}</strong><small>{count} {msg("m0944")}</small></div>)}</div>
        </Card>
        <Notice tone="info" title={msg("m0683")}>{msg("m0576")} {filtered.length} / {points.length} {msg("m0162")} {floorCounts.size} {msg("m0156")}{radarTransform ? msg("m0404") : msg("m1089")}</Notice>
      </div>
    </div>
  );
}

function HighlightsView({ highlights, workspace, addedId, onAdd, onAddMany, onPreview }: { highlights: Highlight[]; workspace: AnalysisWorkspace; addedId: string | null; onAdd: (highlight: Highlight) => void; onAddMany: (highlights: Highlight[]) => void; onPreview: () => void }) {
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
          return <Card className={`highlight-card${selectedIds.has(highlight.id) ? ' is-selected' : ''}`} key={highlight.id}><label className={`highlight-card__rank rank-${index + 1}`}><input type="checkbox" checked={selectedIds.has(highlight.id)} onChange={() => toggleHighlight(highlight.id)} aria-label={msgf("m1226", [highlight.label])} /><span>{String(index + 1).padStart(2, '0')}</span></label><div className="highlight-card__preview"><div className="mini-crosshair"><span /><span /></div><Badge tone="accent">{highlight.round > 0 ? `R${highlight.round}` : msg("m0225")}</Badge><span>{workspace.tick_rate > 0 ? `${((highlight.end_tick - highlight.start_tick) / workspace.tick_rate).toFixed(1)}s` : '—'}</span></div><div className="highlight-card__main"><div><Badge tone={highlight.kind === 'fail' ? 'danger' : highlight.category === 'clutch' ? 'warning' : 'blue'}>{kindLabel[highlight.kind]}</Badge><span>{player?.name ?? highlight.player_id}{player ? ` · TEAM ${player.team}` : ''}</span></div><h3>{highlight.label}</h3><p>{highlight.description || msgf("m0256", [highlight.confidence.toFixed(2)])} · tick {highlight.start_tick.toLocaleString(currentLocale())}–{highlight.end_tick.toLocaleString(currentLocale())}</p>{highlight.tags.length > 0 ? <small>{highlight.tags.join(' · ')}</small> : null}</div><div className="highlight-card__actions"><Button size="sm" onClick={onPreview}><Play size={13} />{msg("m0637")}</Button><Button size="sm" variant="primary" onClick={() => onAdd(highlight)}>{addedId === highlight.id ? <Check size={14} /> : <Plus size={14} />}{addedId === highlight.id ? msg("m0502") : msg("m0303")}</Button></div></Card>;
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
      api.inspectCosmetics(demoId, controller.signal),
      api.getCosmeticCatalog(controller.signal)
        .then((value) => ({ value, error: null }))
        .catch((cause: unknown) => ({ value: null, error: readableError(cause) })),
      api.listCosmeticPlans(demoId, controller.signal)
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
      () => api.rewriteCosmetics(demoId, build.request!),
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
      const plan = await api.createCosmeticPlan(demoId, {
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
      await api.deleteCosmeticPlan(demoId, plan.id);
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
                <span className="cosmetic-item-icon"><CosmeticPreviewImage key={hasSelectedImage ? selectedPaint : 'none'} source={hasSelectedImage ? api.cosmeticImageUrl(item.item_definition_index, selectedPaint) : null} /></span>
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
