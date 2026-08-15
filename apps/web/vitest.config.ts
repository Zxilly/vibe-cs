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

export default defineConfig({
  test: {
    coverage: {
      reporter: ['text', 'html'],
    },
    // Three projects, split by what each one can observe:
    //   unit        pure logic, no React tree
    //   markup      renderToStaticMarkup structure / aria assertions
    //   interaction focus, keyboard, overlays, collapse, disabled states
    projects: [
      {
        plugins: macroPlugins(),
        test: {
          name: 'unit',
          environment: 'node',
          css: false,
          include: ['src/**/*.test.ts'],
          exclude: [...configDefaults.exclude],
        },
      },
      {
        plugins: macroPlugins(),
        test: {
          name: 'markup',
          environment: 'node',
          css: false,
          include: ['src/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, INTERACTION_GLOB],
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
          setupFiles: ['./src/test/setup.interaction.ts'],
        },
      },
    ],
  },
});
