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
 * `DependencyCheck.state` is an open string on the wire (§10.9 group 3), and
 * only two of its values mean "this stops work": `missing` and `blocked`. A
 * `warning` is a thing worth reading in the diagnostics section and is not a
 * reason to put a banner on the workbench — that is the difference between a
 * page that is informative and a page that is nagging.
 *
 * An unrecognised state is treated as **not blocking**. That is the cautious
 * direction here, and it is the opposite of what `GameSection`'s dot does: a
 * dot that cannot classify a state paints neutral rather than green because it
 * is *describing* the dependency, while this block is *interrupting the user*,
 * and interrupting on a state nobody has defined yet is how a banner becomes
 * something people learn to ignore.
 *
 * ── It is not the service gate ───────────────────────────────────────────
 *
 * `app/boundary/ServiceGate` already owns "the local service is down", and it
 * covers the whole shell. This block is about the *environment the service
 * needs to do work* — CS2's location, the capture component — which is a
 * different failure with a different fix, and it is only reachable when the
 * service is up to report it.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useNavigate } from 'react-router-dom';

import { Notice } from '../../design/feedback';
import { useQuickCheck } from '../../data/config';
import type { DependencyCheck } from '../../shared/desktop/dto';

/** The two states that stop work. See the module comment. */
const BLOCKING_STATES = ['missing', 'blocked'];

export function EnvironmentNotice() {
  const checks = useQuickCheck();
  const navigate = useNavigate();
  const blocking = (checks.data?.checks ?? []).filter((check) =>
    BLOCKING_STATES.includes(check.state),
  );

  /* Silence is the normal state — including while the check is still in
     flight. A skeleton here would put a placeholder banner on a workbench that
     is probably fine, which is the thing the board's sentence rules out. */
  if (blocking.length === 0) return null;

  return (
    /* The marker lives on a wrapper: `Notice`'s props are a closed set and it
       does not spread the rest, so a `data-` attribute on it is dropped. */
    <div data-home-block="environment">
      <Notice
        tone="warning"
        action={{
          label: <Trans>去设置</Trans>,
          /* Through the router, not `location.hash`: the app is in hash mode and
             writing the hash directly skips every guard the router runs. */
          onAction: () => void navigate('/settings?section=game'),
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
      </Notice>
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
 * An unknown kind falls back to a generic sentence rather than being dropped:
 * a blocked dependency this page cannot name is still a blocked dependency,
 * and hiding it would be the one outcome worse than a vague banner.
 */
function consequenceOf(kind: string): string {
  switch (kind) {
    case 'cs2':
      return t`回放与录制都起不来`;
    case 'hlae':
      return t`录制起不来，分析与编辑不受影响`;
    case 'encoder':
      return t`导出成片会失败`;
    case 'ffmpeg':
      return t`导出与波形都会失败`;
    default:
      return t`相关功能不可用`;
  }
}
