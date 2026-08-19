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
    <div className="flex flex-col gap-3 border border-divider p-4" data-home-block="first-run">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">
          <Trans>从导入 Demo 开始</Trans>
        </h2>
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>素材为空。导入一场 Demo 后，就可以用它新建第一份作品。</Trans>
        </p>
      </div>

      <RouteLink to="/library"><Trans>导入 Demo</Trans></RouteLink>
    </div>
  );
}
