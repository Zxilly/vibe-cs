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

function projectOf(href: string): string {
  return decodeURIComponent(href.slice('/projects/'.length, href.indexOf('?')));
}

describe('agentPlanHandoff', () => {
  it('names the plan the sender created, and opens on §7’s default shape', () => {
    const params = queryOf(agentPlanHandoff('P-118'));
    expect(projectOf(agentPlanHandoff('P-118'))).toBe('plan:P-118');
    expect(params.has(AGENT_PARAM.plan)).toBe(false);
    expect(params.get(AGENT_PARAM.mode)).toBe('changes');
  });

  it('writes no session: a handoff arrives before any conversation exists', () => {
    expect(queryOf(agentPlanHandoff('P-118')).has(AGENT_PARAM.session)).toBe(false);
  });

  it('uses only the three parameters §7 declares', () => {
    const names = [...queryOf(agentPlanHandoff('P-118', { session: 'S-1', mode: 'takes' })).keys()];
    expect(new Set(names)).toEqual(new Set([AGENT_PARAM.session, AGENT_PARAM.mode, 'step']));
  });

  it('continues an existing conversation when the sender knows one', () => {
    const context = readAgentContext(queryOf(agentPlanHandoff('P-118', { session: 'S-1' })));
    expect(context).toEqual({ plan: null, session: 'S-1', mode: 'changes' });
    expect(projectOf(agentPlanHandoff('P-118', { session: 'S-1' }))).toBe('plan:P-118');
  });

  it('round-trips through the page’s own reader', () => {
    const context = readAgentContext(queryOf(agentPlanHandoff('P-9', { mode: 'inline' })));
    expect(context).toEqual({ plan: null, session: null, mode: 'inline' });
    expect(projectOf(agentPlanHandoff('P-9', { mode: 'inline' }))).toBe('plan:P-9');
  });

  it('is a router path, so `RouteLink` / `navigate` can take it as it is', () => {
    expect(agentPlanHandoff('P-118').startsWith('/projects/plan%3AP-118?')).toBe(true);
  });
});
