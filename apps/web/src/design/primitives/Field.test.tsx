import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Field } from './Field';
import { Input } from './Input';

describe('Field markup', () => {
  it('binds the label to the control it wraps', () => {
    const html = renderMarkup(
      <Field label={<Trans>镜头类型</Trans>}>{(control) => <Input {...control} />}</Field>,
    );

    const forAttribute = /<label[^>]*for="([^"]+)"/u.exec(html)?.[1];
    expect(forAttribute).toBeDefined();
    expect(html).toContain(`id="${forAttribute}"`);
    expect(html).toContain('镜头类型');
  });

  it('accepts a plain child for the reference read-only boxes', () => {
    const html = renderMarkup(
      <Field label={<Trans>起始 tick</Trans>}>
        <span>148 812</span>
      </Field>,
    );
    expect(html).toContain('148 812');
    expect(html).toContain('起始 tick');
  });

  it('uses the 12px step and the muted ink for the label', () => {
    const html = renderMarkup(<Field label="时长">{() => null}</Field>);
    expect(html).toMatch(/<label[^>]*class="[^"]*text-xs/u);
    expect(html).toMatch(/<label[^>]*class="[^"]*text-neutral-700/u);
  });

  it('marks a required field for sighted and screen reader users alike', () => {
    const html = renderMarkup(<Field label="标题" required>{() => null}</Field>);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('*');
    expect(html).toContain('sr-only');
    expect(html).toContain('必填');
  });

  it('leaves the required marker off by default', () => {
    const html = renderMarkup(<Field label="标题">{() => null}</Field>);
    expect(html).not.toContain('必填');
  });

  it('describes the control with its hint', () => {
    const html = renderMarkup(
      <Field label="时长" hint={<Trans>不超过 30 秒</Trans>}>
        {(control) => <Input {...control} />}
      </Field>,
    );

    const describedBy = /<input[^>]*aria-describedby="([^"]+)"/u.exec(html)?.[1];
    expect(describedBy).toBeDefined();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('不超过 30 秒');
    expect(html).not.toContain('aria-invalid');
  });

  it('replaces the hint with the error and marks the control invalid', () => {
    const html = renderMarkup(
      <Field label="时长" hint="不超过 30 秒" error={<Trans>必须是正数</Trans>}>
        {(control) => <Input {...control} />}
      </Field>,
    );

    expect(html).toContain('必须是正数');
    expect(html).not.toContain('不超过 30 秒');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
  });

  it('adds no describedby when there is nothing to describe', () => {
    const html = renderMarkup(<Field label="时长">{(control) => <Input {...control} />}</Field>);
    expect(html).not.toContain('aria-describedby');
  });

  it('carries no bare hex', () => {
    const html = renderMarkup(<Field label="时长" hint="x" required>{() => null}</Field>);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
