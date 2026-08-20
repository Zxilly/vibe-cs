import { beforeEach, describe, expect, it } from 'vitest';

import { resetShellStore, SHELL_INITIAL_STATE, useShellStore } from './shellStore';

beforeEach(() => {
  resetShellStore();
});

describe('shellStore', () => {
  it('starts in editing mode with the rail open and the Agent rail collapsed', () => {
    expect(SHELL_INITIAL_STATE).toEqual({ mode: 'edit', navCollapsed: false, agentRailExpanded: false });
    const state = useShellStore.getState();
    expect(state.mode).toBe('edit');
    expect(state.navCollapsed).toBe(false);
    expect(state.agentRailExpanded).toBe(false);
  });

  it('switches work modes independently of the rail state', () => {
    useShellStore.getState().setMode('analysis');
    expect(useShellStore.getState().mode).toBe('analysis');
    expect(useShellStore.getState().navCollapsed).toBe(false);
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

  it('toggles and sets the Agent rail independently of the nav rail', () => {
    useShellStore.getState().toggleAgentRail();
    expect(useShellStore.getState().agentRailExpanded).toBe(true);
    expect(useShellStore.getState().navCollapsed).toBe(false);

    useShellStore.getState().setAgentRailExpanded(false);
    expect(useShellStore.getState().agentRailExpanded).toBe(false);
  });

  it('holds only shell preferences and no server data', () => {
    const values = Object.entries(useShellStore.getState())
      .filter(([, value]) => typeof value !== 'function')
      .map(([key]) => key)
      .sort();
    expect(values).toEqual(['agentRailExpanded', 'mode', 'navCollapsed']);
  });

  it('resets back to the initial state', () => {
    useShellStore.getState().setNavCollapsed(true);
    useShellStore.getState().setAgentRailExpanded(true);
    resetShellStore();
    expect(useShellStore.getState().mode).toBe('edit');
    expect(useShellStore.getState().navCollapsed).toBe(false);
    expect(useShellStore.getState().agentRailExpanded).toBe(false);
  });
});
