/*
 * `unit` project — the title bar breadcrumb, as a pure function of the address.
 *
 * Asserting on the resolved zh-CN string rather than on descriptor identity:
 * the crumb's contract is what the user reads, and `msg` bakes its source into
 * the descriptor, so the source locale needs no catalog.
 */

import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { CRUMB_SEPARATOR, routeCrumb } from './routeCrumb';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

function crumb(pathname: string, search = ''): string {
  return routeCrumb(pathname, search)
    .map((segment) => i18n._(segment))
    .join(CRUMB_SEPARATOR);
}

describe('routeCrumb', () => {
  it('renders 工作台 without a group, because Frame gives it none', () => {
    expect(routeCrumb('/')).toHaveLength(1);
    expect(crumb('/')).toBe('工作台');
  });

  it('opens with the rail group and closes with the entry', () => {
    expect(crumb('/library')).toBe('资料库 › Demo 资料库');
    expect(crumb('/history')).toBe('资料库 › 比赛历史');
    expect(crumb('/agent')).toBe('制作 › Agent 创作');
    expect(crumb('/editor')).toBe('制作 › 多轨编辑');
  });

  it('reads the query, so one path can carry two rail entries', () => {
    expect(crumb('/delivery')).toBe('交付 › 输出');
    expect(crumb('/delivery', '?view=outputs')).toBe('交付 › 输出');
    expect(crumb('/delivery', '?view=tasks')).toBe('交付 › 任务记录');
    // A leading `?` is optional — `location.search` carries one, a test may not.
    expect(crumb('/delivery', 'view=tasks')).toBe('交付 › 任务记录');
  });

  it('names the leaf for the four §7 routes the rail cannot list', () => {
    expect(crumb('/match/aurora-vs-meridian')).toBe('资料库 › 比赛工作区');
    expect(crumb('/players/kael')).toBe('资料库 › 玩家档案');
    expect(crumb('/delivery/task/t-42')).toBe('交付 › 任务详情');
    expect(crumb('/recovery')).toBe('设置与诊断 › 恢复中心');
  });

  it('replaces the rail entry with the leaf rather than stacking three segments', () => {
    // 「资料库 › 比赛工作区」, not 「资料库 › Demo 资料库 › 比赛工作区」: the middle
    // segment of the reference's crumb is the match title, which is server data.
    expect(routeCrumb('/match/x')).toHaveLength(2);
  });

  it('keeps the list route and its detail route apart', () => {
    expect(crumb('/players')).toBe('资料库 › 玩家目录');
    expect(crumb('/players/kael')).toBe('资料库 › 玩家档案');
  });

  it('treats a trailing slash as the same destination', () => {
    expect(crumb('/library/')).toBe(crumb('/library'));
    expect(crumb('/match/x/')).toBe(crumb('/match/x'));
  });

  it('is empty for an address outside the table, so the bar shows nothing rather than a guess', () => {
    expect(routeCrumb('/does-not-exist')).toEqual([]);
    expect(routeCrumb('/production')).toEqual([]);
  });

  it('uses the separator the reference draws', () => {
    expect(CRUMB_SEPARATOR).toBe(' › ');
  });
});
