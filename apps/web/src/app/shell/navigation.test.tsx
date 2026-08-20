import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { LEGACY_UI_TERMS } from '../../terminology';

import {
  activeNavItemId,
  SHELL_NAV_FOOTER_ITEM,
  SHELL_NAV_GROUPS,
  SHELL_NAV_ITEMS,
  shellNavGroups,
  workspaceModeForPath,
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
      'players',
      'evidence',
      'projects',
      'outputs',
      'settings',
    ]);
    expect(SHELL_NAV_ITEMS.map((item) => item.to)).toEqual([
      '/',
      '/library',
      '/players',
      '/evidence',
      '/projects',
      '/delivery?view=outputs',
      '/settings',
    ]);
  });

  it('pins 设置与诊断 outside the groups, as the frame does', () => {
    expect(SHELL_NAV_FOOTER_ITEM.id).toBe('settings');
    expect(SHELL_NAV_GROUPS.flatMap((group) => group.items).map((item) => item.id)).not.toContain('settings');
  });

  it('separates editing destinations from analysis destinations without duplicating data', () => {
    expect(shellNavGroups('edit').flatMap((group) => group.items).map((item) => item.id)).toEqual([
      'home', 'library', 'projects', 'outputs',
    ]);
    expect(shellNavGroups('analysis').flatMap((group) => group.items).map((item) => item.id)).toEqual([
      'library', 'players', 'evidence',
    ]);
  });
});

describe('workspaceModeForPath', () => {
  it('assigns creation and analysis deep links to their owning lens', () => {
    expect(workspaceModeForPath('/')).toBe('edit');
    expect(workspaceModeForPath('/projects/p-1')).toBe('edit');
    expect(workspaceModeForPath('/delivery')).toBe('edit');
    expect(workspaceModeForPath('/players/kael')).toBe('analysis');
    expect(workspaceModeForPath('/evidence')).toBe('analysis');
    expect(workspaceModeForPath('/match/demo-1')).toBe('analysis');
  });

  it('leaves shared library and settings routes in the chosen mode', () => {
    expect(workspaceModeForPath('/library')).toBeNull();
    expect(workspaceModeForPath('/settings')).toBeNull();
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
    expect(activeNavItemId('/recording/A-2481')).toBeNull();
    expect(activeNavItemId('/editor/P-118')).toBeNull();
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
