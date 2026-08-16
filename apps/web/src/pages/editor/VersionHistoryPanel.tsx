/*
 * pages/editor — 版本历史, the foot of the artboard's right column.
 *
 * `EditorProjectSnapshot` is metadata only — id, revision, name, timestamp —
 * and the document itself stays on the service until a restore asks for it.
 * That is why this panel can list fifty versions without fetching fifty
 * projects, and why 「恢复」 is a round trip rather than a local swap.
 *
 * ── restoring is destructive to unsaved work, and says so ─────────────────
 *
 * `restoreEditorSnapshot` answers the restored project and bumps the revision.
 * Anything the user has edited but not saved is not in that document and is
 * gone. So the button is disabled while there are unsaved changes, with that
 * as its reason — rather than restoring and letting the loss be discovered
 * later, and rather than a confirm dialog, which is a worse version of the
 * same conversation: the user can save first, which loses nothing.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { Skeleton } from '../../design/data';
import { Button } from '../../design/primitives';
import { useLingui } from '@lingui/react';
import type { EditorSnapshotRow } from '../../data/editor';

export interface VersionHistoryPanelProps {
  readonly snapshots: readonly EditorSnapshotRow[];
  readonly loading: boolean;
  /** The revision the editor is currently showing. */
  readonly currentRevision: number | null;
  /** Blocked while there are unsaved edits — see the module comment. */
  readonly restoreBlockedReason?: string | undefined;
  readonly onRestore: (snapshotId: string) => void;
}

export function VersionHistoryPanel({
  snapshots,
  loading,
  currentRevision,
  restoreBlockedReason,
  onRestore,
}: VersionHistoryPanelProps) {
  const { i18n } = useLingui();

  return (
    <section className="flex flex-col gap-2 border-t border-divider p-3" aria-label={t`版本历史`}>
      <h2 className="text-sm font-medium">
        <Trans>版本历史</Trans>
      </h2>

      {loading ? (
        <Skeleton className="h-16" />
      ) : snapshots.length === 0 ? (
        <p className="text-2xs text-neutral-700">
          {/* Not an error: a project saved once has one revision and no history
              behind it. */}
          <Trans>还没有更早的版本</Trans>
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {snapshots.map((snapshot) => {
            const current = snapshot.revision === currentRevision;
            return (
              <li
                key={snapshot.id}
                className="flex items-center justify-between gap-2 text-xs"
                data-snapshot={snapshot.id}
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono">
                    <Trans>版本 {snapshot.revision}</Trans>
                  </span>
                  <span className="ms-2 text-neutral-700">
                    {i18n.date(new Date(snapshot.created_at), { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                </span>
                {current ? (
                  <span className="flex-none text-2xs text-neutral-700">
                    <Trans>当前</Trans>
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={restoreBlockedReason !== undefined}
                    disabledReason={restoreBlockedReason ?? ''}
                    onClick={() => onRestore(snapshot.id)}
                  >
                    <Trans>恢复</Trans>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
