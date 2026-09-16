/*
 * App shell — the palette's object rows: 比赛 / 选手 / 作品.
 *
 * `commandRegistry.ts` registers the static pages and leaves the object
 * groups to "the palette's host", because their rows come from server data.
 * This hook is that host's half: for the query the reader has typed it asks
 * the same reads the library, the player directory and the project list use,
 * and turns each answer into `CommandDefinition`s for `buildCommandList`.
 *
 * The service does the coarse cut (a substring search on the first term); the
 * palette's own `searchCommands` then applies every term, so 「mirage kael」
 * still means both words, and a service that ignores `search` (the mock) is
 * merely slower, not wrong.
 *
 * Titles are data, not copy, so they are passed as `{ id, message }` rather
 * than through `msg` (see the registry's note on object commands). The hints
 * are copy and go through the macro.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import { useDemoList } from '../../data/demos';
import { usePlayerDirectory } from '../../data/players';
import { useProjects } from '../../data/projects';
import { queryTerms } from './commandSearch';
import type { CommandDefinition } from './commandRegistry';

/** 「每组最多 4 条」 plus room for the palette to rank within. */
const OBJECT_PAGE_SIZE = 8;

function literal(value: string): MessageDescriptor {
  return { id: value, message: value };
}

export function useObjectCommands(query: string, enabled: boolean): readonly CommandDefinition[] {
  const terms = queryTerms(query);
  const search = terms[0] ?? '';
  const searching = enabled && search !== '';

  const demos = useDemoList({ search, page: 1, page_size: OBJECT_PAGE_SIZE }, { enabled: searching });
  const players = usePlayerDirectory(
    { search, page: 1, page_size: OBJECT_PAGE_SIZE, sort: 'player', direction: 'asc' },
    { enabled: searching },
  );
  const projects = useProjects({ enabled });

  if (!searching) return [];

  const commands: CommandDefinition[] = [];

  for (const demo of demos.data?.items ?? []) {
    commands.push({
      id: `match.${demo.id}`,
      group: 'match',
      title: literal(demo.display_name),
      hint: msg({ message: '打开工作区', context: 'palette-hint' }),
      keywords: [demo.filename, demo.map_name, demo.team_a_name ?? '', demo.team_b_name ?? '', ...demo.players]
        .filter((keyword) => keyword !== '')
        .map((keyword) => keyword.toLowerCase()),
      run: (context) => {
        context.navigate(`/match/${encodeURIComponent(demo.id)}`);
      },
    });
  }

  for (const player of players.data?.items ?? []) {
    commands.push({
      id: `player.${player.steam_id}`,
      group: 'player',
      title: literal(player.name),
      hint: msg({ message: '选手档案', context: 'palette-hint' }),
      keywords: [...player.aliases, player.last_team ?? '', player.steam_id]
        .filter((keyword) => keyword !== '')
        .map((keyword) => keyword.toLowerCase()),
      run: (context) => {
        context.navigate(`/players/${encodeURIComponent(player.steam_id)}`);
      },
    });
  }

  for (const project of projects.data ?? []) {
    commands.push({
      id: `project.${project.id}`,
      group: 'project',
      title: literal(project.name),
      hint: msg({ message: '打开作品', context: 'palette-hint' }),
      keywords: [],
      run: (context) => {
        context.navigate(`/projects/${encodeURIComponent(project.id)}`);
      },
    });
  }

  /* 证据 stays a page: the index answers a query, not a name, and a row that
     matched every keystroke would take 「回车执行首条」 from every real hit. */
  return commands;
}
