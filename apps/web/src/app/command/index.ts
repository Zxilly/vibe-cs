/*
 * App shell — command palette barrel.
 *
 * `AppShell` needs exactly two things from this directory: `useCommandPalette`
 * for the state and the Ctrl K binding, and `CommandPalette` for the overlay.
 * The registry is exported as well because later phases extend it from where
 * their dependencies live (see `commandRegistry.ts`), and the search functions
 * because they are the tested contract behind 「回车执行首条」.
 */

export { CommandPalette, type CommandPaletteProps } from './CommandPalette';
export {
  buildCommandList,
  COMMAND_GROUP_LABEL,
  COMMAND_GROUP_ORDER,
  PAGE_COMMANDS,
  resolveCommands,
  type CommandContext,
  type CommandDefinition,
  type CommandGroupId,
  type ResolvedCommand,
} from './commandRegistry';
export {
  DEFAULT_GROUP_LIMIT,
  flattenCommandResults,
  MATCH_SCORE,
  nextGroupSelectionIndex,
  nextSelectionIndex,
  queryTerms,
  scoreCommand,
  searchCommands,
  type CommandGroupResult,
  type CommandSearchOptions,
  type SearchableCommand,
} from './commandSearch';
export {
  isCommandPaletteHotkey,
  useCommandPalette,
  type CommandPaletteController,
} from './useCommandPalette';
