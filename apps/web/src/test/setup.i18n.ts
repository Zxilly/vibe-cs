import { i18n } from '@lingui/core';

/*
 * Every vitest project runs this, because a Lingui macro throws — it does not
 * fall back — when no locale is active, and macros are not only in components.
 * `data/replayBinary.ts` and `shared/desktop/client.ts` build their error
 * messages with `t`, so a plain unit test that asserts on a rejection reaches a
 * macro with no React tree anywhere near it.
 *
 * The catalog is empty on purpose. A macro bakes the authored zh-CN string into
 * its own output and falls back to it when the catalog has no entry, so tests
 * read the source text without `lingui compile` ever having run — one less
 * build step between editing a string and seeing the test that asserts on it.
 */
i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
