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
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { Skeleton } from '../../design/data';
import { Alert, StatusDot, type StatusDotStatus } from '../../design/feedback';
import { Button } from '../../design/primitives';
import {
  useExportDiagnostics,
  useHlaeStatus,
  usePrepareManagedHlae,
  useQuickCheck,
  useRuntimeState,
} from '../../data/config';
import { useOpenDirectory } from '../../data/nativeShell';
import { dataErrorMessage } from '../../data/errors';
import { useServiceAction } from '../../data/serviceAction';
import { PathReadout, SettingsBlock, SettingsRow } from './settingsShared';

export function AdvancedSection() {
  const runtime = useRuntimeState();
  const checks = useQuickCheck();
  const hlae = useHlaeStatus();
  const prepareHlae = usePrepareManagedHlae();
  const service = useServiceAction();
  const exportDiagnostics = useExportDiagnostics();
  const openDirectory = useOpenDirectory();

  const runtimeError = dataErrorMessage(runtime.error);
  const checksError = dataErrorMessage(checks.error);
  const hlaeError = dataErrorMessage(hlae.error);

  return (
    <div className="flex flex-col">
      <SettingsBlock
        id="runtime"
        layout="split"
        title={<Trans>运行时</Trans>}
        description={<Trans>本地服务当前的状态。</Trans>}
      >
        {runtimeError !== null ? (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void runtime.refetch() }}>
            <Trans>读不到运行时状态：{runtimeError}</Trans>
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
              label={<Trans>当前运行编号</Trans>}
              hint={
                <Trans>
                  录制与回放是互斥的，这个编号说明为什么某个动作现在不可用。
                </Trans>
              }
            >
              <span className="font-mono text-xs text-neutral-700" data-runtime-session="">
                {runtime.data.runtime_session}
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
                <li key={`${check.kind}:${check.label}`} className="flex flex-col gap-1" data-check={check.kind}>
                  <div className="flex items-center gap-2.5 text-sm">
                    <StatusDot status={dotStatus(check.state)} />
                    <span>{check.label}</span>
                    <span className="font-mono text-2xs text-neutral-600">{check.state}</span>
                  </div>
                  {check.detail === '' ? null : (
                    <p className="ms-5 break-all text-xs leading-normal text-neutral-600">{check.detail}</p>
                  )}
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
                disabled={service.blocked || checks.isFetching}
                disabledReason={service.buttonProps.disabledReason ?? t`正在检查`}
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
        description={<Trans>受管 HLAE 的安装状态与安全边界。</Trans>}
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
              hint={<Trans>不可用时录制无法启动。</Trans>}
            >
              <span className="flex items-center gap-2 text-xs text-neutral-700">
                <StatusDot status={hlae.data.available ? 'ok' : 'fail'} />
                {hlae.data.available ? <Trans>就绪</Trans> : <Trans>不可用</Trans>}
              </span>
            </SettingsRow>
            <SettingsRow
              label={<Trans>启动方式</Trans>}
              hint={<Trans>录制时是否由本应用拉起游戏。</Trans>}
            >
              <span className="text-xs text-neutral-700">
                {hlae.data.automatic_launch_enabled ? <Trans>自动启动</Trans> : <Trans>手动启动</Trans>}
              </span>
            </SettingsRow>
            {hlae.data.executable === null ? null : (
              <PathReadout path={hlae.data.executable} empty={null} />
            )}
            {hlae.data.messages.length === 0 ? null : (
              <ul className="flex flex-col gap-1">
                {hlae.data.messages.map((message) => (
                  <li key={message} className="text-xs leading-normal text-neutral-600">
                    <HlaeMessage message={message} />
                  </li>
                ))}
              </ul>
            )}
            {hlae.data.available ? null : (
              <div className="flex flex-col items-start gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={service.blocked || prepareHlae.isPending}
                  {...(prepareHlae.isPending
                    ? { disabledReason: t`正在下载并校验采集组件` }
                    : service.buttonProps.disabledReason === undefined
                      ? {}
                      : { disabledReason: service.buttonProps.disabledReason })}
                  onClick={() => prepareHlae.mutate()}
                >
                  {prepareHlae.isPending ? <Trans>正在准备</Trans> : <Trans>准备采集组件</Trans>}
                </Button>
                <p className="text-xs leading-normal text-neutral-600">
                  <Trans>下载经过固定版本与 SHA-256 校验的官方 HLAE，并安装到应用数据目录。</Trans>
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
        description={<Trans>这里用于排查运行问题。</Trans>}
      >
        <SettingsRow
          label={<Trans>导出诊断包</Trans>}
          hint={<Trans>报告问题时可以附上的一份运行记录。</Trans>}
        >
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={exportDiagnostics.isPending || service.blocked}
              disabledReason={
                exportDiagnostics.isPending
                  ? t`正在写入报告`
                  : (service.buttonProps.disabledReason ?? '')
              }
              onClick={() => exportDiagnostics.mutate()}
            >
              <Trans>导出</Trans>
            </Button>
            {exportDiagnostics.data === undefined ? null : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openDirectory(exportDiagnostics.data.path)}
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
    </div>
  );
}

const MANAGED_HLAE_BOUNDARY_MESSAGE =
  'Recording jobs launch a fresh managed HLAE and CS2 process for offline Demo playback with -insecure; proposal exports remain process-free';

/** Known service guidance is product copy; unknown diagnostics stay verbatim. */
function HlaeMessage({ message }: { readonly message: string }) {
  if (message !== MANAGED_HLAE_BOUNDARY_MESSAGE) return <>{message}</>;
  return (
    <Trans>
      录制作业会启动新的受管 HLAE 与 CS2 进程，以 -insecure 模式离线回放 Demo；导出剪辑单不会启动游戏进程。
    </Trans>
  );
}

/** Same reading as `GameSection`'s — see the note there on why `idle`. */
function dotStatus(state: string): StatusDotStatus {
  switch (state) {
    case 'ready':
    case 'ok':
      return 'ok';
    case 'warning':
    case 'degraded':
      return 'warn';
    case 'missing':
    case 'error':
    case 'blocked':
      return 'fail';
    default:
      return 'idle';
  }
}
