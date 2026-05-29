import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Modal } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAppStore } from '../../store/index.js';
import { appImageSrc } from '../../lib/imageUrl.js';

/**
 * v0.28.0: near-duplicate image review + merge.
 *
 * Byte-level dedup misses the same photo re-saved on a different Mac (the
 * multi-client copy-around problem). This scans every product's images for
 * VISUALLY near-identical groups (perceptual hash) and lets the user merge
 * each cluster down to one survivor. Removed images are quarantined, not
 * destroyed — every merge is revertable from the "Recent merges" list.
 *
 * Flow: pick a similarity threshold → Scan → review the groups (change the
 * survivor or untick a group) → Merge. The threshold slider is the user's
 * "how identical counts as a duplicate" control.
 */
function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function fmtBytes(n) {
  if (!n) return '0 KB';
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function DuplicateMergeModal({ open, onClose }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const refreshDashboard = useAppStore((s) => s.refreshDashboard);
  const addToast = useAppStore((s) => s.addToast);

  const [step, setStep] = useState('intro'); // intro | scanning | review | merging | results
  const [thresholdPct, setThresholdPct] = useState(95);
  const [groups, setGroups] = useState([]); // [{ key, productId, sku, productName, keepId, included, images }]
  const [stats, setStats] = useState(null);
  const [result, setResult] = useState(null);
  const [recentOps, setRecentOps] = useState([]);
  const [quarantine, setQuarantine] = useState({ totalBytes: 0, opCount: 0 });
  const [nonce, setNonce] = useState(0); // cache-bust thumbnails per scan

  const loadRecentOps = useCallback(async () => {
    try {
      const [ops, q] = await Promise.all([
        window.api.images.listMergeOps(activeCompanyId, 10),
        window.api.images.quarantineInfo().catch(() => ({ totalBytes: 0, opCount: 0 })),
      ]);
      setRecentOps(ops || []);
      setQuarantine(q || { totalBytes: 0, opCount: 0 });
    } catch (_) { /* non-fatal */ }
  }, [activeCompanyId]);

  useEffect(() => {
    if (open) loadRecentOps();
  }, [open, loadRecentOps]);

  function reset() {
    setStep('intro');
    setGroups([]);
    setStats(null);
    setResult(null);
  }
  function handleClose() { reset(); onClose(); }

  async function handleScan() {
    setStep('scanning');
    try {
      const { groups: found, stats: s } = await window.api.images.findDuplicates(activeCompanyId, thresholdPct);
      setStats(s);
      setNonce(Date.now());
      setGroups((found || []).map((g) => ({
        ...g,
        key: g.images[0]?.id || `${g.productId}-${Math.random()}`,
        included: true,
      })));
      setStep('review');
    } catch (err) {
      addToast(err.message, 'error');
      setStep('intro');
    }
  }

  function setKeep(key, imageId) {
    setGroups((gs) => gs.map((g) => (g.key === key ? { ...g, keepId: imageId } : g)));
  }
  function toggleInclude(key) {
    setGroups((gs) => gs.map((g) => (g.key === key ? { ...g, included: !g.included } : g)));
  }
  function setAllIncluded(v) {
    setGroups((gs) => gs.map((g) => ({ ...g, included: v })));
  }

  const totals = useMemo(() => {
    let groupsIn = 0; let willRemove = 0;
    for (const g of groups) {
      if (!g.included) continue;
      groupsIn += 1;
      willRemove += g.images.filter((im) => im.id !== g.keepId).length;
    }
    return { groupsIn, willRemove };
  }, [groups]);

  async function handleMerge() {
    const decisions = groups
      .filter((g) => g.included)
      .map((g) => ({
        productId: g.productId,
        keepId: g.keepId,
        removeIds: g.images.filter((im) => im.id !== g.keepId).map((im) => im.id),
      }))
      .filter((d) => d.removeIds.length > 0);
    if (decisions.length === 0) { addToast('Nothing selected to merge', 'info'); return; }
    setStep('merging');
    try {
      const res = await window.api.images.mergeDuplicates({
        decisions, thresholdPct, mode: 'review', companyId: activeCompanyId,
      });
      setResult(res);
      setStep('results');
      await Promise.all([refreshProducts(), refreshDashboard(), loadRecentOps()]);
    } catch (err) {
      addToast(err.message, 'error');
      setStep('review');
    }
  }

  async function handleRevert(opId) {
    try {
      const res = await window.api.images.revertMerge(opId);
      addToast(`Restored ${res.restored} image${res.restored === 1 ? '' : 's'}`, 'success');
      await Promise.all([refreshProducts(), refreshDashboard(), loadRecentOps()]);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  // v0.28.1: fire-and-forget automatic merge. Runs server-side off the
  // global progress UI so the user doesn't sit and wait — we close the
  // modal and surface a toast when it resolves. Store actions stay valid
  // after unmount, so the .then runs fine even though the modal is gone.
  async function handleAutoMerge() {
    const ok = await confirm({
      title: 'Apply automatically?',
      message: `Scan and merge every near-duplicate group at ≥${thresholdPct}% — no review screen.`,
      detail: 'Runs in the background; removed images are quarantined so you can still undo from "Recent merges". Best once you\'ve reviewed a batch or two and trust the matching.',
      confirmLabel: 'Apply automatically',
    });
    if (!ok) return;
    handleClose();
    addToast('Auto-merge started — running in the background…', 'info');
    try {
      const res = await window.api.images.autoMergeDuplicates(activeCompanyId, thresholdPct);
      if (res.removed > 0) {
        addToast(`Auto-merge done: removed ${res.removed} duplicate${res.removed === 1 ? '' : 's'} across ${res.merged} product${res.merged === 1 ? '' : 's'}. Undo in Merge duplicates.`, 'success');
      } else {
        addToast('Auto-merge finished — no duplicates found.', 'info');
      }
      await Promise.all([refreshProducts(), refreshDashboard()]);
    } catch (err) {
      addToast(`Auto-merge failed: ${err.message}`, 'error');
    }
  }

  async function handlePurge(opId) {
    const ok = await confirm({
      title: 'Permanently delete quarantined images?',
      message: 'This frees the disk space, but this merge can no longer be undone afterwards.',
      confirmLabel: 'Purge',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.api.images.purgeMerge(opId);
      addToast('Quarantined images purged', 'success');
      await loadRecentOps();
    } catch (err) { addToast(err.message, 'error'); }
  }

  async function handlePurgeAll() {
    const ok = await confirm({
      title: 'Purge all quarantined images?',
      message: `Permanently deletes the quarantined files (${fmtBytes(quarantine.totalBytes)}).`,
      detail: 'All still-undoable merges become non-revertable. Already-reverted merges are unaffected.',
      confirmLabel: 'Purge all',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await window.api.images.purgeAllMerges();
      addToast(`Purged ${res.purged} merge${res.purged === 1 ? '' : 's'}`, 'success');
      await loadRecentOps();
    } catch (err) { addToast(err.message, 'error'); }
  }

  const footer =
    step === 'intro' ? (
      <>
        <Button onClick={handleClose}>Cancel</Button>
        <Button onClick={handleAutoMerge} title="Scan + merge everything in the background, no review">Apply automatically…</Button>
        <Button variant="primary" onClick={handleScan}>Scan for duplicates</Button>
      </>
    ) : step === 'review' ? (
      <>
        <Button onClick={() => setStep('intro')}>Back</Button>
        <Button
          variant="primary"
          onClick={handleMerge}
          disabled={totals.groupsIn === 0}
          title={totals.groupsIn === 0 ? 'Tick at least one group' : 'Merge the ticked groups'}
        >
          Merge {totals.groupsIn} group{totals.groupsIn === 1 ? '' : 's'} · remove {totals.willRemove}
        </Button>
      </>
    ) : step === 'results' ? (
      <Button variant="primary" onClick={handleClose}>Done</Button>
    ) : null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Merge duplicate images"
      footer={footer}
      closeOnBackdrop={step !== 'scanning' && step !== 'merging'}
      size="xl"
    >
      {step === 'intro' && (
        <div className="dedup-intro">
          <p className="ws-hint">
            Finds images that look <strong>nearly identical</strong> within each product — the same photo
            re-imported by different clients, even when the files aren&apos;t byte-for-byte equal. It only
            groups images on the <em>same</em> product, never across products.
          </p>
          <div className="dedup-threshold">
            <label htmlFor="dedup-sim">How similar counts as a duplicate?</label>
            <div className="dedup-threshold__row">
              <input
                id="dedup-sim"
                type="range"
                min="80"
                max="100"
                step="1"
                value={thresholdPct}
                onChange={(e) => setThresholdPct(Number(e.target.value))}
              />
              <span className="dedup-threshold__val">≥ {thresholdPct}%</span>
            </div>
            <p className="ws-hint">
              {thresholdPct >= 98
                ? 'Near-identical only (re-encodes / EXIF / tiny resizes). Lowest false-positive risk.'
                : thresholdPct >= 93
                  ? 'Catches re-encodes plus light edits and small crops.'
                  : 'Aggressive — may group different angles of the same product. Review carefully.'}
            </p>
          </div>

          {recentOps.length > 0 && (
            <div className="dedup-recent">
              <div className="dedup-recent__head">
                <h3 className="dedup-recent__heading">Recent merges</h3>
                {quarantine.totalBytes > 0 && (
                  <span className="dedup-recent__quota">
                    <span className="muted">{fmtBytes(quarantine.totalBytes)} quarantined</span>
                    <button type="button" className="linklike" onClick={handlePurgeAll}>Purge all</button>
                  </span>
                )}
              </div>
              <ul className="dedup-recent__list">
                {recentOps.map((op) => (
                  <li key={op.id} className="dedup-recent__row">
                    <span>
                      Removed <strong>{op.removedCount}</strong> from {op.groupCount} group{op.groupCount === 1 ? '' : 's'}
                      <span className="muted"> · {fmtAgo(op.createdAt)} · ≥{op.thresholdPct}%{op.mode === 'auto' ? ' · auto' : ''}</span>
                    </span>
                    {op.revertedAt ? (
                      <span className="muted">reverted</span>
                    ) : op.purgedAt ? (
                      <span className="muted">purged</span>
                    ) : (
                      <span className="dedup-recent__actions">
                        <button type="button" className="linklike" onClick={() => handleRevert(op.id)}>Undo</button>
                        <button type="button" className="linklike" onClick={() => handlePurge(op.id)}>Purge</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {step === 'scanning' && (
        <p className="ws-hint">Scanning images and computing fingerprints… (first run is slower; fingerprints are cached after.)</p>
      )}
      {step === 'merging' && <p className="ws-hint">Merging… removed images are quarantined so this stays undoable.</p>}

      {step === 'review' && (
        <div className="dedup-review">
          {groups.length === 0 ? (
            <p className="ws-hint">
              No near-duplicates found at ≥{stats?.thresholdPct ?? thresholdPct}% across {stats?.imagesScanned ?? 0} images.
              Try lowering the threshold if you expected matches.
            </p>
          ) : (
            <>
              <div className="dedup-review__bar">
                <span>
                  <strong>{groups.length}</strong> duplicate group{groups.length === 1 ? '' : 's'} ·
                  {' '}{stats?.duplicatesFound ?? 0} extra copies · scanned {stats?.imagesScanned ?? 0} images
                </span>
                <span className="dedup-review__bulk">
                  <button type="button" className="linklike" onClick={() => setAllIncluded(true)}>Select all</button>
                  <button type="button" className="linklike" onClick={() => setAllIncluded(false)}>None</button>
                </span>
              </div>
              <p className="ws-hint">
                The <strong>kept</strong> image stays (main image, then highest resolution). Click another
                thumbnail to keep that one instead, or untick a group to leave it alone.
              </p>
              <div className="dedup-groups">
                {groups.map((g) => (
                  <div key={g.key} className={`dedup-group${g.included ? '' : ' is-excluded'}`}>
                    <label className="dedup-group__head">
                      <input type="checkbox" checked={g.included} onChange={() => toggleInclude(g.key)} />
                      <span className="dedup-group__sku">{g.sku}</span>
                      {g.productName ? <span className="muted">· {g.productName}</span> : null}
                      <span className="muted">· {g.images.length} copies</span>
                    </label>
                    <div className="dedup-group__imgs">
                      {g.images.map((im) => {
                        const keep = im.id === g.keepId;
                        return (
                          <button
                            type="button"
                            key={im.id}
                            className={`dedup-thumb${keep ? ' is-keep' : ' is-remove'}`}
                            onClick={() => setKeep(g.key, im.id)}
                            title={keep ? 'Kept' : 'Click to keep this one instead'}
                          >
                            <img src={appImageSrc(im.filepath, nonce)} alt="" loading="lazy" />
                            <span className="dedup-thumb__tag">{keep ? 'Keep' : 'Remove'}</span>
                            <span className="dedup-thumb__dims">
                              {im.width && im.height ? `${im.width}×${im.height}` : ''}
                              {im.isMain ? ' · main' : ''}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {step === 'results' && result && (
        <div className="dedup-results">
          <p>
            Merged <strong>{result.groups}</strong> group{result.groups === 1 ? '' : 's'} —
            removed <strong>{result.removed}</strong> duplicate image{result.removed === 1 ? '' : 's'}
            {' '}across {result.merged} product{result.merged === 1 ? '' : 's'}.
          </p>
          <p className="ws-hint">
            Removed images were quarantined, not deleted. Changed your mind?
            {' '}
            <button type="button" className="linklike" onClick={() => handleRevert(result.opId)}>Undo this merge</button>.
          </p>
        </div>
      )}
    </Modal>
  );
}
