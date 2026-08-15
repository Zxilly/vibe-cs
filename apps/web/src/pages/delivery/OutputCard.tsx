/*
 * pages/delivery — one produced file, as 「11 输出与任务记录」 draws it.
 *
 * The artboard's card is a thumbnail beside four lines: the file name, two
 * lines of facts, and a row of links (播放 · 定位文件 · 来源任务 #A-2481). The
 * missing-file variant swaps the border and the copy (「记录仍在，文件已被移动或
 * 删除」) and offers 重新定位 · 移除记录 instead.
 *
 * ── What this card does not draw, and why ─────────────────────────────────
 *
 * 播放      There is no way to play a local file from the webview: the Tauri CSP
 *           is `default-src 'self'` (§10.3 gap 8 makes the same point about
 *           radar basemaps), and no command returns a playable URL. 定位文件 is
 *           what the shell can actually do today, so it is the primary action
 *           and 播放 is reported as a gap rather than wired to a link that
 *           silently does nothing.
 * 重新定位   `commands` has `relinkMediaAsset` for an editor asset and nothing
 *           for an output record. The missing-file card therefore recovers by
 *           removing the record — which the artboard itself annotates as safe
 *           (「外部文件，移除记录不会删除文件」).
 * 时长/帧率/编码
 *           Not on the wire. See `outputModel.ts`.
 * 来源任务   Only an export carries it: the service builds an export output with
 *           `id: record.job.id` (`crates/application/src/routes/outputs.rs`), so
 *           the record *is* addressable as a task, while a recording output is
 *           keyed by clip id and has no job to point at.
 */

import { Trans } from '@lingui/react/macro';
import { Film } from 'lucide-react';

import { formatTaskClock } from '../../domain/task';
import { EMPTY_STATE_MIN_HEIGHT_CLASS } from '../../design/data';
import { Button, cx } from '../../design/primitives';
import type { OutputItem } from '../../shared/desktop/dto';
import { RouteLink } from '../RouteLink';
import { formatBytes, outputDeletionRemovesFile, outputFileIsUsable } from './outputModel';
import type { ServiceActionState } from '../../data/serviceAction';

export interface OutputCardProps {
  readonly output: OutputItem;
  /** 定位文件. A shell action, not a service call — never gated. */
  readonly onReveal: (output: OutputItem) => void;
  /** 移除记录 / 删除. */
  readonly onDelete: (output: OutputItem) => void;
  /** Gates the one action that reaches the service. */
  readonly service: ServiceActionState;
  readonly now?: Date | undefined;
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
}

export function OutputCard({
  output,
  onReveal,
  onDelete,
  service,
  now,
  timeZone,
  className,
}: OutputCardProps) {
  const usable = outputFileIsUsable(output.availability);
  const size = formatBytes(output.size_bytes);
  const stamp = formatTaskClock(output.created_at, {
    ...(now === undefined ? {} : { now }),
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  const sourceTaskId = output.output_kind === 'export' ? `export:${output.id}` : null;

  return (
    <article
      data-output={output.id}
      data-output-kind={output.output_kind}
      data-output-availability={output.availability}
      className={cx(
        'flex gap-4 border p-4',
        usable ? 'border-divider' : 'border-fail-border',
        className,
      )}
    >
      {/*
       * The artboard's thumbnail is 168×95 and §3.5 has no 168. The same
       * thumbnail on 「01 工作台首页」 is drawn at 132×74, which *is* a token
       * (`--w-track-head`, added in phase 0 and already used this way by
       * `media/FilmStrip` — §10.3 deviation 4). Adopting the home artboard's
       * size costs 36px of thumbnail and avoids an eighteenth panel width.
       */}
      <div
        aria-hidden="true"
        className={cx(
          'grid aspect-video w-[var(--w-track-head)] flex-none place-items-center border',
          usable ? 'border-divider bg-neutral-100 text-neutral-600' : 'border-fail-border text-fail-text',
        )}
      >
        {usable ? (
          <Film size={18} strokeWidth={1.5} />
        ) : (
          <span className="text-2xs">
            <Trans>文件不在原位</Trans>
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="min-w-0 truncate text-md leading-tight font-normal">{output.file_name}</h3>

        <p className={cx('text-xs leading-normal', usable ? 'text-neutral-700' : 'text-fail-text')}>
          {usable ? (
            <>
              {size === null ? null : <>{size}{' · '}</>}
              {stamp}
              {' · '}
              {output.managed ? <Trans>受管文件</Trans> : <Trans>外部文件</Trans>}
            </>
          ) : (
            <Trans>记录仍在，文件已被移动或删除</Trans>
          )}
        </p>

        {/* The full path is the only handle on a file the app cannot show, so
            it is printed rather than hidden behind a tooltip. `break-all` keeps
            a long Windows path inside the card instead of widening the grid. */}
        <p className="min-w-0 truncate font-mono text-2xs text-neutral-600" title={output.path}>
          {output.path}
        </p>

        <div className="mt-1 flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => onReveal(output)}>
            <Trans>定位文件</Trans>
          </Button>

          {sourceTaskId === null ? null : (
            <RouteLink to={`/delivery/task/${encodeURIComponent(sourceTaskId)}`} size="sm">
              <Trans>来源任务</Trans>
            </RouteLink>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(output)}
            {...service.buttonProps}
            className="ml-auto"
          >
            {outputDeletionRemovesFile(output) ? <Trans>删除</Trans> : <Trans>移除记录</Trans>}
            {service.suffix}
          </Button>
        </div>
      </div>
    </article>
  );
}

/**
 * The loading placeholder for one card. Bars only — 「加载中 · 表格骨架（不显示
 * 虚构百分比）」 — and the same box height as the card it stands in for, so the
 * grid does not reflow when the answer arrives.
 */
export function OutputCardSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cx('flex gap-4 border border-divider p-4', EMPTY_STATE_MIN_HEIGHT_CLASS)}
    >
      <span
        aria-hidden="true"
        className="aspect-video w-[var(--w-track-head)] flex-none animate-pulse bg-neutral-200"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span aria-hidden="true" className="h-3.5 w-2/5 animate-pulse bg-neutral-200" />
        <span aria-hidden="true" className="h-3 w-4/5 animate-pulse bg-neutral-200" />
        <span aria-hidden="true" className="h-3 w-3/5 animate-pulse bg-neutral-200" />
      </div>
      <span className="sr-only">
        <Trans>正在加载输出</Trans>
      </span>
    </div>
  );
}
