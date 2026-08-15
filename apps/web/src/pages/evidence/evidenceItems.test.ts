/*
 * `unit` project — the wire row → the row `EvidenceRow` draws.
 *
 * The interesting cases are all about *not* claiming things: a kind the build
 * has never heard of, a `NULL` penetration flag, a row with no position.
 */

import { describe, expect, it } from 'vitest';

import {
  evidenceKindOf,
  evidencePosition,
  evidenceQualifiers,
  formatMatchDay,
  formatMatchMonthDay,
  toEvidenceIdentity,
} from './evidenceItems';
import { evidenceItem } from './test/fixtures';

describe('the kind', () => {
  it.each([
    ['kill', 'kill'],
    ['damage', 'kill'],
    ['multi_kill', 'kill'],
    ['round_start', 'round'],
    ['round_end', 'round'],
    ['purchase', 'round'],
    ['bomb_plant', 'objective'],
    ['bomb_defuse', 'objective'],
    ['defuse', 'objective'],
    ['grenade', 'utility'],
  ])('maps the wire kind %s onto %s', (eventType, expected) => {
    expect(evidenceKindOf(evidenceItem({ event_type: eventType }))).toBe(expected);
  });

  it('falls back rather than throwing on a kind this build has not heard of', () => {
    // A newer analyser must still produce a navigable row.
    expect(evidenceKindOf(evidenceItem({ event_type: 'teleport' }))).toBe('kill');
  });

  it('is 死亡 when the searched player is the one it happened to', () => {
    const row = evidenceItem({ actor_name: 'Kael', target_name: 'Corvin' });
    expect(evidenceKindOf(row, { player: 'Corvin' })).toBe('death');
    expect(evidenceKindOf(row, { player: 'Kael' })).toBe('kill');
    expect(evidenceKindOf(row)).toBe('kill');
  });

  it('matches the perspective case-insensitively and on the id too', () => {
    const row = evidenceItem({ target_id: 'STEAM_CORVIN', target_name: 'Corvin' });
    expect(evidenceKindOf(row, { player: 'corvin' })).toBe('death');
    expect(evidenceKindOf(row, { player: 'steam_corvin' })).toBe('death');
    expect(evidenceKindOf(row, { player: '  ' })).toBe('kill');
  });

  it('never turns a non-duel kind into 死亡', () => {
    const row = evidenceItem({ event_type: 'bomb_plant', target_name: 'Corvin' });
    expect(evidenceKindOf(row, { player: 'Corvin' })).toBe('objective');
  });
});

describe('the qualifiers', () => {
  it('puts penetration before the headshot, as the artboard prints them', () => {
    expect(evidenceQualifiers(evidenceItem({ penetrated: true, headshot: true }))).toEqual([
      'penetrated',
      'headshot',
    ]);
  });

  it('treats NULL as "not recorded", not as false', () => {
    // `null` means the projector had no opinion; claiming a normal shot would
    // be an assertion the data does not support.
    expect(evidenceQualifiers(evidenceItem({ penetrated: null, headshot: null }))).toEqual([]);
    expect(evidenceQualifiers(evidenceItem({ penetrated: false, headshot: false }))).toEqual([]);
  });
});

describe('the identity', () => {
  it('carries the tick, the round and the match label the row prints', () => {
    expect(toEvidenceIdentity(evidenceItem())).toMatchObject({
      id: 'demo:aurora/event:e-1',
      tick: 149_380,
      round: 21,
      matchLabel: 'Aurora vs Meridian',
      actor: 'Kael',
      target: 'Corvin',
      weapon: 'AK-47',
    });
  });

  it('falls back to the raw id when a name never resolved', () => {
    const row = evidenceItem({ actor_name: null, target_name: null });
    expect(toEvidenceIdentity(row)).toMatchObject({
      actor: 'STEAM_KAEL',
      target: 'STEAM_CORVIN',
    });
  });

  it('omits a field the row does not have rather than setting it to undefined', () => {
    const identity = toEvidenceIdentity(
      evidenceItem({ actor_id: null, actor_name: null, weapon: null }),
    );
    expect(identity).not.toHaveProperty('actor');
    expect(identity).not.toHaveProperty('weapon');
  });
});

describe('the position', () => {
  it('reads the projector s position triple', () => {
    expect(evidencePosition(evidenceItem())).toEqual([-1200, 640, 64]);
  });

  it('is null for anything that is not three finite numbers', () => {
    expect(evidencePosition(evidenceItem({ attributes: {} }))).toBeNull();
    expect(evidencePosition(evidenceItem({ attributes: { position: [1, 2] } }))).toBeNull();
    expect(evidencePosition(evidenceItem({ attributes: { position: ['a', 2, 3] } }))).toBeNull();
    expect(
      evidencePosition(evidenceItem({ attributes: { position: [Number.NaN, 2, 3] } })),
    ).toBeNull();
  });
});

describe('the date', () => {
  it('prints the artboard s 08-14 for the table and the full day for the panel', () => {
    expect(formatMatchDay('2026-08-14T20:11:00Z')).toBe('2026-08-14');
    expect(formatMatchMonthDay('2026-08-14T20:11:00Z')).toBe('08-14');
  });

  it('is empty, not a dash, when there is no date — the caller picks the glyph', () => {
    expect(formatMatchDay(null)).toBe('');
    expect(formatMatchMonthDay(null)).toBe('');
  });

  it('leaves a value that is not an ISO date visibly wrong rather than silently empty', () => {
    expect(formatMatchMonthDay('unknown')).toBe('unknown');
  });
});
