/*
 * pages/library — the one empty state both views of 「02 Demo 资料库」 draw.
 *
 * Two situations, one component, because the table and the card grid used to
 * each pick a preset and drifted:
 *
 *   nothing in the library   `Empty` preset `no-matches` — 「还没有比赛」 with
 *                            导入 Demo ＋ 添加目录, the artboard's copy verbatim
 *   a filter emptied it      the `no-hits` box, but with the library's own
 *                            words. The preset's copy belongs to 证据检索
 *                            (「没有命中的证据 · 放宽时间范围通常最有效」); this
 *                            page filters by map, status, platform and tag,
 *                            has no time range to widen, and its rows are
 *                            matches, not evidence.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Empty } from '../../../design/data';
import { Button } from '../../../design/primitives';

export interface LibraryEmptyProps {
  /** Whether a filter or search is what emptied the page. */
  readonly filtered: boolean;
  readonly onClearFilters: () => void;
  /** 导入 Demo ＋ 添加目录, owned by the page because both open its overlays. */
  readonly emptyActions: ReactNode;
  readonly className?: string | undefined;
}

export function LibraryEmpty({ filtered, onClearFilters, emptyActions, className }: LibraryEmptyProps) {
  if (!filtered) {
    return <Empty className={className} preset="no-matches" actions={emptyActions} />;
  }
  return (
    <Empty
      className={className}
      preset="no-hits"
      title={<Trans>没有匹配的比赛</Trans>}
      description={<Trans>换个关键词，或清空地图、状态、平台、标签筛选。</Trans>}
      actions={
        <Button size="sm" onClick={onClearFilters}>
          <Trans>清空条件</Trans>
        </Button>
      }
    />
  );
}
