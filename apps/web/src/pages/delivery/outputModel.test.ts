/*
 * `unit` project — the arithmetic behind an output card.
 */

import { describe, expect, it } from 'vitest';

import type { OutputItem } from '../../shared/desktop/dto';
import {
  formatBytes,
  formatOutputMedia,
  outputDeletionRemovesFile,
  outputFamilyOf,
  outputFileIsUsable,
} from './outputModel';

const OUTPUT: OutputItem = {
  id: 'out-1',
  output_kind: 'recording',
  media_kind: 'clip',
  title: 'Kael 1v3',
  status: 'completed',
  progress: 1,
  path: 'D:\\vibe\\outputs\\Kael_Mirage_1v3.mp4',
  file_name: 'Kael_Mirage_1v3.mp4',
  availability: 'present',
  managed: true,
  mutable: true,
  size_bytes: 186_000_000,
  media: null,
  project_id: null,
  agent_plan_id: null,
  demo_id: 'demo-1',
  error: null,
  created_at: '2026-08-15T09:12:00.000Z',
  updated_at: '2026-08-15T09:12:00.000Z',
};

describe('formatBytes', () => {
  it('writes the artboard s own forms', () => {
    expect(formatBytes(186_000_000)).toBe('186 MB');
    expect(formatBytes(4_200_000_000)).toBe('4.2 GB');
    expect(formatBytes(218_000_000_000)).toBe('218 GB');
  });

  it('keeps a decimal only below ten inside a unit', () => {
    expect(formatBytes(1_500)).toBe('1.5 KB');
    expect(formatBytes(15_000)).toBe('15 KB');
  });

  it('never rounds bytes into a decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('says nothing rather than zero when the size is unknown', () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(Number.NaN)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
  });
});

describe('availability', () => {
  it('treats only a present file as usable', () => {
    expect(outputFileIsUsable('present')).toBe(true);
    expect(outputFileIsUsable('missing')).toBe(false);
    // `unsafe` means the service refused the path; acting on it is the one
    // thing that must not happen.
    expect(outputFileIsUsable('unsafe')).toBe(false);
  });

  it('only a managed, present file is at risk from a delete', () => {
    expect(outputDeletionRemovesFile(OUTPUT)).toBe(true);
    expect(outputDeletionRemovesFile({ ...OUTPUT, managed: false })).toBe(false);
    expect(outputDeletionRemovesFile({ ...OUTPUT, availability: 'missing' })).toBe(false);
  });
});

describe('outputFamilyOf', () => {
  it('splits the montage out of the export pipeline, as the artboard does', () => {
    expect(outputFamilyOf(OUTPUT)).toBe('recording');
    expect(outputFamilyOf({ ...OUTPUT, output_kind: 'export', media_kind: 'editor' })).toBe('export');
    expect(outputFamilyOf({ ...OUTPUT, output_kind: 'export', media_kind: 'montage' })).toBe('montage');
  });
});

describe('formatOutputMedia', () => {
  it('prints actual duration, resolution, rational frame rate and codecs', () => {
    expect(formatOutputMedia({
      width: 1920,
      height: 1080,
      duration_seconds: 8.75,
      frame_rate: '60000/1001',
      video_codec: 'h264',
      audio_codec: 'aac',
    })).toEqual(['8.75 s', '1920×1080', '59.94 fps', 'H264 / AAC']);
  });
});
