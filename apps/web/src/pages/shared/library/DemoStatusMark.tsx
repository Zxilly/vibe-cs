/*
 * pages/library — one demo's status, drawn the same way in the table, the card
 * grid and the Inspector.
 *
 * A tag reads as a terminal state and a dot as a live one, which is what the
 * artboard draws: 「已就绪」 and 「待索引」 are `Badge`s (accent for the state the
 * row has reached, neutral for the one it is waiting in), 「索引中」 / 「分析中」
 * are a running dot, 「索引失败」 / 「文件缺失」 a failed one. No percentage
 * accompanies 「分析中」: `AnalysisRun` has a stage and no denominator, and §4.3
 * forbids simulating one.
 *
 * One component rather than three copies because the copies drifted: the table
 * once painted 「已就绪」 as plain grey text while the card and the Inspector
 * kept the badge, so the same state looked different on the same screen.
 */

import { useLingui } from '@lingui/react';

import { StatusDot } from '../../../design/feedback';
import { Badge, cn } from '../../../design/primitives';
import type { DemoSummary } from '../../../shared/desktop/viewModels';
import { demoStatusMeta } from './libraryFormat';

export function DemoStatusMark({ demo }: { readonly demo: DemoSummary }) {
  const { i18n } = useLingui();
  const meta = demoStatusMeta(demo.lifecycle_status);
  const label = i18n._(meta.label);

  if (meta.tone === 'accent' || meta.tone === 'neutral') {
    return <Badge variant={meta.tone}>{label}</Badge>;
  }
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs', meta.tone === 'fail' && 'text-fail-text')}>
      <StatusDot status={meta.tone} size="sm" />
      {label}
    </span>
  );
}
