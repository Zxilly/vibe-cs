/*
 * Unit project (node): the palette's ranking contract, enumerated.
 *
 * Every rule in `commandSearch.ts`'s header gets a case here, including the two
 * things the search deliberately does NOT do — fuzzy matching and pinyin. Those
 * are asserted as absences so that "add a fuzzy matcher" cannot land silently.
 */

import { describe, expect, it } from 'vitest';

import type { CommandGroupId } from './commandRegistry';
import {
  DEFAULT_GROUP_LIMIT,
  flattenCommandResults,
  MATCH_SCORE,
  nextGroupSelectionIndex,
  nextSelectionIndex,
  queryTerms,
  scoreCommand,
  searchCommands,
  type SearchableCommand,
} from './commandSearch';

function cmd(
  id: string,
  group: CommandGroupId,
  title: string,
  keywords: readonly string[] = [],
): SearchableCommand {
  return { id, group, title, keywords };
}

const ids = (commands: readonly SearchableCommand[]) => commands.map((command) => command.id);

describe('queryTerms', () => {
  it('lower-cases, trims and splits on runs of whitespace', () => {
    expect(queryTerms('  Mirage   KAEL ')).toEqual(['mirage', 'kael']);
  });

  it('treats a blank query as no terms', () => {
    expect(queryTerms('')).toEqual([]);
    expect(queryTerms('   ')).toEqual([]);
  });
});

describe('scoreCommand', () => {
  const library = cmd('library', 'page', 'Demo 资料库', ['/library', 'library', 'demo']);

  it('scores every command 0 for a blank query, so registry order survives', () => {
    expect(scoreCommand(library, '')).toBe(0);
    expect(scoreCommand(library, '   ')).toBe(0);
  });

  it('ranks a title prefix above a title substring', () => {
    expect(scoreCommand(library, 'demo')).toBe(MATCH_SCORE.titlePrefix);
    expect(scoreCommand(library, '资料')).toBe(MATCH_SCORE.titleSubstring);
    expect(MATCH_SCORE.titlePrefix).toBeGreaterThan(MATCH_SCORE.titleSubstring);
  });

  it('ranks a title substring above a keyword prefix', () => {
    const keywordOnly = cmd('other', 'page', '恢复中心', ['资料备份']);
    expect(scoreCommand(library, '资料')).toBe(MATCH_SCORE.titleSubstring);
    expect(scoreCommand(keywordOnly, '资料')).toBe(MATCH_SCORE.keywordPrefix);
    expect(MATCH_SCORE.titleSubstring).toBeGreaterThan(MATCH_SCORE.keywordPrefix);
  });

  it('ranks a keyword prefix above a keyword substring', () => {
    const prefix = cmd('a', 'page', '甲', ['library']);
    const substring = cmd('b', 'page', '乙', ['my-library']);
    expect(scoreCommand(prefix, 'lib')).toBe(MATCH_SCORE.keywordPrefix);
    expect(scoreCommand(substring, 'lib')).toBe(MATCH_SCORE.keywordSubstring);
  });

  it('takes the best keyword, not the first one that matches', () => {
    const command = cmd('a', 'page', '甲', ['my-library', 'library']);
    expect(scoreCommand(command, 'lib')).toBe(MATCH_SCORE.keywordPrefix);
  });

  it('is case-insensitive in both directions', () => {
    expect(scoreCommand(library, 'DEMO')).toBe(MATCH_SCORE.titlePrefix);
    expect(scoreCommand(cmd('a', 'page', 'AGENT 创作', []), 'agent')).toBe(MATCH_SCORE.titlePrefix);
    expect(scoreCommand(cmd('b', 'page', '甲', ['LIBRARY']), 'lib')).toBe(MATCH_SCORE.keywordPrefix);
  });

  it('requires every term to match (AND, not OR)', () => {
    const match = cmd('m', 'match', 'Aurora vs Meridian · Mirage', ['kael', 'mirage']);
    expect(scoreCommand(match, 'mirage kael')).toBe(
      MATCH_SCORE.titleSubstring + MATCH_SCORE.keywordPrefix,
    );
    expect(scoreCommand(match, 'mirage rhea')).toBeNull();
  });

  it('adds the terms up, so a two-term hit outranks a one-term hit', () => {
    const both = cmd('both', 'match', 'Mirage · Kael', []);
    const one = cmd('one', 'match', 'Mirage · Rhea', []);
    const bothScore = scoreCommand(both, 'mirage kael');
    const oneScore = scoreCommand(one, 'mirage');
    expect(bothScore).not.toBeNull();
    expect(oneScore).not.toBeNull();
    expect(bothScore ?? 0).toBeGreaterThan(oneScore ?? 0);
  });

  it('counts a repeated term twice — the query is taken literally', () => {
    const command = cmd('a', 'page', '设置与诊断', []);
    expect(scoreCommand(command, '设置 设置')).toBe(MATCH_SCORE.titlePrefix * 2);
  });

  it('does not match a subsequence: no fuzzy search', () => {
    expect(scoreCommand(cmd('a', 'page', 'Library', ['library']), 'lbr')).toBeNull();
  });

  it('does not match pinyin', () => {
    expect(scoreCommand(cmd('a', 'page', 'Demo 资料库', ['library']), 'ziliao')).toBeNull();
  });

  it('matches CJK by substring like any other script', () => {
    expect(scoreCommand(cmd('a', 'page', '多轨编辑器', []), '编辑')).toBe(MATCH_SCORE.titleSubstring);
  });
});

describe('searchCommands', () => {
  const commands: readonly SearchableCommand[] = [
    cmd('m1', 'match', 'Aurora vs Meridian · Mirage', ['mirage']),
    cmd('m2', 'match', 'Halcyon vs Solace · Mirage', ['mirage']),
    cmd('m3', 'match', 'Kestrel vs Aurora · Mirage', ['mirage']),
    cmd('m4', 'match', 'Solace vs Rhea · Mirage', ['mirage']),
    cmd('m5', 'match', 'Meridian vs Kestrel · Mirage', ['mirage']),
    cmd('p1', 'player', 'Kael', ['kael']),
    cmd('page1', 'page', 'Mirage 页面', []),
    cmd('a1', 'action', '导入 Demo', ['mirage']),
  ];

  it('returns every command in registry order for a blank query', () => {
    const groups = searchCommands(commands, '', { limitPerGroup: 100 });
    expect(flattenCommandResults(groups).map((command) => command.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'p1',
      'page1',
      'a1',
    ]);
  });

  it('does not apply the shorter-title tie-break to a blank query', () => {
    const scoped: readonly SearchableCommand[] = [
      cmd('long', 'page', '多轨编辑器与时间轴', []),
      cmd('short', 'page', '输出', []),
    ];
    expect(ids(searchCommands(scoped, '')[0]?.commands ?? [])).toEqual(['long', 'short']);
  });

  it('emits groups in COMMAND_GROUP_ORDER and drops the empty ones', () => {
    const groups = searchCommands(commands, 'mirage');
    expect(groups.map((group) => group.group)).toEqual(['match', 'page', 'action']);
  });

  it('caps each group at four rows and reports what it hid', () => {
    const groups = searchCommands(commands, 'mirage');
    const matches = groups[0];
    expect(matches?.group).toBe('match');
    expect(matches?.commands).toHaveLength(DEFAULT_GROUP_LIMIT);
    expect(matches?.total).toBe(5);
  });

  it('honours an explicit per-group limit', () => {
    const groups = searchCommands(commands, 'mirage', { limitPerGroup: 2 });
    expect(groups[0]?.commands).toHaveLength(2);
    expect(groups[0]?.total).toBe(5);
  });

  it('sorts within a group by score, not by registry position', () => {
    const scoped: readonly SearchableCommand[] = [
      cmd('substring', 'page', '打开 Library', []),
      cmd('keyword', 'page', '恢复中心', ['library']),
      cmd('prefix', 'page', 'Library 资料库', []),
    ];
    const groups = searchCommands(scoped, 'library');
    expect(ids(groups[0]?.commands ?? [])).toEqual(['prefix', 'substring', 'keyword']);
  });

  it('breaks a score tie by the shorter title', () => {
    const scoped: readonly SearchableCommand[] = [
      cmd('long', 'page', 'Mirage 的完整回放', []),
      cmd('short', 'page', 'Mirage', []),
    ];
    const groups = searchCommands(scoped, 'mirage');
    expect(ids(groups[0]?.commands ?? [])).toEqual(['short', 'long']);
  });

  it('breaks a full tie by registry order, so the list never reshuffles', () => {
    const scoped: readonly SearchableCommand[] = [
      cmd('first', 'page', 'alpha one', []),
      cmd('second', 'page', 'alpha two', []),
    ];
    const groups = searchCommands(scoped, 'alpha');
    expect(ids(groups[0]?.commands ?? [])).toEqual(['first', 'second']);
    expect(ids(searchCommands([...scoped].reverse(), 'alpha')[0]?.commands ?? [])).toEqual([
      'second',
      'first',
    ]);
  });

  it('returns no groups at all when nothing matches', () => {
    expect(searchCommands(commands, 'nothing-here')).toEqual([]);
  });
});

describe('flattenCommandResults', () => {
  it('lays the groups out in display order', () => {
    const commands: readonly SearchableCommand[] = [
      cmd('page1', 'page', '工作台', []),
      cmd('match1', 'match', '工作台比赛', []),
    ];
    const flat = flattenCommandResults(searchCommands(commands, '工作台'));
    // 比赛 is drawn above 页面 on the artboard, whatever the registry order is.
    expect(ids(flat)).toEqual(['match1', 'page1']);
  });
});

describe('nextSelectionIndex', () => {
  it('moves and wraps in both directions', () => {
    expect(nextSelectionIndex(0, 1, 3)).toBe(1);
    expect(nextSelectionIndex(2, 1, 3)).toBe(0);
    expect(nextSelectionIndex(0, -1, 3)).toBe(2);
    expect(nextSelectionIndex(1, -1, 3)).toBe(0);
  });

  it('stays at 0 when there is nothing to select', () => {
    expect(nextSelectionIndex(0, 1, 0)).toBe(0);
    expect(nextSelectionIndex(3, -1, 0)).toBe(0);
  });

  it('treats "nothing selected yet" as position 0', () => {
    expect(nextSelectionIndex(-1, 1, 3)).toBe(1);
    expect(nextSelectionIndex(-1, -1, 3)).toBe(2);
  });
});

describe('nextGroupSelectionIndex', () => {
  const commands: readonly SearchableCommand[] = [
    cmd('m1', 'match', 'x match one', []),
    cmd('m2', 'match', 'x match two', []),
    cmd('p1', 'player', 'x player', []),
    cmd('a1', 'action', 'x action', []),
  ];
  const groups = searchCommands(commands, 'x');

  it('jumps to the first row of the next group', () => {
    expect(nextGroupSelectionIndex(groups, 0)).toBe(2);
    expect(nextGroupSelectionIndex(groups, 1)).toBe(2);
    expect(nextGroupSelectionIndex(groups, 2)).toBe(3);
  });

  it('wraps past the last group', () => {
    expect(nextGroupSelectionIndex(groups, 3)).toBe(0);
  });

  it('is a visible no-op with a single group', () => {
    expect(nextGroupSelectionIndex(searchCommands(commands, 'x player'), 0)).toBe(0);
  });

  it('reports -1 when there is nothing to move to', () => {
    expect(nextGroupSelectionIndex([], 0)).toBe(-1);
  });
});
