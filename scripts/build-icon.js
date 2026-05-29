/* Render build/icon.svg into all the PNG sizes macOS expects, then pack into icon.icns. */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const sharp = require('sharp');

const buildDir   = path.join(__dirname, '..', 'build');
const sourceSvg  = path.join(buildDir, 'icon.svg');
const iconsetDir = path.join(buildDir, 'icon.iconset');

const SIZES = [
  { name: 'icon_16x16.png',      size: 16 },
  { name: 'icon_16x16@2x.png',   size: 32 },
  { name: 'icon_32x32.png',      size: 32 },
  { name: 'icon_32x32@2x.png',   size: 64 },
  { name: 'icon_128x128.png',    size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png',    size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png',    size: 512 },
  { name: 'icon_512x512@2x.png', size: 1024 },
];

async function main() {
  if (!fs.existsSync(sourceSvg)) {
    throw new Error(`Source SVG missing: ${sourceSvg}`);
  }

  fs.mkdirSync(iconsetDir, { recursive: true });

  // Render every required size from the SVG.
  for (const { name, size } of SIZES) {
    const out = path.join(iconsetDir, name);
    await sharp(sourceSvg, { density: 384 })
      .resize(size, size, { fit: 'cover' })
      .png({ compressionLevel: 9 })
      .toFile(out);
  }

  // 1024×1024 fallback PNG (some platforms / tools prefer a single PNG).
  await sharp(sourceSvg, { density: 384 })
    .resize(1024, 1024, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(buildDir, 'icon.png'));

  // macOS-only: pack the iconset into an .icns.
  if (process.platform === 'darwin') {
    const icnsOut = path.join(buildDir, 'icon.icns');
    execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsOut}"`, { stdio: 'inherit' });
    console.log(`Wrote ${path.relative(process.cwd(), icnsOut)}`);
  } else {
    console.log('Skipping .icns (not on macOS). PNGs are in build/icon.iconset/');
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
