import { linguiTransformerBabelPreset } from '@lingui/vite-plugin';
import babel from '@rolldown/plugin-babel';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import type { PluginOption } from 'vite';

// Vitest loads this file *instead of* vite.config.ts, so the macro transform
// has to be registered here as well — otherwise `<Trans>` / `t` macros would
// reach the test runner untransformed and fail at import time.
// Mirrors vite.config.ts: react() first, Babel macro pass after.
const macroPlugins = (): PluginOption[] => [
  react(),
  babel({ presets: [linguiTransformerBabelPreset()] }) as PluginOption,
];

const INTERACTION_GLOB = 'src/**/*.interaction.test.tsx';

// All three projects need an active locale: a Lingui macro throws without one,
// and macros are not confined to components — see the file's own comment.
const I18N_SETUP = './src/test/setup.i18n.ts';

// The Radix APIs jsdom is missing. Both DOM projects load it; see the file.
const DOM_SETUP = './src/test/setup.dom.ts';

export default defineConfig({
  test: {
    coverage: {
      reporter: ['text', 'html'],
    },
    // Three projects, split by what each one can observe:
    //   unit        pure logic, no React tree
    //   markup      structure / aria assertions over a rendered tree
    //   interaction focus, keyboard, overlays, collapse, disabled states
    //
    // `markup` ran in `node` until the design layer moved onto Radix. Radix
    // touches `document` while mounting and puts every overlay through a
    // portal, and `react-dom/server` supports neither — so a structural test
    // of a Dialog under `renderToStaticMarkup` could only ever assert that
    // nothing rendered. jsdom costs the project roughly a second in total and
    // leaves every existing `renderToStaticMarkup` assertion working
    // unchanged: it is a string renderer, and jsdom only adds the globals it
    // was already free to ignore.
    projects: [
      {
        plugins: macroPlugins(),
        test: {
          name: 'unit',
          environment: 'node',
          css: false,
          include: ['src/**/*.test.ts'],
          exclude: [...configDefaults.exclude],
          setupFiles: [I18N_SETUP],
        },
      },
      {
        plugins: macroPlugins(),
        test: {
          name: 'markup',
          environment: 'jsdom',
          css: false,
          include: ['src/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, INTERACTION_GLOB],
          setupFiles: [I18N_SETUP, DOM_SETUP],
        },
      },
      {
        plugins: macroPlugins(),
        test: {
          name: 'interaction',
          environment: 'jsdom',
          css: false,
          include: [INTERACTION_GLOB],
          exclude: [...configDefaults.exclude],
          setupFiles: [I18N_SETUP, DOM_SETUP],
        },
      },
    ],
  },
});
