/** The confirmation before a recording takes over CS2: which clips, roughly how long, and what it occupies. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { CircleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Dialog } from '../../../design/feedback';
import { NativeSelect, Seg } from '../../../design/primitives';
import { ClipCameraInspection } from '../../../domain/editing/ClipCameraInspection';
import type { TimelineClip } from '../../../shared/desktop/dto';
import { recordingEstimate } from './recordingEstimate';

type RecordingScope = 'all' | 'selected';

export interface RecordingConfirmDialogProps {
  readonly open: boolean;
  readonly projectId: string;
  readonly revision: number;
  /** The unrecorded clips this request covers. */
  readonly clips: readonly TimelineClip[];
  /** The Timeline selection; a narrower scope is offered when it holds some, not all, of `clips`. */
  readonly selectedClipIds: readonly string[];
  readonly confirmDisabled: boolean;
  readonly onConfirm: (clipIds: readonly string[]) => void;
  readonly onClose: () => void;
}

export function RecordingConfirmDialog({
  open,
  projectId,
  revision,
  clips,
  selectedClipIds,
  confirmDisabled,
  onConfirm,
  onClose,
}: RecordingConfirmDialogProps) {
  const [scope, setScope] = useState<RecordingScope>('all');
  const [previewSelection, setPreviewSelection] = useState<{ clipId: string; seconds: number } | null>(null);

  useEffect(() => {
    if (open) { setScope('all'); setPreviewSelection(null); }
  }, [open]);

  const selectedClips = clips.filter((clip) => selectedClipIds.includes(clip.id));
  const offersSelection = selectedClips.length > 0 && selectedClips.length < clips.length;
  const scopedClips = offersSelection && scope === 'selected' ? selectedClips : clips;
  const estimate = recordingEstimate(scopedClips.flatMap((clip) => clip.capture_intent ?? []));
  const count = scopedClips.length;
  const total = clips.length;
  const selectedCount = selectedClips.length;
  const minutes = estimate.wallMinutes;
  const previewClip = scopedClips.find((clip) => clip.id === previewSelection?.clipId) ?? scopedClips[0];

  return (
    <Dialog
      open={open}
      className="w-[min(64rem,calc(100vw-2rem))]"
      title={<Trans>录制缺失片段</Trans>}
      confirmLabel={<Trans>开始录制</Trans>}
      confirmDisabled={confirmDisabled || count === 0}
      onConfirm={() => onConfirm(scopedClips.map((clip) => clip.id))}
      onClose={onClose}
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]" data-recording-confirm>
        <div className="flex min-w-0 flex-col gap-4">
          <p><Trans>将启动 CS2 和采集组件，录制 {count} 个还没有素材的片段。</Trans></p>
          {offersSelection ? (
            <Seg<RecordingScope>
              name="recording-scope"
              aria-label={t`录制范围`}
              fill
              value={scope}
              onChange={setScope}
              options={[
                { value: 'all', label: t`全部 ${total} 个未录制片段` },
                { value: 'selected', label: t`只录选中的 ${selectedCount} 个` },
              ]}
            />
          ) : null}
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-2 text-sm">
            <dt className="text-neutral-600"><Trans>录制时长</Trans></dt>
            <dd data-recording-seconds>{formatRecordedDuration(estimate.recordedSeconds)}</dd>
            <dt className="text-neutral-600"><Trans>预计用时</Trans></dt>
            <dd data-recording-wall-minutes><Trans>约 {minutes} 分钟</Trans></dd>
          </dl>
          <p className="text-xs text-neutral-600">
            <Trans>预计用时包含启动 CS2 和逐个加载片段，实际时间会有出入。</Trans>
          </p>
          <p className="flex items-start gap-2 text-sm text-warn-text">
            <CircleAlert className="mt-0.5 size-4 flex-none" aria-hidden="true" />
            <span><Trans>录制期间 CS2 会占用屏幕和声音，请不要操作电脑。进度和结果可以在「作品任务」里查看。</Trans></span>
          </p>
        </div>
        {open && previewClip !== undefined && (
          <div className="min-w-0">
            {scopedClips.length > 1 && <NativeSelect aria-label={t`预演片段`} value={previewClip.id}
              onChange={(event) => setPreviewSelection({ clipId: event.currentTarget.value, seconds: 0 })}>
              {scopedClips.map((clip) => <option key={clip.id} value={clip.id}>{clip.name}</option>)}
            </NativeSelect>}
            <ClipCameraInspection projectId={projectId} revision={revision} clipId={previewClip.id}
              sourceTimeSeconds={previewSelection?.clipId === previewClip.id ? previewSelection.seconds : 0}
              onSourceTimeChange={(seconds) => setPreviewSelection({ clipId: previewClip.id, seconds })} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function formatRecordedDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes === 0 ? t`${rest} 秒` : t`${minutes} 分 ${rest} 秒`;
}
