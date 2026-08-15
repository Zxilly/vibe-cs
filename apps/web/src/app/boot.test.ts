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
import { beforeAll, describe, expect, it } from 'vitest';

import { missingRootError } from './boot';

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
