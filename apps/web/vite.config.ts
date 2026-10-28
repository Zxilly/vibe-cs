import { lingui } from '@lingui/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Lingui owns catalog loading and its native pre-transform expands macros
// before React's JSX transform. Vitest uses the same macro transform.
// ── The three settings `create-tauri-app` puts in every template ──────────
//
// This dev server is not browsed to by hand — `tauri.conf.json` names it as
// `devUrl` and the WebView loads whatever answers there. That changes what the
// defaults mean:
//
//   strictPort   Vite's default is to *step to the next free port* when 5173 is
//                taken, print the new one, and carry on. `devUrl` is a fixed
//                string, so the step is silent to Tauri: the window loads
//                whatever else is on 5173, or nothing. Observed exactly that —
//                a second dev server took 5174 while the config still said
//                5173. Failing to start is the correct answer; the port is part
//                of the contract, not a preference.
//   clearScreen  Vite clears the terminal on boot, and `beforeDevCommand` means
//                Vite boots *after* cargo has printed. Rust warnings and the
//                panic that killed the last run are what gets erased.
//   watch        `src-tauri/**` is Rust and Cargo already watches it. It is
//                outside this package, so the glob is only reached when someone
//                runs Vite from the workspace root; it costs nothing and it
//                keeps the recipe whole.
export default defineConfig({
  plugins: [
    react(),
    lingui({ macroTransform: true }),
    tailwindcss(),
  ],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Match package boundaries: react-markdown belongs to the lazy Agent panel.
            { name: 'react', test: /\/node_modules\/(?:react|react-dom|react-router|react-router-dom)\//, priority: 30 },
            { name: 'icons', test: /\/node_modules\/lucide-react\//, priority: 30 },
            { name: 'query', test: /\/node_modules\/@tanstack\/react-query\//, priority: 30 },
            { name: 'i18n', test: /\/node_modules\/@lingui\//, priority: 30 },
            { name: 'state', test: /\/node_modules\/zustand\//, priority: 30 },
            { name: 'editor-layout', test: /\/node_modules\/flexlayout-react\//, priority: 20 },
            // Keep Three's core independent of its WebGL renderer. Both stay behind
            // Scene3DView's dynamic import and can be cached across renderer edits.
            { name: 'three-core', test: /\/node_modules\/three\/build\/three\.core\.js$/, priority: 20 },
            { name: 'three-webgl', test: /\/node_modules\/three\/build\/three\.module\.js$/, priority: 10 },
          ],
        },
      },
    },
  },
});
