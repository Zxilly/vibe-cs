import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { NativeSelect } from './NativeSelect';

function shotKind(props: Partial<React.ComponentProps<typeof NativeSelect>> = {}) {
  return (
    <NativeSelect aria-label="镜头类型" {...props}>
      <option value="kill">击杀</option>
      <option value="clutch">残局</option>
    </NativeSelect>
  );
}

describe('NativeSelect markup', () => {
  it('is a real select, so the platform owns the popup and its typeahead', () => {
    const html = renderMarkup(shotKind());

    expect(html).toMatch(/^<select/u);
    expect(html).toContain('aria-label="镜头类型"');
    expect(html).toContain('击杀');
  });

  it('takes its height and type step from the §3.3 tokens', () => {
    expect(renderMarkup(shotKind())).toContain('h-[var(--h-ctl-sm)]');
    expect(renderMarkup(shotKind({ size: 'md' }))).toContain('h-[var(--h-ctl-md)]');
    expect(renderMarkup(shotKind())).toContain('text-sm');
  });

  it('outlines with the divider, and with fail when invalid', () => {
    expect(renderMarkup(shotKind())).toContain('border-divider');

    const invalid = renderMarkup(shotKind({ invalid: true }));
    expect(invalid).toContain('border-fail');
    expect(invalid).toContain('aria-invalid="true"');
  });

  it('says nothing about validity unless it was told to', () => {
    expect(renderMarkup(shotKind())).not.toContain('aria-invalid');
  });

  it('carries no bare hex', () => {
    expect(renderMarkup(shotKind())).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
