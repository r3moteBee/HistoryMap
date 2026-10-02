# History Map

A browser extension for **Safari** and **Chrome / Chromium browsers** that records how you move between web pages — which page led to which — and draws your browsing as an interactive map you can filter, style, annotate and export.

It is a standard Manifest V3 web extension: one codebase, no browser-specific builds. It works in Safari 18+ and in Chrome and other Chromium-based browsers (Edge, Brave, Arc, Vivaldi, Opera). Firefox needs a small manifest change (see [Publishing](#publishing)).

- **Trails, not lists.** Each link you follow becomes an arrow from the page you were on to the page you opened, including links opened in new tabs.
- **Filter by site**, group pages into sites, and choose a layout: left → right, top → down, or force-directed.
- **Style it.** Pick a color and shape per site, per page, or for a page and everything you reached from it.
- **Annotate it.** Attach a note to any page.
- **Export it** as SVG, PNG or PDF for documents, or as JSON for backup.
- **Private by design.** Everything is stored locally in the extension; nothing is sent anywhere. See [PRIVACY.md](PRIVACY.md).

---

## Installing for development

### Safari 18 or later (no Xcode)
1. Safari → Settings → Advanced → turn on **Show features for web developers**.
2. Settings → Developer → **Add Temporary Extension…** → choose the `extension` folder.
   Temporary extensions are removed after 24 hours or when Safari quits.

### Safari via Xcode
```sh
xcrun safari-web-extension-converter extension --app-name "History Map" --macos-only --no-open
open "History Map/History Map.xcodeproj"
```
In Xcode, select the macOS target → Signing & Capabilities → choose your team (a free Personal Team works for local use) → Run.
Then enable **History Map** in Safari → Settings → Extensions.
Without signing, enable Develop → **Allow Unsigned Extensions** (resets each time Safari restarts).

### Grant website access (Safari)
Safari → Settings → Extensions → History Map → **Edit Websites** → allow *All Websites*.
Without this, Safari hides page addresses from the extension and nothing is recorded.

### Chrome, Edge, Brave and other Chromium browsers
1. Open the extensions page — `chrome://extensions` (Chrome, Brave, Arc, Vivaldi) or `edge://extensions` (Edge).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension` folder.
4. Pin **History Map** from the puzzle-piece (Extensions) menu so its toolbar button is visible.

Website access is granted at install; no extra step is needed. After editing the code, click the reload icon on the extension's card.

### Browser differences
Recording works the same everywhere; Chrome simply tells extensions a little more, so a few edge cases come out more precisely there.

| | Safari | Chrome / Chromium |
|---|---|---|
| Link opened in a new tab | Matched from the link click (see [How it works](#how-it-works)) | Reported directly by the browser; click matching is a backup |
| URL typed into an *existing* tab | Continues that tab's trail | Starts a new trail |
| Bookmarks / address-bar searches | Continue the tab's trail | Start a new trail |
| Website access | Must be allowed in Settings → Extensions | Granted at install |
| Private / Incognito windows | Not recorded unless allowed in Safari's extension settings | Not recorded unless *Allow in Incognito* is turned on |
| Save as PDF | Print dialog → *PDF → Save as PDF* | Print dialog → Destination *Save as PDF* |

---

## Using it

Click the toolbar button to open the map.

| Area | What it does |
|---|---|
| **Time range** | Today, last 24 hours, 7 days, 30 days, or all time. |
| **Layout** | *Left → right* / *Top → down*: static trees where each page sits one step from the page that first led you to it. *Force-directed*: physics layout that settles in about 2 s. Drag nodes in any layout; **Re-layout** resets. |
| **Default node shape** | Shape for every site you haven't customized. |
| **Group pages by site** | Collapse the map to site-to-site jumps. |
| **Show links to other sites** | Pages outside the site filter appear as grey nodes, so you can see where you came from and went. |
| **Filter by site** | Check/uncheck sites; ⌥-click a site to show only that one; search box narrows the list. |
| **Map controls** (top-left) | Show/hide the options panel · zoom in / out / fit · save the map as an image. |

**Reading the map**
- Solid arrow: the first time you reached a page. Dashed arrow: a revisit or jump back. A small tab badge marks a link opened in a new tab.
- Node size reflects visit count. A yellow dot means the page has a note.
- Click a node to open its details (where you came from, where you went, notes, styling). Double-click a node to open the page.

**Styling** — 12 preset colors or a custom color, and 8 shapes. When styles overlap, the most specific wins:
1. **This page** — click a node → *Style this page…*. Tick **Also apply downstream** to carry the style to every page you reached from it.
2. **Inherited** — from the nearest upstream page that has "apply downstream" on.
3. **Site** — the swatch next to a site in the sidebar, or *Style ‹site›…* in a node's details.

**Notes** — type in a node's Notes box; it saves automatically. In grouped view, notes attach to the whole site.

**Saving the map as an image** (download button, top-left):
- **SVG** — vector; sharp at any size in Word, Pages, Keynote or Illustrator.
- **PNG** — 2× resolution image.
- **Print / Save as PDF** — one page, landscape or portrait to fit. In Safari's print dialog choose *PDF → Save as PDF*; in Chrome set the destination to *Save as PDF*.

Exports contain the whole graph (not just what's on screen) in the light theme, with a title line and legend.

**Data** — *Export data* saves history, notes and styles as JSON; *Import* merges such a file back in; *Clear…* deletes all history and notes.

**Keyboard** — `+` / `−` zoom, `0` fit to screen, `[` show/hide the options panel, `Esc` close popovers.

---

## How it works

### Recording (`background.js`, `content.js`)
The background worker listens for top-level navigations (`webNavigation.onCommitted`, and `onHistoryStateUpdated` for single-page apps) and stores each one as `{ from, to, time }`. "From" is determined, in order, by:

1. **Same tab** — the tab's previous page.
2. **Opener tab** — reported by the browser when a link opens a new tab (Chrome does this; Safari often doesn't).
3. **Link click** — `content.js` reports clicks that will open a new tab (`target=_blank`, ⌘/Ctrl-click, middle-click, context menu). The new tab's first page is matched to that click: by exact URL, or to the most recent click within 5 seconds if the link redirected.
4. **Referrer** — `document.referrer`, used only if it's a page already recorded (cross-site referrers are usually trimmed to the domain and would point at the wrong page).

Typed URLs, bookmarks and address-bar searches start a new trail where the browser reports them (Chrome and Chromium browsers, via `transitionType`). Safari doesn't report this, so in Safari a URL typed into an existing tab continues that tab's trail; a new tab with a typed URL starts a new one.

URL fragments (`#…`) and tracking parameters (`utm_*`, `fbclid`, `gclid`, …) are removed so the same page is one node.

### Storage (`db.js`)
IndexedDB database `historymap`, schema version 2:

| Store | Record | Notes |
|---|---|---|
| `visits` | `{ id, t, url, from, tabId, newTab }` | One per navigation; indexed by time `t`. |
| `pages` | `{ url, title, visits, first, last }` | One per normalized URL. |
| `notes` | `{ id, text, updated }` | `id` is a page URL, or `site:<domain>` in grouped view. |

Schema upgrades are additive, so existing history is kept. Map settings and styles are kept in the extension's `localStorage`.

### The map (`map.html`, `map.js`, `map.css`)
`map.js` replays the visits in the selected time range to build a graph. Each node remembers the page that first led to it; this "discovery tree" drives the tree layouts and downstream styling. Rendering uses [d3](https://d3js.org) (bundled; no network access). `map.js` is organized into numbered sections listed at the top of the file.

---

## Project structure

```
extension/
  manifest.json      Manifest V3: permissions, background worker, content script
  background.js      Records navigations and works out where each page came from
  content.js         Reports page titles, referrers and new-tab link clicks
  db.js              IndexedDB storage layer (shared by worker and map page)
  map.html           Map page markup
  map.js             Graph building, layouts, rendering, styling, notes, export
  map.css            Map page styles (light/dark, print)
  icons/             Extension and toolbar icons
  vendor/d3.min.js   d3 v7.9.0 (ISC license: vendor/d3.LICENSE.txt)
  LICENSE.txt        Copy of the MIT license, so it ships inside packaged builds
LICENSE              MIT license
PRIVACY.md           Privacy policy
```

### Permissions
| Permission | Why |
|---|---|
| `webNavigation` | Detect page navigations. |
| `tabs` | Know which tab a navigation happened in, which tab opened another, and page titles. |
| `storage`, `unlimitedStorage` | Keep per-tab state and store history locally. |
| Host access to all websites | Lets the extension see page addresses (required by Safari) and run the content script that reports titles and new-tab clicks. |

At install, Chrome warns that the extension can *read and change your data on all websites* and *read your browsing history*. That is the standard wording for these permissions; History Map only reads page addresses, titles and clicked link addresses, never changes pages, and never sends anything off the device.

---

## Publishing

- **Safari / Mac App Store** — requires the Apple Developer Program. Package the `extension` folder with App Store Connect's Safari web extension packager (no Xcode needed) or with Xcode, test through TestFlight, then submit for review. You'll need a privacy policy URL (see `PRIVACY.md`); the App Store privacy label is "Data Not Collected".
- **Chrome Web Store** (also installable in Edge, Brave, Arc, Vivaldi and Opera) — one-time developer registration fee. Upload a zip of the `extension` folder's contents. In the listing, give the single purpose ("visualize your own browsing trails"), justify each permission using the table above, link `PRIVACY.md` as the privacy policy, and in the *Privacy practices* tab explain that browsing history is processed only on the device and never transmitted.
- **Microsoft Edge Add-ons** — free; same zip as Chrome.
- **Firefox** — needs a small manifest change: `background.scripts` instead of `service_worker`, plus a `browser_specific_settings.gecko.id`.

Bump `version` in `manifest.json` for each release.

## License

History Map is released under the [MIT License](LICENSE).

## Third-party software
- [d3](https://github.com/d3/d3) v7.9.0 — Copyright 2010–2023 Mike Bostock — ISC License (`extension/vendor/d3.LICENSE.txt`).
