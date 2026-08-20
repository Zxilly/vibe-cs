export const SETTINGS_SECTIONS = ['app', 'files', 'game', 'ai', 'advanced'] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_ITEM_SECTION = {
  appearance: 'app',
  updates: 'app',
  storage: 'files',
  'watch-folders': 'files',
  game: 'game',
  'recording-defaults': 'game',
  'video-output': 'game',
  model: 'ai',
  conversations: 'ai',
  behavior: 'ai',
  runtime: 'advanced',
  dependencies: 'advanced',
  capture: 'advanced',
  diagnostics: 'advanced',
} as const satisfies Readonly<Record<string, SettingsSection>>;

export type SettingsItem = keyof typeof SETTINGS_ITEM_SECTION;

export function settingsPath(item: SettingsItem): string {
  return `/settings?section=${SETTINGS_ITEM_SECTION[item]}&item=${item}`;
}
