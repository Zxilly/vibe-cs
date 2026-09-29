import { dependencyLabel } from '../../../domain/environment/dependencyLabel';
/*
 * pages/settings — 设置 · 游戏与录制 (artboard 「12 设置与诊断」, the one section
 * that board draws in full).
 *
 *   游戏          CS2 位置 · 录制输出目录
 *   录制默认值    前/后留白 · 默认视角 · HUD 与雷达 · 语音
 *   视频输出能力  H.264 / AAC / MP4 · 上次检查 · 重新检查
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Two rows the artboard draws that this section does not
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **录制输出目录.** The board shows it as its own setting with its own 「更改」.
 * `AppConfig` has no such field: recordings are written under `data_dir`, and
 * there is exactly one directory setting on the wire. So the row is here, it
 * shows the derived path, and it says where the path comes from — rather than
 * a second picker that would silently write the same field as 文件与资料库's,
 * or a disabled control with no explanation.
 *
 * **默认视角（选手 POV / 观察者）.** `RecordingDefaults` has no view field.
 * A shot's view is decided per shot (`AgentShotView`), and the board's row
 * describes a *fallback* the Agent uses 「没有明确依据时」 — which has no
 * storage anywhere. Drawing the choice would mean drawing a control whose
 * answer goes nowhere, so it is recorded as a gap instead.
 *
 * ── 「改动只影响之后新建的录制任务」 ────────────────────────────────────
 *
 * That sentence is the board's, and it is true of every row in this section: a
 * recording task captures its settings when it is planned. It is stated once at
 * the top rather than repeated per row.
 *
 * ── CS2 位置 has two sources and one readout ─────────────────────────────
 *
 * `AppConfig.cs2_path` is what the user chose; the quick check's `game` entry
 * is what the service found, which is the configured path when it exists and
 * an auto-discovered install otherwise. Both used to be printed — the check
 * beside the button, the config under the hint — so a machine with a found
 * install and no manual choice read 「已找到 …cs2.exe」 and 「还没有设置」 on
 * two adjacent lines. One line now: the path in use, and which of the two
 * sources it came from.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { MapGeometrySettings } from './MapGeometrySettings';

import { Skeleton } from '../../../design/data';
import { Alert, StatusDot, type StatusDotStatus } from '../../../design/feedback';
import { Button, Seg, Slider } from '../../../design/primitives';
import { useAppConfig, useQuickCheck, useStorageStatus, useUpdateAppConfig } from '../../../data/config';
import { dataErrorMessage } from '../../../data/errors';
import { useNativeShell, useNativeShellAction, useOpenDirectory } from '../../../data/nativeShell';
import type {
  AppConfig,
  DependencyCheck,
  DependencyKind,
  DependencyState,
  RecordingVoicePolicy,
} from '../../../shared/desktop/dto';
import {
  formatBytes,
  PathReadout,
  SettingsBlock,
  SettingsRow,
  SettingsSwitch,
} from './settingsShared';

/** Roll bounds. Half a second is a frame-accurate nudge; ten is a whole round. */
const ROLL_MIN = 0;
const ROLL_MAX = 10;
const ROLL_STEP = 0.5;

/**
 * The checks 「视频输出能力」 is about.
 *
 * This was `['encoder', 'ffmpeg', 'media']` when `kind` was an open string and
 * the list was a guess at names the service might use; two of the three never
 * existed. `DependencyKind` is an enum now, so this is the actual set — and a
 * new kind will not silently fall out of this block, because adding one to the
 * enum without deciding whether it belongs here is a decision, not an accident.
 */
const ENCODER_CHECK_KINDS: readonly DependencyKind[] = ['encoder'];

export function GameSection() {
  const config = useAppConfig();
  const checks = useQuickCheck();
  const storage = useStorageStatus();
  const update = useUpdateAppConfig();
  const shell = useNativeShell();
  const openDirectory = useOpenDirectory();
  const shellAction = useNativeShellAction();
  const [picking, setPicking] = useState(false);

  const current = config.data;
  const busy = update.isPending || picking;
  const blocked = busy;
  const blockedReason = blocked ? t`正在处理` : undefined;

  const write = (next: AppConfig) => void update.mutateAsync(next).catch(() => undefined);
  const writeRecording = (patch: Partial<AppConfig['recording']>) => {
    if (current === undefined) return;
    write({ ...current, recording: { ...current.recording, ...patch } });
  };

  const configError = dataErrorMessage(config.error);
  const writeError = dataErrorMessage(update.error);

  return (
    <div className="flex flex-col">
      {configError === null ? null : (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void config.refetch() }}>
          <Trans>读不到设置：{configError}</Trans>
        </Alert>
      )}
      {writeError === null ? null : (
        <Alert variant="danger" action={{ label: <Trans>知道了</Trans>, onAction: () => update.reset() }}>
          <Trans>这次改动没有保存：{writeError}</Trans>
        </Alert>
      )}

      <SettingsBlock
        id="game"
        title={<Trans>游戏</Trans>}
        description={<Trans>更改仅影响之后的录制。</Trans>}
      >
        {current === undefined ? (
          <Skeleton />
        ) : (
          <>
            <SettingsRow
              label={<Trans>CS2 位置</Trans>}
              hint={<Trans>回放与录制都从这个目录启动游戏。</Trans>}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
            >
              <Button
                variant="secondary"
                size="sm"
                {...(shellAction.available
                  ? { disabled: blocked, ...(blockedReason === undefined ? {} : { disabledReason: blockedReason }) }
                  : shellAction.buttonProps)}
                onClick={() => {
                  setPicking(true);
                  void shell
                    .chooseDirectories({ title: t`选择 CS2 安装目录`, multiple: false })
                    .then((paths) => {
                      const [path] = paths;
                      if (path !== undefined) write({ ...current, cs2_path: path });
                    })
                    .finally(() => setPicking(false));
                }}
              >
                <Trans>更改</Trans>
              </Button>
            </SettingsRow>
            <GameLocationReadout
              configured={current.cs2_path}
              check={(checks.data?.checks ?? []).find((check) => check.kind === 'game')}
            />

            <SettingsRow
              label={<Trans>录制文件目录</Trans>}
              /* Not a field of its own — see the module comment. */
              hint={
                <Trans>
                  在「文件与资料库」中更改录制保存位置。
                </Trans>
              }
            >
              <div className="flex items-center gap-2.5">
                {storage.data === undefined ? null : (
                  <span className="font-mono text-xs text-neutral-700">
                    <Trans>剩余 {formatBytes(storage.data.filesystem_available_bytes)}</Trans>
                  </span>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  {...shellAction.buttonProps}
                  onClick={() => openDirectory(current.data_dir)}
                >
                  <Trans>打开目录</Trans>
                </Button>
              </div>
            </SettingsRow>
            <PathReadout path={current.data_dir} empty={<Trans>还没有设置</Trans>} />
          </>
        )}
      </SettingsBlock>

      <MapGeometrySettings />

      <SettingsBlock id="recording-defaults" title={<Trans>录制默认值</Trans>}>
        {current === undefined ? (
          <Skeleton />
        ) : (
          <>
            <RollRow
              label={<Trans>前留白</Trans>}
              value={current.recording.pre_roll_seconds}
              disabled={blocked}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
              onCommit={(seconds) => writeRecording({ pre_roll_seconds: seconds })}
            />
            <RollRow
              label={<Trans>后留白</Trans>}
              value={current.recording.post_roll_seconds}
              disabled={blocked}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
              onCommit={(seconds) => writeRecording({ post_roll_seconds: seconds })}
            />

            <SettingsSwitch
              label={<Trans>HUD</Trans>}
              hint={<Trans>成片画面里保留游戏的 HUD 界面元素。</Trans>}
              name="show-hud"
              ariaLabel={t`HUD`}
              checked={current.recording.show_hud}
              disabled={blocked}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
              onChange={(next) => writeRecording({ show_hud: next })}
            />
            <SettingsSwitch
              label={<Trans>雷达</Trans>}
              hint={<Trans>成片画面里保留左上角的小地图。</Trans>}
              name="show-radar"
              ariaLabel={t`雷达`}
              checked={current.recording.show_radar}
              disabled={blocked}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
              onChange={(next) => writeRecording({ show_radar: next })}
            />

            <SettingsRow
              label={<Trans>语音</Trans>}
              hint={<Trans>决定录制音轨里保留谁的语音。</Trans>}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
            >
              <Seg
                name="recording-voice"
                size="sm"
                value={current.recording.voice}
                aria-label={t`录制语音`}
                options={VOICE_CHOICES.map((choice) => ({
                  value: choice.value,
                  label: choice.label,
                  disabled: blocked,
                }))}
                onChange={(voice) => writeRecording({ voice })}
              />
            </SettingsRow>
          </>
        )}
      </SettingsBlock>

      <SettingsBlock
        id="video-output"
        title={<Trans>成品生成能力</Trans>}
        description={<Trans>这里显示本机的成片生成能力，结果来自编码器检查。</Trans>}
      >
        {checks.isPending ? (
          <Skeleton />
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {encoderChecks(checks.data?.checks ?? []).map((check) => (
                <li key={check.kind} className="flex items-center gap-2.5 text-sm">
                  <StatusDot status={dotStatus(check.state)} />
                  <span>{dependencyLabel(check.kind)}</span>
                  <span className="text-xs text-neutral-600">{check.state === 'ready' ? <Trans>就绪</Trans> : <Trans>需要配置</Trans>}</span>
                </li>
              ))}
            </ul>
            {encoderChecks(checks.data?.checks ?? []).length === 0 ? (
              <p className="text-xs text-neutral-600">
                {/* Honest about *why* it is empty: the service answered, and
                    nothing it answered with was an encoder check. */}
                <Trans>这次检查里没有编码器项。完整的检查列表在「高级与诊断」。</Trans>
              </p>
            ) : null}
            <div className="flex items-center gap-2.5">
              {checks.data === undefined ? null : (
                <span className="text-xs text-neutral-600">
                  <Trans>上次检查 {new Date(checks.data.checked_at).toLocaleString()}</Trans>
                </span>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={checks.isFetching}
                disabledReason={blockedReason ?? t`正在检查`}
                onClick={() => void checks.refetch()}
              >
                <Trans>重新检查</Trans>
              </Button>
            </div>
          </>
        )}
      </SettingsBlock>
    </div>
  );
}

/** The board's two words, and the third the wire has. */
const VOICE_CHOICES: ReadonlyArray<{ value: RecordingVoicePolicy; label: React.ReactNode }> = [
  { value: 'all_players', label: <Trans>全部保留</Trans> },
  /* 「保留队内」 on the board is this one: only the recorded player's voice.
     The board's wording describes the effect, the wire's names the rule. */
  { value: 'target_only', label: <Trans>只保留目标选手</Trans> },
  { value: 'muted', label: <Trans>全部静音</Trans> },
];

function encoderChecks(checks: readonly DependencyCheck[]): DependencyCheck[] {
  return checks.filter((check) => ENCODER_CHECK_KINDS.includes(check.kind));
}

/**
 * The CS2 path in use and where it came from — see the module comment.
 *
 * A configured path is printed as the user's own choice, with the check's dot
 * saying whether it still exists. Without one, the check's `detail` is the
 * discovered path (the service prints the path itself when it found one), and
 * the line says it was found rather than set. Nothing found and nothing set
 * is the one case that reads as an instruction.
 */
function GameLocationReadout({
  configured,
  check,
}: {
  readonly configured: string;
  readonly check: DependencyCheck | undefined;
}) {
  const specified = configured.trim() !== '';
  const detected = !specified && check?.state === 'ready';
  const path = specified ? configured : detected ? check.detail : '';

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs" data-game-location={specified ? 'specified' : detected ? 'detected' : 'none'}>
      {check === undefined ? null : <StatusDot status={dotStatus(check.state)} />}
      <span className="text-neutral-600">
        {specified ? (
          <Trans>手动指定</Trans>
        ) : detected ? (
          <Trans>自动检测到</Trans>
        ) : (
          <Trans>还没有找到 CS2。点「更改」选择安装目录。</Trans>
        )}
      </span>
      {path === '' ? null : <PathReadout path={path} empty={null} />}
    </div>
  );
}

/**
 * Two states, so two dots.
 *
 * The paragraph here used to argue that an unclassifiable state should paint
 * `idle` rather than `ok`, because `StatusDot` has no 「不知道」 colour and
 * green would be the one answer that could be actively wrong. That argument was
 * about an open string; `DependencyState` is `ready | missing`, and there is
 * nothing left to be unable to classify.
 */
function dotStatus(state: DependencyState): StatusDotStatus {
  return state === 'ready' ? 'ok' : 'fail';
}

interface RollRowProps {
  readonly label: React.ReactNode;
  readonly value: number;
  readonly disabled: boolean;
  readonly disabledReason?: string | undefined;
  readonly onCommit: (seconds: number) => void;
}

/**
 * 前 / 后留白, in half-second steps.
 *
 * The draft is local until the gesture ends, like the take-limit slider in
 * `AiAgentSection`: writing on every pixel of a drag would be one config PUT
 * per frame. `Slider` reports the end of the gesture itself, so the draft only
 * has to feed the readout beside the track.
 */
function RollRow({ label, value, disabled, disabledReason, onCommit }: RollRowProps) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;

  const commit = (settled: number) => {
    if (settled !== value) onCommit(settled);
    setDraft(null);
  };

  return (
    <SettingsRow
      label={label}
      hint={<Trans>每个片段在正式内容之外多录的时长。</Trans>}
      {...(disabledReason === undefined ? {} : { disabledReason })}
    >
      <div className="flex min-w-64 flex-1 items-center gap-3.5">
        <Slider
          className="min-w-0 flex-1"
          value={shown}
          min={ROLL_MIN}
          max={ROLL_MAX}
          step={ROLL_STEP}
          disabled={disabled}
          aria-label={typeof label === 'string' ? label : t`留白`}
          valueText={t`${shown.toFixed(1)} 秒`}
          onChange={(next) => setDraft(next)}
          onCommit={(next) => commit(next)}
        />
        <span className="w-14 flex-none font-mono text-sm" data-roll={shown}>
          {t`${shown.toFixed(1)} 秒`}
        </span>
      </div>
    </SettingsRow>
  );
}
