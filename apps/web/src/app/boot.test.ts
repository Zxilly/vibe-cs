/*
 * `unit` project — the boot invariant.
 *
 * Small, but it holds two things down: the message is translated (not an
 * English developer string that would leak into a zh-CN build), and it is
 * produced by a call rather than by a module-level constant, so it resolves
 * against whatever catalog is active at the moment it is raised.
 */

import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { activateBootPreferences, missingRootError } from './boot';

/* The same macro call as `boot.ts`, so its generated catalog id is available
   here without hard-coding a hash that `lingui extract` owns. */
const MISSING_ROOT = msg`页面根节点 #root 不存在，应用无法启动`;

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

describe('missingRootError', () => {
  it('is an Error, so the failure keeps its stack', () => {
    expect(missingRootError()).toBeInstanceOf(Error);
  });

  it('names what is missing in the product language', () => {
    expect(missingRootError().message).toBe('页面根节点 #root 不存在，应用无法启动');
  });

  it('resolves at call time, not at import time', () => {
    i18n.loadAndActivate({
      locale: 'en-US',
      messages: { [MISSING_ROOT.id as string]: 'The #root element is missing' },
    });
    expect(missingRootError().message).toBe('The #root element is missing');

    i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
    expect(missingRootError().message).toBe('页面根节点 #root 不存在，应用无法启动');
  });
});

describe('activateBootPreferences', () => {
  it('applies persisted theme, reduced motion and locale from one config read', async () => {
    const attrs = new Map<string, string>();
    const target = {
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
    };
    const readConfig = vi.fn().mockResolvedValue({
      locale: 'en-US',
      theme: 'dark',
      reduce_motion: true,
    });

    const result = await activateBootPreferences(readConfig, target);

    expect(readConfig).toHaveBeenCalledOnce();
    expect(result).toEqual({ locale: 'en-US', theme: 'dark' });
    expect(attrs.get('data-theme')).toBe('dark');
    expect(attrs.get('data-reduce-motion')).toBe('true');

    i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
  });

  it('falls back to system theme and zh-CN when config cannot be read', async () => {
    const attrs = new Map<string, string>([['data-theme', 'dark']]);
    const target = {
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
    };

    const result = await activateBootPreferences(vi.fn().mockRejectedValue(new Error('offline')), target);

    expect(result).toEqual({ locale: 'zh-CN', theme: 'system' });
    expect(attrs.has('data-theme')).toBe(false);
  });
});
