import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { RECORDING_STAGE_IDS, StageBar, recordingStages, type StageState } from './StageBar';

describe('recordingStages', () => {
  it('names the six stages of the artboard in order', () => {
    const markup = renderMarkup(
      <StageBar label="录制阶段" stages={recordingStages(['done', 'done', 'active', 'pending', 'pending', 'pending'])} />,
    );

    const labels = ['启动', '跳转', '采集', '稳定', '编码', '发布'];
    let cursor = -1;
    for (const label of labels) {
      const index = markup.indexOf(label, cursor + 1);
      expect(index, label).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('treats a state the caller left out as not started', () => {
    const stages = recordingStages([]);

    expect(stages).toHaveLength(RECORDING_STAGE_IDS.length);
    expect(stages.every((stage) => stage.state === 'pending')).toBe(true);
  });
});

describe('StageBar', () => {
  const running = recordingStages(['done', 'done', 'active', 'pending', 'pending', 'pending']);

  it('is a named ordered list, one item per stage', () => {
    const markup = renderMarkup(<StageBar label="录制阶段" stages={running} />);

    expect(markup).toContain('<ol aria-label="录制阶段"');
    expect(markup.match(/<li /gu) ?? []).toHaveLength(6);
  });

  it('marks the running stage as the current step', () => {
    const markup = renderMarkup(<StageBar label="录制阶段" stages={running} />);

    expect(markup.match(/aria-current="step"/gu) ?? []).toHaveLength(1);
    expect(markup).toMatch(/data-stage="capture"[^>]*aria-current="step"/u);
  });

  it('paints each state from its own token', () => {
    const stages = recordingStages(['done', 'failed', 'active', 'pending', 'pending', 'pending']);
    const markup = renderMarkup(<StageBar label="录制阶段" stages={stages} />);

    expect(markup).toContain('bg-ok');
    expect(markup).toContain('bg-fail');
    expect(markup).toContain('bg-accent');
    expect(markup).toContain('bg-neutral-200');
  });

  it('says each state in words as well as in colour', () => {
    const stages = recordingStages(['done', 'failed', 'active', 'pending', 'pending', 'pending']);
    const markup = renderMarkup(<StageBar label="录制阶段" stages={stages} />);

    for (const word of ['已完成', '失败', '进行中', '未开始']) {
      expect(markup, word).toContain(`class="sr-only">${word}`);
    }
  });

  it('keeps the drawn 6px track and equal segments', () => {
    const markup = renderMarkup(<StageBar label="录制阶段" stages={running} />);

    expect(markup).toContain('h-[6px]');
    expect(markup).toContain('auto-cols-fr');
  });

  it('carries no progress semantics — the bar is a sequence, not a ratio', () => {
    const markup = renderMarkup(<StageBar label="录制阶段" stages={running} />);

    // 「有真实分母时才用进度条，否则只给阶段名」: a StageBar must never claim to
    // be one, or a screen reader would announce an invented percentage.
    expect(markup).not.toContain('progressbar');
    expect(markup).not.toContain('aria-valuenow');
  });

  it('accepts a shorter sequence for task types with fewer stages', () => {
    const analysis = (['done', 'done', 'active', 'pending', 'pending'] as StageState[]).map((state, index) => ({
      id: `stage-${String(index)}`,
      label: `阶段 ${String(index + 1)}`,
      state,
    }));
    const markup = renderMarkup(<StageBar label="分析阶段" stages={analysis} />);

    expect(markup.match(/<li /gu) ?? []).toHaveLength(5);
  });
});
