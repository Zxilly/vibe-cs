import { dependencyLabel } from '../../../domain/environment/dependencyLabel';
/*
 * pages/settings — 设置 · 高级与诊断.
 *
 * The artboard's own description of this section is the specification for what
 * belongs in it: 「采集组件版本、编码器探测、进程与路径校验、日志。普通使用不需要
 * 打开」. So it is a readout, not a control panel — the only thing here that
 * changes anything is 「重新检查」.
 *
 * ── Everything is stated with its source ─────────────────────────────────
 *
 * A diagnostics page whose numbers cannot be traced is a page that generates
 * support tickets rather than closing them. Each block says which service read
 * it came from, and a read that failed says so instead of rendering an empty
 * table that looks like a clean bill of health.
 *
 * ── 导出诊断包 ───────────────────────────────────────────────────────────
 *
 * This was drawn disabled with 「服务端还没有打包诊断信息的接口」, and that
 * sentence was wrong: `POST /api/app/diagnostics/export` has existed all along,
 * and so has `productApi.exportDiagnostics`. Nothing called it, so nobody
 * noticed — the whole of `shared/desktop/product.ts` had no consumer.
 *
 * The report is a JSON file under 「数据目录」/diagnostics: version, runtime
 * session, OS and arch, and which things are *configured* — never a credential
 * value, never media. The row says so, because the file is one the user is
 * about to hand to someone else.
 *
 * The path comes back and is shown with 定位文件, rather than leaving the user
 * to hunt for a filename they never saw.
 *
 * ── 恢复中心 and 使用引导 live under this section ─────────────────────────
 *
 * Neither has a rail entry; both light 设置与诊断 and crumb under it. The
 * command palette reaches them, and so does the last block here — otherwise
 * the crumb promises a parent that has no way back down.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { Skeleton } from '../../../design/data';
import { Alert, StatusDot, type StatusDotStatus } from '../../../design/feedback';
import { Button } from '../../../design/primitives';
import {
  useExportDiagnostics,
  useHlaeStatus,
  usePrepareManagedHlae,
  useQuickCheck,
  useRuntimeState,
} from '../../../data/config';
import { useRevealPath } from '../../../data/nativeShell';
import { dataErrorMessage } from '../../../data/errors';
import type { DependencyState } from '../../../shared/desktop/dto';
import { RouteLink } from '../navigation/RouteLink';
import { PathReadout, SettingsBlock, SettingsRow } from './settingsShared';

export function AdvancedSection() {
  const runtime = useRuntimeState();
  const checks = useQuickCheck();
  const hlae = useHlaeStatus();
  const prepareHlae = usePrepareManagedHlae();
  const exportDiagnostics = useExportDiagnostics();
  const revealPath = useRevealPath();

  const runtimeError = dataErrorMessage(runtime.error);
  const checksError = dataErrorMessage(checks.error);
  const hlaeError = dataErrorMessage(hlae.error);

  return (
    <div className="flex flex-col">
      <SettingsBlock
        id="runtime"
        layout="split"
        title={<Trans>运行状态</Trans>}
        description={<Trans>版本、数据目录和当前录制占用。</Trans>}
      >
        {runtimeError !== null ? (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void runtime.refetch() }}>
            <Trans>无法读取运行状态：{runtimeError}</Trans>
          </Alert>
        ) : runtime.data === undefined ? (
          <Skeleton />
        ) : (
          <>
            <SettingsRow label={<Trans>版本</Trans>} hint={<Trans>报告问题时附上这个号码。</Trans>}>
              <span className="font-mono text-xs text-neutral-700" data-runtime-version="">
                {runtime.data.version}
              </span>
            </SettingsRow>
            <SettingsRow
              label={<Trans>当前运行状态</Trans>}
              hint={
                <Trans>
                  录制期间无法同时回放。
                </Trans>
              }
            >
              <span className="text-xs text-neutral-700" data-runtime-session={runtime.data.runtime_session}>
                <RuntimeSessionLabel session={runtime.data.runtime_session} />
              </span>
            </SettingsRow>
            {runtime.data.active_recording_job === null ? null : (
              <SettingsRow
                label={<Trans>正在录制</Trans>}
                hint={<Trans>这项任务结束前，其它录制与回放都会被拒绝。</Trans>}
              >
                <span className="font-mono text-xs text-neutral-700">
                  {runtime.data.active_recording_job}
                </span>
              </SettingsRow>
            )}
            <SettingsRow
              label={<Trans>数据目录</Trans>}
              hint={<Trans>在「文件与资料库」中更改保存位置。</Trans>}
            />
            <PathReadout path={runtime.data.data_dir} empty={<Trans>没有数据目录</Trans>} />
          </>
        )}
      </SettingsBlock>

      <SettingsBlock
        id="dependencies"
        layout="split"
        title={<Trans>依赖检查</Trans>}
        description={<Trans>路径、进程与编码器的逐项检查。</Trans>}
      >
        {checksError !== null ? (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void checks.refetch() }}>
            <Trans>读不到依赖检查：{checksError}</Trans>
          </Alert>
        ) : checks.isPending ? (
          <Skeleton />
        ) : (
          <>
            <ul className="flex flex-col gap-2.5">
              {(checks.data?.checks ?? []).map((check) => (
                <li key={`${check.kind}:${dependencyLabel(check.kind)}`} className="flex flex-col gap-1" data-check={check.kind}>
                  <div className="flex items-center gap-2.5 text-sm">
                    <StatusDot status={dotStatus(check.state)} />
                    <span>{dependencyLabel(check.kind)}</span>
                    <span className="text-xs text-neutral-600" data-check-state={check.state}>
                      {check.state === 'ready' ? <Trans>就绪</Trans> : <Trans>缺失</Trans>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            {(checks.data?.checks ?? []).length === 0 ? (
              <p className="text-xs leading-normal text-neutral-600">
                <Trans>这次检查没有返回任何项。</Trans>
              </p>
            ) : null}
            <div className="flex items-center gap-2.5">
              {checks.data === undefined ? null : (
                <span className="text-xs text-neutral-600">
                  <Trans>上次检查 {new Date(checks.data.checked_at).toLocaleString()}</Trans>
                </span>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={checks.isFetching}
                disabledReason={t`正在检查`}
                onClick={() => void checks.refetch()}
              >
                <Trans>重新检查</Trans>
              </Button>
            </div>
          </>
        )}
      </SettingsBlock>

      <SettingsBlock
        id="capture"
        layout="split"
        title={<Trans>采集组件</Trans>}
        description={<Trans>安装和检查录制所需组件。</Trans>}
      >
        {hlaeError !== null ? (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void hlae.refetch() }}>
            <Trans>读不到采集组件状态：{hlaeError}</Trans>
          </Alert>
        ) : hlae.data === undefined ? (
          <Skeleton />
        ) : (
          <>
            <SettingsRow
              label={<Trans>可用性</Trans>}
            >
              <span className="flex items-center gap-2 text-xs text-neutral-700">
                <StatusDot status={hlae.data.available ? 'ok' : 'fail'} />
                {hlae.data.available ? <Trans>就绪</Trans> : <Trans>不可用</Trans>}
              </span>
            </SettingsRow>
            <SettingsRow
              label={<Trans>启动方式</Trans>}
            >
              <span className="text-xs text-neutral-700">
                {hlae.data.automatic_launch_enabled ? <Trans>自动启动</Trans> : <Trans>手动启动</Trans>}
              </span>
            </SettingsRow>
            {hlae.data.executable === null ? null : (
              <>
                <SettingsRow
                  label={<Trans>可执行文件</Trans>}
                />
                <PathReadout path={hlae.data.executable} empty={null} />
              </>
            )}
            {hlae.data.available ? null : (
              <div className="flex flex-col items-start gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={prepareHlae.isPending}
                  {...(prepareHlae.isPending
                    ? { disabledReason: t`正在下载并校验采集组件` }
                    : {})}
                  onClick={() => prepareHlae.mutate()}
                >
                  {prepareHlae.isPending ? <Trans>正在准备</Trans> : <Trans>准备采集组件</Trans>}
                </Button>
                <p className="text-xs leading-normal text-neutral-600">
                  <Trans>下载并安装录制所需组件。</Trans>
                </p>
              </div>
            )}
            {prepareHlae.error == null ? null : (
              <Alert
                variant="danger"
                action={{ label: <Trans>重试</Trans>, onAction: () => prepareHlae.mutate() }}
              >
                <Trans>采集组件没有准备完成：{dataErrorMessage(prepareHlae.error)}</Trans>
              </Alert>
            )}
          </>
        )}
      </SettingsBlock>

      <SettingsBlock
        id="diagnostics"
        layout="split"
        title={<Trans>日志与诊断包</Trans>}
      >
        <SettingsRow
          label={<Trans>导出诊断包</Trans>}
          hint={<Trans>报告问题时可以附上的一份运行记录。</Trans>}
        >
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={exportDiagnostics.isPending}
              disabledReason={exportDiagnostics.isPending ? t`正在写入报告` : ''}
              onClick={() => exportDiagnostics.mutate()}
            >
              <Trans>导出</Trans>
            </Button>
            {exportDiagnostics.data === undefined ? null : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => revealPath(exportDiagnostics.data.path)}
              >
                <Trans>定位文件</Trans>
              </Button>
            )}
          </div>
        </SettingsRow>
        {exportDiagnostics.data === undefined ? null : (
          /* A sentence, not a `Notice`: every notice carries a recovery action
             by design, and a report that was written has nothing to recover
             from. The path is the whole message. */
          <p className="px-3 pb-3 text-sm text-neutral-700" data-diagnostics-result="">
            {/* The flag, not the assumption: this page promises 「不含密钥」 only
                because the service said so on the wire. */}
            {exportDiagnostics.data.contains_secrets ? (
              <Trans>报告已写入 {exportDiagnostics.data.path}。</Trans>
            ) : (
              <Trans>报告已写入 {exportDiagnostics.data.path}，不含任何密钥或媒体内容。</Trans>
            )}
          </p>
        )}
        {exportDiagnostics.error == null ? null : (
          <Alert
            variant="danger"
            action={{
              label: <Trans>重试</Trans>,
              onAction: () => exportDiagnostics.mutate(),
            }}
          >
            {dataErrorMessage(exportDiagnostics.error)}
          </Alert>
        )}
      </SettingsBlock>

      <SettingsBlock
        id="recovery"
        layout="split"
        title={<Trans>恢复与引导</Trans>}
        description={<Trans>修复损坏的配置和残留文件，或重看三步引导。</Trans>}
      >
        <SettingsRow
          label={<Trans>恢复中心</Trans>}
          hint={<Trans>修复配置或清理残留文件。</Trans>}
        >
          <RouteLink to="/recovery" data-settings-link="recovery">
            <Trans>打开恢复中心</Trans>
          </RouteLink>
        </SettingsRow>
        <SettingsRow
          label={<Trans>使用引导</Trans>}
          hint={<Trans>三步做出第一条视频，以及这台机器现在能做什么。</Trans>}
        >
          <RouteLink to="/guide" data-settings-link="guide">
            <Trans>打开使用引导</Trans>
          </RouteLink>
        </SettingsRow>
      </SettingsBlock>
    </div>
  );
}

/**
 * The runtime session, in words. The wire carries the state machine's own
 * names (`state.rs`'s `runtime_session_snapshot`); a name this list does not
 * know is printed as-is rather than dropped, because a diagnostics page that
 * hides a state it cannot name is hiding the one thing worth reporting.
 */
function RuntimeSessionLabel({ session }: { readonly session: string }) {
  switch (session) {
    case 'idle':
      return <Trans>空闲</Trans>;
    case 'playback_launching':
      return <Trans>正在启动回放</Trans>;
    case 'playback':
      return <Trans>回放中</Trans>;
    case 'playback_stopping':
      return <Trans>正在停止回放</Trans>;
    case 'recording':
      return <Trans>录制中</Trans>;
    default:
      return <span className="font-mono">{session}</span>;
  }
}

/** Two states, so two dots — the same reading as `GameSection`'s. */
function dotStatus(state: DependencyState): StatusDotStatus {
  return state === 'ready' ? 'ok' : 'fail';
}
