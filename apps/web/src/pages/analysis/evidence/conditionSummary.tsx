/*
 * pages/evidence — the active conditions, in one sentence.
 *
 * `design/data/Empty`'s `no-hits` preset keeps only the general advice and
 * leaves 「当前条件：选手 Kael ＋ 穿墙 ＋ 近 7 天」 to the page, because that half
 * is a rendering of live state. This is that half, and it is a separate module
 * from `EvidenceConditions` because the *chips* and the *sentence* have
 * different jobs: a chip is a control and needs a remove affordance, a sentence
 * is read once inside an empty state.
 *
 * The joining word is 「＋」, verbatim from the artboard, and the fields keep the
 * order `activeConditions` produced — which is the order the chips are drawn
 * in, so the sentence and the strip read the same way round.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import type { EvidenceCondition } from './evidenceSearchParams';

function label(condition: EvidenceCondition): ReactNode {
  switch (condition.field) {
    case 'family':
      return <Trans>种类 {condition.value}</Trans>;
    case 'q':
      return <Trans>关键词 {condition.value}</Trans>;
    case 'player':
      return <Trans>选手 {condition.value}</Trans>;
    case 'map':
      return <Trans>地图 {condition.value}</Trans>;
    case 'weapon':
      return <Trans>武器 {condition.value}</Trans>;
    case 'headshot':
      return <Trans>仅爆头</Trans>;
    case 'from':
      return <Trans>不早于 {condition.value}</Trans>;
    case 'to':
      return <Trans>不晚于 {condition.value}</Trans>;
  }
}

export function conditionSummaryText(conditions: readonly EvidenceCondition[]): ReactNode {
  return (
    <span data-condition-summary="">
      {conditions.map((condition, index) => (
        <span key={condition.field}>
          {index > 0 ? ' ＋ ' : null}
          {label(condition)}
        </span>
      ))}
    </span>
  );
}
