import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { StageTimeline, recordingTaskStages } from './StageTimeline';

const SECOND = 1000;

/** The recording run the task detail artboard draws, stage by stage. */
const RUN = recordingTaskStages([
  { state: 'done', at: '2026-08-15T09:05:00Z', durationMs: 12 * SECOND },
  { state: 'done', at: '2026-08-15T09:05:40Z', durationMs: 8 * SECOND },
  {
    state: 'done',
    at: '2026-08-15T09:06:00Z',
    durationMs: 3 * SECOND,
    note: '片段 3 重试 1 次后成功 · 观察者视角短暂丢失',
  },
  { state: 'done', at: '2026-08-15T09:10:00Z' },
  { state: 'done', at: '2026-08-15T09:11:00Z' },
  { state: 'done', at: '2026-08-15T09:12:00Z' },
]);

describe('recordingTaskStages', () => {
  it('takes the six stage names from the design layer, in order', () => {
    expect(RUN.map((stage) => stage.id)).toEqual(['launch', 'seek', 'capture', 'settle', 'encode', 'publish']);
  });

  it('leaves the stages the caller said nothing about not started', () => {
    const partial = recordingTaskStages([{ state: 'done' }, { state: 'active' }]);

    expect(partial).toHaveLength(6);
    expect(partial.map((stage) => stage.state)).toEqual(
      ['done', 'active', 'pending', 'pending', 'pending', 'pending'],
    );
  });
});

describe('StageTimeline', () => {
  it('wraps the design system’s bar rather than redrawing it', () => {
    const markup = renderMarkup(<StageTimeline label="录制阶段" stages={RUN} timeZone="UTC" />);

    // StageBar's own contract: a named ordered list, one item per stage, each
    // segment painted from a token and each state also stated in words.
    expect(markup).toContain('<ol aria-label="录制阶段"');
    expect(markup.match(/data-stage="/gu) ?? []).toHaveLength(6);
    expect(markup).toContain('bg-ok');
    expect(markup).toContain('已完成');
    for (const stage of ['启动', '跳转', '采集', '稳定', '编码', '发布']) {
      expect(markup, stage).toContain(stage);
    }
  });

  it('adds what the bar does not carry: the stamp of each stage', () => {
    const markup = renderMarkup(<StageTimeline label="录制阶段" stages={RUN} timeZone="UTC" />);

    expect(markup).toContain('09:05');
    expect(markup).toContain('09:12');
    expect(markup.match(/data-stage-meta="/gu) ?? []).toHaveLength(6);
  });

  it('adds each stage’s duration, read as elapsed while the stage is running', () => {
    const running = recordingTaskStages([
      { state: 'done', durationMs: 12 * SECOND },
      { state: 'active', durationMs: 4 * SECOND },
    ]);
    const markup = renderMarkup(<StageTimeline label="录制阶段" stages={running} timeZone="UTC" />);

    expect(markup).toContain('data-duration-kind="total"');
    expect(markup).toContain('data-duration-kind="elapsed"');
  });

  it('prints the failure point as a sentence under the bar, not inside a 6px segment', () => {
    const failed = recordingTaskStages([
      { state: 'done' },
      { state: 'done' },
      { state: 'failed', note: '观察者视角丢失，已达重试上限' },
    ]);
    const markup = renderMarkup(<StageTimeline label="录制阶段" stages={failed} timeZone="UTC" />);

    expect(markup).toContain('data-stage-note="capture"');
    expect(markup).toContain('观察者视角丢失，已达重试上限');
    expect(markup).toContain('text-fail-text');
  });

  it('keeps a note about a stage that did not fail in the neutral voice', () => {
    const markup = renderMarkup(<StageTimeline label="录制阶段" stages={RUN} timeZone="UTC" />);

    expect(markup).toContain('data-stage-note="capture"');
    expect(markup).toContain('片段 3 重试 1 次后成功');
    expect(markup).not.toContain('text-fail-text');
  });

  it('renders nothing for a task kind that has no drawn stage sequence', () => {
    // 导出 and 下载 have none — an empty 172px placeholder inside a task record
    // would claim something is missing when nothing is.
    expect(renderMarkup(<StageTimeline label="任务阶段" stages={[]} />)).toBe('');
  });

  it('skips the meta row entirely when no stage carried a time or a duration', () => {
    const bare = recordingTaskStages([{ state: 'active' }]);
    const markup = renderMarkup(<StageTimeline label="录制阶段" stages={bare} />);

    expect(markup).toContain('<ol aria-label="录制阶段"');
    expect(markup).not.toContain('data-stage-meta=');
  });
});
