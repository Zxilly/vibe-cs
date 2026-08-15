import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Toggle } from './Toggle';

describe('Toggle markup', () => {
  it('is an operable switch, not the reference span', () => {
    const html = renderMarkup(<Toggle checked aria-label="预填上下文" />);

    expect(html).toMatch(/^<button/u);
    expect(html).toContain('type="button"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="预填上下文"');
  });

  it('is the reference 34×18 square, not a pill', () => {
    const html = renderMarkup(<Toggle checked={false} aria-label="x" />);
    expect(html).toContain('w-[34px]');
    expect(html).toContain('h-[18px]');
    // --radius-* is 0 system-wide; a rounded track would be an invention.
    expect(html).not.toContain('rounded');
  });

  it('fills the track with the accent when on and the neutral step when off', () => {
    expect(renderMarkup(<Toggle checked aria-label="x" />)).toContain('bg-accent');
    expect(renderMarkup(<Toggle checked={false} aria-label="x" />)).toContain('bg-neutral-300');
  });

  it('pins the 16px knob to the side that matches the state', () => {
    expect(renderMarkup(<Toggle checked aria-label="x" />)).toContain('right-[1px]');
    expect(renderMarkup(<Toggle checked={false} aria-label="x" />)).toContain('left-[1px]');
    expect(renderMarkup(<Toggle checked aria-label="x" />)).toContain('size-[16px]');
  });

  it('draws the 「不可关闭」 treatment and says the switch is unavailable', () => {
    const html = renderMarkup(<Toggle checked locked aria-label="录制前需人工确认" />);

    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('border-accent-700');
    // Locked, not disabled: the reference draws it at full strength because it
    // states a rule of the system rather than a state of the form.
    expect(html).not.toContain('disabled=""');
  });

  it('leaves the locked frame out of an ordinary switch', () => {
    expect(renderMarkup(<Toggle checked aria-label="x" />)).not.toContain('border-accent-700');
  });

  it('carries no bare hex', () => {
    expect(renderMarkup(<Toggle checked locked aria-label="x" />)).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
