import { describe, expect, it } from 'vitest';

import { parseAnalysisRun, parseAnalysisRunDetail } from './analysisRunContract';

const run = () => ({
  id: 'run-1',
  demo_id: 'demo-1',
  input_sha256: null,
  input_size: null,
  status: 'queued',
  stage: 'validating_input',
  error: null,
  created_at: '2026-08-13T01:00:00Z',
  updated_at: '2026-08-13T01:00:00Z',
});

describe('analysis run wire contract', () => {
  it('accepts only the complete current run shape', () => {
    expect(parseAnalysisRun(run())).toEqual(run());
    const { input_sha256: _missing, ...incomplete } = run();
    expect(() => parseAnalysisRun(incomplete)).toThrow('current contract');
    expect(() => parseAnalysisRun({ ...run(), progress_percent: 12 })).toThrow('current contract');
    expect(() => parseAnalysisRun({ ...run(), input_sha256: 'abc', input_size: 42 }))
      .toThrow('current contract');
  });

  it('bounds persisted events and requires their nullable detail', () => {
    const event = {
      run_id: 'run-1', sequence: 0, stage: 'validating_input',
      message_code: 'input_validation_started', detail: null,
      created_at: '2026-08-13T01:00:00Z',
    };
    expect(parseAnalysisRunDetail({ run: run(), events: [event], result_available: false }))
      .toMatchObject({ events: [event] });
    expect(() => parseAnalysisRunDetail({ run: run(), events: [], result_available: false }))
      .toThrow('current contract');
    expect(() => parseAnalysisRunDetail({
      run: run(), events: Array.from({ length: 33 }, () => event), result_available: false,
    })).toThrow('current contract');
    const { detail: _missing, ...incompleteEvent } = event;
    expect(() => parseAnalysisRunDetail({
      run: run(), events: [incompleteEvent], result_available: false,
    })).toThrow('current contract');
    expect(() => parseAnalysisRunDetail({
      run: run(), events: [{ ...event, stage: 'parser_running' }], result_available: false,
    })).toThrow('current contract');
  });

  it('rejects event histories that skip a proven stage boundary', () => {
    const current = {
      ...run(), input_sha256: 'a'.repeat(64), input_size: 42,
      status: 'running', stage: 'parser_running',
    };
    expect(() => parseAnalysisRunDetail({
      run: current,
      events: [{
        run_id: 'run-1', sequence: 0, stage: 'validating_input',
        message_code: 'input_validation_started', detail: null,
        created_at: '2026-08-13T01:00:00Z',
      }, {
        run_id: 'run-1', sequence: 1, stage: 'parser_running',
        message_code: 'parser_started', detail: null,
        created_at: '2026-08-13T01:01:00Z',
      }],
      result_available: false,
    })).toThrow('current contract');
  });

  it('rejects a result projection attached to a non-completed run', () => {
    expect(() => parseAnalysisRunDetail({
      run: run(),
      events: [{
        run_id: 'run-1', sequence: 0, stage: 'validating_input',
        message_code: 'input_validation_started', detail: null,
        created_at: '2026-08-13T01:00:00Z',
      }],
      result_available: true,
    })).toThrow('current contract');
  });
});
