/**
 * v0.49.47 — Cost Calculator.
 *
 * A focused tool for pricing decisions:
 *   - Pick a product OR enter a landed cost manually.
 *   - Enter a target margin %.
 *   - See the suggested retail.
 *   - Or enter a retail price and see the realized margin.
 *
 * Two-way: edit either field, the other recomputes. The landed cost comes
 * from product_landed_costs (latest received PO snapshot). For
 * what-if pricing on a product that has no PO history yet, the user
 * can override the landed cost manually.
 *
 * No state lives in the DB — this is a pure scratch pad. Last-used values
 * are kept in component state and reset on module unmount.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input, Select, EmptyState } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';

export function CostCalculator() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);

  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [costData, setCostData] = useState(null); // { latest, avg3mo, avg12mo, latestPoId, ... }
  const [landedCostUsd, setLandedCostUsd] = useState('');
  const [targetMarginPct, setTargetMarginPct] = useState('40');
  const [retailUsd, setRetailUsd] = useState('');
  const [lastEdited, setLastEdited] = useState('margin'); // which field drives the other

  // Load products for the picker.
  useEffect(() => {
    if (!activeCompanyId) { setProducts([]); return; }
    window.api.products.list(activeCompanyId, {})
      .then((list) => setProducts(Array.isArray(list) ? list : []))
      .catch((err) => { addToast(`Failed to load products: ${err.message}`, 'error'); setProducts([]); });
  }, [activeCompanyId, addToast]);

  // When user picks a product, fetch its landed cost cache and use the
  // latest as the default landed cost.
  useEffect(() => {
    if (!productId) { setCostData(null); return; }
    window.api.purchaseOrders.getProductCost(productId)
      .then((c) => {
        setCostData(c);
        if (c?.latestLandedCostUsd != null) {
          setLandedCostUsd(c.latestLandedCostUsd.toFixed(4));
        } else {
          setLandedCostUsd('');
        }
      })
      .catch(() => setCostData(null));
  }, [productId]);

  // Two-way binding between margin% and retail$. Whichever field the
  // user typed in last drives the other.
  useEffect(() => {
    const cost = Number(landedCostUsd) || 0;
    if (cost <= 0) {
      setRetailUsd('');
      return;
    }
    if (lastEdited === 'margin') {
      const m = Number(targetMarginPct) || 0;
      if (m >= 100) { setRetailUsd(''); return; }
      const r = m <= 0 ? cost : cost / (1 - m / 100);
      setRetailUsd(r.toFixed(4));
    } else if (lastEdited === 'retail') {
      const r = Number(retailUsd) || 0;
      if (r <= 0) { setTargetMarginPct(''); return; }
      const m = ((r - cost) / r) * 100;
      setTargetMarginPct(m.toFixed(2));
    }
  // We intentionally include only the driving inputs so it doesn't loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landedCostUsd, targetMarginPct, lastEdited === 'retail' ? retailUsd : null]);

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return products.slice(0, 50);
    return products.filter((p) => {
      const hay = `${p.sku || ''} ${p.name || ''}`.toLowerCase();
      return hay.includes(q);
    }).slice(0, 50);
  }, [products, productSearch]);

  const margin = Number(targetMarginPct) || 0;
  const cost = Number(landedCostUsd) || 0;
  const retail = Number(retailUsd) || 0;
  const profit = retail - cost;

  if (!activeCompanyId) {
    return (
      <div className="page page--costcalc">
        <PageHeader title="Cost Calculator" />
        <EmptyState
          title="No company selected"
          body="Pick a company from the sidebar to use the cost calculator."
        />
      </div>
    );
  }

  return (
    <div className="page page--costcalc">
      <PageHeader
        title="Cost Calculator"
        subtitle="Suggested retail from a margin target, or vice versa. Reads landed cost from received POs."
      />

      <div className="costcalc__layout">
        <section className="po-section">
          <h3 className="po-section__title">1. Pick a product (optional)</h3>
          <Input
            placeholder="Search SKU or name…"
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
          />
          <Select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            style={{ marginTop: 8 }}
          >
            <option value="">— manual entry —</option>
            {filteredProducts.map((p) => (
              <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
            ))}
          </Select>
          {productId && costData && (
            <div className="costcalc__history">
              <CostStat label="Latest landed" value={fmtUsd(costData.latestLandedCostUsd)} />
              <CostStat label="3-mo avg" value={fmtUsd(costData.avgLandedCostUsd3mo)} />
              <CostStat label="12-mo avg" value={fmtUsd(costData.avgLandedCostUsd12mo)} />
            </div>
          )}
          {productId && !costData && (
            <p className="muted" style={{ marginTop: 12 }}>
              No received-PO cost history for this product yet — enter the landed cost manually below.
            </p>
          )}
        </section>

        <section className="po-section">
          <h3 className="po-section__title">2. Landed cost</h3>
          <label className="field">
            <span className="field__label">Landed cost per unit (USD) *</span>
            <Input
              type="number"
              min="0"
              step="0.0001"
              value={landedCostUsd}
              onChange={(e) => setLandedCostUsd(e.target.value)}
            />
            <span className="field__hint">
              Pre-filled from the latest received PO when a product is picked. Edit freely.
            </span>
          </label>
        </section>

        <section className="po-section">
          <h3 className="po-section__title">3. Margin ↔ Retail</h3>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Target margin %</span>
              <Input
                type="number"
                min="0"
                max="99.99"
                step="0.1"
                value={targetMarginPct}
                onChange={(e) => { setTargetMarginPct(e.target.value); setLastEdited('margin'); }}
              />
              <span className="field__hint">
                Margin of retail (profit ÷ retail), not markup over cost.
              </span>
            </label>
            <label className="field">
              <span className="field__label">Retail price (USD)</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={retailUsd}
                onChange={(e) => { setRetailUsd(e.target.value); setLastEdited('retail'); }}
              />
            </label>
          </div>

          <div className="costcalc__summary">
            <CostStat label="Profit per unit" value={fmtUsd(profit)} tone={profit >= 0 ? 'emerald' : 'rose'} />
            <CostStat label="Realized margin" value={`${margin.toFixed(2)}%`} />
            <CostStat
              label="Markup over cost"
              value={cost > 0 ? `${(((retail - cost) / cost) * 100).toFixed(2)}%` : '—'}
            />
          </div>
        </section>

        <section className="po-section">
          <h3 className="po-section__title">Quick what-ifs</h3>
          <p className="muted">
            Try common margin targets against this landed cost — useful when you’re
            sanity-checking a wholesale vs retail split.
          </p>
          <div className="costcalc__whatif">
            {[20, 25, 30, 35, 40, 45, 50, 55, 60].map((m) => {
              const r = cost > 0 ? cost / (1 - m / 100) : 0;
              return (
                <button
                  key={m}
                  type="button"
                  className="costcalc__chip"
                  onClick={() => { setTargetMarginPct(String(m)); setLastEdited('margin'); }}
                >
                  <span>{m}%</span>
                  <strong>{fmtUsd(r)}</strong>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function CostStat({ label, value, tone }) {
  return (
    <div className={`po-stat${tone ? '' : ''}`}>
      <div className="po-stat__label">{label}</div>
      <div className={`po-stat__value${tone ? ` po-stat__value--${tone}` : ''}`}>{value}</div>
    </div>
  );
}

function fmtUsd(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
