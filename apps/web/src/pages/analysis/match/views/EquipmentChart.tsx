import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { cn } from '../../../../design/primitives';
import { equipmentPath, equipmentX, equipmentY, type EquipmentRound } from './equipmentModel';

export function EquipmentChart({ rounds, activeRound, teamA, teamB, onSelect }: {
  readonly rounds: readonly EquipmentRound[];
  readonly activeRound: number;
  readonly teamA: string;
  readonly teamB: string;
  readonly onSelect: (round: number) => void;
}) {
  const maximum = Math.max(10_000, Math.ceil(Math.max(...rounds.flatMap((round) => [round.a ?? 0, round.b ?? 0])) / 10_000) * 10_000);
  const selectedIndex = rounds.findIndex((round) => round.round === activeRound);
  const available = rounds.some((round) => round.a !== null || round.b !== null);
  return (
    <div className="px-4 pb-3" data-equipment-chart>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <span className="text-neutral-600"><Trans>冻结结束装备价值（$）</Trans></span>
        <span className="flex gap-4"><span className="text-accent">━ {teamA}</span><span className="text-team-b">━ {teamB}</span></span>
      </div>
      <div className="overflow-x-auto">
      <div style={{ minWidth: Math.max(0, rounds.length - 1) * 20 + 72 }}>
      {available ? <svg viewBox="0 0 624 218" className="block w-full" role="img" aria-label={t`两队逐回合装备价值`}>
        {selectedIndex < 0 ? null : <rect x={equipmentX(selectedIndex, rounds.length) - 8} y={28} width={16} height={176} className="fill-accent-100" />}
        {[0, 1, 2, 3].map((index) => {
          const value = maximum * index / 3;
          const y = equipmentY(value, maximum);
          return <g key={index}><line x1={48} x2={600} y1={y} y2={y} className="stroke-divider" /><text x={38} y={y + 4} textAnchor="end" className="fill-neutral-600 font-mono text-xs">{value === 0 ? '0' : `${Number((value / 1000).toFixed(1))}k`}</text></g>;
        })}
        <path d={equipmentPath(rounds.map((round) => round.a), maximum)} fill="none" className="stroke-accent" strokeWidth={2} />
        <path d={equipmentPath(rounds.map((round) => round.b), maximum)} fill="none" className="stroke-team-b" strokeWidth={2} />
        {rounds.map((round, index) => <g key={round.round}>
          {round.a === null ? null : <circle cx={equipmentX(index, rounds.length)} cy={equipmentY(round.a, maximum)} r={2} className="fill-accent" />}
          {round.b === null ? null : <circle cx={equipmentX(index, rounds.length)} cy={equipmentY(round.b, maximum)} r={2} className="fill-team-b" />}
        </g>)}
      </svg> : <p className="flex min-h-40 items-center justify-center text-sm text-neutral-600"><Trans>暂无装备价值数据</Trans></p>}
      <div className="relative h-12" style={{ marginLeft: `${48 / 624 * 100}%`, marginRight: `${24 / 624 * 100}%` }} aria-label={t`选择经济回合`}>
        {rounds.map((round, index) => <button key={round.round} type="button" onClick={() => onSelect(round.round)}
          style={{ left: `${rounds.length === 1 ? 50 : index / (rounds.length - 1) * 100}%` }}
          aria-label={t`第 ${round.round} 回合装备`} aria-pressed={round.round === activeRound}
          className={cn('absolute top-1 flex w-5 -translate-x-1/2 flex-col items-center gap-2 rounded-sm px-0.5 py-1 font-mono text-xs hover:bg-surface', round.round === activeRound ? 'bg-accent-100 text-accent-700' : 'text-neutral-600')}>
          {round.round}<span aria-hidden="true" className={cn('h-1 w-full rounded-sm', round.winner === 'A' ? 'bg-accent' : round.winner === 'B' ? 'bg-team-b' : 'bg-divider')} />
        </button>)}
      </div>
      </div>
      </div>
      <div className="flex justify-between text-xs text-neutral-600"><span><Trans>胜方</Trans></span><span><Trans>回合</Trans></span></div>
    </div>
  );
}
