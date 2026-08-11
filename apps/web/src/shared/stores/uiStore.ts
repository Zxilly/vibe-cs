import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const memoryValues = new Map<string, string>();
const memoryStorage: Storage = {
  get length() { return memoryValues.size; },
  clear: () => memoryValues.clear(),
  getItem: (key) => memoryValues.get(key) ?? null,
  key: (index) => [...memoryValues.keys()][index] ?? null,
  removeItem: (key) => { memoryValues.delete(key); },
  setItem: (key, value) => { memoryValues.set(key, value); },
};

export type ThemePreference = 'dark' | 'light' | 'system';
export type LanguagePreference = 'zh-CN' | 'en-US';

type UiState = {
  sidebarCollapsed: boolean;
  theme: ThemePreference;
  language: LanguagePreference;
  toggleSidebar: () => void;
  setTheme: (theme: ThemePreference) => void;
  setLanguage: (language: LanguagePreference) => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: 'light',
      language: 'zh-CN',
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
    }),
    {
      name: 'vibe-cs:ui-v1',
      version: 2,
      storage: createJSONStorage(() => typeof localStorage === 'undefined' ? memoryStorage : localStorage),
      partialize: ({ sidebarCollapsed, theme, language }) => ({
        sidebarCollapsed,
        theme,
        language,
      }),
    },
  ),
);
