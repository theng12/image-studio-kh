import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Walk `main/**\/*.js` and emit a `{ <relativeNameWithoutExt>: <absPath> }`
 * map suitable for Rollup's `input`. This replaces the previous explicit
 * entry list — adding a new file under main/ no longer requires editing this
 * config. The packaged-app crash in v0.7.0 ("Cannot find module './_util'")
 * was caused by exactly that footgun.
 *
 * `preload.js` is excluded because the preload script has its own dedicated
 * vite-plugin-electron build target with a different output dir.
 */
function collectMainEntries(rootDir) {
  const entries = {};
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const rel = path.relative(rootDir, abs).replace(/\\/g, '/');
      if (rel === 'preload.js') continue;
      const name = rel.slice(0, -3); // drop .js
      entries[name] = abs;
    }
  }
  walk(rootDir);
  return entries;
}

// Strip `crossorigin` from the <script> and <link> tags Vite emits.
// In a packaged Electron app the renderer is loaded from file:// inside an
// asar archive. Chromium treats file:// origins as opaque, and the CORS
// preflight implied by `crossorigin` fails — so the stylesheet (and module
// script) silently fail to load, leaving the page nearly unstyled. Stripping
// the attribute is safe here: every asset shipped with the app is local.
function stripCrossoriginPlugin() {
  return {
    name: 'iskh:strip-crossorigin',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(/\s+crossorigin(?:="[^"]*")?/g, '');
      },
    },
  };
}

export default defineConfig({
  root: path.resolve(__dirname, 'renderer'),
  publicDir: path.resolve(__dirname, 'renderer/public'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
  },
  plugins: [
    stripCrossoriginPlugin(),
    react(),
    electron({
      main: {
        entry: path.resolve(__dirname, 'main/index.js'),
        vite: {
          build: {
            outDir: path.resolve(__dirname, 'dist-electron/main'),
            lib: false,
            rollupOptions: {
              // Auto-collected from main/**/*.js. Add a new file under main/
              // and it ships in the next build — no edits needed here.
              input: collectMainEntries(path.resolve(__dirname, 'main')),
              external: [
                'electron',
                'better-sqlite3',
                'sharp',
                '@imgly/background-removal',
                'xlsx',
                // v0.15.1: WebSocket library. Kept external so the
                // packaged app loads it from node_modules at runtime;
                // pure-JS with no native deps, no asarUnpack needed.
                'ws',
              ],
              output: {
                format: 'cjs',
                entryFileNames: '[name].js',
                chunkFileNames: 'chunks/[name]-[hash].js',
              },
            },
          },
        },
      },
      preload: {
        input: path.resolve(__dirname, 'main/preload.js'),
        vite: {
          build: {
            outDir: path.resolve(__dirname, 'dist-electron/preload'),
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      renderer: {},
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'renderer'),
    },
  },
  server: {
    port: 5173,
  },
});
