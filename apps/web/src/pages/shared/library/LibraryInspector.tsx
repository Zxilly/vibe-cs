/*
 * pages/library — the right-hand 「比赛详情」 of 「02 Demo 资料库」.
 *
 * `design/layout/Inspector` is the shell, and it already carries the §8 rule 2
 * behaviour: docked at `--w-inspector` above the 1100px breakpoint, and below it
 * a 46px summary strip plus a召-out drawer. **No media query is written here** —
 * the component observes the breakpoint itself, and the primary action is
 * passed as `summaryActions` so that it stays on the strip when the panel
 * folds (§8: 主动作在任何宽度下保持可见).
 *
 * ## The primary action, by state
 *
 *   ready       `workspaceLabel` → `onOpenWorkspace`. The page names the
 *               action, because what the match workspace is *for* depends on
 *               where the user came from — 「从 Demo 创建剪辑」 when a project
 *               sent them here to collect clips, 「打开比赛工作区」 otherwise —
 *               and this shared page does not know which mode is on.
 *   analysing   「查看分析进度」 → `onViewAnalysis`, the same place the table
 *               row's 「查看」 goes. A disabled 「开始分析」 with no reason was
 *               what stood here before.
 *   otherwise   「开始分析」 → `onAnalyse`.
 *
 * ## What the artboard draws and the wire cannot answer
 *
 * The drawn panel has 文件 / 大小 / 校验 / 位置, an 分析历史 timeline and 备注.
 * `normalizeDemo` keeps `filename` and `path` and drops `file_size` and
 * `content_sha256`, so 大小 and 校验 are **not rendered as empty rows** — an
 * always-blank field claims a value exists. 分析历史 needs the run list for one
 * demo, which is `data/tasks.ts` territory (phase 3a) and has no per-demo query
 * on the bridge; the panel shows the one run state that *is* addressable — the
 * record's own 「分析中」, drawn by `DemoStatusMark` exactly as the table draws
 * it — and nothing more. Both gaps are reported.
 *
 * 备注 is editable in place, because it is the one field of the drawn panel the
 * wire accepts a write for (`DemoUpdate.remark`). A save is explicit: an
 * auto-save would fight the 5-second edit-notification window §4.5.4 defines
 * for the Agent, and this page has no such notifier.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState, type ReactNode } from 'react';

import { Inspector } from '../../../design/layout';
import { Alert } from '../../../design/feedback';
import { Button, Badge, Input } from '../../../design/primitives';
import type { DemoMetadata } from '../../../shared/desktop/dto';
import type { DemoSummary } from '../../../shared/desktop/viewModels';
import { DemoStatusMark } from './DemoStatusMark';
import type { ActionAvailability } from './libraryColumns';
import {
  demoSourceLabel,
  EMPTY_CELL,
  formatDateTime,
  formatDuration,
  formatFileLocation,
  formatMatchDate,
  formatMatchup,
  formatRounds,
  formatScore,
  isDemoAnalysable,
} from './libraryFormat';

export interface LibraryInspectorProps {
  readonly demo: DemoSummary | undefined;
  readonly metadata: DemoMetadata | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  /** The record's lifecycle is `analyzing` — picks 「查看分析进度」. */
  readonly analysing: boolean;

  /** What the primary action is called while the workspace can be opened. */
  readonly workspaceLabel: ReactNode;
  readonly onOpenWorkspace: () => void;
  readonly onAnalyse: () => void;
  /** 「查看分析进度」 — where the running analysis can be watched. */
  readonly onViewAnalysis: () => void;
  readonly onPlay: () => void;
  /** 「定位文件」 — reveal the demo in the file manager. */
  readonly onReveal: () => void;
  readonly revealButtonProps: ActionAvailability;
  readonly onSaveRemark: (remark: string) => Promise<unknown>;
  readonly savingRemark: boolean;

  /** Test seam for the §8 breakpoint; production leaves it to the component. */
  readonly collapsed?: boolean | undefined;
}

export function LibraryInspector({
  demo,
  metadata,
  loading,
  error,
  onRetry,
  analysing,
  workspaceLabel,
  onOpenWorkspace,
  onAnalyse,
  onViewAnalysis,
  onPlay,
  onReveal,
  revealButtonProps,
  onSaveRemark,
  savingRemark,
  collapsed,
}: LibraryInspectorProps) {
  const { i18n } = useLingui();
  const [remark, setRemark] = useState(demo?.remark ?? '');

  // Following the selection is the point: the panel is a view of whichever row
  // is active, and a stale draft belonging to a different match would be worse
  // than losing an unsaved word.
  useEffect(() => {
    setRemark(demo?.remark ?? '');
  }, [demo?.id, demo?.remark]);

  if (demo === undefined) {
    return (
      <Inspector
        label={t`比赛详情`}
        title={<Trans>比赛详情</Trans>}
        summary={<Trans>未选中比赛</Trans>}
        {...(collapsed === undefined ? {} : { collapsed })}
      >
        {loading ? (
          <p className="text-sm text-neutral-600">
            <Trans>正在读取</Trans>
          </p>
        ) : (
          <p className="text-sm leading-normal text-neutral-700">
            <Trans>在左侧选一场比赛，这里会显示它的文件、状态与下一步。</Trans>
          </p>
        )}
        {error === null ? null : (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
            {error}
          </Alert>
        )}
      </Inspector>
    );
  }

  const canOpenWorkspace = isDemoAnalysable(demo);
  const matchup = formatMatchup(demo);
  const score = formatScore(demo);
  const duration = formatDuration(demo.duration_seconds);

  const primaryAction = (size: 'sm' | 'lg') => {
    if (canOpenWorkspace) {
      return (
        <Button size={size} variant="primary" block={size === 'lg'} onClick={onOpenWorkspace}>
          {workspaceLabel}
        </Button>
      );
    }
    if (analysing) {
      return (
        <Button size={size} variant="primary" block={size === 'lg'} onClick={onViewAnalysis}>
          <Trans>查看分析进度</Trans>
        </Button>
      );
    }
    return (
      <Button size={size} variant="primary" block={size === 'lg'} onClick={onAnalyse}>
        <Trans>开始分析</Trans>
      </Button>
    );
  };

  return (
    <Inspector
      label={t`比赛详情`}
      title={<Trans>比赛详情</Trans>}
      summary={
        <Trans>
          选中 {demo.display_name} · {demo.map_name}
        </Trans>
      }
      {...(collapsed === undefined ? {} : { collapsed })}
      summaryActions={primaryAction('sm')}
      footer={
        <>
          {primaryAction('lg')}
          <div className="flex gap-2">
            <Button size="sm" grow onClick={onPlay}>
              <Trans>游戏内回放</Trans>
            </Button>
            <Button size="sm" grow {...revealButtonProps} onClick={onReveal}>
              <Trans>定位文件</Trans>
            </Button>
          </div>
        </>
      }
    >
      {error === null ? null : (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
          {error}
        </Alert>
      )}

      <div>
        <h3 className="font-heading text-xl">{demo.display_name}</h3>
        {/* Each number says what it is: 「FURIA 8 : 13 Falcons」 and 「时长 56:19」
            are both colon-separated digits, and side by side without a label
            the score read as a second clock. */}
        <p className="mt-px text-sm text-neutral-700">
          {demo.map_name}
          {matchup !== null ? (
            <>
              {' · '}
              {matchup}
            </>
          ) : score !== EMPTY_CELL ? (
            <>
              {' · '}
              <Trans>比分 {score}</Trans>
            </>
          ) : null}
          {demo.total_rounds > 0 ? (
            <>
              {' · '}
              <Trans>{formatRounds(demo.total_rounds)} 回合</Trans>
            </>
          ) : null}
          {duration !== EMPTY_CELL ? (
            <>
              {' · '}
              <Trans>时长 {duration}</Trans>
            </>
          ) : null}
        </p>
      </div>

      {/* 「分析中」 with its running dot is the whole of what is known: no
          percentage, because `AnalysisRun` reports a stage and no denominator. */}
      <div className="flex items-center gap-2">
        <DemoStatusMark demo={demo} />
      </div>

      <dl className="flex flex-col gap-2 text-sm">
        <DetailRow term={<Trans>文件</Trans>} value={demo.filename} mono />
        <DetailRow term={<Trans>位置</Trans>} value={formatFileLocation(demo.path)} mono />
        <DetailRow term={<Trans>来源</Trans>} value={i18n._(demoSourceLabel(demo.source))} />
        <DetailRow term={<Trans>比赛时间</Trans>} value={formatMatchDate(demo.match_date)} mono />
        <DetailRow term={<Trans>入库时间</Trans>} value={formatDateTime(demo.cataloged_at)} mono />
      </dl>

      {metadata !== undefined && metadata.tags.length > 0 ? (
        <section className="border-t border-divider pt-4">
          <h4 className="mb-2 font-heading text-xs tracking-caps text-neutral-600">
            <Trans>标签</Trans>
          </h4>
          <div className="flex flex-wrap gap-2">
            {metadata.tags.map((tag) => (
              <Badge key={tag.id} variant="accent">
                {tag.name}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      <section className="border-t border-divider pt-4">
        <h4 className="mb-2 font-heading text-xs tracking-caps text-neutral-600">
          <Trans>备注</Trans>
        </h4>
        <Input
          size="sm"
          aria-label={t`备注`}
          value={remark}
          placeholder={t`写下这场值得回头看的地方`}
          onChange={(event) => {
            setRemark(event.target.value);
          }}
        />
        <div className="mt-2">
          <Button
            size="sm"
            disabled={savingRemark || remark === demo.remark}
            onClick={() => {
              void onSaveRemark(remark);
            }}
          >
            <Trans>保存备注</Trans>
          </Button>
        </div>
      </section>
    </Inspector>
  );
}

function DetailRow({
  term,
  value,
  mono = false,
}: {
  term: ReactNode;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-3">
      <dt className="flex-none text-neutral-600">{term}</dt>
      <dd className={mono ? 'min-w-0 truncate font-mono text-xs' : 'min-w-0 truncate'} title={value}>
        {value}
      </dd>
    </div>
  );
}
