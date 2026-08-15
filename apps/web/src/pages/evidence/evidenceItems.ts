/*
 * pages/evidence — the wire row → the row `domain/match/EvidenceRow` draws.
 *
 * `EvidenceSearchItem` is what the index stores (snake_case, nullable
 * everywhere, `event_type` as a bare wire string); `EvidenceItem` is what the
 * component takes. `domain/match/types.ts` states the split and why the two are
 * not the same type — so the page owns the translation, and this is it.
 *
 * Everything here is pure and copy-free. Free text on `EvidenceItem` is
 * `ReactNode` because every visible sentence goes through a Lingui macro
 * (§5.1), and a macro belongs in a component, not in a node-testable module. So
 * this file produces the *facts* — the kind, the qualifiers, the identity — and
 * `EvidenceResults.tsx` turns them into sentences. Splitting it that way is
 * what lets `evidenceItems.test.ts` run in the `unit` project with no i18n
 * activation and no DOM.
 */

import type { EvidenceKind } from '../../domain/match';
import type { EvidenceItem } from '../../domain/match';
import type { EvidenceSearchItem } from '../../shared/desktop/dto';

/* ── the kind ────────────────────────────────────────────────────────────── */

/**
 * `event_type` is written by the projector as a bare string
 * (`crates/storage/src/repository.rs`, `event_kind_text` and
 * `highlight_kind_text`), so the wire vocabulary is known and finite. Both
 * tables are transcribed here, mapped onto the five members of
 * `domain/match`'s `EvidenceKind`.
 *
 * Two of the mappings are judgements rather than identities and are called out
 * so a reviewer can disagree with them:
 *
 *   `damage`   lands on 击杀 — a shot that connected. `EvidenceKind` has no
 *              「伤害」 member, and inventing one is a `domain/**` change.
 *   `purchase` lands on 回合 — an economy fact belongs to the round, not to a
 *              duel.
 *
 * An unrecognised string falls back to 击杀 rather than throwing: a newer
 * analyser writing a kind this build has not heard of should still produce a
 * readable row, and the tick, the actor and the round — everything a user
 * navigates by — are unaffected by the glyph.
 */
const KIND_BY_EVENT_TYPE: Readonly<Record<string, EvidenceKind>> = {
  /* events */
  kill: 'kill',
  damage: 'kill',
  round_start: 'round',
  round_end: 'round',
  purchase: 'round',
  bomb_plant: 'objective',
  bomb_defuse: 'objective',
  bomb_explode: 'objective',
  grenade: 'utility',
  /* highlights */
  multi_kill: 'kill',
  clutch: 'kill',
  one_tap: 'kill',
  wallbang: 'kill',
  no_scope: 'kill',
  knife: 'kill',
  taser: 'kill',
  defuse: 'objective',
  fail: 'kill',
  timeline: 'round',
};

const FALLBACK_KIND: EvidenceKind = 'kill';

export interface EvidencePerspective {
  /**
   * The player the search is *about* — the 「选手：Kael」 chip. A kill is 击杀
   * from the shooter's side and 死亡 from the victim's, and the index stores
   * one row for both; without a perspective the row cannot be told which it is,
   * so it stays 击杀. Matched case-insensitively against the target's id and
   * name, because the chip is typed by a human.
   */
  readonly player?: string | undefined;
}

export function evidenceKindOf(
  row: EvidenceSearchItem,
  perspective: EvidencePerspective = {},
): EvidenceKind {
  const base = KIND_BY_EVENT_TYPE[row.event_type] ?? FALLBACK_KIND;
  if (base !== 'kill') return base;
  return isPerspectiveTarget(row, perspective.player) ? 'death' : 'kill';
}

function isPerspectiveTarget(row: EvidenceSearchItem, player: string | undefined): boolean {
  if (player === undefined) return false;
  const wanted = player.trim().toLowerCase();
  if (wanted === '') return false;
  return (
    row.target_id?.toLowerCase() === wanted || row.target_name?.toLowerCase() === wanted
  );
}

/* ── the qualifiers ──────────────────────────────────────────────────────── */

/**
 * The 「穿墙」 / 「爆头」 badges the artboard prints after the weapon. Returned as
 * tokens rather than as text so the component owns the wording; the order is
 * the artboard's (「AK-47 · 穿墙 · 18.7m」 puts penetration first).
 *
 * `null` is not `false`: the index stores `NULL` when the projector had no
 * opinion, and a row that never recorded penetration must not claim it was a
 * normal shot.
 */
export type EvidenceQualifier = 'penetrated' | 'headshot';

export function evidenceQualifiers(row: EvidenceSearchItem): readonly EvidenceQualifier[] {
  const list: EvidenceQualifier[] = [];
  if (row.penetrated === true) list.push('penetrated');
  if (row.headshot === true) list.push('headshot');
  return list;
}

/* ── the identity ────────────────────────────────────────────────────────── */

/**
 * The fields of `EvidenceItem` that carry no authored sentence.
 * `EvidenceResults` spreads this and adds `description` / `context`, which are
 * the two slots that need macros.
 *
 * `actor` and `target` prefer the resolved name and fall back to the raw id:
 * a steam id is ugly but it is the truth, and rendering an empty cell for a
 * player whose name never resolved would hide a real row.
 */
export type EvidenceIdentity = Pick<
  EvidenceItem,
  'id' | 'tick' | 'kind' | 'actor' | 'target' | 'weapon' | 'round' | 'matchLabel'
>;

export function toEvidenceIdentity(
  row: EvidenceSearchItem,
  perspective: EvidencePerspective = {},
): EvidenceIdentity {
  const actor = row.actor_name ?? row.actor_id;
  const target = row.target_name ?? row.target_id;
  return {
    id: row.evidence_id,
    tick: row.tick,
    kind: evidenceKindOf(row, perspective),
    round: row.round,
    matchLabel: row.demo_display_name,
    ...(actor === null ? {} : { actor }),
    ...(target === null ? {} : { target }),
    ...(row.weapon === null ? {} : { weapon: row.weapon }),
  };
}

/* ── spatial evidence ────────────────────────────────────────────────────── */

/**
 * The world position the projector stored on the row, or `null`.
 *
 * `attributes` is `Record<string, unknown>` on the wire — the projector writes
 * `{"position": [x, y, z]}` for an event and a different bag for a highlight
 * (`crates/storage/src/repository.rs`) — so it is narrowed structurally here
 * rather than cast. `null` is the honest answer for a row with no position, and
 * the Inspector prints 「空间证据：不可用」 for it instead of dropping the field:
 * a missing row and a missing *field* are different facts.
 */
export function evidencePosition(row: EvidenceSearchItem): readonly [number, number, number] | null {
  const value = row.attributes['position'];
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/* ── the date ────────────────────────────────────────────────────────────── */

/**
 * 「08-14」 — the artboard's own format for the results table's first column.
 * The year is dropped because every row in the table shares the page's date
 * filter and the full stamp is in the Inspector; `formatMatchDay` keeps it for
 * that use.
 *
 * Hand-sliced rather than run through `Intl`: `match_date` is an ISO string
 * from the service, the two artboard formats are fixed-width by design (the
 * column is mono and must not reflow between rows), and `Intl` would localise
 * the separator. A value that is not an ISO date comes back untouched, which is
 * visibly wrong rather than silently empty.
 */
export function formatMatchDay(matchDate: string | null): string {
  if (matchDate === null) return '';
  return matchDate.slice(0, 10);
}

export function formatMatchMonthDay(matchDate: string | null): string {
  const day = formatMatchDay(matchDate);
  return day.length === 10 ? day.slice(5) : day;
}
