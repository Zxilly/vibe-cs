/**
 * `unit` project — the two knobs a caller may turn on a read.
 */

import { describe, expect, it } from 'vitest';

import { resolveQueryTuning } from './queryTuning';

describe('resolveQueryTuning', () => {
  it('enables the query and polls never by default (§4.1 sets no interval)', () => {
    expect(resolveQueryTuning()).toEqual({
      enabled: true,
      refetchInterval: false,
      refetchIntervalInBackground: false,
    });
  });

  it('requires the hook’s own gate and the caller to agree', () => {
    // The hook knows whether it has arguments; the caller knows whether the
    // page wants the read yet. Either one may veto.
    expect(resolveQueryTuning({}, { enabled: false }).enabled).toBe(false);
    expect(resolveQueryTuning({ enabled: false }, { enabled: true }).enabled).toBe(false);
    expect(resolveQueryTuning({ enabled: true }, { enabled: false }).enabled).toBe(false);
    expect(resolveQueryTuning({ enabled: true }, { enabled: true }).enabled).toBe(true);
  });

  it('treats an explicit undefined as "not specified"', () => {
    expect(resolveQueryTuning({ enabled: undefined, pollMs: undefined })).toEqual({
      enabled: true,
      refetchInterval: false,
      refetchIntervalInBackground: false,
    });
  });

  it('passes a positive interval through', () => {
    expect(resolveQueryTuning({ pollMs: 3_000 }).refetchInterval).toBe(3_000);
  });

  it('refuses to hand TanStack a zero or negative interval', () => {
    // `refetchInterval: 0` in TanStack means "as fast as the event loop
    // allows", which on an IPC bridge is a busy loop, not a poll.
    expect(resolveQueryTuning({ pollMs: 0 }).refetchInterval).toBe(false);
    expect(resolveQueryTuning({ pollMs: -1 }).refetchInterval).toBe(false);
    expect(resolveQueryTuning({ pollMs: Number.NaN }).refetchInterval).toBe(false);
    expect(resolveQueryTuning({ pollMs: Number.POSITIVE_INFINITY }).refetchInterval).toBe(false);
    expect(resolveQueryTuning({ pollMs: false }).refetchInterval).toBe(false);
  });

  it('never polls a window nobody is looking at', () => {
    expect(resolveQueryTuning({ pollMs: 3_000 }).refetchIntervalInBackground).toBe(false);
  });
});
