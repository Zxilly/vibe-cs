/*
 * pages/recording — block C, 录制前校验, and the one 开始录制.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  The whole contract, in one sentence each
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **`blocking > 0` disables 开始录制. Nothing else the check list says does.**
 * `RecordingPreflight.blocking` is the server's own count of `blocked` rows; a
 * `warning` row is information and never a gate, and this block adds no
 * condition of its own on top of one. When it *is* blocking, the reason names
 * the rows — 「录制前校验有阻塞项」 with nothing after it would send the reader
 * back to count them.
 *
 * **`detail` is English fact and is printed, not translated.** The eight codes
 * are a closed set with a Chinese label table (`PREFLIGHT_CHECK`); `detail`
 * carries the parts a code cannot — a free-byte count, an HLAE version, a file
 * name — and it arrives from the service in English. Translating it would mean
 * parsing it, and a page that parsed 「218 GB free」 to re-render it would be
 * inventing a number. So it is printed verbatim in a monospace run with a
 * Chinese label beside it saying what it is: 「服务返回」.
 *
 * **`camera_collision_unverified` reports an unknown, not a collision.** It says
 * these shots' coordinates cannot be checked against map geometry until they
 * have been previewed in game. It is a `warning` when the plan has an observer
 * shot, `ok` when every shot is POV, and **never** `blocked`. 「碰撞几何未知」 is
 * the right wording; 「检测到碰撞」 is not, and the recovery it offers is block
 * D's 「在游戏里预览」, which is the thing that would actually answer the
 * question.
 *
 * **`affected_item_ids` is a way back to the shots.** A row that speaks about
 * some of the plan selects the first one it names, so 「影响 1 个镜头」 is
 * followable rather than a riddle.
 *
 * ── 开始录制 lives here, and only here ────────────────────────────────────
 *
 * §4.5.3 rule ①: recording starts from exactly one explicit confirmation. This
 * is the only button on the page that can reach `executeRecordingPlan`, and it
 * is here rather than in the toolbar because this is the only place `blocking`
 * is known — a second copy in the top bar would have to be told the answer, and
 * 3e's lesson is that the copy which is told the answer is the copy that goes
 * stale and colours itself for a click that does nothing.
 *
 * §8 is still satisfied: this strip is `flex-none` at the foot of a `min-h-0`
 * column, so the action is on screen at every width and never folds into an
 * overflow menu.
 *
 * The dialog is not decoration either. `executeRecordingPlan` launches CS2,
 * writes to disk and cannot be undone, and its second argument is the user's
 * acknowledgement that the game starts in offline `-insecure` mode — which is a
 * fact about their machine, so it is a checkbox they tick rather than a constant
 * this file sends.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { Dialog, Alert, StatusDot, type StatusDotStatus } from '../../design/feedback';
import { Button, Checkbox, cn } from '../../design/primitives';
import type { RecordingPreflightCheck, RecordingPreflightState } from '../../shared/desktop/dto';
import { PREFLIGHT_CHECK, type RecordingBlockProps } from './recordingContract';

/** 三档视觉, from `design/feedback/StatusDot` rather than three new squares. */
const STATE_DOT: Readonly<Record<RecordingPreflightState, StatusDotStatus>> = {
  ok: 'ok',
  warning: 'warn',
  blocked: 'fail',
};

export function PreflightBlock({ plan, preflight, selection, start, service }: RecordingBlockProps) {
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const result = preflight.result;
  const warnings = plan.plan?.warnings ?? [];
  const failure = dataErrorMessage(preflight.error);
  const startFailure = dataErrorMessage(start.error);

  return (
    <section
      data-recording-block="preflight"
      data-preflight-status={preflight.status}
      aria-label={t`录制前校验`}
      className="flex flex-none flex-col gap-3 border-t border-divider px-5 py-3.5"
    >
      <div className="flex min-w-0 items-start gap-6">
        <h2 className="flex-none whitespace-nowrap font-heading text-sm tracking-caps">
          <Trans>录制前校验</Trans>
        </h2>

        <div className="min-w-0 flex-1">
          {failure !== null ? (
            <Alert
              variant="danger"
              action={{ label: <Trans>重试</Trans>, onAction: preflight.run }}
              detail={<Trans>校验只做检查，没有任何数据被改动，重试是安全的。</Trans>}
            >
              <Trans>录制前校验没能完成：{failure}</Trans>
            </Alert>
          ) : preflight.status === 'running' ? (
            <p role="status" aria-busy="true" className="text-sm text-neutral-700">
              <Trans>正在检查 CS2、采集组件、Demo 内容、编码器与输出目录…</Trans>
            </p>
          ) : result === null ? (
            <p className="text-sm text-neutral-700">
              {plan.dirty ? (
                <Trans>片段改过之后需要重新生成预览计划，再运行一次校验。</Trans>
              ) : (
                <Trans>还没有对这份片段列表跑过校验。</Trans>
              )}
            </p>
          ) : (
            <CheckGrid checks={result.checks} onSelectShot={selection.select} />
          )}

          {warnings.length === 0 ? null : (
            <div className="mt-3" data-plan-warnings={warnings.length}>
              <h3 className="font-heading text-2xs tracking-caps text-neutral-600">
                <Trans>计划提示（服务返回）</Trans>
              </h3>
              <ul className="mt-1 flex list-none flex-col gap-1 text-xs text-neutral-700">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex flex-none flex-col items-end gap-2">
          <Button
            variant="secondary"
            disabled={service.blocked || plan.plan === null || preflight.status === 'running'}
            {...preflightRunReason({ service, hasPlan: plan.plan !== null, preflight })}
            onClick={preflight.run}
          >
            {result === null ? <Trans>运行录制前校验</Trans> : <Trans>重新校验</Trans>}
            {service.suffix}
          </Button>
          {/* The artboard's 42px button — `hero` in §3.3's control scale. */}
          <Button
            variant="primary"
            size="hero"
            data-recording-start="true"
            disabled={start.action.disabled}
            {...(start.action.disabledReason === undefined
              ? {}
              : { disabledReason: start.action.disabledReason })}
            onClick={() => {
              setAcknowledged(false);
              setConfirming(true);
            }}
          >
            {start.shotCount === null ? (
              <Trans>开始录制</Trans>
            ) : (
              <Trans>开始录制 {start.shotCount} 个片段</Trans>
            )}
          </Button>
          {start.action.disabled && start.action.disabledReason !== undefined ? (
            <p className="max-w-[var(--w-panel)] text-right text-2xs text-neutral-600">
              {start.action.disabledReason}
            </p>
          ) : null}
        </div>
      </div>

      {startFailure === null ? null : (
        <Alert
          variant="danger"
          action={{ label: <Trans>重新生成预览计划</Trans>, onAction: plan.replan }}
          detail={<Trans>没有开始录制，游戏也没有被启动。</Trans>}
        >
          <Trans>没能开始录制：{startFailure}</Trans>
        </Alert>
      )}

      {/*
        The one confirmation. §4.5.3 rule ①: nothing else on this page reaches
        `executeRecordingPlan`, and `start.start` is the shell's single caller
        of the branded `confirmRecordingStart`.
      */}
      <Dialog
        open={confirming}
        title={<Trans>开始录制这份计划？</Trans>}
        confirmLabel={<Trans>开始录制</Trans>}
        confirmDisabled={!acknowledged}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          start.start(acknowledged);
        }}
      >
        <p>
          {start.shotCount === null ? (
            <Trans>录制会启动 CS2，逐个采集片段，完成后把成片发布到输出里。</Trans>
          ) : (
            <Trans>
              录制会启动 CS2，逐个采集 {start.shotCount} 个片段，完成后把成片发布到输出里。
            </Trans>
          )}
        </p>
        <p className="mt-2">
          <Trans>录制期间这台机器会被游戏占用，中途停止会保留已完成的片段。</Trans>
        </p>
        <Checkbox
          className="mt-3"
          checked={acknowledged}
          onChange={setAcknowledged}
        >
          <Trans>我知道 CS2 会以离线（-insecure）模式启动</Trans>
        </Checkbox>
      </Dialog>
    </section>
  );
}

/* ── the rows ────────────────────────────────────────────────────────────── */

function CheckGrid({
  checks,
  onSelectShot,
}: {
  readonly checks: readonly RecordingPreflightCheck[];
  readonly onSelectShot: (shotId: string | null) => void;
}) {
  const { i18n } = useLingui();

  return (
    <ul
      className="grid list-none grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4"
      data-preflight-checks={checks.length}
    >
      {checks.map((check) => {
        const meta = PREFLIGHT_CHECK[check.code];
        const first = check.affected_item_ids[0] ?? null;

        return (
          <li
            key={check.code}
            data-check={check.code}
            data-check-state={check.state}
            className="flex min-w-0 items-start gap-2"
          >
            <span className="mt-1.5 flex-none">
              <StatusDot status={STATE_DOT[check.state]} />
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  'truncate',
                  check.state === 'blocked'
                    ? 'text-fail-text'
                    : check.state === 'warning'
                      ? 'text-warn-text'
                      : null,
                )}
                title={i18n._(meta.hint)}
              >
                {i18n._(meta.label)}
              </p>
              {check.detail === '' ? null : (
                <p className="mt-0.5 min-w-0 text-2xs text-neutral-600">
                  {/*
                    The label is Chinese, the fact is not. `detail` is the
                    service's own English string — a byte count, a version, a
                    path — and it is printed as it came so a bug report and the
                    screen say the same thing.
                  */}
                  <Trans>服务返回</Trans>{' '}
                  <span className="break-all font-mono">{check.detail}</span>
                </p>
              )}
              {first === null ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-0.5 px-0"
                  onClick={() => onSelectShot(first)}
                >
                  <Trans>影响 {check.affected_item_ids.length} 个片段，定位第一个</Trans>
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ── the run button's reason ─────────────────────────────────────────────── */

function preflightRunReason(input: {
  readonly service: RecordingBlockProps['service'];
  readonly hasPlan: boolean;
  readonly preflight: RecordingBlockProps['preflight'];
}): { disabledReason?: string } {
  if (input.service.blocked) {
    return input.service.buttonProps.disabledReason === undefined
      ? {}
      : { disabledReason: input.service.buttonProps.disabledReason };
  }
  if (!input.hasPlan) return { disabledReason: t`还没有预览计划，先生成一份` };
  if (input.preflight.status === 'running') return { disabledReason: t`正在校验` };
  return {};
}
