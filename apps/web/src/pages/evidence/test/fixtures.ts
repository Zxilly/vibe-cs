/*
 * Test fixtures for `pages/evidence`.
 *
 * Under `test/` so `lingui.config.ts` excludes it from the message catalogue —
 * the Chinese strings here are fixture data (a demo's display name, an
 * annotation body), not product copy, and extracting them would demand an
 * English translation for a sentence no user can reach. Same rule
 * `data/test/renderDataHook.tsx` follows.
 *
 * The numbers come from `domain/densityFixtures.ts` where one exists — 47 hits
 * and 1 284 632 normalised rows are both printed on 「05 证据检索」.
 */

import type {
  EvidenceAnnotation,
  EvidenceSearchItem,
  EvidenceSearchResponse,
} from '../../../shared/desktop/dto';

/** The artboard's first row: 08-14 · Aurora vs Meridian · Mirage · R21 ·
 *  Kael → Corvin · AK-47 · 穿墙 · tick 149380. */
export function evidenceItem(overrides: Partial<EvidenceSearchItem> = {}): EvidenceSearchItem {
  return {
    evidence_id: 'demo:aurora/event:e-1',
    demo_id: 'aurora',
    demo_display_name: 'Aurora vs Meridian',
    map_name: 'de_mirage',
    match_date: '2026-08-14T20:11:00Z',
    round: 21,
    tick: 149_380,
    end_tick: 149_380,
    event_type: 'kill',
    actor_id: 'STEAM_KAEL',
    actor_name: 'Kael',
    target_id: 'STEAM_CORVIN',
    target_name: 'Corvin',
    weapon: 'AK-47',
    headshot: true,
    penetrated: true,
    source_kind: 'event',
    source_id: 'e-1',
    attributes: { position: [-1200, 640, 64] },
    analysis_href: '/demos/aurora/analysis',
    replay_href: '/demos/aurora/replay',
    ...overrides,
  };
}

export function evidenceItems(count: number): EvidenceSearchItem[] {
  return Array.from({ length: count }, (_, index) =>
    evidenceItem({
      evidence_id: `demo:aurora/event:e-${String(index)}`,
      round: (index % 24) + 1,
      tick: 100_000 + index * 137,
      target_name: `Corvin-${String(index % 5)}`,
    }),
  );
}

export function evidenceResponse(
  overrides: Partial<EvidenceSearchResponse> = {},
): EvidenceSearchResponse {
  return {
    items: evidenceItems(8),
    total: 47,
    page: 1,
    page_size: 20,
    availability: {
      indexed_items: 1_284_632,
      indexed_demos: 248,
      total_analyses: 248,
      scan_complete: true,
      match_date: { available: true, indexed_items: 1_284_632, reason: null },
      source: { available: true, indexed_items: 1_284_632, reason: null },
    },
    ...overrides,
  };
}

export function annotation(overrides: Partial<EvidenceAnnotation> = {}): EvidenceAnnotation {
  return {
    id: 'ann-1',
    demo_id: 'aurora',
    evidence_id: 'demo:aurora/event:e-1',
    round: 21,
    tick: 149_380,
    body: '这堵墙的穿点可以单独做一条教学。',
    tags: ['教学'],
    review_state: 'open',
    created_at: '2026-08-14T21:00:00Z',
    updated_at: '2026-08-14T21:00:00Z',
    ...overrides,
  };
}
