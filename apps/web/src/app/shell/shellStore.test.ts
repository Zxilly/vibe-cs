import { beforeEach, describe, expect, it } from 'vitest';

import { resetShellStore, SHELL_INITIAL_STATE, useShellStore } from './shellStore';

beforeEach(() => {
  resetShellStore();
});

describe('shellStore', () => {
  it('starts with the rail open and the Agent rail collapsed, as Frame draws them', () => {
    expect(SHELL_INITIAL_STATE).toEqual({ navCollapsed: false, agentRailExpanded: false });
    const state = useShellStore.getState();
    expect(state.navCollapsed).toBe(false);
    expect(state.agentRailExpanded).toBe(false);
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

  it('holds nothing but the two shell preferences (§4.2: no server data)', () => {
    const values = Object.entries(useShellStore.getState())
      .filter(([, value]) => typeof value !== 'function')
      .map(([key]) => key)
      .sort();
    expect(values).toEqual(['agentRailExpanded', 'navCollapsed']);
  });

  it('resets back to the initial state', () => {
    useShellStore.getState().setNavCollapsed(true);
    useShellStore.getState().setAgentRailExpanded(true);
    resetShellStore();
    expect(useShellStore.getState().navCollapsed).toBe(false);
    expect(useShellStore.getState().agentRailExpanded).toBe(false);
  });
});
