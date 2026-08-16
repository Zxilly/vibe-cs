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
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { Skeleton } from '../../design/data';
import { Notice, StatusDot, type StatusDotStatus } from '../../design/feedback';
import { Button, Seg, Slider } from '../../design/primitives';
import { useAppConfig, useQuickCheck, useStorageStatus, useUpdateAppConfig } from '../../data/config';
import { dataErrorMessage } from '../../data/errors';
import { useNativeShell, useNativeShellAction } from '../../data/nativeShell';
import { useServiceAction } from '../../data/serviceAction';
import type {
  AppConfig,
  DependencyCheck,
  DependencyKind,
  DependencyState,
  RecordingVoicePolicy,
} from '../../shared/desktop/dto';
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
  const service = useServiceAction();
  const shell = useNativeShell();
  const shellAction = useNativeShellAction();
  const [picking, setPicking] = useState(false);

  const current = config.data;
  const busy = update.isPending || picking;
  const blocked = service.blocked || busy;
  const blockedReason = service.blocked ? service.buttonProps.disabledReason : undefined;

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
        <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void config.refetch() }}>
          <Trans>读不到设置：{configError}</Trans>
        </Notice>
      )}
      {writeError === null ? null : (
        <Notice tone="danger" action={{ label: <Trans>知道了</Trans>, onAction: () => update.reset() }}>
          <Trans>这次改动没有保存：{writeError}</Trans>
        </Notice>
      )}

      <SettingsBlock
        title={<Trans>游戏</Trans>}
        description={<Trans>这些设置决定视频怎么被录出来。改动只影响之后新建的录制任务。</Trans>}
      >
        {current === undefined ? (
          <Skeleton />
        ) : (
          <>
            <SettingsRow
              label={<Trans>CS2 位置</Trans>}
              hint={<Trans>影响：能否启动回放与录制。</Trans>}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
            >
              <div className="flex items-center gap-2.5">
                <CheckDot checks={checks.data?.checks ?? []} kind="game" />
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
              </div>
            </SettingsRow>
            <PathReadout path={current.cs2_path} empty={<Trans>还没有设置</Trans>} />

            <SettingsRow
              label={<Trans>录制输出目录</Trans>}
              /* Not a field of its own — see the module comment. */
              hint={
                <Trans>
                  影响：新录制文件的存放位置。它跟着数据目录走，在「文件与资料库」里改。
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
                  onClick={() => void shell.openDirectory(current.data_dir)}
                >
                  <Trans>打开目录</Trans>
                </Button>
              </div>
            </SettingsRow>
            <PathReadout path={current.data_dir} empty={<Trans>还没有设置</Trans>} />
          </>
        )}
      </SettingsBlock>

      <SettingsBlock title={<Trans>录制默认值</Trans>}>
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
              hint={<Trans>影响：成片画面里是否出现界面元素。</Trans>}
              name="show-hud"
              ariaLabel={t`HUD`}
              checked={current.recording.show_hud}
              disabled={blocked}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
              onChange={(next) => writeRecording({ show_hud: next })}
            />
            <SettingsSwitch
              label={<Trans>雷达</Trans>}
              hint={<Trans>影响：成片画面里是否出现小地图。</Trans>}
              name="show-radar"
              ariaLabel={t`雷达`}
              checked={current.recording.show_radar}
              disabled={blocked}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
              onChange={(next) => writeRecording({ show_radar: next })}
            />

            <SettingsRow
              label={<Trans>语音</Trans>}
              hint={<Trans>影响：录制音轨里是否包含人声。</Trans>}
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
        title={<Trans>视频输出能力</Trans>}
        description={<Trans>这台机器能不能写出成片。检查的是本机的编码器，不是设置。</Trans>}
      >
        {checks.isPending ? (
          <Skeleton />
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {encoderChecks(checks.data?.checks ?? []).map((check) => (
                <li key={check.kind} className="flex items-center gap-2.5 text-sm">
                  <StatusDot status={dotStatus(check.state)} />
                  <span>{check.label}</span>
                  <span className="text-xs text-neutral-600">{check.detail}</span>
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
                disabled={service.blocked || checks.isFetching}
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

function CheckDot({
  checks,
  kind,
}: {
  readonly checks: readonly DependencyCheck[];
  readonly kind: DependencyKind;
}) {
  const check = checks.find((each) => each.kind === kind);
  if (check === undefined) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs text-neutral-700">
      <StatusDot status={dotStatus(check.state)} />
      {check.detail === '' ? check.label : check.detail}
    </span>
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
 * The draft is local until the pointer comes up, like the take-limit slider in
 * `AiAgentSection`: writing on every pixel of a drag would be one config PUT
 * per frame.
 */
function RollRow({ label, value, disabled, disabledReason, onCommit }: RollRowProps) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;

  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };

  return (
    <SettingsRow
      label={label}
      hint={<Trans>影响：每个片段自动多录多少。</Trans>}
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
          onPointerUp={commit}
          onBlur={commit}
        />
        <span className="w-14 flex-none font-mono text-sm" data-roll={shown}>
          {t`${shown.toFixed(1)} 秒`}
        </span>
      </div>
    </SettingsRow>
  );
}
