# Company Manager — Handoff Spec

A self-contained spec for building a desktop "Company / Workspace / Organization" manager tab. Hand this file to a fresh Claude Code session and it has everything needed to reproduce the feature at ~1:1 parity, regardless of what the receiving project calls the entity.

The pattern is **two-pane**: left list of entities (active one badged), right inline editor with sections. Dynamic +/× rows for repeating fields (price groups, custom fields). Explicit Cancel / Save. No modal.

---

## 1. Goal

Build an "entity profile manager" page where the user can create, switch between, edit, and delete top-level workspaces. The default name is **Company**; rename freely throughout (e.g. Workspace, Organization, Vendor, Tenant). The current entity drives every other module's data scope, so the manager also surfaces and changes the "active" selection.

Feature list:

1. **Two-pane layout** — left list, right form, no modal.
2. **Active badge** in the list and in the editor header.
3. **Switch active** from the editor when viewing a non-active entity.
4. **Inline new-entity flow** — `+` button next to the list header opens an empty form in-place; the new row appears as a dashed placeholder in the list until saved.
5. **Section-grouped form**: Basics, Price groups, Custom fields, Branding, Variants.
6. **Dynamic +/× rows** for price groups and custom fields (max 10 custom).
7. **Explicit Cancel / Save** (deliberate deviation from auto-save — entity profiles are rarely-edited, color/font scrubbing benefits from "try then commit").
8. **Dirty detection** — Cancel reverts to the last saved state; Save is disabled until name is non-empty AND form differs from saved.
9. **Color picker** as a full-width swatch (the swatch *is* the input, not a tiny preview next to a hex field).
10. **Logo upload** that imports the file into the app's data folder (no absolute paths in the DB).
11. **Delete** in the bottom-left with confirmation, cascades to all child data (brands, products, catalogs).

---

## 2. Naming / generalization

Throughout this spec the entity is called **Company**, the table is `companies`, and the variables are `company` / `companies`. If your project uses different terminology:

- Rename the table, column references (`company_id` foreign keys on children), and JS identifiers consistently.
- The dynamic-row pattern, save/cancel semantics, and layout don't change.
- Child entities (brands, products, catalogs, etc.) FK to the parent via `<entity>_id`.

---

## 3. Stack assumptions

| Layer | Choice |
|---|---|
| Desktop shell | Electron + `vite-plugin-electron/simple` |
| UI | React 18 + Vite |
| Styling | Tailwind CSS |
| State | Zustand |
| Local DB | `better-sqlite3` |
| Image processing | `sharp` (for logo resize) |
| Icons | inline SVG |

Source code in JavaScript (`.jsx` / `.js`).

A shared `Modal`, `Button`, `Input`, `Field`, `Textarea`, `EmptyState` component set is assumed (most projects already have this; build it if not).

---

## 4. File layout

```
main/
  db.js                    # companies table + CRUD + addColumnIfMissing
  ipc.js                   # companies:* + images:importForCompany handlers
  imageManager.js          # importCompanyLogo (sharp pipeline, SHA-1 dedup)
  preload.js               # window.api.companies + images.importForCompany

renderer/
  store/index.js           # companies state + active-company tracking
  modules/CompanyManager/
    index.jsx              # ⭐ The whole feature is one file. ~500 LOC.
```

---

## 5. SQL schema

```sql
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo TEXT,                           -- relative path under assets/companies/
  address TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  primary_color TEXT DEFAULT '#3b82f6',
  secondary_color TEXT DEFAULT '#64748b',
  accent_color TEXT DEFAULT '#3b82f6',
  default_font TEXT DEFAULT 'Inter',
  price_groups TEXT NOT NULL DEFAULT '["Retail"]',  -- JSON array of strings
  custom_fields TEXT NOT NULL DEFAULT '[]',         -- JSON array of { name: string }
  variants_enabled INTEGER NOT NULL DEFAULT 0,
  variant_display_mode TEXT DEFAULT 'one-per-sku',  -- 'one-per-sku' | 'swatches'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Active selection persists across launches.
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

**Additive migration helper** — call at every boot, before any read/write:

```js
function addColumnIfMissing(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// On boot:
addColumnIfMissing(db, 'companies', 'address', 'TEXT');
addColumnIfMissing(db, 'companies', 'phone', 'TEXT');
addColumnIfMissing(db, 'companies', 'email', 'TEXT');
addColumnIfMissing(db, 'companies', 'website', 'TEXT');
```

When this manager ships *after* an earlier schema version, that helper lets the contact fields land without wiping existing rows.

---

## 6. Row mapper

```js
function parseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function rowToCompany(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    logo: row.logo,
    address: row.address,
    phone: row.phone,
    email: row.email,
    website: row.website,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    accentColor: row.accent_color,
    defaultFont: row.default_font,
    priceGroups: parseJson(row.price_groups, ['Retail']),
    customFields: parseJson(row.custom_fields, []),
    variantsEnabled: !!row.variants_enabled,
    variantDisplayMode: row.variant_display_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

---

## 7. Companies CRUD (main process)

```js
const crypto = require('node:crypto');
const uuid = () => crypto.randomUUID();
const now = () => Date.now();

const companies = {
  list() {
    return getDb().prepare(
      'SELECT * FROM companies ORDER BY name COLLATE NOCASE'
    ).all().map(rowToCompany);
  },
  get(id) {
    return rowToCompany(getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id));
  },
  create(input) {
    const id = input.id ?? uuid();
    const ts = now();
    getDb().prepare(`
      INSERT INTO companies (
        id, name, logo, address, phone, email, website,
        primary_color, secondary_color, accent_color, default_font,
        price_groups, custom_fields, variants_enabled, variant_display_mode,
        created_at, updated_at
      ) VALUES (
        @id, @name, @logo, @address, @phone, @email, @website,
        @primaryColor, @secondaryColor, @accentColor, @defaultFont,
        @priceGroups, @customFields, @variantsEnabled, @variantDisplayMode,
        @createdAt, @updatedAt
      )
    `).run({
      id,
      name: input.name,
      logo: input.logo ?? null,
      address: input.address ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      website: input.website ?? null,
      primaryColor:   input.primaryColor   ?? '#3b82f6',
      secondaryColor: input.secondaryColor ?? '#64748b',
      accentColor:    input.accentColor    ?? '#3b82f6',
      defaultFont:    input.defaultFont    ?? 'Inter',
      priceGroups:    JSON.stringify(input.priceGroups   ?? ['Retail']),
      customFields:   JSON.stringify(input.customFields  ?? []),
      variantsEnabled:    input.variantsEnabled ? 1 : 0,
      variantDisplayMode: input.variantDisplayMode ?? 'one-per-sku',
      createdAt: ts, updatedAt: ts,
    });
    return companies.get(id);
  },
  update(id, patch) {
    const current = companies.get(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    getDb().prepare(`
      UPDATE companies SET
        name = @name, logo = @logo,
        address = @address, phone = @phone, email = @email, website = @website,
        primary_color = @primaryColor, secondary_color = @secondaryColor,
        accent_color = @accentColor, default_font = @defaultFont,
        price_groups = @priceGroups, custom_fields = @customFields,
        variants_enabled = @variantsEnabled, variant_display_mode = @variantDisplayMode,
        updated_at = @updatedAt
       WHERE id = @id
    `).run({
      id,
      name:           merged.name,
      logo:           merged.logo ?? null,
      address:        merged.address ?? null,
      phone:          merged.phone ?? null,
      email:          merged.email ?? null,
      website:        merged.website ?? null,
      primaryColor:   merged.primaryColor,
      secondaryColor: merged.secondaryColor,
      accentColor:    merged.accentColor,
      defaultFont:    merged.defaultFont,
      priceGroups:    JSON.stringify(merged.priceGroups ?? []),
      customFields:   JSON.stringify(merged.customFields ?? []),
      variantsEnabled:    merged.variantsEnabled ? 1 : 0,
      variantDisplayMode: merged.variantDisplayMode,
      updatedAt: now(),
    });
    return companies.get(id);
  },
  remove(id) {
    getDb().prepare('DELETE FROM companies WHERE id = ?').run(id);
    return true;
  },
};
```

Child tables (brands, products, catalogs) must use `ON DELETE CASCADE` so `remove` cleans them up:

```sql
CREATE TABLE brands (
  ...
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ...
);
```

---

## 8. Logo import (main process)

The form picks an absolute path with the OS file dialog; the IPC layer copies the file into `<dataDir>/assets/companies/`, hashes it (SHA-1), and returns a relative path the DB can store.

```js
async function importCompanyLogo(sourcePath, companyName) {
  return importAsset('companies', sourcePath, companyName);
}

// importAsset is generic across kinds:
async function importAsset(kind, sourcePath, slugHint) {
  // 1. Read source bytes, compute SHA-1.
  // 2. Build deterministic filename: <slugify(name)>-<10-char-sha1>.<ext>
  // 3. If file already exists on disk, return its relative path (skipped: true).
  // 4. Otherwise run sharp(.).rotate().resize({ width, height, fit:'inside', withoutEnlargement:true }).
  //    Encode as png/webp/jpeg based on input ext. SVGs are copied verbatim.
  // 5. Save to <dataDir>/assets/<kind>/<filename>.
  // 6. Return { relativePath: `${kind}/${filename}`, skipped, hash }.
}
```

KIND_MAX_DIMENSION for `companies` should be ~1024px (smaller than products' 1600 — logos don't need to be huge).

**Custom Electron protocol** to serve the file back to the renderer:

```js
protocol.handle('app-image', (request) => {
  const stripped = request.url.replace(/^app-image:\/\/local\//, '');
  const decoded = decodeURIComponent(stripped);  // NOT decodeURI — see pitfalls
  const abs = path.isAbsolute(decoded) ? decoded : path.join(getAssetsDir(), decoded);
  if (!fs.existsSync(abs)) return new Response(null, { status: 404 });
  return net.fetch(url.pathToFileURL(abs).toString());
});
```

Renderer uses `<img src="app-image://local/${encodeURIComponent(relativePath)}">`.

---

## 9. IPC contracts

All channels follow `domain:action`. Main throws `new Error('…')` on failure.

| Channel | Payload | Returns |
|---|---|---|
| `companies:list` | — | `Company[]` |
| `companies:get` | `id` | `Company \| null` |
| `companies:create` | `Partial<Company> & { name }` | new `Company` |
| `companies:update` | `{ id, patch: Partial<Company> }` | updated `Company` |
| `companies:remove` | `id` | `true` |
| `images:importForCompany` | `{ sourcePath, companyName }` | `relativePath: string` |
| `state:get` | `key` | `string \| null` |
| `state:set` | `{ key, value }` | `true` |

`app_state` is used to persist `activeCompanyId` across launches.

---

## 10. Preload surface

```js
contextBridge.exposeInMainWorld('api', {
  companies: {
    list:   ()           => invoke('companies:list'),
    get:    (id)         => invoke('companies:get', id),
    create: (input)      => invoke('companies:create', input),
    update: (id, patch)  => invoke('companies:update', { id, patch }),
    remove: (id)         => invoke('companies:remove', id),
  },
  images: {
    importForCompany: (sourcePath, companyName) =>
      invoke('images:importForCompany', { sourcePath, companyName }),
  },
  files: {
    pickImage: () => invoke('files:pickImage'),
  },
  state: {
    get: (key) => invoke('state:get', key),
    set: (key, value) => invoke('state:set', { key, value }),
  },
});
```

---

## 11. Zustand store slice

The store exposes the list, the active id, and async actions that wrap the IPC.

```js
import { create } from 'zustand';
const api = () => window.api;

export const useAppStore = create((set, get) => ({
  companies: [],
  activeCompanyId: null,

  async init() {
    const companies = await api().companies.list();
    const stored = await api().state.get('activeCompanyId');
    let activeCompanyId = stored && companies.some((c) => c.id === stored) ? stored : null;
    if (!activeCompanyId && companies.length === 1) {
      activeCompanyId = companies[0].id;
      await api().state.set('activeCompanyId', activeCompanyId);
    }
    set({ companies, activeCompanyId });
  },

  async refreshCompanies() {
    set({ companies: await api().companies.list() });
  },
  async createCompany(input) {
    const created = await api().companies.create(input);
    await get().refreshCompanies();
    await get().setActiveCompany(created.id);   // auto-activate new entity
    return created;
  },
  async updateCompany(id, patch) {
    const updated = await api().companies.update(id, patch);
    await get().refreshCompanies();
    return updated;
  },
  async removeCompany(id) {
    await api().companies.remove(id);
    if (get().activeCompanyId === id) {
      await api().state.set('activeCompanyId', null);
      set({ activeCompanyId: null });
    }
    await get().refreshCompanies();
  },
  async setActiveCompany(id) {
    await api().state.set('activeCompanyId', id);
    set({ activeCompanyId: id });
    // Notify child modules to refresh their data here if they listen for this.
  },
}));
```

---

## 12. Layout

Two-pane flex layout. Left ~256px sidebar, right takes the rest. The full page sits inside the app's main content area (assumes a sidebar nav lives further left, outside this module).

```
┌──────────────────────┬─────────────────────────────────────────────────────┐
│ ALL COMPANIES     +  │  [□]  Edit Acme Retail Group              [ Active ]│
│                      │                                                       │
│ □ Acme [active]      │  Company name *        Color                          │
│ □ Phnom Penh Co.     │  [______________]      [██████████████████]           │
│ □ ▒▒▒▒  (new draft)  │                        Swatch shown in switcher.      │
│                      │                                                       │
│                      │  Address                                              │
│                      │  [______________________________________]             │
│                      │                                                       │
│                      │  Phone           Email           (Website full row)   │
│                      │  [_______]       [_______]       [______________]     │
│                      │                                                       │
│                      │  PRICE GROUPS                          + Add group    │
│                      │  One numeric input appears per group on the product   │
│                      │  form. Examples: Retail, Wholesale, VIP, Distributor. │
│                      │  [ Retail              ]  ×                           │
│                      │  [ Wholesale           ]  ×                           │
│                      │                                                       │
│                      │  CUSTOM PRODUCT FIELDS                 + Add field   │
│                      │  Up to 10 free-text fields. 2 / 10.                   │
│                      │  [ Finish Type         ]  ×                           │
│                      │  [ Box Qty             ]  ×                           │
│                      │                                                       │
│                      │  BRANDING                                             │
│                      │  Logo: [Choose file…]  ·  Default font: [Inter]       │
│                      │  Secondary color: [████]   Accent color: [████]       │
│                      │                                                       │
│                      │  VARIANTS                                             │
│                      │  ☐ Enable variant support                             │
│                      │                                                       │
│                      ├─────────────────────────────────────────────────────┤
│                      │  🗑 Delete            [ Cancel ]   [ Save changes ]  │
└──────────────────────┴─────────────────────────────────────────────────────┘
```

### Sidebar list behavior

- Header row: small uppercase "ALL COMPANIES" label on the left, `+` icon button on the right.
- Each item: 12px color square (the entity's primary color), name, optional emerald "active" pill on the right.
- Selected item: light slate border + slate-50 background.
- Hover (non-selected): slate-50 background.
- While `creating` is true, append a dashed-border ghost row showing the in-progress name (or "New company").

### Form behavior

- **Header row**: 36px color swatch using `form.primaryColor` + title (`Edit <name>` for existing, `New company` for create). To the right: `Active` pill if the current selection is the active one, OR a `Switch to` button if it's a non-active existing entity.
- Body is a vertical stack of `<Section>` blocks separated by visible whitespace, not by horizontal rules. Section headers are small uppercase 10px labels with optional helper copy below.
- **Footer row** (after a top border): Delete on the left (rose-tinted, with trash icon), Cancel + Save on the right.

---

## 13. The dynamic-row pattern (price groups + custom fields)

This is the reusable pattern from the spec. Two helpers + a `Section` wrapper. Drop into the same file.

```jsx
function Section({ title, hint, action, children }) {
  return (
    <section className="space-y-3">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {title}
          </h3>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
        {action}
      </header>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function DynamicRow({ value, onChange, onRemove, placeholder }) {
  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        aria-label="Remove"
        title="Remove"
      >
        {/* × icon — 16px stroke */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function EmptyRow({ text }) {
  return (
    <div className="rounded-md border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-500">
      {text}
    </div>
  );
}
```

Use them like this:

```jsx
<Section
  title="Price groups"
  hint="One numeric input appears per group on the product form. Examples: Retail, Wholesale, VIP, Distributor."
  action={<Button variant="secondary" onClick={addPriceGroup}>+ Add group</Button>}
>
  {form.priceGroups.length === 0
    ? <EmptyRow text="No price groups. Add one to enable pricing on products." />
    : form.priceGroups.map((g, i) => (
        <DynamicRow
          key={`pg-${i}`}
          value={g}
          onChange={(v) => updatePriceGroup(i, v)}
          onRemove={() => removePriceGroup(i)}
          placeholder="e.g. Retail"
        />
      ))
  }
</Section>
```

State helpers (immutable):

```js
const addPriceGroup = () =>
  setForm((f) => ({ ...f, priceGroups: [...f.priceGroups, ''] }));
const updatePriceGroup = (i, value) =>
  setForm((f) => ({
    ...f,
    priceGroups: f.priceGroups.map((g, idx) => (idx === i ? value : g)),
  }));
const removePriceGroup = (i) =>
  setForm((f) => ({
    ...f,
    priceGroups: f.priceGroups.filter((_, idx) => idx !== i),
  }));
```

Custom fields use the same shape. The only difference: cap at 10 and disable `+ Add field` at the cap.

**On save**, normalize the arrays before sending to IPC:

```js
priceGroups:  form.priceGroups.map(g => g.trim()).filter(Boolean),
customFields: form.customFields
                .map(n => n.trim())
                .filter(Boolean)
                .slice(0, 10)
                .map(name => ({ name })),
```

The DB schema stores `custom_fields` as `[{ name }]` so it can grow per-field metadata later (type, default value, etc.) without another migration.

---

## 14. Save / Cancel / dirty semantics

Two pieces of state: `form` (live) and `saved` (snapshot of last persist).

```jsx
const [form, setForm] = useState(EMPTY);
const [saved, setSaved] = useState(EMPTY);
const [saving, setSaving] = useState(false);

const dirty = JSON.stringify(form) !== JSON.stringify(saved);
const canSave = !!form.name.trim() && (creating || dirty) && !saving;
```

On selection change, reset both:

```jsx
useEffect(() => {
  if (creating) {
    setForm(EMPTY); setSaved(EMPTY);
  } else if (selected) {
    const init = fromCompany(selected);
    setForm(init); setSaved(init);
  }
}, [selected, creating]);
```

Handlers:

```js
const handleSave = async () => {
  setSaving(true);
  try {
    if (creating) {
      const created = await createCompany(payload);
      setCreating(false);
      setSelectedId(created.id);
    } else {
      await updateCompany(selected.id, payload);
      setSaved({ ...form });
    }
  } catch (e) {
    flash(`Save failed: ${e.message}`, 'error');
  } finally {
    setSaving(false);
  }
};

const handleCancel = () => {
  if (creating) setCreating(false);
  else setForm({ ...saved });   // revert to last persist
};
```

**Why explicit Save** (vs. project-wide auto-save default): entity profiles are infrequent edits with many color/font/string fields where users scrub previews. Auto-saving every keystroke is jarring. The catalog-builder, product-form, and similar "data" editors should still auto-save — only "profile / settings" editors get explicit Save.

---

## 15. Active-company handling

The active entity is persisted in `app_state`. The store exposes `activeCompanyId` and `setActiveCompany(id)`.

In the list:

```jsx
{isActive && (
  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
    active
  </span>
)}
```

In the editor header — when the selected entity is the active one, show a pill; otherwise a button:

```jsx
{!creating && selected?.id === activeId && (
  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
    Active
  </span>
)}
{!creating && selected && selected.id !== activeId && (
  <Button variant="secondary" onClick={() => setActiveCompany(selected.id)}>
    Switch to
  </Button>
)}
```

When a brand-new company is saved, the store auto-activates it (`createCompany` calls `setActiveCompany(created.id)`). Existing entities require explicit Switch-to.

---

## 16. New-entity flow

A `creating` boolean toggles the page into "draft" mode:

```jsx
const [creating, setCreating] = useState(false);
const [selectedId, setSelectedId] = useState(null);
const selected = companies.find((c) => c.id === selectedId) ?? null;

const handleStartCreate = () => setCreating(true);
```

While `creating` is true:

- Sidebar shows a dashed placeholder at the bottom of the list with the in-progress name.
- The form is populated with `EMPTY` defaults.
- The header reads `New company`.
- The footer shows Cancel + `Create company`.
- Delete button is hidden.

On Save: create succeeds → `setCreating(false)`, `setSelectedId(created.id)`, the new row replaces the dashed placeholder.

On Cancel while creating: just `setCreating(false)`. The `useEffect` reverts the form to the previously-selected entity.

---

## 17. Auto-select on mount

When the page first renders, auto-select the active entity (or the first one) so the right pane isn't empty:

```jsx
useEffect(() => {
  if (creating) return;
  if (selectedId && companies.some((c) => c.id === selectedId)) return;
  if (companies.length > 0) {
    setSelectedId(activeId ?? companies[0].id);
  } else {
    setSelectedId(null);
  }
}, [companies, activeId, creating, selectedId]);
```

---

## 18. Color picker style

Reference UI uses a **full-width swatch** as the input, not a tiny color box + hex string side-by-side:

```jsx
<Field label="Color" hint="Swatch shown in the workspace switcher.">
  <input
    type="color"
    value={form.primaryColor}
    onChange={(e) => setField('primaryColor', e.target.value)}
    className="h-9 w-full cursor-pointer rounded-md border border-slate-200"
    aria-label="Company color"
  />
</Field>
```

Native HTML5 color input rendered at full width. macOS / Windows / Linux all show their native color picker on click.

For secondary / accent colors in the Branding section, the same full-width swatch — just nested under the smaller "Branding" header.

---

## 19. Invariants

1. **Name is the only required field.** All others are nullable. Save disabled while name is empty.
2. **Dirty detection uses JSON.stringify comparison** of `form` vs. `saved`. Don't track per-field — too brittle.
3. **`activeCompanyId` is the source of truth** for which entity drives child modules. Update via `setActiveCompany` only.
4. **`createCompany` auto-activates** the new entity. `updateCompany` never changes activation.
5. **Cascade deletes.** Removing a company must `ON DELETE CASCADE` all child rows. Confirm in a `window.confirm` first.
6. **Logo paths in the DB are relative.** Never store the absolute path from the user's filesystem.
7. **Custom fields cap at 10.** Enforced both in UI (button disabled) and on save (`.slice(0, 10)`).
8. **Price groups have no cap** but trim + filter empties on save.
9. **JSON-serialized columns** (`price_groups`, `custom_fields`) always have safe defaults so `JSON.parse` never crashes.
10. **Color values are 7-char hex** (`#rrggbb`). The HTML5 color input enforces this.

---

## 20. Acceptance checklist

- [ ] Open the Company tab on a fresh DB → empty state with "+ New company" CTA.
- [ ] Click `+` next to ALL COMPANIES → form clears, sidebar shows dashed "New company" placeholder.
- [ ] Type a name + change Color → Save → row appears, dashed placeholder replaced, new row is `active` (emerald pill).
- [ ] Add 2 price groups via `+ Add group`, fill names, Save → reopen, both groups still there.
- [ ] Remove a price group via `×` → row disappears immediately; Save → reload confirms.
- [ ] Add 10 custom fields → `+ Add field` is disabled at #10. Counter reads `10 / 10`.
- [ ] Click another company in the sidebar → form loads its data, Active pill shows on the correct entity only.
- [ ] On a non-active company, click `Switch to` → that company is now active (sidebar badge moves; the header pill swaps to "Active").
- [ ] Edit a field but don't save → Cancel → form reverts; sidebar selection unchanged.
- [ ] Edit a field → Save changes → toast/saved indicator confirms; reload app → change persists.
- [ ] Pick a logo file → logo filename shows in the form; Save → reload → logo persists (relative path in DB).
- [ ] Delete a company → confirm → company disappears from sidebar; all child data (brands, products, catalogs) is gone; if it was the active one, no active company until you pick another.
- [ ] Press `Esc` while in any color picker or text input → focus leaves the field but the page stays.
- [ ] Click anywhere outside the form → no accidental discard (no backdrop).
- [ ] Refresh the app — last-selected company is auto-selected on remount.

---

## 21. Common pitfalls

- **`decodeURI` vs `decodeURIComponent`** in the protocol handler. Relative paths contain `/` which encodes to `%2F`; `decodeURI` won't decode it. Always `decodeURIComponent`.
- **Color input value must be `#rrggbb`** — six lowercase hex digits. If you let users type free-text into a paired hex field, validate before assigning to `type="color"` or the input silently rejects.
- **Avoid `onChange` for the color input** firing on every drag point if you wire it to live IPC. We use local state until Save, so no problem here — but if you ever wire color directly to IPC, debounce.
- **`useEffect` reset loop**: when both `selected` and `creating` are in the dependency array, make sure their relationship is monotonic (creating → false after save sets selectedId; the effect runs once with the new id). The implementation above is correct; copy-paste rather than rederive.
- **Custom-field `{ name }` shape**: write the DB as `[{ name: string }]` even though today only the name is used. This avoids a migration when you eventually add `{ name, type, default }`.
- **`COLLATE NOCASE` ordering**: list is sorted case-insensitively so "acme" and "Acme" sit together regardless of casing.
- **Auto-activate on first create**, but never on subsequent creates. Track via "did the user ever set an active company?" — easier: just auto-activate every new create. Most users want that.

---

## 22. Suggested build order

1. SQL DDL + `addColumnIfMissing` helper.
2. `rowToCompany` + `companies.list/get/create/update/remove`.
3. IPC handlers + preload surface + Zustand actions.
4. Sidebar list with empty form on the right; click cycles selection.
5. Basics fields (name, color, address, phone, email, website) — verify create/update round-trip.
6. `Section` + `DynamicRow` + `EmptyRow` helpers.
7. Price groups section with +/× rows; verify save persists the array.
8. Custom fields section, identical pattern + 10-cap.
9. Branding (logo + secondary/accent + font). Logo import via `images:importForCompany`.
10. Variants toggle + display-mode select.
11. New-entity draft flow (`creating` boolean + dashed placeholder).
12. Active-company handling (badge, Switch-to button, auto-activate on create).
13. Dirty detection + Cancel revert + Save validation.
14. Auto-select on mount.
15. Delete with cascade confirmation.
16. Acceptance checklist pass.

Each step is independently verifiable.

---

**End of spec.** Hand this single file to a fresh Claude Code session, point it at a project that already has Electron + React + Tailwind + Zustand + SQLite set up, and ask it to build the Company Manager tab following this document. Expect ~1:1 parity with the reference implementation.
