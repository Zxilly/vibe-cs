import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Drawer } from './Drawer';
import { overlayActionClass } from './actionButton';

const noop = () => {};

function evidenceAnnotation() {
  return (
    <Drawer open title={<Trans>证据注释</Trans>} onClose={noop} description={<Trans>Aurora vs Meridian · R21</Trans>}>
      <Trans>这堵墙的穿点可以单独做一条教学。</Trans>
    </Drawer>
  );
}

describe('Drawer', () => {
  it('renders nothing while closed', () => {
    expect(renderMarkup(<Drawer open={false} title="会话" onClose={noop} children={null} />)).toBe('');
  });

  it('is a dialog labelled by its title', () => {
    const markup = renderMarkup(evidenceAnnotation());

    expect(markup).toContain('role="dialog"');
    const labelledBy = /aria-labelledby="(?<id>[^"]+)"/u.exec(markup)?.groups?.['id'];
    expect(labelledBy).toBeDefined();
    expect(markup).toContain(`<h2 id="${labelledBy ?? ''}"`);
    expect(markup).toContain('证据注释');
  });

  it('does not claim modality — 不阻断表格浏览', () => {
    const markup = renderMarkup(evidenceAnnotation());

    // A Drawer that announced itself modal would tell assistive technology the
    // table behind it is inert, which is exactly what the artboard forbids.
    expect(markup).not.toContain('aria-modal');
    // And no scrim, so the page behind stays visible and clickable.
    expect(markup).not.toContain('dialog-backdrop');
    expect(markup).not.toContain('bg-neutral-900/50');
  });

  it('docks to the right edge at a §3.5 panel width', () => {
    const wide = renderMarkup(evidenceAnnotation());
    const standard = renderMarkup(
      <Drawer open title="属性" onClose={noop} width="standard">
        <Trans>片段属性</Trans>
      </Drawer>,
    );

    expect(wide).toContain('inset-y-0 right-0');
    expect(wide).toContain('data-width="wide"');
    expect(wide).toContain('w-[var(--w-inspector-wide)]');
    expect(standard).toContain('w-[var(--w-inspector)]');
  });

  it('offers a named close control and prints the key beside it', () => {
    const markup = renderMarkup(evidenceAnnotation());

    expect(markup).toContain('aria-label="关闭抽屉"');
    expect(markup).toContain('data-drawer-action="close"');
    // The key hint duplicates the button's own name, so it is decorative.
    expect(markup).toMatch(/aria-hidden="true"[^>]*>ESC/u);
  });

  it('renders the description beside the title', () => {
    expect(renderMarkup(evidenceAnnotation())).toContain('Aurora vs Meridian · R21');
  });

  it('omits the footer entirely when the drawer has no actions', () => {
    expect(renderMarkup(evidenceAnnotation())).not.toContain('<footer');
  });

  it('pins the supplied actions bottom-right, in the shared button language', () => {
    const markup = renderMarkup(
      <Drawer
        open
        title={<Trans>证据注释</Trans>}
        onClose={noop}
        footer={
          <>
            <button type="button" className={overlayActionClass('secondary')}>
              <Trans>标为已处理</Trans>
            </button>
            <button type="button" className={overlayActionClass('primary')}>
              <Trans>保存</Trans>
            </button>
          </>
        }
      >
        <Trans>这堵墙的穿点可以单独做一条教学。</Trans>
      </Drawer>,
    );

    expect(markup).toContain('<footer');
    expect(markup).toContain('justify-end');
    expect(markup.indexOf('标为已处理')).toBeLessThan(markup.indexOf('保存'));
    expect(markup).toContain('bg-accent');
  });

  it('scrolls its body rather than the page', () => {
    expect(renderMarkup(evidenceAnnotation())).toContain('overflow-y-auto');
  });
});
