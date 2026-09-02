import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { activateAppLocale, activateConfiguredLocale } from './locale';

const DASHBOARD = msg`工作台`;

beforeEach(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

describe('application locale activation', () => {
  it('loads the compiled English catalog before the application renders', async () => {
    await activateAppLocale('en-US');

    expect(i18n.locale).toBe('en-US');
    expect(i18n._(DASHBOARD)).toBe('Dashboard');
  });

  it('uses the source locale for unsupported configuration values', async () => {
    await activateAppLocale('unknown');

    expect(i18n.locale).toBe('zh-CN');
    expect(i18n._(DASHBOARD)).toBe('工作台');
  });

  it('activates the persisted locale returned by the desktop host', async () => {
    const readConfig = vi.fn().mockResolvedValue({ locale: 'en-US' });

    await activateConfiguredLocale(readConfig);

    expect(readConfig).toHaveBeenCalledOnce();
    expect(i18n.locale).toBe('en-US');
    expect(i18n._(DASHBOARD)).toBe('Dashboard');
  });

  it('keeps the source locale when configuration cannot be read', async () => {
    await activateConfiguredLocale(vi.fn().mockRejectedValue(new Error('offline')));

    expect(i18n.locale).toBe('zh-CN');
    expect(i18n._(DASHBOARD)).toBe('工作台');
  });
});
