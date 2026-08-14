export function freezeSampleIndex(
  frames: readonly { tick: number }[],
  freezeEndTick: number | null,
): number {
  return freezeEndTick === null ? -1 : frames.findIndex((frame) => frame.tick >= freezeEndTick);
}

export function replayTeamEquipmentValues(
  players: readonly { team: string; current_equipment_value?: number | null }[],
): { A: number; B: number } {
  return players.reduce((totals, player) => {
    if ((player.team === 'A' || player.team === 'B')
        && player.current_equipment_value !== null
        && player.current_equipment_value !== undefined) {
      totals[player.team] += player.current_equipment_value;
    }
    return totals;
  }, { A: 0, B: 0 });
}
