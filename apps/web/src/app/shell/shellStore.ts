/*
 * App shell — the persisted shell state (spec §4.2).
 *
 * Shell presentation preferences persist locally
 * and they survive a reload; nothing here ever holds anything a query owns.
 *
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { WorkspaceMode } from './navigation';

export interface ShellState {
  /** The current work lens; both modes keep using the same underlying data. */
  mode: WorkspaceMode;
  /** One-time orientation has been completed or explicitly dismissed. */
  onboardingComplete: boolean;
  /** Spec §8 rule 1: 216px text rail → 56px icon rail. */
  navCollapsed: boolean;
  setMode: (mode: WorkspaceMode) => void;
  completeOnboarding: () => void;
  setNavCollapsed: (collapsed: boolean) => void;
  toggleNav: () => void;
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
} as const;

export const useShellStore = create<ShellState>()(
  persist(
    (set) => ({
      ...SHELL_INITIAL_STATE,
      setMode: (mode) => set({ mode }),
      completeOnboarding: () => set({ onboardingComplete: true }),
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
      toggleNav: () => set((state) => ({ navCollapsed: !state.navCollapsed })),
    }),
    {
      name: 'vibe-cs:shell',
      storage: createJSONStorage(() => localStorage),
      partialize: ({ mode, onboardingComplete, navCollapsed }) => ({
        mode,
        onboardingComplete,
        navCollapsed,
      }),
    },
  ),
);

/** Puts the store back to `SHELL_INITIAL_STATE`. For tests and nothing else. */
export function resetShellStore(): void {
  useShellStore.setState({ ...SHELL_INITIAL_STATE });
}
