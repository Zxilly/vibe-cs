import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Button } from './Button';

describe('Button markup', () => {
  it('renders a non-submitting button by default, in the secondary variant', () => {
    const html = renderMarkup(
      <Button>
        <Trans>取消</Trans>
      </Button>,
    );

    // `type="button"` is not a detail: the delete and save dialogs put these
    // inside forms, where the platform default would submit.
    expect(html).toContain('type="button"');
    expect(html).toContain('取消');
    expect(html).toContain('border-divider');
    expect(html).not.toContain('bg-accent');
  });

  it('paints the primary variant from the accent token', () => {
    const html = renderMarkup(<Button variant="primary">确认</Button>);
    expect(html).toContain('bg-accent');
    expect(html).toContain('text-bg');
  });

  it('paints the danger variant from --color-fail, not a page override', () => {
    const html = renderMarkup(<Button variant="danger">删除</Button>);
    expect(html).toContain('bg-fail');
    expect(html).toContain('border-fail');
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it('takes its height from the §3.3 token of the requested size', () => {
    expect(renderMarkup(<Button size="sm">a</Button>)).toContain('h-[var(--h-ctl-sm)]');
    expect(renderMarkup(<Button size="md">a</Button>)).toContain('h-[var(--h-ctl-md)]');
    expect(renderMarkup(<Button size="lg">a</Button>)).toContain('h-[var(--h-ctl-lg)]');
    expect(renderMarkup(<Button size="hero">a</Button>)).toContain('h-[var(--h-ctl-hero)]');
  });

  it('never writes a bare height, so 28 and 30 cannot come back', () => {
    const html = renderMarkup(<Button size="sm">a</Button>);
    expect(html).not.toMatch(/h-\[\d+px\]/u);
  });

  it('makes an icon button square from the same token and keeps its name', () => {
    const html = renderMarkup(<Button icon size="sm" aria-label="展开" />);
    expect(html).toContain('w-[var(--h-ctl-sm)]');
    expect(html).toContain('h-[var(--h-ctl-sm)]');
    expect(html).toContain('px-0');
    expect(html).toContain('aria-label="展开"');
  });

  it('stacks the icon and block modifiers on top of a variant', () => {
    const icon = renderMarkup(
      <Button variant="primary" icon aria-label="播放" />,
    );
    expect(icon).toContain('bg-accent');
    expect(icon).toContain('w-[var(--h-ctl-md)]');

    const block = renderMarkup(<Button variant="primary" block size="hero" />);
    expect(block).toContain('w-full');
    expect(block).toContain('h-[var(--h-ctl-hero)]');
  });

  it('gives a row-sharing button flex:1', () => {
    expect(renderMarkup(<Button grow>a</Button>)).toContain('flex-1');
  });

  it('disables without a reason when none is given', () => {
    const html = renderMarkup(<Button disabled>a</Button>);
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('aria-describedby');
  });

  it('states why a disabled action is unavailable, for the tooltip and for AT', () => {
    const html = renderMarkup(
      <Button disabled disabledReason="本地服务离线">
        开始录制
      </Button>,
    );

    /* The shell's degradation rule: 禁用并写明原因，不隐藏、不静默失败. A disabled
       button raises no pointer events, so the reason hangs on a focusable
       wrapper rather than on the button — see `feedback/Tooltip`. */
    expect(html).toMatch(/<span tabindex="0"[^>]*class="inline-flex"/u);
    expect(html).toMatch(/aria-describedby="([^"]+)"/u);
    expect(html).toContain('sr-only');
    expect(html).toContain('暂时不能执行：本地服务离线');

    const describedBy = /aria-describedby="([^"]+)"/u.exec(html)?.[1];
    expect(describedBy).toBeDefined();
    expect(html).toContain(`id="${describedBy}"`);
  });

  it('keeps the description out of the accessible name', () => {
    const html = renderMarkup(
      <Button disabled disabledReason="本地服务离线">
        开始录制
      </Button>,
    );
    const button = /<button[^>]*>([\s\S]*?)<\/button>/u.exec(html)?.[1] ?? '';
    expect(button).toBe('开始录制');
  });

  it('appends caller classes last so a layout can still place it', () => {
    const html = renderMarkup(<Button className="ml-auto">a</Button>);
    expect(html).toMatch(/class="[^"]*ml-auto"/u);
  });
});

describe('Button asChild', () => {
  it('renders the child element and keeps the button styling', () => {
    const html = renderMarkup(
      <Button asChild variant="primary" size="sm">
        <a href="/library">资料库</a>
      </Button>,
    );

    /* A link drawn as a button stays a link: middle-click, 「在新标签页打开」
       and the status bar all need the `href`. */
    expect(html).toMatch(/^<a /u);
    expect(html).toContain('href="/library"');
    expect(html).not.toContain('<button');
    expect(html).toContain('bg-accent');
    expect(html).toContain('h-[var(--h-ctl-sm)]');
  });

  it('does not put a button type on the element it borrows', () => {
    const html = renderMarkup(
      <Button asChild>
        <a href="/library">资料库</a>
      </Button>,
    );
    expect(html).not.toContain('type="button"');
  });
});
