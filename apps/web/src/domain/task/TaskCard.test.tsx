import { describe, expect, it } from 'vitest';

import { recordingStages } from '../../design/feedback';
import { renderMarkup } from '../../test/render';
import { TaskCard, TaskCardSkeleton } from './TaskCard';
import { taskStageStates } from './taskStages';
import type { TaskSummary } from './types';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** 「录制 · Kael_Mirage_1v3 · 已完成 · 09:12 · 用时 6 分 41 秒」, the first rail entry. */
const DONE: TaskSummary = {
  id: '#A-2481',
  kind: 'recording',
  status: 'succeeded',
  subject: 'Kael_Mirage_1v3',
  startedAt: '2026-08-15T09:12:00Z',
  durationMs: 6 * MINUTE + 41 * SECOND,
  artifacts: [{ id: 'out', label: '查看结果 Kael_Mirage_1v3.mp4', href: '#/delivery/outputs/1' }],
};

/** 「分析 · Kestrel vs Halcyon · 运行中 · 阶段 3/5 位置采样 · 已用 1 分 52 秒」. */
const RUNNING: TaskSummary = {
  id: '#N-908',
  kind: 'analysis',
  status: 'running',
  subject: 'Kestrel vs Halcyon',
  startedAt: '2026-08-15T08:50:00Z',
  durationMs: MINUTE + 52 * SECOND,
  stage: { id: 'projecting', label: '位置采样', index: 3, count: 5 },
  progress: { completed: 62, total: 100, unit: 'percent' },
};

/** 「导出 · Aurora 赛点集锦 · 失败 · 磁盘空间不足 · 08-15 08:40」. */
const FAILED: TaskSummary = {
  id: '#E-131',
  kind: 'export',
  status: 'failed',
  subject: 'Aurora 赛点集锦',
  startedAt: '2026-08-15T08:40:00Z',
  failure: {
    reason: 'disk-space',
    impact: '影响范围：仅这一次导出，工程与素材已保留。释放 4.2 GB 后可重试。',
    recovery: { label: '重试导出', onAction: () => undefined },
  },
};

const UTC = { timeZone: 'UTC' } as const;

const RECORDING_BAR = recordingStages(taskStageStates(
  ['launch', 'seek', 'capture', 'settle', 'encode', 'publish'],
  5,
  'succeeded',
));

describe('TaskCard', () => {
  it('names the type and the target object the way the rail writes them', () => {
    const markup = renderMarkup(<TaskCard task={DONE} {...UTC} />);

    expect(markup).toContain('录制');
    expect(markup).toContain('Kael_Mirage_1v3');
    expect(markup).toContain('#A-2481');
  });

  it('carries the type and the status as data for the list around it', () => {
    const markup = renderMarkup(<TaskCard task={RUNNING} {...UTC} />);

    expect(markup).toContain('data-task-kind="analysis"');
    expect(markup).toContain('data-task-status="running"');
  });

  it('marks a finished task with the filled square and a failed one with the hollow one', () => {
    expect(renderMarkup(<TaskCard task={DONE} {...UTC} />)).toContain('data-status="ok"');
    expect(renderMarkup(<TaskCard task={FAILED} {...UTC} />)).toContain('data-status="fail"');
  });

  it('writes the start time and the elapsed / total duration in the status line', () => {
    const done = renderMarkup(<TaskCard task={DONE} {...UTC} />);
    expect(done).toContain('09:12');
    expect(done).toContain('用时');

    const running = renderMarkup(<TaskCard task={RUNNING} {...UTC} />);
    expect(running).toContain('已用');
    expect(running).not.toContain('用时');
  });

  it('drops the date for a stamp from today and keeps it otherwise', () => {
    const now = new Date('2026-08-15T20:00:00Z');

    expect(renderMarkup(<TaskCard task={DONE} now={now} {...UTC} />)).toContain('>09:12<');
    expect(renderMarkup(<TaskCard task={DONE} {...UTC} />)).toContain('08-15 09:12');
  });

  it('writes 「阶段 3/5 位置采样」 when the backend gave a position', () => {
    const markup = renderMarkup(<TaskCard task={RUNNING} {...UTC} />);

    expect(markup).toContain('阶段 3/5');
    expect(markup).toContain('位置采样');
  });
});

describe('TaskCard · the progress rule', () => {
  it('draws a bar only when a real denominator arrived', () => {
    const markup = renderMarkup(<TaskCard task={RUNNING} {...UTC} />);

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="62"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(markup).toContain('62%');
  });

  it('falls back to the stage names, with no bar, when progress is missing', () => {
    // 「有真实分母时才用进度条，否则只给阶段名」— the artboard's own words, and the
    // reason `TaskSummary.progress` is optional in the first place.
    const markup = renderMarkup(<TaskCard task={DONE} stages={RECORDING_BAR} {...UTC} />);

    expect(markup).not.toContain('role="progressbar"');
    for (const stage of ['启动', '跳转', '采集', '稳定', '编码', '发布']) {
      expect(markup, stage).toContain(stage);
    }
  });

  it('draws nothing at all when there is neither a denominator nor a drawn sequence', () => {
    const markup = renderMarkup(<TaskCard task={FAILED} {...UTC} />);

    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain('<ol');
  });

  it('never invents a percentage out of a stage index', () => {
    const noDenominator: TaskSummary = { ...RUNNING, progress: undefined };
    const markup = renderMarkup(<TaskCard task={noDenominator} {...UTC} />);

    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain('%');
  });

  it('reads a counted denominator out as 「2/6」', () => {
    const clips: TaskSummary = {
      ...RUNNING,
      progress: { completed: 2, total: 6, unit: 'clips' },
    };
    const markup = renderMarkup(<TaskCard task={clips} {...UTC} />);

    expect(markup).toContain('2/6');
    expect(markup).toContain('片段');
  });
});

describe('TaskCard · failure', () => {
  it('renders the failure as a Notice with its recovery action', () => {
    const markup = renderMarkup(<TaskCard task={FAILED} {...UTC} />);

    expect(markup).toContain('data-tone="danger"');
    expect(markup).toContain('data-notice-action="primary"');
    expect(markup).toContain('重试导出');
  });

  it('names the reason from the closed set and prints the impact underneath', () => {
    const markup = renderMarkup(<TaskCard task={FAILED} {...UTC} />);

    expect(markup).toContain('磁盘空间不足');
    expect(markup).toContain('影响范围：仅这一次导出');
  });

  it('says 失败 in words as well as in colour', () => {
    expect(renderMarkup(<TaskCard task={FAILED} {...UTC} />)).toContain('失败');
  });

  it('caps diagnostic prose only in the compact drawer summary', () => {
    const compact = renderMarkup(<TaskCard task={FAILED} compact {...UTC} />);
    const detail = renderMarkup(<TaskCard task={FAILED} {...UTC} />);

    expect(compact).toContain('data-task-density="compact"');
    expect(compact).toContain('line-clamp-2');
    expect(compact).not.toContain('影响范围：仅这一次导出');
    expect(detail).toContain('data-task-density="default"');
    expect(detail).not.toContain('line-clamp-2');
  });
});

describe('TaskCard · results', () => {
  it('links to what the task produced', () => {
    const markup = renderMarkup(<TaskCard task={DONE} {...UTC} />);

    expect(markup).toContain('查看结果 Kael_Mirage_1v3.mp4');
    expect(markup).toContain('href="#/delivery/outputs/1"');
  });

  it('colours a link to a file that is no longer where it was', () => {
    const missing: TaskSummary = {
      ...DONE,
      artifacts: [{ id: 'out', label: 'Rhea_double_v3.mp4', href: '#/x', missing: true }],
    };

    expect(renderMarkup(<TaskCard task={missing} {...UTC} />)).toContain('text-fail-text');
  });

  it('renders the navigation links the page gives it', () => {
    const markup = renderMarkup(
      <TaskCard task={DONE} links={[{ id: 'plan', label: '来源方案 #P-118', href: '#/plans/118' }]} {...UTC} />,
    );

    expect(markup).toContain('来源方案 #P-118');
  });
});

describe('TaskCardSkeleton', () => {
  it('is a busy placeholder with no fabricated percentage', () => {
    const markup = renderMarkup(<TaskCardSkeleton />);

    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('role="progressbar"');
    // Nothing is *written* — the only percentages in there are the bar widths
    // of the artboard's own skeleton, which are CSS, not a claim about how far
    // along the task is.
    expect(markup.replaceAll(/<[^>]*>/gu, '')).toBe('');
  });
});
