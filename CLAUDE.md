# App Building Preferences — Theng

These are durable conventions for any desktop or web app you build with me. Apply them by default; don't ask. Only deviate when I explicitly say so.

This file is intentionally short and rule-shaped, not aspirational. Treat each section as a contract.

---

## 1. Navigation — left sidebar, never top tabs

- Use a vertical sidebar on the left (~220px wide) for the primary navigation.
- Group items into labeled sections (e.g. `SETUP`, `PRODUCTION`, `SYSTEM`). Section labels in small uppercase tracked-out text.
- App name + a small logo mark at the top of the sidebar.
- Active item: light-grey fill, bold/darker text, darker-tinted icon. Inactive: subdued text, lighter icon.
- Use **inline SVG icons** (stroke-based, ~18px). Do not add an icon library as a dependency.
- The top of the main content area shows the current page title + the active context chip (e.g. active company / workspace / project). It does **not** repeat the nav.

Top-tab navigation across feature areas is forbidden. Sub-tabs *inside* a single page are acceptable but rare.

## 2. Modals / dialogs — always dismissible

- All modal popups must close when:
  - User presses **Esc**
  - User **clicks the dim backdrop** outside the modal box
- The X button in the corner must have `aria-label="Close (Esc)"` and a tooltip.
- Implement modal behavior **once** in a shared `Modal` component. Never duplicate the close logic per modal.
- Allow opt-out via `closeOnBackdrop={false}` only for destructive confirmations (rare).
- Modals must be keyboard-accessible: focus should be inside the modal when open.

## 3. Versioning + "What's new" — always present

- The app version (sourced from `package.json` via `app.getVersion()` over IPC) must be visible somewhere persistent — usually the sidebar footer.
- Provide a **"What's new"** entry in the sidebar footer (sparkles icon is fine) that opens a modal.
- The modal renders a hand-curated, versioned changelog as an in-code array. Top entry is the current release.
- Each entry: version + date + bullet list of changes. No links to external changelogs; keep it inline.
- Update this array every time we ship a meaningful change.

## 4. Support / donate — always present

- A **"Support this app"** button in the sidebar footer (heart icon).
- Opens a modal with a short blurb + 1–2 CTAs (Sponsor, Buy-me-a-coffee, etc.).
- External links open via Electron's `shell.openExternal` through an IPC bridge with an `http(s)` / `mailto` allow-list. Never let arbitrary URLs through.

## 5. Settings — always accessible

- "Settings" is always reachable, even when no business/company/workspace is selected.
- Houses: data folder location, app preferences, reset-to-default actions, and other global config.
- Mark it `alwaysAvailable` in nav config so the "select a workspace first" gate doesn't block it.

## 6. Saves are automatic — show a status indicator AND keep an explicit Save button

- Every field change is persisted via IPC immediately (debounce ~500ms to coalesce rapid edits like slider drags).
- **Editors ALSO have an explicit "Save" button** as a belt-and-braces affordance. Auto-save is the safety net; the visible Save button is the user's deliberate-commit mental model — especially valuable in editors where the user is making many small tweaks before stepping away (e.g. Image Workspace orientation + crop + watermark before processing).
- The Save button writes the same payload as the debounce timer would; it's idempotent. Clicking it while auto-save is in-flight is a no-op (button shows the same `Saving…` state).
- Near the editor header, show:
  - `● All changes saved` in green when idle
  - `Saving…` in amber while a save is in-flight
  - A relative timestamp (`2 min ago`) that auto-refreshes every 30s
- Errors during save surface via toast, not silent.

(Earlier versions of this rule forbade the Save button entirely; that turned out to be the wrong call for the Image Workspace, which the user wants to *commit* explicitly even when the auto-save indicator shows everything is durable. Updated 2026-05-20.)

## 7. Toasts

- Single-line, bottom-center, auto-dismiss after 3s.
- Variants: `info` (slate), `success` (emerald), `error` (rose).
- Use them for "Saved", "Imported N rows", "Exported to <path>", and actual error messages.
- Never use them for blocking content — that's what modals are for.

## 8. Data folder is user-configurable

For desktop apps:

- Default location: `app.getPath('userData')/data/`.
- Settings UI lets the user pick a different folder (Documents, Dropbox, external drive, etc.).
- Persist the choice in `config.json` under userData (not the DB — chicken/egg).
- "Move existing data" checkbox when switching, default ON.
- Trigger an Electron `app.relaunch() + app.exit()` after switching so the new DB connection opens cleanly. Prompt the user before restarting.

## 9. Asset storage — content-addressed, deduplicated

- All user-imported files (images, logos, icons) are **copied** into `<dataDir>/assets/<kind>/<file>`. Never reference absolute paths from the user's disk in the database.
- Filename pattern: `<slug>-<hash10>.<ext>` where `hash10` is the first 10 hex chars of the source file's SHA-1.
- Identical content → identical hash → identical filename → automatic dedup. No two copies on disk.
- Renderer accesses these via a custom protocol (e.g. `app-image://local/<relpath>`). Resolve in main process; serve via `protocol.handle()` (not the deprecated `registerFileProtocol`).
- Auto-import-on-pick: when a user picks a file in a form, copy it to assets immediately. Form state stores the *relative* path returned by the importer, not the absolute pick path.

## 10. Pagination on long lists

- Any table or grid that can grow past ~50 items gets pagination.
- Footer shows: `Showing X–Y of Z`, prev/next buttons, page size dropdown (default 50; options 25/50/100/200), page indicator.
- Reset to page 1 when filters, search, or page size change.
- Clamp page index when the underlying list shrinks below the current page.

## 11. Excel / CSV import with column mapping

- Imports are 3 steps: **pick file → map columns → review results**.
- Auto-guess each column's target based on header text (case-insensitive, fuzzy matches like `ean`/`upc` → `barcode`).
- Show 1 sample value per column in the mapping table so users can verify.
- Imports are **upserts by natural key** (e.g. SKU). For existing rows, **only update fields that have a value in the imported row** — never blank out fields just because the column wasn't supplied. Merge JSON object fields (prices, custom fields) into existing rather than replacing.
- Provide a **"Download sample"** button that emits a workbook pre-configured with this org's price groups, custom fields, and the full canonical column set. Include an "Instructions" sheet with one row per column explaining what it accepts.

## 12. Multi-image handling

When products / entities can have multiple images:

- Store images as an ordered array. Position 0 = main.
- Provide UI to:
  - **Set as main** (move to position 0)
  - **Reorder** (← and → arrows on hover, or drag-to-reorder)
  - **Remove** (X in corner)
- Display current count vs cap (e.g. `3 / 20`).
- Hard cap per entity (default: 20) enforced server-side in IPC.
- Support **clipboard paste** (`⌘V` / `Ctrl+V`): listen for paste events with image MIME types, send `ArrayBuffer` over IPC, write to temp file, run through normal import pipeline.

## 13. Smart filename matching for batch image import

When auto-matching a folder of images to records by some key (e.g. SKU):

- **Recursive folder scan**, up to 5 levels deep. Skip dotfiles/hidden folders.
- **Case-insensitive** filename + folder name matching.
- Supported patterns for one key with N images:
  - `<key>.ext` → position 0 (main)
  - `<key>-1.ext`, `<key>-2.ext`, `<key>-3.ext` → positions in that order
  - `<key>_2.ext`, `<key> 2.ext` — same intent, different separators all accepted
  - `<key>/main.ext` or `<key>/primary.ext` or `<key>/cover.ext` → position 0
  - `<key>/1.ext`, `<key>/2.ext` → positions by number
  - `<key>/anything.ext` → falls back to alphabetical
- **Surface the matching rules** to the user before they pick a folder (a rules list in the modal). After matching, show stats: scanned, matched, imported, duplicates skipped, unmatched, cap-skipped.

## 14. Database conventions (SQLite + better-sqlite3)

- Column names: `snake_case`. JS object keys: `camelCase`. Convert via `rowToX(row)` mapper functions per table.
- Foreign keys with `ON DELETE CASCADE` for "parent owns children" relationships (e.g. `products` are owned by a company).
- Indexes on every foreign key + every column commonly filtered.
- `UNIQUE (parent_id, natural_key)` for natural-key uniqueness scoped within parents (e.g. `UNIQUE (company_id, sku)`).
- Migrations are **additive** by default (`ALTER TABLE ADD COLUMN`). Bump `schema_version` only when you need structural changes; bumping wipes existing pre-release data.
- Use an `app_state` table for kv storage (active selection IDs, schema version, etc.).
- Use a `addColumnIfMissing(db, table, col, type)` helper that checks `PRAGMA table_info` — keep migrations idempotent.

## 15. IPC conventions (Electron)

- Channel names: `domain:action`. Examples: `products:list`, `images:setMainImage`, `app:relaunch`.
- All renderer→main calls go through preload's `window.api.<domain>.<method>(...)`. Renderer never imports Node modules directly.
- Preload exposes a single `api` object via `contextBridge.exposeInMainWorld`. Keep `nodeIntegration: false`, `contextIsolation: true`.
- Handlers `throw new Error('…')` on failure. Catch in renderer with try/catch; surface via toast.
- For binary data (clipboard images, etc.), pass `ArrayBuffer` via the structured-clone IPC.

## 16. Stack defaults (apply unless told otherwise)

| Layer | Choice |
|---|---|
| Desktop shell | Electron + `vite-plugin-electron/simple` |
| UI framework | React 18 + Vite |
| Styling | Tailwind CSS |
| State | Zustand (one store, action methods) |
| Local DB | better-sqlite3 |
| Excel/CSV | SheetJS (`xlsx`) |
| Images | `sharp` |
| PDF | Puppeteer |
| Icons | Inline SVG, no library |

Source code in JavaScript (`.jsx` / `.js`) unless I ask for TypeScript.

## 17. File layout (Electron apps)

```
main/                  # main process, CommonJS
  index.js             # app entry, BrowserWindow, lifecycle logging
  config.js            # config.json read/write
  db.js                # schema, migrations, queries
  ipc.js               # ipcMain handlers
  preload.js           # contextBridge surface
  fileHandler.js       # spreadsheet IO
  imageManager.js      # sharp, hashing, dedup
  pdfExporter.js       # Puppeteer wrapper
renderer/              # React + Vite, ESM
  App.jsx
  index.css
  store/index.js       # Zustand
  components/
    ui.jsx             # Button, Input, Modal, Field, Toast, Badge, EmptyState
    Sidebar.jsx
    SupportModal.jsx
    WhatsNewModal.jsx
  modules/<Name>/      # one folder per feature module
    index.jsx
assets/                # bundled (fonts, theme JSON)
data/                  # runtime userData (gitignored)
```

## 18. Tone & copy

- Plain English. No marketing speak. No emoji in UI text unless I ask.
- Form field hints sit under the input, ≤1 line, in muted small text.
- Error toasts contain the *actual* error message, not "Something went wrong".
- Empty states are short, kind, and offer an action ("No catalogs yet. Create your first one.").

## 19. Crash logging

Every Electron app must:

- Append lifecycle events (`boot`, `app:ready`, `before-quit`, `render-process-gone`, `child-process-gone`, `uncaughtException`, `unhandledRejection`) to `<userData>/crash.log`.
- Mirror those events to stdout too so they're visible in `npm run dev`.
- Set `ELECTRON_ENABLE_LOGGING=1` in the dev script so Chromium logs are not swallowed.

## 20. Build for both arm64 AND x64 on macOS

Every `npm run dist` must produce TWO DMGs — one for Apple Silicon (`arm64`) and one for Intel (`x64`). Configured in `package.json` under `build.mac.target[].arch: ["arm64", "x64"]`.

Why:
- I have both Apple Silicon and Intel Macs on the test fleet (older Intel MacBook Pros are still kicking around as client-only machines)
- Building both at once means I always have the right DMG for whichever Mac I'm pushing to next; no "wait, this is the wrong arch" surprise
- electron-builder rebuilds native deps (better-sqlite3, sharp, @img/*) per arch automatically via @electron/rebuild — works fine on an Apple Silicon host
- Output filenames are auto-suffixed: `Image Studio KH-X.Y.Z-arm64.dmg` and `Image Studio KH-X.Y.Z-x64.dmg` side-by-side in `dist/`
- Build time is roughly 1.5× a single-arch build (native rebuild is the slow part; the rest is shared)

Do NOT use `arch: ["universal"]` — universal binaries double the file size by bundling both arches in one app, and rebuild times are longer. Two separate DMGs is the simpler shipping model.

## 21. Packaging-safe paths — dev layout ≠ packaged layout

The single nastiest bug class in this app: code that resolves paths relative to the **source tree** works in `npm run dev` but breaks in the packaged DMG, because the compiled main-process files live at a different depth inside `dist-electron/main/…` (and inside the asar). These never throw in tests or dev — only on a client's machine. Rules:

- **App version comes from `require('electron').app.getVersion()` — never `require('…/package.json')`.** In dev, `require('../../package.json')` resolves to the repo root; in the packaged app the compiled file sits at `dist-electron/main/server/index.js`, so `../../package.json` points at a file that doesn't exist and the require throws. This caused the v0.26.52 `/api/ping` 500 (amber server-hiccup chip + failing diagnostics). The renderer gets the version over IPC (`app:getVersion`), which in client mode is a **local** handler, not proxied to the server.
- **Never `require()` a `.json` (or any data file) by a relative path that climbs out of the compiled file's own directory.** If you need bundled data, either inline it in JS or load it from a runtime path you control.
- **Any file the main process *reads at runtime* must live under a runtime path** — `app.getPath('userData')`, the configured `dataDir`, the system temp dir, or a user-picked absolute path. Do **not** read app data via `__dirname`-relative paths into the source tree; those files are not laid out the same way (or at all) inside the asar.
  - The *only* legitimate `__dirname` uses are pointing at things electron-builder actually ships in `dist-electron/` / `dist-renderer/` (e.g. the preload script and the built renderer `index.html` in `main/index.js`). Those are correct in both dev and packaged builds. Everything else is suspect.
- **Guard test:** `test/buildHygiene.test.js` statically scans `main/**` and fails if any file requires a `package.json`. A runtime unit test can't catch this (tests run in the source layout where the relative path happens to resolve), so the scan is the defense. If you add another packaging-fragile pattern, extend that test.

## 22. Updating this file

When something new becomes a durable preference, **edit this file** in-place. Don't create a separate decisions doc; this is the single source of truth.

If a rule here is wrong or out of date, propose the correction in chat — don't silently violate it.
