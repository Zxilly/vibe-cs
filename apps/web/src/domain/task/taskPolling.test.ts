/*
 * `unit` project — the three cadences phase 3a settled (§10.3 gap 1).
 *
 * The numbers themselves are a judgement, and a test cannot check a judgement.
 * What it can check is the shape of the judgement: three distinct cadences,
 * ordered by how closely the surface is being watched, all of them slow enough
 * that a stuck interval cannot become a busy loop. Those are the properties
 * that break if someone copies the wrong constant into a new page.
 */

import { describe, expect, it } from 'vitest';

import {
  TASK_POLL_DETAIL_MS,
  TASK_POLL_DIGEST_MS,
  TASK_POLL_FEED_MS,
  TASK_POLL_MS,
} from './taskPolling';

describe('task poll cadences', () => {
  it('watches the detail page most closely and the workbench least', () => {
    expect(TASK_POLL_DETAIL_MS).toBeLessThan(TASK_POLL_FEED_MS);
    expect(TASK_POLL_FEED_MS).toBeLessThan(TASK_POLL_DIGEST_MS);
  });

  it('never polls faster than a recording stage lasts', () => {
    // 「片段 1 采集完成 · 3.0 秒」 is the shortest thing worth noticing; one
    // second would be two requests per stage and no more information.
    expect(TASK_POLL_DETAIL_MS).toBeGreaterThanOrEqual(2_000);
  });

  it('exposes the same three numbers as a table', () => {
    expect(TASK_POLL_MS).toEqual({
      digest: TASK_POLL_DIGEST_MS,
      feed: TASK_POLL_FEED_MS,
      detail: TASK_POLL_DETAIL_MS,
    });
  });
});
