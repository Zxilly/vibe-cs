/*
 * Unit project (node): the registry is data, so it is checked as data.
 *
 * The point of these cases is that the spec §7 route table and this file cannot
 * drift apart unnoticed — the destinations are asserted literally, not derived
 * from the same constant they are meant to guard.
 */

import { i18n } from '@lingui/core';
import type { MessageDescriptor } from '@lingui/core';
import { describe, expect, it, vi } from 'vitest';

import {
  buildCommandList,
  COMMAND_GROUP_LABEL,
  COMMAND_GROUP_ORDER,
  PAGE_COMMANDS,
  resolveCommands,
  type CommandDefinition,
} from './commandRegistry';

/** Source locale with an empty catalog: `_` falls back to the authored zh-CN. */
function activateSourceLocale(): void {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
}

const translate = (descriptor: MessageDescriptor) => i18n._(descriptor);

/** Runs a command and reports where it navigated. */
function destinationOf(command: CommandDefinition): string | null {
  let destination: string | null = null;
  command.run({
    navigate: (to) => {
      destination = to;
    },
  });
  return destination;
}

function stubCommand(id: string, overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id,
    group: 'action',
    title: { id: `title.${id}`, message: id },
    keywords: [],
    run: () => {},
    ...overrides,
  };
}

describe('PAGE_COMMANDS', () => {
  it('covers every static destination of the spec §7 route table', () => {
    expect(PAGE_COMMANDS.map(destinationOf)).toEqual([
      '/',
      '/library',
      '/history',
      '/players',
      '/evidence',
      '/projects',
      '/projects/new?step=shotlist',
      '/recording',
      '/delivery?view=outputs',
      '/delivery?view=tasks',
      '/settings',
      '/recovery',
      '/guide',
    ]);
  });

  it('registers nothing that needs a route parameter', () => {
    // `/match/:demoId` and `/delivery/task/:taskId` are object commands, not
    // page commands; they arrive through `buildCommandList` in a later phase.
    for (const command of PAGE_COMMANDS) {
      expect(destinationOf(command)).not.toContain(':');
    }
  });

  it('gives every command a unique id in the page group', () => {
    const identifiers = PAGE_COMMANDS.map((command) => command.id);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(PAGE_COMMANDS.every((command) => command.group === 'page')).toBe(true);
  });

  it('always carries the route path as a search term, lower-cased', () => {
    for (const command of PAGE_COMMANDS) {
      const destination = destinationOf(command) ?? '';
      expect(command.keywords).toContain(destination.toLowerCase());
      expect(command.keywords.every((keyword) => keyword === keyword.toLowerCase())).toBe(true);
    }
  });

  it('navigates exactly once per run', () => {
    const navigate = vi.fn();
    const first = PAGE_COMMANDS[0];
    expect(first).toBeDefined();
    first?.run({ navigate });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/');
  });
});

describe('COMMAND_GROUP_ORDER', () => {
  it('is the footer hint order — 比赛、选手、证据、页面和动作', () => {
    activateSourceLocale();
    expect(COMMAND_GROUP_ORDER.map((group) => translate(COMMAND_GROUP_LABEL[group]))).toEqual([
      '比赛',
      '选手',
      '证据',
      '页面',
      '动作',
    ]);
  });

  it('labels every group exactly once', () => {
    expect(Object.keys(COMMAND_GROUP_LABEL).sort()).toEqual([...COMMAND_GROUP_ORDER].sort());
  });
});

describe('buildCommandList', () => {
  it('is the page table when nothing is passed', () => {
    expect(buildCommandList().map((command) => command.id)).toEqual(
      PAGE_COMMANDS.map((command) => command.id),
    );
  });

  it('appends extensions after the built-ins', () => {
    const built = buildCommandList([stubCommand('action.import-demo')]);
    expect(built).toHaveLength(PAGE_COMMANDS.length + 1);
    expect(built[built.length - 1]?.id).toBe('action.import-demo');
  });

  it('lets an extension override a built-in in place, keeping its position', () => {
    const replacement = stubCommand('page.agent', { group: 'page' });
    const built = buildCommandList([replacement]);
    const position = PAGE_COMMANDS.findIndex((command) => command.id === 'page.agent');

    expect(built).toHaveLength(PAGE_COMMANDS.length);
    expect(built[position]).toBe(replacement);
  });

  it('does not mutate the built-in table', () => {
    const before = PAGE_COMMANDS.length;
    buildCommandList([stubCommand('x'), stubCommand('page.home', { group: 'page' })]);
    expect(PAGE_COMMANDS).toHaveLength(before);
    expect(destinationOf(PAGE_COMMANDS[0] as CommandDefinition)).toBe('/');
  });
});

describe('resolveCommands', () => {
  it('resolves the copy and keeps the closure', () => {
    activateSourceLocale();
    const resolved = resolveCommands(PAGE_COMMANDS, translate);
    const library = resolved.find((command) => command.id === 'page.library');

    expect(library?.title).toBe('Demo 资料库');
    expect(library?.hint).toBe('跳转');
    expect(library?.shortcut).toBeNull();

    const navigate = vi.fn();
    library?.run({ navigate });
    expect(navigate).toHaveBeenCalledWith('/library');
  });

  it('turns an absent hint or shortcut into null rather than undefined', () => {
    const resolved = resolveCommands([stubCommand('bare')], (descriptor) => String(descriptor.id));
    expect(resolved[0]?.hint).toBeNull();
    expect(resolved[0]?.shortcut).toBeNull();
  });

  it('passes a shortcut through untouched — it is a key name, not copy', () => {
    const resolved = resolveCommands(
      [stubCommand('with-shortcut', { shortcut: 'CTRL I' })],
      (descriptor) => String(descriptor.id),
    );
    expect(resolved[0]?.shortcut).toBe('CTRL I');
  });
});
