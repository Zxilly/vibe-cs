/*
 * pages/ — 11 输出与任务记录 (spec §7 `/delivery?view=outputs|tasks`, phase 3a).
 *
 * §7 merges the pre-redesign `/outputs` and `/activity` into one route with two
 * views, and Frame lists both as separate rail entries pointing at the same
 * path with different queries — which is why `shell/navigation.tsx` matches on
 * the query as well as the pathname. Both old addresses redirect here.
 *
 * ── Seg, not SubNav ───────────────────────────────────────────────────────
 *
 * The artboard settles it: the switch is drawn in the 56px topbar as
 * `<div class="seg" style="height:34px">` with two options, 输出 and 任务记录.
 * That is `design/primitives/Seg` at `--h-ctl-md`. `design/layout/SubNav` is
 * the *left rail* of the match workspace (190px, `--w-subnav`, nine views, and
 * a collapse rule of its own) — a different control for a different job, and
 * using it here would put a navigation column on a page whose two faces are one
 * radio group.
 *
 * It travels as a `Toolbar` action rather than as `children` so it sits on the
 * right of the bar where the artboard draws it, and `inlineActionsWhenCollapsed`
 * is 2 so neither it nor 清理无效记录 folds into 「更多」 at 1100px — §10.3 gap 2
 * asked short-titled pages (library, delivery) to pass exactly that. A view
 * switcher inside an overflow menu would hide the page's own structure.
 *
 * ── The two views are one page, not two routes ────────────────────────────
 *
 * 输出 keeps the 520px 任务记录 rail beside it (`--w-split`, the width §3.5
 * reserves for this one layout) — until the shell folds at 1100px, where the
 * artboard has no room for it and `SplitPane` would leave the card grid 476px.
 * Below the fold the rail is dropped and the Seg is the way to the records,
 * which is the same affordance the artboard uses at full width.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useSearchParams } from 'react-router-dom';

import { useCleanupMissingOutputs, useOutputList } from '../data/outputs';
import { useStorageStatus } from '../data/config';
import { Page, SplitPane, Toolbar, useShellCollapsed } from '../design/layout';
import { Button, Seg } from '../design/primitives';
import { OutputsView } from './delivery/OutputsView';
import { formatBytes } from './delivery/outputModel';
import { TaskRecordRail } from './delivery/TaskRecordRail';
import { TaskRecordView } from './delivery/TaskRecordView';
import { useServiceAction } from '../data/serviceAction';
import { pickQueryValue } from './routeQuery';

const DELIVERY_VIEWS = ['outputs', 'tasks'] as const;
type DeliveryView = (typeof DELIVERY_VIEWS)[number];

export function DeliveryPage() {
  const [params, setParams] = useSearchParams();
  const view = pickQueryValue(params.get('view'), DELIVERY_VIEWS, 'outputs');
  const collapsed = useShellCollapsed();
  const service = useServiceAction();

  /*
   * 「34 个输出 · 218 GB 可用」. Both halves are real reads: the count is the
   * output list's own `total` (a one-row page, so the count arrives without
   * fetching a page of cards this bar does not draw), and the free space is
   * `StorageStatus.filesystem_available_bytes`.
   */
  const outputCount = useOutputList({ page: 1, page_size: 1 });
  const storage = useStorageStatus();
  const cleanup = useCleanupMissingOutputs();

  const total = outputCount.data?.total;
  const available = formatBytes(storage.data?.filesystem_available_bytes ?? null);

  const setView = (next: DeliveryView): void => {
    // `replace` keeps the back button pointing at wherever the user came from
    // rather than at the other tab of the page they are still on.
    setParams(next === 'outputs' ? {} : { view: next }, { replace: true });
  };

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>交付</Trans>}
          meta={
            total === undefined ? undefined : available === null ? (
              <Trans>{total} 个输出</Trans>
            ) : (
              <Trans>{total} 个输出 · {available} 可用</Trans>
            )
          }
          inlineActionsWhenCollapsed={2}
          actions={[
            {
              id: 'view',
              label: view === 'tasks' ? <Trans>任务记录</Trans> : <Trans>输出</Trans>,
              control: (
                <Seg
                  name="delivery-view"
                  aria-label={t`交付视图`}
                  size="md"
                  value={view}
                  options={[
                    { value: 'outputs', label: t`输出` },
                    { value: 'tasks', label: t`任务记录` },
                  ]}
                  onChange={setView}
                />
              ),
            },
            {
              id: 'cleanup',
              label: <Trans>清理无效记录</Trans>,
              onSelect: () => cleanup.mutate(undefined),
              disabled: service.blocked || cleanup.isPending,
              control: (
                <Button
                  size="md"
                  onClick={() => cleanup.mutate(undefined)}
                  {...service.buttonProps}
                  {...(cleanup.isPending ? { disabled: true } : {})}
                >
                  <Trans>清理无效记录</Trans>
                  {service.suffix}
                </Button>
              ),
            },
          ]}
        />
      }
    >
      {view === 'tasks' ? (
        <TaskRecordView service={service} />
      ) : collapsed ? (
        <OutputsView service={service} />
      ) : (
        <SplitPane
          asideLabel={t`任务记录`}
          asideWidth="split"
          storageId="delivery-tasks"
          aside={<TaskRecordRail service={service} />}
        >
          <OutputsView service={service} />
        </SplitPane>
      )}
    </Page>
  );
}
