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
import { ChevronRight } from 'lucide-react';
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
import { Skeleton } from '../../design/data';
import { Dialog, Alert } from '../../design/feedback';
import { Button, Field, Input, Seg, Textarea, Toggle } from '../../design/primitives';
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
  retentionChoices,
  retentionFromOptionId,
} from './aiAgentModel';

/** Which irreversible action is waiting for its second confirmation. */
type PendingConfirmation = 'retention' | 'clear' | null;

const SHOT_VIEW_OPTIONS = [
  { value: 'pov' as const, label: t`第一人称` },
  { value: 'tracking' as const, label: t`跟随` },
  { value: 'orbit' as const, label: t`环绕` },
  { value: 'dolly' as const, label: t`推轨` },
  { value: 'static' as const, label: t`固定` },
  { value: 'crane' as const, label: t`升降` },
  { value: 'flyby' as const, label: t`飞越` },
] as const;

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
          <Plural value={removed} other="已删除 # 条对话，剪辑单、后台任务和成片都还在" />
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
            <Trans>读不到 Agent 的对话设置：{settingsError}</Trans>
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

          </>
        )}

        <StorageRow
          bytes={storage.data?.conversation_bytes ?? null}
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
              <Trans>此确认始终开启：录制会启动游戏并写出文件，每次都由你确认。</Trans>
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
                  Agent 创建片段时默认使用这个视角。每个片段仍可单独调整。
                </Trans>
              </p>
              <Seg
                name="default-shot-view"
                size="sm"
                value={current.default_camera_style}
                aria-label={t`默认视角`}
                options={SHOT_VIEW_OPTIONS.map((view) => ({
                  value: view.value,
                  label: i18n._(view.label),
                  disabled: service.blocked || updateSettings.isPending,
                }))}
                onChange={(next) => void write({ ...current, default_camera_style: next })}
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
                <Trans>Agent 撰写点评和片段说明时使用的语气。</Trans>
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
          超出保留范围的对话会被删除。剪辑单、录制任务和成片不受影响。
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
          清空会删除全部对话记录。剪辑单、录制任务和成片继续保留。
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
    ?? (!parametersAreObject ? t`请求参数必须是 JSON 对象` : null)
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
            <Trans>连接信息</Trans>
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
                setParameterJsonError(t`请输入有效的 JSON 对象`);
              }
            }}
          />
          <Field
            label={<Trans>自定义指令</Trans>}
            hint={<Trans>这些指令会随每轮请求发送给模型。留空时使用 Agent 的系统指令。</Trans>}
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
  if (parameters === null) return t`请输入 JSON 对象（键值对象）`;
  const reserved = Object.keys(parameters).find((key) =>
    RUNTIME_PROVIDER_PARAMETER_KEYS.has(key.toLowerCase()));
  if (reserved !== undefined) return t`${reserved} 由 Agent 运行时统一生成`;
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
  const customCount = Object.keys(parameters).length;

  const update = (key: string, value: JsonValue | undefined) => {
    onParametersChange(setProviderParameter(parameters, key, value));
  };

  return (
    <details className="group border border-divider" data-provider-parameters="">
      <summary className="flex min-h-[var(--h-row)] cursor-pointer list-none items-center gap-3 px-4 py-2.5">
        <span className="font-heading text-sm"><Trans>请求参数</Trans></span>
        <span className="text-xs text-neutral-600"><Trans>使用提供方默认值</Trans></span>
        <span className="text-xs text-neutral-600" data-custom-parameter-count={customCount}>
          <Trans>{customCount} 项自定义</Trans>
        </span>
        <ChevronRight
          size={15}
          strokeWidth={1.5}
          aria-hidden="true"
          className="ml-auto flex-none transition-transform group-open:rotate-90"
        />
      </summary>

      <div className="flex flex-col gap-4 border-t border-divider p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex min-w-64 flex-1 flex-col gap-2">
            <p className="text-sm"><Trans>接口格式</Trans></p>
            <Seg
              name="llm-parameter-style"
              size="sm"
              value={style}
              aria-label={t`请求参数格式`}
              options={[
                { value: 'openai' as const, label: 'OpenAI', disabled },
                { value: 'anthropic' as const, label: 'Anthropic', disabled },
              ]}
              onChange={onStyleChange}
            />
          </div>
          <Button
            size="sm"
            disabled={disabled || customCount === 0}
            onClick={() => onParametersChange({})}
          >
            <Trans>恢复提供方默认值</Trans>
          </Button>
        </div>

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
        </div>
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>Temperature 和 Top P 通常只需设置一个。</Trans>
        </p>

        <Field label={<Trans>停止序列</Trans>} hint={<Trans>每行一项，填写后会随请求发送。</Trans>}>
          {(control) => (
            <Textarea {...control} rows={2} value={stopValue} disabled={disabled}
              onChange={(event) => {
                const values = event.target.value.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
                update(stopKey, values.length === 0 ? undefined : values);
              }} />
          )}
        </Field>

        <Field
          label={<Trans>完整参数 JSON</Trans>}
          hint={<Trans>API 密钥和私密请求头由上方的连接配置保管。</Trans>}
        >
          {(control) => (
            <Textarea {...control} rows={7} className="font-mono text-xs"
              value={rawDraft ?? JSON.stringify(parameters, null, 2)} disabled={disabled}
              aria-invalid={rawError === null ? undefined : true}
              onChange={(event) => onRawChange(event.target.value)} />
          )}
        </Field>
        {rawError === null ? null : <p className="text-xs text-danger">{rawError}</p>}
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>Agent 运行时统一生成 model、messages、tools、tool_choice、stream 与认证字段。</Trans>
        </p>
      </div>
    </details>
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
          disabled={disabled} placeholder={t`提供方默认值`}
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
        aria-label={t`对话保留多久`}
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
        <Trans>决定对话列表保留多久。成片和后台任务不会删除。</Trans>
      </p>
      <div className="flex items-center gap-2.5">
        {/* The sweep has no scheduler on the wire — see this file's header for
            why the frontend does not invent one. This button is its one
            trigger, and it is a confirmation away from deleting. */}
        <p className="min-w-0 flex-1 text-xs leading-normal text-neutral-600">
          <Trans>新策略不会立即清理旧对话。要现在清理，点「立即应用」。</Trans>
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
      return <Trans>保留 0 条</Trans>;
  }
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
          Agent 会以这个时长规划剪辑单，不会强行截断更长的成片。
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

  return (
    <div className="flex flex-col gap-2.5 border-t border-divider pt-3">
      {error !== null ? (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onRetry }}>
          <Trans>读不到对话占用：{error}</Trans>
        </Alert>
      ) : null}

      {exportError === null ? null : (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onExport }}>
          <Trans>导出没有完成：{exportError}</Trans>
        </Alert>
      )}

      {exportResult === null ? null : (
        <p data-export-result="" className="text-xs leading-normal text-neutral-700">
          <Plural value={exportResult.count} other="已导出 # 条对话" />
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
                  <Plural value={sessionCount} other="# 条对话" />
                )}
              </p>
              <p className="mt-1 text-xs text-neutral-600">
                <Trans>全部存在本机，不上传。</Trans>
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
