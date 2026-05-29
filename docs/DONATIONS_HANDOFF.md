# Donations — Handoff Spec

> _Last revised: 2026-05-19. Reference implementation: Label Studio KH v0.5.2._
> _For global conventions see `AGENTS.md` in this folder. If anything below contradicts AGENTS.md, AGENTS.md wins._

A self-contained spec for adding voluntary-donation support to a desktop app. Hand this file to a fresh Claude Code session in a new project and it will reproduce the feature at ~1:1 parity.

The receiving Claude does **not** need access to the original codebase. Every URL, copy block, behaviour rule, and storage key is inlined.

---

## 1. Goal

The app is **free, all features unlocked**. There is no licensing, no trial, no gated functionality. Donations are the only revenue mechanism and are 100% voluntary. The donation flow must:

1. Be one click from anywhere in the app (left-sidebar entry: _Support this app_).
2. Open a curated payment widget that handles 200+ crypto coins and conversion — donor needs no Anthropic-style account on our side.
3. Surface a polite, dismissable nudge on the Dashboard that reappears after a cool-off period — so the existence of donations is visible without nagging.
4. Never gate functionality. Dismissing the nudge or refusing to donate has zero functional consequence.

---

## 2. Why NOWPayments

The reference implementation uses NOWPayments. The case:

- One embedded widget covers 200+ coins + 50+ networks. The donor picks coin and network inside the widget — we don't maintain a wallet list.
- No KYC for the donor; the recipient (you) keeps the account and configures payout currency.
- The `api_key` baked into the widget URL is a **public widget key**, distinct from the private REST API key. NOWPayments designs it to be embedded in pages anyone can view-source. Safe to commit.
- Single button + external-browser open avoids all the wallet-extension / wallet-app friction inside an Electron renderer (wallet extensions live in the donor's browser, not in our embedded webview).

Alternatives (Stripe / PayPal / Patreon / Ko-fi) are all viable and the same UX shell works for them. Just swap the URL and the button label. The rest of this spec is payment-provider-agnostic.

---

## 3. Configuration constant

A single top-of-file constant in the Support page:

```ts
const NOWPAYMENTS_DONATION_URL =
  'https://nowpayments.io/embeds/donation-widget?api_key=<YOUR_PUBLIC_WIDGET_KEY>';

const nowpaymentsConfigured =
  !!NOWPAYMENTS_DONATION_URL && !NOWPAYMENTS_DONATION_URL.includes('TODO_');
```

The `nowpaymentsConfigured` flag lets you ship the code with a placeholder URL and reveal the button only once the real key is in place. While placeholder, the page renders a polite "Donations are being set up" banner instead of the button.

**Sign-up flow** (one-time, per app):

1. Create an account at https://nowpayments.io
2. KYC the account (passport/ID), pick a payout coin (e.g. USDT-TRC20 for low fees, or BTC).
3. Generate a **widget API key** (Dashboard → Settings → API keys → Donation widget). This is the public key — different from the REST API key.
4. Plug it into `NOWPAYMENTS_DONATION_URL`.

---

## 4. Surfaces

Three places the donation surface lives. Each has a different role.

### 4.1 Left-sidebar entry — _Support this app_

A full-width nav row with a heart icon at the bottom of the sidebar footer, above the version line. Routes to `/support`.

```tsx
<SidebarLink to="/support" label="Support this app" icon={IconHeart} />
```

Sits *below* the main nav sections, inside a `border-t` footer block. Always visible — but quiet.

### 4.2 Support page (`/support`)

Two-card layout:

**Card 1 — Headline** (always visible):

> ❤️ {App name} is free, with all features unlocked.
>
> If it saves you hours each week, you can support development with a one-time donation. Donations keep the app maintained, the bugs fixed, and the bundled fonts updated. Thank you 💛

**Card 2 — Donate**:

- Title: _Donate_ with a coin icon.
- Single primary button: `Pay with crypto (NOWPayments)` with an external-link arrow icon.
- Subtext under the button: _"Donate in any of 200+ coins via NOWPayments — handles conversion, no account needed on your end. Opens in your default browser."_

When the placeholder URL is detected, the button is replaced with:

> Donations are being set up. The next app update will include a payment widget here. Thanks for your patience.

### 4.3 Dashboard nudge

A dismissable banner that lives at the bottom of the Dashboard page. Shows on first launch and again 7 days after each dismissal.

Layout: small heart icon, one-line message, primary _Donate_ button (routes to `/support`), and a `×` close button (aria-label: "Dismiss for 7 days").

Copy:
> ❤️ **{App name} is free.** If it saves you hours each week, you can support development with a donation — every bit keeps the app maintained and the bugs fixed.

---

## 5. State / persistence

One `localStorage` key controls the Dashboard nudge:

```ts
const DONATION_DISMISS_KEY = 'kh.donationDismissedAt';
//                            ^ replace prefix with the app's namespace
```

- Stored value: epoch ms (string) of the last dismissal.
- First launch: key absent → show nudge.
- After dismissal: store `Date.now()` → hide nudge.
- On every Dashboard mount: re-evaluate. If stored age ≥ 7 days, show again.

No server state, no analytics on donations, no tracking. Purely local.

Reference effect (Dashboard.tsx):

```ts
useEffect(() => {
  const at = localStorage.getItem(DONATION_DISMISS_KEY);
  if (!at) {
    setShowDonate(true);
    return;
  }
  const lastMs = parseInt(at, 10);
  const ageDays = (Date.now() - lastMs) / (1000 * 60 * 60 * 24);
  setShowDonate(ageDays >= 7);
}, []);
```

---

## 6. Electron specifics

**Browser-open, not embedded.** The donation URL must open in the user's default browser, not an Electron `<webview>` or BrowserWindow. Reasons:

- Crypto wallet extensions (MetaMask, Phantom, Rabby) live in the user's Chrome / Firefox / Safari, not in our renderer.
- Embedded crypto checkout flows in Electron are a permission and CSP nightmare.
- Browser-open is one line.

Two pieces to make this work:

1. In the renderer (Support page): `window.open(url, '_blank', 'noopener,noreferrer')`.
2. In the main process: intercept `setWindowOpenHandler` and re-route to `shell.openExternal`:

```ts
// main/index.ts
win.webContents.setWindowOpenHandler(({ url }) => {
  shell.openExternal(url);
  return { action: 'deny' };
});
```

Without (2), `window.open` would spawn an empty Electron child window and the URL would fail to load (no `nodeIntegration`, CSP blocks, etc.).

---

## 7. Tone & copy rules

- Never imply the app costs anything. Always lead with **free**.
- Never gate features behind a "Donate now" call. Donations don't unlock anything.
- "Voluntary" beats "optional" in the headline (warmer).
- Use "donate" not "tip" — tips imply per-use, donations imply continued maintenance.
- The Dashboard nudge re-appears every 7 days but never auto-pops a modal. It's a footer banner you can ignore.
- No emoji bombs. One ❤️ on the Support page, one in the dashboard banner. That's it.
- No mention of dollar amounts. NOWPayments lets the donor pick.

---

## 8. Files to create (Electron + React + Tailwind reference stack)

```
src/renderer/pages/Support.tsx           # The /support route
src/renderer/components/DonationNudge.tsx  # (optional) reusable banner
```

Plus one route registration in your router and one entry in your sidebar's nav config.

The whole feature is < 200 lines of UI code. There is no backend, no IPC, no database. The only "API" is the embedded NOWPayments URL.

---

## 9. Customisations for other apps

To re-use this spec in a new app:

1. **App name** — appears in the headline and dashboard banner. Search-replace.
2. **`DONATION_DISMISS_KEY` prefix** — change the `lskh.` / `kh.` prefix to match the app's namespace (avoid sharing the dismissal state across apps).
3. **Widget URL** — same NOWPayments account works for multiple apps; you can create per-app widget keys if you want per-app donation analytics.
4. **Nudge cool-off** — 7 days is the default. Bump to 14 or 30 for apps where the user opens the dashboard less often.
5. **Sidebar position** — must be in the **footer** of the sidebar, not the main nav. Donations shouldn't compete with feature nav.

---

## 10. What NOT to do

- ❌ Don't add a paywall feature flag tied to the dismissal key. The whole point is no gating.
- ❌ Don't show the nudge on every page. Dashboard only — it's a calm reminder, not a banner ad.
- ❌ Don't add a "donated already?" honour-system checkbox. The nudge already auto-hides for 7 days after dismissal; that's enough.
- ❌ Don't try to embed the NOWPayments widget in an iframe inside Electron. CSP + wallet-extension issues will eat days. Browser-open, always.
- ❌ Don't track conversion. No PostHog / Mixpanel / Plausible event on Donate click. The local-first promise extends to donation flow.
- ❌ Don't reach for Stripe / Patreon as a primary because they "look more legit". For a small indie tool, NOWPayments has lower friction: no Patreon account for the donor, no recurring-billing complexity for you.

---

## 11. Acceptance checklist

After implementation, the receiving Claude should verify:

- [ ] _Support this app_ link is in the sidebar footer, never the main nav.
- [ ] `/support` page renders the two-card layout exactly per §4.2.
- [ ] Single primary button opens NOWPayments in the **default browser** (not an Electron child window).
- [ ] Placeholder URL displays the "Donations are being set up" banner instead of the button.
- [ ] First Dashboard launch shows the nudge.
- [ ] Clicking `×` dismisses; re-mounting the Dashboard within 7 days keeps it hidden.
- [ ] After 7 days (manual test: set `localStorage.setItem(KEY, String(Date.now() - 8*86400000))` and reload), the nudge returns.
- [ ] No feature in the app changes behaviour based on whether the user has donated.
- [ ] The widget `api_key` is committed in source (it's the public key — verify with NOWPayments docs if in doubt).
- [ ] The private REST API key is NOT in source, only in a server-side .env if you use the REST API at all.

---

## 12. Future extensions (out of scope for v1)

- **Donation history** — NOWPayments dashboard has this; no need to surface in-app.
- **One-time vs recurring** — NOWPayments widget supports both via its own UI; we don't pick.
- **Multiple coin direct-send addresses** — was previously inlined, removed because NOWPayments already does it better. Add back only if you need self-hosted donations without an intermediary.
- **Localised copy** — copy is English-only in v1. Add i18n keys when the app itself becomes multi-lingual; until then, the donate flow can stay English even in non-English UI (it routes to a non-English-aware external service anyway).
