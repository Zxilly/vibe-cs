import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { useAppConfig, useQuickCheck } from '../../data/config';
import { useDemo } from '../../data/demos';
import { dataErrorMessage } from '../../data/errors';
import { StatusDot, type StatusDotStatus } from '../../design/feedback';
import type { DemoLifecycleStatus } from '../../shared/desktop/dto';
import { RouteLink } from '../RouteLink';
import { settingsPath } from '../settings/settingsRoutes';
import type { AgentGuardedAction } from './agentContract';

export type AgentReadinessKey = 'demo' | 'analysis' | 'model' | 'recording';

export interface AgentReadinessItem {
  readonly key: AgentReadinessKey;
  readonly label: string;
  readonly detail: string;
  readonly state: StatusDotStatus;
  readonly blocking: boolean;
  readonly action: { readonly label: string; readonly to: string } | null;
}

export interface AgentReadinessState {
  readonly items: readonly AgentReadinessItem[];
  readonly gate: AgentGuardedAction;
}

interface ReadinessInput {
  readonly projectId: string | null;
  readonly demoId: string | null;
  readonly demoStatus: DemoLifecycleStatus | null;
  readonly demoPending: boolean;
  readonly demoError: string | null;
  readonly modelConfigured: boolean | null;
  readonly modelPending: boolean;
  readonly modelError: string | null;
  readonly recordingMissing: readonly string[];
  readonly recordingPending: boolean;
  readonly recordingError: string | null;
}

export function buildAgentReadiness(input: ReadinessInput): AgentReadinessState {
  const selectPath = `/projects/${encodeURIComponent(input.projectId ?? 'new')}?step=select`;
  const demo: AgentReadinessItem = input.demoId === null
    ? {
        key: 'demo', label: t`Demo`, detail: t`先选择一份 Demo 作为视频素材`,
        state: 'warn', blocking: true, action: { label: t`选择 Demo`, to: selectPath },
      }
    : input.demoError !== null
      ? {
          key: 'demo', label: t`Demo`, detail: input.demoError,
          state: 'fail', blocking: true, action: { label: t`返回选材`, to: selectPath },
        }
      : input.demoPending
        ? {
            key: 'demo', label: t`Demo`, detail: t`正在读取素材`,
            state: 'running', blocking: true, action: null,
          }
        : {
            key: 'demo', label: t`Demo`, detail: t`已关联当前作品`,
            state: 'ok', blocking: false, action: null,
          };

  const analysis = analysisReadiness(input, selectPath);
  const model: AgentReadinessItem = input.modelError !== null
    ? {
        key: 'model', label: t`AI 模型`, detail: input.modelError,
        state: 'fail', blocking: true, action: { label: t`配置模型`, to: settingsPath('model') },
      }
    : input.modelPending
      ? {
          key: 'model', label: t`AI 模型`, detail: t`正在读取模型配置`,
          state: 'running', blocking: true, action: null,
        }
      : input.modelConfigured === true
        ? {
            key: 'model', label: t`AI 模型`, detail: t`配置已保存，可在设置中测试连接`,
            state: 'ok', blocking: false, action: { label: t`测试连接`, to: settingsPath('model') },
          }
        : {
            key: 'model', label: t`AI 模型`, detail: t`还没有可用的模型配置`,
            state: 'warn', blocking: true, action: { label: t`配置模型`, to: settingsPath('model') },
          };

  const recording: AgentReadinessItem = input.recordingError !== null
    ? {
        key: 'recording', label: t`录制环境`, detail: input.recordingError,
        state: 'fail', blocking: false, action: { label: t`检查录制设置`, to: settingsPath('game') },
      }
    : input.recordingPending
      ? {
          key: 'recording', label: t`录制环境`, detail: t`正在检查本机环境`,
          state: 'running', blocking: false, action: null,
        }
      : input.recordingMissing.length === 0
        ? {
            key: 'recording', label: t`录制环境`, detail: t`本机录制依赖已就绪`,
            state: 'ok', blocking: false, action: null,
          }
        : {
            key: 'recording', label: t`录制环境`,
            detail: t`${input.recordingMissing.join('、')} 尚未就绪；不影响先生成剪辑单`,
            state: 'warn', blocking: false, action: { label: t`检查录制设置`, to: settingsPath('game') },
          };

  const items = [demo, analysis, model, recording] as const;
  const firstBlocker = items.find((item) => item.blocking);
  return {
    items,
    gate: firstBlocker === undefined
      ? { disabled: false }
      : { disabled: true, disabledReason: firstBlocker.detail },
  };
}

function analysisReadiness(input: ReadinessInput, selectPath: string): AgentReadinessItem {
  if (input.demoId === null) {
    return {
      key: 'analysis', label: t`Demo 分析`, detail: t`选择 Demo 后检查分析结果`,
      state: 'idle', blocking: true, action: null,
    };
  }
  if (input.demoPending || input.demoStatus === null) {
    return {
      key: 'analysis', label: t`Demo 分析`, detail: t`正在读取分析状态`,
      state: 'running', blocking: true, action: null,
    };
  }
  if (input.demoStatus === 'ready') {
    return {
      key: 'analysis', label: t`Demo 分析`, detail: t`分析结果可供 Agent 使用`,
      state: 'ok', blocking: false, action: null,
    };
  }
  const failed = input.demoStatus === 'failed' || input.demoStatus === 'missing';
  return {
    key: 'analysis', label: t`Demo 分析`,
    detail: failed ? t`分析不可用，需要先回到素材处理` : t`分析尚未完成，完成后即可生成剪辑单`,
    state: failed ? 'fail' : 'running', blocking: true,
    action: {
      label: t`查看 Demo`,
      to: input.demoId === null ? selectPath : `/match/${encodeURIComponent(input.demoId)}`,
    },
  };
}

export function useAgentReadiness(input: {
  readonly projectId: string | null;
  readonly demoId: string | null;
}): AgentReadinessState {
  const demo = useDemo(input.demoId);
  const config = useAppConfig();
  const checks = useQuickCheck();
  const llm = config.data?.llm;
  const modelConfigured = config.data === undefined
    ? null
    : Boolean(
        llm?.provider.trim()
        && llm.model.trim()
        && llm.base_url.trim()
        && config.data.llm_has_api_key,
      );
  return buildAgentReadiness({
    ...input,
    demoStatus: demo.data?.lifecycle_status ?? null,
    demoPending: input.demoId !== null && demo.isPending,
    demoError: dataErrorMessage(demo.error),
    modelConfigured,
    modelPending: config.isPending,
    modelError: dataErrorMessage(config.error),
    recordingMissing: (checks.data?.checks ?? [])
      .filter((check) => check.state === 'missing')
      .map((check) => check.label),
    recordingPending: checks.isPending,
    recordingError: dataErrorMessage(checks.error),
  });
}

export function AgentReadiness({ state }: { readonly state: AgentReadinessState }) {
  return (
    <section className="flex-none border-b border-divider px-4 py-3" aria-label={t`创作准备检查`}>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-36">
          <h3 className="text-sm font-medium"><Trans>创作准备</Trans></h3>
          <p className="text-xs text-neutral-600"><Trans>先生成剪辑单，录制环境可以稍后补齐</Trans></p>
        </div>
        <ul className="m-0 flex min-w-0 flex-1 list-none flex-wrap gap-x-5 gap-y-2 p-0">
          {state.items.map((item) => (
            <li key={item.key} className="flex min-w-48 items-start gap-2" data-agent-readiness={item.key}>
              <StatusDot status={item.state} className="mt-1" />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{item.label}</span>
                <span className="block text-xs text-neutral-600">{item.detail}</span>
                {item.action === null ? null : (
                  <RouteLink to={item.action.to} size="sm">{item.action.label}</RouteLink>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
