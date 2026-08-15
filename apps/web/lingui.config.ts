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
      // Test files author Chinese fixture strings — match names, evidence
      // sentences, table captions — and those are not product copy. Without
      // this they extract like any other message: they ship in the compiled
      // catalog, and every fixture edit churns both `.po` files and demands an
      // English translation for a string no user can reach.
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.interaction.test.tsx', '**/test/**'],
    },
  ],
});

export default config;
