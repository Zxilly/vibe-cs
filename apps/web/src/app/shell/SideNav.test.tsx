import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { SHELL_NAV_FOOTER_ITEM, shellNavGroups, type WorkspaceMode } from './navigation';
import { resetShellStore } from './shellStore';
import { SideNav, type SideNavProps } from './SideNav';

beforeEach(() => {
  resetShellStore();
});

function nav(props: SideNavProps = {}, at = '/'): string {
  return renderMarkup(
    <MemoryRouter initialEntries={[at]}>
      <SideNav {...props} />
    </MemoryRouter>,
  );
}

function modeItems(mode: WorkspaceMode) {
  return [...shellNavGroups(mode).flatMap((group) => group.items), SHELL_NAV_FOOTER_ITEM];
}

/** The ids of the entries the markup marks as current. */
function currentIds(html: string): string[] {
  return [...html.matchAll(/data-nav-item="([^"]+)"[^>]*aria-current="page"/gu)].map((match) => match[1] as string);
}

describe('SideNav, expanded', () => {
  it('is the 216px rail of Frame.dc.html', () => {
    const html = nav();

    expect(html).toContain('data-shell-nav="expanded"');
    expect(html).toContain('w-[var(--w-nav)]');
    expect(html).toContain('aria-label="主导航"');
    expect(html).toContain('bg-surface-chrome');
  });

  it('draws every destination once, at the 40px row height of §3.4', () => {
    const html = nav();

    for (const item of modeItems('edit')) {
      expect(html.split(`data-nav-item="${item.id}"`)).toHaveLength(2);
    }
    expect(html).toContain('h-[var(--h-panel-head)]');
  });

  it('shows the three group headings the frame labels', () => {
    const html = nav();

    for (const heading of ['资料库', '制作', '交付']) expect(html).toContain(`>${heading}</h2>`);
    // The first group is drawn without one.
    expect(html.split('</h2>')).toHaveLength(4);
  });

  it('marks the current destination with aria-current, not colour alone', () => {
    const html = nav({}, '/library');

    expect(currentIds(html)).toEqual(['library']);
    expect(html).toContain('bg-accent-100');
  });

  it('lights 资料库 while the match workspace is open', () => {
    expect(currentIds(nav({}, '/match/aurora-meridian'))).toEqual(['library']);
  });

  it('keeps delivery queries on the one finished-files entry', () => {
    expect(currentIds(nav({}, '/delivery?view=outputs'))).toEqual(['outputs']);
    expect(currentIds(nav({}, '/delivery?view=tasks'))).toEqual(['outputs']);
    expect(currentIds(nav({}, '/delivery/task/A-2481'))).toEqual(['outputs']);
  });

  it('marks nothing when the route is outside the rail', () => {
    expect(currentIds(nav({}, '/prototype/whatever'))).toEqual([]);
  });

  it('carries the two count badges the frame draws', () => {
    const html = nav({ badges: { projects: 1, outputs: 3 } });

    expect(html).toContain('>1</span>');
    expect(html).toContain('>3</span>');
    expect(html).toContain('border-accent-300');
  });

  it('omits a badge whose count is zero', () => {
    expect(nav({ badges: { projects: 0 } })).not.toContain('border-accent-300');
  });
});

describe('SideNav, collapsed', () => {
  it('is the 56px icon rail of the 1100 × 700 artboard', () => {
    const html = nav({ collapsed: true });

    expect(html).toContain('data-shell-nav="collapsed"');
    expect(html).toContain('w-[var(--w-nav-collapsed)]');
    expect(html).toContain('size-[var(--h-ctl-md)]');
  });

  it('keeps every destination reachable and named, with the label off-screen', () => {
    const html = nav({ collapsed: true });

    for (const item of modeItems('edit')) {
      expect(html.split(`data-nav-item="${item.id}"`)).toHaveLength(2);
    }
    expect(html).toContain('<span class="sr-only">工作台</span>');
  });

  it('drops the group headings — they only come back in the hover flyout', () => {
    const html = nav({ collapsed: true });

    expect(html).not.toContain('</h2>');
    expect(html).not.toContain('data-nav-flyout');
  });

  it('reduces a badge to the corner square the artboard draws', () => {
    const html = nav({ collapsed: true, badges: { projects: 1 } });

    expect(html).toContain('data-nav-badge="projects"');
    expect(html).not.toContain('>1</span>');
  });
});

describe('SideNav modes', () => {
  it('shows creation destinations in editing mode', () => {
    const html = nav({ mode: 'edit' });
    expect(html).toContain('data-nav-item="home"');
    expect(html).toContain('data-nav-item="agent"');
    expect(html).toContain('data-nav-item="projects"');
    expect(html).toContain('data-nav-item="outputs"');
    expect(html).not.toContain('data-nav-item="players"');
    expect(html).not.toContain('data-nav-item="evidence"');
  });

  it('lets the active settings row fill the expanded footer behind the overlay toggle', () => {
    const html = nav({ mode: 'edit' }, '/settings');
    const footer = html.slice(html.indexOf('data-shell-nav-footer'));
    const settings = footer.slice(footer.indexOf('data-nav-item="settings"'));

    expect(footer).toContain('relative');
    expect(footer).toContain('absolute');
    expect(settings.slice(0, 400)).toContain('w-full');
    expect(settings.slice(0, 400)).toContain('pr-12');
  });

  it('shows the retained analysis destinations in analysis mode', () => {
    const html = nav({ mode: 'analysis' }, '/players');
    expect(html).toContain('data-nav-item="library"');
    expect(html).toContain('data-nav-item="players"');
    expect(html).toContain('data-nav-item="evidence"');
    expect(html).not.toContain('data-nav-item="home"');
    expect(html).not.toContain('data-nav-item="projects"');
    expect(currentIds(html)).toEqual(['players']);
  });
});
