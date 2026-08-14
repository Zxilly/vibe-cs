import { describe, expect, it } from 'vitest';

import { freezeSampleIndex, replayTeamEquipmentValues } from './replayEconomy';

describe('replay economy truth', () => {
  it('uses the exact sample at or immediately after freeze end without interpolation', () => {
    expect(freezeSampleIndex([{ tick: 100 }, { tick: 116 }, { tick: 132 }], 116)).toBe(1);
    expect(freezeSampleIndex([{ tick: 100 }, { tick: 116 }, { tick: 132 }], 110)).toBe(1);
    expect(freezeSampleIndex([{ tick: 100 }], null)).toBe(-1);
  });

  it('sums only verified current equipment values by stable Team A/B', () => {
    expect(replayTeamEquipmentValues([
      { team: 'A', current_equipment_value: 4_000 },
      { team: 'A', current_equipment_value: null },
      { team: 'B', current_equipment_value: 3_000 },
      { team: 'T', current_equipment_value: 99_999 },
    ])).toEqual({ A: 4_000, B: 3_000 });
  });
});
