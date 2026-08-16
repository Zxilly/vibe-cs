/*
 * pages/home — 首次使用的三步提示条.
 *
 * 「引导建议改成首次使用时的三步提示条」 (「02 补齐 · 暗色与其余页面」).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  What counts as "first use", and why it is not a flag
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **An empty library.** Not a `localStorage` marker, not a
 * `has_seen_guide` field — the strip is shown while there is nothing to work
 * on, and it goes away the moment there is.
 *
 * A stored flag would be wrong in both directions. It stays dismissed after
 * the user clears their data and genuinely is starting over; and it reappears
 * on a second machine for someone who has used the product for a year. The
 * library being empty is the actual condition the strip is about, and it needs
 * no storage, no migration and no way to get out of sync.
 *
 * It also means there is no 「不再显示」 button, which is the right trade: a
 * dismissable strip needs somewhere to remember the dismissal, and the thing
 * it would remember is already answerable from the data.
 *
 * ── While the read is in flight, nothing is shown ────────────────────────
 *
 * The strip appearing and then vanishing a moment later is worse than it never
 * appearing: it moves everything below it twice. `isPending` renders nothing,
 * and the first paint a returning user sees has no strip in it at all.
 */

import { Trans } from '@lingui/react/macro';

import { useDemoList } from '../../data/demos';
import { FIRST_RUN_STEPS } from './firstRunSteps';
import { RouteLink } from '../RouteLink';

export function FirstRunStrip() {
  /* One row is enough to answer "is there anything here" — the count is not
     needed and asking for fifty would be a page of data to decide one
     boolean. */
  const demos = useDemoList({ page: 1, page_size: 1 });

  /* An error is not first use. A library that would not load is a problem the
     workbench's own blocks report; adding a "welcome" strip on top of it would
     tell a returning user they have nothing, which is a guess. */
  if (demos.isPending || demos.error !== null) return null;
  if ((demos.data?.items.length ?? 0) > 0) return null;

  return (
    <section className="flex flex-col gap-3 border border-divider p-4" data-home-block="first-run">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">
          <Trans>三步做出第一条视频</Trans>
        </h2>
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>资料库里还没有东西，从第一步开始。这一条在导入之后会自动消失。</Trans>
        </p>
      </div>

      <ol className="flex flex-col gap-2 sm:flex-row sm:gap-4">
        {FIRST_RUN_STEPS.map((step, index) => (
          <li key={step.id} className="flex min-w-0 flex-1 items-start gap-2.5" data-first-run-step={step.id}>
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

      <RouteLink to="/guide">
        <Trans>完整的使用引导与环境自检</Trans>
      </RouteLink>
    </section>
  );
}
