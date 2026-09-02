/*
 * Domain layer, 2 of 3 — match/, the shared test fixtures.
 *
 * The 「03 比赛工作区」 match, verbatim: Aurora 13 : 11 Meridian on Mirage, 24
 * rounds, round 21 the 1v3 clutch. Using the artboard's own data in the tests
 * means a test that fails says "the artboard says otherwise", not "the number I
 * made up moved".
 *
 * Not imported by any component, and named after the `collapse.testing.ts`
 * precedent in `design/layout` so both test projects can share it; `lingui.config.ts`
 * excludes `**\/test\/**` and `*.test.*` from extraction, so the copy here would
 * otherwise reach the catalog — which is why nothing in this file goes through a
 * macro. Every string is a plain literal, and a plain literal in a `ReactNode`
 * slot renders as itself.
 */

import type { EvidenceItem, HighlightCandidate, MatchIdentity, RoundSummary, TeamScore } from './types';
import type { RoundEndReason, RoundWinner } from './matchEnums';

export const MATCH: MatchIdentity = {
  demoId: 'demo-aurora-meridian',
  mapName: 'Mirage',
  mapCode: 'MRG',
  playedAt: '2026-08-14',
  roundCount: 24,
  tickRate: 64,
};

export const TEAM_A: TeamScore = { id: 'aurora', name: 'Aurora', side: 'ct', score: 13 };
export const TEAM_B: TeamScore = { id: 'meridian', name: 'Meridian', side: 't', score: 11 };

/** The reference's 24-round strip: 1 A, 2 B, 3 A, 4 A, 5 B, … 21 A (selected). */
const WINNERS = 'ABAABBAABAABBABABABBAABA';

const REASONS: readonly RoundEndReason[] = [
  'elimination',
  'bomb-exploded',
  'bomb-defused',
  'time-expired',
];

export const ROUNDS: readonly RoundSummary[] = Array.from(WINNERS, (letter, index) => {
  const winner: RoundWinner = letter === 'A' ? 'a' : 'b';
  const number = index + 1;
  return {
    number,
    winner,
    reason: REASONS[index % REASONS.length] ?? 'unknown',
    startTick: 6000 * number,
    endTick: 6000 * number + 5200,
    ...(number === 21 ? { key: true } : {}),
  };
});

/** 「Kael → Sable · AK-47 · 爆头」 at tick 148920, the Inspector's first row. */
export const EVIDENCE: EvidenceItem = {
  id: 'ev-148920',
  tick: 148_920,
  kind: 'kill',
  actor: 'Kael',
  target: 'Sable',
  weapon: 'AK-47',
  description: '爆头',
  context: 'A 点连接处 · 距离 12.4m',
  round: 21,
  matchLabel: 'Aurora vs Meridian',
  annotation: { label: '待处理' },
  tickRate: 64,
};

/** 「1v3 残局 · Kael · 三杀后拆包，剩余 1.8 秒 · 148 920–150 440」 */
export const HIGHLIGHT: HighlightCandidate = {
  id: 'hl-r21-clutch',
  kind: 'clutch',
  playerId: 'kael',
  label: '1v3 残局',
  round: 21,
  subject: 'Kael',
  description: '三杀后拆包，剩余 1.8 秒',
  startTick: 148_920,
  endTick: 150_440,
  tags: ['赛点'],
  tickRate: 64,
};
