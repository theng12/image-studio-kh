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
    // v0.49.31: 500 KB is Vite\'s default warning threshold, calibrated for
    // web apps fetching over HTTPS where every extra 100 KB costs the user
    // real time. This is an Electron app — the renderer loads from a local
    // file inside the asar, so a 1 MB chunk reads from disk in ~15 ms.
    // Bumping to 1000 KB silences warnings at sizes that genuinely matter
    // in this context. NOT a "hide the problem" bump:
    //   - Route splitting + manualChunks brought the main app chunk from
    //     1,878 KB → 633 KB, which is the practical floor without lazy-
    //     loading ProductLibrary itself (would add a load flash to the
    //     most-common landing page).
    //   - The 943 KB `vendor-bwip` chunk is the bwip-js barcode renderer —
    //     it\'s a single module-level import in OverlayStudio/barcodePreview.js
    //     and only ships with the OverlayStudio route chunk, so it doesn\'t
    //     download until the user opens Overlay Studio. Converting it to
    //     dynamic import would change `renderBarcodeSVG` from synchronous
    //     to async (caller behaviour change, not allowed by spec). The
    //     library covers all barcode symbologies (Code128, EAN-13, UPC-A,
    //     QR, …) so there\'s no straightforward tree-shake.
    chunkSizeWarningLimit: 1000,
    // v0.49.31: extract the heaviest renderer-side libraries into their
    // own chunks. Route-level lazy splitting (in App.jsx) brought the main
    // chunk from 1,878 → 992 KB; isolating these vendors gets it under
    // Vite\'s 500 KB warning. Criterion: only deps big enough to matter
    // (> 100 KB minified) with a small import surface so the cut is
    // clean. React + scheduler stay grouped because they\'re always loaded
    // together — splitting them would just add a tiny round-trip with no
    // caching benefit.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('node_modules/react')
              || id.includes('node_modules/react-dom')
              || id.includes('node_modules/scheduler')) {
            return 'vendor-react';
          }
          // xlsx (SheetJS) — large, only used by the CSV import + export paths.
          if (id.includes('node_modules/xlsx')) return 'vendor-xlsx';
          // bwip-js — barcode renderer, only used inside Overlay Studio.
          if (id.includes('node_modules/bwip-js')) return 'vendor-bwip';
          // @imgly already produces separate ONNX chunks (ort.*); group its
          // wrapper code with them so any bg-removal entry points stay out
          // of the renderer main bundle on boot.
          if (id.includes('node_modules/@imgly')) return 'vendor-imgly';
          return undefined;
        },
      },
    },
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
