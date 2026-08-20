/*
 * pages/settings — 设置 · AI 与 Agent (§7's fourth section, artboard 「补齐 ·
 * Agent 会话历史与设置」).
 *
 * The fifth round renamed 「AI」 to 「AI 与 Agent」 and split it into three
 * blocks: 模型 / 会话 / 行为边界. All three are drawn here; what is *in* them is
 * only what the wire carries.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Two decisions this section had to make
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── 「录制前始终由你确认」 is not a setting ───────────────────────────────
 *
 * §4.5.3 rule ① — 「录制只由一次显式确认启动」 — is a rule of the system, so the
 * artboard draws the switch **on and unreachable** and says why in its own line:
 * 「不可关闭：录制会启动游戏并写出文件，必须有一次人工确认」. It is rendered from
 * `RECORDING_CONFIRMATION_LOCKED_ON`, which reads `domain/task`'s
 * `TASK_REQUIRES_CONFIRMATION.recording` — the place the product *actually*
 * enforces it — rather than from a `true` typed into this file.
 * `AgentWorkspaceSettings` has no field for it, and that is correct.
 *
 * ── When the retention policy is applied (§10.1 gap 2, decided here) ──────
 *
 * `applyAgentSessionRetention` has no scheduler, and phase 3e was asked to
 * decide whether the frontend should call it once at startup. **It should not,
 * and this panel does not.** Three reasons:
 *
 *   · A renderer is not a scheduler. A sweep that only runs when a window is
 *     open makes 「30 天」 mean 「30 天，如果你最近开过应用」, and a user who
 *     leaves the app closed for a month gets the opposite of what they set.
 *   · A startup sweep is an irreversible delete triggered by no user action,
 *     performed before the user can see — let alone correct — the policy that
 *     drives it. A mis-set 「不保留」 would empty the workspace on next launch
 *     with nothing on screen to stop it.
 *   · It is the same shape as §4.5.3 rule ①: work that destroys or produces
 *     things needs an explicit confirmation, not an effect on mount.
 *
 * So the sweep has exactly one trigger here — 「立即应用」, behind a destructive
 * `Dialog` that names the policy and reports how many conversations went. The
 * periodic sweep belongs to the backend runtime (it is the only party that runs
 * when no window does); that is filed as a blocker rather than approximated.
 *
 * ── The five switches that used to have nowhere to go ────────────────────
 *
 * 「自动带入当前选中的 Demo 与选手」 in 会话, and 「应用剪辑变更前先预览」 /
 * 「显示 Agent 读取了哪些证据」 / 「默认成片时长」 / 「点评语气」 in 行为边界
 * were all absent through phase 3e, because `AgentWorkspaceSettings` was
 * `{ session_retention, take_limit }` and a switch with nowhere to store its
 * answer lies the moment the panel is reopened.
 *
 * Phase 3g-be added the fields (§10.11), so they are drawn now. Each writes the
 * *whole* settings document — the route replaces it, so a partial write would
 * silently reset whatever it omitted.
 */

import { useLingui } from '@lingui/react';
import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { useState, type ReactNode } from 'react';

import { useAppConfig } from '../../data/config';
import { dataErrorMessage } from '../../data/errors';
import { useServiceAction } from '../../data/serviceAction';
import {
  retentionOptionId,
  useAgentSessionStorage,
  useAgentWorkspaceSettings,
  useApplyAgentSessionRetention,
  useClearAgentSessions,
  useExportAgentSessions,
  useUpdateAgentWorkspaceSettings,
} from '../../data/sessions';
import { AGENT_SHOT_VIEW, AGENT_SHOT_VIEWS } from '../../domain/agent';
import { Skeleton } from '../../design/data';
import { Dialog, Alert } from '../../design/feedback';
import { Button, Seg, Slider, Toggle } from '../../design/primitives';
import type { AgentSessionRetention, AgentWorkspaceSettings } from '../../shared/desktop/dto';
import { formatBytes } from '../delivery/outputModel';
import {
  RECORDING_CONFIRMATION_LOCKED_ON,
  TAKE_LIMIT_MAX,
  TAKE_LIMIT_MIN,
  clampTakeLimit,
  retentionChoices,
  retentionFromOptionId,
} from './aiAgentModel';

/** Which irreversible action is waiting for its second confirmation. */
type PendingConfirmation = 'retention' | 'clear' | null;

export function AiAgentSection() {
  // The vocabulary tables hold `MessageDescriptor`s so the words are looked up
  // at render rather than frozen at import — see `domain/agent/types.ts`.
  const { i18n } = useLingui();
  const service = useServiceAction();

  const config = useAppConfig();
  const settings = useAgentWorkspaceSettings();
  const storage = useAgentSessionStorage();

  const updateSettings = useUpdateAgentWorkspaceSettings();
  const applyRetention = useApplyAgentSessionRetention();
  const exportSessions = useExportAgentSessions();
  const clearSessions = useClearAgentSessions();

  const [confirming, setConfirming] = useState<PendingConfirmation>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<number | null>(null);

  const current = settings.data;
  const settingsError = dataErrorMessage(settings.error);

  const write = async (next: AgentWorkspaceSettings) => {
    setWriteError(null);
    try {
      await updateSettings.mutateAsync(next);
    } catch (cause) {
      setWriteError(dataErrorMessage(cause) ?? t`设置没有保存成功`);
    }
  };

  const runRetention = async () => {
    setWriteError(null);
    setConfirming(null);
    try {
      const result = await applyRetention.mutateAsync();
      setRemoved(result.removed_sessions);
    } catch (cause) {
      setWriteError(dataErrorMessage(cause) ?? t`保留策略没有应用成功`);
    }
  };

  const runClear = async () => {
    setWriteError(null);
    setConfirming(null);
    try {
      const result = await clearSessions.mutateAsync();
      setRemoved(result.removed_sessions);
    } catch (cause) {
      setWriteError(dataErrorMessage(cause) ?? t`清空没有成功`);
    }
  };

  return (
    <div data-settings-section="ai" className="flex flex-col gap-3.5 p-5">
      {writeError === null ? null : (
        <Alert
          variant="danger"
          action={{
            label: <Trans>知道了</Trans>,
            onAction: () => {
              setWriteError(null);
            },
          }}
        >
          {writeError}
        </Alert>
      )}

      {removed === null ? null : (
        <Alert
          variant="success"
          action={{
            label: <Trans>知道了</Trans>,
            onAction: () => {
              setRemoved(null);
            },
          }}
        >
          <Plural value={removed} other="已删除 # 条会话，方案、任务和视频都还在" />
        </Alert>
      )}

      <ModelBlock
        provider={config.data?.llm.provider ?? null}
        model={config.data?.llm.model ?? null}
        hasApiKey={config.data?.llm_has_api_key ?? null}
        loading={config.isPending}
        error={dataErrorMessage(config.error)}
        onRetry={() => void config.refetch()}
      />

      <Block id="conversations" title={<Trans>对话</Trans>}>
        {settingsError !== null ? (
          <Alert
            variant="danger"
            action={{ label: <Trans>重试</Trans>, onAction: () => void settings.refetch() }}
          >
            <Trans>读不到 Agent 的会话设置：{settingsError}</Trans>
          </Alert>
        ) : current === undefined ? (
          <div aria-busy="true" className="flex flex-col gap-2.5">
            <Skeleton />
            <Skeleton width="88%" />
            <Skeleton width="92%" />
          </div>
        ) : (
          <>
            <RetentionRow
              current={current}
              disabled={service.blocked || updateSettings.isPending}
              disabledReason={
                service.blocked ? service.buttonProps.disabledReason : undefined
              }
              onChange={(retention) => void write({ ...current, session_retention: retention })}
              onApplyNow={() => {
                setConfirming('retention');
              }}
              applyProps={service.buttonProps}
              applySuffix={service.suffix}
            />

            <SwitchRow
              label={<Trans>自动带入当前选中的 Demo 与选手</Trans>}
              hint={<Trans>新建对话时预填当前的 Demo 与选手，之后随时可以手动改。</Trans>}
              name="auto-attach-context"
              ariaLabel={t`自动带入当前选中的 Demo 与选手`}
              checked={current.auto_attach_context}
              disabled={service.blocked || updateSettings.isPending}
              onChange={(next) => void write({ ...current, auto_attach_context: next })}
            />

            <TakeLimitRow
              value={current.take_limit}
              disabled={service.blocked || updateSettings.isPending}
              onCommit={(take) => void write({ ...current, take_limit: take })}
            />
          </>
        )}

        <StorageRow
          bytes={storage.data?.conversation_bytes ?? null}
          planBytes={storage.data?.plan_bytes ?? null}
          sessionCount={storage.data?.session_count ?? null}
          loading={storage.isPending}
          error={dataErrorMessage(storage.error)}
          onRetry={() => void storage.refetch()}
          onExport={() => void exportSessions.mutateAsync().catch(() => undefined)}
          exportResult={
            exportSessions.data === undefined
              ? null
              : { count: exportSessions.data.sessions.length, at: exportSessions.data.exported_at }
          }
          exportError={dataErrorMessage(exportSessions.error)}
          onClear={() => {
            setConfirming('clear');
          }}
          busy={exportSessions.isPending || clearSessions.isPending}
          service={service.buttonProps}
          serviceSuffix={service.suffix}
        />
      </Block>

      <Block id="behavior" title={<Trans>行为边界</Trans>}>
        <div className="flex items-center gap-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-base">
              <Trans>录制前始终由你确认</Trans>
            </p>
            <p id="agent-confirm-locked" className="mt-1 text-xs leading-normal text-neutral-600">
              <Trans>不可关闭：录制会启动游戏并写出文件，必须有一次人工确认。</Trans>
            </p>
          </div>
          <Toggle
            locked
            checked={RECORDING_CONFIRMATION_LOCKED_ON}
            data-setting="recording-confirmation"
            aria-label={t`录制前始终由你确认`}
            aria-describedby="agent-confirm-locked"
          />
        </div>

        {current === undefined ? null : (
          <>
            <SwitchRow
              label={<Trans>应用剪辑变更前先预览</Trans>}
              hint={<Trans>关闭后，接受变更会直接改工程，仍可撤销。</Trans>}
              name="preview-before-apply"
              ariaLabel={t`应用剪辑变更前先预览`}
              checked={current.preview_before_apply}
              disabled={service.blocked || updateSettings.isPending}
              onChange={(next) => void write({ ...current, preview_before_apply: next })}
            />

            <SwitchRow
              label={<Trans>显示 Agent 读取了哪些证据</Trans>}
              hint={<Trans>在工作进度里展开 Agent 每次读取的回合与事件。</Trans>}
              name="show-evidence-reads"
              ariaLabel={t`显示 Agent 读取了哪些证据`}
              checked={current.show_evidence_reads}
              disabled={service.blocked || updateSettings.isPending}
              onChange={(next) => void write({ ...current, show_evidence_reads: next })}
            />

            <VideoLengthRow
              value={current.default_video_seconds}
              disabled={service.blocked || updateSettings.isPending}
              onCommit={(seconds) => void write({ ...current, default_video_seconds: seconds })}
            />

            <div className="flex flex-col gap-2">
              <p className="text-base">
                <Trans>默认视角</Trans>
              </p>
              <p className="text-xs text-neutral-600">
                <Trans>
                  Agent 把镜头交过来时用的初始视角。每个镜头仍可在方案里单独改。
                </Trans>
              </p>
              <Seg
                name="default-shot-view"
                size="sm"
                value={current.default_shot_view}
                aria-label={t`默认视角`}
                options={AGENT_SHOT_VIEWS.map((view) => ({
                  value: view,
                  label: i18n._(AGENT_SHOT_VIEW[view].label),
                  disabled: service.blocked || updateSettings.isPending,
                }))}
                onChange={(next) => void write({ ...current, default_shot_view: next })}
              />
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-base">
                <Trans>点评语气</Trans>
              </p>
              <Seg
                name="commentary-tone"
                size="sm"
                value={current.commentary_tone}
                aria-label={t`点评语气`}
                options={[
                  {
                    value: 'professional' as const,
                    label: <Trans>专业</Trans>,
                    disabled: service.blocked || updateSettings.isPending,
                  },
                  {
                    value: 'broadcast' as const,
                    label: <Trans>节目化</Trans>,
                    disabled: service.blocked || updateSettings.isPending,
                  },
                ]}
                onChange={(tone) => void write({ ...current, commentary_tone: tone })}
              />
              <p className="text-xs leading-normal text-neutral-600">
                <Trans>Agent 写点评与镜头意图时的措辞。</Trans>
              </p>
            </div>
          </>
        )}
      </Block>

      <Dialog
        open={confirming === 'retention'}
        tone="destructive"
        title={<Trans>现在按保留策略清理对话？</Trans>}
        confirmLabel={<Trans>立即应用</Trans>}
        confirmDisabled={applyRetention.isPending}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => void runRetention()}
      >
        <Trans>
          超出当前保留策略的会话会被删除，删掉的是对话本身。它们改过的方案、录制任务和已生成的视频都留下。
        </Trans>
      </Dialog>

      <Dialog
        open={confirming === 'clear'}
        tone="destructive"
        title={<Trans>清空全部对话？</Trans>}
        confirmLabel={<Trans>清空对话</Trans>}
        confirmDisabled={clearSessions.isPending}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => void runClear()}
      >
        <Trans>
          所有对话记录都会被删除，且不能恢复。方案、录制任务和已生成的视频不受影响，它们占用的空间也不会因此释放。
        </Trans>
      </Dialog>
    </div>
  );
}

/* ── the three blocks ────────────────────────────────────────────────────── */

/** The artboard's bordered block: a 34px head with a tracked label, then body. */
function Block({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section id={`setting-${id}`} data-setting-item={id} tabIndex={-1} className="border border-divider">
      <h3 className="flex h-[var(--h-panel-head)] items-center border-b border-divider px-3 font-heading text-sm tracking-wider">
        {title}
      </h3>
      <div className="flex flex-col gap-3.5 p-3">{children}</div>
    </section>
  );
}

interface ModelBlockProps {
  readonly provider: string | null;
  readonly model: string | null;
  readonly hasApiKey: boolean | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
}

/**
 * 模型. `AppConfig.llm` is the whole of what this section knows: provider,
 * model, and whether a key is stored (`llm_has_api_key` — the key itself is
 * never printed).
 *
 * The artboard's second line 「连接正常 · 支持工具调用」 and its 「测试连接」
 * button are **not** here. `LlmTestResult` exists on the bridge and
 * `DesktopClient` already lists `testLlm`, but `data/**` publishes no hook for
 * it, and a page that reaches for the client itself would be the first one in
 * the codebase to do so. Reported as a blocker; it is one hook in
 * `data/config.ts`, and this block gains a row when it lands.
 */
function ModelBlock({ provider, model, hasApiKey, loading, error, onRetry }: ModelBlockProps) {
  return (
    <Block id="model" title={<Trans>模型</Trans>}>
      {error !== null ? (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
          <Trans>读不到模型配置：{error}</Trans>
        </Alert>
      ) : loading ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <Skeleton width="72%" />
        </div>
      ) : (
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-neutral-800">
          {/* Each fact is omitted when the config does not carry it, rather than
              printed as an empty segment. */}
          {provider === null || provider === '' ? null : <span>{provider}</span>}
          {model === null || model === '' ? null : <span className="font-mono text-xs">{model}</span>}
          {hasApiKey === null ? null : (
            <span className="text-xs text-neutral-600">
              {hasApiKey ? <Trans>密钥已配置</Trans> : <Trans>还没有配置密钥</Trans>}
            </span>
          )}
        </p>
      )}
    </Block>
  );
}

interface RetentionRowProps {
  readonly current: AgentWorkspaceSettings;
  readonly disabled: boolean;
  readonly disabledReason: string | undefined;
  readonly onChange: (retention: AgentSessionRetention) => void;
  readonly onApplyNow: () => void;
  readonly applyProps: { disabled: boolean; disabledReason?: string };
  readonly applySuffix: ReactNode;
}

function RetentionRow({
  current,
  disabled,
  disabledReason,
  onChange,
  onApplyNow,
  applyProps,
  applySuffix,
}: RetentionRowProps) {
  const choices = retentionChoices(current.session_retention);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-base">
        <Trans>保留多久</Trans>
      </p>
      <Seg
        name="agent-session-retention"
        aria-label={t`会话保留多久`}
        value={retentionOptionId(current.session_retention)}
        options={choices.map((choice) => ({
          value: retentionOptionId(choice),
          label: <RetentionLabel retention={choice} />,
          disabled,
        }))}
        onChange={(id) => {
          const next = retentionFromOptionId(id, choices);
          if (next !== null) onChange(next);
        }}
      />
      {/* 「禁用并写明原因，不隐藏、不静默失败」 — a `Seg` has no `disabledReason`
          slot the way a Button does, so the reason is written beside it. */}
      {disabledReason === undefined ? null : (
        <p data-retention-disabled-reason="" className="text-xs leading-normal text-neutral-600">
          {disabledReason}
        </p>
      )}
      <p className="text-xs leading-normal text-neutral-600">
        <Trans>决定会话抽屉里能翻到多久以前。已生成的视频和任务记录不受影响。</Trans>
      </p>
      <div className="flex items-center gap-2.5">
        {/* The sweep has no scheduler on the wire — see this file's header for
            why the frontend does not invent one. This button is its one
            trigger, and it is a confirmation away from deleting. */}
        <p className="min-w-0 flex-1 text-xs leading-normal text-neutral-600">
          <Trans>改了策略不会立刻清理。要现在生效，用右边这个按钮。</Trans>
        </p>
        <Button size="sm" data-setting-action="apply-retention" onClick={onApplyNow} {...applyProps}>
          <Trans>立即应用</Trans>
          {applySuffix}
        </Button>
      </div>
    </div>
  );
}

function RetentionLabel({ retention }: { retention: AgentSessionRetention }) {
  switch (retention.mode) {
    case 'all':
      return <Trans>全部保留</Trans>;
    case 'recent_count':
      return <Plural value={retention.count} other="最近 # 条" />;
    case 'max_age_days':
      return <Plural value={retention.days} other="# 天" />;
    default:
      return <Trans>不保留</Trans>;
  }
}

interface TakeLimitRowProps {
  readonly value: number;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
}

/**
 * 每条会话保留的 take 上限.
 *
 * The artboard's second impact line — 「被选用过的 take 永不丢弃」 — is not
 * printed: §4.5.2's `Take` has no wire type at all (contract gap 8), so nothing
 * here can promise how the backend picks which one to drop. The limit is a real
 * stored field, so the control is real; the promise is not this page's to make.
 */
function TakeLimitRow({ value, disabled, onCommit }: TakeLimitRowProps) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = clampTakeLimit(draft ?? value);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-base">
        <Trans>每条会话保留的 take 上限</Trans>
      </p>
      <div className="flex items-center gap-3.5">
        <Slider
          className="min-w-0 flex-1"
          value={shown}
          min={TAKE_LIMIT_MIN}
          max={TAKE_LIMIT_MAX}
          step={1}
          disabled={disabled}
          aria-label={t`每条会话保留的 take 上限`}
          valueText={String(shown)}
          onChange={(next) => {
            setDraft(next);
          }}
          onCommit={(next) => {
            const settled = clampTakeLimit(next);
            if (settled !== value) onCommit(settled);
            setDraft(null);
          }}
        />
        <span data-take-limit={shown} className="w-7 flex-none font-mono text-sm">
          {shown}
        </span>
      </div>
      <p className="text-xs leading-normal text-neutral-600">
        <Trans>超过这个数量后，最早的 take 会被丢弃。</Trans>
      </p>
    </div>
  );
}

interface SwitchRowProps {
  readonly label: ReactNode;
  readonly hint: ReactNode;
  /** Becomes `data-setting`, so a test names the switch rather than its index. */
  readonly name: string;
  readonly ariaLabel: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (next: boolean) => void;
}

/**
 * One labelled switch with its explanatory line.
 *
 * The hint is not decoration: every row of this artboard states what the
 * setting *changes*, because a switch called 「显示 Agent 读取了哪些证据」 is
 * otherwise a guess about where the evidence would show up.
 */
function SwitchRow({ label, hint, name, ariaLabel, checked, disabled, onChange }: SwitchRowProps) {
  const hintId = `agent-${name}-hint`;
  return (
    <div className="flex items-center gap-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-base">{label}</p>
        <p id={hintId} className="mt-1 text-xs leading-normal text-neutral-600">
          {hint}
        </p>
      </div>
      <Toggle
        checked={checked}
        disabled={disabled}
        data-setting={name}
        aria-label={ariaLabel}
        aria-describedby={hintId}
        onChange={onChange}
      />
    </div>
  );
}

interface VideoLengthRowProps {
  readonly value: number;
  readonly disabled: boolean;
  readonly onCommit: (seconds: number) => void;
}

/** See `VideoLengthRow` — the lengths people actually ask a highlight for. */
const VIDEO_LENGTH_STOPS = [20, 40, 60, 90] as const;

/**
 * 「默认成片时长」. The artboard draws 「40 秒左右」 and 「左右」 is the whole
 * point: this is a target, not a ceiling, and the hint says so. A plan that
 * needs 44 seconds is not truncated to fit it.
 *
 * Stops rather than a free slider, because the answer is one of four numbers in
 * practice — and because the service accepts 5…3600, a value set elsewhere is
 * printed rather than hidden, or the panel would look like it had reset it.
 */
function VideoLengthRow({ value, disabled, onCommit }: VideoLengthRowProps) {
  const known = VIDEO_LENGTH_STOPS.some((seconds) => seconds === value);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-base">
        <Trans>默认成片时长</Trans>
      </p>
      <Seg
        name="default-video-seconds"
        size="sm"
        value={String(value)}
        aria-label={t`默认成片时长`}
        options={VIDEO_LENGTH_STOPS.map((seconds) => ({
          value: String(seconds),
          label: t`${seconds} 秒左右`,
          disabled,
        }))}
        onChange={(next) => onCommit(Number(next))}
      />
      <p className="text-xs leading-normal text-neutral-600">
        <Trans>
          Agent 设计镜头时瞄准的长度。它是目标不是上限，需要更长的方案不会被截断。
        </Trans>
      </p>
      {known ? null : (
        <p className="text-xs leading-normal text-neutral-600" data-video-length-custom={value}>
          <Trans>当前是 {value} 秒，不在上面这几档里。</Trans>
        </p>
      )}
    </div>
  );
}

interface StorageRowProps {
  readonly bytes: number | null;
  readonly planBytes: number | null;
  readonly sessionCount: number | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onExport: () => void;
  readonly exportResult: { count: number; at: string } | null;
  readonly exportError: string | null;
  readonly onClear: () => void;
  readonly busy: boolean;
  readonly service: { disabled: boolean; disabledReason?: string };
  readonly serviceSuffix: ReactNode;
}

/**
 * 「当前占用 38 MB · 14 条会话」 plus 导出 / 清空会话.
 *
 * `plan_bytes` is printed beside it because it is the honest half of a clear:
 * `AgentSessionStorageStats` splits the two on purpose, and the confirmation
 * dialog would otherwise be the only place the user learns that clearing
 * conversations frees none of the plan storage.
 */
function StorageRow({
  bytes,
  planBytes,
  sessionCount,
  loading,
  error,
  onRetry,
  onExport,
  exportResult,
  exportError,
  onClear,
  busy,
  service,
  serviceSuffix,
}: StorageRowProps) {
  const conversation = formatBytes(bytes);
  const plans = formatBytes(planBytes);

  return (
    <div className="flex flex-col gap-2.5 border-t border-divider pt-3">
      {error !== null ? (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
          <Trans>读不到会话占用：{error}</Trans>
        </Alert>
      ) : null}

      {exportError === null ? null : (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onExport }}>
          <Trans>导出没有完成：{exportError}</Trans>
        </Alert>
      )}

      {exportResult === null ? null : (
        <p data-export-result="" className="text-xs leading-normal text-neutral-700">
          <Plural value={exportResult.count} other="已导出 # 条会话" />
          {' · '}
          <time dateTime={exportResult.at}>{exportResult.at}</time>
        </p>
      )}

      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1 text-sm text-neutral-800">
          {loading ? (
            <Skeleton width="60%" />
          ) : (
            <>
              <p>
                {/* Every fact here is omitted when the stat is absent — never a
                    「0 B」 standing in for 「不知道」. */}
                {conversation === null ? null : <Trans>当前占用 {conversation}</Trans>}
                {conversation !== null && sessionCount !== null ? ' · ' : null}
                {sessionCount === null ? null : (
                  <Plural value={sessionCount} other="# 条会话" />
                )}
              </p>
              <p className="mt-1 text-xs text-neutral-600">
                <Trans>全部存在本机，不上传。</Trans>
                {plans === null ? null : (
                  <>
                    {' '}
                    <Trans>方案另占 {plans}，清空会话不会释放这部分。</Trans>
                  </>
                )}
              </p>
            </>
          )}
        </div>

        <Button
          size="sm"
          data-setting-action="export"
          onClick={onExport}
          {...(service.disabled ? service : busy ? { disabled: true, disabledReason: t`正在处理上一次操作` } : { disabled: false })}
        >
          <Trans>导出</Trans>
          {serviceSuffix}
        </Button>
        <Button
          size="sm"
          data-setting-action="clear"
          onClick={onClear}
          {...(service.disabled ? service : busy ? { disabled: true, disabledReason: t`正在处理上一次操作` } : { disabled: false })}
        >
          <Trans>清空对话</Trans>
          {serviceSuffix}
        </Button>
      </div>
    </div>
  );
}
