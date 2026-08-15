/*
 * `unit` project — §10.5 gap 18's answer, pinned.
 *
 * The point of these assertions is not the string; it is that the handoff
 * stays inside §7's three parameters. A fourth one appearing in this address
 * would put the route table and the implementation out of step, and a test is
 * the only thing that notices that on the day someone adds `?clips=`.
 */

import { describe, expect, it } from 'vitest';

import { AGENT_PARAM, readAgentContext } from './agentContract';
import { agentPlanHandoff } from './agentHandoff';

function queryOf(href: string): URLSearchParams {
  return new URLSearchParams(href.slice(href.indexOf('?') + 1));
}

describe('agentPlanHandoff', () => {
  it('names the plan the sender created, and opens on §7’s default shape', () => {
    const params = queryOf(agentPlanHandoff('P-118'));
    expect(params.get(AGENT_PARAM.plan)).toBe('P-118');
    expect(params.get(AGENT_PARAM.mode)).toBe('changes');
  });

  it('writes no session: a handoff arrives before any conversation exists', () => {
    expect(queryOf(agentPlanHandoff('P-118')).has(AGENT_PARAM.session)).toBe(false);
  });

  it('uses only the three parameters §7 declares', () => {
    const names = [...queryOf(agentPlanHandoff('P-118', { session: 'S-1', mode: 'takes' })).keys()];
    expect(new Set(names)).toEqual(new Set([AGENT_PARAM.plan, AGENT_PARAM.session, AGENT_PARAM.mode]));
  });

  it('continues an existing conversation when the sender knows one', () => {
    const context = readAgentContext(queryOf(agentPlanHandoff('P-118', { session: 'S-1' })));
    expect(context).toEqual({ plan: 'P-118', session: 'S-1', mode: 'changes' });
  });

  it('round-trips through the page’s own reader', () => {
    const context = readAgentContext(queryOf(agentPlanHandoff('P-9', { mode: 'inline' })));
    expect(context).toEqual({ plan: 'P-9', session: null, mode: 'inline' });
  });

  it('is a router path, so `RouteLink` / `navigate` can take it as it is', () => {
    expect(agentPlanHandoff('P-118').startsWith('/agent?')).toBe(true);
  });
});
