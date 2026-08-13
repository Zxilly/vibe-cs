import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, EvidenceAnnotation, Highlight } from '../../shared/desktop/dto';
import {
  canonicalHighlightAnnotationItem,
  createHighlightAnnotationReviewState,
  highlightAnnotationSummary,
  loadHighlightAnnotationReviews,
} from './highlightAnnotationReview';

const highlight: Highlight = {
  id: 'fallen-r12-4k',
  label: 'FalleN 4K',
  category: 'multi-kill',
  kind: 'multi_kill',
  description: 'Four exact eliminations',
  tags: ['4k', 'awp'],
  victims: ['victim-a', 'victim-b', 'victim-c', 'victim-d'],
  player_id: 'fallen-id',
  round: 12,
  start_tick: 12_000,
  end_tick: 12_640,
  confidence: 0.95,
};

const workspace: AnalysisWorkspace = {
  demo_id: '00000000-0000-4000-8000-000000000001',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_958,
  teams: [],
  players: [
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 4, deaths: 0, assists: 0, headshot_rate: 0.25, kill_death_ratio: 4, adr: 100 },
    { id: 'victim-a', name: 'Victim A', team: 'B', kills: 0, deaths: 1, assists: 0, headshot_rate: 0, kill_death_ratio: 0, adr: 0 },
  ],
  rounds: [{
    number: 12,
    winner: 'A',
    reason: 'elimination',
    start_tick: 11_000,
    end_tick: 13_000,
    team_a_score: 7,
    team_b_score: 5,
    events: [],
  }],
  highlights: [highlight],
};

describe('highlight annotation review', () => {
  it('adapts one current highlight to its exact persisted evidence locator and deep links', () => {
    const item = canonicalHighlightAnnotationItem(workspace, highlight);

    expect(item).toMatchObject({
      evidence_id: 'demo:00000000-0000-4000-8000-000000000001/highlight:fallen-r12-4k',
      demo_id: '00000000-0000-4000-8000-000000000001',
      round: 12,
      tick: 12_000,
      end_tick: 12_640,
      source_kind: 'highlight',
      source_id: 'fallen-r12-4k',
      actor_id: 'fallen-id',
      actor_name: 'FalleN',
    });
    expect(item?.analysis_href).toContain('tab=highlights');
    expect(item?.analysis_href).toContain('evidence=demo%3A00000000-0000-4000-8000-000000000001%2Fhighlight%3Afallen-r12-4k');
    expect(item?.replay_href).toContain('tab=replay');
    expect(item?.replay_href).toContain('tick=12000');
  });

  it('fails closed when the highlight is unknown, stale, or has no persistable locator', () => {
    expect(canonicalHighlightAnnotationItem(workspace, {
      ...highlight,
      id: 'unknown-highlight',
    })).toBeNull();
    expect(canonicalHighlightAnnotationItem(workspace, {
      ...highlight,
      start_tick: highlight.start_tick + 1,
    })).toBeNull();
    expect(canonicalHighlightAnnotationItem({
      ...workspace,
      highlights: [{ ...highlight, round: 0 }],
    }, { ...highlight, round: 0 })).toBeNull();
    expect(canonicalHighlightAnnotationItem({
      ...workspace,
      demo_id: 'not-a-current-demo-uuid',
    }, highlight)).toBeNull();
  });

  it('reports persisted open and resolved review state only for the exact canonical locator', () => {
    const item = canonicalHighlightAnnotationItem(workspace, highlight)!;
    const annotation = (
      overrides: Partial<EvidenceAnnotation>,
    ): EvidenceAnnotation => ({
      id: 'annotation-open',
      demo_id: item.demo_id,
      evidence_id: item.evidence_id,
      round: item.round,
      tick: item.tick,
      body: 'Review the spacing',
      tags: ['spacing'],
      review_state: 'open',
      created_at: '2026-08-13T04:00:00Z',
      updated_at: '2026-08-13T04:00:00Z',
      ...overrides,
    });

    expect(highlightAnnotationSummary(item, [
      annotation({}),
      annotation({ id: 'annotation-resolved', review_state: 'resolved' }),
      annotation({ id: 'wrong-tick', tick: item.tick + 1 }),
      annotation({ id: 'wrong-demo', demo_id: 'other-demo' }),
    ])).toEqual({ total: 2, open: 1, resolved: 1 });
  });

  it('ignores a stale response after the selected canonical highlight changes', async () => {
    let resolveOld: ((value: string) => void) | undefined;
    const oldRequest = new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
    const requests = createHighlightAnnotationReviewState();
    const oldResult = requests.acceptCurrent('demo:00000000-0000-4000-8000-000000000001/highlight:old', oldRequest);

    expect(requests.select('demo:00000000-0000-4000-8000-000000000001/highlight:current')).toBe(true);
    resolveOld?.('stale');

    await expect(oldResult).resolves.toBeNull();
    await expect(requests.acceptCurrent(
      'demo:00000000-0000-4000-8000-000000000001/highlight:current',
      Promise.resolve('fresh'),
    )).resolves.toBe('fresh');
  });

  it('loads every persisted annotation page for one exact demo', async () => {
    const queries: unknown[] = [];
    const annotation = (id: string): EvidenceAnnotation => ({
      id,
      demo_id: workspace.demo_id,
      evidence_id: `demo:${workspace.demo_id}/highlight:${highlight.id}`,
      round: highlight.round,
      tick: highlight.start_tick,
      body: id,
      tags: [],
      review_state: 'open',
      created_at: '2026-08-13T04:00:00Z',
      updated_at: '2026-08-13T04:00:00Z',
    });
    const pages = [
      { items: [annotation('annotation-1')], total: 2, page: 1, page_size: 1 },
      { items: [annotation('annotation-2')], total: 2, page: 2, page_size: 1 },
    ];

    const items = await loadHighlightAnnotationReviews({
      listEvidenceAnnotations: async (query) => {
        queries.push(query);
        return pages[(query.page ?? 1) - 1]!;
      },
    }, workspace.demo_id, undefined, 1);

    expect(items.map((item) => item.id)).toEqual(['annotation-1', 'annotation-2']);
    expect(queries).toEqual([
      { demo_id: workspace.demo_id, page: 1, page_size: 1 },
      { demo_id: workspace.demo_id, page: 2, page_size: 1 },
    ]);
  });
});
