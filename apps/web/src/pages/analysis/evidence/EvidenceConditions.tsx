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
import { Plus, Search, X } from 'lucide-react';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Badge, Button, Input, InputGroup, InputGroupAddon, InputGroupInput, Seg, type SegOption } from '../../../design/primitives';
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

/** What the open field wants, in the spelling the index keys on: the three
 *  fields look identical once open, and 「地图」 could mean Mirage or de_mirage. */
function textFieldPlaceholder(field: TextField): string {
  switch (field) {
    case 'player':
      return t`选手昵称，Enter 确认`;
    case 'map':
      return t`地图，例如 de_mirage`;
    case 'weapon':
      return t`武器，例如 AK-47`;
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
  const conditionId = useId();
  /* The only local state on this page. The typed-but-not-submitted query is
     genuinely not shared — it has no meaning until 「检索」 — and putting every
     keystroke in the URL would fill the back stack with half-words.

     It is a draft *of* `state.q`, though, so when the address changes under it
     — the 关键词 chip removed, back / forward, a pasted link — the draft
     follows. Otherwise the box would keep showing a keyword the chip row and
     the results had already dropped, and the next 「检索」 would quietly put
     it back. */
  const [draft, setDraft] = useState(state.q);
  const [draftOf, setDraftOf] = useState(state.q);
  if (draftOf !== state.q) {
    setDraftOf(state.q);
    setDraft(state.q);
  }
  const [editing, setEditing] = useState<TextField | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const searchComposing = useRef(false);
  const conditionComposing = useRef(false);

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
    if (searchComposing.current) return;
    commit({ ...state, q: draft.trim() });
  };

  const openField = (field: TextField) => {
    conditionComposing.current = false;
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
      className="@container/conditions flex flex-col"
    >
      <form
        data-evidence-search-bar=""
        className="flex min-h-[var(--h-bar)] flex-none flex-wrap items-center gap-2.5 border-b border-divider bg-surface-chrome px-4 py-2 @min-[900px]/conditions:px-6"
        onSubmit={submitSearch}
      >
        <Seg
          name="evidence-family"
          value={state.family}
          options={familyOptions}
          onChange={(family) => commit({ ...state, family })}
          aria-label={t`证据种类`}
        />
        <div className="min-w-48 flex-1">
          <InputGroup ground="bg">
            <InputGroupAddon>
              <Search strokeWidth={1.5} />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onCompositionStart={() => { searchComposing.current = true; }}
              onCompositionEnd={(event) => {
                searchComposing.current = false;
                setDraft(event.currentTarget.value);
              }}
              aria-label={t`检索证据`}
              placeholder={t`搜索选手、武器或事件`}
            />
          </InputGroup>
        </div>
        <Button type="submit" variant="primary">
          <Trans>检索</Trans>
        </Button>
      </form>

      <div
        data-evidence-condition-bar=""
        className="flex min-h-[var(--h-bar)] flex-none flex-wrap items-center gap-2 border-b border-divider bg-surface-chrome px-4 py-2 @min-[900px]/conditions:px-6"
      >
        <span className="text-xs text-neutral-600">
          <Trans>条件</Trans>
        </span>

        {conditions.map((condition) => (
          <Badge
            key={condition.field}
            asChild
            variant="accent"
            data-condition={condition.field}
            aria-labelledby={`${conditionId}-${condition.field}`}
            onClick={() => onChange(withoutCondition(state, condition.field))}
            className="min-h-8 max-w-full gap-1.5"
          >
            <button type="button">
              <span id={`${conditionId}-${condition.field}`} className="min-w-0 truncate"><span className="sr-only"><Trans>移除条件</Trans>：</span>{conditionLabel(condition)}</span>
              <X size={11} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </Badge>
        ))}

        {TEXT_FIELDS.filter((field) => state[field] === '').map((field) =>
          editing === field ? (
            <span key={field} className="inline-flex w-52 flex-none items-center">
              <Input
                autoFocus
                ground="bg"
                value={editingValue}
                aria-label={textFieldName(field)}
                placeholder={textFieldPlaceholder(field)}
                data-condition-input={field}
                onChange={(event) => setEditingValue(event.target.value)}
                onCompositionStart={() => { conditionComposing.current = true; }}
                onCompositionEnd={(event) => {
                  conditionComposing.current = false;
                  setEditingValue(event.currentTarget.value);
                }}
                onBlur={() => { if (!conditionComposing.current) commitField(field); }}
                onKeyDown={(event) => {
                  if (conditionComposing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitField(field);
                  }
                  if (event.key === 'Escape') {
                    /* Esc here is the field's: it cancels the edit and stops
                       there. The page's own Esc listener releases the selected
                       row only when nothing closer has claimed the key. */
                    event.preventDefault();
                    setEditing(null);
                  }
                }}
              />
            </span>
          ) : (
            <Badge
              key={field}
              asChild
              variant="outline"
              data-condition-add={field}
              className="min-h-8 gap-1.5"
              onClick={() => openField(field)}
            >
              <button type="button">
                <Plus size={13} strokeWidth={1.5} aria-hidden="true" />{textFieldLabel(field)}
              </button>
            </Badge>
          ),
        )}

        {state.headshot ? null : (
          <Badge
            asChild
            variant="outline"
            data-condition-add="headshot"
            className="min-h-8 gap-1.5"
            onClick={() => commit({ ...state, headshot: true })}
          >
            <button type="button">
              <Plus size={13} strokeWidth={1.5} aria-hidden="true" /><Trans>仅爆头</Trans>
            </button>
          </Badge>
        )}

        {state.from === '' ? (
          <Badge
            asChild
            variant="outline"
            data-condition-add="from"
            className="min-h-8 gap-1.5 disabled:cursor-not-allowed disabled:opacity-45"
            {...(dateDisabledReason === undefined
              ? {}
              : {
                  disabled: true,
                  title: dateDisabledReason,
                })}
            onClick={() => commit({ ...state, from: recentFrom })}
          >
            <button type="button">
              <Plus size={13} strokeWidth={1.5} aria-hidden="true" /><Trans>近 {RECENT_WINDOW_DAYS} 天</Trans>
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
