/*
 * pages/agent — 「补齐 · 手动编辑与编辑感知」's edit card (§4.5.3 rule ②).
 *
 * The artboard draws it as the selected shot's card, opened in place: a 2px
 * accent frame, the title inline-editable at the top with the 「你改过」 badge
 * beside it, one row of fields, the intent paragraph, and a footer that says
 * 「改动会记入方案修订，并通知 Agent」.
 *
 * ── What is deliberately not on this card ─────────────────────────────────
 *
 * **No approval, no review, no 「等待确认」.** §4.5.3 ② is a *design* rule before
 * it is a code rule, and the way a form keeps it is by not having the control:
 * there is 放弃 and there is 保存改动, and 保存改动 saves. `shotEditForm.test.tsx`
 * asserts the absence, because an absence is the kind of thing that gets added
 * back by accident.
 *
 * **No 「时长会自动改 tick」.** The plan carries no tick rate, so 时长 and the two
 * tick fields are independent inputs and the user moves whichever they mean. The
 * alternative — deriving one from the other at 64 or at 128 — writes a guess
 * into a field the recorder will obey. The hint under 时长 says so out loud
 * rather than leaving the reader to discover it.
 *
 * ── The keyboard ─────────────────────────────────────────────────────────
 *
 * 「Esc 放弃 · ⌘↵ 保存」 is printed on the artboard, so it is implemented: Escape
 * cancels and Meta/Ctrl+Enter saves, both from anywhere inside the card. The
 * form is a real `<form>`, so Enter in a text field submits it too — which is
 * the behaviour a browser already promises and that a `<div>` with buttons
 * quietly breaks.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { KeyboardEvent } from 'react';

import { Button, Field, Seg, TextInput, cx } from '../../design/primitives';
import {
  AGENT_PLAN_AUTHOR,
  AGENT_SHOT_KIND,
  AGENT_SHOT_KINDS,
  AGENT_SHOT_VIEW,
  AGENT_SHOT_VIEWS,
  formatShotDuration,
} from '../../domain/agent';
import type { AgentShotKind } from '../../domain/agent';
import type { AgentPlanShot, AgentShotView } from '../../shared/desktop/dto';

import {
  draftIsValid,
  validateShotDraft,
  type ShotDraft,
} from './planEditModel';

export interface ShotEditFormProps {
  readonly shot: AgentPlanShot;
  /** One-based position — the 「02」 the artboard prints beside the title. */
  readonly index: number;
  readonly draft: ShotDraft;
  readonly onChange: (draft: ShotDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  /** `props.edit` from the shell: no session, or no service. */
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * The select for 镜头类型. Seven members (`domain/agent/types.ts` explains why
 * seven and not §4.5.2's five) is past what a `Seg` can carry in a 440px
 * inspector, and the design system has no listbox, so this is a native
 * `<select>` wearing the same height and type step as every other control.
 */
const SELECT_CLASS =
  'w-full min-w-0 border border-divider bg-bg px-2 text-sm leading-normal text-text ' +
  'h-[var(--h-ctl-sm)] focus:border-accent disabled:opacity-45';

const TEXTAREA_CLASS =
  'w-full min-w-0 resize-y border border-divider px-3 py-2 text-sm leading-normal caret-accent ' +
  'placeholder:text-neutral-600 focus:border-accent disabled:opacity-45';

export function ShotEditForm({
  shot,
  index,
  draft,
  onChange,
  onSave,
  onCancel,
  disabled = false,
  disabledReason,
  className,
}: ShotEditFormProps) {
  const { i18n } = useLingui();

  const errors = validateShotDraft(draft);
  const valid = draftIsValid(draft);
  const author = AGENT_PLAN_AUTHOR[shot.source];
  const number = String(index).padStart(2, '0');

  /* The artboard strikes the previous duration through beside the new one. It
     appears only once the value actually moved, so the field is not permanently
     carrying a second number. */
  const previousDuration =
    draft.duration.trim() === String(shot.duration_seconds)
      ? null
      : formatShotDuration(shot.duration_seconds);

  const saveBlocked = disabled || !valid;
  const saveReason = disabled ? disabledReason : valid ? undefined : t`还有字段填得不对`;

  const patch = (part: Partial<ShotDraft>) => {
    onChange({ ...draft, ...part });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!saveBlocked) onSave();
    }
  };

  return (
    <form
      data-shot-edit={shot.id}
      aria-label={t`编辑镜头 ${number}`}
      className={cx('flex flex-col gap-3 border-2 border-accent p-3.5', className)}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        if (!saveBlocked) onSave();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-none font-mono text-xs text-neutral-600">{number}</span>
        <TextInput
          value={draft.title}
          onChange={(event) => {
            patch({ title: event.target.value });
          }}
          disabled={disabled}
          aria-label={t`镜头标题`}
          invalid={errors.title !== undefined}
          className="min-w-0 flex-1"
        />
        <span className="flex-none border border-accent px-2 py-0.5 text-2xs text-accent-800">
          {i18n._(author.sourceBadge)}
        </span>
      </div>
      {errors.title === undefined ? null : (
        <p role="alert" className="text-xs text-fail-text">
          {i18n._(errors.title)}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <Field label={<Trans>镜头类型</Trans>} className="w-40">
          {(control) => (
            <select
              {...control}
              className={SELECT_CLASS}
              disabled={disabled}
              value={draft.kind}
              onChange={(event) => {
                patch({ kind: event.target.value as AgentShotKind });
              }}
            >
              {AGENT_SHOT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {AGENT_SHOT_KIND[kind].code} · {i18n._(AGENT_SHOT_KIND[kind].label)}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          label={<Trans>时长</Trans>}
          className="w-32"
          hint={<Trans>tick 区间不会跟着动</Trans>}
          {...(errors.duration === undefined ? {} : { error: i18n._(errors.duration) })}
        >
          {(control) => (
            <TextInput
              {...control}
              mono
              inputMode="decimal"
              disabled={disabled}
              value={draft.duration}
              invalid={errors.duration !== undefined}
              onChange={(event) => {
                patch({ duration: event.target.value });
              }}
              {...(previousDuration === null
                ? {}
                : { trailing: <s className="font-mono text-2xs">{previousDuration}</s> })}
            />
          )}
        </Field>

        <Field
          label={<Trans>起始 tick</Trans>}
          className="w-32"
          {...(errors.startTick === undefined ? {} : { error: i18n._(errors.startTick) })}
        >
          {(control) => (
            <TextInput
              {...control}
              mono
              inputMode="numeric"
              disabled={disabled}
              value={draft.startTick}
              invalid={errors.startTick !== undefined}
              onChange={(event) => {
                patch({ startTick: event.target.value });
              }}
            />
          )}
        </Field>

        <Field
          label={<Trans>结束 tick</Trans>}
          className="w-32"
          {...(errors.endTick === undefined ? {} : { error: i18n._(errors.endTick) })}
        >
          {(control) => (
            <TextInput
              {...control}
              mono
              inputMode="numeric"
              disabled={disabled}
              value={draft.endTick}
              invalid={errors.endTick !== undefined}
              onChange={(event) => {
                patch({ endTick: event.target.value });
              }}
            />
          )}
        </Field>

        <div className="flex min-w-0 flex-1 flex-col justify-end">
          <Seg
            name={`shot-view-${shot.id}`}
            aria-label={t`视角`}
            value={draft.view}
            fill
            options={AGENT_SHOT_VIEWS.map((view) => ({
              value: view,
              label: i18n._(AGENT_SHOT_VIEW[view].label),
              disabled,
            }))}
            onChange={(view: AgentShotView) => {
              patch({ view });
            }}
          />
        </div>
      </div>

      <Field label={<Trans>镜头意图 · 会一起发给 Agent</Trans>}>
        {(control) => (
          <textarea
            {...control}
            rows={3}
            className={TEXTAREA_CLASS}
            disabled={disabled}
            value={draft.rationale}
            onChange={(event) => {
              patch({ rationale: event.target.value });
            }}
          />
        )}
      </Field>

      <Field
        label={<Trans>这次改动的说明（可选）</Trans>}
        hint={<Trans>会作为通知的备注一起发给 Agent</Trans>}
      >
        {(control) => (
          <TextInput
            {...control}
            disabled={disabled}
            value={draft.note}
            onChange={(event) => {
              patch({ note: event.target.value });
            }}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-neutral-600">
          <Trans>改动会记入方案修订，并通知 Agent</Trans>
          {' · '}
          <Trans>Esc 放弃 · ⌘↵ 保存</Trans>
        </p>
        <Button size="sm" onClick={onCancel}>
          <Trans>放弃</Trans>
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={saveBlocked}
          {...(saveReason === undefined ? {} : { disabledReason: saveReason })}
        >
          <Trans>保存改动</Trans>
        </Button>
      </div>
    </form>
  );
}
