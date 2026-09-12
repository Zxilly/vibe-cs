import { describe, expect, it } from 'vitest';
import { equipmentPath, equipmentRounds } from './equipmentModel';
import { ANALYSIS, INSIGHTS } from './test/matchFixture';

describe('round equipment presentation', () => {
  it('uses stable A/B snapshots and the backend buy classification', () => {
    const rows = equipmentRounds({
      ...ANALYSIS,
      insights: {
        ...INSIGHTS,
        round_economy: [{
          round: 1, freeze_end_tick: 120, unattributed_purchase_count: 0,
          team_equipment: [
            { team: 'B', side: 'T', equipment_value: 21_000, buy_type: 'full_buy' },
            { team: 'A', side: 'CT', equipment_value: 25_000, buy_type: 'full_buy' },
          ],
          teams: [
            { team: 'T', purchase_count: 3, items: [], spend: 1_200 },
            { team: 'CT', purchase_count: 7, items: [], spend: 2_800 },
          ],
        }],
      },
    });
    expect(rows[0]).toMatchObject({ a: 25_000, b: 21_000, aBuyType: 'full_buy', bBuyType: 'full_buy' });
    expect(rows[1]).toMatchObject({ a: null, b: null, freezeEndTick: null, aBuyType: null, bBuyType: null });
  });

  it('breaks curves across missing samples and preserves genuine zero equipment', () => {
    const path = equipmentPath([10_000, null, 0, 20_000], 30_000);
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path.match(/L/g)).toHaveLength(1);
    expect(path).not.toContain('NaN');
    expect(equipmentPath([null, null], 10_000)).toBe('');
  });
});
