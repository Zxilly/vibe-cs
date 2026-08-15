/*
 * `unit` project — `/agent`'s address, the one piece of the contract that is
 * pure. §7 fixes the three parameters; invariant 4 fixes what a patch may do.
 */

import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  AGENT_MODE,
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  agentHref,
  patchAgentContext,
  readAgentContext,
  writeAgentContext,
  type AgentRouteContext,
} from './agentContract';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

const OPEN: AgentRouteContext = { plan: 'P-118', session: 'S-1', mode: 'changes' };

describe('reading the address', () => {
  it('reads all three parameters', () => {
    expect(readAgentContext(new URLSearchParams('plan=P-118&session=S-1&mode=takes'))).toEqual({
      plan: 'P-118',
      session: 'S-1',
      mode: 'takes',
    });
  });

  it('opens on 变更列表 with nothing selected when the query is bare', () => {
    expect(readAgentContext(new URLSearchParams())).toEqual({
      plan: null,
      session: null,
      mode: DEFAULT_AGENT_MODE,
    });
    expect(DEFAULT_AGENT_MODE).toBe('changes');
  });

  it('falls back rather than rendering nothing for an unreadable mode', () => {
    expect(readAgentContext(new URLSearchParams('mode=diff')).mode).toBe('changes');
  });

  it('treats an empty or blank id as no selection', () => {
    const context = readAgentContext(new URLSearchParams('plan=&session=%20%20'));
    expect(context.plan).toBeNull();
    expect(context.session).toBeNull();
  });

  it('knows exactly the three shapes the reference draws', () => {
    expect([...AGENT_MODES]).toEqual(['changes', 'inline', 'takes']);
  });
});

describe('writing the address', () => {
  it('omits an absent selection and always writes the mode', () => {
    expect(writeAgentContext({ plan: null, session: null, mode: 'changes' }).toString()).toBe(
      'mode=changes',
    );
  });

  it('round-trips', () => {
    expect(readAgentContext(writeAgentContext(OPEN))).toEqual(OPEN);
  });

  it('builds a shareable href', () => {
    expect(agentHref(OPEN)).toBe('/agent?plan=P-118&session=S-1&mode=changes');
  });
});

describe('patching the address (invariant 4)', () => {
  it('changes one field and leaves the rest', () => {
    expect(patchAgentContext(OPEN, { mode: 'inline' })).toEqual({ ...OPEN, mode: 'inline' });
  });

  it('keeps the plan when the session changes — a new session takes it over', () => {
    expect(patchAgentContext(OPEN, { session: 'S-2' })).toEqual({ ...OPEN, session: 'S-2' });
  });

  it('keeps the session when the plan changes — one session may touch many objects', () => {
    expect(patchAgentContext(OPEN, { plan: 'P-102' })).toEqual({ ...OPEN, plan: 'P-102' });
  });

  it('clears only what the patch names', () => {
    expect(patchAgentContext(OPEN, { plan: null })).toEqual({ ...OPEN, plan: null });
    expect(patchAgentContext(OPEN, { session: null })).toEqual({ ...OPEN, session: null });
  });

  it('leaves everything alone for an empty patch', () => {
    expect(patchAgentContext(OPEN, {})).toEqual(OPEN);
  });
});

describe('the mode vocabulary', () => {
  it('gives every mode a label and a hint', () => {
    for (const mode of AGENT_MODES) {
      expect(i18n._(AGENT_MODE[mode].label)).not.toBe('');
      expect(i18n._(AGENT_MODE[mode].hint)).not.toBe('');
    }
  });

  it('gives every mode a distinct label', () => {
    const labels = AGENT_MODES.map((mode) => i18n._(AGENT_MODE[mode].label));
    expect(new Set(labels).size).toBe(AGENT_MODES.length);
  });
});
