import { i18n } from '@lingui/core';

export type AppLocale = 'zh-CN' | 'en-US';

const SOURCE_LOCALE: AppLocale = 'zh-CN';

export async function activateAppLocale(locale: string): Promise<AppLocale> {
  if (locale !== 'en-US') {
    i18n.loadAndActivate({ locale: SOURCE_LOCALE, messages: {} });
    return SOURCE_LOCALE;
  }

  const { messages } = await import('../locales/en-US/messages');
  i18n.loadAndActivate({ locale: 'en-US', messages });
  return 'en-US';
}

export async function activateConfiguredLocale(
  readConfig: () => Promise<{ readonly locale: string }>,
): Promise<AppLocale> {
  try {
    const config = await readConfig();
    return await activateAppLocale(config.locale);
  } catch {
    return activateAppLocale(SOURCE_LOCALE);
  }
}
