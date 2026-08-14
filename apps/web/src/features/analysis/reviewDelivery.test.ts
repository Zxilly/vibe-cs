import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, LlmReviewResult } from '../../shared/desktop/dto';
import { buildReviewDelivery } from './reviewDelivery';

const workspace: AnalysisWorkspace = {
  demo_id: '11111111-1111-4111-8111-111111111111',
  map_name: 'de_mirage<script>alert(1)</script>',
  tick_rate: 64,
  duration_seconds: 1200,
  teams: [
    { side: 'A', name: 'A', score: 13, players: ['76561198000000001'] },
    { side: 'B', name: 'B', score: 8, players: [] },
  ],
  players: [{
    id: '76561198000000001', name: '<b>Alice</b>', team: 'A', kills: 20, deaths: 10,
    assists: 4, headshot_rate: 0.45, kill_death_ratio: 2, adr: 85,
  }],
  rounds: [],
  highlights: [],
};
const review: LlmReviewResult = {
  demo_id: workspace.demo_id,
  scope: 'match',
  player_id: null,
  highlight_ids: [],
  tone: 'analytical',
  commentary: '<img src=x onerror=alert(1)> 保持中路控制',
  evidence_ids: ['demo:11111111-1111-4111-8111-111111111111/round:7'],
  evidence_sha256: 'a'.repeat(64),
  provider: 'local',
  model: 'review-model',
  generated_at: '2026-08-14T08:00:00Z',
  cached: false,
};

const labels = {
  matchResult: 'Match result',
  team: 'Team',
  score: 'Score',
  playerPerformance: 'Player performance',
  player: 'Player',
  aiReview: 'AI review',
  highlights: 'Highlights',
  noHighlights: 'No highlights',
  evidenceReferences: 'Evidence references',
  noEvidence: 'No evidence',
};

describe('review delivery', () => {
  it('builds an escaped standalone report with exact producer lineage', () => {
    const delivery = buildReviewDelivery({
      workspace,
      review,
      producerRunId: '22222222-2222-4222-8222-222222222222',
      labels,
    });

    expect(delivery.fileName).toMatch(/^vibe-cs-review-mirage-/);
    expect(delivery.html).toContain('22222222-2222-4222-8222-222222222222');
    expect(delivery.html).toContain('a'.repeat(64));
    expect(delivery.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(delivery.html).toContain('&lt;b&gt;Alice&lt;/b&gt;');
    expect(delivery.html).not.toContain('<script>alert(1)</script>');
  });

  it('rejects a review that belongs to another Demo', () => {
    expect(() => buildReviewDelivery({
      workspace,
      review: { ...review, demo_id: '33333333-3333-4333-8333-333333333333' },
      producerRunId: '22222222-2222-4222-8222-222222222222',
      labels,
    })).toThrow(/same Demo/i);
  });
});
