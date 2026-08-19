import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { LEGACY_UI_TERMS } from '../../terminology';

import {
  activeNavItemId,
  SHELL_NAV_FOOTER_ITEM,
  SHELL_NAV_GROUPS,
  SHELL_NAV_ITEMS,
} from './navigation';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

describe('the nav table mirrors Frame.dc.html', () => {
  it('contains none of the legacy IA nouns in shell chrome', () => {
    const chrome = [
      ...SHELL_NAV_GROUPS.flatMap((group) =>
        group.label === null ? [] : [i18n._(group.label)],
      ),
      ...SHELL_NAV_ITEMS.map((item) => i18n._(item.label)),
    ].join('\n');

    for (const legacy of LEGACY_UI_TERMS) expect(chrome).not.toContain(legacy);
  });

  it('keeps the four groups in the order the frame declares them', () => {
    expect(SHELL_NAV_GROUPS.map((group) => group.id)).toEqual([
      'workspace',
      'library',
      'production',
      'delivery',
    ]);
    // Only the first group is drawn without a heading.
    expect(SHELL_NAV_GROUPS.map((group) => group.label === null)).toEqual([true, false, false, false]);
  });

  it('lists the twelve destinations of spec §7 that the rail carries', () => {
    expect(SHELL_NAV_ITEMS.map((item) => item.id)).toEqual([
      'home',
      'library',
      'history',
      'players',
      'evidence',
      'projects',
      'agent',
      'recording',
      'montage',
      'editor',
      'outputs',
      'settings',
    ]);
    expect(SHELL_NAV_ITEMS.map((item) => item.to)).toEqual([
      '/',
      '/library',
      '/history',
      '/players',
      '/evidence',
      '/projects',
      '/agent',
      '/recording',
      '/montage',
      '/editor',
      '/delivery?view=outputs',
      '/settings',
    ]);
  });

  it('pins 设置与诊断 outside the groups, as the frame does', () => {
    expect(SHELL_NAV_FOOTER_ITEM.id).toBe('settings');
    expect(SHELL_NAV_GROUPS.flatMap((group) => group.items).map((item) => item.id)).not.toContain('settings');
  });
});

describe('activeNavItemId', () => {
  it('matches the workspace root exactly, not as a prefix', () => {
    expect(activeNavItemId('/')).toBe('home');
    expect(activeNavItemId('/library')).toBe('library');
  });

  it('tolerates a trailing slash', () => {
    expect(activeNavItemId('/players/')).toBe('players');
  });

  it('lights 资料库 for the match workspace, per the 1100×700 artboard', () => {
    expect(activeNavItemId('/match/aurora-meridian')).toBe('library');
  });

  it('follows a nested route to its section', () => {
    expect(activeNavItemId('/players/kael')).toBe('players');
    expect(activeNavItemId('/recording/A-2481')).toBe('recording');
    expect(activeNavItemId('/editor/P-118')).toBe('editor');
  });

  it('keeps every delivery address on the finished-files destination', () => {
    expect(activeNavItemId('/delivery')).toBe('outputs');
    expect(activeNavItemId('/delivery', '?view=outputs')).toBe('outputs');
    expect(activeNavItemId('/delivery', 'view=tasks')).toBe('outputs');
    expect(activeNavItemId('/delivery', '?view=tasks')).toBe('outputs');
  });

  it('files the legacy task detail under finished files', () => {
    expect(activeNavItemId('/delivery/task/A-2481')).toBe('outputs');
    expect(activeNavItemId('/delivery/task/A-2481', '?view=outputs')).toBe('outputs');
  });

  it('lights 设置与诊断 for the recovery centre, which the frame does not list', () => {
    expect(activeNavItemId('/recovery')).toBe('settings');
    expect(activeNavItemId('/settings', '?section=ai')).toBe('settings');
  });

  it('returns null for a destination outside the rail', () => {
    expect(activeNavItemId('/prototype/whatever')).toBeNull();
  });
});
