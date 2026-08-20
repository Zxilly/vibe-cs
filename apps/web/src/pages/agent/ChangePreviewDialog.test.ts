import { describe, expect, it } from 'vitest';

import type { RecordedClipRecord } from '../../shared/desktop/dto';
import { takeForShot } from './ChangePreviewDialog';

function take(id: string, requestId: string | null): RecordedClipRecord {
  return {
    id,
    title: id,
    path: `C:/recordings/${id}.mp4`,
    player_name: null,
    map_name: 'de_mirage',
    duration_seconds: 8,
    created_at: '2026-08-20T00:00:00.000Z',
    stream_url: `/api/recorded-clips/${id}/stream`,
    demo_id: 'demo-1',
    category: 'agent',
    tags: [],
    metadata: requestId === null ? {} : { request_id: requestId },
  };
}

describe('takeForShot', () => {
  it('returns the real recorded result bound to the plan shot request', () => {
    const unrelated = take('clip-1', 'shot-01');
    const matching = take('clip-2', 'shot-02');

    expect(takeForShot([unrelated, matching], 'shot-02')).toBe(matching);
  });

  it('does not substitute an unrelated clip or malformed metadata', () => {
    expect(takeForShot([take('clip-1', 'shot-01'), take('clip-2', null)], 'shot-02')).toBeNull();
  });
});
