/*
 * pages/montage — block C, 包装.
 *
 * 主题 / 片头 / 选手名牌 / 情景标签 / 片尾 / 片段转场, as the artboard's right
 * column draws them. Three of those six needed a decision:
 *
 * **主题 has four members, the artboard draws three.** The wire set is
 * `vibe | broadcast | minimal | neon` and the board shows 线框 / 极简 / 转播.
 * Built from the wire (`MONTAGE_THEME` in the contract labels all four),
 * because a project already stored as `neon` has to render as something other
 * than a raw identifier, and a fourth option that exists on the server and not
 * in the UI is a setting the user can reach but not undo. Recorded as a
 * deviation from the board.
 *
 * **情景标签（回合 / 类型）is omitted.** `MontageSettingsRecord` has no field
 * for it — it carries `include_name_cards`, the two title cards, the theme, the
 * transition and the encode settings, and nothing that would switch a
 * round/kind tag on. An always-off toggle would be a control that does nothing,
 * which is worse than an absent one. Recorded as a backend gap.
 *
 * **片头 / 片尾 are a duration *and* a title.** `intro_duration_seconds > 0`
 * with an empty `intro_title` is rejected by the renderer at export time
 * (`crates/media/src/plan.rs`), so the toggle writes both: on gives it three
 * seconds — the artboard's 「片头（3 秒）」 — and seeds the title from the
 * project name; off writes a zero duration and leaves the title alone so
 * turning it back on restores what was typed.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Skeleton } from '../../design/data';
import { Field, Input, Toggle, cn } from '../../design/primitives';
import type { MontageBrandingTheme } from '../../shared/desktop/dto';
import { MONTAGE_THEME, type MontageBlockProps } from './montageContract';
import {
  MONTAGE_TITLE_CARD_SECONDS,
  MONTAGE_TRANSITIONS,
  MONTAGE_TRANSITION_LABEL,
  editAllTransitions,
  editMontageSettings,
  normaliseTransition,
  sharedTransition,
  type MontageTransition,
} from './montageSettings';

const THEMES = Object.keys(MONTAGE_THEME) as readonly MontageBrandingTheme[];

/** Same native `<select>` the Agent shot form uses, for the same reason: the
 *  design system has no listbox and ten transitions do not fit a `Seg`. */
const SELECT_CLASS =
  'w-full min-w-0 border border-divider bg-bg px-2 text-sm leading-normal text-text ' +
  'h-[var(--h-ctl-md)] focus:border-accent disabled:opacity-45';

export function PackagingBlock({ project: desk, service }: MontageBlockProps) {
  const { i18n } = useLingui();
  const project = desk.project;
  const writable = !service.blocked && project !== null && !desk.saving;

  if (project === null) {
    return (
      <section data-montage-block="packaging" className="flex flex-col gap-3 p-4">
        <PanelHeading />
        <Skeleton width="100%" />
        <Skeleton width="72%" />
        <Skeleton width="86%" />
        <p className="sr-only" role="status" aria-busy="true">
          <Trans>正在读取包装设置</Trans>
        </p>
      </section>
    );
  }

  const { settings } = project;
  const transition = sharedTransition(project);
  const unknownTransition = project.clips.some((clip) => normaliseTransition(clip.transition) === null);

  return (
    <section data-montage-block="packaging" className="flex flex-col">
      <PanelHeading />
      <div className="flex flex-col gap-4 p-4">
        <Field label={<Trans>主题</Trans>}>
          <div className="flex gap-2" role="radiogroup" aria-label={t`合辑主题`}>
            {THEMES.map((theme) => (
              <button
                key={theme}
                type="button"
                role="radio"
                aria-checked={settings.branding_theme === theme}
                data-montage-theme={theme}
                disabled={!writable}
                onClick={() => desk.save(editMontageSettings({ branding_theme: theme }))}
                className={cn(
                  'flex h-12 flex-1 items-center justify-center border text-sm',
                  'focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
                  'disabled:opacity-45',
                  settings.branding_theme === theme ? 'border-accent bg-accent-100' : 'border-divider',
                )}
              >
                {i18n._(MONTAGE_THEME[theme])}
              </button>
            ))}
          </div>
        </Field>

        <TitleCardRow
          id="intro"
          label={<Trans>片头</Trans>}
          seconds={settings.intro_duration_seconds}
          title={settings.intro_title}
          writable={writable}
          onToggle={(on) =>
            desk.save(
              editMontageSettings({
                intro_duration_seconds: on ? MONTAGE_TITLE_CARD_SECONDS : 0,
                ...(on && (settings.intro_title ?? '').trim() === ''
                  ? { intro_title: project.name }
                  : {}),
              }),
            )
          }
          onTitle={(value) => desk.save(editMontageSettings({ intro_title: value }))}
        />

        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            <Trans>选手名牌</Trans>
          </span>
          <Toggle
            checked={settings.include_name_cards}
            disabled={!writable}
            data-montage-toggle="name-cards"
            onChange={(checked) => desk.save(editMontageSettings({ include_name_cards: checked }))}
          />
        </label>

        <TitleCardRow
          id="outro"
          label={<Trans>片尾</Trans>}
          seconds={settings.outro_duration_seconds}
          title={settings.outro_title}
          writable={writable}
          onToggle={(on) =>
            desk.save(
              editMontageSettings({
                outro_duration_seconds: on ? MONTAGE_TITLE_CARD_SECONDS : 0,
                ...(on && (settings.outro_title ?? '').trim() === ''
                  ? { outro_title: project.name }
                  : {}),
              }),
            )
          }
          onTitle={(value) => desk.save(editMontageSettings({ outro_title: value }))}
        />

        <Field
          label={<Trans>片段转场</Trans>}
          hint={
            transition === null && !unknownTransition ? (
              <Trans>各片段的转场不一致，选择后会统一。</Trans>
            ) : unknownTransition ? (
              <Trans>有片段的转场渲染器不认识，选择后会统一。</Trans>
            ) : undefined
          }
        >
          {(control) => (
            <select
              {...control}
              data-montage-field="transition"
              disabled={!writable}
              value={transition ?? ''}
              onChange={(event) =>
                desk.save(editAllTransitions(event.target.value as MontageTransition))
              }
              className={SELECT_CLASS}
            >
              {transition === null ? <option value=""> </option> : null}
              {MONTAGE_TRANSITIONS.map((kind) => (
                <option key={kind} value={kind}>
                  {i18n._(MONTAGE_TRANSITION_LABEL[kind])}
                </option>
              ))}
            </select>
          )}
        </Field>

        {transition === 'cut' || transition === null ? null : (
          <Field
            label={<Trans>转场时长（秒）</Trans>}
            hint={<Trans>0.05 到 5 秒；转场比相邻片段还长时渲染会拒绝。</Trans>}
          >
            {(control) => (
              <Input
                {...control}
                mono
                inputMode="decimal"
                data-montage-field="transition-seconds"
                disabled={!writable}
                defaultValue={String(settings.transition_seconds)}
                onBlur={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value) || value < 0.05 || value > 5) return;
                  if (value === settings.transition_seconds) return;
                  desk.save(editMontageSettings({ transition_seconds: value }));
                }}
              />
            )}
          </Field>
        )}
      </div>
    </section>
  );
}

function PanelHeading() {
  return (
    <h3
      className="flex h-[var(--h-panel-head)] flex-none items-center border-b border-divider px-4 font-heading tracking-caps"
      style={{ fontSize: 'var(--text-sm)' }}
    >
      <Trans>包装</Trans>
    </h3>
  );
}

/**
 * 「片头（3 秒）」 — the toggle and, once it is on, the title the renderer
 * demands. The two are one row because they are one setting: a title card with
 * no title is a validation error, not a half-configured feature.
 */
function TitleCardRow({
  id,
  label,
  seconds,
  title,
  writable,
  onToggle,
  onTitle,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly seconds: number;
  readonly title: string | null;
  readonly writable: boolean;
  readonly onToggle: (on: boolean) => void;
  readonly onTitle: (value: string) => void;
}) {
  const on = seconds > 0;
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          {label}
          {on ? (
            <span className="ml-1 text-neutral-600">
              <Trans>（{seconds} 秒）</Trans>
            </span>
          ) : null}
        </span>
        <Toggle
          checked={on}
          disabled={!writable}
          data-montage-toggle={id}
          onChange={onToggle}
        />
      </label>
      {on ? (
        <Input
          mono={false}
          disabled={!writable}
          data-montage-field={`${id}-title`}
          aria-label={t`标题`}
          defaultValue={title ?? ''}
          maxLength={200}
          onBlur={(event) => {
            if (event.target.value === (title ?? '')) return;
            onTitle(event.target.value);
          }}
        />
      ) : null}
      {on && (title ?? '').trim() === '' ? (
        <p className="text-xs text-fail-text">
          <Trans>标题为空时渲染会拒绝这份工程。</Trans>
        </p>
      ) : null}
    </div>
  );
}

/* A last, deliberate absence: there is no 情景标签 toggle, and no 保存 button.
 * The first has no wire field (see the header); the second has nothing to do,
 * because every control above writes through the moment it changes. */
