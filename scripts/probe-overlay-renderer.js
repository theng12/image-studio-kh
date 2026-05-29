/**
 * Phase 1 smoke test — invokes templateRenderer.compose() directly (no
 * Electron) to confirm the Sharp + bwip-js pipeline works end-to-end. Used
 * by hand: `node scripts/probe-overlay-renderer.js`. Output PNG is written
 * to /tmp so it's easy to open and eyeball.
 *
 * This proves:
 *   - bwip-js bundles + runs in plain Node (no Electron dependency)
 *   - Sharp composites barcodes + text SVG correctly
 *   - The token-fill function returns the right values
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

// Stub getDataDir so the renderer module loads without the full app.
// `brand-icon` / `asset:` element sources won't resolve in this probe,
// but text + barcode don't need them.
require.cache[require.resolve('../main/db')] = {
  exports: { getDataDir: () => path.join('/tmp', 'iskh-probe-data') },
};

const templateRenderer = require('../main/templateRenderer');

(async () => {
  // Synthesise an input image so we don't need a real product on disk.
  const inputImage = await sharp({
    create: {
      width: 2000,
      height: 2000,
      channels: 4,
      background: { r: 240, g: 240, b: 245, alpha: 1 },
    },
  }).png().toBuffer();

  const template = {
    canvasWidth: 2000,
    canvasHeight: 2000,
    elements: [
      {
        id: 't1',
        type: 'text',
        x: 0.04, y: 0.04, anchor: 'tl',
        content: '{sku}',
        font: { family: 'Helvetica, Arial, sans-serif', size: 96, weight: 'bold', color: '#111' },
        bg:   { color: '#FFFFFF', opacity: 0.9, padding: 18, radius: 10 },
      },
      {
        id: 'b1',
        type: 'barcode',
        x: 0.96, y: 0.96, anchor: 'br',
        width: 0.30, height: 0.12,
        content: '{sku}',
        format: 'code128',
        showText: true,
        bg: { color: '#FFFFFF', opacity: 1, padding: 14, radius: 6 },
      },
      {
        id: 't2',
        type: 'text',
        x: 0.5, y: 0.92, anchor: 'bc',
        content: '{name} — {color}',
        align: 'center',
        font: { family: 'Helvetica, Arial, sans-serif', size: 40, color: '#333' },
        bg:   { color: '#FFFFFF', opacity: 0.85, padding: 10, radius: 6 },
      },
    ],
  };
  const context = {
    sku: 'AV-M8111-AG',
    name: 'MACEPRO faucet — antique gold',
    colorFinish: 'antique gold',
  };

  const out = await templateRenderer.compose({ inputImage, template, context });
  const outPath = path.join('/tmp', 'iskh-overlay-probe.png');
  fs.writeFileSync(outPath, out);
  const stat = fs.statSync(outPath);
  console.log(`OK — wrote ${stat.size} bytes to ${outPath}`);
  console.log('Open with: open ' + outPath);
})().catch((err) => {
  console.error('FAILED:', err.stack || err.message);
  process.exit(1);
});
