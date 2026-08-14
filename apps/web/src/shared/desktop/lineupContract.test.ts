import { describe, expect, it } from 'vitest';

import { parseLineupDirectoryPage, parseLineupMapPage } from './lineupContract';

const lineup = 'a'.repeat(64);
const opponent = 'b'.repeat(64);
const members = Array.from({ length: 5 }, (_, index) => `7656119800000000${index + 1}`);
const coverage = { evaluated_demos: 3, verified_demos: 3, total_analyses: 3, projection_complete: true };

describe('local lineup current contract', () => {
  it('accepts exact five-member directory and map truth', () => {
    const directory = parseLineupDirectoryPage({ items: [{ lineup_id: lineup, members, maps: 3, wins: 2, losses: 1, ties: 0, rounds_for: 35, rounds_against: 28 }], total: 1, page: 1, page_size: 20, coverage });
    expect(directory.items[0]?.members).toHaveLength(5);
    const maps = parseLineupMapPage({ lineup_id: lineup, members, items: [{ demo_id: '11111111-1111-4111-8111-111111111111', map_name: 'de_mirage', match_date: null, cataloged_at: '2026-08-14T00:00:00Z', opponent_lineup_id: opponent, team_slot: 'A', rounds_for: 13, rounds_against: 8 }], total: 1, page: 1, page_size: 20, coverage }, lineup);
    expect(maps.items[0]?.match_date).toBeNull();
  });

  it('rejects partial rosters, aggregate lies, and identity mismatch', () => {
    expect(() => parseLineupDirectoryPage({ items: [{ lineup_id: lineup, members: members.slice(0, 4), maps: 3, wins: 2, losses: 1, ties: 0, rounds_for: 35, rounds_against: 28 }], total: 1, page: 1, page_size: 20, coverage })).toThrow();
    expect(() => parseLineupDirectoryPage({ items: [{ lineup_id: lineup, members, maps: 4, wins: 2, losses: 1, ties: 0, rounds_for: 35, rounds_against: 28 }], total: 1, page: 1, page_size: 20, coverage })).toThrow();
    expect(() => parseLineupMapPage({ lineup_id: opponent, members, items: [], total: 0, page: 1, page_size: 20, coverage }, lineup)).toThrow();
  });
});
