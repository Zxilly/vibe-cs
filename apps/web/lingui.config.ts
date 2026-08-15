import { defineConfig } from '@lingui/cli';

// Explicit annotation: `@lingui/conf` (which owns `LinguiConfig`) is not a
// direct dependency, so the inferred type cannot be named portably (TS2883).
const config: ReturnType<typeof defineConfig> = defineConfig({
  // Source locale is zh-CN: the Chinese copy authored inline in JSX/TS *is* the
  // source message. `en-US` is a translated catalog and has to stay complete —
  // `lingui compile --strict` fails when it is not.
  sourceLocale: 'zh-CN',
  locales: ['zh-CN', 'en-US'],
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['src'],
    },
  ],
});

export default config;
