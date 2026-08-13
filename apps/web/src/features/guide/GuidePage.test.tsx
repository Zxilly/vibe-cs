import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { DependencyCheck } from '../../shared/desktop/dto';
import { GuidePage, GuidePreflight } from './GuidePage';

const readyCs2: DependencyCheck = {
  kind: 'game',
  state: 'ready',
  label: 'Counter-Strike 2',
  detail: 'E:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
  action_path: '/settings',
};

const missingCs2: DependencyCheck = {
  kind: 'game',
  state: 'missing',
  label: 'Counter-Strike 2',
  detail: 'Counter-Strike 2 was not found',
  action_path: '/settings',
};

describe('guide CS2 preflight', () => {
  it('collapses a ready CS2 check into one compact inline status', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <GuidePreflight loading={false} check={readyCs2} onRefresh={() => undefined} />
      </MemoryRouter>,
    );

    expect(markup).toContain('guide-preflight--ready');
    expect(markup).toContain('CS2 已就绪');
    expect(markup).toContain('cs2.exe');
    expect(markup).toContain('href="/settings"');
    expect(markup).not.toContain('setup-card');
    expect(markup).not.toMatch(/OBS|Encoder|FFmpeg/i);
  });

  it('keeps a missing CS2 executable as an explicit recoverable blocker', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <GuidePreflight loading={false} check={missingCs2} onRefresh={() => undefined} />
      </MemoryRouter>,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('需要定位 Counter-Strike 2');
    expect(markup).toContain('CS2 是唯一需要你提供的本地前置条件');
    expect(markup).toContain('button--primary');
    expect(markup).toContain('href="/settings"');
    expect(markup).toContain('定位 CS2');
  });
});

describe('guide task hierarchy', () => {
  it('keeps readiness inline and gives the three-step workflow the full workspace', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <GuidePage />
      </MemoryRouter>,
    );

    expect(markup).toContain('guide-preflight guide-preflight--checking');
    expect(markup).not.toContain('setup-card');
    expect(markup).not.toContain('guide-workspace');
    expect(markup.match(/class="workflow-card"/g)).toHaveLength(3);
    expect(markup.indexOf('guide-preflight')).toBeLessThan(markup.indexOf('workflow-section'));
  });
});
