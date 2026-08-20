import { Trans } from '@lingui/react/macro';
import { useMemo, useState } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useNativeShell } from '../../data/nativeShell';
import { useRecordedClipRecords } from '../../data/recording';
import { useServiceAction } from '../../data/serviceAction';
import { Alert, Dialog } from '../../design/feedback';
import { Button } from '../../design/primitives';
import type { PlanChange } from '../../domain/agent';
import type { AgentPlanShot, JsonValue, RecordedClipRecord } from '../../shared/desktop/dto';
import { useCameraDesk } from '../recording/cameraDesk';
import type { RecordingShot } from '../recording/recordingContract';

export interface ChangePreviewDialogProps {
  readonly open: boolean;
  readonly change: PlanChange | null;
  readonly shot: AgentPlanShot | null;
  readonly onClose: () => void;
  readonly onAccept?: (() => void) | undefined;
}

export function ChangePreviewDialog({
  open,
  change,
  shot,
  onClose,
  onAccept,
}: ChangePreviewDialogProps) {
  const shell = useNativeShell();
  const service = useServiceAction();
  const takes = useRecordedClipRecords({ enabled: open });
  const recordingShot = useMemo(() => recordingShotFor(shot), [shot]);
  const camera = useCameraDesk({ shot: recordingShot, service, preflight: null, enabled: open });
  const [confirmingGame, setConfirmingGame] = useState(false);

  const take = shot === null ? null : takeForShot(takes.data?.items ?? [], shot.id);
  const src = take === null ? null : shell.mediaSrc(take.stream_url);
  const takeError = dataErrorMessage(takes.error);
  const cameraError = dataErrorMessage(camera.error);

  return (
    <>
      <Dialog
        open={open}
        title={<Trans>预览这条修改</Trans>}
        confirmLabel={onAccept === undefined ? <Trans>完成预览</Trans> : <Trans>接受修改</Trans>}
        onClose={onClose}
        onConfirm={() => {
          onAccept?.();
          onClose();
        }}
      >
        {change === null ? null : (
          <div className="flex flex-col gap-3">
            <p className="border border-divider p-2 text-xs">
              <span className="font-medium">{shot?.title ?? change.targetShotId}</span>
              {change.before === null && change.after === null ? null : (
                <span className="ml-2 font-mono">{change.before ?? '—'} → {change.after ?? '—'}</span>
              )}
            </p>

            {takeError === null ? null : (
              <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void takes.refetch() }}>
                <Trans>读不到已有录制结果：{takeError}</Trans>
              </Alert>
            )}

            {src === null ? null : (
              <div>
                <p className="mb-1 text-xs text-neutral-600"><Trans>已有录制结果 · 直接播放</Trans></p>
                <video data-change-preview="take" src={src} controls preload="metadata" className="w-full border border-divider" />
              </div>
            )}

            {take === null ? (
              <div className="flex flex-col gap-2 border border-divider p-2">
                <p className="text-xs text-neutral-600">
                  <Trans>这条片段还没有录制结果；可以编译相机路径后在 CS2 里只读预览，不会录制。</Trans>
                </p>
                {cameraError === null ? null : <p className="text-xs text-fail-text">{cameraError}</p>}
                <Button
                  size="sm"
                  disabled={camera.inGame.action.disabled}
                  {...(camera.inGame.action.disabledReason === undefined
                    ? {}
                    : { disabledReason: camera.inGame.action.disabledReason })}
                  onClick={() => setConfirmingGame(true)}
                >
                  {camera.status === 'loading' ? <Trans>正在编译预览</Trans> : <Trans>在游戏里预览</Trans>}
                </Button>
                {camera.inGame.action.disabled && camera.inGame.action.disabledReason !== undefined ? (
                  <p className="text-xs text-neutral-600">{camera.inGame.action.disabledReason}</p>
                ) : null}
              </div>
            ) : src === null ? (
              <p className="text-xs text-neutral-600"><Trans>已有录制结果，但只有 Desktop 能播放本机文件。</Trans></p>
            ) : null}
          </div>
        )}
      </Dialog>

      <Dialog
        open={confirmingGame}
        title={<Trans>启动 CS2 预览这个片段？</Trans>}
        confirmLabel={<Trans>启动游戏</Trans>}
        onClose={() => setConfirmingGame(false)}
        onConfirm={() => {
          setConfirmingGame(false);
          camera.inGame.launch();
        }}
      >
        <p><Trans>只会启动回放并跳到片段起点，不会采集画面或产生文件。</Trans></p>
      </Dialog>
    </>
  );
}

function recordingShotFor(shot: AgentPlanShot | null): RecordingShot | null {
  const recording = shot?.recording;
  if (shot === null || recording === undefined || recording === null) return null;
  return {
    id: shot.id,
    demo_id: recording.demo_id,
    highlight_id: recording.highlight_id,
    player_id: recording.player_id,
    title: shot.title,
    start_tick: shot.start_tick,
    end_tick: shot.end_tick,
    pre_roll_seconds: recording.pre_roll_seconds,
    post_roll_seconds: recording.post_roll_seconds,
    victim_pov: recording.victim_pov,
    camera_style: shot.kind,
    presentation: recording.presentation,
  };
}

function metadataRequestId(metadata: JsonValue): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).request_id;
  return typeof value === 'string' ? value : null;
}

export function takeForShot(
  takes: readonly RecordedClipRecord[],
  shotId: string,
): RecordedClipRecord | null {
  return takes.find((take) => metadataRequestId(take.metadata) === shotId) ?? null;
}
