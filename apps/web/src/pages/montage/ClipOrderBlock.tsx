/*
 * pages/montage — block A, 片段顺序.
 *
 * 「拖拽排序 · 双击裁切」 plus 「从录制结果添加」, over `domain/media`'s
 * `ClipStrip`. The strip already owns the 210px tile, the position badge, the
 * running time, the pointer drag and — the part that matters here —
 * **Ctrl/⌘ + ← → to move the focused tile**, so reordering is completable from
 * the keyboard without this page adding a control of its own.
 *
 * What this file adds is the *meaning*:
 *
 *   · a `MontageClipRecord` joined to its `RecordedClip`, because the project
 *     stores an id and a trim and the take stores the title, the player and the
 *     length (contract gap 4);
 *   · `reorderMontageClips`, which renumbers the wire's `order` field — the
 *     strip moves an array and knows nothing about the shape it is moving;
 *   · the trim entrance, twice: a double-click on a tile *and* a 「裁切」 button
 *     in the head. The button is the real one — a double-click cannot be
 *     discovered, cannot be reached by keyboard, and is an accelerator only.
 *
 * A take that is no longer in `useRecordedClips` renders as `status: 'missing'`
 * (the strip draws 「需要重新定位」) instead of vanishing: a clip the project
 * still holds and the page silently dropped would be a montage that exports
 * something the user cannot see on screen.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState, type MouseEvent } from 'react';

import { Dialog } from '../../design/feedback';
import { Button, cx } from '../../design/primitives';
import { useRecordedClips } from '../../data/outputs';
import { ClipStrip, type MediaClip } from '../../domain/media';
import type { MontageClipRecord, RecordedClip } from '../../shared/desktop/dto';
import { AddClipsDialog } from './AddClipsDialog';
import { ClipTrimDrawer } from './ClipTrimDrawer';
import {
  clipDurationSeconds,
  reorderMontageClips,
  type MontageBlockProps,
} from './montageContract';
import { editAppendClips, editRemoveClips, sharedTransition } from './montageSettings';

export function ClipOrderBlock({ project: desk, selection, service }: MontageBlockProps) {
  const takes = useRecordedClips();
  const [adding, setAdding] = useState(false);
  const [trimming, setTrimming] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const takeById = useMemo(() => {
    const map = new Map<string, RecordedClip>();
    for (const take of takes.data?.items ?? []) map.set(take.id, take);
    return map;
  }, [takes.data]);

  const project = desk.project;
  const ordered = useMemo<readonly MontageClipRecord[]>(
    () => (project === null ? [] : [...project.clips].sort((left, right) => left.order - right.order)),
    [project],
  );

  const tiles = useMemo<readonly MediaClip[]>(
    () =>
      ordered.map((clip) => {
        const take = takeById.get(clip.clip_id);
        const length = clipDurationSeconds(clip, desk.clipDurations);
        return {
          id: clip.clip_id,
          title: clip.title ?? take?.title ?? clip.clip_id,
          durationSeconds: length ?? 0,
          ...(take === undefined ? {} : { subtitle: `${take.player_name} · ${take.map_name}` }),
          ...(take === undefined ? { status: 'missing' as const } : {}),
        };
      }),
    [desk.clipDurations, ordered, takeById],
  );

  const selectedClip = ordered.find((clip) => clip.clip_id === selection.clipId) ?? null;
  const trimmingClip = ordered.find((clip) => clip.clip_id === trimming) ?? null;

  const writable = !service.blocked && project !== null && !desk.saving;
  /* One guard object, spread onto every write action: `disabled` is the whole
     condition and `disabledReason` is the service's sentence when that is what
     is blocking. Spreading `service.buttonProps` directly would let its
     `disabled: false` overwrite a local reason to stay disabled. */
  const guard = {
    disabled: !writable,
    ...(service.buttonProps.disabledReason === undefined
      ? {}
      : { disabledReason: service.buttonProps.disabledReason }),
  };
  const transition = project === null ? 'cut' : (sharedTransition(project) ?? 'cut');

  /*
   * The double-click accelerator. Bound to the wrapper rather than to a tile,
   * because `ClipStrip` renders the tiles and exposes them through the
   * `data-clip` attribute it already sets for its own drag model — reaching for
   * a per-tile `onDoubleClick` prop would mean widening a `domain/` component's
   * API for one page's accelerator.
   */
  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const tile = (event.target as HTMLElement).closest('[data-clip]');
    const clipId = tile?.getAttribute('data-clip');
    if (clipId === null || clipId === undefined) return;
    selection.select(clipId);
    setTrimming(clipId);
  };

  return (
    <section data-montage-block="clips" className="flex min-w-0 flex-col border border-divider">
      <header className="flex min-h-[var(--h-panel-head)] flex-none flex-wrap items-center gap-3 border-b border-divider px-3.5 py-1">
        <h3 className="min-w-0 truncate font-heading tracking-wide" style={{ fontSize: 'var(--text-base)' }}>
          <Trans>片段顺序</Trans>
        </h3>
        <p className="min-w-0 truncate text-xs text-neutral-600">
          <Trans>拖拽排序 · 双击裁切 · Ctrl 与左右方向键也可以移动</Trans>
        </p>
        <span className="flex-1" />
        <span className="flex flex-none items-center gap-2">
          <Button
            size="sm"
            data-montage-action="trim"
            disabled={selectedClip === null}
            {...(selectedClip === null ? { disabledReason: t`先选中一段再裁切` } : {})}
            onClick={() => setTrimming(selection.clipId)}
          >
            <Trans>裁切</Trans>
          </Button>
          <Button
            size="sm"
            data-montage-action="clear-clips"
            {...guard}
            disabled={!writable || ordered.length === 0}
            {...(ordered.length === 0 ? { disabledReason: t`这份合辑还没有片段` } : {})}
            onClick={() => setClearing(true)}
          >
            <Trans>清空片段</Trans>
          </Button>
          <Button
            size="sm"
            data-montage-action="add-clips"
            {...guard}
            onClick={() => setAdding(true)}
          >
            <Trans>从录制结果添加</Trans>
            {service.suffix}
          </Button>
        </span>
      </header>

      <div
        className={cx('p-3.5', desk.saving && 'opacity-60')}
        onDoubleClick={handleDoubleClick}
        data-montage-strip=""
      >
        <ClipStrip
          clips={tiles}
          selectedId={selection.clipId}
          loading={desk.loading || takes.isPending}
          onSelect={selection.select}
          {...(writable ? { onAdd: () => setAdding(true) } : {})}
          onReorder={(_next, move) => desk.save(reorderMontageClips(move.from, move.to))}
          emptyAction={
            <Button
              variant="primary"
              size="md"
              data-montage-action="add-clips-empty"
              {...guard}
              onClick={() => setAdding(true)}
            >
              <Trans>从录制结果添加</Trans>
              {service.suffix}
            </Button>
          }
        />
      </div>

      <AddClipsDialog
        open={adding}
        onClose={() => setAdding(false)}
        held={new Set(ordered.map((clip) => clip.clip_id))}
        {...guard}
        /* New clips inherit whatever transition the project already uses, so
           adding to a cross-faded montage does not drop a hard cut into it. */
        onAdd={(clipIds) => desk.save(editAppendClips(clipIds, transition))}
      />

      <ClipTrimDrawer
        open={trimmingClip !== null}
        onClose={() => setTrimming(null)}
        clip={trimmingClip}
        take={trimmingClip === null ? null : takeById.get(trimmingClip.clip_id) ?? null}
        saving={desk.saving}
        onSave={desk.save}
        onRemove={() => {
          if (trimmingClip === null) return;
          desk.save(editRemoveClips([trimmingClip.clip_id]));
          setTrimming(null);
        }}
      />

      <Dialog
        open={clearing}
        tone="destructive"
        title={<Trans>清空这份合辑的片段？</Trans>}
        confirmLabel={<Trans>清空</Trans>}
        confirmDisabled={!writable}
        onConfirm={() => {
          desk.save(editRemoveClips(ordered.map((clip) => clip.clip_id)));
          setClearing(false);
        }}
        onClose={() => setClearing(false)}
      >
        <p className="leading-normal">
          <Trans>
            这份合辑里的 {ordered.length} 段都会被移出，包装与导出设置保持不变。录制结果本身留在输出里。
          </Trans>
        </p>
      </Dialog>
    </section>
  );
}
