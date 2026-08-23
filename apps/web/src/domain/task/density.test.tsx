/*
 * 1100 × 700 density review — `domain/task/` (spec §9 risk 6).
 *
 * The 任务记录 rail is the longest list in the product that is not a table: the
 * retention default on 「12 设置与诊断」 is 「最近 50 条」, so fifty cards is the
 * steady state and not the outlier. A card is not one row — it is a heading, a
 * status sentence, a bar or a stage strip, sometimes a `Notice`, and a row of
 * links — so the two things to check are that nothing in it is unbounded and
 * that the failures inside a long list stay individually recoverable.
 *
 * `TaskDetail` has the other problem: its 阶段日志 is the only place in the
 * directory where content grows without limit, and it sits inside a 700px
 * window.
 */

import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import {
  CONCURRENT_TASK_COUNT,
  STAGE_LOG_ENTRY_COUNT,
  TASK_RECORD_COUNT,
  makeTaskLog,
  makeTasks,
} from '../densityFixtures';
import { StageTimeline, recordingTaskStages } from './StageTimeline';
import { TaskCard } from './TaskCard';
import { TaskDetail } from './TaskDetail';

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

const tasks = makeTasks(TASK_RECORD_COUNT);

describe('density · the 任务记录 rail at its retention limit', () => {
  it('draws all fifty records, five of them still running', () => {
    const html = renderMarkup(
      <div>
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>,
    );

    expect(occurrences(html, 'data-task=')).toBe(TASK_RECORD_COUNT);
    expect(occurrences(html, 'data-task-status="running"')).toBe(CONCURRENT_TASK_COUNT);
    // 「有真实分母时才用进度条」: only the running ones have one, so only they
    // draw a bar. The rest do not fabricate one.
    expect(occurrences(html, 'role="progressbar"')).toBe(CONCURRENT_TASK_COUNT);
  });

  it('truncates the subject and never the id', () => {
    const html = renderMarkup(
      <div>
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>,
    );

    const cards = html.split('<article').slice(1);
    expect(cards).toHaveLength(TASK_RECORD_COUNT);
    for (const card of cards) {
      // 类型 · 目标对象 is user-supplied and long; 「#A-2481」 is how a person
      // names the task to somebody else and may not be clipped.
      expect(card).toContain('truncate');
      expect(card).toMatch(/#A-\d+/u);
    }
  });

  it('keeps every failure in the long list individually recoverable', () => {
    const failures = tasks.filter((task) => task.status === 'failed');
    expect(failures.length).toBeGreaterThan(0);

    const html = renderMarkup(
      <div>
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>,
    );

    // One `Notice` per failure, each with its own 释放空间 button — not one
    // banner at the top of the rail standing in for all of them.
    expect(occurrences(html, '释放空间')).toBe(failures.length);
  });
});

describe('density · TaskDetail with a full stage log', () => {
  const task = tasks[0];

  it('scrolls a 120-line log inside the panel instead of past the window', () => {
    expect(task).toBeDefined();
    if (task === undefined) return;

    const entries = makeTaskLog(STAGE_LOG_ENTRY_COUNT);
    const html = renderMarkup(
      <TaskDetail
        task={task}
        stages={recordingTaskStages([
          { state: 'done' },
          { state: 'done' },
          { state: 'active' },
        ])}
        log={{ status: 'ready', entries }}
        facts={[{ id: 'duration', label: '用时', value: '6 分 41 秒' }]}
      />,
    );

    expect(occurrences(html, '<li')).toBeGreaterThanOrEqual(STAGE_LOG_ENTRY_COUNT);
    // 120 lines at ~28px is ~3400px inside a 700px window.
    expect(STAGE_LOG_ENTRY_COUNT * 28).toBeGreaterThan(3000);

    // The log's own `<ol>`, not `StageBar`'s — the stage bar is an `<ol>` too.
    const afterHeading = html.slice(html.indexOf('阶段日志'));
    const list = afterHeading.slice(afterHeading.indexOf('<ol'));
    const listClass = /class="([^"]*)"/u.exec(list)?.[1] ?? '';
    expect(listClass).toContain('overflow-y-auto');
    expect(listClass).toContain('min-h-0');
    // …and the column above it has to be allowed to shrink, or the scroll never
    // engages and the overflow goes back out to the page.
    expect(html).toContain('flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4');
  });

  it('keeps the wider fact rail bounded while technical values wrap', () => {
    expect(task).toBeDefined();
    if (task === undefined) return;

    const html = renderMarkup(
      <TaskDetail
        task={task}
        facts={[{ id: 'source', label: '来源 Demo', value: 'D:\\CS2\\replays\\一个很长的文件名.dem' }]}
        technicalDetails={[{ id: 'encoder', label: '编码参数', value: 'libx264 crf=18 preset=slow tune=film' }]}
      />,
    );

    // User-facing facts still truncate. Diagnostic paths use the wider rail
    // and wrap, so a bug report keeps the exact value rather than an ellipsis.
    expect(occurrences(html, 'truncate')).toBeGreaterThanOrEqual(2);
    expect(html).toContain('lg:w-[var(--w-inspector-wide)]');
    expect(html).toContain('break-all font-mono');
  });
});

describe('density · StageTimeline stays on one grid', () => {
  it('lays six stages and their meta on the same six columns', () => {
    const html = renderMarkup(
      <StageTimeline
        label="任务阶段"
        stages={recordingTaskStages([
          { state: 'done', at: '2026-08-14T09:06:00.000Z', durationMs: 3000 },
          { state: 'done', at: '2026-08-14T09:07:00.000Z', durationMs: 4000 },
          { state: 'done', at: '2026-08-14T09:08:00.000Z', durationMs: 5000 },
          { state: 'failed', at: '2026-08-14T09:09:00.000Z', note: '观察者视角短暂丢失' },
          { state: 'pending' },
          { state: 'pending' },
        ])}
      />,
    );

    // `auto-cols-fr` on both rows: six stages share the width evenly however
    // narrow the panel gets, so the meta under a segment cannot drift off it.
    expect(occurrences(html, 'auto-cols-fr')).toBe(2);
    expect(occurrences(html, 'data-stage-meta=')).toBe(6);
    // A stage note is a sentence and lives under the bar, not inside a 6px
    // segment — so it wraps instead of overflowing.
    expect(html).toContain('data-stage-note=');
  });
});
