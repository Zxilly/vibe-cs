import { describe, expect, it } from 'vitest';

import { createVibeTools } from './tools.js';

const context = {
  demo: { id: 'demo-1', file_name: 'match.dem' },
  analysis: {
    tick_rate: 64,
    rounds: [{
      number: 7, winner: 'A', start_tick: 900, end_tick: 1_700,
      team_a_score: 7, team_b_score: 5,
      events: [{ id: 'kill-1', tick: 1_200, seconds: 18.75, kind: 'kill', actor: 'p1', target: 'p2', weapon: 'ak47', headshot: true }],
    }],
    highlights: [{
      id: 'ace-1', kind: 'multi_kill', title: 'Ace', player_id: 'p1', round: 7,
      start_tick: 1_000, end_tick: 1_500, description: 'Five eliminations',
    }, {
      id: 'support-2', kind: 'clutch', title: 'Support clutch', player_id: 'p2', round: 7,
      start_tick: 1_520, end_tick: 1_620, description: 'Clutch follow-up',
    }],
    insights: {
      round_economy: [{ round: 7, teams: [{ team: 'A', items: [{ name: 'ak47', count: 1 }] }] }],
      matchups: [{ player_id: 'p1', opponent_id: 'p2', kills: 2, deaths: 0 }],
    },
  },
  editorProject: { id: 'project-1', revision: 3, tracks: [] },
  selectedAudio: null,
  audioAnalysis: null,
  beatAlignmentDraft: null,
};

describe('Vibe CS agent tools', () => {
  it('binds beat drafts to the selected audio asset and placement', async () => {
    const plans: never[] = [];
    const draft = { advisory_only: true, clips: [{ clip_id: 'clip-1' }] };
    const tools = createVibeTools({
      ...context,
      selectedAudio: {
        assetId: 'audio-1',
        placement: { timeline_start_seconds: 0, source_in_seconds: 0, volume: 1 },
      },
      beatAlignmentDraft: draft,
    }, plans);
    const result = await tools.draftBeatAlignment.execute?.(
      { acknowledgeAdvisoryOnly: true },
      {} as never,
    );
    expect(result).toEqual({ available: true, draft });
    expect(plans).toEqual([{
      kind: 'beat_alignment',
      title: 'BGM beat alignment',
      payload: {
        project_id: 'project-1',
        expected_revision: 3,
        audio_asset_id: 'audio-1',
        audio_placement: { timeline_start_seconds: 0, source_in_seconds: 0, volume: 1 },
        draft,
      },
    }]);
  });

  it('rejects a partial highlight binding without enqueueing a reduced proposal', async () => {
    const plans: never[] = [];
    const tools = createVibeTools(context, plans);
    const result = await tools.draftEditPlan.execute?.({
      highlightIds: ['support-2', 'ace-1', 'missing'], pacing: 'impact', includeContextSeconds: 2,
      transitionStyle: 'auto',
    }, {} as never);
    expect(result).toMatchObject({
      accepted: false,
      plan: {
        clips: [],
        missingHighlightIds: ['missing'],
        duplicateHighlightIds: [],
        rejectionReasons: ['Missing highlight evidence: missing'],
      },
    });
    expect(plans).toEqual([]);
  });

  it('preserves exact highlight order only when every ID has one evidence match', async () => {
    const plans: never[] = [];
    const tools = createVibeTools(context, plans);
    const result = await tools.draftEditPlan.execute?.({
      highlightIds: ['support-2', 'ace-1'], pacing: 'impact', includeContextSeconds: 2,
      transitionStyle: 'auto',
    }, {} as never);
    expect(result).toMatchObject({
      accepted: true,
      plan: {
        clips: [
          { sourceHighlightId: 'support-2', order: 0, transition: 'cut' },
          { sourceHighlightId: 'ace-1', order: 1, startTick: 872, endTick: 1_628, transition: 'flash' },
        ],
        missingHighlightIds: [],
        duplicateHighlightIds: [],
        rejectionReasons: [],
      },
    });
    expect(plans).toMatchObject([{
      kind: 'highlight_edit',
      payload: {
        demo_id: 'demo-1',
        highlight_ids: ['support-2', 'ace-1'],
        intent: { pacing: 'impact', include_context_seconds: 2, transition: 'flash' },
      },
    }]);
  });

  it('rejects duplicate requested highlight IDs without enqueueing a proposal', async () => {
    const plans: never[] = [];
    const tools = createVibeTools(context, plans);
    const result = await tools.draftEditPlan.execute?.({
      highlightIds: ['ace-1', 'ace-1'], pacing: 'measured', includeContextSeconds: 1,
      transitionStyle: 'fade',
    }, {} as never);
    expect(result).toMatchObject({
      accepted: false,
      plan: {
        clips: [],
        duplicateHighlightIds: ['ace-1'],
        rejectionReasons: ['Duplicate requested highlight IDs: ace-1'],
      },
    });
    expect(plans).toEqual([]);
  });

  it('emits only a typed HLAE intent and leaves camera compilation to Rust', async () => {
    const plans: never[] = [];
    const tools = createVibeTools(context, plans);
    const result = await tools.draftHlaePlan.execute?.({
      highlightIds: ['support-2', 'ace-1'], cameraStyle: 'orbit', mode: 'capture', leadSeconds: 2, tailSeconds: 3,
    }, {} as never);
    expect(result).toMatchObject({
      accepted: true,
      missingEvidence: [],
      plan: {
        demo_id: 'demo-1', highlight_ids: ['support-2', 'ace-1'], camera_style: 'orbit',
        mode: 'capture', lead_seconds: 2, tail_seconds: 3, requiresUserReview: true,
        rejectionReasons: [],
      },
    });
    expect(plans).toMatchObject([{
      kind: 'hlae',
      payload: {
        demo_id: 'demo-1', highlight_ids: ['support-2', 'ace-1'],
        mode: 'capture', lead_seconds: 2, tail_seconds: 3,
      },
    }]);
  });

  it('rejects a partial HLAE evidence binding without enqueueing a reduced proposal', async () => {
    const plans: never[] = [];
    const tools = createVibeTools(context, plans);
    const result = await tools.draftHlaePlan.execute?.({
      highlightIds: ['ace-1', 'missing'], cameraStyle: 'pov', mode: 'preview',
      leadSeconds: 2, tailSeconds: 2,
    }, {} as never);
    expect(result).toMatchObject({
      accepted: false,
      missingEvidence: ['missing_highlight:missing'],
      plan: {
        highlight_ids: [],
        missingHighlightIds: ['missing'],
        duplicateHighlightIds: [],
        rejectionReasons: ['Missing highlight evidence: missing'],
      },
    });
    expect(plans).toEqual([]);
  });

  it('rejects duplicate HLAE highlight IDs without enqueueing a proposal', async () => {
    const plans: never[] = [];
    const tools = createVibeTools(context, plans);
    const result = await tools.draftHlaePlan.execute?.({
      highlightIds: ['ace-1', 'ace-1'], cameraStyle: 'dolly', mode: 'preview',
      leadSeconds: 2, tailSeconds: 2,
    }, {} as never);
    expect(result).toMatchObject({
      accepted: false,
      missingEvidence: ['duplicate_highlight:ace-1'],
      plan: {
        highlight_ids: [],
        duplicateHighlightIds: ['ace-1'],
        rejectionReasons: ['Duplicate requested highlight IDs: ace-1'],
      },
    });
    expect(plans).toEqual([]);
  });

  it('executes strict local round and event queries with evidence identifiers', async () => {
    const tools = createVibeTools(context, []);
    const found = await tools.searchRounds.execute?.({
      winningSide: 'A', playerIds: ['p1'], purchasedItems: ['ak47'], roundNumbers: [7],
      eventKinds: ['kill'], maximumResults: 4,
    }, {} as never);
    expect(found).toMatchObject({ available: true, rounds: [{ evidenceId: 'round:7' }] });
    const events = await tools.readRoundEvents.execute?.({
      roundNumbers: [7], eventKinds: ['kill'], playerIds: ['p1'], maximumResults: 16,
    }, {} as never);
    expect(events).toMatchObject({ available: true, events: [{ evidenceId: 'event:kill-1', tick: 1_200 }] });
  });

  it('returns bounded matchup and highlight evidence', async () => {
    const tools = createVibeTools(context, []);
    const matchups = await tools.readPlayerMatchups.execute?.({ playerIds: ['p1'] }, {} as never);
    expect(matchups).toMatchObject({ available: true, matchups: [{ evidenceId: 'matchup:p1:p2' }] });
    const highlights = await tools.readHighlights.execute?.({
      playerIds: ['p1'], kinds: ['multi_kill'], roundNumbers: [7], minimumScore: 0, maximumResults: 8,
    }, {} as never);
    expect(highlights).toMatchObject({ available: true, highlights: [{ evidenceId: 'highlight:ace-1' }] });
  });
});
