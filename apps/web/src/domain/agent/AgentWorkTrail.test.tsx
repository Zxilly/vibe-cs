import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { AgentWorkTrail } from './AgentWorkTrail';

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** The 07 artboard's own five rows. */
const STEPS = [
  { id: 'structure', label: '读取比赛结构', detail: '24 回合 · 10 名选手 · 18 条高光证据' },
  { id: 'candidates', label: '筛选候选片段', detail: '7 条与 Kael 相关，选中第 21 回合残局' },
  { id: 'spatial', label: '读取空间证据', detail: '移动路线、朝向样本、经击杀验证的交战轴' },
  { id: 'design', label: '设计镜头', detail: '4 个镜头 · 1 处降级为 POV · 1 处标注风险' },
  { id: 'confirm', label: '等待你的确认', detail: '确认后才会启动 CS2 回放与采集', state: 'waiting' as const },
];

describe('AgentWorkTrail', () => {
  it('draws the artboard’s five rows in order, each with its detail line', () => {
    const html = renderMarkup(<AgentWorkTrail steps={STEPS} label="工作进度" />);

    expect(occurrences(html, 'data-work-step=')).toBe(5);
    expect(html).toContain('读取比赛结构');
    expect(html).toContain('24 回合 · 10 名选手 · 18 条高光证据');
    expect(html).toContain('等待你的确认');
  });

  it('fills what has happened and outlines what has not', () => {
    const html = renderMarkup(<AgentWorkTrail steps={STEPS} label="工作进度" />);

    // §6.2: shape, not hue, is what separates them.
    expect(occurrences(html, 'data-shape="filled"')).toBe(4);
    expect(occurrences(html, 'data-shape="hollow"')).toBe(1);
  });

  it('gives the waiting step the 等待确认 colour the shell reserves for it', () => {
    const html = renderMarkup(<AgentWorkTrail steps={STEPS} label="工作进度" />);

    expect(html).toContain('data-work-state="waiting"');
    expect(html).toContain('data-status="warn"');
  });

  it('says each step’s state in words as well as in its marker', () => {
    const html = renderMarkup(<AgentWorkTrail steps={STEPS} label="工作进度" />);

    expect(html).toContain('已完成');
    expect(html).toContain('等待你确认');
  });

  it('marks a step that is still running', () => {
    const html = renderMarkup(
      <AgentWorkTrail steps={[{ id: 'a', label: '读取空间证据', state: 'active' }]} label="工作进度" />,
    );

    expect(html).toContain('data-work-state="active"');
    expect(html).toContain('进行中');
  });

  it('draws no connector under the last row', () => {
    const html = renderMarkup(<AgentWorkTrail steps={STEPS} label="工作进度" />);

    expect(occurrences(html, 'w-px flex-1 bg-divider')).toBe(4);
  });

  it('omits the detail line for a step that has none', () => {
    const html = renderMarkup(<AgentWorkTrail steps={[{ id: 'a', label: 'read_match_structure' }]} label="工具调用" />);

    expect(html).toContain('read_match_structure');
    expect(html).toContain('aria-label="工具调用"');
  });
});
