import { describe, expect, it } from 'vitest';

import type { EvidenceSearchItem, EvidenceSearchQuery } from '../../shared/desktop/dto';
import {
  evidenceSearchQueryFromParameters,
  evidenceSearchParameters,
  evidenceSearchResultHref,
  visibleEvidenceAttributes,
} from './evidenceSearchPresentation';

const item: EvidenceSearchItem = {
  evidence_id: 'demo:major-1/event:kill-160986',
  demo_id: 'major-1',
  demo_display_name: 'FURIA vs Falcons · Map 1',
  map_name: 'de_mirage',
  match_date: '2026-06-22T18:00:00Z',
  round: 20,
  tick: 160_986,
  end_tick: 160_986,
  event_type: 'kill',
  actor_id: 'fallen-id',
  actor_name: 'FalleN',
  target_id: 'niko-id',
  target_name: 'NiKo',
  weapon: 'awp',
  headshot: false,
  penetrated: true,
  source_kind: 'event',
  source_id: 'kill-160986',
  attributes: { position: [100, 200, 0], ignored: 'not a public badge' },
  analysis_href: '/analysis?demo=major-1&tab=rounds&round=20&tick=160986',
  replay_href: '/analysis?demo=major-1&tab=replay&round=20&tick=160986',
};

describe('evidence search presentation', () => {
  it('keeps an empty shareable URL unfiltered so product defaults can show a dense result page', () => {
    expect(evidenceSearchQueryFromParameters(new URLSearchParams())).toEqual({});
  });

  it('serializes only explicit bounded filters and preserves false booleans', () => {
    const query: EvidenceSearchQuery = {
      q: '  FalleN   ',
      event_family: 'kill',
      actor: '',
      weapon: 'AWP',
      headshot: false,
      round: 20,
      page: 2,
      page_size: 50,
    };

    expect(evidenceSearchParameters(query).toString()).toBe(
      'q=FalleN&event_family=kill&weapon=AWP&headshot=false&round=20&page=2&page_size=50',
    );
  });

  it('builds an exact hash-router link from the evidence identity rather than trusting server navigation text', () => {
    expect(evidenceSearchResultHref(item, 'rounds')).toBe(
      '/analysis?demo=major-1&tab=rounds&round=20&tick=160986&evidence=demo%3Amajor-1%2Fevent%3Akill-160986&player=fallen-id',
    );
    expect(evidenceSearchResultHref(item, 'replay')).toContain('tab=replay');
  });

  it('shows only evidence-backed event attributes', () => {
    expect(visibleEvidenceAttributes(item)).toEqual(['penetrated']);
  });

  it('restores only bounded filters from a shareable URL', () => {
    expect(evidenceSearchQueryFromParameters(new URLSearchParams(
      'q=FalleN&event_family=kill&headshot=false&round=20&page=999999&page_size=500&unknown=x',
    ))).toEqual({
      q: 'FalleN',
      event_family: 'kill',
      headshot: false,
      round: 20,
      page: 100_000,
      page_size: 100,
    });
  });
});
