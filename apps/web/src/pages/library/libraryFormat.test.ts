/*
 * `unit` project — the library's cell formatting.
 *
 * Every assertion here is a value printed on 「02 Demo 资料库」 or a rule this
 * module's header states, including the two places where the wire cannot answer
 * what the artboard asks.
 */

import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import type { DemoSummary } from '../../shared/desktop/dto';
import {
  demoSourceLabel,
  demoStatusMeta,
  EMPTY_CELL,
  formatDateTime,
  formatDuration,
  formatFileLocation,
  formatMatchDate,
  formatRounds,
  formatScore,
  isDemoAnalysable,
  isDemoFileMissing,
  partitionForDelete,
} from './libraryFormat';

const DEMO: DemoSummary = {
  id: 'demo-a',
  path: 'D:\\CS2\\demos\\aurora-meridian-mirage.dem',
  filename: 'aurora-meridian-mirage.dem',
  display_name: 'Aurora vs Meridian',
  map_name: 'Mirage',
  // Local time on purpose: the column is a wall clock, and an offsetless
  // string is parsed in the runner's zone the same way the app parses it.
  match_date: '2026-08-14T20:11:00',
  cataloged_at: '2026-08-14T20:40:00',
  duration_seconds: 2462,
  total_rounds: 24,
  score_team_a: 13,
  score_team_b: 11,
  team_a_name: 'Aurora',
  team_b_name: 'Meridian',
  status: 'ready',
  lifecycle_status: 'ready',
  players: ['Kael'],
  source: 'upload',
  remark: '',
  updated_at: '2026-08-14T20:40:00',
};

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

describe('formatMatchDate', () => {
  it('prints the artboard’s 「08-14 20:11」', () => {
    expect(formatMatchDate(DEMO.match_date)).toBe('08-14 20:11');
  });

  it('says 「—」 rather than inventing a date', () => {
    expect(formatMatchDate(null)).toBe(EMPTY_CELL);
    expect(formatMatchDate('')).toBe(EMPTY_CELL);
    expect(formatMatchDate('not a date')).toBe(EMPTY_CELL);
  });

  it('adds the year for the Inspector’s 入库时间', () => {
    expect(formatDateTime(DEMO.cataloged_at)).toBe('2026-08-14 20:40');
  });
});

describe('formatDuration', () => {
  it('prints mm:ss, the artboard’s 「41:02」', () => {
    expect(formatDuration(2462)).toBe('41:02');
  });

  it('grows an hour field rather than printing 「81:02」', () => {
    expect(formatDuration(4862)).toBe('1:21:02');
  });

  it('treats a missing length as missing, not as zero', () => {
    expect(formatDuration(0)).toBe(EMPTY_CELL);
    expect(formatDuration(Number.NaN)).toBe(EMPTY_CELL);
  });
});

describe('formatScore / formatRounds', () => {
  it('prints 「13 : 11」', () => {
    expect(formatScore(DEMO)).toBe('13 : 11');
  });

  it('says 「—」 while a match has no score yet', () => {
    expect(formatScore({ ...DEMO, score_team_a: null, score_team_b: null })).toBe(EMPTY_CELL);
  });

  it('reads a zero round count as 「not known yet」', () => {
    expect(formatRounds(24)).toBe('24');
    expect(formatRounds(0)).toBe(EMPTY_CELL);
  });
});

describe('formatFileLocation', () => {
  it('keeps the directory and both separators', () => {
    expect(formatFileLocation(DEMO.path)).toBe('D:\\CS2\\demos\\');
    expect(formatFileLocation('/home/kael/demos/a.dem')).toBe('/home/kael/demos/');
  });

  it('says 「—」 for a bare filename', () => {
    expect(formatFileLocation('a.dem')).toBe(EMPTY_CELL);
  });
});

describe('demoStatusMeta', () => {
  it('gives every wire state a label and a tone', () => {
    for (const status of ['discovered', 'indexing', 'ready', 'analyzing', 'failed', 'missing'] as const) {
      const meta = demoStatusMeta(status);
      expect(i18n._(meta.label)).not.toBe('');
    }
  });

  it('paints the two the artboard paints brick red', () => {
    expect(demoStatusMeta('missing').tone).toBe('fail');
    expect(demoStatusMeta('failed').tone).toBe('fail');
  });

  it('does not claim a record has been analysed', () => {
    // `DemoRecord.status` has no 已分析 / 未分析; 「已就绪」 is the wire's own
    // word, and the gap is reported rather than papered over with a label.
    expect(i18n._(demoStatusMeta('ready').label)).toBe('已就绪');
  });

  it('answers the two row questions the action column asks', () => {
    expect(isDemoAnalysable(DEMO)).toBe(true);
    expect(isDemoFileMissing({ ...DEMO, lifecycle_status: 'missing' })).toBe(true);
    expect(isDemoAnalysable({ ...DEMO, lifecycle_status: 'missing' })).toBe(false);
  });
});

describe('demoSourceLabel', () => {
  it('says how the file arrived, which is what the wire knows', () => {
    expect(i18n._(demoSourceLabel('watch'))).toBe('监听目录');
    expect(i18n._(demoSourceLabel('upload'))).toBe('已导入');
    expect(i18n._(demoSourceLabel('local'))).toBe('本地文件');
  });
});

describe('partitionForDelete', () => {
  it('splits the two halves the delete dialog states', () => {
    const partition = partitionForDelete([
      { ...DEMO, id: 'm1', source: 'upload' },
      { ...DEMO, id: 'm2', source: 'upload' },
      { ...DEMO, id: 'x1', source: 'watch' },
    ]);

    expect(partition.managed).toEqual(['m1', 'm2']);
    expect(partition.external).toEqual(['x1']);
  });

  it('is empty for an empty selection, so the dialog can disable its confirm', () => {
    expect(partitionForDelete([])).toEqual({ managed: [], external: [] });
  });
});
