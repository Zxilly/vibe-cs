/*
 * App shell — the persisted shell state (spec §4.2).
 *
 * §4.2 hands zustand exactly two shell concerns: `sidebarCollapsed` and
 * `agentRailExpanded`. Both are preferences, not server data, so they persist
 * and they survive a reload; nothing here ever holds anything a query owns.
 *
 * This is a new store rather than a field on `shared/stores/uiStore`: that one
 * is part of the pre-redesign shell and goes away with `features/**` in phase
 * 4, and it also carries `theme` / `language`, which spec §10 assigns to the
 * settings page (phase 3g). When those land they join this store — the §4.2
 * list is one store, built up as its owners arrive — so the name is the whole
 * shell, not the sidebar.
 *
 * The storage fallback repeats the shape `uiStore` uses: `localStorage` does
 * not exist in the `unit` / `markup` test environments (node), and zustand's
 * `createJSONStorage` would throw reading it.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { WorkspaceMode } from './navigation';

const memoryValues = new Map<string, string>();

const memoryStorage: Storage = {
  get length() {
    return memoryValues.size;
  },
  clear: () => memoryValues.clear(),
  getItem: (key) => memoryValues.get(key) ?? null,
  key: (index) => [...memoryValues.keys()][index] ?? null,
  removeItem: (key) => {
    memoryValues.delete(key);
  },
  setItem: (key, value) => {
    memoryValues.set(key, value);
  },
};

export interface ShellState {
  /** The current work lens; both modes keep using the same underlying data. */
  mode: WorkspaceMode;
  /** One-time orientation has been completed or explicitly dismissed. */
  onboardingComplete: boolean;
  /** Spec §8 rule 1: 216px text rail → 56px icon rail. */
  navCollapsed: boolean;
  /** The 46px Agent rail opened to `--w-inspector`. Default closed, per Frame. */
  agentRailExpanded: boolean;
  setMode: (mode: WorkspaceMode) => void;
  completeOnboarding: () => void;
  setNavCollapsed: (collapsed: boolean) => void;
  toggleNav: () => void;
  setAgentRailExpanded: (expanded: boolean) => void;
  toggleAgentRail: () => void;
}

/**
 * The state a fresh install starts from. Exported so a test can restore it
 * without re-typing the defaults — the store is a module singleton and leaks
 * across test files otherwise.
 */
export const SHELL_INITIAL_STATE = {
  mode: 'edit' as const,
  onboardingComplete: false,
  navCollapsed: false,
  /* Frame.dc.html draws the rail collapsed on every artboard, and the 壳层规格
     board labels the 46px form 「默认收起」. */
  agentRailExpanded: false,
} as const;

export const useShellStore = create<ShellState>()(
  persist(
    (set) => ({
      ...SHELL_INITIAL_STATE,
      setMode: (mode) => set({ mode }),
      completeOnboarding: () => set({ onboardingComplete: true }),
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
      toggleNav: () => set((state) => ({ navCollapsed: !state.navCollapsed })),
      setAgentRailExpanded: (agentRailExpanded) => set({ agentRailExpanded }),
      toggleAgentRail: () => set((state) => ({ agentRailExpanded: !state.agentRailExpanded })),
    }),
    {
      name: 'vibe-cs:shell',
      storage: createJSONStorage(() => (typeof localStorage === 'undefined' ? memoryStorage : localStorage)),
      partialize: ({ mode, onboardingComplete, navCollapsed, agentRailExpanded }) => ({
        mode,
        onboardingComplete,
        navCollapsed,
        agentRailExpanded,
      }),
    },
  ),
);

/** Puts the store back to `SHELL_INITIAL_STATE`. For tests and nothing else. */
export function resetShellStore(): void {
  useShellStore.setState({ ...SHELL_INITIAL_STATE });
}
