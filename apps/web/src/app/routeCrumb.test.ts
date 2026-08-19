/*
 * `unit` project — the title bar breadcrumb, as a pure function of the address.
 *
 * Asserting on the resolved zh-CN string rather than on descriptor identity:
 * the crumb's contract is what the user reads, and `msg` bakes its source into
 * the descriptor, so the source locale needs no catalog.
 */

import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { routeCrumb } from './routeCrumb';
import { LEGACY_UI_TERMS } from '../terminology';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

function crumb(pathname: string, search = ''): string {
  return routeCrumb(pathname, search)
    .map((segment) => i18n._(segment.label))
    .join(' › ');
}

/** Where each rung goes, `-` for a rung that is a heading rather than a route. */
function targets(pathname: string, search = ''): string {
  return routeCrumb(pathname, search)
    .map((segment) => segment.to ?? '-')
    .join(' ');
}

describe('routeCrumb', () => {
  it('keeps legacy IA nouns out of breadcrumb chrome', () => {
    const chrome = [
      crumb('/'),
      crumb('/library'),
      crumb('/agent'),
      crumb('/montage'),
      crumb('/delivery'),
      crumb('/delivery', '?view=tasks'),
      crumb('/delivery/task/t-42'),
    ].join('\n');

    for (const legacy of LEGACY_UI_TERMS) expect(chrome).not.toContain(legacy);
  });

  it('renders 工作台 without a group, because Frame gives it none', () => {
    expect(routeCrumb('/')).toHaveLength(1);
    expect(crumb('/')).toBe('工作台');
  });

  it('opens with the rail group and closes with the entry', () => {
    expect(crumb('/library')).toBe('资料库 › Demo 资料库');
    expect(crumb('/history')).toBe('资料库 › 比赛历史');
    expect(crumb('/agent')).toBe('制作 › Agent 创作');
    expect(crumb('/editor')).toBe('制作 › 多轨编辑');
    expect(crumb('/montage')).toBe('制作 › 快速剪辑');
  });

  it('reads the query, so one path can carry two rail entries', () => {
    expect(crumb('/delivery')).toBe('交付 › 成品文件');
    expect(crumb('/delivery', '?view=outputs')).toBe('交付 › 成品文件');
    expect(crumb('/delivery', '?view=tasks')).toBe('交付 › 成品文件');
    // A leading `?` is optional — `location.search` carries one, a test may not.
    expect(crumb('/delivery', 'view=tasks')).toBe('交付 › 成品文件');
  });

  it('names the leaf for the four §7 routes the rail cannot list', () => {
    expect(crumb('/match/aurora-vs-meridian')).toBe('资料库 › Demo 资料库 › 比赛工作区');
    expect(crumb('/players/kael')).toBe('资料库 › 玩家目录 › 玩家档案');
    expect(crumb('/delivery/task/t-42')).toBe('交付 › 成品文件 › 后台任务详情');
    // The footer entry has no group heading, so its own label opens the crumb —
    // once, carrying the destination rather than being repeated as a heading.
    expect(crumb('/recovery')).toBe('设置与诊断 › 恢复中心');
  });

  /* The trail is climbable, which is the whole reason it is a trail. The rung
     that used to be dropped — the list this detail page came from — is the only
     one anybody would ever click. */
  it('keeps the parent list as a rung, and gives it its destination', () => {
    expect(routeCrumb('/match/x')).toHaveLength(3);
    expect(targets('/match/x')).toBe('- /library -');
    expect(targets('/players/kael')).toBe('- /players -');
    expect(targets('/recovery')).toBe('/settings -');
  });

  it('leaves the page you are on without a destination', () => {
    // A link to where you already are is a link that does nothing.
    expect(targets('/library')).toBe('- -');
    expect(targets('/')).toBe('-');
  });

  it('keeps the list route and its detail route apart', () => {
    expect(crumb('/players')).toBe('资料库 › 玩家目录');
    expect(crumb('/players/kael')).toBe('资料库 › 玩家目录 › 玩家档案');
  });

  it('treats a trailing slash as the same destination', () => {
    expect(crumb('/library/')).toBe(crumb('/library'));
    expect(crumb('/match/x/')).toBe(crumb('/match/x'));
  });

  it('is empty for an address outside the table, so the bar shows nothing rather than a guess', () => {
    expect(routeCrumb('/does-not-exist')).toEqual([]);
    expect(routeCrumb('/production')).toEqual([]);
  });

  /* The separator itself belongs to `design/layout/Breadcrumb` now — it is
     punctuation the component draws, not data this resolver returns. */
});
