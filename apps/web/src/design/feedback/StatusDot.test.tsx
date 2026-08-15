import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { StatusDot, type StatusDotStatus } from './StatusDot';

describe('StatusDot', () => {
  it.each([
    { status: 'ok' as const, shape: 'filled', paint: 'bg-ok' },
    { status: 'running' as const, shape: 'filled', paint: 'bg-accent' },
    { status: 'idle' as const, shape: 'hollow', paint: 'border border-neutral-500' },
    { status: 'warn' as const, shape: 'hollow', paint: 'border border-warn' },
    { status: 'fail' as const, shape: 'hollow', paint: 'border border-fail' },
  ])('draws $status as a $shape square', ({ status, shape, paint }) => {
    const markup = renderMarkup(<StatusDot status={status} />);

    expect(markup).toContain(`data-status="${status}"`);
    // 已发生 / 正在发生 is filled, 尚未发生 is outlined — the reference's own rule,
    // and the second cue beside hue.
    expect(markup).toContain(`data-shape="${shape}"`);
    expect(markup).toContain(paint);
  });

  it('is hidden from assistive technology when it only decorates a status line', () => {
    const markup = renderMarkup(<StatusDot status="ok" />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="img"');
  });

  it('becomes an image with a name when it stands alone', () => {
    const markup = renderMarkup(<StatusDot status="fail" label="失败" />);

    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="失败"');
    expect(markup).not.toContain('aria-hidden');
  });

  it.each([
    { size: 'sm' as const, css: 'size-[7px]' },
    { size: 'md' as const, css: 'size-[8px]' },
    { size: 'lg' as const, css: 'size-[9px]' },
  ])('sizes $size to the reference value', ({ size, css }) => {
    expect(renderMarkup(<StatusDot status="ok" size={size} />)).toContain(css);
  });

  it('defaults to the size the reference draws most often', () => {
    expect(renderMarkup(<StatusDot status="ok" />)).toContain('size-[8px]');
  });

  it('stays square — this system has no radius above zero', () => {
    const statuses: StatusDotStatus[] = ['idle', 'running', 'ok', 'warn', 'fail'];

    for (const status of statuses) {
      expect(renderMarkup(<StatusDot status={status} />)).not.toMatch(/rounded/u);
    }
  });
});
