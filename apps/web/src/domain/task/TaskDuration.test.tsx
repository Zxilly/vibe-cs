import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { TaskDuration } from './TaskDuration';
import { taskDuration, taskDurationFor } from './duration';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('TaskDuration', () => {
  it('says 用时 for a task that is over — the artboard sentence, verbatim', () => {
    const markup = renderMarkup(<TaskDuration value={taskDuration(6 * MINUTE + 41 * SECOND, 'total')} />);

    expect(markup).toContain('用时');
    expect(markup).toContain('6 分');
    expect(markup).toContain('41 秒');
    expect(markup).not.toContain('已用');
  });

  it('says 已用 for a task still running — a different claim, not a shorter one', () => {
    const markup = renderMarkup(<TaskDuration value={taskDuration(MINUTE + 52 * SECOND, 'elapsed')} />);

    expect(markup).toContain('已用');
    expect(markup).toContain('1 分');
    expect(markup).toContain('52 秒');
    expect(markup).not.toContain('用时');
  });

  it('picks the wording from the task status, so a call site cannot get it wrong', () => {
    const running = renderMarkup(<TaskDuration value={taskDurationFor(90 * SECOND, 'running')} />);
    const stopped = renderMarkup(<TaskDuration value={taskDurationFor(90 * SECOND, 'succeeded')} />);

    expect(running).toContain('已用');
    expect(stopped).toContain('用时');
  });

  it('refuses to print 「0 秒」 for something that took under a second', () => {
    const markup = renderMarkup(<TaskDuration value={taskDuration(400, 'total')} />);

    expect(markup).toContain('不足 1 秒');
    expect(markup).not.toContain('0 秒');
  });

  it('prints a real zero as 0 秒', () => {
    expect(renderMarkup(<TaskDuration value={taskDuration(0, 'total')} />)).toContain('0 秒');
  });

  it('stops at two units past an hour', () => {
    const markup = renderMarkup(<TaskDuration value={taskDuration(HOUR + 12 * MINUTE + 33 * SECOND, 'total')} />);

    expect(markup).toContain('1 小时');
    expect(markup).toContain('12 分');
    expect(markup).not.toContain('33 秒');
  });

  it('carries a machine-readable duration and its kind on the element', () => {
    const markup = renderMarkup(<TaskDuration value={taskDuration(401 * SECOND, 'elapsed')} />);

    // React 19 emits the attribute in its JSX spelling; HTML attribute names
    // are case-insensitive, so the assertion is too.
    expect(markup).toMatch(/datetime="PT401S"/iu);
    expect(markup).toContain('data-duration-kind="elapsed"');
  });
});
