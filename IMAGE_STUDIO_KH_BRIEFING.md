# Image Studio KH — Build Briefing

## Overview

**App name:** Image Studio KH  
**Type:** Desktop app (Electron + React)  
**Purpose:** Batch product image processor. Takes raw, mixed-quality product photos and outputs clean, marketplace-ready images with correct backgrounds, sizes, formats, and file naming — ready to upload to Amazon, Shopify, Lazada, Etsy, or any custom destination.  
**Primary user:** TerraNash — running multiple product businesses (construction materials, refurbished iPhones, FMCG). Needs to process large batches of product images across different categories efficiently.

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Electron + React | Desktop-first, same stack as companion app Catalog Studio KH |
| UI | React + plain CSS | No UI framework. Custom components throughout |
| Background removal | @imgly/background-removal | Pure Node/WASM, fully bundleable, no user install required |
| BG removal fallback | remove.bg API | Optional, user provides their own API key in Settings |
| Image processing | Sharp | Resize, format conversion, color profile, quality |
| Local database | SQLite via better-sqlite3 | Stores products, images, export profiles, settings |
| File system | Node.js fs + Electron dialog | Folder picker, deep folder scanning, output path management |

**No external cloud dependency required.** Everything runs locally. remove.bg is opt-in only.

---

## App Structure

```
Image Studio KH
├── 1. Product Library      ← import and manage products + raw images
├── 2. Image Workspace      ← process images per product (bg removal, canvas, enhance)
├── 3. Export Center        ← export profiles, queue, batch export runner
└── 4. Settings             ← app preferences, API keys, categories, output path
```

### Window Layout

- **Left sidebar** — fixed navigation between the 4 modules
- **Main content area** — each module renders here
- Standard Electron window with custom titlebar (macOS traffic lights style)
- Minimum window size: 1100 × 700px

---

## Module 1 — Product Library

### Purpose
The entry point. Every product is a container that holds metadata and raw images. Products must be created/imported here before images can be processed.

### Layout
Three-column layout:
- Left: filter sidebar (Brand, Category, Status)
- Center: product table or grid (toggle between views)
- Right: opens as detail/edit panel when a product is selected

### Product Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| SKU | Text | Yes | Primary identifier, must be unique |
| Name | Text | No | |
| Brand | Dropdown | No | Managed list (add/edit in Settings) |
| Barcode | Text | No | EAN, UPC, or other |
| Secondary Code | Text | No | Supplier code or alt SKU |
| Category | Dropdown | No | Managed list |
| Subcategory | Text/Dropdown | No | |
| Color / Finish | Text | No | |
| Variant | Text | No | Size, material, etc. |
| Unit | Text | No | sqm, piece, box, etc. |
| Status | Dropdown | No | Active / Inactive / Draft — default: Active |
| Tags | Comma-separated text | No | |
| Description | Textarea | No | |
| Retail Price | Number | No | |
| Wholesale Price | Number | No | |
| Images | Multi-file | No | Up to 20 images per product |

### Product Table Columns
IMAGE (thumbnail) · SKU · BRAND · NAME · CATEGORY · COLOR/FINISH · IMAGES (count, e.g. 3/20) · PROCESS STATUS · STATUS

### Process Status values
- **Unprocessed** — no images have been processed yet
- **In progress** — some images processed, some raw
- **Done** — all images processed
- **Exported** — processed and exported at least once

### Actions (top bar)
- Search by SKU, name, color, tags
- Toggle Table / Grid view
- Auto-match images (scan a folder and match filenames to SKUs)
- Import Excel/CSV
- + New product button

### Import Methods

**1. Manual — New Product modal**
- Form with all fields listed above
- Images: drag and drop or click to add, paste from clipboard (Cmd+V / Ctrl+V)
- Re-importing the same image is detected and skipped automatically
- Save creates the product; images can be added after saving

**2. Excel / CSV Import**
- Download sample template available
- Maps columns to product fields
- Validates SKUs for duplicates before import
- Shows import summary (X created, X updated, X skipped)

**3. Folder Scan / Auto-match**
- User selects a root folder
- App scans recursively (up to 5 folder levels deep)
- Finds all image files: JPG, JPEG, PNG, WEBP, HEIC
- Attempts to match filenames to existing SKUs (exact match and fuzzy match)
- Matched images are attached to their products automatically
- Unmatched images land in an "Import Queue" (shown as a badge on the sidebar)
- Import Queue lets user manually drag-assign unmatched images to products

### Filters (left sidebar)
- Brand (multi-select)
- Category (multi-select)
- Status (Active / Inactive / Draft)
- Process status (Unprocessed / In progress / Done / Exported)

---

## Module 2 — Image Workspace

### Purpose
The processing screen. Opened when the user clicks "Process" on a product. Shows all images for that product in a strip on the left, the canvas editor in the center, and the processing settings panel on the right.

### Navigation
Accessed from Product Library via a "Process →" button on each product row. Breadcrumb in the top bar shows: Product Library / [SKU · Product Name].

### Layout — Three panels

**Left panel — Image strip**
- Vertical list of all images attached to the current product
- Each thumbnail shows: image name, status (Raw / Done)
- Active image highlighted with border
- Progress bar at the bottom: "X of Y processed"
- Clicking a thumbnail switches the canvas to that image

**Center — Canvas**
- Shows the current image being worked on
- Default view: checkerboard pattern (shows transparency after bg removal)
- Top bar controls:
  - Canvas size label (e.g. "2000 × 2000px · sRGB")
  - **Fill preview toggle** — switches canvas from checkerboard to the chosen background fill color so user can preview the final look
  - **Before / After toggle** — splits the canvas with a draggable center divider; left side = original raw image, right side = processed result. "Single" mode shows just the processed canvas.
- Alignment guides (centered crosshair lines, subtle blue, toggleable)
- Bottom toolbar: Move · Crop · Brush (touch-up edges) · Zoom in · Zoom % · Zoom out · Reset view

**Right panel — Processing settings**
Collapsible sections:

**Background**
- Toggle: Remove background (on/off)
- Background fill color swatches: White (#FFFFFF), Light grey (#F5F5F5), Grey (#E0E0E0), Black (#000000), + Custom color picker
- Info hint: "Toggle Fill preview on canvas to see fill color"

**Canvas & Size**
- Marketplace preset tags: Amazon · Shopify · Etsy · Lazada · Custom
  - Selecting a preset auto-fills the size fields and locks the color profile
- Output size inputs: Width × Height (px)
- Product fill slider: 50%–100% (how much of the canvas the product occupies, default 85%)

**Enhance**
- Toggle: Auto-adjust (auto brightness/contrast/white balance)
- Brightness slider: -100 to +100
- Contrast slider: -100 to +100
- Toggle: Add shadow (subtle drop shadow under product)

**Watermark**
- Toggle: Show watermark
- When on: upload logo image, set position (corner picker), set opacity slider

**Apply buttons (bottom of right panel)**
- "Apply to this image" — processes current image with current settings
- "Apply settings to all X" — batch applies current settings to all images in the product
- Note: "Applies current panel settings to all images"

### Marketplace canvas presets (built-in)
| Preset | Size | Format | Color profile |
|---|---|---|---|
| Amazon | 2000×2000 | JPG | sRGB |
| Shopify | 2048×2048 | WEBP | sRGB |
| Etsy | 2000×2000 | JPG | sRGB |
| Lazada | 800×800 | JPG | sRGB |
| TikTok Shop | 800×800 | JPG | sRGB |

---

## Module 3 — Export Center

### Purpose
Takes processed images and exports them in the correct format, size, file name, and folder structure for each destination platform.

### Layout — Two columns

**Left column — Export profiles list**
- List of saved export profiles
- Each profile shows: icon (marketplace color-coded), name, summary (size · format · bg)
- Actions per profile: Edit · Duplicate
- "+ New profile" button at top

**Right column — two zones stacked**

**Top zone — Selected profile details**
- Profile name + Edit button
- Detail cards: Size · Format + Quality · Background fill · Color profile
- File naming pattern builder:
  - Token blocks: `{SKU}` `{COLOR}` `{INDEX}` `{DATE}` `{BRAND}` — drag to reorder, click to remove
  - Separator selector: dash / underscore / none
  - Live preview: shows example filename using current product data
  - Example: `BBC-TILE-001-WHITE-01.jpg`

**Bottom zone — Export queue**
- List of products selected for this export run
- Each row: checkbox · thumbnail · SKU + name · category · image count · status badge
- Status badges: Ready (green) · Partial — X unprocessed (amber) · Queued (blue)
- Partial warning behavior: unprocessed images are **skipped** during export; after export completes a summary shows "X images skipped — unprocessed"
- "+ Add products" button to add more products to the queue

**Run bar (bottom)**
- Summary: "X products · Y images selected for export"
- Output folder path display + edit button (folder picker)
- "Run export" primary button

### Export profile fields
| Field | Options |
|---|---|
| Name | Text |
| Size | Width × Height (px) |
| Format | JPG / PNG / WEBP |
| Quality | 1–100 (for JPG/WEBP) |
| Background fill | Color picker |
| Color profile | sRGB / Display P3 |
| File naming pattern | Token builder (see above) |
| Output subfolder | Optional subfolder name appended to base output path |

### One profile per run
Simplicity rule: each export run uses a single profile applied to all selected products. To export the same products to multiple platforms, the user runs export once per profile.

### Profile preview
When a profile is selected, a small rendered preview thumbnail shows a sample product image processed with that profile's settings (background, canvas ratio, padding). Updates live as profile settings change.

---

## Module 4 — Settings

### Sections

**General**
- Default output folder — folder picker, stores base path for all exports
- Default export profile — dropdown, pre-selects a profile in Export Center on launch
- App language — English only for now (placeholder for future)

**Background removal**
- Engine selector: Local (bundled @imgly) / remove.bg API
- remove.bg API key input (masked, show/hide toggle)
- Usage counter (calls made this month, if API mode selected)
- Test connection button

**File naming**
- Default separator: Dash / Underscore / None
- Default token order (drag to reorder)

**Marketplace presets**
- List of built-in presets (read-only) with their specs
- User can add custom presets: name, size, format, color profile

**Categories & brands**
- Two managed lists: Categories · Brands
- Add / rename / delete entries
- These populate the dropdowns in Product Library

**About**
- App version
- Open logs folder
- Check for updates (placeholder)

---

## Data Model (SQLite)

```
products
  id, sku, name, brand_id, barcode, secondary_code,
  category_id, subcategory, color_finish, variant,
  unit, status, tags, description, price_retail, price_wholesale,
  process_status, created_at, updated_at

product_images
  id, product_id, filename, filepath, original_filepath,
  order_index, is_processed, processed_filepath,
  workspace_settings (JSON), created_at

export_profiles
  id, name, marketplace, width, height, format, quality,
  background_color, color_profile, naming_pattern,
  output_subfolder, created_at, updated_at

export_runs
  id, profile_id, run_at, product_count, image_count,
  skipped_count, output_path, notes

brands
  id, name, color

categories
  id, name, parent_id

settings
  key, value
```

---

## File & Folder Conventions

### App data location
- macOS: `~/Library/Application Support/ImageStudioKH/`
- Windows: `%APPDATA%/ImageStudioKH/`
- Contains: `database.sqlite`, `processed/` folder, `settings.json`

### Processed images storage
- `[AppData]/processed/[SKU]/[filename]`
- Originals are never modified — always write to the processed folder

### Export output
- Base path set by user in Settings
- Each export run creates: `[base path]/[output subfolder if set]/[named files]`

---

## Key UX Rules

1. **Originals are sacred** — never overwrite or modify original uploaded images. Always write processed versions to a separate folder.
2. **Non-destructive** — workspace settings are stored per image so the user can re-process with different settings at any time.
3. **Batch-first** — every action that can be batched should offer a "apply to all" option.
4. **Skip and inform** — if an image can't be exported (unprocessed, missing file), skip it silently and show a post-run summary of what was skipped and why.
5. **One profile per export run** — keep Export Center simple. Multiple destinations = multiple runs.
6. **Familiar UX** — layout and component patterns should feel consistent with Catalog Studio KH (the companion app the user already uses daily).

---

## Build Order

Build module by module in this order, testing each before moving to the next:

1. Project scaffold (Electron + React boilerplate, SQLite setup, window frame, sidebar nav)
2. App shell (routing, sidebar, window chrome)
3. Product Library (database schema, product list, add/edit modal, CSV import)
4. Image Workspace (canvas, @imgly bg removal, settings panel, before/after view)
5. Export Center (profiles, queue, batch export, naming pattern builder)
6. Settings (all preference screens, managed lists)

---

## Notes for Claude Code

- Ask the user to confirm before running `npm install` steps that will take a while
- Test each module works before scaffolding the next
- Use plain CSS modules or scoped styles — no Tailwind, no styled-components
- All IPC between Electron main and renderer should go through a typed preload bridge
- Sharp should run in the main process (Node), not the renderer
- @imgly/background-removal can run in the renderer (it uses WASM)
- Use `better-sqlite3` (synchronous) not `sqlite3` (async) for simplicity
- Keep the database layer in a separate `src/db/` folder with one file per table
- Store workspace settings as JSON blob in the `product_images` table — no need to normalize every slider value into its own column
