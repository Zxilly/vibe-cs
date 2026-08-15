import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';

// Plugin order is load-bearing and must not be reordered:
//   1. `react()` sets up the JSX transform and fast refresh.
//   2. `lingui()` resolves the `.po` catalogs at build time.
//   3. the Babel pass expands the Lingui macros (`<Trans>`, `t`, `plural`, …)
//      into runtime calls. It has to run over source that still contains the
//      macro imports, so it stays behind `lingui()` and ahead of Tailwind.
//   4. `tailwindcss()` last.
//
// NOTE: the design doc writes this as
// `react({ babel: { plugins: ['@lingui/babel-plugin-lingui-macro'] } })`.
// That option no longer exists: @vitejs/plugin-react 6 (the Vite 8 / Rolldown
// line) dropped its Babel pipeline entirely and only configures oxc, so the
// `babel` key is silently ignored and the macros reach the bundler
// untransformed. `@rolldown/plugin-babel` + `linguiTransformerBabelPreset()` is
// the supported replacement and is what @lingui/vite-plugin 6 documents.
// The macro plugin package is still required — the preset loads it.
export default defineConfig({
  plugins: [
    react(),
    lingui(),
    babel({ presets: [linguiTransformerBabelPreset()] }) as PluginOption,
    tailwindcss(),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/react') || id.includes('/node_modules/react-dom') || id.includes('/node_modules/react-router-dom')) {
            return 'react';
          }
          if (id.includes('/node_modules/lucide-react')) {
            return 'icons';
          }
          if (id.includes('/node_modules/@tanstack/react-query')) {
            return 'query';
          }
          if (id.includes('/node_modules/@lingui/')) {
            return 'i18n';
          }
          if (id.includes('/node_modules/zustand')) {
            return 'state';
          }
          return undefined;
        },
      },
    },
  },
});
