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

import { useAppConfig, useTestLlm, useUpdateAppConfig } from '../../data/config';
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
import { Button, Field, Input, Seg, Slider, Textarea, Toggle } from '../../design/primitives';
import type {
  AgentSessionRetention,
  AgentWorkspaceSettings,
  JsonValue,
  LlmConfig,
  LlmParameterStyle,
} from '../../shared/desktop/dto';
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
  const updateConfig = useUpdateAppConfig();
  const testLlm = useTestLlm();
  const settings = useAgentWorkspaceSettings();
  const storage = useAgentSessionStorage();

  const updateSettings = useUpdateAgentWorkspaceSettings();
  const applyRetention = useApplyAgentSessionRetention();
  const exportSessions = useExportAgentSessions();
  const clearSessions = useClearAgentSessions();

  const [confirming, setConfirming] = useState<PendingConfirmation>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<number | null>(null);
  const [llmDraft, setLlmDraft] = useState<LlmConfig | null>(null);

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
        draft={llmDraft ?? config.data?.llm ?? null}
        hasApiKey={config.data?.llm_has_api_key ?? null}
        loading={config.isPending}
        error={dataErrorMessage(config.error)}
        disabled={service.blocked || updateConfig.isPending || testLlm.isPending}
        disabledReason={service.blocked ? service.buttonProps.disabledReason : undefined}
        saving={updateConfig.isPending}
        testing={testLlm.isPending}
        testResult={testLlm.data === undefined ? null : `${testLlm.data.provider} · ${testLlm.data.model}`}
        testError={dataErrorMessage(testLlm.error)}
        onChange={setLlmDraft}
        onSave={() => {
          const current = config.data;
          const draft = llmDraft ?? current?.llm;
          if (current === undefined || draft === undefined) return;
          void updateConfig.mutateAsync({ ...current, llm: draft, clear_llm_api_key: false })
            .then(() => {
              setLlmDraft(null);
              testLlm.reset();
            })
            .catch((cause) => {
              setWriteError(dataErrorMessage(cause) ?? t`模型设置没有保存成功`);
            });
        }}
        onTest={() => {
          const draft = llmDraft ?? config.data?.llm;
          if (draft !== undefined) testLlm.mutate(draft);
        }}
        onResetTest={() => testLlm.reset()}
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
function Block({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: ReactNode;
  actions?: ReactNode | undefined;
  children: ReactNode;
}) {
  return (
    <section id={`setting-${id}`} data-setting-item={id} tabIndex={-1} className="border border-divider">
      <header className="flex min-h-[var(--h-panel-head)] items-center gap-3 border-b border-divider px-3 py-1">
        <h3 className="font-heading text-sm tracking-wider">{title}</h3>
        {actions === undefined ? null : <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>
      <div className="flex flex-col gap-3.5 p-3">{children}</div>
    </section>
  );
}

interface ModelBlockProps {
  readonly draft: LlmConfig | null;
  readonly hasApiKey: boolean | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly disabledReason: string | undefined;
  readonly saving: boolean;
  readonly testing: boolean;
  readonly testResult: string | null;
  readonly testError: string | null;
  readonly onChange: (draft: LlmConfig) => void;
  readonly onSave: () => void;
  readonly onTest: () => void;
  readonly onResetTest: () => void;
  readonly onRetry: () => void;
}

/**
 * 模型. `AppConfig.llm` is the whole of what this section knows: provider,
 * model, provider-owned generation parameters, and whether a key is stored
 * (`llm_has_api_key` — the key itself is never printed).
 *
 * The form writes through the same whole-document config mutation as the other
 * settings. Testing is separate and may use an unsaved draft; an empty key asks
 * the backend to reuse the stored secret rather than reflecting it to the UI.
 */
function ModelBlock({
  draft,
  hasApiKey,
  loading,
  error,
  disabled,
  disabledReason,
  saving,
  testing,
  testResult,
  testError,
  onChange,
  onSave,
  onTest,
  onResetTest,
  onRetry,
}: ModelBlockProps) {
  const [parameterJsonDraft, setParameterJsonDraft] = useState<string | null>(null);
  const [parameterJsonError, setParameterJsonError] = useState<string | null>(null);
  const parameters = providerParameterObject(draft?.parameters);
  const parametersAreObject = draft === null || parameters !== null;
  const invalid = draft === null
    || draft.provider.trim() === ''
    || draft.model.trim() === ''
    || !/^https?:\/\//u.test(draft.base_url.trim())
    || (hasApiKey === false && draft.api_key.trim() === '')
    || !parametersAreObject
    || parameterJsonError !== null;
  const actionDisabled = disabled || invalid;
  const actionDisabledReason = parameterJsonError
    ?? (!parametersAreObject ? t`Provider 参数必须是 JSON object` : null)
    ?? (invalid ? t`请补齐提供方、模型、API 地址和密钥` : disabledReason);
  const actionProps = actionDisabled
    ? { disabled: true, ...(actionDisabledReason === undefined ? {} : { disabledReason: actionDisabledReason }) }
    : {};
  return (
    <Block
      id="model"
      title={<Trans>模型</Trans>}
      actions={draft === null ? undefined : (
        <>
          <Button variant="primary" size="sm" onClick={onSave} {...actionProps}>
            {saving ? <Trans>正在保存</Trans> : <Trans>保存模型设置</Trans>}
          </Button>
          <Button size="sm" onClick={onTest} {...actionProps}>
            {testing ? <Trans>正在测试</Trans> : <Trans>测试连接</Trans>}
          </Button>
        </>
      )}
    >
      {error !== null ? (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
          <Trans>读不到模型配置：{error}</Trans>
        </Alert>
      ) : loading ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <Skeleton width="72%" />
        </div>
      ) : draft === null ? null : (
        <div className="flex flex-col gap-3">
          <p className="border-b border-divider pb-2 font-heading text-sm">
            <Trans>1. 连接与身份</Trans>
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={<Trans>提供方</Trans>} required>
              {(control) => (
                <Input {...control} value={draft.provider} disabled={disabled}
                  placeholder="openai-compatible"
                  onChange={(event) => onChange({ ...draft, provider: event.target.value })} />
              )}
            </Field>
            <Field label={<Trans>模型</Trans>} required>
              {(control) => (
                <Input {...control} value={draft.model} disabled={disabled}
                  placeholder="gpt-4.1-mini"
                  onChange={(event) => onChange({ ...draft, model: event.target.value })} />
              )}
            </Field>
            <Field label={<Trans>API 地址</Trans>} required hint={<Trans>OpenAI 兼容接口，填写到 /v1。</Trans>}>
              {(control) => (
                <Input {...control} type="url" value={draft.base_url} disabled={disabled}
                  placeholder="https://api.openai.com/v1"
                  onChange={(event) => onChange({ ...draft, base_url: event.target.value })} />
              )}
            </Field>
            <Field label={<Trans>API 密钥</Trans>}
              hint={hasApiKey ? <Trans>留空会保留已经安全保存的密钥。</Trans> : <Trans>首次配置需要填写密钥。</Trans>}>
              {(control) => (
                <Input {...control} type="password" value={draft.api_key} disabled={disabled}
                  placeholder={hasApiKey ? '••••••••' : 'sk-…'}
                  onChange={(event) => onChange({ ...draft, api_key: event.target.value })} />
              )}
            </Field>
          </div>
          <ProviderParametersEditor
            style={draft.parameter_style}
            parameters={parameters ?? {}}
            rawDraft={parameterJsonDraft}
            rawError={parameterJsonError}
            disabled={disabled}
            onStyleChange={(parameterStyle) => {
              setParameterJsonDraft(null);
              setParameterJsonError(null);
              onChange({ ...draft, parameter_style: parameterStyle });
            }}
            onParametersChange={(next) => {
              setParameterJsonDraft(null);
              setParameterJsonError(null);
              onChange({ ...draft, parameters: next });
            }}
            onRawChange={(raw) => {
              setParameterJsonDraft(raw);
              try {
                const parsed = JSON.parse(raw) as JsonValue;
                const object = providerParameterObject(parsed);
                const validation = validateProviderParameterObject(object);
                if (validation !== null) {
                  setParameterJsonError(validation);
                  return;
                }
                setParameterJsonError(null);
                onChange({ ...draft, parameters: object ?? {} });
              } catch {
                setParameterJsonError(t`必须是有效的 JSON object`);
              }
            }}
          />
          <Field
            label={<span className="before:content-['5._']"><Trans>自定义指令</Trans></span>}
            hint={<Trans>会追加到 Agent 的系统指令；留空使用默认行为。</Trans>}
          >
            {(control) => (
              <Textarea {...control} rows={2} value={draft.prompt} disabled={disabled}
                onChange={(event) => onChange({ ...draft, prompt: event.target.value })} />
            )}
          </Field>
          {testError === null ? null : (
            <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onTest }}>
              <Trans>模型连接失败：{testError}</Trans>
            </Alert>
          )}
          {testResult === null ? null : (
            <Alert variant="success" action={{ label: <Trans>知道了</Trans>, onAction: onResetTest }}>
              <Trans>连接正常：{testResult}，支持 Agent 工具调用。</Trans>
            </Alert>
          )}
          {disabledReason === undefined ? null : <p className="text-xs text-warn">{disabledReason}</p>}
        </div>
      )}
    </Block>
  );
}

type ProviderParameterObject = { [key: string]: JsonValue };

const RUNTIME_PROVIDER_PARAMETER_KEYS = new Set([
  'api_key',
  'base_url',
  'function_call',
  'functions',
  'messages',
  'model',
  'stream',
  'stream_options',
  'system',
  'tool_choice',
  'tools',
]);

function providerParameterObject(value: JsonValue | undefined): ProviderParameterObject | null {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
    return value === undefined ? {} : null;
  }
  return value;
}

function validateProviderParameterObject(parameters: ProviderParameterObject | null): string | null {
  if (parameters === null) return t`必须是 JSON object，不能是数组或单个值`;
  const reserved = Object.keys(parameters).find((key) =>
    RUNTIME_PROVIDER_PARAMETER_KEYS.has(key.toLowerCase()));
  if (reserved !== undefined) return t`${reserved} 由 Agent 运行时管理，不能在这里覆盖`;
  return null;
}

function setProviderParameter(
  parameters: ProviderParameterObject,
  key: string,
  value: JsonValue | undefined,
): ProviderParameterObject {
  const next = { ...parameters };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function parameterRecord(value: JsonValue | undefined): ProviderParameterObject | null {
  return providerParameterObject(value);
}

function parameterNumber(parameters: ProviderParameterObject, key: string): number | undefined {
  const value = parameters[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

interface ProviderParametersEditorProps {
  readonly style: LlmParameterStyle;
  readonly parameters: ProviderParameterObject;
  readonly rawDraft: string | null;
  readonly rawError: string | null;
  readonly disabled: boolean;
  readonly onStyleChange: (style: LlmParameterStyle) => void;
  readonly onParametersChange: (parameters: ProviderParameterObject) => void;
  readonly onRawChange: (raw: string) => void;
}

function ProviderParametersEditor({
  style,
  parameters,
  rawDraft,
  rawError,
  disabled,
  onStyleChange,
  onParametersChange,
  onRawChange,
}: ProviderParametersEditorProps) {
  const stopKey = style === 'openai' ? 'stop' : 'stop_sequences';
  const stopValue = Array.isArray(parameters[stopKey])
    ? parameters[stopKey].filter((value): value is string => typeof value === 'string').join('\n')
    : '';
  const thinking = parameterRecord(parameters.thinking);
  const thinkingMode = typeof thinking?.type === 'string' ? thinking.type : 'provider_default';
  const outputConfig = parameterRecord(parameters.output_config);
  const anthropicEffort = typeof outputConfig?.effort === 'string'
    ? outputConfig.effort
    : 'provider_default';
  const openAiEffort = typeof parameters.reasoning_effort === 'string'
    ? parameters.reasoning_effort
    : 'provider_default';

  const update = (key: string, value: JsonValue | undefined) => {
    onParametersChange(setProviderParameter(parameters, key, value));
  };

  return (
    <div className="flex flex-col gap-3 border-t border-divider pt-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-heading text-sm"><Trans>2. Provider 参数</Trans></p>
          <p className="mt-1 text-xs leading-normal text-neutral-600">
            <Trans>Vibe CS 不再自动设置 reasoning、采样或输出上限。留空就使用 provider 默认值。</Trans>
          </p>
        </div>
        <Button size="sm" disabled={disabled || Object.keys(parameters).length === 0}
          onClick={() => onParametersChange({})}>
          <Trans>清空参数</Trans>
        </Button>
      </div>

      <Seg
        name="llm-parameter-style"
        size="sm"
        value={style}
        aria-label={t`Provider 参数风格`}
        options={[
          { value: 'openai' as const, label: 'OpenAI', disabled },
          { value: 'anthropic' as const, label: 'Anthropic', disabled },
        ]}
        onChange={onStyleChange}
      />

      <div className="grid grid-cols-2 gap-3">
        <OptionalNumberParameter
          label={<Trans>Temperature</Trans>}
          value={parameterNumber(parameters, 'temperature')}
          min={0}
          max={style === 'openai' ? 2 : 1}
          step={0.1}
          disabled={disabled}
          onChange={(value) => update('temperature', value)}
        />
        <OptionalNumberParameter
          label={<Trans>Top P</Trans>}
          value={parameterNumber(parameters, 'top_p')}
          min={0}
          max={1}
          step={0.05}
          disabled={disabled}
          onChange={(value) => update('top_p', value)}
        />
        <OptionalNumberParameter
          label={style === 'openai' ? <Trans>Max completion tokens</Trans> : <Trans>Max tokens</Trans>}
          value={parameterNumber(parameters, style === 'openai' ? 'max_completion_tokens' : 'max_tokens')}
          min={1}
          step={1}
          disabled={disabled}
          onChange={(value) => update(style === 'openai' ? 'max_completion_tokens' : 'max_tokens', value)}
        />
        {style === 'openai' ? (
          <OptionalNumberParameter
            label={<Trans>Seed</Trans>}
            value={parameterNumber(parameters, 'seed')}
            step={1}
            disabled={disabled}
            onChange={(value) => update('seed', value)}
          />
        ) : (
          <OptionalNumberParameter
            label={<Trans>Top K</Trans>}
            value={parameterNumber(parameters, 'top_k')}
            min={0}
            step={1}
            disabled={disabled}
            onChange={(value) => update('top_k', value)}
          />
        )}
        {style === 'openai' ? (
          <>
            <OptionalNumberParameter
              label={<Trans>Presence penalty</Trans>}
              value={parameterNumber(parameters, 'presence_penalty')}
              min={-2}
              max={2}
              step={0.1}
              disabled={disabled}
              onChange={(value) => update('presence_penalty', value)}
            />
            <OptionalNumberParameter
              label={<Trans>Frequency penalty</Trans>}
              value={parameterNumber(parameters, 'frequency_penalty')}
              min={-2}
              max={2}
              step={0.1}
              disabled={disabled}
              onChange={(value) => update('frequency_penalty', value)}
            />
          </>
        ) : null}
      </div>

      {style === 'openai' ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm"><Trans>Reasoning effort</Trans></p>
          <Seg
            name="openai-reasoning-effort"
            size="sm"
            value={openAiEffort}
            aria-label={t`OpenAI reasoning effort`}
            options={['provider_default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => ({
              value,
              label: value === 'provider_default' ? t`Provider 默认` : value,
              disabled,
            }))}
            onChange={(value) => update('reasoning_effort', value === 'provider_default' ? undefined : value)}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-sm"><Trans>Thinking</Trans></p>
            <Seg
              name="anthropic-thinking"
              size="sm"
              value={thinkingMode}
              aria-label={t`Anthropic thinking`}
              options={['provider_default', 'adaptive', 'enabled', 'disabled'].map((value) => ({
                value,
                label: value === 'provider_default' ? t`Provider 默认` : value,
                disabled,
              }))}
              onChange={(value) => {
                if (value === 'provider_default') update('thinking', undefined);
                else if (value === 'enabled') update('thinking', { type: 'enabled', budget_tokens: 1024 });
                else update('thinking', { type: value });
              }}
            />
          </div>
          {thinkingMode === 'enabled' ? (
            <OptionalNumberParameter
              label={<Trans>Thinking budget tokens</Trans>}
              value={typeof thinking?.budget_tokens === 'number' ? thinking.budget_tokens : undefined}
              min={1024}
              step={1}
              disabled={disabled}
              onChange={(value) => update('thinking', {
                ...(thinking ?? {}),
                type: 'enabled',
                ...(value === undefined ? {} : { budget_tokens: value }),
              })}
            />
          ) : null}
          <div className="flex flex-col gap-2">
            <p className="text-sm"><Trans>Output effort</Trans></p>
            <Seg
              name="anthropic-output-effort"
              size="sm"
              value={anthropicEffort}
              aria-label={t`Anthropic output effort`}
              options={['provider_default', 'low', 'medium', 'high', 'max'].map((value) => ({
                value,
                label: value === 'provider_default' ? t`Provider 默认` : value,
                disabled,
              }))}
              onChange={(value) => update(
                'output_config',
                value === 'provider_default' ? undefined : { ...(outputConfig ?? {}), effort: value },
              )}
            />
          </div>
        </>
      )}

      <Field
        label={<span className="before:content-['3._']"><Trans>Stop sequences</Trans></span>}
        hint={<Trans>每行一个；留空不发送。</Trans>}
      >
        {(control) => (
          <Textarea {...control} rows={2} value={stopValue} disabled={disabled}
            onChange={(event) => {
              const values = event.target.value.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
              update(stopKey, values.length === 0 ? undefined : values);
            }} />
        )}
      </Field>

      <Field label={<span className="before:content-['4._']"><Trans>完整参数 JSON</Trans></span>}
        hint={<Trans>常用字段与这里编辑的是同一个 object。不要放 API key 或私密 header。</Trans>}>
        {(control) => (
          <Textarea {...control} rows={7} className="font-mono text-xs"
            value={rawDraft ?? JSON.stringify(parameters, null, 2)} disabled={disabled}
            aria-invalid={rawError === null ? undefined : true}
            onChange={(event) => onRawChange(event.target.value)} />
        )}
      </Field>
      {rawError === null ? null : <p className="text-xs text-danger">{rawError}</p>}
      <p className="text-xs leading-normal text-neutral-600">
        <Trans>model、messages、tools、tool_choice、stream 和认证字段由 Agent 管理，JSON 中不能覆盖。</Trans>
      </p>
    </div>
  );
}

function OptionalNumberParameter({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  readonly label: ReactNode;
  readonly value: number | undefined;
  readonly min?: number;
  readonly max?: number;
  readonly step: number;
  readonly disabled: boolean;
  readonly onChange: (value: number | undefined) => void;
}) {
  return (
    <Field label={label}>
      {(control) => (
        <Input {...control} type="number" value={value ?? ''} min={min} max={max} step={step}
          disabled={disabled} placeholder="Provider default"
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') onChange(undefined);
            else {
              const parsed = Number(raw);
              if (Number.isFinite(parsed)) onChange(parsed);
            }
          }} />
      )}
    </Field>
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
