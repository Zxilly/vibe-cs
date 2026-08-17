/*
 * pages/recording — block D, 片段属性 (the artboard's 360px right column).
 *
 * 镜头类型 / 视角 / 前后留白 / 视野 FOV / 持枪视野 / 闪光强度 / HUD / 雷达 /
 * 队内语音, plus 存为预设, 应用到全部 and 「在游戏里预览」.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Four things this panel must get right, all of them backend contracts
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **1. `presentation: null` means 「跟随全局默认」, not 「关掉」.** The wire keeps
 * 「the user never touched these controls」 and 「the user set them to exactly
 * today's global default」 apart on purpose, so the panel keeps them apart too:
 * an inherited shot says 跟随全局默认 and the values are the config's; touching
 * any one of the six detaches the shot (there is no partial write — the field is
 * one object) and 「跟随全局默认」 comes back as an explicit action.
 *
 * **2. 视野 FOV and 持枪视野 are POV-only, and the backend *rejects* rather than
 * ignores.** `crates/domain/src/recording.rs` answers 400 for a non-neutral
 * field of view on an observer shot — 「observer shots take their field of view
 * from the camera path」. An observer shot draws no viewmodel at all. So both
 * controls are disabled for a non-POV style **with the reason written beside
 * them** (`presentationFieldsFor`), and `presentationForStyle` re-neutralises
 * them on every write, so a value left over from a style change cannot reach the
 * wire.
 *
 * **3. 闪光强度 is `flash_alpha / 255`, and it is *not* inverted here.**
 * `flash_alpha` is *remaining* flash: 255 is a fully drawn flashbang, 0 is none.
 * The inversion happens one layer down, where
 * `crates/hlae/src/scene_presentation.rs` emits `mirv_noflash (1 - alpha/255)` —
 * its own test pins 「`flash_alpha: 102` → `mirv_noflash 0.6`」, which is the
 * artboard's 「闪光强度 40%」. `flashAlphaToPercent` / `percentToFlashAlpha` are
 * the two directions and they are unit-tested for the round trip; nothing in
 * this file divides by 255 by hand.
 *
 * **4. 「在游戏里预览」 starts a game and is confirmed like one — but it does not
 * record, and the dialog says so.** `crates/hlae/src/compile.rs` appends
 * `mirv_campath draw enabled 1` for a preview-mode plan and emits no capture
 * command; `HlaeNoticeCode::PreviewDoesNotRecord` exists to say exactly that.
 * The chain and its three gates are `cameraDesk.ts`.
 *
 * It also does not finish by itself, and this panel says which half is missing
 * rather than implying it is done: `exportHlaeProposal` answers
 * `launched: false`, and `playDemo` starts *plain* CS2 (`build_playback_command`
 * adds `+demo_gototick`, nothing else), so the path is not drawn until the
 * exported bootstrap is loaded through HLAE. The bundle's directory is
 * therefore printed with a way to open it — that is the rest of the action, not
 * a receipt for it.
 *
 * ── 应用到全部 and 存为预设 ────────────────────────────────────────────────
 *
 * Both move the same set of fields — camera style, 视角, the two roll-ins and
 * the whole presentation — and neither carries `demo_id`, `player_id`, the tick
 * window or the title. That is what makes them safe: applying either can never
 * retarget a shot at different footage. 应用到全部 is a confirmed action because
 * it rewrites every shot at once and there is no undo on the wire (there is no
 * wire call at all — it is N local edits, re-planned once).
 *
 * ── §8 ────────────────────────────────────────────────────────────────────
 *
 * The panel is a `design/layout/Inspector`, so folding at the observed
 * breakpoint is the design layer's behaviour rather than a media query written
 * here — the folded strip keeps a summary and opens the rest in a drawer.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { useAppConfig } from '../../data/config';
import { dataErrorMessage } from '../../data/errors';
import { useNativeShell, useNativeShellAction } from '../../data/nativeShell';
import { useCreateRecordingShotPreset, useRecordingShotPresets } from '../../data/recording';
import { Empty } from '../../design/data';
import { Dialog, Alert } from '../../design/feedback';
import { Inspector } from '../../design/layout';
import { Button, Field, Input, InputGroup, InputGroupAddon, InputGroupInput, Seg, Slider, Toggle } from '../../design/primitives';
import type { RecordingRequest, RecordingShotPreset } from '../../shared/desktop/dto';
import type { CameraDesk } from './cameraDesk';
import {
  CAMERA_FOV_RANGE,
  VIEWMODEL_FOV_RANGE,
  flashAlphaToPercent,
  percentToFlashAlpha,
  presentationFieldsFor,
  resolveShotPresentation,
  type RecordingBlockProps,
  type RecordingDefaults,
  type RecordingShot,
} from './recordingContract';
import {
  CAMERA_STYLE,
  CAMERA_STYLES,
  SHOT_VIEW,
  SHOT_VIEWS,
  VOICE_POLICIES,
  VOICE_POLICY,
  applyToAllPatch,
  detachedPresentationPatch,
  patchCameraStyle,
  patchPresentation,
  patchShotView,
  presetDraftFromShot,
  presetPatch,
  shotViewOf,
} from './shotModel';

export interface ShotInspectorBlockProps extends RecordingBlockProps {
  readonly camera: CameraDesk;
}

export function ShotInspectorBlock({
  plan,
  selection,
  service,
  collapsed,
  camera,
}: ShotInspectorBlockProps) {
  const { i18n } = useLingui();
  const config = useAppConfig();
  const shot = plan.items.find((item) => item.id === selection.shotId) ?? null;
  const index = plan.items.findIndex((item) => item.id === selection.shotId);

  return (
    <Inspector
      title={
        shot === null ? (
          <Trans>片段属性</Trans>
        ) : (
          <Trans>片段属性 · {String(index + 1).padStart(2, '0')}</Trans>
        )
      }
      label={t`片段属性`}
      summary={shot?.title ?? t`未选中片段`}
      collapsed={collapsed}
      footer={
        shot === null || config.data === undefined ? null : (
          <ShotActions
            shot={shot}
            defaults={config.data.recording}
            plan={plan}
            service={service}
          />
        )
      }
    >
      {shot === null ? (
        <Empty
          title={<Trans>未选中片段</Trans>}
          description={<Trans>在左边选一个片段，这里会显示它的镜头类型、视角与画面参数。</Trans>}
          actions={null}
        />
      ) : config.data === undefined ? (
        <ConfigState config={config} />
      ) : (
        <div className="flex flex-col gap-3.5">
          <ShotForm
            shot={shot}
            defaults={config.data.recording}
            onEdit={(patch) => plan.editShot(shot.id, patch)}
            i18n={i18n}
          />
          <InGamePreview camera={camera} />
        </div>
      )}
    </Inspector>
  );
}

/* ── the config the whole panel depends on ───────────────────────────────── */

function ConfigState({ config }: { readonly config: ReturnType<typeof useAppConfig> }) {
  const failure = dataErrorMessage(config.error);
  if (failure !== null) {
    return (
      <Alert
        variant="danger"
        action={{ label: <Trans>重试</Trans>, onAction: () => void config.refetch() }}
      >
        <Trans>读不到录制默认值，画面参数暂时无法显示：{failure}</Trans>
      </Alert>
    );
  }
  return (
    <p role="status" aria-busy="true" className="text-sm text-neutral-700">
      <Trans>正在读取全局录制默认值…</Trans>
    </p>
  );
}

/* ── the form ────────────────────────────────────────────────────────────── */

function ShotForm({
  shot,
  defaults,
  onEdit,
  i18n,
}: {
  readonly shot: RecordingRequest;
  readonly defaults: RecordingDefaults;
  readonly onEdit: (patch: Partial<RecordingRequest>) => void;
  readonly i18n: ReturnType<typeof useLingui>['i18n'];
}) {
  const resolved = resolveShotPresentation(shot.presentation, defaults);
  const presentation = resolved.value;
  const fields = presentationFieldsFor(shot.camera_style);
  const view = shotViewOf(shot);
  const flashPercent = flashAlphaToPercent(presentation.flash_alpha);

  const editPresentation = (change: Parameters<typeof patchPresentation>[1]) => {
    onEdit(patchPresentation(shot, change, defaults));
  };

  return (
    <>
      <Field label={<Trans>镜头类型</Trans>} hint={i18n._(CAMERA_STYLE[shot.camera_style].hint)}>
        {(control) => (
          <select
            {...control}
            data-shot-style="true"
            value={shot.camera_style}
            onChange={(event) =>
              onEdit(
                patchCameraStyle(shot, event.target.value as RecordingRequest['camera_style'], defaults),
              )
            }
            className="h-[var(--h-ctl-md)] w-full border border-divider bg-bg px-2.5 text-sm"
          >
            {CAMERA_STYLES.map((style) => (
              <option key={style} value={style}>
                {i18n._(CAMERA_STYLE[style].label)}
              </option>
            ))}
          </select>
        )}
      </Field>

      {/* Not wrapped in `Field`: a `Field` label is a `<label for>` and a radio
          group has no single control to point at. `Seg` names itself. */}
      <div className="flex flex-col">
        <span className="mb-[calc(var(--spacing)*1.5)] text-xs leading-normal text-neutral-700">
          <Trans>视角</Trans>
        </span>
        <Seg
          name={`shot-view-${shot.id}`}
          fill
          aria-label={t`视角`}
          value={view}
          onChange={(next) => onEdit(patchShotView(shot, next, defaults))}
          options={SHOT_VIEWS.map((option) => ({
            value: option,
            label: i18n._(SHOT_VIEW[option]),
          }))}
        />
      </div>

      <div className="flex gap-2.5">
        <Field className="flex-1" label={<Trans>前留白</Trans>}>
          {(control) => (
            <InputGroup>
              <InputGroupInput
                {...control}
                type="number"
                className="font-mono"
                step={0.1}
                min={0}
                value={String(shot.pre_roll_seconds)}
                onChange={(event) =>
                  onEdit({ pre_roll_seconds: readSeconds(event.target.value, shot.pre_roll_seconds) })
                }
              />
              <InputGroupAddon align="inline-end">
                <Trans>秒</Trans>
              </InputGroupAddon>
            </InputGroup>
          )}
        </Field>
        <Field className="flex-1" label={<Trans>后留白</Trans>}>
          {(control) => (
            <InputGroup>
              <InputGroupInput
                {...control}
                type="number"
                className="font-mono"
                step={0.1}
                min={0}
                value={String(shot.post_roll_seconds)}
                onChange={(event) =>
                  onEdit({
                    post_roll_seconds: readSeconds(event.target.value, shot.post_roll_seconds),
                  })
                }
              />
              <InputGroupAddon align="inline-end">
                <Trans>秒</Trans>
              </InputGroupAddon>
            </InputGroup>
          )}
        </Field>
      </div>

      <section className="flex flex-col gap-3 border-t border-divider pt-3.5">
        <header className="flex items-baseline justify-between gap-2">
          <h3 className="font-heading text-2xs tracking-caps text-neutral-600">
            <Trans>画面</Trans>
          </h3>
          <InheritanceNote overridden={resolved.overridden} onDetachBack={() => onEdit(detachedPresentationPatch())} />
        </header>

        <SliderRow
          label={t`视野 FOV`}
          value={presentation.camera_fov}
          min={CAMERA_FOV_RANGE.min}
          max={CAMERA_FOV_RANGE.max}
          reading={String(Math.round(presentation.camera_fov))}
          state={fields.camera_fov}
          probe="camera-fov"
          onChange={(value) => editPresentation({ camera_fov: value })}
          i18n={i18n}
        />
        <SliderRow
          label={t`持枪视野`}
          value={presentation.viewmodel_fov}
          min={VIEWMODEL_FOV_RANGE.min}
          max={VIEWMODEL_FOV_RANGE.max}
          reading={String(Math.round(presentation.viewmodel_fov))}
          state={fields.viewmodel_fov}
          probe="viewmodel-fov"
          onChange={(value) => editPresentation({ viewmodel_fov: value })}
          i18n={i18n}
        />
        <SliderRow
          label={t`闪光强度`}
          value={flashPercent}
          min={0}
          max={100}
          reading={`${flashPercent}%`}
          state={fields.flash_alpha}
          probe="flash-alpha"
          onChange={(value) => editPresentation({ flash_alpha: percentToFlashAlpha(value) })}
          i18n={i18n}
        />
        <p className="text-2xs leading-normal text-neutral-600">
          <Trans>闪光强度是画面上还剩多少闪光：100% 是完整的闪光弹，0% 是完全不闪。</Trans>
        </p>
      </section>

      <section className="flex flex-col gap-2.5 border-t border-divider pt-3.5">
        <h3 className="font-heading text-2xs tracking-caps text-neutral-600">
          <Trans>画面元素</Trans>
        </h3>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>
            <Trans>HUD</Trans>
          </span>
          <Toggle
            checked={presentation.show_hud}
            aria-label={t`HUD`}
            onChange={(checked) => editPresentation({ show_hud: checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>
            <Trans>雷达</Trans>
          </span>
          <Toggle
            checked={presentation.show_radar}
            aria-label={t`雷达`}
            onChange={(checked) => editPresentation({ show_radar: checked })}
          />
        </label>
        {/*
          队内语音 is a three-member enum on the wire, not a switch. A toggle
          would either hide `target_only` — 「只留目标选手」, which is what a
          single-player highlight usually wants — or pick it silently.
        */}
        <div className="flex flex-col">
          <span className="mb-[calc(var(--spacing)*1.5)] text-xs leading-normal text-neutral-700">
            <Trans>队内语音</Trans>
          </span>
          <Seg
            name={`shot-voice-${shot.id}`}
            fill
            size="sm"
            aria-label={t`队内语音`}
            value={presentation.voice}
            onChange={(next) => editPresentation({ voice: next })}
            options={VOICE_POLICIES.map((policy) => ({
              value: policy,
              label: i18n._(VOICE_POLICY[policy]),
            }))}
          />
        </div>
      </section>
    </>
  );
}

/** 跟随全局默认 vs 这个片段自己的设置 — the distinction `presentation: null`
 *  exists to carry. */
function InheritanceNote({
  overridden,
  onDetachBack,
}: {
  readonly overridden: boolean;
  readonly onDetachBack: () => void;
}) {
  if (!overridden) {
    return (
      <span className="text-2xs text-neutral-600" data-presentation="inherited">
        <Trans>跟随全局默认</Trans>
      </span>
    );
  }
  return (
    <Button variant="ghost" size="sm" data-presentation="overridden" onClick={onDetachBack}>
      <Trans>改回全局默认</Trans>
    </Button>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  reading,
  state,
  probe,
  onChange,
  i18n,
}: {
  /** Plain text, not a node: it is the control's accessible name as well as its
   *  printed label, and the two must be the same words. */
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly reading: string;
  readonly state: ReturnType<typeof presentationFieldsFor>[keyof ReturnType<typeof presentationFieldsFor>];
  readonly probe: string;
  readonly onChange: (value: number) => void;
  readonly i18n: ReturnType<typeof useLingui>['i18n'];
}) {
  const reason = state.disabledReason === undefined ? null : i18n._(state.disabledReason);

  return (
    <div data-presentation-field={probe} data-editable={state.editable}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="font-mono">{reading}</span>
      </div>
      <Slider
        className="mt-1.5"
        value={value}
        min={min}
        max={max}
        disabled={!state.editable}
        aria-label={label}
        valueText={reading}
        onChange={onChange}
      />
      {reason === null ? null : (
        <p className="mt-1 text-2xs leading-normal text-neutral-600" data-disabled-reason="true">
          {reason}
        </p>
      )}
    </div>
  );
}

/* ── 在游戏里预览 ────────────────────────────────────────────────────────── */

function InGamePreview({ camera }: { readonly camera: CameraDesk }) {
  const [confirming, setConfirming] = useState(false);
  const shell = useNativeShell();
  const shellAction = useNativeShellAction();
  const failure = dataErrorMessage(camera.inGame.error);
  const bundle = camera.inGame.bundle;

  return (
    <section className="flex flex-col gap-2 border-t border-divider pt-3.5">
      <h3 className="font-heading text-2xs tracking-caps text-neutral-600">
        <Trans>在游戏里看这个镜头</Trans>
      </h3>
      <p className="text-2xs leading-normal text-neutral-600">
        <Trans>
          会把相机路径写成 HLAE 脚本落到磁盘，并启动 CS2 跳到这个镜头的起点。只是预览，不会录制任何画面。
        </Trans>
      </p>

      {camera.inGame.running ? (
        <Button
          variant="secondary"
          disabled={camera.inGame.stopAction.disabled}
          {...(camera.inGame.stopAction.disabledReason === undefined
            ? {}
            : { disabledReason: camera.inGame.stopAction.disabledReason })}
          onClick={camera.inGame.stop}
        >
          <Trans>停止预览</Trans>
        </Button>
      ) : (
        <Button
          variant="secondary"
          data-in-game-preview="true"
          disabled={camera.inGame.action.disabled}
          {...(camera.inGame.action.disabledReason === undefined
            ? {}
            : { disabledReason: camera.inGame.action.disabledReason })}
          onClick={() => setConfirming(true)}
        >
          <Trans>在游戏里预览</Trans>
        </Button>
      )}

      {camera.inGame.action.disabled && camera.inGame.action.disabledReason !== undefined ? (
        <p className="text-2xs leading-normal text-neutral-600">
          {camera.inGame.action.disabledReason}
        </p>
      ) : null}

      {camera.inGame.stage === 'writing' || camera.inGame.stage === 'launching' ? (
        <p role="status" aria-busy="true" className="text-2xs text-neutral-700">
          {camera.inGame.stage === 'writing' ? (
            <Trans>正在写出 HLAE 脚本…</Trans>
          ) : (
            <Trans>正在启动 CS2…</Trans>
          )}
        </p>
      ) : null}

      {bundle === null ? null : (
        <div className="border border-divider p-2" data-hlae-bundle="true">
          {/*
            The honest ending. `exportHlaeProposal` answers `launched: false` and
            `playDemo` starts plain CS2 — it does not go through HLAE's custom
            loader, so `mirv_*` does not exist in that process and the path is
            not on screen until this bundle's bootstrap is loaded by hand. The
            directory is therefore not a receipt, it is the rest of the action.
          */}
          <p className="text-2xs leading-normal text-neutral-700">
            <Trans>脚本已经写好，共 {bundle.files.length} 个文件。目录里的 README 说明怎么在 HLAE 里加载它；游戏不会自动加载。</Trans>
          </p>
          <p className="mt-1 break-all font-mono text-2xs text-neutral-600">{bundle.directory}</p>
          <Button
            className="mt-1.5"
            variant="ghost"
            size="sm"
            disabled={shellAction.buttonProps.disabled}
            {...(shellAction.buttonProps.disabledReason === undefined
              ? {}
              : { disabledReason: shellAction.buttonProps.disabledReason })}
            onClick={() => void shell.openDirectory(bundle.directory)}
          >
            <Trans>打开脚本目录</Trans>
          </Button>
        </div>
      )}

      {failure === null ? null : (
        <Alert
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: () => setConfirming(true) }}
          detail={<Trans>没有录制任何画面。</Trans>}
        >
          <Trans>没能在游戏里打开这个镜头：{failure}</Trans>
        </Alert>
      )}

      <Dialog
        open={confirming}
        title={<Trans>在游戏里预览这个镜头？</Trans>}
        confirmLabel={<Trans>启动游戏</Trans>}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          camera.inGame.launch();
        }}
      >
        <p>
          <Trans>相机路径会被写成一组 HLAE 脚本文件，CS2 会被启动并跳到这个镜头的起始 tick。</Trans>
        </p>
        <p className="mt-2">
          {/* Not glossed over: the service says `launched: false` and means it. */}
          <Trans>路径要在 HLAE 里加载这组脚本之后才会画出来，本地服务不会替你加载；启动后这里会给出脚本目录。</Trans>
        </p>
        <p className="mt-2">
          {/* The distinction that makes this dialog different from 开始录制 —
              stated, not implied. */}
          <Trans>这不是录制：不会采集任何画面，也不会产生输出。</Trans>
        </p>
      </Dialog>
    </section>
  );
}

/* ── 存为预设 / 应用到全部 ───────────────────────────────────────────────── */

function ShotActions({
  shot,
  defaults,
  plan,
  service,
}: {
  readonly shot: RecordingShot;
  readonly defaults: RecordingDefaults;
  readonly plan: RecordingBlockProps['plan'];
  readonly service: RecordingBlockProps['service'];
}) {
  const [savingPreset, setSavingPreset] = useState(false);
  const [applyingAll, setApplyingAll] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetsOpen, setPresetsOpen] = useState(false);

  const presets = useRecordingShotPresets({ enabled: presetsOpen && !service.blocked });
  const createPreset = useCreateRecordingShotPreset();
  const createFailure = dataErrorMessage(createPreset.error);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button
          variant="secondary"
          grow
          disabled={service.blocked}
          {...(service.buttonProps.disabledReason === undefined
            ? {}
            : { disabledReason: service.buttonProps.disabledReason })}
          onClick={() => {
            setPresetName('');
            setSavingPreset(true);
          }}
        >
          <Trans>存为预设</Trans>
          {service.suffix}
        </Button>
        <Button variant="secondary" grow onClick={() => setApplyingAll(true)}>
          <Trans>应用到全部</Trans>
        </Button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={presetsOpen}
        onClick={() => setPresetsOpen((open) => !open)}
      >
        {presetsOpen ? <Trans>收起预设</Trans> : <Trans>从预设应用</Trans>}
      </Button>

      {presetsOpen ? (
        <PresetList
          presets={presets}
          onApply={(preset) => plan.editShot(shot.id, presetPatch(preset))}
        />
      ) : null}

      {createFailure === null ? null : (
        <Alert
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: () => setSavingPreset(true) }}
        >
          <Trans>没能保存预设：{createFailure}</Trans>
        </Alert>
      )}

      <Dialog
        open={savingPreset}
        title={<Trans>存为预设</Trans>}
        confirmLabel={<Trans>保存</Trans>}
        confirmDisabled={presetName.trim() === '' || createPreset.isPending}
        onClose={() => setSavingPreset(false)}
        onConfirm={() => {
          setSavingPreset(false);
          createPreset.mutate(presetDraftFromShot(shot, presetName.trim(), defaults));
        }}
      >
        <Field label={<Trans>预设名称</Trans>}>
          {(control) => (
            <Input
              {...control}
              value={presetName}
              placeholder={t`我的 POV 参数`}
              onChange={(event) => setPresetName(event.target.value)}
            />
          )}
        </Field>
        <p className="mt-2 text-xs text-neutral-700">
          <Trans>包含视野、HUD、雷达、语音与前后留白，应用时作为一次原子变更。</Trans>
        </p>
        <p className="mt-1 text-xs text-neutral-600">
          {/* Said out loud because it is what makes 应用到全部 safe. */}
          <Trans>预设不包含 Demo、选手与 tick 区间，套用它不会改变录的是哪一段。</Trans>
        </p>
      </Dialog>

      <Dialog
        open={applyingAll}
        title={<Trans>把这个片段的参数应用到全部？</Trans>}
        confirmLabel={<Trans>应用到全部</Trans>}
        onClose={() => setApplyingAll(false)}
        onConfirm={() => {
          setApplyingAll(false);
          plan.editEveryShot(applyToAllPatch(shot, defaults));
        }}
      >
        <p>
          <Trans>
            {plan.items.length} 个片段的镜头类型、视角、前后留白与画面参数都会变成这个片段的设置。
          </Trans>
        </p>
        <p className="mt-2">
          <Trans>Demo、选手与 tick 区间不会被改动。改完之后需要重新生成预览计划。</Trans>
        </p>
      </Dialog>
    </div>
  );
}

function PresetList({
  presets,
  onApply,
}: {
  readonly presets: ReturnType<typeof useRecordingShotPresets>;
  readonly onApply: (preset: RecordingShotPreset) => void;
}) {
  const failure = dataErrorMessage(presets.error);
  if (failure !== null) {
    return (
      <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void presets.refetch() }}>
        <Trans>读不到预设：{failure}</Trans>
      </Alert>
    );
  }
  if (presets.isPending) {
    return (
      <p role="status" aria-busy="true" className="text-2xs text-neutral-600">
        <Trans>正在读取预设…</Trans>
      </p>
    );
  }
  /* `listRecordingShotPresets` answers `{ items }`, not a bare array. */
  const items: readonly RecordingShotPreset[] = presets.data?.items ?? [];
  if (items.length === 0) {
    return (
      <p className="text-2xs text-neutral-600">
        <Trans>还没有保存过预设。</Trans>
      </p>
    );
  }
  return (
    <ul className="flex list-none flex-col" data-shot-presets={items.length}>
      {items.map((preset) => (
        <li key={preset.id} className="border-t border-divider py-1.5">
          <Button variant="ghost" size="sm" block onClick={() => onApply(preset)}>
            {preset.name}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** A seconds field that refuses to turn a half-typed value into `NaN`. */
function readSeconds(raw: string, fallback: number): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}
