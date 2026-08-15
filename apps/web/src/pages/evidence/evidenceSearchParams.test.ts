/*
 * `unit` project — the address bar is the search form (§4.4).
 *
 * The round trip is what the deep-link promise rests on: if reading a URL and
 * writing it back changed the state, 「把这条链接发给别人」 would not reproduce
 * the result set, and the back button would land somewhere the user never was.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_EVIDENCE_SEARCH,
  EVIDENCE_PAGE_SIZE,
  RECENT_WINDOW_DAYS,
  activeConditions,
  clearedConditions,
  isoDaysAgo,
  readEvidenceSearch,
  toEvidenceQuery,
  withoutCondition,
  writeEvidenceSearch,
  type EvidenceSearchState,
} from './evidenceSearchParams';

function read(search: string): EvidenceSearchState {
  return readEvidenceSearch(new URLSearchParams(search));
}

describe('reading the URL', () => {
  it('opens on the evidence view with no conditions', () => {
    expect(read('')).toEqual(EMPTY_EVIDENCE_SEARCH);
  });

  it('takes every condition off the query string', () => {
    expect(
      read('view=annotations&family=kill&q=穿墙&player=Kael&weapon=AK-47&map=de_mirage&headshot=1&from=2026-07-16&to=2026-08-15&page=3&evidence=e-1'),
    ).toEqual({
      view: 'annotations',
      family: 'kill',
      q: '穿墙',
      player: 'Kael',
      weapon: 'AK-47',
      map: 'de_mirage',
      headshot: true,
      from: '2026-07-16',
      to: '2026-08-15',
      page: 3,
      evidenceId: 'e-1',
    });
  });

  it('falls back rather than rendering nothing for a value it does not know', () => {
    expect(read('view=nonsense').view).toBe('evidence');
    expect(read('family=nonsense').family).toBe('all');
  });

  it('drops a half-typed date instead of sending it', () => {
    // The service would reject `2026-08` and the page would blame the query.
    expect(read('from=2026-08').from).toBe('');
    expect(read('from=yesterday').from).toBe('');
    expect(read('from=2026-08-15').from).toBe('2026-08-15');
  });

  it('clamps a page number that cannot address a page', () => {
    expect(read('page=0').page).toBe(1);
    expect(read('page=-4').page).toBe(1);
    expect(read('page=abc').page).toBe(1);
    expect(read('page=7').page).toBe(7);
  });

  it('trims, so a copied link with a stray space is the same search', () => {
    expect(read('player=%20Kael%20').player).toBe('Kael');
  });
});

describe('writing the URL', () => {
  it('writes nothing for a default state — a bare /evidence stays bare', () => {
    expect(writeEvidenceSearch(EMPTY_EVIDENCE_SEARCH).toString()).toBe('');
  });

  it('round-trips every field', () => {
    const state = read('view=annotations&family=objective&q=a&player=b&weapon=c&map=d&headshot=1&from=2026-01-02&to=2026-03-04&page=5&evidence=f');
    expect(readEvidenceSearch(writeEvidenceSearch(state))).toEqual(state);
  });

  it('is stable: the same state always produces the same string', () => {
    const state = read('map=d&player=b&q=a');
    expect(writeEvidenceSearch(state).toString()).toBe(writeEvidenceSearch(state).toString());
  });
});

describe('the IPC query', () => {
  it('always carries the page and the page size', () => {
    expect(toEvidenceQuery(EMPTY_EVIDENCE_SEARCH)).toEqual({
      page: 1,
      page_size: EVIDENCE_PAGE_SIZE,
    });
  });

  it('omits an absent condition rather than sending undefined', () => {
    // `{ q: undefined }` and `{}` are two different cache entries — data/keys.ts.
    const query = toEvidenceQuery(EMPTY_EVIDENCE_SEARCH);
    expect(Object.keys(query).sort()).toEqual(['page', 'page_size']);
  });

  it('never sends the synthetic `all` family', () => {
    expect(toEvidenceQuery({ ...EMPTY_EVIDENCE_SEARCH, family: 'all' })).not.toHaveProperty(
      'event_family',
    );
    expect(toEvidenceQuery({ ...EMPTY_EVIDENCE_SEARCH, family: 'kill' })).toMatchObject({
      event_family: 'kill',
    });
  });

  it('maps the date chips onto the DTO field names', () => {
    expect(
      toEvidenceQuery({ ...EMPTY_EVIDENCE_SEARCH, from: '2026-07-16', to: '2026-08-15' }),
    ).toMatchObject({ match_date_from: '2026-07-16', match_date_to: '2026-08-15' });
  });

  it('sends headshot only when it is on — false is the absence of the filter', () => {
    expect(toEvidenceQuery(EMPTY_EVIDENCE_SEARCH)).not.toHaveProperty('headshot');
    expect(toEvidenceQuery({ ...EMPTY_EVIDENCE_SEARCH, headshot: true })).toMatchObject({
      headshot: true,
    });
  });
});

describe('the condition chips', () => {
  it('lists only what the user set, in the artboard s order', () => {
    const state = read('family=kill&player=Kael&headshot=1&from=2026-07-16');
    expect(activeConditions(state).map((condition) => condition.field)).toEqual([
      'family',
      'player',
      'headshot',
      'from',
    ]);
  });

  it('returns to page 1 when a chip is removed', () => {
    const state = read('player=Kael&map=de_mirage&page=6&evidence=e-1');
    const next = withoutCondition(state, 'map');
    expect(next.map).toBe('');
    expect(next.player).toBe('Kael');
    expect(next.page).toBe(1);
    // The Inspector cannot keep describing a row the new result set may not hold.
    expect(next.evidenceId).toBe('');
  });

  it('clears the family back to `all` rather than to an empty string', () => {
    expect(withoutCondition(read('family=kill'), 'family').family).toBe('all');
  });

  it('keeps the view when everything else is cleared', () => {
    const cleared = clearedConditions(read('view=annotations&player=Kael&page=4'));
    expect(cleared).toEqual({ ...EMPTY_EVIDENCE_SEARCH, view: 'annotations' });
  });
});

describe('the 近 30 天 chip', () => {
  it('is 30 days back, in UTC, as YYYY-MM-DD', () => {
    expect(isoDaysAgo(new Date('2026-08-15T08:40:00Z'), RECENT_WINDOW_DAYS)).toBe('2026-07-16');
  });

  it('does not move with the reader s timezone — a shared link must not', () => {
    // Both instants are the same moment; the boundary must not depend on how it
    // was spelled.
    expect(isoDaysAgo(new Date('2026-08-15T00:00:00Z'), 1)).toBe(
      isoDaysAgo(new Date('2026-08-14T24:00:00Z'), 1),
    );
  });
});
