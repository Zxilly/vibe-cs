import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { TaskDetail } from './TaskDetail';
import { recordingTaskStages } from './StageTimeline';
import type { TaskSummary } from './types';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const TASK: TaskSummary = {
  id: '#A-2481',
  kind: 'recording',
  status: 'succeeded',
  subject: 'Kael_Mirage_1v3',
  startedAt: '2026-08-15T09:05:00Z',
  durationMs: 6 * MINUTE + 41 * SECOND,
};

const FAILED: TaskSummary = {
  id: '#E-131',
  kind: 'export',
  status: 'failed',
  subject: 'Aurora 赛点集锦',
  startedAt: '2026-08-15T08:40:00Z',
  failure: {
    reason: 'disk-space',
    impact: '影响范围：仅这一次导出，工程与素材已保留。',
    recovery: { label: '重试导出', onAction: () => undefined },
  },
};

const STAGES = recordingTaskStages([
  { state: 'done', at: '2026-08-15T09:05:00Z' },
  { state: 'done', at: '2026-08-15T09:05:30Z' },
  { state: 'done', at: '2026-08-15T09:06:00Z' },
  { state: 'done', at: '2026-08-15T09:10:00Z' },
  { state: 'done', at: '2026-08-15T09:11:00Z' },
  { state: 'done', at: '2026-08-15T09:12:00Z' },
]);

/** The seven lines the artboard writes into 阶段日志. */
const LOG = [
  { id: '1', at: '2026-08-15T09:05:00Z', message: '开始录制 4 个片段' },
  { id: '2', at: '2026-08-15T09:05:20Z', message: 'CS2 已启动，进入离线回放' },
  { id: '3', at: '2026-08-15T09:06:00Z', message: '片段 1 采集完成 · 3.0 秒' },
  { id: '4', at: '2026-08-15T09:09:00Z', message: '片段 3 重试 1 次后成功 · 观察者视角短暂丢失', emphasis: true },
  { id: '5', at: '2026-08-15T09:12:00Z', message: '输出已发布 · Kael_Mirage_1v3.mp4' },
] as const;

const UTC = { timeZone: 'UTC' } as const;

describe('TaskDetail · header', () => {
  it('writes the type, the target object, the id and the state tag', () => {
    const markup = renderMarkup(<TaskDetail task={TASK} stages={STAGES} {...UTC} />);

    expect(markup).toContain('录制');
    expect(markup).toContain('Kael_Mirage_1v3');
    expect(markup).toContain('#A-2481');
    expect(markup).toContain('已完成');
  });

  it('links to the source and to what the task produced', () => {
    const markup = renderMarkup(
      <TaskDetail
        task={TASK}
        stages={STAGES}
        links={[{ id: 'plan', label: '来源方案 #P-118', href: '#/plans/118' }]}
        artifacts={[{ id: 'out', label: '打开结果', href: '#/delivery/outputs/1' }]}
        {...UTC}
      />,
    );

    expect(markup).toContain('来源方案 #P-118');
    expect(markup).toContain('href="#/delivery/outputs/1"');
  });
});

describe('TaskDetail · stages', () => {
  it('draws the stage sequence with its per-stage stamps', () => {
    const markup = renderMarkup(<TaskDetail task={TASK} stages={STAGES} {...UTC} />);

    for (const stage of ['启动', '跳转', '采集', '稳定', '编码', '发布']) {
      expect(markup, stage).toContain(stage);
    }
    expect(markup).toContain('09:05');
    expect(markup).toContain('09:12');
  });

  it('draws no stage row at all for a kind that has none', () => {
    const markup = renderMarkup(<TaskDetail task={FAILED} {...UTC} />);

    expect(markup).not.toContain('data-stage-meta=');
  });
});

describe('TaskDetail · the stage log', () => {
  it('renders every line with its stamp', () => {
    const markup = renderMarkup(
      <TaskDetail task={TASK} stages={STAGES} log={{ status: 'ready', entries: LOG }} {...UTC} />,
    );

    expect(markup).toContain('阶段日志');
    expect(markup).toContain('开始录制 4 个片段');
    expect(markup).toContain('输出已发布 · Kael_Mirage_1v3.mp4');
    expect(markup).toContain('09:09');
  });

  it('washes the retry line the way the artboard does, and marks it as data', () => {
    const markup = renderMarkup(
      <TaskDetail task={TASK} stages={STAGES} log={{ status: 'ready', entries: LOG }} {...UTC} />,
    );

    expect(markup).toContain('data-emphasis="true"');
    expect(markup).toContain('bg-accent-100');
  });

  it('says so plainly when there is nothing in the log yet', () => {
    const markup = renderMarkup(
      <TaskDetail task={TASK} stages={STAGES} log={{ status: 'ready', entries: [] }} {...UTC} />,
    );

    expect(markup).toContain('还没有阶段日志');
  });

  it('shows a skeleton, not a fabricated percentage, while the log is loading', () => {
    const markup = renderMarkup(
      <TaskDetail task={TASK} stages={STAGES} log={{ status: 'loading', stage: '正在读取阶段记录' }} {...UTC} />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('正在读取阶段记录');
    expect(markup).not.toContain('role="progressbar"');
  });

  it('renders a failed load in place as a Notice with a way out', () => {
    const markup = renderMarkup(
      <TaskDetail
        task={TASK}
        stages={STAGES}
        log={{ status: 'error', message: '读取阶段记录失败', onRetry: () => undefined }}
        {...UTC}
      />,
    );

    expect(markup).toContain('读取阶段记录失败');
    expect(markup).toContain('重新加载');
    expect(markup).toContain('data-notice-action="primary"');
  });
});

describe('TaskDetail · failure', () => {
  it('renders the failure with its reason, its impact and its recovery action', () => {
    const markup = renderMarkup(<TaskDetail task={FAILED} {...UTC} />);

    expect(markup).toContain('磁盘空间不足');
    expect(markup).toContain('影响范围：仅这一次导出');
    expect(markup).toContain('重试导出');
    expect(markup).toContain('data-tone="danger"');
  });

  it('shows the retry state when the page hands one over', () => {
    const markup = renderMarkup(
      <TaskDetail
        task={FAILED}
        retry={{ retries: 2, maxRetries: 2, action: { label: '重试导出', onAction: () => undefined } }}
        {...UTC}
      />,
    );

    expect(markup).toContain('已重试 2 次');
    expect(markup).toContain('已达上限，不再自动重试');
  });
});

describe('TaskDetail · technical details', () => {
  it('collapses them behind a disclosure rather than laying them out', () => {
    const markup = renderMarkup(
      <TaskDetail
        task={TASK}
        stages={STAGES}
        technicalDetails={[
          { id: 'pid', label: '进程', value: '18422' },
          { id: 'tick', label: 'tick', value: '128' },
        ]}
        {...UTC}
      />,
    );

    expect(markup).toContain('<details');
    expect(markup).not.toContain('<details open');
    expect(markup).toContain('技术细节');
    expect(markup).toContain('进程、tick、编码参数');
  });

  it('has nowhere to put a raw stack — the prop does not exist', () => {
    // The enforcement is the type, not this assertion: `technicalDetails` takes
    // label/value facts. A caller holding a stack cannot pass it, so the
    // artboard's 「实现细节收在“技术细节”里」 cannot be lost by a call site.
    const markup = renderMarkup(<TaskDetail task={FAILED} {...UTC} />);

    expect(markup).not.toContain('<details');
    expect(markup).not.toMatch(/\bat [A-Za-z$_][\w$.]*\s\(/u);
  });
});

describe('TaskDetail · facts', () => {
  it('lists the rail rows and the duration in the finished grammar', () => {
    const markup = renderMarkup(
      <TaskDetail
        task={TASK}
        stages={STAGES}
        facts={[
          { id: 'clips', label: '片段', value: '4 / 4' },
          { id: 'retries', label: '重试', value: '1' },
        ]}
        {...UTC}
      />,
    );

    expect(markup).toContain('片段');
    expect(markup).toContain('4 / 4');
    expect(markup).toContain('重试');
    expect(markup).toContain('用时');
    expect(markup).toContain('6 分');
    expect(markup).toContain('41 秒');
  });
});
