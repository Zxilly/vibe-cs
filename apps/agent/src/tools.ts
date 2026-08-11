import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { AgentRequest, CapturedPlan } from './protocol.js';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function highlightEvidence(analysis: unknown) {
  return array(object(analysis)?.highlights).map((value) => {
    const item = object(value) ?? {};
    return {
      id: text(item.id) ?? '',
      kind: text(item.kind) ?? '',
      title: text(item.title) ?? text(item.label) ?? 'Highlight',
      playerId: text(item.player_id) ?? '',
      round: number(item.round),
      startTick: number(item.start_tick),
      endTick: number(item.end_tick),
      score: number(item.score) ?? number(item.confidence),
      description: text(item.description) ?? '',
      victims: array(item.victims).filter((entry): entry is string => typeof entry === 'string'),
      tags: array(item.tags).filter((entry): entry is string => typeof entry === 'string'),
    };
  }).filter((item) => item.id && item.startTick !== null && item.endTick !== null);
}

function bindHighlightEvidence(highlights: ReturnType<typeof highlightEvidence>, highlightIds: string[]) {
  const evidenceById = new Map<string, typeof highlights>();
  for (const highlight of highlights) {
    const matches = evidenceById.get(highlight.id) ?? [];
    matches.push(highlight);
    evidenceById.set(highlight.id, matches);
  }
  const duplicateHighlightIds = [...new Set(
    highlightIds.filter((id, index) => highlightIds.indexOf(id) !== index),
  )];
  const missingHighlightIds = [...new Set(
    highlightIds.filter((id) => !evidenceById.has(id)),
  )];
  const ambiguousHighlightIds = [...new Set(
    highlightIds.filter((id) => (evidenceById.get(id)?.length ?? 0) > 1),
  )];
  const selected = highlightIds.flatMap((id) => {
    const matches = evidenceById.get(id);
    return matches?.length === 1 ? matches : [];
  });
  const ready = duplicateHighlightIds.length === 0
    && missingHighlightIds.length === 0
    && ambiguousHighlightIds.length === 0
    && selected.length === highlightIds.length
    && selected.every((item, index) => item.id === highlightIds[index]);
  return { selected, duplicateHighlightIds, missingHighlightIds, ambiguousHighlightIds, ready };
}

const eventKindSchema = z.enum([
  'round_start', 'round_end', 'kill', 'damage', 'bomb_plant', 'bomb_defuse',
  'bomb_explode', 'grenade', 'purchase',
]);

function rounds(analysis: unknown): JsonObject[] {
  return array(object(analysis)?.rounds).flatMap((value) => {
    const round = object(value);
    return round ? [round] : [];
  });
}

function insights(analysis: unknown): JsonObject {
  return object(object(analysis)?.insights) ?? {};
}

function roundNumber(round: JsonObject): number | null {
  return number(round.number);
}

function roundEvents(round: JsonObject): JsonObject[] {
  return array(round.events).flatMap((value) => {
    const event = object(value);
    return event ? [event] : [];
  });
}

function roundEconomy(analysis: unknown, targetRound: number): unknown[] {
  const economy = array(insights(analysis).round_economy).find((value) => (
    number(object(value)?.round) === targetRound
  ));
  return array(object(economy)?.teams);
}

function eventMatches(event: JsonObject, eventKinds: Set<string>, playerIds: Set<string>): boolean {
  const kind = text(event.kind);
  if (eventKinds.size > 0 && (!kind || !eventKinds.has(kind))) return false;
  if (playerIds.size === 0) return true;
  return [text(event.actor), text(event.target)].some((id) => id !== null && playerIds.has(id));
}

export function createVibeTools(context: AgentRequest['context'], plans: CapturedPlan[]) {
  const readDemoEvidence = createTool({
    id: 'read_demo_evidence',
    description: 'Read verified local demo metadata, highlights, rounds, or players. Use this before giving match-specific guidance.',
    inputSchema: z.object({
      section: z.enum(['summary', 'highlights', 'rounds', 'players']),
      roundNumbers: z.array(z.number().int().positive()).max(12).optional(),
    }).strict(),
    outputSchema: z.object({ section: z.string(), evidence: z.unknown() }).strict(),
    execute: async ({ section, roundNumbers }) => {
      const analysis = object(context.analysis);
      if (!analysis) return { section, evidence: { available: false, reason: 'No analyzed demo is selected.' } };
      if (section === 'summary') {
        return {
          section,
          evidence: {
            available: true,
            demo: context.demo,
            mapName: analysis.map_name,
            tickRate: analysis.tick_rate,
            durationSeconds: analysis.duration_seconds,
            teams: analysis.teams,
          },
        };
      }
      if (section === 'highlights') return { section, evidence: highlightEvidence(analysis) };
      if (section === 'players') return { section, evidence: analysis.players ?? [] };
      const wanted = new Set(roundNumbers ?? []);
      const rounds = array(analysis.rounds).filter((entry) => {
        if (wanted.size === 0) return true;
        const round = number(object(entry)?.number);
        return round !== null && wanted.has(round);
      });
      return { section, evidence: rounds.slice(0, 24) };
    },
  });

  const readEditorTimeline = createTool({
    id: 'read_editor_timeline',
    description: 'Read the selected editor project and its real tracks, clips, markers, dimensions, frame rate, and revision.',
    inputSchema: z.object({ includeClips: z.boolean().default(true) }).strict(),
    outputSchema: z.object({ available: z.boolean(), project: z.unknown().nullable() }).strict(),
    execute: async ({ includeClips }) => {
      const project = object(context.editorProject);
      if (!project) return { available: false, project: null };
      if (includeClips) return { available: true, project };
      const { tracks: _tracks, ...summary } = project;
      return { available: true, project: summary };
    },
  });

  const searchRounds = createTool({
    id: 'search_rounds',
    description: 'Run a strict, deterministic query over the selected local Demo rounds. Returns bounded round/tick evidence only.',
    inputSchema: z.object({
      winningSide: z.enum(['A', 'B']).optional(),
      playerIds: z.array(z.string().min(1).max(128)).max(10).default([]),
      purchasedItems: z.array(z.string().trim().min(1).max(64)).max(12).default([]),
      roundNumbers: z.array(z.number().int().positive()).max(24).default([]),
      eventKinds: z.array(eventKindSchema).max(9).default([]),
      maximumResults: z.number().int().min(1).max(24).default(24),
    }).strict(),
    outputSchema: z.object({ available: z.boolean(), rounds: z.array(z.unknown()), aggregate: z.unknown() }).strict(),
    execute: async ({ winningSide, playerIds, purchasedItems, roundNumbers, eventKinds, maximumResults }) => {
      const source = object(context.analysis);
      if (!source) return { available: false, rounds: [], aggregate: { reason: 'No analyzed Demo is selected.' } };
      const wantedRounds = new Set(roundNumbers);
      const wantedEvents = new Set(eventKinds);
      const wantedPlayers = new Set(playerIds);
      const wantedItems = new Set(purchasedItems.map((value) => value.toLowerCase()));
      const matches = rounds(source).flatMap((round) => {
        const numberValue = roundNumber(round);
        if (numberValue === null || wantedRounds.size > 0 && !wantedRounds.has(numberValue)) return [];
        if (winningSide && text(round.winner) !== winningSide) return [];
        const events = roundEvents(round).filter((event) => eventMatches(event, wantedEvents, wantedPlayers));
        if ((wantedEvents.size > 0 || wantedPlayers.size > 0) && events.length === 0) return [];
        const economy = roundEconomy(source, numberValue);
        if (wantedItems.size > 0) {
          const items = economy.flatMap((team) => array(object(team)?.items))
            .map((item) => text(object(item)?.name)?.toLowerCase()).filter(Boolean);
          if (!items.some((item) => item && wantedItems.has(item))) return [];
        }
        return [{
          evidenceId: `round:${numberValue}`, round: numberValue,
          startTick: number(round.start_tick), endTick: number(round.end_tick), winner: text(round.winner),
          score: [number(round.team_a_score), number(round.team_b_score)], economy,
          matchedEvents: events.slice(0, 32).map((event) => ({
            evidenceId: `event:${text(event.id) ?? `${numberValue}:${number(event.tick) ?? 0}`}`,
            tick: number(event.tick), kind: text(event.kind), actor: text(event.actor), target: text(event.target),
          })),
        }];
      }).slice(0, maximumResults);
      return { available: matches.length > 0, rounds: matches, aggregate: { count: matches.length, truncated: matches.length === maximumResults } };
    },
  });

  const readRoundContext = createTool({
    id: 'read_round_context',
    description: 'Read context for up to 12 explicit rounds from the selected local Demo.',
    inputSchema: z.object({ roundNumbers: z.array(z.number().int().positive()).min(1).max(12) }).strict(),
    outputSchema: z.object({ available: z.boolean(), rounds: z.array(z.unknown()) }).strict(),
    execute: async ({ roundNumbers }) => {
      const wanted = new Set(roundNumbers);
      const selected = rounds(context.analysis).flatMap((round) => {
        const value = roundNumber(round);
        if (value === null || !wanted.has(value)) return [];
        return [{
          evidenceId: `round:${value}`, round: value, startTick: round.start_tick, endTick: round.end_tick,
          winner: round.winner, reason: round.reason, score: [round.team_a_score, round.team_b_score],
          economy: roundEconomy(context.analysis, value), events: roundEvents(round).slice(0, 64),
        }];
      });
      return { available: selected.length > 0, rounds: selected };
    },
  });

  const readRoundEvents = createTool({
    id: 'read_round_events',
    description: 'Read bounded local events for explicit rounds, event kinds, and player identifiers.',
    inputSchema: z.object({
      roundNumbers: z.array(z.number().int().positive()).min(1).max(24),
      eventKinds: z.array(eventKindSchema).max(9).default([]),
      playerIds: z.array(z.string().min(1).max(128)).max(10).default([]),
      maximumResults: z.number().int().min(1).max(256).default(128),
    }).strict(),
    outputSchema: z.object({ available: z.boolean(), events: z.array(z.unknown()), truncated: z.boolean() }).strict(),
    execute: async ({ roundNumbers, eventKinds, playerIds, maximumResults }) => {
      const wantedRounds = new Set(roundNumbers);
      const wantedEvents = new Set(eventKinds);
      const wantedPlayers = new Set(playerIds);
      const all = rounds(context.analysis).flatMap((round) => {
        const value = roundNumber(round);
        if (value === null || !wantedRounds.has(value)) return [];
        return roundEvents(round).filter((event) => eventMatches(event, wantedEvents, wantedPlayers)).map((event) => ({
          evidenceId: `event:${text(event.id) ?? `${value}:${number(event.tick) ?? 0}`}`,
          round: value, tick: number(event.tick), seconds: number(event.seconds), kind: text(event.kind),
          actor: text(event.actor), target: text(event.target), weapon: text(event.weapon), headshot: event.headshot === true,
        }));
      });
      return { available: all.length > 0, events: all.slice(0, maximumResults), truncated: all.length > maximumResults };
    },
  });

  const readPlayerMatchups = createTool({
    id: 'read_player_matchups',
    description: 'Read deterministic player-versus-player aggregates derived by the local Demo analyzer.',
    inputSchema: z.object({ playerIds: z.array(z.string().min(1).max(128)).min(1).max(10) }).strict(),
    outputSchema: z.object({ available: z.boolean(), matchups: z.array(z.unknown()), reason: z.string().optional() }).strict(),
    execute: async ({ playerIds }) => {
      const wanted = new Set(playerIds);
      const matchups = array(insights(context.analysis).matchups).flatMap((value) => {
        const matchup = object(value);
        if (!matchup || !wanted.has(text(matchup.player_id) ?? '') && !wanted.has(text(matchup.opponent_id) ?? '')) return [];
        return [{ evidenceId: `matchup:${text(matchup.player_id)}:${text(matchup.opponent_id)}`, ...matchup }];
      }).slice(0, 100);
      return matchups.length > 0
        ? { available: true, matchups }
        : { available: false, matchups: [], reason: 'No verified matchup evidence is available for those players.' };
    },
  });

  const readHighlights = createTool({
    id: 'read_highlights',
    description: 'Read filtered local highlight evidence with explicit identifiers and tick ranges.',
    inputSchema: z.object({
      playerIds: z.array(z.string().min(1).max(128)).max(10).default([]),
      kinds: z.array(z.string().min(1).max(64)).max(12).default([]),
      roundNumbers: z.array(z.number().int().positive()).max(24).default([]),
      minimumScore: z.number().min(0).max(1).default(0),
      maximumResults: z.number().int().min(1).max(64).default(32),
    }).strict(),
    outputSchema: z.object({ available: z.boolean(), highlights: z.array(z.unknown()) }).strict(),
    execute: async ({ playerIds, kinds, roundNumbers, minimumScore, maximumResults }) => {
      const players = new Set(playerIds);
      const wantedKinds = new Set(kinds);
      const wantedRounds = new Set(roundNumbers);
      const selected = highlightEvidence(context.analysis).filter((highlight) => (
        (players.size === 0 || players.has(highlight.playerId))
        && (wantedRounds.size === 0 || highlight.round !== null && wantedRounds.has(highlight.round))
        && (highlight.score ?? 0) >= minimumScore
        && (wantedKinds.size === 0 || wantedKinds.has(highlight.kind))
      )).slice(0, maximumResults).map((highlight) => ({ evidenceId: `highlight:${highlight.id}`, ...highlight }));
      return { available: selected.length > 0, highlights: selected };
    },
  });

  const draftEditPlan = createTool({
    id: 'draft_edit_plan',
    description: 'Draft a non-destructive edit plan from verified highlight identifiers. This never changes the timeline by itself.',
    inputSchema: z.object({
      highlightIds: z.array(z.string().min(1)).min(1).max(16),
      pacing: z.enum(['measured', 'energetic', 'impact']),
      includeContextSeconds: z.number().min(0).max(8).default(2),
      transitionStyle: z.enum(['auto', 'cut', 'fade', 'flash', 'slide']).default('auto'),
    }).strict(),
    outputSchema: z.object({ accepted: z.boolean(), plan: z.unknown() }).strict(),
    execute: async ({ highlightIds, pacing, includeContextSeconds, transitionStyle }) => {
      const highlights = highlightEvidence(context.analysis);
      const {
        selected, duplicateHighlightIds, missingHighlightIds, ambiguousHighlightIds,
        ready: bindingReady,
      } = bindHighlightEvidence(highlights, highlightIds);
      const tickRate = number(object(context.analysis)?.tick_rate) ?? 64;
      const resolvedTransition = transitionStyle === 'auto'
        ? pacing === 'impact' ? 'flash' : pacing === 'energetic' ? 'slide' : 'fade'
        : transitionStyle;
      const candidateClips = selected.map((item, index) => ({
        sourceHighlightId: item.id,
        order: index,
        startTick: Math.max(0, (item.startTick ?? 0) - Math.round(includeContextSeconds * tickRate)),
        endTick: (item.endTick ?? 0) + Math.round(includeContextSeconds * tickRate),
        transition: index === 0 ? 'cut' : resolvedTransition,
        rationale: item.description || item.title,
      }));
      const demoId = text(object(context.demo)?.id);
      const rejectionReasons = [
        ...(missingHighlightIds.length > 0
          ? [`Missing highlight evidence: ${missingHighlightIds.join(', ')}`]
          : []),
        ...(duplicateHighlightIds.length > 0
          ? [`Duplicate requested highlight IDs: ${duplicateHighlightIds.join(', ')}`]
          : []),
        ...(ambiguousHighlightIds.length > 0
          ? [`Highlight IDs are ambiguous in the current analysis: ${ambiguousHighlightIds.join(', ')}`]
          : []),
        ...(!demoId ? ['No analyzed Demo is selected.'] : []),
      ];
      const accepted = bindingReady && demoId !== null;
      const payload = {
        schemaVersion: 1,
        pacing,
        tickRate,
        clips: accepted ? candidateClips : [],
        missingHighlightIds,
        duplicateHighlightIds,
        ambiguousHighlightIds,
        rejectionReasons,
      };
      if (accepted) {
        plans.push({
          kind: 'highlight_edit', title: 'Recorded highlight edit draft',
          payload: {
            demo_id: demoId,
            highlight_ids: selected.map((item) => item.id),
            intent: {
              pacing,
              include_context_seconds: includeContextSeconds,
              transition: resolvedTransition,
            },
          },
        });
      }
      return { accepted, plan: payload };
    },
  });

  const draftHlaePlan = createTool({
    id: 'draft_hlae_plan',
    description: 'Draft a reviewable HLAE camera intent from verified demo ticks. Choose preview to inspect paths without recording or capture to export image-sequence recording commands. This emits data only and never launches the game or executes console commands.',
    inputSchema: z.object({
      highlightIds: z.array(z.string().min(1)).min(1).max(16),
      cameraStyle: z.enum(['pov', 'orbit', 'dolly']),
      mode: z.enum(['preview', 'capture']).default('preview'),
      leadSeconds: z.number().min(0.5).max(8).default(2.5),
      tailSeconds: z.number().min(0.5).max(8).default(2),
    }).strict(),
    outputSchema: z.object({
      accepted: z.boolean(),
      plan: z.unknown(),
      missingEvidence: z.array(z.string()),
    }).strict(),
    execute: async ({ highlightIds, cameraStyle, mode, leadSeconds, tailSeconds }) => {
      const highlights = highlightEvidence(context.analysis);
      const tickRate = number(object(context.analysis)?.tick_rate) ?? 64;
      const {
        selected, duplicateHighlightIds, missingHighlightIds, ambiguousHighlightIds,
        ready: bindingReady,
      } = bindHighlightEvidence(highlights, highlightIds);
      const demoId = text(object(context.demo)?.id);
      const missingEvidence = [
        ...missingHighlightIds.map((id) => `missing_highlight:${id}`),
        ...duplicateHighlightIds.map((id) => `duplicate_highlight:${id}`),
        ...ambiguousHighlightIds.map((id) => `ambiguous_highlight:${id}`),
        ...(!demoId ? ['demo_id'] : []),
      ];
      const accepted = bindingReady && demoId !== null;
      const rejectionReasons = [
        ...(missingHighlightIds.length > 0
          ? [`Missing highlight evidence: ${missingHighlightIds.join(', ')}`]
          : []),
        ...(duplicateHighlightIds.length > 0
          ? [`Duplicate requested highlight IDs: ${duplicateHighlightIds.join(', ')}`]
          : []),
        ...(ambiguousHighlightIds.length > 0
          ? [`Highlight IDs are ambiguous in the current analysis: ${ambiguousHighlightIds.join(', ')}`]
          : []),
        ...(!demoId ? ['No analyzed Demo is selected.'] : []),
      ];
      const payload = {
        demo_id: demoId,
        highlight_ids: accepted ? selected.map((item) => item.id) : [],
        camera_style: cameraStyle,
        mode,
        lead_seconds: leadSeconds,
        tail_seconds: tailSeconds,
      };
      if (accepted) plans.push({ kind: 'hlae', title: 'HLAE camera proposal', payload });
      return {
        accepted,
        plan: {
          ...payload,
          tickRate,
          requiresUserReview: true,
          missingHighlightIds,
          duplicateHighlightIds,
          ambiguousHighlightIds,
          rejectionReasons,
        },
        missingEvidence,
      };
    },
  });

  const readAudioAnalysis = createTool({
    id: 'read_audio_analysis',
    description: 'Read real locally decoded BGM tempo, beat, onset, energy, and section evidence. Never infer that audio was analyzed when unavailable.',
    inputSchema: z.object({ includeEnergyCurve: z.boolean().default(false) }).strict(),
    outputSchema: z.object({ available: z.boolean(), analysis: z.unknown().nullable() }).strict(),
    execute: async ({ includeEnergyCurve }) => {
      const analysis = object(context.audioAnalysis);
      if (!analysis) return { available: false, analysis: null };
      if (includeEnergyCurve) return { available: true, analysis };
      const { energy: _energy, ...summary } = analysis;
      return { available: true, analysis: summary };
    },
  });

  const draftBeatAlignment = createTool({
    id: 'draft_beat_alignment',
    description: 'Return the advisory beat-alignment draft computed by the native Rust audio engine for the selected BGM and real clips.',
    inputSchema: z.object({ acknowledgeAdvisoryOnly: z.literal(true) }).strict(),
    outputSchema: z.object({ available: z.boolean(), draft: z.unknown().nullable() }).strict(),
    execute: async () => {
      const draft = object(context.beatAlignmentDraft);
      if (!draft) return { available: false, draft: null };
      const project = object(context.editorProject);
      const projectId = text(project?.id);
      const revision = number(project?.revision);
      const selectedAudio = object(context.selectedAudio);
      const audioAssetId = text(selectedAudio?.assetId);
      const placement = object(selectedAudio?.placement);
      if (projectId && revision !== null && audioAssetId && placement) {
        plans.push({
          kind: 'beat_alignment', title: 'BGM beat alignment',
          payload: {
            project_id: projectId,
            expected_revision: revision,
            audio_asset_id: audioAssetId,
            audio_placement: placement,
            draft,
          },
        });
      }
      return { available: true, draft };
    },
  });

  return {
    readDemoEvidence,
    searchRounds,
    readRoundContext,
    readRoundEvents,
    readPlayerMatchups,
    readHighlights,
    readEditorTimeline,
    draftEditPlan,
    draftHlaePlan,
    readAudioAnalysis,
    draftBeatAlignment,
  };
}
