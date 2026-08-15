import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Notice, type NoticeTone } from './Notice';

const noop = () => {};

/** The four samples the 「持久提示 Notice · 四态」panel draws, in order. */
const SAMPLE: readonly { tone: NoticeTone; message: string; action: string; role: string }[] = [
  { tone: 'info', message: '分析完成后会在这里提示，可直接进入工作区', action: '知道了', role: 'status' },
  { tone: 'success', message: '视频已生成 · Kael_Mirage_1v3.mp4', action: '播放', role: 'status' },
  { tone: 'warning', message: '运动镜头缺少碰撞数据，可能穿墙', action: '改为 POV', role: 'alert' },
  { tone: 'danger', message: '导出未完成：磁盘空间不足，已保留工程与素材', action: '重试', role: 'alert' },
];

describe('Notice', () => {
  it.each(SAMPLE)('renders the $tone sample with its recovery action', (sample) => {
    const markup = renderMarkup(
      <Notice tone={sample.tone} action={{ label: sample.action, onAction: noop }}>
        {sample.message}
      </Notice>,
    );

    expect(markup).toContain(`data-tone="${sample.tone}"`);
    expect(markup).toContain(`role="${sample.role}"`);
    expect(markup).toContain(sample.message);
    // 每条都带一个主要恢复动作 — always a button, never a link out of the page.
    expect(markup).toContain('data-notice-action="primary"');
    expect(markup).toContain(sample.action);
  });

  it('gives each tone a different graphic, so colour is never the only cue', () => {
    const icons = SAMPLE.map((sample) => {
      const markup = renderMarkup(
        <Notice tone={sample.tone} action={{ label: sample.action, onAction: noop }}>
          {sample.message}
        </Notice>,
      );
      const icon = /<svg[^>]*>(?<body>.*?)<\/svg>/su.exec(markup)?.groups?.['body'];
      expect(icon).toBeDefined();
      return icon;
    });

    expect(new Set(icons).size).toBe(SAMPLE.length);
  });

  it('states the tone in words for readers who get neither hue nor outline', () => {
    const words = ['提示', '成功', '警告', '错误'];

    SAMPLE.forEach((sample, index) => {
      const markup = renderMarkup(
        <Notice tone={sample.tone} action={{ label: sample.action, onAction: noop }}>
          {sample.message}
        </Notice>,
      );
      expect(markup).toContain(`class="sr-only">${words[index] ?? ''}`);
    });
  });

  it('paints each tone from the §3.1 surface / border pair', () => {
    const expected: Record<NoticeTone, string> = {
      info: 'border-accent-300 bg-accent-100',
      success: 'border-ok-border bg-ok-surface',
      warning: 'border-warn-border bg-warn-surface',
      danger: 'border-fail-border bg-fail-surface',
    };

    for (const sample of SAMPLE) {
      const markup = renderMarkup(
        <Notice tone={sample.tone} action={{ label: sample.action, onAction: noop }}>
          {sample.message}
        </Notice>,
      );
      expect(markup).toContain(expected[sample.tone]);
    }
  });

  it('renders the blast-radius detail line when given one', () => {
    const markup = renderMarkup(
      <Notice
        tone="danger"
        detail={<Trans>影响范围：仅这一次导出 · 释放 4.2 GB 后可继续</Trans>}
        action={{ label: <Trans>重试</Trans>, onAction: noop }}
      >
        <Trans>导出未完成：磁盘空间不足，已保留工程与素材</Trans>
      </Notice>,
    );

    expect(markup).toContain('影响范围：仅这一次导出 · 释放 4.2 GB 后可继续');
  });

  it('omits the dismiss control unless the caller supplies one', () => {
    const withoutDismiss = renderMarkup(
      <Notice tone="info" action={{ label: '知道了', onAction: noop }}>
        分析完成后会在这里提示
      </Notice>,
    );
    const withDismiss = renderMarkup(
      <Notice tone="info" action={{ label: '知道了', onAction: noop }} onDismiss={noop}>
        分析完成后会在这里提示
      </Notice>,
    );

    expect(withoutDismiss).not.toContain('关闭提示');
    expect(withDismiss).toContain('aria-label="关闭提示"');
  });

  it('does not float above the page — a Notice is a block in the flow', () => {
    const markup = renderMarkup(
      <Notice tone="danger" action={{ label: '重试', onAction: noop }}>
        导出未完成
      </Notice>,
    );

    // 不用 Toast 承载错误: no fixed positioning, no stacking context of its own.
    expect(markup).not.toMatch(/\bfixed\b/u);
    expect(markup).not.toMatch(/\bz-\d/u);
  });
});
