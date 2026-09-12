import { msg } from '@lingui/core/macro';
import type { EquipmentBuyType } from '../../../../shared/desktop/generated/EquipmentBuyType';
import type { AnalysisWorkspace } from '../../../../shared/desktop/viewModels';

export interface EquipmentRound {
  readonly round: number;
  readonly freezeEndTick: number | null;
  readonly winner: 'A' | 'B' | null;
  readonly a: number | null;
  readonly b: number | null;
  readonly aBuyType: EquipmentBuyType | null;
  readonly bBuyType: EquipmentBuyType | null;
}

export function equipmentRounds(analysis: AnalysisWorkspace): readonly EquipmentRound[] {
  const byRound = new Map(analysis.insights?.round_economy.map((row) => [row.round, row]));
  return [...analysis.rounds].sort((a, b) => a.number - b.number).map((round) => {
    const record = byRound.get(round.number);
    const a = record?.team_equipment.find((team) => team.team === 'A');
    const b = record?.team_equipment.find((team) => team.team === 'B');
    return {
      round: round.number,
      freezeEndTick: record?.freeze_end_tick ?? null,
      winner: round.winner === 'A' || round.winner === 'B' ? round.winner : null,
      a: a?.equipment_value ?? null,
      b: b?.equipment_value ?? null,
      aBuyType: a?.buy_type ?? null,
      bBuyType: b?.buy_type ?? null,
    };
  });
}

export function equipmentPath(values: readonly (number | null)[], maximum: number): string {
  let connected = false;
  return values.flatMap((value, index) => {
    if (value === null) { connected = false; return []; }
    const command = connected ? 'L' : 'M';
    connected = true;
    return [`${command}${equipmentX(index, values.length)},${equipmentY(value, maximum)}`];
  }).join(' ');
}

export const equipmentX = (index: number, count: number) => count === 1 ? 324 : 48 + index / (count - 1) * 552;
export const equipmentY = (value: number, maximum: number) => 196 - value / maximum * 160;

export const BUY_TYPE_LABEL = {
  pistol: msg`手枪局`,
  eco: msg`经济局`,
  semi_buy: msg`半起`,
  force_buy: msg`强起`,
  full_buy: msg`全起`,
} satisfies Record<EquipmentBuyType, ReturnType<typeof msg>>;
