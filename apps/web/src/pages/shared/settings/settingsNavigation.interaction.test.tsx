import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubMatchMedia, type MatchMediaStub } from '../../../design/layout/collapse.testing';
import { SettingsPage } from './SettingsPage';
import { renderPage } from '../../../test/renderPage';

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
  vi.restoreAllMocks();
});

function render(at: string) {
  return renderPage({ element: <SettingsPage />, client: {}, route: at, pattern: '/settings' });
}

describe('settings navigation', () => {
  it('reparents collapsed section tabs above the content instead of leaving a half-width blank column', () => {
    media = stubMatchMedia(1000);
    render('/settings?section=advanced');

    expect(document.querySelector('[data-page-bar] [data-subnav="tabs"]')).not.toBeNull();
    expect(document.querySelector('[data-page-body] > div > [data-subnav="tabs"]')).toBeNull();
  });

  it('starts every section at the top rather than where the last one was left', () => {
    // One scroll container serves all five sections; a section opened after
    // scrolling another must not open with its first card's title above the fold.
    media = stubMatchMedia(1400);
    render('/settings?section=files');

    const content = document.querySelector('[data-settings-content]') as HTMLElement;
    let position = 0;
    Object.defineProperty(content, 'scrollTop', {
      configurable: true,
      get: () => position,
      set: (value: number) => { position = value; },
    });
    content.scrollTop = 191;

    fireEvent.click(screen.getByRole('button', { name: '游戏与录制' }));

    expect(screen.getByRole('button', { name: '游戏与录制' }).getAttribute('aria-current')).toBe('page');
    expect(content.scrollTop).toBe(0);
  });

  it('deep-links to a setting item and marks the scrolled target', async () => {
    media = stubMatchMedia(1400);
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    render('/settings?item=dependencies');

    const target = await waitFor(() => {
      const node = document.querySelector('[data-setting-item="dependencies"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(target.getAttribute('data-setting-target')).toBe('true');
    expect(document.activeElement).toBe(target);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '高级与诊断' }).getAttribute('aria-current')).toBe('page');
  });
});
