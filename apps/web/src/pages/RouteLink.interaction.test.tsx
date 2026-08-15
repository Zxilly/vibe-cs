/*
 * `interaction` project — the hash prefix.
 *
 * `HashRouter` reads `document.location` while it constructs its history, so it
 * cannot be rendered in the node-environment `markup` project at all. This is
 * the case that matters most, though: spec §1.1 keeps the app in hash mode, and
 * the whole reason `RouteLink` exists is so no page writes `#` by hand.
 */

import { HashRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderInteractive } from '../test/render';
import { RouteLink } from './RouteLink';

describe('RouteLink in hash mode', () => {
  it('prefixes the address with the hash the router owns', () => {
    const { container } = renderInteractive(
      <HashRouter>
        <RouteLink to="/delivery?view=tasks">任务记录</RouteLink>
      </HashRouter>,
    );

    expect(container.querySelector('a')?.getAttribute('href')).toBe('#/delivery?view=tasks');
  });

  it('navigates without a reload, which is what hash routing buys', () => {
    const { container } = renderInteractive(
      <HashRouter>
        <RouteLink to="/library">资料库</RouteLink>
      </HashRouter>,
    );

    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('target')).toBeNull();
    expect(anchor?.getAttribute('href')?.startsWith('#')).toBe(true);
  });
});
