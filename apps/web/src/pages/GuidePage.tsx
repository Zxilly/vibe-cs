/*
 * pages/ — 使用引导 (§7 `/guide`, phase 3g).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Why this page exists at all, given the board wanted it gone
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 「02 补齐 · 暗色与其余页面」 lists GuidePage among the pages to retire, with
 * the note 「工作台首页已接管入口，引导建议改成首次使用时的三步提示条」. §10
 * kept it anyway, and both halves of that decision are built:
 *
 *   · the **three-step strip** is on the workbench, shown only while the
 *     library is empty (`home/FirstRunStrip`);
 *   · this page keeps the one thing the strip cannot carry — the **environment
 *     self-check**, item by item, with a way to re-run it.
 *
 * The old `features/guide/GuidePage.tsx` was 198 lines of exactly that: a
 * `quickCheck` readout plus a row of entry cards. Retiring the page would have
 * retired the readout with it, and 「为什么录制起不来」 is the question a new
 * user has on day one.
 *
 * ── It is not 设置 · 高级与诊断 ───────────────────────────────────────────
 *
 * That section lists every check with its raw state, for someone diagnosing a
 * problem they already have. This page answers 「我现在能做什么」: the same
 * checks, grouped by what they enable, and each one saying what still works
 * without it. A missing HLAE stops recording and stops nothing else, and a
 * first-time user needs to know they can still import and analyse today.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { Skeleton } from '../design/data';
import { Notice, StatusDot, type StatusDotStatus } from '../design/feedback';
import { Page, Toolbar } from '../design/layout';
import { Button } from '../design/primitives';
import { useQuickCheck } from '../data/config';
import { dataErrorMessage } from '../data/errors';
import { useServiceAction } from '../data/serviceAction';
import type { DependencyCheck } from '../shared/desktop/dto';
import { FIRST_RUN_STEPS } from './home/firstRunSteps';
import { RouteLink } from './RouteLink';

export function GuidePage() {
  const checks = useQuickCheck();
  const service = useServiceAction();
  const error = dataErrorMessage(checks.error);

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>使用引导</Trans>}
          meta={<Trans>三步做出第一条视频，以及这台机器现在能做什么</Trans>}
        />
      }
    >
      <div className="flex flex-col gap-6 p-5">
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-medium">
            <Trans>三步</Trans>
          </h2>
          <ol className="flex flex-col gap-2.5">
            {FIRST_RUN_STEPS.map((step, index) => (
              <li key={step.id} className="flex items-start gap-3 border border-divider p-3">
                <span className="flex-none font-mono text-sm text-neutral-600">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <RouteLink to={step.to}>{step.title()}</RouteLink>
                  <p className="text-xs leading-normal text-neutral-600">{step.description()}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-medium">
              <Trans>这台机器现在能做什么</Trans>
            </h2>
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

          {error !== null ? (
            <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void checks.refetch() }}>
              <Trans>读不到环境自检：{error}</Trans>
            </Notice>
          ) : checks.isPending ? (
            <div className="flex flex-col gap-2.5">
              <Skeleton />
              <Skeleton width="82%" />
            </div>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {(checks.data?.checks ?? []).map((check) => (
                <li key={`${check.kind}:${check.label}`} className="flex flex-col gap-1" data-guide-check={check.kind}>
                  <div className="flex items-center gap-2.5 text-sm">
                    <StatusDot status={dotStatus(check.state)} />
                    <span>{check.label}</span>
                  </div>
                  <p className="ms-5 text-xs leading-normal text-neutral-600">
                    {/* What it enables, and — when it is broken — what still
                        works without it. A first-time user with no HLAE needs
                        to know they can still import and analyse today. */}
                    {enablesSentence(check)}
                  </p>
                  {check.detail === '' ? null : (
                    <p className="ms-5 break-all text-2xs leading-normal text-neutral-600">{check.detail}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs leading-normal text-neutral-600">
            <Trans>
              逐项的原始状态与路径校验在
              <RouteLink to="/settings?section=advanced">设置 · 高级与诊断</RouteLink>。
            </Trans>
          </p>
        </section>
      </div>
    </Page>
  );
}

/** Same reading of the open `state` string as the settings sections use. */
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

/**
 * One sentence per dependency: what it is for, and what is unaffected when it
 * is missing.
 *
 * Written per kind rather than derived from `detail`, and through the macro at
 * call time rather than from a module-scope table — the same reason
 * `home/EnvironmentNotice` does it that way.
 */
function enablesSentence(check: DependencyCheck): string {
  const broken = check.state === 'missing' || check.state === 'blocked' || check.state === 'error';
  switch (check.kind) {
    case 'cs2':
      return broken
        ? t`回放与录制都需要它。导入和分析不受影响，可以先做那两步。`
        : t`回放与录制都用它。`;
    case 'hlae':
      return broken
        ? t`录制需要它。导入、分析和剪辑都不受影响。`
        : t`录制用它接管画面。`;
    case 'encoder':
    case 'ffmpeg':
      return broken
        ? t`导出成片需要它。录制与分析不受影响，但导不出文件。`
        : t`导出成片与波形分析用它。`;
    default:
      return broken ? t`这一项现在不可用。` : t`这一项就绪。`;
  }
}
