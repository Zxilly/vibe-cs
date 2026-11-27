/*
 * pages/home — the first-run start panel: what to do when there is nothing yet.
 *
 * 「引导建议改成首次使用时的三步提示条」 (「02 补齐 · 暗色与其余页面」).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  What counts as "first use", and why it is not a flag
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **An empty library.** Not a `localStorage` marker, not a
 * `has_seen_guide` field — the panel is shown while the library read has
 * *succeeded* with no rows, and it goes away the moment there is a Demo.
 * `useEmptyLibrary` is that one predicate; the workbench reads it too, to
 * decide the rest of the page around the panel (the toolbar's primary action,
 * whether 开始选材 has anything to list).
 *
 * While the read is in flight, nothing is shown: the panel appearing and then
 * vanishing moves everything below it twice. An error is not first use either
 * — telling a returning user they have nothing would be a guess.
 *
 * A stored flag would be wrong in both directions. It stays dismissed after
 * the user clears their data and genuinely is starting over; and it reappears
 * on a second machine for someone who has used the product for a year.
 *
 * ── One origin, done in place ────────────────────────────────────────────
 *
 * The panel used to be a link to `/library`, beside a 「打开 Demo 资料库」
 * link and a toolbar 「新建作品」 — three controls, two destinations, and the
 * only one styled as the main action created an empty 作品 with nothing to put
 * in it. Now the panel owns the view's single primary action and opens the
 * library's own import dialog right here: the same `useImportDemoPaths`
 * mutation, which refreshes every Demo list on success, so the workbench turns
 * into its populated layout without a page change. Steam download is the second
 * way in for someone with no `.dem` on disk, and it is honestly a link: it lives
 * on the library's Steam view. The three steps themselves stay on `/guide`;
 * the panel's one sentence says the order (import → analyse → 作品).
 */

import { Trans } from '@lingui/react/macro';
import { Download, FileUp } from 'lucide-react';
import { useId, useState } from 'react';

import { useDemoList, useImportDemoPaths } from '../../../data/demos';
import { dataErrorMessage } from '../../../data/errors';
import { Button } from '../../../design/primitives';
import { ImportDemoDialog } from '../library/ImportDemoDialog';
import { RouteLink } from '../navigation/RouteLink';

/** True only once the library read has succeeded with no rows. */
export function useEmptyLibrary(): boolean {
  /* One row is enough to answer "is there anything here". */
  const demos = useDemoList({ page: 1, page_size: 1 });
  return demos.isSuccess && demos.data.items.length === 0;
}

export function FirstRunStrip() {
  const headingId = useId();
  const empty = useEmptyLibrary();
  const [importOpen, setImportOpen] = useState(false);
  const importDemos = useImportDemoPaths();

  if (!empty) return null;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-lg border border-accent bg-accent-100 p-5"
      data-home-block="first-run"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={headingId} className="text-lg font-medium">
          <Trans>从导入 Demo 开始</Trans>
        </h2>
        <p className="text-base leading-relaxed text-accent-800">
          <Trans>资料库还是空的。导入本地的 .dem 文件，或从 Steam 下载最近的比赛；分析完成后就能挑选片段、新建作品。</Trans>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="primary" size="md" onClick={() => setImportOpen(true)}>
          <FileUp size={16} aria-hidden="true" />
          <Trans>导入 Demo 文件</Trans>
        </Button>
        <Button asChild variant="secondary" size="md">
          <RouteLink to="/library?view=steam" className="no-underline">
            <Download size={16} aria-hidden="true" />
            <Trans>从 Steam 下载</Trans>
          </RouteLink>
        </Button>
      </div>

      <ImportDemoDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={(paths) => importDemos.mutateAsync(paths)}
        importing={importDemos.isPending}
        error={dataErrorMessage(importDemos.error)}
      />
    </section>
  );
}
