import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Empty, type EmptyPreset } from './Empty';

const ACTION = <button type="button">导入 Demo</button>;

function textOf(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, '');
}

describe('Empty presets', () => {
  // 「补齐 · 规范与状态」— "空 · 加载 · 错误", four empty cells plus one error cell.
  const cases: readonly [EmptyPreset, string][] = [
    ['no-matches', '还没有比赛'],
    ['not-analysed', '这场还没分析'],
    ['no-hits', '没有命中的证据'],
    ['no-outputs', '还没有输出'],
    ['error', '这个页面没能打开'],
  ];

  it.each(cases)('renders the artboard copy for %s', (preset, title) => {
    const html = renderMarkup(<Empty preset={preset} actions={ACTION} />);
    expect(textOf(html)).toContain(title);
  });

  it.each(cases)('gives %s a recovery action', (preset) => {
    const html = renderMarkup(<Empty preset={preset} actions={ACTION} />);
    // The artboard's rule for every state: "每条都带一个主要恢复动作".
    expect(html).toContain('导入 Demo');
  });

  it('draws a glyph only where the artboard draws one', () => {
    expect(renderMarkup(<Empty preset="no-matches" actions={ACTION} />)).toContain('<svg');
    expect(renderMarkup(<Empty preset="not-analysed" actions={ACTION} />)).not.toContain('<svg');
  });

  it('carries the folder description of 还没有比赛 verbatim', () => {
    const html = renderMarkup(<Empty preset="no-matches" actions={ACTION} />);
    expect(textOf(html)).toContain('导入一个 .dem，或添加一个监听目录自动发现');
  });
});

describe('Empty structure', () => {
  it('names the region by its heading', () => {
    const html = renderMarkup(<Empty preset="no-outputs" actions={ACTION} />);
    const labelled = /aria-labelledby="([^"]+)"/u.exec(html);
    expect(labelled).not.toBeNull();
    expect(html).toContain(`<h3 id="${labelled?.[1] ?? ''}"`);
  });

  it('takes the heading level from the caller so it slots into the page outline', () => {
    expect(renderMarkup(<Empty preset="no-outputs" actions={ACTION} headingLevel={2} />)).toContain('<h2');
  });

  it('paints the error tone with the fail border and fail ink, not with colour alone', () => {
    const html = renderMarkup(<Empty preset="error" actions={ACTION} />);
    expect(html).toContain('data-tone="error"');
    expect(html).toContain('border-fail-border');
    expect(html).toContain('text-fail-text');
  });

  it('keeps the empty tone on the plain divider frame', () => {
    const html = renderMarkup(<Empty preset="no-hits" actions={ACTION} />);
    expect(html).toContain('data-tone="empty"');
    expect(html).toContain('border-divider');
    expect(html).not.toContain('border-fail-border');
  });

  it('lets a page supply its own live conditions in place of the preset copy', () => {
    const html = renderMarkup(
      <Empty preset="no-hits" description="当前条件：选手 Kael ＋ 穿墙 ＋ 近 7 天。" actions={ACTION} />,
    );
    const text = textOf(html);
    expect(text).toContain('没有命中的证据');
    expect(text).toContain('当前条件：选手 Kael ＋ 穿墙 ＋ 近 7 天。');
    expect(text).not.toContain('放宽时间范围通常最有效。');
  });

  it('works with no preset at all, and omits the description paragraph', () => {
    const html = renderMarkup(<Empty title="没有输出" actions={ACTION} />);
    expect(textOf(html)).toBe('没有输出导入 Demo');
    expect(html).not.toContain('<p');
  });
});
