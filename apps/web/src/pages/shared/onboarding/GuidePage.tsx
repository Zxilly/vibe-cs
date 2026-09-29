import { dependencyLabel } from '../../../domain/environment/dependencyLabel';
/*
 * pages/onboarding — 使用引导: the three steps beside what this machine can do.
 *
 * The step cards mark progress from the data (`useFirstRunProgress`) rather
 * than always pointing at step one: the accent face and left rule are the
 * shell's 「you are here」 vocabulary, and on a machine with a library full of
 * analysed matches that vocabulary on 「导入 Demo」 is a wrong answer. A taken
 * step is labelled done; the first step not taken is the current one.
 *
 * Each card is one target. The title is the anchor — the accessible name stays
 * the step's name — and it is stretched over the card, so the number and the
 * sentence beside it are not a dead zone inside something drawn as a button.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { Skeleton } from '../../../design/data';
import { Alert, StatusDot, type StatusDotStatus } from '../../../design/feedback';
import { Page, Toolbar } from '../../../design/layout';
import { Badge, Button } from '../../../design/primitives';
import { cn } from '../../../design/cn';
import { useQuickCheck } from '../../../data/config';
import { dataErrorMessage } from '../../../data/errors';
import type { DependencyCheck, DependencyState } from '../../../shared/desktop/dto';
import { useFirstRunProgress } from './firstRunProgress';
import { FIRST_RUN_STEPS } from './firstRunSteps';
import { RouteLink } from '../navigation/RouteLink';
import { settingsPath } from '../settings/settingsRoutes';

export function GuidePage() {
  const checks = useQuickCheck();
  const progress = useFirstRunProgress();
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
      {/* `items-start`: the two columns are unrelated readouts, and the left
          one is three fixed cards. Stretching it to the taller column left a
          panel with a page of empty border under its last card. */}
      <div className="grid min-h-0 grid-cols-1 items-start gap-4 p-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(24rem,1fr)]">
        <section className="flex min-w-0 flex-col gap-4">
          <h2 className="text-base font-medium">
            <Trans>从 Demo 到第一条视频</Trans>
          </h2>
          <ol className="flex flex-col border border-divider bg-bg">
            {FIRST_RUN_STEPS.map((step, index) => {
              const current = progress?.current === step.id;
              const done = progress?.done.has(step.id) ?? false;
              return (
                <li
                  key={step.id}
                  data-guide-step={step.id}
                  data-guide-current={current ? 'true' : undefined}
                  data-guide-done={done ? 'true' : undefined}
                  className={cn(
                    'relative flex min-h-28 items-center gap-4 border-b border-divider p-5 last:border-b-0 focus-within:outline-2 focus-within:outline-accent focus-within:-outline-offset-2',
                    current
                      ? 'bg-accent-100'
                      : 'hover:bg-action-hover',
                  )}
                >
                  <span
                    className={cn(
                      'w-10 flex-none font-heading text-2xl tabular-nums',
                      current ? 'text-accent-800' : 'text-neutral-500',
                    )}
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <RouteLink to={step.to} aria-current={current ? 'step' : undefined}
                        className="text-base font-medium after:absolute after:inset-0">
                        {step.title()}
                      </RouteLink>
                      {done ? (
                        <Badge variant="neutral" size="sm">
                          <Trans>已完成</Trans>
                        </Badge>
                      ) : null}
                      {current ? <Badge variant="accent" size="sm"><Trans>下一步</Trans></Badge> : null}
                    </div>
                    <p className={cn('max-w-prose text-sm leading-relaxed', current ? 'text-accent-800' : 'text-neutral-600')}>{step.description()}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="flex min-w-0 flex-col gap-4 border border-divider p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-medium">
              <Trans>这台机器现在能做什么</Trans>
            </h2>
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

          {error !== null ? (
            <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void checks.refetch() }}>
              <Trans>读不到环境自检：{error}</Trans>
            </Alert>
          ) : checks.isPending ? (
            <div className="flex flex-col gap-2.5">
              <Skeleton />
              <Skeleton width="82%" />
            </div>
          ) : (
            <ul className="flex flex-col">
              {(checks.data?.checks ?? []).map((check) => (
                <li
                  key={`${check.kind}:${dependencyLabel(check.kind)}`}
                  className="flex flex-col gap-1 border-b border-divider py-4 first:pt-2 last:border-b-0"
                  data-guide-check={check.kind}
                >
                  <div className="flex items-center gap-2.5 text-sm">
                    <StatusDot status={dotStatus(check.state)} />
                    <span>{dependencyLabel(check.kind)}</span>
                    <span className={cn('ml-auto flex-none text-sm', check.state === 'ready' ? 'text-ok-text' : 'text-fail-text')}>
                      {check.state === 'ready' ? <Trans>就绪</Trans> : <Trans>需要配置</Trans>}
                    </span>
                  </div>
                  <p className="ms-5 text-sm leading-relaxed text-neutral-600">
                    {/* What it enables, and — when it is broken — what still
                        works without it. A first-time user with no HLAE needs
                        to know they can still import and analyse today. */}
                    {enablesSentence(check)}
                  </p>
                </li>
              ))}
              {(checks.data?.checks ?? []).length === 0 ? (
                <li className="py-3 text-sm leading-relaxed text-neutral-600">
                  <Trans>没有收到环境检查结果。请重新检查后确认回放、录制和导出是否可用。</Trans>
                </li>
              ) : null}
            </ul>
          )}

          <p className="text-xs leading-normal text-neutral-600">
            <Trans>
              更多检查结果见
              <RouteLink to={settingsPath('dependencies')}>设置 · 高级与诊断</RouteLink>。
            </Trans>
          </p>
        </section>
      </div>
    </Page>
  );
}

/**
 * Two states, so two dots.
 *
 * This used to take a `string` and answer for seven values — `ok`, `warning`,
 * `degraded`, `error`, `blocked` and a neutral fallback — because the wire type
 * was an open string and nobody could say which ones arrived. The route answers
 * with an enum now: the probe either found the dependency or it did not, and
 * there is no third answer to paint.
 */
function dotStatus(state: DependencyState): StatusDotStatus {
  return state === 'ready' ? 'ok' : 'fail';
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
  const broken = check.state === 'missing';
  switch (check.kind) {
    case 'game':
      return broken
        ? t`回放与录制都需要它。导入和分析不受影响，可以先做那两步。`
        : t`回放与录制都用它。`;
    case 'hlae':
      return broken
        ? t`录制需要它。导入、分析和剪辑都不受影响。`
        : t`录制用它接管画面。`;
    case 'encoder':
      return broken
        ? t`导出成片需要它。录制与分析不受影响，但导不出文件。`
        : t`导出成片与波形分析用它。`;
  }
}
