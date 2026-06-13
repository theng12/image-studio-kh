/**
 * v0.21.1: files:* + samples:* IPC handlers, extracted from ipc.js.
 *
 * All local-only by definition — OS file pickers, spreadsheet
 * parsing on disk paths, thumbnail generation from absolute paths.
 * In client mode the same channel names are re-registered in
 * main/client/index.js so the dialog runs on the client's Mac.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog } = require('electron');
const fileHandler = require('../fileHandler');

function register(/* helpers — unused */) {
  ipcMain.handle('files:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  /**
   * v0.11.0: read a thumbnail for an arbitrary absolute image
   * path, return a base64 data-URL. Used by the Bulk source picker
   * so it can preview files the user picked but hasn't queued yet
   * (those files haven't been imported into assets/ai-source/ yet,
   * so app-image:// can't serve them).
   */
  ipcMain.handle('files:readImageThumb', async (_e, absPath) => {
    if (!absPath || typeof absPath !== 'string') throw new Error('absPath required');
    if (!fs.existsSync(absPath)) throw new Error('File not found');
    const sharp = require('sharp');
    const buf = await sharp(absPath)
      .rotate()
      .resize({ width: 160, height: 160, fit: 'cover' })
      .jpeg({ quality: 72 })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  });

  ipcMain.handle('files:pickImageFile', async (_e, { multiple = false } = {}) => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', ...(multiple ? ['multiSelections'] : [])],
      filters: [
        // v0.41.0: allow HEIC/HEIF (iPhone photos) — converted to JPEG on import.
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return multiple ? res.filePaths : res.filePaths[0];
  });

  /**
   * v0.49.53: scan a folder for image files (top level + one level of
   * subfolders) and return their absolute paths. Used by the "Watermark
   * external photos" batch tool so a user can drop a whole folder in
   * rather than multi-selecting files. Skips hidden files/dotfolders.
   */
  ipcMain.handle('files:scanImageFiles', async (_e, folderPath) => {
    if (!folderPath || typeof folderPath !== 'string') throw new Error('folderPath required');
    const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
    const out = [];
    function scan(dir, depth) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 1) scan(full, depth + 1); }
        else if (IMG.has(path.extname(e.name).toLowerCase())) out.push(full);
      }
    }
    scan(folderPath, 0);
    out.sort();
    return out;
  });

  ipcMain.handle('files:pickWorkbook', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Spreadsheet', extensions: ['xlsx', 'xls', 'csv', 'tsv'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('files:parseWorkbook', (_e, filePath) => {
    return fileHandler.readWorkbook(filePath);
  });

  ipcMain.handle('samples:generateProductSheet', async () => {
    const res = await dialog.showSaveDialog({
      title: 'Save sample workbook',
      defaultPath: 'image-studio-kh-products-sample.xlsx',
      filters: [{ name: 'Workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fileHandler.writeProductSampleWorkbook(res.filePath);
    return res.filePath;
  });
}

module.exports = { register };
