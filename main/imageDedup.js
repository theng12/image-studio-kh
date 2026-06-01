/**
 * Near-duplicate image detection + merge (v0.28.0).
 *
 * Why: byte-level dedup (content_hash) only catches identical files. When
 * several clients import their own re-saved copies of the same product
 * photo, the bytes differ → separate library images. This module finds the
 * visually-identical copies via perceptual hash and merges each cluster
 * down to one survivor — REVERTABLY: removed files are quarantined (moved
 * aside, not destroyed) and the batch is logged to image_merge_ops so the
 * whole merge can be undone.
 *
 * Scope: grouping happens WITHIN each product (images that all attached to
 * the same SKU). It never merges across products — two different products
 * that happen to look alike must stay separate.
 *
 * All file paths in product_images.filepath are relative to
 * `<dataDir>/assets/`; processed_filepath is relative to `<dataDir>/`.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const { getDb, getDataDir } = require('./db');
const productImages = require('./db/productImages');
const phash = require('./util/phash');

function assetsAbs(rel) { return path.join(getDataDir(), 'assets', rel); }
function dataAbs(rel) { return path.join(getDataDir(), rel); }
function quarantineDir(opId) { return path.join(getDataDir(), '.merge-trash', opId); }

/** Rows for the scan, optionally scoped to a company. Joined with products
 *  so we can show SKU/name and skip orphans. */
function imageRowsForScan(companyId) {
  const db = getDb();
  // v0.31.0: never group images flagged dedup_exempt (export-derived web
  // copies) — otherwise a small export would be flagged against, and could
  // replace, its own hi-res original.
  const exemptClause = '(pi.dedup_exempt IS NULL OR pi.dedup_exempt = 0)';
  const sql = `
    SELECT pi.id, pi.product_id, pi.filepath, pi.processed_filepath, pi.is_processed,
           pi.order_index, pi.perceptual_hash, pi.created_at,
           p.sku AS sku, p.name AS product_name, p.company_id AS company_id
      FROM product_images pi
      JOIN products p ON p.id = pi.product_id
     WHERE ${exemptClause}${companyId ? ' AND p.company_id = ?' : ''}
     ORDER BY pi.product_id ASC, pi.order_index ASC`;
  return companyId ? db.prepare(sql).all(companyId) : db.prepare(sql).all();
}

/** Ensure a row has a perceptual hash; compute + cache from its file if not.
 *  Returns the hash (or null if the file is missing/undecodable). */
async function ensureHash(row) {
  if (row.perceptual_hash) return row.perceptual_hash;
  const abs = assetsAbs(row.filepath);
  if (!fs.existsSync(abs)) return null;
  const h = await phash.perceptualHash(abs);
  if (h) productImages.setPerceptualHashById(row.id, h);
  return h;
}

/** Decode just enough metadata to rank survivors: pixel area + file size. */
async function imageRank(row) {
  const abs = assetsAbs(row.filepath);
  let width = 0; let height = 0; let size = 0;
  try { const st = fs.statSync(abs); size = st.size; } catch (_) {}
  try { const m = await sharp(abs, { failOn: 'none' }).metadata(); width = m.width || 0; height = m.height || 0; } catch (_) {}
  return { width, height, area: width * height, size };
}

/**
 * Scan for near-duplicate image groups.
 * @param {object} args
 * @param {string} [args.companyId]   scope to one company (else whole library)
 * @param {number} [args.thresholdPct=95] similarity % (higher = stricter)
 * @param {(p:{phase:string, done:number, total:number}) => void} [args.onProgress]
 * @returns {Promise<{ groups: object[], stats: object }>}
 */
async function scanDuplicates({ companyId, thresholdPct = 95, onProgress } = {}) {
  const maxDistance = phash.pctToMaxDistance(thresholdPct);
  const rows = imageRowsForScan(companyId);

  // 1. Hash (lazy backfill). Most rows will already be hashed after the
  //    first run; only new imports need a decode.
  let hashedNew = 0;
  const total = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.perceptual_hash) {
      const h = await ensureHash(row);
      if (h) { row.perceptual_hash = h; hashedNew++; }
    }
    if (onProgress && (i % 25 === 0 || i === rows.length - 1)) {
      onProgress({ phase: 'hashing', done: i + 1, total });
    }
  }

  // 2. Group WITHIN each product.
  const byProduct = new Map();
  for (const row of rows) {
    if (!row.perceptual_hash) continue;
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(row);
  }

  const groups = [];
  let duplicatesFound = 0;
  for (const [, imgs] of byProduct) {
    if (imgs.length < 2) continue;
    const clusters = phash.groupByHamming(
      imgs.map((r) => ({ id: r.id, hash: r.perceptual_hash })),
      maxDistance,
    );
    for (const ids of clusters) {
      const members = ids.map((id) => imgs.find((r) => r.id === id)).filter(Boolean);
      if (members.length < 2) continue;
      // Rank for the keep-rule: keep MAIN (order_index 0) if present, else
      // highest pixel area, else largest file.
      const ranked = [];
      for (const m of members) ranked.push({ row: m, rank: await imageRank(m) });
      ranked.sort((a, b) => {
        const aMain = a.row.order_index === 0 ? 1 : 0;
        const bMain = b.row.order_index === 0 ? 1 : 0;
        if (aMain !== bMain) return bMain - aMain;            // main first
        if (b.rank.area !== a.rank.area) return b.rank.area - a.rank.area; // bigger pixels
        return b.rank.size - a.rank.size;                     // bigger file
      });
      const keepId = ranked[0].row.id;
      duplicatesFound += members.length - 1;
      const sample = members[0];
      groups.push({
        productId: sample.product_id,
        sku: sample.sku,
        productName: sample.product_name,
        keepId,
        images: ranked.map(({ row, rank }) => ({
          id: row.id,
          filepath: row.filepath,
          processedFilepath: row.processed_filepath,
          isProcessed: !!row.is_processed,
          orderIndex: row.order_index,
          isMain: row.order_index === 0,
          width: rank.width,
          height: rank.height,
          fileSize: rank.size,
        })),
      });
    }
  }

  return {
    groups,
    stats: {
      productsScanned: byProduct.size,
      imagesScanned: total,
      hashedNew,
      groupsFound: groups.length,
      duplicatesFound,
      thresholdPct,
    },
  };
}

/** PLAN a quarantine move (no I/O): given a relative path, return
 *  `{ fromAbs, toAbs }` for a unique destination in this op's trash dir,
 *  or null if the source doesn't exist. The actual move happens later,
 *  AFTER the DB transaction commits (see mergeGroups). */
function planQuarantine(opId, relPath, isProcessed) {
  if (!relPath) return null;
  const fromAbs = isProcessed ? dataAbs(relPath) : assetsAbs(relPath);
  if (!fs.existsSync(fromAbs)) return null;
  // Unique name so two removed rows can't collide in the trash.
  const toAbs = path.join(quarantineDir(opId), `${crypto.randomUUID()}-${path.basename(relPath)}`);
  return { fromAbs, toAbs };
}

/** Execute a planned move (rename, with cross-device copy+unlink fallback).
 *  Best-effort: on failure the source is left in place (revert recovers
 *  from the original path). */
function executeQuarantineMove(mv) {
  try { fs.renameSync(mv.fromAbs, mv.toAbs); }
  catch (_) {
    try { fs.copyFileSync(mv.fromAbs, mv.toAbs); fs.unlinkSync(mv.fromAbs); } catch (_2) {/* leave original */}
  }
}

/**
 * Merge the chosen groups. Each decision = { productId, keepId, removeIds }.
 * Survivors are never touched; removed rows are snapshotted + logged to
 * image_merge_ops (for revert), their rows deleted, their files moved to
 * quarantine, and the surviving images renumbered.
 *
 * CRITICAL ordering (fixed in v0.34.2): the DB transaction does ONLY DB
 * work — no filesystem moves. The undo record (with each removed file's
 * planned quarantine path) is committed FIRST; the actual file moves run
 * AFTER the commit. This makes the operation crash-safe: if anything
 * throws mid-batch, the transaction rolls back cleanly with no files
 * moved; if a post-commit move fails (or we crash), the file stays at its
 * original path and revert still recovers it (revert falls back to the
 * original path when the quarantined copy is missing). Previously the
 * moves ran inside the tx, so a rollback could leave files quarantined
 * with no committed undo record → silent image loss.
 *
 * @returns {{ opId, merged, removed, groups }}
 */
function mergeGroups({ decisions = [], thresholdPct = 95, mode = 'review', companyId = null } = {}) {
  const db = getDb();
  const opId = crypto.randomUUID();
  const removedSnapshots = [];
  const fileMoves = [];          // { fromAbs, toAbs } — executed AFTER commit
  const touchedProducts = new Set();

  // ── Phase 1: PLAN. Read the rows + decide quarantine targets. No DB
  //    writes, no file moves — so bailing here leaves nothing half-done.
  for (const dec of decisions) {
    const { productId, removeIds = [] } = dec || {};
    if (!productId || removeIds.length === 0) continue;
    for (const rid of removeIds) {
      const row = db.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?').get(rid, productId);
      if (!row) continue;
      // Only quarantine the asset file if no OTHER row references it.
      const assetShared = productImages.countByFilepath(row.filepath) > 1;
      const assetPlan = assetShared ? null : planQuarantine(opId, row.filepath, false);
      // Processed file is per-row (never shared) — safe to move if present.
      const procPlan = row.processed_filepath ? planQuarantine(opId, row.processed_filepath, true) : null;
      if (assetPlan) fileMoves.push(assetPlan);
      if (procPlan) fileMoves.push(procPlan);
      removedSnapshots.push({
        row: {
          id: row.id,
          product_id: row.product_id,
          filename: row.filename,
          filepath: row.filepath,
          original_filepath: row.original_filepath,
          order_index: row.order_index,
          is_processed: row.is_processed,
          processed_filepath: row.processed_filepath,
          workspace_settings: row.workspace_settings,
          content_hash: row.content_hash,
          perceptual_hash: row.perceptual_hash,
          created_at: row.created_at,
        },
        quarantine: {
          asset: assetPlan ? assetPlan.toAbs : null,
          processed: procPlan ? procPlan.toAbs : null,
          assetWasShared: assetShared,
        },
      });
      touchedProducts.add(productId);
    }
  }

  if (removedSnapshots.length === 0) {
    return { opId: null, merged: 0, removed: 0, groups: 0 };
  }

  const groupCount = decisions.filter((d) => (d.removeIds || []).length > 0).length;

  // ── Phase 2: DB transaction — delete rows, reindex order, write the undo
  //    log. DB-only and atomic; the merge-op (carrying the quarantine
  //    targets) is durable before any file is touched.
  const tx = db.transaction(() => {
    const del = db.prepare('DELETE FROM product_images WHERE id = ?');
    for (const snap of removedSnapshots) del.run(snap.row.id);
    const upd = db.prepare('UPDATE product_images SET order_index = ? WHERE id = ?');
    for (const pid of touchedProducts) {
      const remaining = db
        .prepare('SELECT id FROM product_images WHERE product_id = ? ORDER BY order_index ASC')
        .all(pid);
      remaining.forEach((r, i) => upd.run(i, r.id));
    }
    db.prepare(
      `INSERT INTO image_merge_ops
        (id, created_at, company_id, threshold_pct, mode, group_count, removed_count, removed_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(opId, Date.now(), companyId ?? null, thresholdPct, mode, groupCount, removedSnapshots.length, JSON.stringify(removedSnapshots));
  });
  tx();

  // ── Phase 3: AFTER commit, move removed files to quarantine. Best-effort
  //    — a failure here leaves the file at its original path, and revert
  //    recovers it from there.
  if (fileMoves.length) {
    try { fs.mkdirSync(quarantineDir(opId), { recursive: true }); } catch (_) {}
    for (const mv of fileMoves) executeQuarantineMove(mv);
  }

  // ── Phase 4: renumber surviving files so NNN slots stay contiguous.
  for (const pid of touchedProducts) {
    try { productImages.renumberFiles(pid); } catch (_) {/* best-effort */}
  }

  return { opId, merged: touchedProducts.size, removed: removedSnapshots.length, groups: groupCount };
}

function rowToOp(row) {
  if (!row) return null;
  let removed = [];
  try { removed = JSON.parse(row.removed_json || '[]'); } catch (_) {}
  return {
    id: row.id,
    createdAt: row.created_at,
    companyId: row.company_id,
    thresholdPct: row.threshold_pct,
    mode: row.mode,
    groupCount: row.group_count,
    removedCount: row.removed_count,
    revertedAt: row.reverted_at,
    purgedAt: row.purged_at,
    canRevert: !row.reverted_at && !row.purged_at && removed.length > 0,
  };
}

function listMergeOps({ companyId, limit = 20 } = {}) {
  const db = getDb();
  const sql = `SELECT * FROM image_merge_ops
               ${companyId ? 'WHERE (company_id = ? OR company_id IS NULL)' : ''}
               ORDER BY created_at DESC LIMIT ?`;
  const rows = companyId ? db.prepare(sql).all(companyId, limit) : db.prepare(sql).all(limit);
  return rows.map(rowToOp);
}

/**
 * Revert a merge: re-insert the removed rows and move their quarantined
 * files back. Restored images are APPENDED to their product (positions may
 * differ from before the merge — the point is to get the images back; the
 * survivor and main image were never touched). Best-effort per row.
 */
function revertMergeOp(opId) {
  const db = getDb();
  const op = db.prepare('SELECT * FROM image_merge_ops WHERE id = ?').get(opId);
  if (!op) throw new Error('Merge operation not found');
  if (op.reverted_at) throw new Error('This merge was already reverted');
  if (op.purged_at) throw new Error('This merge was permanently purged and can no longer be reverted');
  let removed = [];
  try { removed = JSON.parse(op.removed_json || '[]'); } catch (_) {}

  const touchedProducts = new Set();
  let restored = 0;

  const tx = db.transaction(() => {
    for (const entry of removed) {
      const r = entry.row;
      // Product must still exist (CASCADE would have dropped its images).
      const prod = db.prepare('SELECT id FROM products WHERE id = ?').get(r.product_id);
      if (!prod) continue;

      // Restore the asset file. If it was shared (never quarantined) the
      // original file is still on disk → reuse it. Otherwise move the
      // quarantined copy back to its original relative path.
      let restoredFilepath = r.filepath;
      if (entry.quarantine && entry.quarantine.asset && !entry.quarantine.assetWasShared) {
        const destAbs = assetsAbs(r.filepath);
        try {
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          if (fs.existsSync(destAbs)) {
            // Slot got reused by a renumber — restore under a fresh name.
            const ext = path.extname(r.filepath);
            const freshRel = path.posix.join(path.posix.dirname(r.filepath), `restored-${crypto.randomUUID()}${ext}`);
            const freshAbs = assetsAbs(freshRel);
            fs.renameSync(entry.quarantine.asset, freshAbs);
            restoredFilepath = freshRel;
          } else {
            fs.renameSync(entry.quarantine.asset, destAbs);
          }
        } catch (_) {/* if the move fails, still re-add the row pointing at original */}
      }

      // Restore processed file if it was quarantined.
      if (entry.quarantine && entry.quarantine.processed && r.processed_filepath) {
        try {
          const destAbs = dataAbs(r.processed_filepath);
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          if (!fs.existsSync(destAbs)) fs.renameSync(entry.quarantine.processed, destAbs);
        } catch (_) {}
      }

      // Append the row at the end of the product's current order.
      const nextOrder = (db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM product_images WHERE product_id = ?')
        .get(r.product_id).m ?? -1) + 1;
      const newId = db.prepare('SELECT id FROM product_images WHERE id = ?').get(r.id) ? crypto.randomUUID() : r.id;
      db.prepare(
        `INSERT INTO product_images
          (id, product_id, filename, filepath, original_filepath, order_index, is_processed, processed_filepath, workspace_settings, content_hash, perceptual_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId, r.product_id, path.posix.basename(restoredFilepath), restoredFilepath,
        r.original_filepath, nextOrder, r.is_processed, r.processed_filepath,
        r.workspace_settings || '{}', r.content_hash, r.perceptual_hash, r.created_at,
      );
      touchedProducts.add(r.product_id);
      restored++;
    }
    db.prepare('UPDATE image_merge_ops SET reverted_at = ? WHERE id = ?').run(Date.now(), opId);
  });
  tx();

  for (const pid of touchedProducts) {
    try { productImages.renumberFiles(pid); } catch (_) {}
  }

  // Clean up the (now-empty) quarantine dir.
  try { fs.rmSync(quarantineDir(opId), { recursive: true, force: true }); } catch (_) {}

  return { restored, products: touchedProducts.size, productIds: [...touchedProducts] };
}

/** Permanently delete the quarantined files for a merge op (frees disk;
 *  the merge can no longer be reverted afterwards). */
function purgeMergeOp(opId) {
  const db = getDb();
  const op = db.prepare('SELECT * FROM image_merge_ops WHERE id = ?').get(opId);
  if (!op) throw new Error('Merge operation not found');
  try { fs.rmSync(quarantineDir(opId), { recursive: true, force: true }); } catch (_) {}
  db.prepare('UPDATE image_merge_ops SET purged_at = ? WHERE id = ?').run(Date.now(), opId);
  return { ok: true };
}

/** Total bytes + op count sitting in the quarantine trash. Cheap stat walk;
 *  used by the modal to show "Quarantined: X MB" and gate the purge button. */
function quarantineInfo() {
  const root = path.join(getDataDir(), '.merge-trash');
  let totalBytes = 0;
  let opCount = 0;
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      opCount++;
      const dir = path.join(root, d.name);
      try {
        for (const f of fs.readdirSync(dir)) {
          try { totalBytes += fs.statSync(path.join(dir, f)).size; } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (_) { /* no trash dir yet */ }
  return { totalBytes, opCount };
}

/** Permanently purge every still-revertable merge op (frees all quarantine
 *  disk). Reverted ops are skipped (their files were already restored).
 *  Returns how many ops were purged. */
function purgeAll() {
  const db = getDb();
  const ops = db.prepare('SELECT id FROM image_merge_ops WHERE purged_at IS NULL AND reverted_at IS NULL').all();
  let purged = 0;
  for (const o of ops) {
    try { purgeMergeOp(o.id); purged++; } catch (_) {}
  }
  // Safety net: remove any stray quarantine dirs not tracked by a row.
  try { fs.rmSync(path.join(getDataDir(), '.merge-trash'), { recursive: true, force: true }); } catch (_) {}
  return { purged };
}

module.exports = {
  scanDuplicates,
  mergeGroups,
  listMergeOps,
  revertMergeOp,
  purgeMergeOp,
  quarantineInfo,
  purgeAll,
};
