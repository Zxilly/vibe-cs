import { describe, expect, it } from 'vitest';

import type { MatchHistoryItem } from '../../shared/api/dto';
import { matchesCsv } from './MatchHistoryPage';

describe('matchesCsv', () => {
  it('quotes every cell and neutralizes spreadsheet formulas', () => {
    const match: MatchHistoryItem = {
      id: 'record-id',
      steam_id: '76561198000000000',
      match_id: '=unsafe',
      outcome_id: '2',
      token: 3,
      map_name: 'de_mirage',
      played_at: '2026-08-10T10:00:00Z',
      score: '13:9',
      result: 'win',
      demo_status: 'available',
      demo_id: null,
      last_error: null,
      synced_at: '2026-08-10T10:00:00Z',
      updated_at: '2026-08-10T10:00:00Z',
    };

    const csv = matchesCsv([match]);

    expect(csv).toContain('"\'=unsafe"');
    expect(csv).toContain('"de_mirage"');
    expect(csv).toContain('\r\n');
  });
});
