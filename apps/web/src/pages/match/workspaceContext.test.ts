/*
 * `unit` project — the §4.4 address.
 *
 * The URL is the only state the workspace has, so every rule about reading and
 * writing it is asserted here rather than through a rendered page: 「回合 21 ·
 * 选手 Kael」 surviving a walk across the rail, a hand-edited parameter falling
 * back instead of poisoning a query, and the one invariant the three selections
 * share.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MATCH_VIEW,
  matchWorkspaceHref,
  patchWorkspaceContext,
  readWorkspaceContext,
  writeWorkspaceContext,
  type MatchWorkspaceContext,
} from './workspaceContext';

function read(query: string): MatchWorkspaceContext {
  return readWorkspaceContext(new URLSearchParams(query));
}

const EMPTY: MatchWorkspaceContext = {
  view: 'overview',
  round: null,
  player: null,
  tick: null,
  evidence: null,
};

describe('reading the address', () => {
  it('opens on §7 default view when nothing is asked for', () => {
    expect(read('')).toEqual(EMPTY);
    expect(DEFAULT_MATCH_VIEW).toBe('overview');
  });

  it('reads all five parameters', () => {
    expect(read('view=replay&round=21&player=kael&tick=149380&evidence=e-9')).toEqual({
      view: 'replay',
      round: 21,
      player: 'kael',
      tick: 149_380,
      evidence: 'e-9',
    });
  });

  it('falls back on an unknown view instead of rendering nothing', () => {
    expect(read('view=cosmetics').view).toBe('overview');
    expect(read('view=').view).toBe('overview');
  });

  it('refuses a round that is not a whole number ≥ 1', () => {
    for (const query of ['round=abc', 'round=0', 'round=-3', 'round=1.5', 'round=']) {
      expect(`${query}:${String(read(query).round)}`).toBe(`${query}:null`);
    }
    expect(read('round=21').round).toBe(21);
  });

  it('keeps tick 0 — it is the first tick of the demo, not an absent value', () => {
    expect(read('tick=0').tick).toBe(0);
    expect(read('tick=-1').tick).toBeNull();
    expect(read('tick=12abc').tick).toBeNull();
  });

  it('treats a blank id as no selection', () => {
    expect(read('player=%20%20').player).toBeNull();
    expect(read('evidence=').evidence).toBeNull();
    expect(read('player=%20kael%20').player).toBe('kael');
  });
});

describe('writing the address', () => {
  it('omits what is not selected rather than writing it empty', () => {
    expect(writeWorkspaceContext(EMPTY).toString()).toBe('view=overview');
  });

  it('always writes the view, including the default', () => {
    // A copied link that omits it depends on the default never changing.
    expect(writeWorkspaceContext(EMPTY).get('view')).toBe('overview');
  });

  it('round-trips a full selection', () => {
    const context: MatchWorkspaceContext = {
      view: 'highlights',
      round: 21,
      player: 'kael',
      tick: 149_380,
      evidence: 'e-9',
    };
    expect(read(writeWorkspaceContext(context).toString())).toEqual(context);
  });

  it('builds a shareable href with the demo id encoded', () => {
    expect(matchWorkspaceHref('demo/one', { ...EMPTY, round: 7 })).toBe(
      '/match/demo%2Fone?view=overview&round=7',
    );
  });
});

describe('patching the context', () => {
  const selected: MatchWorkspaceContext = {
    view: 'rounds',
    round: 21,
    player: 'kael',
    tick: 149_380,
    evidence: 'e-9',
  };

  it('leaves out fields alone and clears the ones set to null', () => {
    expect(patchWorkspaceContext(selected, { player: null }).player).toBeNull();
    expect(patchWorkspaceContext(selected, { player: null }).round).toBe(21);
  });

  it('carries the whole selection across a view change — that is the point of §7', () => {
    const moved = patchWorkspaceContext(selected, { view: 'replay' });
    expect(moved).toEqual({ ...selected, view: 'replay' });
  });

  it('drops a stale tick and evidence when the round moves', () => {
    const moved = patchWorkspaceContext(selected, { round: 7 });
    expect(moved.round).toBe(7);
    expect(moved.tick).toBeNull();
    expect(moved.evidence).toBeNull();
    // …and the focused player is not a property of the round, so it stays.
    expect(moved.player).toBe('kael');
  });

  it('keeps the playhead when the round is re-selected', () => {
    expect(patchWorkspaceContext(selected, { round: 21 }).tick).toBe(149_380);
  });

  it('lets a caller set the round and the tick in one move', () => {
    const moved = patchWorkspaceContext(selected, { round: 7, tick: 52_000, evidence: 'e-2' });
    expect(moved.tick).toBe(52_000);
    expect(moved.evidence).toBe('e-2');
  });

  it('clears the round without pretending the old tick still means something', () => {
    expect(patchWorkspaceContext(selected, { round: null })).toEqual({
      view: 'rounds',
      round: null,
      player: 'kael',
      tick: null,
      evidence: null,
    });
  });
});
