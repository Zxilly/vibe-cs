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
    }],
    insights: {
      round_economy: [{ round: 7, teams: [{ team: 'A', items: [{ name: 'ak47', count: 1 }] }] }],
      matchups: [{ player_id: 'p1', opponent_id: 'p2', kills: 2, deaths: 0 }],
    },
  },
  editorProject: { id: 'project-1', revision: 3, tracks: [] },
  audioAnalysis: null,
  beatAlignmentDraft: null,
};

describe('Vibe CS agent tools', () => {
  it('grounds edit plans in known highlight IDs', async () => {
    const plans: never[] = [];
    const tools = createVibeTools(context, plans);
    const result = await tools.draftEditPlan.execute?.({
      highlightIds: ['ace-1', 'missing'], pacing: 'impact', includeContextSeconds: 2,
    }, {} as never);
    expect(result).toMatchObject({ accepted: true, plan: { missingHighlightIds: ['missing'] } });
    expect(plans).toHaveLength(1);
  });

  it('emits only a typed HLAE intent and leaves camera compilation to Rust', async () => {
    const plans: never[] = [];
    const tools = createVibeTools(context, plans);
    const result = await tools.draftHlaePlan.execute?.({
      highlightIds: ['ace-1'], cameraStyle: 'orbit', leadSeconds: 2, tailSeconds: 2,
    }, {} as never);
    expect(result).toMatchObject({
      accepted: true,
      missingEvidence: [],
      plan: {
        demo_id: 'demo-1', highlight_ids: ['ace-1'], camera_style: 'orbit',
        mode: 'preview', requiresUserReview: true,
      },
    });
    expect(plans).toMatchObject([{ kind: 'hlae', payload: { demo_id: 'demo-1', mode: 'preview' } }]);
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
