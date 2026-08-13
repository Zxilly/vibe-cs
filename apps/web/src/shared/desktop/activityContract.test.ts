import { describe, expect, it } from 'vitest';

import { parseActivityFeed, parseActivityItem } from './activityContract';

const jobId = '11111111-1111-4111-8111-111111111111';

const item = () => ({
  id: `export:${jobId}`,
  kind: 'export',
  subtype: 'editor',
  job_id: jobId,
  context_id: '22222222-2222-4222-8222-222222222222',
  subject: 'C:/exports/exact.mp4',
  status: 'running',
  stage: null,
  progress_percent: 42,
  completed_units: null,
  total_units: null,
  unit: null,
  error: null,
  created_at: '2026-08-13T01:00:00Z',
  updated_at: '2026-08-13T01:01:00Z',
  available_actions: ['cancel', 'open_outputs'],
});

describe('activity wire contract', () => {
  it('accepts only the complete exact current item shape', () => {
    expect(parseActivityItem(item())).toEqual(item());
    const { stage: _missing, ...incomplete } = item();
    expect(() => parseActivityItem(incomplete)).toThrow('current contract');
    expect(() => parseActivityItem({ ...item(), retired_progress: 42 }))
      .toThrow('current contract');
  });

  it('binds the copyable activity locator to one canonical durable job identity', () => {
    for (const invalid of [
      { ...item(), id: `recording:${jobId}` },
      { ...item(), job_id: null },
      { ...item(), job_id: 'not-a-uuid', id: 'export:not-a-uuid' },
    ]) {
      expect(() => parseActivityItem(invalid)).toThrow('current contract');
    }
  });

  it('rejects fabricated progress and incomplete unit measurements', () => {
    for (const invalid of [
      { ...item(), progress_percent: 101 },
      { ...item(), progress_percent: 1.5 },
      { ...item(), completed_units: 4, unit: null },
      { ...item(), completed_units: null, total_units: 5, unit: 'stages' },
      { ...item(), completed_units: 6, total_units: 5, unit: 'stages' },
    ]) {
      expect(() => parseActivityItem(invalid)).toThrow('current contract');
    }
  });

  it('does not widen each activity kind into another projection progress model', () => {
    const recordingId = '44444444-4444-4444-8444-444444444444';
    const downloadId = '55555555-5555-4555-8555-555555555555';
    for (const invalid of [
      {
        ...item(), id: `recording:${recordingId}`, kind: 'recording', subtype: null,
        job_id: recordingId,
      },
      { ...item(), completed_units: 2, total_units: 5, unit: 'stages' },
      {
        ...item(), id: `download:${downloadId}`, kind: 'download', subtype: null,
        job_id: downloadId, completed_units: 2, total_units: 5, unit: 'stages',
        available_actions: ['cancel', 'open_match_history'],
      },
    ]) {
      expect(() => parseActivityItem(invalid)).toThrow('current contract');
    }
  });

  it('rejects action sets that contradict the persisted status projection', () => {
    for (const invalid of [
      { ...item(), status: 'completed', progress_percent: 100 },
      { ...item(), available_actions: ['open_outputs'] },
      { ...item(), status: 'failed', progress_percent: null, available_actions: ['cancel', 'open_outputs'] },
    ]) {
      expect(() => parseActivityItem(invalid)).toThrow('current contract');
    }
  });

  it('keeps analysis interruption as failed activity truth without a fake percentage', () => {
    const runId = '33333333-3333-4333-8333-333333333333';
    const interrupted = {
      ...item(),
      id: `analysis:${runId}`,
      kind: 'analysis',
      subtype: null,
      job_id: runId,
      status: 'failed',
      stage: 'interrupted',
      progress_percent: null,
      available_actions: ['retry_analysis', 'open_library'],
    };
    expect(parseActivityItem(interrupted)).toEqual(interrupted);
    expect(() => parseActivityItem({ ...interrupted, progress_percent: 50 }))
      .toThrow('current contract');
    expect(() => parseActivityItem({ ...interrupted, status: 'cancelled' }))
      .toThrow('current contract');
    expect(() => parseActivityItem({ ...interrupted, available_actions: ['retry_recording'] }))
      .toThrow('current contract');
  });

  it('accepts only a bounded exact activity feed envelope', () => {
    const feed = {
      items: [item()],
      total: 1,
      page: 1,
      page_size: 50,
      summary: { total: 1, active: 1, failed: 0, completed: 0 },
    };
    expect(parseActivityFeed(feed)).toEqual(feed);
    expect(() => parseActivityFeed({ ...feed, cursor: null })).toThrow('current contract');
    expect(() => parseActivityFeed({ ...feed, page_size: 101 })).toThrow('current contract');
    expect(() => parseActivityFeed({ ...feed, items: [...feed.items, ...feed.items], total: 1 }))
      .toThrow('current contract');
    expect(() => parseActivityFeed({ ...feed, summary: { ...feed.summary, total: 0 } }))
      .toThrow('current contract');
    expect(() => parseActivityFeed({
      ...feed, summary: { total: 1, active: 1, failed: 1, completed: 0 },
    })).toThrow('current contract');
  });
});
