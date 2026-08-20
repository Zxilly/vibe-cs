/*
 * pages/evidence — the condition strip of 「05 证据检索」.
 *
 * The artboard draws it as two rows on the `--color-surface` plane under the
 * top bar:
 *
 *   row 1  a segmented control, a wide search box with a magnifier, 「检索」
 *   row 2  「条件」 then the active conditions as accent chips, the ones you can
 *          still add as outline 「＋ …」 chips, and — flush right —
 *          「命中 47 条 · 排序：时间倒序」
 *
 * Two decisions worth stating.
 *
 * **The chips are the form.** There is no filter drawer and no second dialog:
 * clicking 「＋ 地图」 turns that chip into a small field, typing and pressing
 * Enter turns it back into an accent chip, and clicking an accent chip removes
 * it. Every one of those commits to the URL (§4.4), so the chip row and the
 * address bar are the same state seen twice.
 *
 * **A condition the index cannot serve is disabled, not hidden.** The response's
 * `availability` block says which filters this index can apply
 * (`data/evidence.ts`, `unsupportedEvidenceFilters`); when 「近 30 天」 is one of
 * the unusable ones the chip stays on the strip, disabled, with the service's
 * own reason attached — the shell's degradation rule (「不隐藏、不静默失败」)
 * applies to a filter as much as to a button.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Search, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';

import { Badge, Button, Input, InputGroup, InputGroupAddon, InputGroupInput, Seg, type SegOption } from '../../design/primitives';
import {
  EVIDENCE_FAMILIES,
  RECENT_WINDOW_DAYS,
  activeConditions,
  withoutCondition,
  type EvidenceCondition,
  type EvidenceFamily,
  type EvidenceSearchState,
} from './evidenceSearchParams';

/* ── labels ──────────────────────────────────────────────────────────────── */

function familyLabel(family: EvidenceFamily): ReactNode {
  switch (family) {
    case 'all':
      return <Trans>全部</Trans>;
    case 'kill':
      return <Trans>击杀</Trans>;
    case 'multi_kill':
      return <Trans>多杀</Trans>;
    case 'objective':
      return <Trans>目标事件</Trans>;
    case 'round_start':
      /* Not 「回合」: `domain/match`'s evidence kind already owns that word, and
         this member filters *round-start* rows specifically. */
      return <Trans>回合开始</Trans>;
  }
}

/** The three chips that hold free text. Kept apart from the boolean and the
 *  date chip because only these three open an input. */
const TEXT_FIELDS = ['player', 'map', 'weapon'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

function textFieldLabel(field: TextField): ReactNode {
  switch (field) {
    case 'player':
      return <Trans>选手</Trans>;
    case 'map':
      return <Trans>地图</Trans>;
    case 'weapon':
      return <Trans>武器</Trans>;
  }
}

function textFieldName(field: TextField): string {
  switch (field) {
    case 'player':
      return t`选手`;
    case 'map':
      return t`地图`;
    case 'weapon':
      return t`武器`;
  }
}

function conditionLabel(condition: EvidenceCondition): ReactNode {
  switch (condition.field) {
    case 'family':
      return <Trans>种类：{familyLabel(condition.value as EvidenceFamily)}</Trans>;
    case 'q':
      return <Trans>关键词：{condition.value}</Trans>;
    case 'player':
      return <Trans>选手：{condition.value}</Trans>;
    case 'map':
      return <Trans>地图：{condition.value}</Trans>;
    case 'weapon':
      return <Trans>武器：{condition.value}</Trans>;
    case 'headshot':
      return <Trans>仅爆头</Trans>;
    case 'from':
      return <Trans>不早于 {condition.value}</Trans>;
    case 'to':
      return <Trans>不晚于 {condition.value}</Trans>;
  }
}

/* ── props ───────────────────────────────────────────────────────────────── */

export interface EvidenceConditionsProps {
  readonly state: EvidenceSearchState;
  /** Commits a new state. The page is what writes it to the URL. */
  readonly onChange: (next: EvidenceSearchState) => void;
  /** 「命中 47 条 · 排序：时间倒序」, flush right. */
  readonly summary?: ReactNode | undefined;
  /** `from` for the 「近 30 天」 chip, computed by the page so this stays pure
   *  of `Date.now()` and the interaction test can pin the value. */
  readonly recentFrom: string;
  /** Why the date filter is unavailable, when the index says it is. */
  readonly dateDisabledReason?: string | undefined;
}

export function EvidenceConditions({
  state,
  onChange,
  summary,
  recentFrom,
  dateDisabledReason,
}: EvidenceConditionsProps) {
  /* The only local state on this page. The typed-but-not-submitted query is
     genuinely not shared — it has no meaning until 「检索」 — and putting every
     keystroke in the URL would fill the back stack with half-words. */
  const [draft, setDraft] = useState(state.q);
  const [editing, setEditing] = useState<TextField | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const conditions = activeConditions(state);
  const familyOptions: readonly SegOption<EvidenceFamily>[] = EVIDENCE_FAMILIES.map((family) => ({
    value: family,
    label: familyLabel(family),
  }));

  /* A condition change always returns to page 1 and drops the selected row:
     the row the Inspector was showing may not be in the new result set, and an
     Inspector describing something the table no longer lists is a lie. */
  const commit = (next: EvidenceSearchState) => {
    onChange({ ...next, page: 1, evidenceId: '' });
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    commit({ ...state, q: draft.trim() });
  };

  const openField = (field: TextField) => {
    setEditing(field);
    setEditingValue(state[field]);
  };

  const commitField = (field: TextField) => {
    setEditing(null);
    const value = editingValue.trim();
    if (value === state[field]) return;
    commit({ ...state, [field]: value });
  };

  return (
    <div
      data-evidence-conditions=""
      className="flex flex-col"
    >
      <form
        data-evidence-search-bar=""
        className="flex h-[var(--h-bar)] flex-none items-center gap-2.5 overflow-x-auto overscroll-x-contain border-b border-divider bg-surface-chrome px-7"
        onSubmit={submitSearch}
      >
        <Seg
          name="evidence-family"
          value={state.family}
          options={familyOptions}
          onChange={(family) => commit({ ...state, family })}
          aria-label={t`证据种类`}
        />
        <div className="min-w-0 flex-1">
          <InputGroup ground="bg">
            <InputGroupAddon>
              <Search strokeWidth={1.5} />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={t`检索证据`}
              placeholder={t`Kael 的穿墙击杀`}
            />
          </InputGroup>
        </div>
        <Button type="submit" variant="primary">
          <Trans>检索</Trans>
        </Button>
      </form>

      <div
        data-evidence-condition-bar=""
        className="flex h-[var(--h-bar)] flex-none items-center gap-2 overflow-x-auto overscroll-x-contain border-b border-divider bg-surface-chrome px-7"
      >
        <span className="text-2xs text-neutral-600">
          <Trans>条件</Trans>
        </span>

        {conditions.map((condition) => (
          <Badge
            key={condition.field}
            asChild
            variant="accent"
            data-condition={condition.field}
            aria-label={t`移除条件`}
            onClick={() => onChange(withoutCondition(state, condition.field))}
            className="gap-1.5"
          >
            <button type="button">
              {conditionLabel(condition)}
              <X size={11} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </Badge>
        ))}

        {TEXT_FIELDS.filter((field) => state[field] === '').map((field) =>
          editing === field ? (
            <span key={field} className="inline-flex w-40 flex-none items-center">
              <Input
                autoFocus
                ground="bg"
                value={editingValue}
                aria-label={textFieldName(field)}
                data-condition-input={field}
                onChange={(event) => setEditingValue(event.target.value)}
                onBlur={() => commitField(field)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitField(field);
                  }
                  if (event.key === 'Escape') setEditing(null);
                }}
              />
            </span>
          ) : (
            <Badge
              key={field}
              asChild
              variant="outline"
              data-condition-add={field}
              onClick={() => openField(field)}
            >
              <button type="button">
                <Trans>＋ {textFieldLabel(field)}</Trans>
              </button>
            </Badge>
          ),
        )}

        {state.headshot ? null : (
          <Badge
            asChild
            variant="outline"
            data-condition-add="headshot"
            onClick={() => commit({ ...state, headshot: true })}
          >
            <button type="button">
              <Trans>＋ 仅爆头</Trans>
            </button>
          </Badge>
        )}

        {state.from === '' ? (
          <Badge
            asChild
            variant="outline"
            data-condition-add="from"
            {...(dateDisabledReason === undefined
              ? {}
              : {
                  disabled: true,
                  title: dateDisabledReason,
                  className: 'cursor-not-allowed opacity-45',
                })}
            onClick={() => commit({ ...state, from: recentFrom })}
          >
            <button type="button">
              <Trans>＋ 近 {RECENT_WINDOW_DAYS} 天</Trans>
            </button>
          </Badge>
        ) : null}

        <div className="flex-1" aria-hidden="true" />

        {summary === undefined ? null : (
          <span data-evidence-summary="" className="flex-none whitespace-nowrap text-sm text-neutral-700">
            {summary}
          </span>
        )}
      </div>
    </div>
  );
}
