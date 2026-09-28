/*
 * pages/library — one demo's status, drawn the same way in the table, the card
 * grid and the Inspector.
 *
 * Every state is one StatusDot followed by its words: 「已就绪」 a filled ok
 * dot, 「索引中」 / 「分析中」 a filled accent dot for work in progress,
 * 「待索引」 a hollow neutral one, 「索引失败」 / 「文件缺失」 a hollow failed one.
 * One representation rather than badges for some states and dots for others,
 * so a column of mixed states scans as one list. No percentage accompanies
 * 「分析中」: `AnalysisRun` has a stage and no denominator, and §4.3 forbids
 * simulating one.
 *
 * One component rather than three copies because the copies drifted: the table
 * once painted 「已就绪」 as plain grey text while the card and the Inspector
 * kept the badge, so the same state looked different on the same screen.
 */

import { useLingui } from '@lingui/react';

import { StatusDot } from '../../../design/feedback';
import { cn } from '../../../design/primitives';
import type { DemoSummary } from '../../../shared/desktop/viewModels';
import { demoStatusMeta } from './libraryFormat';

export function DemoStatusMark({ demo }: { readonly demo: DemoSummary }) {
  const { i18n } = useLingui();
  const meta = demoStatusMeta(demo.lifecycle_status);

  return (
    <span
      data-status={meta.tone}
      className={cn('inline-flex items-center gap-2 text-xs', meta.tone === 'fail' ? 'text-fail-text' : 'text-text')}
    >
      <StatusDot status={meta.tone} size="sm" />
      {i18n._(meta.label)}
    </span>
  );
}
