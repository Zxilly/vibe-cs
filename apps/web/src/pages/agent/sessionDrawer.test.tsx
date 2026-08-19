/*
 * `markup` project — the session drawer's structure, and block C's two seams.
 *
 * Rendered with an empty cache and no service, so what is asserted here is the
 * shape the user meets first: the loading state (no invented percentage), the
 * copy that carries §4.5.1, and the fact that the overlay is not in the DOM
 * until it is opened.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { ServiceActionState } from '../../data/serviceAction';
import { renderMarkup, renderMarkupDom } from '../../test/render';
import type { AgentRouteContext } from './agentContract';
import { AgentSessionsBlock, agentSessionsToolbarAction } from './AgentSessionsBlock';
import { SessionDrawer } from './SessionDrawer';

const READY: ServiceActionState = { blocked: false, buttonProps: { disabled: false }, suffix: undefined };

const CONTEXT: AgentRouteContext = { plan: null, session: null, mode: 'changes' };

/* `renderMarkupDom`: the Drawer is portalled, and `react-dom/server` throws on
   `createPortal`. */
function drawer(open: boolean): string {
  return renderMarkupDom(
    <MemoryRouter initialEntries={['/agent']}>
      <SessionDrawer
        open={open}
        onClose={() => undefined}
        context={CONTEXT}
        updateContext={() => undefined}
        service={READY}
      />
    </MemoryRouter>,
  );
}

describe('the overlay', () => {
  it('is a Drawer — no scrim, because the plan behind it stays usable', () => {
    const html = drawer(true);
    expect(html).toContain('data-overlay="drawer"');
    expect(html).not.toContain('data-overlay="dialog-backdrop"');
  });

  it('is not in the DOM at all while closed', () => {
    expect(drawer(false)).not.toContain('data-overlay="drawer"');
  });

  it('carries the artboard’s header: a name, the ESC hint and 新建对话', () => {
    const html = drawer(true);
    expect(html).toContain('对话');
    expect(html).toContain('ESC');
    expect(html).toContain('新建对话');
  });

  it('searches over more than the titles it has, and says so', () => {
    const html = drawer(true);
    expect(html).toContain('搜索会话、Demo 或选手');
    expect(html).toContain('每条下方是它触及过的对象');
  });

  it('states §4.5.1 where the user is about to act on it', () => {
    expect(drawer(true)).toContain('打开一条会话＝回到那次对话');
  });

  it('loads with a skeleton and no percentage — §4.3 forbids an invented one', () => {
    const html = drawer(true);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="progressbar"');
  });

  it('invents no session: an empty cache renders no names', () => {
    const html = drawer(true);
    expect(html).not.toContain('Kael');
    expect(html).not.toContain('Aurora');
  });
});

describe('block C’s seams', () => {
  it('mounts nothing — and therefore fetches nothing — while closed', () => {
    const html = renderMarkup(
      <MemoryRouter initialEntries={['/agent']}>
        <AgentSessionsBlock
          open={false}
          onClose={() => undefined}
          context={CONTEXT}
          updateContext={() => undefined}
          service={READY}
        />
      </MemoryRouter>,
    );
    expect(html).toBe('');
  });

  it('gives the toolbar both forms, so §8 may fold it without losing the drawer', () => {
    const action = agentSessionsToolbarAction(() => undefined);
    expect(action.id).toBe('agent-sessions');
    expect(action.onSelect).toBeTypeOf('function');

    const control = renderMarkup(<>{action.control}</>);
    const label = renderMarkup(<>{action.label}</>);
    expect(control).toContain('会话历史');
    expect(control).toContain('data-agent-sessions-trigger');
    expect(label).toContain('会话历史');
  });
});
