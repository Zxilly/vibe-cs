import { beforeEach, describe, expect, it } from 'vitest';

import { resetShellStore, SHELL_INITIAL_STATE, useShellStore } from './shellStore';

beforeEach(() => {
  resetShellStore();
});

describe('shellStore', () => {
  it('starts in editing mode with the navigation rail open', () => {
    expect(SHELL_INITIAL_STATE).toEqual({
      mode: 'edit',
      onboardingComplete: false,
      navCollapsed: false,
    });
    const state = useShellStore.getState();
    expect(state.mode).toBe('edit');
    expect(state.navCollapsed).toBe(false);
  });

  it('switches work modes independently of the rail state', () => {
    useShellStore.getState().setMode('analysis');
    expect(useShellStore.getState().mode).toBe('analysis');
    expect(useShellStore.getState().navCollapsed).toBe(false);
  });

  it('records the one-time guide independently of the chosen mode', () => {
    useShellStore.getState().completeOnboarding();
    expect(useShellStore.getState().onboardingComplete).toBe(true);
    expect(useShellStore.getState().mode).toBe('edit');
  });

  it('toggles the nav rail', () => {
    useShellStore.getState().toggleNav();
    expect(useShellStore.getState().navCollapsed).toBe(true);
    useShellStore.getState().toggleNav();
    expect(useShellStore.getState().navCollapsed).toBe(false);
  });

  it('sets the nav rail directly', () => {
    useShellStore.getState().setNavCollapsed(true);
    expect(useShellStore.getState().navCollapsed).toBe(true);
    useShellStore.getState().setNavCollapsed(true);
    expect(useShellStore.getState().navCollapsed).toBe(true);
  });

  it('holds only shell preferences and no server data', () => {
    const values = Object.entries(useShellStore.getState())
      .filter(([, value]) => typeof value !== 'function')
      .map(([key]) => key)
      .sort();
    expect(values).toEqual(['mode', 'navCollapsed', 'onboardingComplete']);
  });

  it('resets back to the initial state', () => {
    useShellStore.getState().setNavCollapsed(true);
    resetShellStore();
    expect(useShellStore.getState().mode).toBe('edit');
    expect(useShellStore.getState().onboardingComplete).toBe(false);
    expect(useShellStore.getState().navCollapsed).toBe(false);
  });
});
