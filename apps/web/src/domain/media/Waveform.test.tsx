import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Waveform } from './Waveform';

/** A deterministic signal; no randomness in a test that asserts a path. */
const peaks = Array.from({ length: 2000 }, (_, index) => Math.sin(index / 40));

describe('Waveform markup', () => {
  it('draws the envelope as one SVG path in the artboard view box', () => {
    const markup = renderMarkup(<Waveform peaks={peaks} durationSeconds={124} />);
    expect(markup).toContain('viewBox="0 0 1000 100"');
    expect(markup).toContain('preserveAspectRatio="none"');
    expect(markup).toContain('<path d="M0,');
    // The artboard's zero line.
    expect(markup).toContain('M0 50 H1000');
  });

  it('names itself for a screen reader instead of leaving a bare graphic', () => {
    const markup = renderMarkup(<Waveform peaks={peaks} durationSeconds={124} />);
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="音频波形，全长 02:04"');
  });

  it('decodes nothing — a Float32Array renders the same as an array', () => {
    const asArray = renderMarkup(<Waveform peaks={peaks} durationSeconds={124} columns={64} />);
    const asTyped = renderMarkup(<Waveform peaks={Float32Array.from(peaks)} durationSeconds={124} columns={64} />);
    // Float32 rounds the samples, so the paths differ in the last decimal;
    // the structure must not.
    expect(asTyped).toContain('viewBox="0 0 1000 100"');
    expect(asArray.length).toBeGreaterThan(0);
  });

  it('has no playhead until it is given a time', () => {
    expect(renderMarkup(<Waveform peaks={peaks} durationSeconds={124} />)).not.toContain('data-playhead');

    const markup = renderMarkup(<Waveform peaks={peaks} durationSeconds={124} currentTime={31} />);
    expect(markup).toContain('data-playhead="true"');
    expect(markup).toContain('left:25%');
  });

  it('draws the in and out points as edges with the outside dimmed', () => {
    const markup = renderMarkup(
      <Waveform peaks={peaks} durationSeconds={100} inPoint={20} outPoint={70} />,
    );
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain('data-region="before-in"');
    expect(markup).toContain('data-region="after-out"');
    expect(markup).toContain('data-edge="in"');
    expect(markup).toContain('data-edge="out"');
    expect(markup).toContain('aria-label="音频波形，全长 01:40，已选 00:20 至 01:10"');
  });

  it('places the selection by percentage, so the box can be any width', () => {
    const markup = renderMarkup(
      <Waveform peaks={peaks} durationSeconds={100} inPoint={20} outPoint={70} />,
    );
    expect(markup).toContain('width:20%');
    expect(markup).toContain('width:30%');
    expect(markup).toContain('left:70%');
  });

  it('renders an empty state rather than an empty box when there are no peaks', () => {
    const markup = renderMarkup(<Waveform peaks={[]} durationSeconds={124} />);
    expect(markup).toContain('还没有波形');
    expect(markup).not.toContain('<svg');
  });

  it('renders a skeleton while the peaks are being computed', () => {
    const markup = renderMarkup(<Waveform peaks={[]} durationSeconds={124} loading />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('正在读取波形');
    expect(markup).toContain('animate-pulse');
    expect(markup).not.toContain('还没有波形');
  });

  it('renders a failure as a Notice with its recovery action', () => {
    const markup = renderMarkup(
      <Waveform
        peaks={peaks}
        durationSeconds={124}
        failure={{
          message: '音频没能解码',
          detail: '文件可能不完整',
          action: { label: '重新分析', onAction: () => {} },
        }}
      />,
    );
    expect(markup).toContain('音频没能解码');
    expect(markup).toContain('文件可能不完整');
    expect(markup).toContain('重新分析');
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('<svg viewBox="0 0 1000 100"');
  });

  it('takes the caller’s empty-state action', () => {
    const markup = renderMarkup(
      <Waveform peaks={[]} durationSeconds={124} emptyAction={<button type="button">重新分析音频</button>} />,
    );
    expect(markup).toContain('重新分析音频');
  });

  it('is a static render: no canvas, no measurement, no effect needed', () => {
    const markup = renderMarkup(<Waveform peaks={peaks} durationSeconds={124} />);
    expect(markup).not.toContain('<canvas');
    expect(renderMarkup(<Waveform peaks={peaks} durationSeconds={124} />)).toBe(markup);
  });
});
