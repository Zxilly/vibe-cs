import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  EVIDENCE_KIND,
  EVIDENCE_KINDS,
  HIGHLIGHT_KIND,
  HIGHLIGHT_KINDS,
  KEY_ROUND,
  normaliseRoundEndReason,
  ROUND_END_REASON,
  ROUND_END_REASONS,
  TEAM_SIDE,
  TEAM_SIDES,
} from './matchEnums';

beforeAll(() => {
  // Source locale with an empty catalog: the macros baked the zh-CN string in,
  // so `_` falls back to it and the tests do not need a compiled catalog.
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

describe('the tables are total', () => {
  it('gives every team side a label, a two-letter word and a glyph', () => {
    expect(TEAM_SIDES).toHaveLength(2);
    for (const side of TEAM_SIDES) {
      const meta = TEAM_SIDE[side];
      expect(i18n._(meta.label)).not.toBe('');
      expect(meta.abbreviation).toMatch(/^(?:CT|T)$/u);
      expect(meta.icon).toBeTruthy();
    }
  });

  it('gives every round end reason a label and a glyph', () => {
    expect(ROUND_END_REASONS).toHaveLength(5);
    for (const reason of ROUND_END_REASONS) {
      const meta = ROUND_END_REASON[reason];
      expect(i18n._(meta.label)).not.toBe('');
      expect(meta.icon).toBeTruthy();
    }
  });

  it('gives every evidence kind a label and a glyph', () => {
    for (const kind of EVIDENCE_KINDS) {
      expect(i18n._(EVIDENCE_KIND[kind].label)).not.toBe('');
      expect(EVIDENCE_KIND[kind].icon).toBeTruthy();
    }
  });

  it('gives every highlight kind a label', () => {
    for (const kind of HIGHLIGHT_KINDS) {
      expect(i18n._(HIGHLIGHT_KIND[kind].label)).not.toBe('');
    }
  });

  it('has no two members of a union sharing a glyph', () => {
    const reasonIcons = ROUND_END_REASONS.map((reason) => ROUND_END_REASON[reason].icon);
    expect(new Set(reasonIcons).size).toBe(reasonIcons.length);

    const evidenceIcons = EVIDENCE_KINDS.map((kind) => EVIDENCE_KIND[kind].icon);
    expect(new Set(evidenceIcons).size).toBe(evidenceIcons.length);

    const sideIcons = TEAM_SIDES.map((side) => TEAM_SIDE[side].icon);
    expect(new Set(sideIcons).size).toBe(sideIcons.length);
  });

  it('lists every key the table declares, so a new member cannot hide', () => {
    expect([...TEAM_SIDES].sort()).toEqual(Object.keys(TEAM_SIDE).sort());
    expect([...ROUND_END_REASONS].sort()).toEqual(Object.keys(ROUND_END_REASON).sort());
    expect([...EVIDENCE_KINDS].sort()).toEqual(Object.keys(EVIDENCE_KIND).sort());
    expect([...HIGHLIGHT_KINDS].sort()).toEqual(Object.keys(HIGHLIGHT_KIND).sort());
  });

  it('names the key-round marker in words as well as with a star', () => {
    expect(i18n._(KEY_ROUND.label)).toBe('关键回合');
    expect(KEY_ROUND.icon).toBeTruthy();
  });
});

describe('normaliseRoundEndReason', () => {
  it('reads the analyser canonical reasons', () => {
    expect(normaliseRoundEndReason('t_killed')).toBe('elimination');
    expect(normaliseRoundEndReason('ct_killed')).toBe('elimination');
    expect(normaliseRoundEndReason('bomb_defused')).toBe('bomb-defused');
    expect(normaliseRoundEndReason('bomb_exploded')).toBe('bomb-exploded');
    expect(normaliseRoundEndReason('time_ran_out')).toBe('time-expired');
  });

  it('reads the SFUI notice the demo itself carries', () => {
    expect(normaliseRoundEndReason('#SFUI_Notice_CTs_Win')).toBe('elimination');
    expect(normaliseRoundEndReason('#SFUI_Notice_Terrorists_Win')).toBe('elimination');
    expect(normaliseRoundEndReason('#SFUI_Notice_Bomb_Defused')).toBe('bomb-defused');
    expect(normaliseRoundEndReason('#SFUI_Notice_Target_Bombed')).toBe('bomb-exploded');
    expect(normaliseRoundEndReason('#SFUI_Notice_Target_Saved')).toBe('time-expired');
  });

  it('is insensitive to case, spacing and separator style', () => {
    expect(normaliseRoundEndReason('Bomb Defused')).toBe('bomb-defused');
    expect(normaliseRoundEndReason('BOMB-EXPLODED')).toBe('bomb-exploded');
    expect(normaliseRoundEndReason('  elimination  ')).toBe('elimination');
  });

  it('answers unknown rather than guessing, and never throws on absent input', () => {
    expect(normaliseRoundEndReason('surrender')).toBe('unknown');
    expect(normaliseRoundEndReason('')).toBe('unknown');
    expect(normaliseRoundEndReason(null)).toBe('unknown');
    expect(normaliseRoundEndReason(undefined)).toBe('unknown');
  });

  it('resolves the defuse-versus-explode ambiguity toward the defuse', () => {
    // Both words contain "bomb"; the discriminating stem is checked first.
    expect(normaliseRoundEndReason('bomb_defused')).not.toBe('bomb-exploded');
  });
});
