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
