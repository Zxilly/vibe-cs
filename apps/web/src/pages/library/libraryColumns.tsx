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
 * Column widths are `<col>` values, not utilities, so a width survives an empty
 * page (`DataTable` puts them in a `<colgroup>`). They are the artboard's own:
 * a 90px action column, and the mono fields sized to their content.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import type { DataTableColumn } from '../../design/data';
import { Button, cn, Badge } from '../../design/primitives';
import { StatusDot } from '../../design/feedback';
import type { DemoSummary } from '../../shared/desktop/viewModels';
import { RouteLink } from '../RouteLink';
import {
  demoSourceLabel,
  demoStatusMeta,
  formatDuration,
  formatMatchDate,
  formatRounds,
  isDemoAnalysable,
  isDemoFileMissing,
  type DemoStatusTone,
} from './libraryFormat';
import { unavailableAction, type ServiceActionButtonProps } from './serviceAction';

/**
 * The two hooks the row actions need. Both come from the page, because both
 * are writes and §2.1 rule 6 keeps writes in `data/**` — a column definition
 * has no business holding a mutation.
 */
export interface LibraryColumnHandlers {
  /** 「分析」 on an unanalysed row. */
  readonly onAnalyse: (demo: DemoSummary) => void;
  /** Disabled + reason while the local service is down (「· 需要服务」). */
  readonly analyseButtonProps: ServiceActionButtonProps;
  /** The tail the artboard appends to a blocked action's label. */
  readonly serviceSuffix: ReactNode | undefined;
}

/** The one column 列配置 may not hide, and the id the sort map keys on. */
export const LIBRARY_PRIMARY_COLUMN = 'match';

const STATUS_DOT = {
  accent: 'ok',
  neutral: 'idle',
  running: 'running',
  fail: 'fail',
} as const satisfies Record<DemoStatusTone, 'ok' | 'idle' | 'running' | 'fail'>;

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
      cell: (demo) => <span className="text-base">{demo.display_name}</span>,
    },
    {
      id: 'map',
      header: <Trans>地图</Trans>,
      configLabel: t`地图`,
      width: '9ch',
      sortable: true,
      truncate: true,
      cell: (demo) => demo.map_name,
    },
    {
      id: 'date',
      header: <Trans>日期</Trans>,
      configLabel: t`日期`,
      variant: 'numeric',
      width: '12ch',
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
      width: '6ch',
      sortable: true,
      cell: (demo) => formatRounds(demo.total_rounds),
    },
    {
      id: 'source',
      header: <Trans>来源</Trans>,
      configLabel: t`来源`,
      width: '10ch',
      truncate: true,
      cell: (demo) => <DemoSourceCell demo={demo} />,
    },
    {
      id: 'status',
      header: <Trans>状态</Trans>,
      configLabel: t`状态`,
      width: '11ch',
      sortable: true,
      cell: (demo) => <DemoStatusCell demo={demo} />,
    },
    {
      id: 'actions',
      headerLabel: t`行操作`,
      configLabel: t`行操作`,
      hideable: false,
      width: '90px',
      cell: (demo) => <RowAction demo={demo} handlers={handlers} />,
    },
  ];
}

/**
 * 「已分析」 is a `Tag`, everything else a dot plus a word — which is what the
 * artboard draws, and it is not decoration: a tag reads as a terminal state and
 * a dot as a live one. No percentage accompanies 「分析中」: `AnalysisRun` has a
 * stage and no denominator, and §4.3 forbids simulating one.
 */
function DemoSourceCell({ demo }: { demo: DemoSummary }) {
  const { i18n } = useLingui();
  return <>{i18n._(demoSourceLabel(demo.source))}</>;
}

function DemoStatusCell({ demo }: { demo: DemoSummary }) {
  const { i18n } = useLingui();
  const meta = demoStatusMeta(demo.lifecycle_status);
  const label = i18n._(meta.label);

  if (meta.tone === 'accent') {
    return <Badge variant="accent">{label}</Badge>;
  }
  if (meta.tone === 'neutral') {
    return <Badge variant="neutral">{label}</Badge>;
  }
  return (
    <span
      className={cn('inline-flex items-center gap-2 text-xs', meta.tone === 'fail' && 'text-fail-text')}
    >
      <StatusDot status={STATUS_DOT[meta.tone]} size="sm" />
      {label}
    </span>
  );
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
  if (isDemoFileMissing(demo)) {
    return (
      <Button
        size="sm"
        variant="ghost"
        {...unavailableAction(t`暂不支持重新定位 Demo 文件`)}
      >
        <Trans>重新定位</Trans>
      </Button>
    );
  }

  if (demo.lifecycle_status === 'analyzing') {
    // 「查看」 — the run itself lives on the delivery task list, which is where
    // §7 puts 「分析、录制与导出的执行记录」.
    return (
      <RouteLink to="/delivery?view=tasks">
        <Trans>查看</Trans>
      </RouteLink>
    );
  }

  if (isDemoAnalysable(demo)) {
    return (
      <RouteLink to={`/match/${encodeURIComponent(demo.id)}`}>
        <Trans>工作区</Trans>
      </RouteLink>
    );
  }

  return (
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
      {handlers.serviceSuffix}
    </Button>
  );
}
