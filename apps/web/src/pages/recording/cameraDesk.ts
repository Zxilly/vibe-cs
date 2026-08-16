/*
 * pages/recording — the camera path of the selected shot, and the one door into
 * the game.
 *
 * Two surfaces need the same compiled path and neither may compile it twice:
 *
 *   block B  导播预览 draws the keyframes over the radar, plus the height strip
 *   block D  「在游戏里预览」 exports the same path and launches CS2 on it
 *
 * So the shell owns one desk and hands it to both, the same way it owns one
 * `RecordingPreflightGate` and one 开始录制. Two `usePreviewCameraPath()`
 * instances would POST twice per selection and could show a path that is not
 * the one the export wrote.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  「在游戏里预览」 is three calls, and none of them records
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. `previewHlaeProposal({ …, mode: 'preview' })` compiles the camera path
 *      and reports prerequisites. `crates/hlae/src/compile.rs` appends
 *      `mirv_campath draw enabled 1` for a preview-mode plan and emits **no
 *      capture command at all** — the notice code `PreviewDoesNotRecord` exists
 *      for precisely this.
 *   2. `exportHlaeProposal(intent, confirmation)` writes the script bundle to
 *      disk: a bootstrap `.cfg`, a command-system XML, one camera path per shot,
 *      a README and a launch profile. Its answer carries `launched: false`,
 *      hard-coded.
 *   3. `playDemo(demoId, { start_tick })` starts CS2 on the Demo at the shot's
 *      first tick.
 *
 * ── What step 3 does **not** do, said plainly ─────────────────────────────
 *
 * `launched: false` is not a placeholder and `playDemo` is not the bundle's
 * launcher. `crates/runtime/src/integration.rs`'s `build_playback_command`
 * starts plain CS2 with `+demo_gototick`; it does not go through HLAE's custom
 * loader, so `mirv_*` does not exist in that process and **the path is not drawn
 * until the exported bootstrap is loaded through HLAE by hand**. The export
 * module says the same thing from its side: 「No generated file is executed」.
 *
 * So the desk keeps the export result (`bundle` below) and the page prints the
 * directory with a way to open it, rather than claiming the game came up with
 * the path on screen. Closing that gap needs a route that launches the managed
 * HLAE session on a bundle without recording; there is none, and it is
 * reported.
 *
 * It still takes an explicit confirmation. §4.5.3 rule ① governs *recording*
 * and this is not a recording — but it writes files and launches an external
 * process that seizes the machine and the focus, so it is confirmed like one,
 * and the dialog says in so many words that nothing is being recorded.
 *
 * ── Why it can be unavailable, and who decides ────────────────────────────
 *
 * Not this file, and not a second probe. `game_ready` and
 * `capture_component_ready` are two of the eight rows the preflight already
 * measured; asking again would be a second answer to a question that has one.
 * `preflightGate` below reads those two rows, and the playback status supplies
 * the third reason (CS2 is already replaying something — the backend refuses a
 * second launch anyway, and 「录制中拒绝启动回放」 has its own test on that side).
 */

import { t } from '@lingui/core/macro';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useRuntimeState } from '../../data/config';
import {
  useExportCameraPath,
  usePreviewCameraPath,
  useStartDemoPlayback,
  useStopDemoPlayback,
} from '../../data/recording';
import type { ServiceActionState } from '../../data/serviceAction';
import type {
  HlaeProposalExportResult,
  HlaeProposalIntent,
  HlaeProposalPreview,
  ProposalPrerequisite,
  RecordingPreflight,
  RecordingRequest,
} from '../../shared/desktop/dto';
import { readHlaeCameraPlan, type CameraPlan } from './cameraPlan';

/* ── the intent ──────────────────────────────────────────────────────────── */

/**
 * The proposal intent a shot maps to, or `null`.
 *
 * `HlaeProposalIntent.highlight_ids` is not optional, and the evidence sampler
 * on the other side walks the highlight to find the four frames it needs. A
 * shot with `highlight_id: null` — a hand-built queue item, or a plan shot the
 * Agent placed by tick — therefore has no camera path to compile, and the
 * honest answer is to say that rather than to send an empty array and read the
 * 422 back as though it were about something else.
 */
export function cameraIntentForShot(item: RecordingRequest | null): HlaeProposalIntent | null {
  if (item === null) return null;
  const highlightId = item.highlight_id;
  if (highlightId === null || highlightId === '') return null;
  return {
    demo_id: item.demo_id,
    highlight_ids: [highlightId],
    camera_style: item.camera_style,
    mode: 'preview',
    lead_seconds: item.pre_roll_seconds,
    tail_seconds: item.post_roll_seconds,
  };
}

/** A stable key for an intent, so a held preview is dropped the moment the shot
 *  it describes stops being the shot on screen. */
export function cameraIntentKey(intent: HlaeProposalIntent | null): string {
  if (intent === null) return '';
  return [
    intent.demo_id,
    intent.highlight_ids.join(','),
    intent.camera_style,
    intent.mode,
    intent.lead_seconds,
    intent.tail_seconds,
  ].join('|');
}

/* ── the desk ────────────────────────────────────────────────────────────── */

export type CameraPreviewStatus =
  /** No shot selected, or the shot has no highlight to sample. */
  | 'unavailable'
  | 'idle'
  | 'loading'
  /** Compiled, and `plan` is drawable. */
  | 'ready'
  /** Compiled, and the answer is a list of prerequisites instead of a path. */
  | 'blocked'
  | 'failed';

export type InGameStage = 'idle' | 'compiling' | 'writing' | 'launching' | 'failed';

export interface CameraGuardedAction {
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

export interface InGamePreviewDesk {
  readonly action: CameraGuardedAction;
  /** CS2 is already replaying something. The button becomes 「停止预览」. */
  readonly running: boolean;
  readonly stage: InGameStage;
  /**
   * Where the script bundle was written, once it has been. Kept because the
   * game does **not** load it by itself — see the module note — so the
   * directory is the only thing that makes the action finishable by hand.
   */
  readonly bundle: HlaeProposalExportResult | null;
  readonly error: unknown;
  /** Runs the three calls. Call it from the confirmation dialog, never from a
   *  click handler directly. */
  readonly launch: () => void;
  readonly stop: () => void;
  readonly stopAction: CameraGuardedAction;
}

export interface CameraDesk {
  readonly shotId: string | null;
  readonly intent: HlaeProposalIntent | null;
  readonly status: CameraPreviewStatus;
  readonly preview: HlaeProposalPreview | null;
  readonly plan: CameraPlan | null;
  readonly prerequisites: readonly ProposalPrerequisite[];
  /** Free-text notices the compiler produced — 「预览不会录制」 is one of them. */
  readonly notices: readonly string[];
  readonly error: unknown;
  readonly reload: () => void;
  readonly inGame: InGamePreviewDesk;
}

export interface CameraDeskOptions {
  readonly shot: RecordingRequest | null;
  readonly service: ServiceActionState;
  /** The check list, when one has been run. Two of its rows decide whether the
   *  in-game door is open; nothing here probes for itself. */
  readonly preflight: RecordingPreflight | null;
  /** Off in tests that only assert markup, so no mutation fires on mount. */
  readonly enabled?: boolean | undefined;
}

interface HeldPreview {
  readonly key: string;
  readonly preview: HlaeProposalPreview | null;
  readonly error: unknown;
}

/**
 * Compiles the selected shot's camera path, and holds the answer keyed on the
 * intent it was produced from.
 *
 * The hold is derived rather than cleared by an effect, for the same reason
 * `useRecordingPreflight` does it that way: an effect that reset state on change
 * renders the previous answer once, and once is a path drawn over the wrong
 * shot.
 */
export function useCameraDesk({
  shot,
  service,
  preflight,
  enabled = true,
}: CameraDeskOptions): CameraDesk {
  const intent = useMemo(() => cameraIntentForShot(shot), [shot]);
  const key = cameraIntentKey(intent);

  const preview = usePreviewCameraPath();
  const exportPath = useExportCameraPath();
  const startPlayback = useStartDemoPlayback();
  const stopPlayback = useStopDemoPlayback();
  /*
   * `RuntimeState.runtime_session` rather than `playbackStatus`: it is the one
   * field that answers 「服务现在在做什么」 as a closed set, and it names the
   * recording case too — the backend refuses a launch while a recording runs
   * (`playback_launch_is_rejected_while_recording_is_active`), so the button is
   * disabled with that reason instead of failing after the click.
   */
  const runtime = useRuntimeState({ enabled: enabled && !service.blocked });

  const [held, setHeld] = useState<HeldPreview | null>(null);
  const [stage, setStage] = useState<InGameStage>('idle');
  const [launchError, setLaunchError] = useState<unknown>(null);
  const [bundle, setBundle] = useState<HlaeProposalExportResult | null>(null);

  const run = useRef<(compileKey: string) => void>(() => {});
  run.current = (compileKey: string) => {
    if (intent === null) return;
    preview.mutate(intent, {
      onSuccess: (answer) => setHeld({ key: compileKey, preview: answer, error: null }),
      onError: (error) => setHeld({ key: compileKey, preview: null, error }),
    });
  };

  /*
   * Compile on selection. A POST that writes nothing, so running it because the
   * user looked at a shot is legitimate — it is the block's content, not a side
   * effect of rendering something else. Guarded on the service being up, so an
   * offline app does not queue a request per click.
   */
  useEffect(() => {
    if (!enabled || service.blocked || key === '') return;
    run.current(key);
  }, [enabled, service.blocked, key]);

  const current = held !== null && held.key === key ? held : null;
  const answer = current?.preview ?? null;
  const plan = useMemo(() => readHlaeCameraPlan(answer), [answer]);

  const status: CameraPreviewStatus =
    intent === null
      ? 'unavailable'
      : preview.isPending
        ? 'loading'
        : current === null
          ? 'idle'
          : current.error !== undefined && current.error !== null
            ? 'failed'
            : answer !== null && answer.ready && plan !== null
              ? 'ready'
              : 'blocked';

  const session = runtime.data?.runtime_session ?? 'idle';
  const running = session === 'playback' || session === 'playback_launching';
  const recording = session === 'recording';
  const gate = inGameGate({ service, preflight, intent, status, running, recording, stage });

  return {
    shotId: shot?.id ?? null,
    intent,
    status,
    preview: answer,
    plan,
    prerequisites: answer?.prerequisites ?? EMPTY_PREREQUISITES,
    notices: answer?.notices ?? EMPTY_NOTICES,
    error: current?.error ?? null,
    reload: () => {
      if (key === '') return;
      run.current(key);
    },
    inGame: {
      action: gate,
      running,
      stage,
      bundle,
      error: launchError,
      launch: () => {
        if (intent === null || answer === null) return;
        setLaunchError(null);
        setBundle(null);
        setStage('writing');
        exportPath.mutate(
          { intent, preview: answer },
          {
            onSuccess: (written) => {
              setBundle(written);
              setStage('launching');
              startPlayback.mutate(
                { demoId: intent.demo_id, options: { start_tick: shot?.start_tick ?? 0 } },
                {
                  onSuccess: () => setStage('idle'),
                  onError: (error) => {
                    setLaunchError(error);
                    setStage('failed');
                  },
                },
              );
            },
            onError: (error) => {
              setLaunchError(error);
              setStage('failed');
            },
          },
        );
      },
      stop: () => {
        stopPlayback.mutate(undefined, {
          onError: (error) => setLaunchError(error),
        });
      },
      stopAction: service.blocked ? service.buttonProps : { disabled: stopPlayback.isPending },
    },
  };
}

const EMPTY_PREREQUISITES: readonly ProposalPrerequisite[] = [];
const EMPTY_NOTICES: readonly string[] = [];

/**
 * 「禁用并写明原因」 for the in-game door, in the order a reader would ask.
 *
 * `game_ready` and `capture_component_ready` come from the check list the page
 * already ran; a `blocked` row on either is the reason, printed as the reason,
 * rather than a launch that fails a second later with an English message from
 * the service.
 */
export function inGameGate(input: {
  readonly service: ServiceActionState;
  readonly preflight: RecordingPreflight | null;
  readonly intent: HlaeProposalIntent | null;
  readonly status: CameraPreviewStatus;
  readonly running: boolean;
  readonly recording: boolean;
  readonly stage: InGameStage;
}): CameraGuardedAction {
  if (input.service.blocked) return input.service.buttonProps;
  if (input.intent === null) {
    return { disabled: true, disabledReason: t`这个片段没有绑定高光，没有可以在游戏里画的相机路径` };
  }
  if (input.recording) {
    return { disabled: true, disabledReason: t`正在录制，录制期间不能再启动一次回放` };
  }
  if (input.running) {
    return { disabled: true, disabledReason: t`游戏正在回放另一段 Demo，先停止它再预览这个镜头` };
  }
  if (input.stage === 'writing' || input.stage === 'launching') {
    return { disabled: true, disabledReason: t`正在启动游戏，请稍候` };
  }

  const checks = input.preflight?.checks ?? [];
  const game = checks.find((check) => check.code === 'game_ready');
  const capture = checks.find((check) => check.code === 'capture_component_ready');
  if (game?.state === 'blocked') {
    return { disabled: true, disabledReason: t`录制前校验没有找到可用的 CS2，无法在游戏里预览` };
  }
  if (capture?.state === 'blocked') {
    return { disabled: true, disabledReason: t`采集组件还没准备好，无法在游戏里预览` };
  }

  if (input.status !== 'ready') {
    return { disabled: true, disabledReason: t`相机路径还没有编译出来，先等导播预览就绪` };
  }
  return { disabled: false };
}
