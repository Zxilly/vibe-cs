/*
 * pages/ — 恢复中心 (spec §7 `/recovery`, phase 3g).
 *
 * Frame draws no rail entry for it, so the ways in are the command palette
 * (`page.recovery`) and a link from 设置与诊断, which is the entry it lights.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  What this page is, and what makes it different from 设置
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every action here **destroys or overwrites something**, and the page is
 * organised around that rather than around the subsystems the actions belong
 * to. Each card says three things in the same order:
 *
 *   1. what is wrong — or that nothing is, which is the normal answer;
 *   2. what the action would change, in files and records rather than in verbs;
 *   3. what it will not touch.
 *
 * The third one is the reason the page exists. A user reaching 恢复中心 is
 * already worried about losing work, and 「清理残留文件」 with no scope
 * attached reads as "delete something, unspecified". Naming the boundary is
 * what makes the button pressable.
 *
 * ── Every action is behind a confirmation, without exception ──────────────
 *
 * Even the ones that look harmless. §4.5.3 rule ① is about recording, but its
 * shape is general: work that destroys things takes one explicit confirmation.
 * 「清理未完成的暂存输出」 sounds like housekeeping and deletes files a failed
 * export left behind — which is exactly the situation where the user might
 * still want them.
 *
 * ── Three cards, because there are three routes ───────────────────────────
 *
 * 配置恢复 (`/config-backup/*`), 暂存输出 (`/outputs/cleanup-staged`) and
 * 失效记录 (`/outputs/cleanup-missing`). The proxy cleanup
 * (`/media/proxies/cleanup`) is deliberately **not** here: a proxy is a
 * regenerable cache, its cleanup breaks nothing, and it belongs with the
 * editor that creates them rather than on a page about damage.
 *
 * ── The count comes before the button ─────────────────────────────────────
 *
 * `/outputs/recovery-scan` runs the same two scans the cleanups run and
 * reports what they would remove: files and bytes for the staging directory,
 * records for the dangling ones. Each card prints that as its state line, so
 * the user knows whether pressing is worth it, and a card that found nothing
 * says so and keeps its button closed — "press to find out" is not an answer
 * on a page about deleting things.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { useState, type ReactNode } from 'react';

import { Skeleton } from '../../../design/data';
import { Dialog, Alert, StatusDot } from '../../../design/feedback';
import { Page, Toolbar } from '../../../design/layout';
import { Button } from '../../../design/primitives';
import { useRecoverConfiguration, useRecoveryStatus } from '../../../data/config';
import { dataErrorMessage } from '../../../data/errors';
import { useCleanupMissingOutputs, useCleanupStagedOutputs, useRecoveryScan } from '../../../data/outputs';
import { formatBytes } from '../../../domain/media/outputModel';

type Pending = 'config' | 'staged' | 'missing';

export function RecoveryPage() {
  const status = useRecoveryStatus();
  const scan = useRecoveryScan();
  const recoverConfig = useRecoverConfiguration();
  const cleanupStaged = useCleanupStagedOutputs();
  const cleanupMissing = useCleanupMissingOutputs();
  const [confirming, setConfirming] = useState<Pending | null>(null);

  const statusError = dataErrorMessage(status.error);
  const scanError = dataErrorMessage(scan.error);
  const actionError =
    dataErrorMessage(recoverConfig.error) ??
    dataErrorMessage(cleanupStaged.error) ??
    dataErrorMessage(cleanupMissing.error);

  const busy = recoverConfig.isPending || cleanupStaged.isPending || cleanupMissing.isPending;
  const blocked = busy;
  const blockedReason = t`正在处理`;
  const stagedFiles = scan.data?.staged.files;
  const stagedBytes = scan.data === undefined ? null : formatBytes(scan.data.staged.bytes);
  const missingRecords = scan.data?.missing.records;
  const scanUnavailable = scan.isPending || scan.isError;
  const scanUnavailableReason = scan.isPending ? t`正在扫描清理范围` : t`请先重试扫描，确认需要清理的内容`;

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>恢复中心</Trans>}
          meta={<Trans>先检查范围，再按需恢复或清理</Trans>}
          inlineActionsWhenCollapsed={1}
          actions={[{
            id: 'rescan',
            label: <Trans>重新检查</Trans>,
            disabled: busy || scan.isFetching || status.isFetching,
            onSelect: () => { void scan.refetch(); void status.refetch(); },
            control: <Button disabled={busy || scan.isFetching || status.isFetching}
              onClick={() => { void scan.refetch(); void status.refetch(); }}><Trans>重新检查</Trans></Button>,
          }]}
        />
      }
    >
      <div className="flex flex-col gap-5 p-6">
        {statusError === null ? null : (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void status.refetch() }}>
            <Trans>读不到恢复状态：{statusError}</Trans>
          </Alert>
        )}
        {scanError === null ? null : (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void scan.refetch() }}>
            <Trans>没有扫描到清理范围：{scanError}</Trans>
          </Alert>
        )}
        {actionError === null ? null : (
          <Alert
            variant="danger"
            action={{
              label: <Trans>知道了</Trans>,
              onAction: () => {
                recoverConfig.reset();
                cleanupStaged.reset();
                cleanupMissing.reset();
              },
            }}
          >
            <Trans>这次恢复没有完成：{actionError}</Trans>
          </Alert>
        )}

        <div data-recovery-list className="border border-divider">
          <RecoveryCard
          title={<Trans>配置恢复</Trans>}
          state={
            status.isPending ? (
              <Skeleton width="12rem" />
            ) : status.data === undefined ? (
              <span className="text-xs text-neutral-600">
                <Trans>读不到状态</Trans>
              </span>
            ) : status.data.recovery_required ? (
              <span className="flex items-center gap-2 text-sm text-neutral-800" data-recovery-required="">
                <StatusDot status="fail" />
                {status.data.reason ?? <Trans>配置文件读不出来</Trans>}
              </span>
            ) : (
              <span className="flex items-center gap-2 text-sm text-neutral-800">
                <StatusDot status="ok" />
                {/* The normal answer, said plainly. A recovery page that is
                    silent when nothing is wrong makes the user wonder whether
                    it checked. */}
                <Trans>配置文件状态正常</Trans>
              </span>
            )
          }
          effect={
            <Trans>将用上一次自动备份覆盖当前配置文件，然后重新读取。</Trans>
          }
          untouched={<Trans>不会删除 Demo、录制结果、成片、作品或对话记录。</Trans>}
          detail={
            status.data === undefined || status.data.affected_files.length === 0 ? null : (
              <ul className="flex flex-col gap-1">
                {status.data.affected_files.map((file) => (
                  <li key={file} className="break-all font-mono text-xs text-neutral-600">
                    {file}
                  </li>
                ))}
              </ul>
            )
          }
          action={
            <Button
              variant="secondary"
              size="md"
              data-recovery-action="config"
              disabled={blocked || status.isError || status.data?.recovery_required !== true}
              disabledReason={
                status.isPending ? t`正在读取恢复状态` : status.isError ? t`请先重试读取恢复状态` : status.data?.recovery_required === false
                  ? t`当前配置完整，备份恢复保持关闭`
                  : blockedReason
              }
              onClick={() => setConfirming('config')}
            >
              <Trans>用备份恢复</Trans>
            </Button>
          }
          result={
            recoverConfig.data === undefined ? null : (
              <Trans>已从备份恢复配置，重新读取后生效。</Trans>
            )
          }
          />

          <RecoveryCard
          title={<Trans>未完成的暂存成品文件</Trans>}
          state={
            scan.isPending ? (
              <Skeleton width="12rem" />
            ) : scan.data === undefined ? (
              <span className="text-xs text-neutral-600">
                <Trans>读不到状态</Trans>
              </span>
            ) : stagedFiles === 0 ? (
              <span className="flex items-center gap-2 text-sm text-neutral-800" data-recovery-staged="0">
                <StatusDot status="ok" />
                <Trans>暂存目录里没有未完成的文件</Trans>
              </span>
            ) : (
              <span
                className="flex flex-wrap items-center gap-2 text-sm text-neutral-800"
                data-recovery-staged={String(scan.data.staged.files)}
              >
                <StatusDot status="warn" />
                <Plural value={scan.data.staged.files} other="# 个未完成的文件" />
                {stagedBytes === null ? null : <span className="text-neutral-600">· {stagedBytes}</span>}
                {scan.data.staged.scan_limited ? (
                  <span className="text-neutral-600">
                    <Trans>· 只扫描了一部分</Trans>
                  </span>
                ) : null}
              </span>
            )
          }
          effect={<Trans>录制或导出中断时会留下暂存文件，它们不会自己消失。将删除暂存目录里未完成的成片文件。</Trans>}
          untouched={<Trans>不会删除已完成的录制结果、成片或资料库记录。</Trans>}
          action={
            <Button
              variant="secondary"
              size="md"
              data-recovery-action="staged"
              disabled={blocked || scanUnavailable || stagedFiles === 0}
              disabledReason={scanUnavailable ? scanUnavailableReason : stagedFiles === 0 ? t`没有需要清理的暂存文件` : blockedReason}
              onClick={() => setConfirming('staged')}
            >
              <Trans>清理暂存成片</Trans>
            </Button>
          }
          result={
            cleanupStaged.data === undefined ? null : (
              <>
                <Plural
                  value={cleanupStaged.data.deleted}
                  _0="没有需要清理的暂存文件。"
                  other="已清理 # 个暂存文件。"
                />
                {cleanupStaged.data.failed > 0 ? (
                  /* Reporting only the successes would leave the user pressing
                     the button again on files that are locked. */
                  <Trans> 另有 {cleanupStaged.data.failed} 个删不掉，可能正被占用。</Trans>
                ) : null}
                {cleanupStaged.data.scan_limited ? (
                  <Trans> 这次只扫描了一部分，可能还有剩余。</Trans>
                ) : null}
              </>
            )
          }
          />

          <RecoveryCard
          title={<Trans>指向不存在文件的记录</Trans>}
          state={
            scan.isPending ? (
              <Skeleton width="12rem" />
            ) : scan.data === undefined ? (
              <span className="text-xs text-neutral-600">
                <Trans>读不到状态</Trans>
              </span>
            ) : missingRecords === 0 ? (
              <span className="flex items-center gap-2 text-sm text-neutral-800" data-recovery-missing="0">
                <StatusDot status="ok" />
                <Trans>所有记录都能找到文件</Trans>
              </span>
            ) : (
              <span
                className="flex flex-wrap items-center gap-2 text-sm text-neutral-800"
                data-recovery-missing={String(scan.data.missing.records)}
              >
                <StatusDot status="warn" />
                <Plural value={scan.data.missing.records} other="# 条记录找不到文件" />
                {scan.data.missing.scan_limited ? (
                  <span className="text-neutral-600">
                    <Trans>· 只扫描了一部分</Trans>
                  </span>
                ) : null}
              </span>
            )
          }
          effect={<Trans>文件被手动移动或删除后，资料库里的记录会指向一个不存在的位置。将删除这些失效记录。</Trans>}
          untouched={
            /* The distinction that matters: this removes *records*, and the
               files it removes records for are already gone. It cannot delete
               a file, which is what makes it safe to offer here. */
            <Trans>不会删除磁盘上的现有文件，只移除失效记录。</Trans>
          }
          action={
            <Button
              variant="secondary"
              size="md"
              data-recovery-action="missing"
              disabled={blocked || scanUnavailable || missingRecords === 0}
              disabledReason={scanUnavailable ? scanUnavailableReason : missingRecords === 0 ? t`没有失效记录` : blockedReason}
              onClick={() => setConfirming('missing')}
            >
              <Trans>清理失效记录</Trans>
            </Button>
          }
          result={
            cleanupMissing.data === undefined ? null : (
              <>
                <Plural
                  value={cleanupMissing.data.deleted}
                  _0="没有失效记录。"
                  other="已移除 # 条失效记录。"
                />
                {cleanupMissing.data.scan_limited ? (
                  <Trans> 这次只扫描了一部分，可能还有剩余。</Trans>
                ) : null}
              </>
            )
          }
          />
        </div>
      </div>

      <Dialog
        open={confirming === 'config'}
        tone="destructive"
        title={<Trans>用备份覆盖当前配置？</Trans>}
        confirmLabel={<Trans>覆盖并恢复</Trans>}
        confirmDisabled={recoverConfig.isPending}
        onConfirm={() => {
          void recoverConfig.mutateAsync().catch(() => undefined);
          setConfirming(null);
        }}
        onClose={() => setConfirming(null)}
      >
        <Trans>
          当前的配置文件会被上一次自动备份覆盖，改动无法撤销。备份之后做过的设置改动会丢失。
        </Trans>
      </Dialog>

      <Dialog
        open={confirming === 'staged'}
        tone="destructive"
        title={<Trans>清理未完成的暂存成品文件？</Trans>}
        confirmLabel={<Trans>清理</Trans>}
        confirmDisabled={cleanupStaged.isPending}
        onConfirm={() => {
          void cleanupStaged.mutateAsync().catch(() => undefined);
          setConfirming(null);
        }}
        onClose={() => setConfirming(null)}
      >
        <Trans>
          暂存目录里未完成的文件会被删除。如果某次录制或导出还想接着救，先把文件复制出去。
        </Trans>
      </Dialog>

      <Dialog
        open={confirming === 'missing'}
        tone="destructive"
        title={<Trans>清理失效记录？</Trans>}
        confirmLabel={<Trans>清理</Trans>}
        confirmDisabled={cleanupMissing.isPending}
        onConfirm={() => {
          /* No `kind`: this page sweeps every output kind, unlike the
             library's own 「清理无效记录」, which filters by the list the user
             is looking at. */
          void cleanupMissing.mutateAsync(undefined).catch(() => undefined);
          setConfirming(null);
        }}
        onClose={() => setConfirming(null)}
      >
        <Trans>
          指向不存在文件的记录会被移除。如果文件只是被挪走了，先把它放回去再清理，否则记录会一起消失。
        </Trans>
      </Dialog>
    </Page>
  );
}

interface RecoveryCardProps {
  readonly title: ReactNode;
  /** What is wrong, or that nothing is. */
  readonly state: ReactNode;
  /** 「会做什么」 — in files and records, not in verbs. */
  readonly effect: ReactNode;
  /** 「不会动」 — the reason the page is usable. */
  readonly untouched: ReactNode;
  readonly detail?: ReactNode;
  readonly action: ReactNode;
  readonly result?: ReactNode;
}

function RecoveryCard({ title, state, effect, untouched, detail, action, result }: RecoveryCardProps) {
  return (
    <section className="grid min-h-36 grid-cols-1 border-b border-divider last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-[minmax(18rem,1fr)_minmax(24rem,1.6fr)_13rem]">
      <div className="flex min-w-0 flex-col gap-2 border-b border-divider p-4 sm:col-span-2 xl:col-span-1 xl:border-r xl:border-b-0 xl:p-5">
        <h2 className="text-lg font-medium">{title}</h2>
        {state}
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-3 border-b border-divider p-4 sm:border-r sm:border-b-0 xl:p-5">
        {detail}
        <p className="text-sm leading-normal text-neutral-700">{effect}</p>
        <p className="text-sm leading-normal text-neutral-700">{untouched}</p>
      </div>
      <div className="flex min-w-0 flex-col items-stretch justify-center gap-3 p-4 xl:p-5">
        {action}
        {result === null || result === undefined ? null : (
          <span role="status" className="text-sm leading-relaxed text-neutral-700" data-recovery-result="">
            {result}
          </span>
        )}
      </div>
    </section>
  );
}
