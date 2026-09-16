/*
 * pages/library — the columns of 「02 Demo 资料库」.
 *
 * The artboard's header row is
 *
 *   [ ] 比赛 · 地图 · 日期 · 时长 · 回合 · 来源 · 标签 · 状态 · (行动作)
 *
 * and eight of those nine are here. **标签 is not**, because `DemoSummary` —
 * everything `commands.listDemos` returns, via `normalizeDemo` — carries no
 * tags. Tags reach the client one demo at a time through `getDemoMetadata`, and
 * twenty extra round trips per page to fill one column is not a column, it is a
 * fetch waterfall. A permanently blank 标签 column would be worse still: §10.3
 * calls silent truncation a bug, and a column that can never have a value is
 * the same lie with more whitespace. The gap is reported instead.
 *
 * Column widths are `DataTableColumn.width` values, not utilities, so a width
 * survives an empty page (`DataTable` writes them on the `<colgroup>` and as
 * the header cell's floor). Every column but the truncating 比赛 names one, so
 * the headers sit at the same pixel whether the page holds twenty rows, one
 * or none, and 比赛 alone takes the slack.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import type { DataTableColumn } from '../../../design/data';
import { Button } from '../../../design/primitives';
import type { DemoSummary } from '../../../shared/desktop/viewModels';
import { RouteLink } from '../navigation/RouteLink';
import { DemoStatusMark } from './DemoStatusMark';
import {
  demoSourceLabel,
  formatDuration,
  formatMatchDate,
  formatRounds,
  isDemoAnalysable,
  isDemoFileMissing,
} from './libraryFormat';

/** Spreadable onto `Button`: `disabled` plus the reason when there is one. */
export interface ActionAvailability {
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

/**
 * The two hooks the row actions need. Both come from the page, because both
 * are writes and §2.1 rule 6 keeps writes in `data/**` — a column definition
 * has no business holding a mutation.
 */
export interface LibraryColumnHandlers {
  /** 「分析」 on an unanalysed row. */
  readonly onAnalyse: (demo: DemoSummary) => void;
  readonly onCreateProject: (demo: DemoSummary) => void;
  readonly analyseButtonProps: ActionAvailability;
  readonly createButtonProps: ActionAvailability;
}

/** The one column 列配置 may not hide, and the id the sort map keys on. */
export const LIBRARY_PRIMARY_COLUMN = 'match';

export function libraryColumns(
  handlers: LibraryColumnHandlers,
): readonly DataTableColumn<DemoSummary>[] {
  return [
    {
      id: LIBRARY_PRIMARY_COLUMN,
      header: <Trans>比赛</Trans>,
      configLabel: t`比赛`,
      // The identity column cannot be switched off, and it is the one that
      // truncates: §10.3's rule is 「该截断的要 truncate」, and a 60-character
      // match name would otherwise push 状态 out of a 616px pane.
      hideable: false,
      truncate: true,
      sortable: true,
      // `TableCell`'s contract: a truncated cell carries the full text as its
      // `title`, or a clipped 「Vitality vs G2 · I…」 has no way to be read.
      cell: (demo) => (
        <span className="text-base" title={demo.display_name}>
          {demo.display_name}
        </span>
      ),
    },
    {
      id: 'map',
      header: <Trans>地图</Trans>,
      configLabel: t`地图`,
      /* A width and no `truncate`. In the auto table a column without a width
         is sized by whatever rows happen to be on the page, so the headers
         shifted with every search and collapsed to their own labels on an
         empty result. The width is a floor, not a clip: without `truncate` a
         longer map name still widens the column, so 「de_mirage」 can never
         become 「de_mira…」 the way an earlier `9ch` + `truncate` pair made it.
         In px rather than `ch` because the floor also lives on the header
         cell, whose type differs from the body's — `DataTable` explains — and
         this column has to sit at the same pixel on an empty page. 92px is
         「de_ancient」 plus the cell's inline padding; a longer name widens it. */
      width: '92px',
      sortable: true,
      cell: (demo) => demo.map_name,
    },
    {
      id: 'date',
      header: <Trans>日期</Trans>,
      configLabel: t`日期`,
      variant: 'numeric',
      /* px, like 地图: 「08-14 20:11」 is eleven mono characters at the body
         size, and a `ch` floor on the header would resolve smaller and let
         the column narrow on an empty page. */
      width: '102px',
      cell: (demo) => formatMatchDate(demo.match_date),
    },
    {
      id: 'duration',
      header: <Trans>时长</Trans>,
      configLabel: t`时长`,
      variant: 'numeric',
      width: '8ch',
      sortable: true,
      cell: (demo) => formatDuration(demo.duration_seconds),
    },
    {
      id: 'rounds',
      header: <Trans>回合</Trans>,
      configLabel: t`回合`,
      variant: 'numeric',
      /* 8ch, not the 6ch its *values* need: `ch` is the width of a Latin
         digit and the header is two CJK characters plus a sort glyph, so the
         column has to fit its own name. It no longer *has* to — `TableCell`
         pins every cell to one line, so a short width can no longer wrap the
         label — but 时长 next door is the same shape, and two neighbours that
         count things should be the same width. */
      width: '8ch',
      sortable: true,
      cell: (demo) => formatRounds(demo.total_rounds),
    },
    {
      id: 'source',
      header: <Trans>来源</Trans>,
      configLabel: t`来源`,
      /* Three fixed words (本地文件 / 监听目录 / 已导入), so the same reasoning as
         地图: a floor wide enough for the longest, never clipped. */
      width: '72px',
      cell: (demo) => <DemoSourceCell demo={demo} />,
    },
    {
      id: 'status',
      header: <Trans>状态</Trans>,
      configLabel: t`状态`,
      width: '11ch',
      sortable: true,
      cell: (demo) => <DemoStatusMark demo={demo} />,
    },
    {
      id: 'actions',
      headerLabel: t`行操作`,
      configLabel: t`行操作`,
      hideable: false,
      /* 「工作区 · 用 Agent 制作」 at its widest, so the column does not grow by
         a few pixels on the pages that hold that pair and shift the headers. */
      width: '200px',
      cell: (demo) => <RowAction demo={demo} handlers={handlers} />,
    },
  ];
}

function DemoSourceCell({ demo }: { demo: DemoSummary }) {
  const { i18n } = useLingui();
  return <>{i18n._(demoSourceLabel(demo.source))}</>;
}

/**
 * The artboard's fourth column of actions: 工作区 · 分析 · 查看 · 重新定位, one
 * per status.
 *
 * 重新定位 is rendered disabled with its reason written on it rather than
 * omitted: the desktop bridge has no 「relink this demo」 command (only
 * `relinkMediaAsset`, which is for editor assets), and 「不隐藏、不静默失败」
 * applies to a missing backend the same way it applies to a missing service.
 */
function RowAction({
  demo,
  handlers,
}: {
  demo: DemoSummary;
  handlers: LibraryColumnHandlers;
}) {
  const create = (
    <Button
      size="sm"
      variant="ghost"
      {...handlers.createButtonProps}
      onClick={() => handlers.onCreateProject(demo)}
    >
      <Trans>用 Agent 制作</Trans>
    </Button>
  );

  let existing: ReactNode;
  if (isDemoFileMissing(demo)) {
    existing = (
      <Button
        size="sm"
        variant="ghost"
        disabled
        disabledReason={t`暂不支持重新定位 Demo 文件`}
      >
        <Trans>重新定位</Trans>
      </Button>
    );
  } else if (demo.lifecycle_status === 'analyzing') {
    // 「查看」 — the run itself lives on the delivery task list, which is where
    // §7 puts 「分析、录制与导出的执行记录」.
    existing = (
      <RouteLink to="/tasks">
        <Trans>查看</Trans>
      </RouteLink>
    );
  } else if (isDemoAnalysable(demo)) {
    existing = (
      <RouteLink to={`/match/${encodeURIComponent(demo.id)}`}>
        <Trans>工作区</Trans>
      </RouteLink>
    );
  } else {
    existing = (
      <Button
        size="sm"
        variant="ghost"
        {...handlers.analyseButtonProps}
        onClick={() => {
          handlers.onAnalyse(demo);
        }}
      >
        {/* A verb — Analyze. The bare 「分析」 msgid is the task-kind noun
            (Analysis) in `domain/task/taskVocabulary`. */}
        <Trans context="row-action">分析</Trans>
      </Button>
    );
  }

  return <span className="flex items-center justify-end gap-2">{existing}{create}</span>;
}
