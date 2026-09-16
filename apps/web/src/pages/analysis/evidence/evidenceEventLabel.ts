/*
 * pages/evidence — what a row *is*, in words.
 *
 * `evidenceItems.ts` folds the wire `event_type` onto `domain/match`'s six
 * `EvidenceKind` glyphs, and a glyph is enough for a kill — 「Kael → Corvin ·
 * AK-47」 says the rest. It is not enough for the rows that have no duel to
 * describe them: a round start has neither actor nor weapon, a purchase and a
 * grenade throw share a glyph with everything else in their family, and a
 * highlight (multi_kill, clutch, one_tap…) is a kill glyph with the interesting
 * part missing. So every wire kind except the plain `kill` has a phrase here,
 * and the row, the Inspector and the collected clip's name all print it.
 *
 * `MessageDescriptor`s rather than `<Trans>`: the clip name that goes into a
 * project is a `string`, and `EvidenceRow` prints the phrase inside a
 * sentence it already owns. The vocabulary is the one `crates/storage`
 * writes (`event_kind_text`, `highlight_kind_text`); an unknown kind gets no
 * phrase and the row falls back to its glyph's label.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import type { EvidenceSearchItem } from '../../../shared/desktop/dto';

const EVENT_LABEL: Readonly<Record<string, MessageDescriptor>> = {
  /* events */
  damage: msg({ message: '伤害', context: 'evidence-event' }),
  round_start: msg({ message: '回合开始', context: 'evidence-event' }),
  round_end: msg({ message: '回合结束', context: 'evidence-event' }),
  purchase: msg({ message: '购买', context: 'evidence-event' }),
  bomb_plant: msg({ message: '下包', context: 'evidence-event' }),
  bomb_defuse: msg({ message: '拆包', context: 'evidence-event' }),
  bomb_explode: msg({ message: '炸弹爆炸', context: 'evidence-event' }),
  grenade: msg({ message: '投掷道具', context: 'evidence-event' }),
  /* highlights */
  multi_kill: msg({ message: '多杀', context: 'evidence-event' }),
  clutch: msg({ message: '残局', context: 'evidence-event' }),
  one_tap: msg({ message: '一枪', context: 'evidence-event' }),
  wallbang: msg({ message: '穿墙击杀', context: 'evidence-event' }),
  no_scope: msg({ message: '盲狙', context: 'evidence-event' }),
  knife: msg({ message: '刀杀', context: 'evidence-event' }),
  taser: msg({ message: '电击枪击杀', context: 'evidence-event' }),
  defuse: msg({ message: '拆包', context: 'evidence-event' }),
  fail: msg({ message: '失误', context: 'evidence-event' }),
  timeline: msg({ message: '高光片段', context: 'evidence-event' }),
};

/**
 * The phrase for a row's wire kind, or `null` for a plain kill and for a kind
 * this build has not heard of — both of which the kind glyph already covers.
 */
export function evidenceEventLabel(row: Pick<EvidenceSearchItem, 'event_type'>): MessageDescriptor | null {
  return EVENT_LABEL[row.event_type] ?? null;
}
