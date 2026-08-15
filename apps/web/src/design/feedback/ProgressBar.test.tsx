import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('exposes the real denominator, not a percentage', () => {
    // 「录制 · Rhea 双杀 · 3 个片段 … 2/6」 from the workbench artboard.
    const markup = renderMarkup(<ProgressBar value={2} max={6} label="录制进度" valueText="2/6 片段" />);

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="录制进度"');
    expect(markup).toContain('aria-valuenow="2"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="6"');
    expect(markup).toContain('aria-valuetext="2/6 片段"');
  });

  it('fills the track to the ratio the artboard draws', () => {
    const markup = renderMarkup(<ProgressBar value={62} max={100} label="分析进度" />);

    expect(markup).toContain('width:62%');
  });

  it('clamps a value outside the denominator instead of overflowing the track', () => {
    expect(renderMarkup(<ProgressBar value={9} max={6} label="录制进度" />)).toContain('width:100%');
    expect(renderMarkup(<ProgressBar value={-3} max={6} label="录制进度" />)).toContain('width:0%');
  });

  it('survives a zero denominator without dividing by it', () => {
    const markup = renderMarkup(<ProgressBar value={0} max={0} label="录制进度" />);

    expect(markup).toContain('width:0%');
    expect(markup).not.toContain('NaN');
  });

  it.each([
    { size: 'sm' as const, css: 'h-[5px]' },
    { size: 'md' as const, css: 'h-[6px]' },
    { size: 'lg' as const, css: 'h-[8px]' },
  ])('draws the $size track at the reference height', ({ size, css }) => {
    expect(renderMarkup(<ProgressBar value={1} max={2} label="进度" size={size} />)).toContain(css);
  });

  it('runs the track on neutral-200 and the fill on the tone token', () => {
    const accent = renderMarkup(<ProgressBar value={1} max={2} label="进度" />);
    const fail = renderMarkup(<ProgressBar value={1} max={2} label="进度" tone="fail" />);

    expect(accent).toContain('bg-neutral-200');
    expect(accent).toContain('bg-accent');
    expect(fail).toContain('bg-fail');
  });

  it('hides the fill from assistive technology — the role already carries the value', () => {
    const markup = renderMarkup(<ProgressBar value={1} max={2} label="进度" />);

    expect(markup).toContain('aria-hidden="true"');
  });
});
