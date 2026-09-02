/*
 * pages/home — 环境提示.
 *
 * The board's whole instruction for this block is one sentence:
 *
 *   「CS2 与受管录制环境已就绪。环境问题只在阻塞相应任务时出现在这里。」
 *
 * So the rule is not "show the dependency checks on the workbench" — the full
 * list is 设置 · 高级与诊断's job. It is: **say nothing while nothing is
 * blocked**, and when something is, say what it blocks.
 *
 * ── Which checks block, and which are only worth knowing ─────────────────
 *
 * `DependencyCheck.state` is `ready` or `missing` — the route answers with an
 * enum, so "which values block" is no longer a judgement call: `missing` does.
 *
 * This paragraph used to weigh a `warning` state against a `blocked` one and
 * settle on treating anything unrecognised as non-blocking, since the wire type
 * was an open string and no one could enumerate it. Neither value was ever
 * sent. The reasoning still holds if a third state is ever added — a banner
 * that interrupts on states nobody has defined is one people learn to ignore —
 * but it is now a decision to make then, not a defence to carry.
 *
 * This block is about the environment required for work — CS2's location and
 * the capture implementation — and reports only actionable failures.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useNavigate } from 'react-router-dom';

import { Alert } from '../../design/feedback';
import { useQuickCheck } from '../../data/config';
import type {
  DependencyCheck,
  DependencyKind,
  DependencyState,
} from '../../shared/desktop/dto';
import { settingsPath } from '../settings/settingsRoutes';

/** The state that stops work. See the module comment. */
const BLOCKING_STATE: DependencyState = 'missing';

export function EnvironmentNotice() {
  const checks = useQuickCheck();
  const navigate = useNavigate();
  const blocking = (checks.data?.checks ?? []).filter(
    (check) => check.state === BLOCKING_STATE,
  );

  /* Silence is the normal state — including while the check is still in
     flight. A skeleton here would put a placeholder banner on a workbench that
     is probably fine, which is the thing the board's sentence rules out. */
  if (blocking.length === 0) return null;

  return (
    /* The marker lives on a wrapper: `Notice`'s props are a closed set and it
       does not spread the rest, so a `data-` attribute on it is dropped. */
    <div data-home-block="environment">
      <Alert
        variant="warning"
        action={{
          label: <Trans>去设置</Trans>,
          /* Through the router, not `location.hash`: the app is in hash mode and
             writing the hash directly skips every guard the router runs. */
          onAction: () => void navigate(settingsPath('game')),
        }}
        detail={
          <ul className="flex flex-col gap-1">
            {blocking.map((check) => (
              <li key={`${check.kind}:${check.label}`} data-blocking-check={check.kind}>
                {blockingSentence(check)}
              </li>
            ))}
          </ul>
        }
      >
        <Trans>录制环境还没准备好，需要它的任务现在起不来。</Trans>
      </Alert>
    </div>
  );
}

/**
 * One line per blocked dependency: what is wrong, and what it stops.
 *
 * The consequence is written per *kind* rather than taken from `detail`,
 * because `detail` says what the service found (「未探测到 HLAE」) and the user
 * needs what it costs them (「录制起不来」). Both are shown — the service's own
 * words are more precise, and the consequence is what makes them actionable.
 */
function blockingSentence(check: DependencyCheck): string {
  const consequence = consequenceOf(check.kind);
  return check.detail === ''
    ? `${check.label} — ${consequence}`
    : `${check.label} — ${consequence}（${check.detail}）`;
}

/**
 * Kind → what stops working.
 *
 * A function rather than a lookup table, because these are UI copy and have to
 * go through the macro at call time — a module-scope object would freeze the
 * strings at import in whichever locale happened to be active.
 *
 * Exhaustive over the enum, so a new kind is a compile error here rather than a
 * banner that says 「相关功能不可用」 about something this page could have named.
 */
function consequenceOf(kind: DependencyKind): string {
  switch (kind) {
    case 'game':
      return t`回放与录制都起不来`;
    case 'hlae':
      return t`录制起不来，分析与编辑不受影响`;
    case 'encoder':
      return t`导出成片会失败`;
  }
}
