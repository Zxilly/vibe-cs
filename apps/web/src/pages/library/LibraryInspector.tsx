/*
 * pages/library — the right-hand 「比赛详情」 of 「02 Demo 资料库」.
 *
 * `design/layout/Inspector` is the shell, and it already carries the §8 rule 2
 * behaviour: docked at `--w-inspector` above the 1100px breakpoint, and below it
 * a 46px summary strip plus a召-out drawer. **No media query is written here** —
 * the component observes the breakpoint itself, and 「打开比赛工作区」 is passed
 * as `summaryActions` so that the main action stays on the strip when the panel
 * folds (§8: 主动作在任何宽度下保持可见).
 *
 * ## What the artboard draws and the wire cannot answer
 *
 * The drawn panel has 文件 / 大小 / 校验 / 位置, an 分析历史 timeline and 备注.
 * `normalizeDemo` keeps `filename` and `path` and drops `file_size` and
 * `content_sha256`, so 大小 and 校验 are **not rendered as empty rows** — an
 * always-blank field claims a value exists. 分析历史 needs the run list for one
 * demo, which is `data/tasks.ts` territory (phase 3a) and has no per-demo query
 * on the bridge; the panel shows the one run state that *is* addressable,
 * 「正在分析」, and nothing more. Both gaps are reported.
 *
 * 备注 is editable in place, because it is the one field of the drawn panel the
 * wire accepts a write for (`DemoUpdate.remark`). A save is explicit: an
 * auto-save would fight the 5-second edit-notification window §4.5.4 defines
 * for the Agent, and this page has no such notifier.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { Inspector } from '../../design/layout';
import { Notice, StatusDot } from '../../design/feedback';
import { Button, Tag, TextInput } from '../../design/primitives';
import type { DemoMetadata } from '../../shared/desktop/dto';
import type { DemoSummary } from '../../shared/desktop/viewModels';
import {
  demoSourceLabel,
  demoStatusMeta,
  formatDateTime,
  formatDuration,
  formatFileLocation,
  formatMatchDate,
  formatRounds,
  formatScore,
  isDemoAnalysable,
} from './libraryFormat';
import { alsoDisabled, unavailableAction, type ServiceActionButtonProps } from './serviceAction';
import type { ReactNode } from 'react';

export interface LibraryInspectorProps {
  readonly demo: DemoSummary | undefined;
  readonly metadata: DemoMetadata | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  /** 「正在分析」 — `data/tasks.ts`'s per-demo run query answered true. */
  readonly analysing: boolean;

  readonly onOpenWorkspace: () => void;
  readonly onAnalyse: () => void;
  readonly onPlay: () => void;
  readonly onSaveRemark: (remark: string) => Promise<unknown>;
  readonly savingRemark: boolean;

  readonly service: ServiceActionButtonProps;
  readonly serviceSuffix: ReactNode | undefined;
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
  onOpenWorkspace,
  onAnalyse,
  onPlay,
  onSaveRemark,
  savingRemark,
  service,
  serviceSuffix,
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
          <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
            {error}
          </Notice>
        )}
      </Inspector>
    );
  }

  const status = demoStatusMeta(demo.lifecycle_status);
  const canOpenWorkspace = isDemoAnalysable(demo);

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
      summaryActions={
        canOpenWorkspace ? (
          <Button size="sm" variant="primary" onClick={onOpenWorkspace}>
            <Trans>打开比赛工作区</Trans>
          </Button>
        ) : (
          <Button size="sm" variant="primary" {...alsoDisabled(service, analysing)} onClick={onAnalyse}>
            <Trans>开始分析</Trans>
            {serviceSuffix}
          </Button>
        )
      }
      footer={
        <>
          {canOpenWorkspace ? (
            <Button size="lg" variant="primary" block onClick={onOpenWorkspace}>
              <Trans>打开比赛工作区</Trans>
            </Button>
          ) : (
            <Button
              size="lg"
              variant="primary"
              block
              {...alsoDisabled(service, analysing)}
              onClick={onAnalyse}
            >
              <Trans>开始分析</Trans>
              {serviceSuffix}
            </Button>
          )}
          <div className="flex gap-2">
            <Button size="sm" grow {...service} onClick={onPlay}>
              <Trans>游戏内回放</Trans>
              {serviceSuffix}
            </Button>
            <Button
              size="sm"
              grow
              {...unavailableAction(t`暂不支持在文件管理器中显示`)}
            >
              <Trans>定位文件</Trans>
            </Button>
          </div>
        </>
      }
    >
      {error === null ? null : (
        <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
          {error}
        </Notice>
      )}

      <div>
        <h3 className="font-heading text-xl">{demo.display_name}</h3>
        <p className="mt-px text-sm text-neutral-700">
          {demo.map_name}
          {' · '}
          {formatScore(demo)}
          {demo.total_rounds > 0 ? (
            <>
              {' · '}
              <Trans>{formatRounds(demo.total_rounds)} 回合</Trans>
            </>
          ) : null}
          {' · '}
          {formatDuration(demo.duration_seconds)}
        </p>
      </div>

      <div className="flex items-center gap-2">
        {status.tone === 'accent' || status.tone === 'neutral' ? (
          <Tag tone={status.tone}>{i18n._(status.label)}</Tag>
        ) : (
          <span className="inline-flex items-center gap-2 text-xs">
            <StatusDot status={status.tone === 'fail' ? 'fail' : 'running'} size="sm" />
            {i18n._(status.label)}
          </span>
        )}
        {analysing ? (
          <span className="inline-flex items-center gap-2 text-xs">
            <StatusDot status="running" size="sm" />
            {/* No percentage: `AnalysisRun` reports a stage and no denominator. */}
            <Trans>正在分析</Trans>
          </span>
        ) : null}
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
              <Tag key={tag.id} tone="accent">
                {tag.name}
              </Tag>
            ))}
          </div>
        </section>
      ) : null}

      <section className="border-t border-divider pt-4">
        <h4 className="mb-2 font-heading text-xs tracking-caps text-neutral-600">
          <Trans>备注</Trans>
        </h4>
        <TextInput
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
            {...alsoDisabled(service, savingRemark || remark === demo.remark)}
            onClick={() => {
              void onSaveRemark(remark);
            }}
          >
            <Trans>保存备注</Trans>
            {serviceSuffix}
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
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex-none text-neutral-600">{term}</dt>
      <dd className={mono ? 'min-w-0 truncate font-mono text-xs' : 'min-w-0 truncate'} title={value}>
        {value}
      </dd>
    </div>
  );
}
