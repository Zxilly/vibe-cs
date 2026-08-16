/*
 * pages/montage — block D, 导出.
 *
 * 分辨率 / 帧率 / 画质策略 / 将生成 / 预计时长 / 输出目录. The 「生成视频」 the
 * artboard draws under this panel is **not** here: it is the shell's, rendered
 * into the Inspector's footer, because it is the same action as the one in the
 * top bar (contract invariant 1).
 *
 * Three things on the artboard are not on the wire, and each is handled
 * differently rather than uniformly faked:
 *
 * **「将生成 Kael_highlights_v2.mp4」 — omitted as a name, printed as a rule.**
 * The service names the file itself: `crates/runtime/src/export.rs` writes
 * `montage-{project_id}-{job_id}.mp4` into `<data_dir>/exports`, and the job
 * id does not exist until the job has been accepted. There is therefore no
 * name to show beforehand, and a made-up one would be a promise about a path
 * the user might go looking for. The panel prints the naming rule and the
 * directory instead — both true, both checkable.
 *
 * **「约 540 MB」 — omitted.** `quality` selects a CRF (`quality_to_crf` in
 * `crates/media/src/plan.rs`), and CRF is constant *quality*: the bitrate is
 * whatever the content needs. A bitrate × duration estimate would be wrong by a
 * factor, in the direction people act on — this is the number somebody reads
 * before deciding whether to free disk space — so no number is the honest
 * answer. Recorded as a backend gap; if a size estimate is wanted, it belongs
 * where the encoder is.
 *
 * **「输出目录 D:\CS2\exports\」 — read, not set.** `AppConfig` has `data_dir`
 * and no export directory of its own; the exports folder is `data_dir/exports`,
 * fixed in `export.rs`. So the panel *shows* the directory and offers 「打开
 * 目录」 (a real native capability), and there is no 「更改」 here: changing it
 * would mean moving the whole application data directory, which is 设置 ·
 * 文件与资料库's job and not an export panel's. Recorded as a gap.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { Skeleton } from '../../design/data';
import { Button, Field, Seg } from '../../design/primitives';
import { useAppConfig } from '../../data/config';
import { useNativeShell, useNativeShellAction } from '../../data/nativeShell';
import { splitMinutesSeconds } from './montageClock';
import type { MontageBlockProps } from './montageContract';
import {
  MONTAGE_EXPORT_BLOCKER_REASON,
  MONTAGE_FRAME_RATES,
  MONTAGE_QUALITY_LABEL,
  MONTAGE_QUALITY_TIERS,
  MONTAGE_QUALITY_VALUE,
  MONTAGE_RESOLUTIONS,
  editMontageSettings,
  formatResolution,
  montageRenderPlan,
  qualityIsExactTier,
  qualityToCrf,
  qualityTierOf,
  type MontageQualityTier,
} from './montageSettings';

/** `<data_dir>/exports`, the directory `export.rs` creates and writes into. */
function exportDirectory(dataDir: string): string {
  const separator = dataDir.includes('\\') ? '\\' : '/';
  const trimmed = dataDir.replace(/[\\/]+$/u, '');
  return `${trimmed}${separator}exports`;
}

export function ExportBlock({ project: desk, service, projectId }: MontageBlockProps) {
  const { i18n } = useLingui();
  const shell = useNativeShell();
  const shellAction = useNativeShellAction();
  const config = useAppConfig();

  const project = desk.project;
  const writable = !service.blocked && project !== null && !desk.saving;

  if (project === null) {
    return (
      <section data-montage-block="export" className="flex flex-col">
        <PanelHeading />
        <div className="flex flex-col gap-3 p-4">
          <Skeleton width="100%" />
          <Skeleton width="64%" />
          <p className="sr-only" role="status" aria-busy="true">
            <Trans>正在读取导出设置</Trans>
          </p>
        </div>
      </section>
    );
  }

  const { settings } = project;
  const tier = qualityTierOf(settings.quality);
  const plan = montageRenderPlan(project, desk.clipDurations);
  const spans = plan.durationSeconds === null ? null : splitMinutesSeconds(plan.durationSeconds);
  const directory = config.data?.data_dir === undefined ? null : exportDirectory(config.data.data_dir);

  return (
    <section data-montage-block="export" className="flex flex-col">
      <PanelHeading />
      <div className="flex flex-col gap-4 p-4">
        <div className="flex gap-2.5">
          <Field label={<Trans>分辨率</Trans>} className="flex-1">
            {(control) => (
              <select
                {...control}
                data-montage-field="resolution"
                disabled={!writable}
                value={formatResolution(settings.width, settings.height)}
                onChange={(event) => {
                  const found = MONTAGE_RESOLUTIONS.find(
                    ([width, height]) => formatResolution(width, height) === event.target.value,
                  );
                  if (found === undefined) return;
                  desk.save(editMontageSettings({ width: found[0], height: found[1] }));
                }}
                className={SELECT_CLASS}
              >
                {/* A project stored at a size this list does not carry keeps it,
                    as its own first option, rather than being snapped to 1080p
                    the first time the panel renders. */}
                {MONTAGE_RESOLUTIONS.some(
                  ([width, height]) => width === settings.width && height === settings.height,
                ) ? null : (
                  <option value={formatResolution(settings.width, settings.height)}>
                    {formatResolution(settings.width, settings.height)}
                  </option>
                )}
                {MONTAGE_RESOLUTIONS.map(([width, height]) => (
                  <option key={`${width}x${height}`} value={formatResolution(width, height)}>
                    {formatResolution(width, height)}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label={<Trans>帧率</Trans>} className="flex-1">
            {(control) => (
              <select
                {...control}
                data-montage-field="fps"
                disabled={!writable}
                value={String(settings.fps)}
                onChange={(event) => desk.save(editMontageSettings({ fps: Number(event.target.value) }))}
                className={SELECT_CLASS}
              >
                {MONTAGE_FRAME_RATES.includes(settings.fps) ? null : (
                  <option value={String(settings.fps)}>{settings.fps} fps</option>
                )}
                {MONTAGE_FRAME_RATES.map((fps) => (
                  <option key={fps} value={String(fps)}>
                    {fps} fps
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>

        <Field
          label={<Trans>画质策略</Trans>}
          hint={
            qualityIsExactTier(settings.quality) ? (
              <Trans>当前 quality {settings.quality} · CRF {qualityToCrf(settings.quality)}</Trans>
            ) : (
              /* A project set elsewhere keeps its own number; the panel says
                 which of the three it is nearest to instead of rewriting it. */
              <Trans>
                当前 quality {settings.quality}（CRF {qualityToCrf(settings.quality)}），最接近这一档
              </Trans>
            )
          }
        >
          <Seg
            name="montage-quality"
            aria-label={t`画质策略`}
            size="md"
            fill
            value={tier}
            options={MONTAGE_QUALITY_TIERS.map((option) => ({
              value: option,
              label: i18n._(MONTAGE_QUALITY_LABEL[option]),
            }))}
            onChange={(next: MontageQualityTier) =>
              desk.save(editMontageSettings({ quality: MONTAGE_QUALITY_VALUE[next] }))
            }
          />
        </Field>

        <dl
          data-montage-export-summary=""
          className="flex flex-col gap-1.5 border border-divider p-3 text-xs leading-normal text-neutral-800"
        >
          <div className="flex flex-col gap-0.5">
            <dt>
              <Trans>将生成</Trans>
            </dt>
            <dd className="font-mono text-2xs break-all">montage-{projectId}-&lt;任务 id&gt;.mp4</dd>
            <dd className="text-neutral-600">
              <Trans>文件名由服务在任务开始时确定，任务 id 在这之前还不存在。</Trans>
            </dd>
          </div>

          {spans === null ? (
            <div className="flex justify-between gap-3">
              <dt>
                <Trans>预计时长</Trans>
              </dt>
              <dd className="text-neutral-600">
                <Trans>待定 · 还有片段的素材长度没读到</Trans>
              </dd>
            </div>
          ) : (
            <div className="flex justify-between gap-3">
              <dt>
                <Trans>预计时长</Trans>
              </dt>
              <dd className="font-mono">
                <Trans>
                  {spans.minutes} 分 {spans.seconds} 秒
                </Trans>
              </dd>
            </div>
          )}

          <div className="flex flex-col gap-0.5">
            <dt>
              <Trans>输出目录</Trans>
            </dt>
            {directory === null ? (
              <dd className="text-neutral-600">
                <Trans>读取中</Trans>
              </dd>
            ) : (
              <dd className="font-mono text-2xs break-all">{directory}</dd>
            )}
          </div>
        </dl>

        {plan.blockers.length === 0 ? null : (
          /* Every reason, not just the first: the toolbar button can only carry
             one sentence, and a user who fixes the missing intro title should
             not then discover the transition problem one press later. */
          <ul data-montage-export-blockers="" className="flex flex-col gap-1 text-xs text-fail-text">
            {plan.blockers.map((code) => (
              <li key={code}>{i18n._(MONTAGE_EXPORT_BLOCKER_REASON[code])}</li>
            ))}
          </ul>
        )}

        <Button
          size="sm"
          data-montage-action="open-exports"
          {...shellAction.buttonProps}
          disabled={!shellAction.available || directory === null}
          onClick={() => {
            if (directory !== null) void shell.openDirectory(directory);
          }}
        >
          <Trans>打开输出目录</Trans>
        </Button>
      </div>
    </section>
  );
}

const SELECT_CLASS =
  'w-full min-w-0 border border-divider bg-bg px-2 text-sm leading-normal text-text ' +
  'h-[var(--h-ctl-md)] focus:border-accent disabled:opacity-45';

function PanelHeading() {
  return (
    <h3
      className="flex h-[var(--h-panel-head)] flex-none items-center border-y border-divider px-4 font-heading tracking-caps"
      style={{ fontSize: 'var(--text-sm)' }}
    >
      <Trans>导出</Trans>
    </h3>
  );
}
