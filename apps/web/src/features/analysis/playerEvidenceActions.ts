import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { QueueItem } from '../queue/queueStore';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import type { PlayerEvidenceRef } from './playerMatchEvidence';

export type PlayerEvidenceCompilationIntent = {
  id: string;
  title: string;
  playerId: string;
  startTick: number;
  endTick: number;
  category: QueueItem['category'];
  highlightId?: string;
  hasVictimPov?: boolean;
};

export type PlayerEvidenceActionIntent = {
  watch: { start_tick: number };
  replay: AnalysisNavigationPatch;
  compilation: PlayerEvidenceCompilationIntent;
};

function playerName(workspace: AnalysisWorkspace, playerId: string | null): string | null {
  if (!playerId) return null;
  return workspace.players.find((player) => player.id === playerId)?.name ?? playerId;
}

function eventForEvidence(
  workspace: AnalysisWorkspace,
  evidence: PlayerEvidenceRef,
): TimelineEvent | null {
  const round = workspace.rounds.find((candidate) => candidate.number === evidence.round);
  return round?.events.find((event) => event.id === evidence.source_id) ?? null;
}

function eventCategory(event: TimelineEvent): QueueItem['category'] {
  if (event.kind === 'kill') return 'entry';
  if (event.kind === 'grenade' || event.kind.startsWith('bomb_')) return 'utility';
  return 'custom';
}

function eventTitle(workspace: AnalysisWorkspace, event: TimelineEvent): string {
  const actor = playerName(workspace, event.actor);
  const target = playerName(workspace, event.target);
  const weapon = event.weapon?.replace(/^weapon_/i, '').toLocaleUpperCase() ?? null;
  if (event.kind === 'kill') {
    return ['Kill', actor && target ? `${actor} → ${target}` : actor ?? target, weapon]
      .filter(Boolean)
      .join(' · ');
  }
  if (event.kind === 'damage') {
    return ['Damage', actor && target ? `${actor} → ${target}` : actor ?? target, weapon]
      .filter(Boolean)
      .join(' · ');
  }
  if (event.kind === 'grenade') {
    return ['Utility', actor, weapon].filter(Boolean).join(' · ');
  }
  const label = event.kind.replaceAll('_', ' ');
  return [label.charAt(0).toLocaleUpperCase() + label.slice(1), actor].filter(Boolean).join(' · ');
}

function safeEndTick(startTick: number, requestedEndTick: number | null): number {
  if (requestedEndTick !== null && requestedEndTick > startTick) return requestedEndTick;
  return Math.min(Number.MAX_SAFE_INTEGER, startTick + 1);
}

/**
 * Builds the three product actions for one stable evidence reference without
 * reparsing display text or inventing evidence that is absent from analysis.
 */
export function playerEvidenceActionIntent(
  workspace: AnalysisWorkspace,
  selectedPlayerId: string,
  evidence: PlayerEvidenceRef,
): PlayerEvidenceActionIntent {
  const highlight = evidence.source_kind === 'highlight'
    ? workspace.highlights.find((candidate) => candidate.id === evidence.source_id) ?? null
    : null;
  const event = evidence.source_kind === 'event' ? eventForEvidence(workspace, evidence) : null;
  const selectedName = playerName(workspace, selectedPlayerId) ?? selectedPlayerId;
  const playerId = highlight?.player_id ?? selectedPlayerId;
  const startTick = highlight?.start_tick ?? evidence.tick;
  const endTick = safeEndTick(startTick, highlight?.end_tick ?? evidence.end_tick);
  const compilation: PlayerEvidenceCompilationIntent = {
    id: evidence.evidence_id,
    title: highlight?.label
      ?? (event ? eventTitle(workspace, event) : `${selectedName} · Round ${evidence.round} evidence`),
    playerId,
    startTick,
    endTick,
    category: highlight?.category ?? (event ? eventCategory(event) : 'custom'),
  };
  if (highlight) {
    compilation.highlightId = highlight.id;
    compilation.hasVictimPov = highlight.victims.length > 0;
  }

  return {
    watch: { start_tick: evidence.tick },
    replay: {
      tab: 'replay',
      round: evidence.round,
      tick: evidence.tick,
      playerId,
      evidenceId: evidence.evidence_id,
    },
    compilation,
  };
}
