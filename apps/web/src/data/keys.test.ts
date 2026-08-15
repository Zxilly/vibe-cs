/**
 * `unit` project — the query key factory.
 *
 * These assertions are the foundation the rest of the cache stands on, so they
 * are written as exact shapes rather than "starts with the right thing":
 *
 *   · the literal array every factory produces (a silent reorder of the
 *     arguments would move an object's cache entry without any type error)
 *   · that `hashKey` — the function TanStack actually compares keys with —
 *     separates every distinct call in the corpus
 *   · that a namespace key is a prefix of everything in it, and an object's
 *     detail key is a prefix of its sub-resources, because that is what makes
 *     「失效一个领域」 and 「失效一个对象」 one-liners
 *   · that the §4.1 recovery predicate still holds: the health probe is the
 *     only key `ServiceGate` excludes, and every other key is refreshed
 *
 * There is no import from `app/**` here any more: `app/boundary/serviceHealth`
 * now takes `SERVICE_HEALTH_KEY` from `qk.service.health()`, so the two cannot
 * diverge and the test does not have to reach up a layer to check that they
 * have not. The literals asserted below are the contract itself.
 */

import { hashKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  QUERY_NAMESPACE,
  isKeyPrefixOf,
  isServiceProbeKey,
  qk,
  refreshesOnServiceRecovery,
  type QueryNamespace,
} from './keys';

/** Every factory call, tagged with the namespace it must land in. */
const CORPUS: ReadonlyArray<readonly [QueryNamespace, string, readonly unknown[]]> = [
  ['service', 'service.health()', qk.service.health()],

  ['demos', 'demos.list({})', qk.demos.list({})],
  ['demos', 'demos.list({page:1})', qk.demos.list({ page: 1 })],
  ['demos', 'demos.detail(a)', qk.demos.detail('demo-a')],
  ['demos', 'demos.detail(b)', qk.demos.detail('demo-b')],
  ['demos', 'demos.metadata(a)', qk.demos.metadata('demo-a')],
  ['demos', 'demos.watch()', qk.demos.watch()],
  ['demos', 'demos.reviewTags()', qk.demos.reviewTags()],

  ['players', 'players.list', qk.players.list({ sort: 'adr', direction: 'desc' })],
  ['players', 'players.list(asc)', qk.players.list({ sort: 'adr', direction: 'asc' })],
  ['players', 'players.detail', qk.players.detail('7656119')],
  ['players', 'players.matches', qk.players.matches('7656119', { page: 1, page_size: 20 })],
  ['players', 'players.matches(p2)', qk.players.matches('7656119', { page: 2, page_size: 20 })],
  ['players', 'players.maps', qk.players.maps('7656119', { page: 1, page_size: 20 })],
  ['players', 'players.heatmap', qk.players.heatmap('7656119', { map: 'de_mirage', kind: 'all' })],
  [
    'players',
    'players.heatmap(kills)',
    qk.players.heatmap('7656119', { map: 'de_mirage', kind: 'kills' }),
  ],

  ['evidence', 'evidence.search({})', qk.evidence.search({})],
  ['evidence', 'evidence.search(q)', qk.evidence.search({ q: 'ace' })],
  ['evidence', 'evidence.annotationsAll', qk.evidence.annotationsAll],
  ['evidence', 'evidence.annotations({})', qk.evidence.annotations({})],
  ['evidence', 'evidence.annotations(open)', qk.evidence.annotations({ state: 'open' })],

  ['tasks', 'tasks.feed({})', qk.tasks.feed({})],
  ['tasks', 'tasks.feed(active)', qk.tasks.feed({ state: 'active' })],
  ['tasks', 'tasks.detail(recording)', qk.tasks.detail('recording', 'job-1')],
  ['tasks', 'tasks.detail(export)', qk.tasks.detail('export', 'job-1')],
  ['tasks', 'tasks.recordingJob', qk.tasks.recordingJob('job-1')],
  ['tasks', 'tasks.exportJob', qk.tasks.exportJob('job-1')],
  ['tasks', 'tasks.analysisRun', qk.tasks.analysisRun('run-1')],
  ['tasks', 'tasks.activeAnalysisRun', qk.tasks.activeAnalysisRun('demo-a')],

  ['outputs', 'outputs.list({})', qk.outputs.list({})],
  ['outputs', 'outputs.list(page2)', qk.outputs.list({ page: 2 })],
  ['outputs', 'outputs.recordedClips()', qk.outputs.recordedClips()],

  ['config', 'config.app()', qk.config.app()],
  ['config', 'config.quickCheck()', qk.config.quickCheck()],
  ['config', 'config.storage()', qk.config.storage()],
  ['config', 'config.hlae()', qk.config.hlae()],
  ['config', 'config.recovery()', qk.config.recovery()],
  ['config', 'config.runtime()', qk.config.runtime()],

  ['sessions', 'sessions.list({})', qk.sessions.list({})],
  ['sessions', 'sessions.detail', qk.sessions.detail('s-1')],
  ['sessions', 'sessions.ofObject', qk.sessions.ofObject('plan', 'P-118')],
  ['sessions', 'sessions.ofObject(output)', qk.sessions.ofObject('output', 'P-118')],
  ['sessions', 'sessions.workspaceReferences()', qk.sessions.workspaceReferences()],
  ['sessions', 'sessions.settings()', qk.sessions.settings()],
  ['sessions', 'sessions.storage()', qk.sessions.storage()],

  ['plans', 'plans.list({})', qk.plans.list({})],
  ['plans', 'plans.detail', qk.plans.detail('P-118')],
];

const NAMESPACE_ROOT: Record<QueryNamespace, readonly unknown[]> = {
  service: qk.service.all,
  demos: qk.demos.all,
  players: qk.players.all,
  evidence: qk.evidence.all,
  tasks: qk.tasks.all,
  outputs: qk.outputs.all,
  config: qk.config.all,
  sessions: qk.sessions.all,
  plans: qk.plans.all,
};

describe('qk — 键的形状', () => {
  it('spells every key out exactly, arguments in a fixed order', () => {
    expect(qk.service.health()).toEqual(['service', 'health']);

    expect(qk.demos.list({ page: 2, search: 'aurora' })).toEqual([
      'demos',
      'list',
      { page: 2, search: 'aurora' },
    ]);
    expect(qk.demos.detail('demo-a')).toEqual(['demos', 'detail', 'demo-a']);
    expect(qk.demos.metadata('demo-a')).toEqual(['demos', 'detail', 'demo-a', 'metadata']);
    expect(qk.demos.watch()).toEqual(['demos', 'watch']);
    expect(qk.demos.reviewTags()).toEqual(['demos', 'review-tags']);

    expect(qk.players.detail('7656119')).toEqual(['players', 'detail', '7656119']);
    // id first, then the sub-resource name, then its arguments — never the
    // other way round, or every profile would share one matches entry.
    expect(qk.players.matches('7656119', { page: 2, page_size: 20 })).toEqual([
      'players',
      'detail',
      '7656119',
      'matches',
      { page: 2, page_size: 20 },
    ]);
    expect(qk.players.heatmap('7656119', { map: 'de_mirage', kind: 'kills' })).toEqual([
      'players',
      'detail',
      '7656119',
      'heatmap',
      { map: 'de_mirage', kind: 'kills' },
    ]);

    expect(qk.evidence.search({ q: 'ace' })).toEqual(['evidence', 'search', { q: 'ace' }]);
    expect(qk.evidence.annotationsAll).toEqual(['evidence', 'annotations']);
    expect(qk.evidence.annotations({ state: 'open' })).toEqual([
      'evidence',
      'annotations',
      { state: 'open' },
    ]);

    expect(qk.tasks.feed({ kind: 'export' })).toEqual(['tasks', 'feed', { kind: 'export' }]);
    expect(qk.tasks.detail('recording', 'job-1')).toEqual([
      'tasks',
      'detail',
      'recording',
      'job-1',
    ]);
    expect(qk.tasks.recordingJob('job-1')).toEqual(['tasks', 'detail', 'recording', 'job-1', 'job']);
    expect(qk.tasks.exportJob('job-1')).toEqual(['tasks', 'detail', 'export', 'job-1', 'job']);
    expect(qk.tasks.analysisRun('run-1')).toEqual(['tasks', 'detail', 'analysis', 'run-1', 'run']);
    expect(qk.tasks.activeAnalysisRun('demo-a')).toEqual([
      'tasks',
      'analysis',
      'active',
      'demo-a',
    ]);

    expect(qk.outputs.list({ page: 2 })).toEqual(['outputs', 'list', { page: 2 }]);
    expect(qk.outputs.recordedClips()).toEqual(['outputs', 'recorded-clips']);

    expect(qk.config.app()).toEqual(['config', 'app']);
    expect(qk.config.runtime()).toEqual(['config', 'runtime']);

    expect(qk.sessions.ofObject('plan', 'P-118')).toEqual([
      'sessions',
      'of-object',
      'plan',
      'P-118',
    ]);
    expect(qk.plans.detail('P-118')).toEqual(['plans', 'detail', 'P-118']);
  });

  it('starts every key with its own declared namespace', () => {
    for (const [namespace, label, key] of CORPUS) {
      expect(`${label}:${String(key[0])}`).toBe(`${label}:${QUERY_NAMESPACE[namespace]}`);
    }
  });

  it('makes the namespace root a prefix of every key inside it', () => {
    for (const [namespace, label, key] of CORPUS) {
      const root = NAMESPACE_ROOT[namespace];
      expect(`${label}:${String(isKeyPrefixOf(root, key))}`).toBe(`${label}:true`);
    }
  });

  it('never collides two different calls, by TanStack’s own hash', () => {
    const seen = new Map<string, string>();
    for (const [, label, key] of CORPUS) {
      const hash = hashKey(key);
      const previous = seen.get(hash);
      expect(previous === undefined ? label : `${previous} vs ${label}`).toBe(label);
      seen.set(hash, label);
    }
    expect(seen.size).toBe(CORPUS.length);
  });
});

describe('qk — 参数进键', () => {
  it('ignores the order the query object’s own fields were written in', () => {
    // TanStack hashes objects with sorted keys, so the two spellings are one
    // cache entry. Pages therefore do not have to normalise their filter state.
    expect(hashKey(qk.demos.list({ page: 1, search: 'aurora' }))).toBe(
      hashKey(qk.demos.list({ search: 'aurora', page: 1 })),
    );
    expect(hashKey(qk.evidence.search({ q: 'ace', round: 12 }))).toBe(
      hashKey(qk.evidence.search({ round: 12, q: 'ace' })),
    );
  });

  it('separates two different filters', () => {
    expect(hashKey(qk.demos.list({}))).not.toBe(hashKey(qk.demos.list({ page: 2 })));
    expect(hashKey(qk.demos.list({ search: 'a' }))).not.toBe(
      hashKey(qk.demos.list({ search: 'b' })),
    );
    // An absent field is not the same query as an explicitly empty one.
    expect(hashKey(qk.demos.list({}))).not.toBe(hashKey(qk.demos.list({ search: '' })));
  });

  it('separates two different objects of the same kind', () => {
    expect(hashKey(qk.demos.detail('a'))).not.toBe(hashKey(qk.demos.detail('b')));
    expect(hashKey(qk.tasks.detail('recording', 'job-1'))).not.toBe(
      hashKey(qk.tasks.detail('export', 'job-1')),
    );
    expect(hashKey(qk.players.matches('a', { page: 1, page_size: 20 }))).not.toBe(
      hashKey(qk.players.matches('b', { page: 1, page_size: 20 })),
    );
  });

  it('keeps an object’s sub-resources under its detail key', () => {
    expect(isKeyPrefixOf(qk.demos.detail('demo-a'), qk.demos.metadata('demo-a'))).toBe(true);
    expect(isKeyPrefixOf(qk.demos.detail('demo-b'), qk.demos.metadata('demo-a'))).toBe(false);

    const player = qk.players.detail('7656119');
    expect(isKeyPrefixOf(player, qk.players.matches('7656119', { page: 1, page_size: 20 }))).toBe(
      true,
    );
    expect(isKeyPrefixOf(player, qk.players.maps('7656119', { page: 1, page_size: 20 }))).toBe(true);
    expect(
      isKeyPrefixOf(player, qk.players.heatmap('7656119', { map: 'de_dust2', kind: 'all' })),
    ).toBe(true);
    // …and not under a different player's.
    expect(isKeyPrefixOf(qk.players.detail('other'), qk.players.matches('7656119', {
      page: 1,
      page_size: 20,
    }))).toBe(false);

    // The raw job record hangs below the activity item it describes, so
    // invalidating the task refreshes both.
    expect(isKeyPrefixOf(qk.tasks.detail('recording', 'job-1'), qk.tasks.recordingJob('job-1'))).toBe(
      true,
    );
    expect(isKeyPrefixOf(qk.tasks.detail('export', 'job-1'), qk.tasks.exportJob('job-1'))).toBe(true);
    // A list key is not a detail key: invalidating one demo must not sweep the
    // library table.
    expect(isKeyPrefixOf(qk.demos.detail('demo-a'), qk.demos.list({}))).toBe(false);
  });
});

describe('qk — §4.1 恢复时的失效谓词', () => {
  it('agrees with the key the shell already probes on', () => {
    expect(qk.service.health()).toEqual(['service', 'health']);
  });

  it('excludes the probe and nothing else', () => {
    for (const [namespace, label, key] of CORPUS) {
      const excluded = isServiceProbeKey(key);
      expect(`${label}:${String(excluded)}`).toBe(`${label}:${String(namespace === 'service')}`);
      expect(refreshesOnServiceRecovery(key)).toBe(!excluded);
    }
  });

  it('matches ServiceGate’s inline predicate exactly', () => {
    // ServiceGate invalidates with `entry.queryKey[0] !== SERVICE_HEALTH_KEY[0]`.
    for (const [, , key] of CORPUS) {
      expect(refreshesOnServiceRecovery(key)).toBe(key[0] !== 'service');
    }
  });
});

describe('isKeyPrefixOf', () => {
  it('compares segment by segment from the front', () => {
    expect(isKeyPrefixOf(['a'], ['a', 'b'])).toBe(true);
    expect(isKeyPrefixOf(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isKeyPrefixOf(['a', 'b'], ['a'])).toBe(false);
    expect(isKeyPrefixOf(['b'], ['a', 'b'])).toBe(false);
    expect(isKeyPrefixOf([], ['a'])).toBe(true);
  });

  it('compares query objects by value, not by identity', () => {
    expect(isKeyPrefixOf(['a', { page: 1 }], ['a', { page: 1 }, 'x'])).toBe(true);
    expect(isKeyPrefixOf(['a', { page: 1 }], ['a', { page: 2 }])).toBe(false);
    expect(isKeyPrefixOf(['a', { page: 1 }], ['a', { page: 1, size: 20 }])).toBe(false);
  });

  it('does not treat a number and its string form as one segment', () => {
    expect(isKeyPrefixOf(['a', 1], ['a', '1'])).toBe(false);
  });
});
