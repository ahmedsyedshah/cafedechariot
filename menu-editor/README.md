# CDC Menu Editor

A desktop app (Electron) for editing Cafe De Chariot's `menu-modal.html` directly —
no hand-editing HTML, no separate copy of the file. It reads the real file, lets you
edit every item in a form, and overwrites the real file on Save, preserving all
existing CSS/structure exactly as-is.

## What it does

- Auto-loads your `menu-modal.html` on startup (remembers the location after the first run).
- Parses **every** menu item, whether it's written directly in the HTML (deal cards,
  drink/fries/pasta list items, promo cards) or generated from the JS data arrays at
  the bottom of the file (pizzas, burgers, wraps, rolls, sandwiches, nuggets, wings,
  sidelines, add-ons).
- Two-column UI: searchable tree of every section on the left, edit form + live
  preview on the right.
- Editing name/price/description updates the `showPreview(...)` calls that drive the
  in-page preview panel, **and** best-effort syncs the visible text (`item-name`,
  `item-price`, `deal-price`, etc.) so the on-page menu text matches too.
- **Choose Image** copies the picked file into an `images/` folder next to your HTML
  (never inlined as base64) and stores a relative path like `images/lasagna.jpg` in
  the file. It also patches the two JS builder functions (`buildList`,
  `buildPizzaRows`) once, so pizzas/burgers/etc. pass their image through to the
  preview modal too — this patch is idempotent, so it's safe on every save.
- Save overwrites your real `menu-modal.html`. A `.bak` copy of the previous version
  is written alongside it first, as a safety net.
- Warns you before discarding unsaved changes (closing the window, reloading, or
  switching files).
- 100% offline once installed — everything runs locally, no network calls.

## What it deliberately does NOT do

It does not rebuild the HTML from scratch. It only replaces the exact bytes for the
fields you changed (an `onclick="showPreview(...)"` attribute, an object literal
field, a name/price `<span>`). Everything else — your CSS, layout, fonts, footer,
other markup — is left byte-for-byte untouched.

## Running it

```bash
npm install
npm start
```

On first launch you'll be asked to locate `menu-modal.html`. After that, it opens
automatically every time.

## Building a standalone installer (.exe / .dmg / .AppImage)

```bash
npm run dist:win     # Windows installer (NSIS)
npm run dist:mac     # macOS .dmg
npm run dist:linux   # Linux AppImage
# or just:
npm run dist         # build for the current platform
```

Installers are written to `dist-installer/`. Cross-compiling (e.g. building the
Windows .exe from macOS/Linux) works with electron-builder in most cases, but for a
guaranteed clean build, build each target on that OS.

> Note: this repo doesn't include an app icon. Drop an `icon.png` (512×512+) into a
> `build-resources/` folder and add `"icon": "build-resources/icon.png"` under the
> relevant platform in `package.json`'s `build` block if you want custom branding.

## Project layout

```
main.js            Electron main process — file I/O, image copying, dialogs
preload.js          Safe bridge exposing menuAPI to the renderer
parser.js           Core parse/serialize logic (pure Node, no Electron deps)
renderer/
  index.html         UI shell
  style.css           Dark gold/black theme matching the CDC brand
  renderer.js         Tree, form, live preview, save/load wiring
```

`parser.js` has no Electron dependency, so if the real menu file's structure ever
changes and something stops parsing correctly, you can debug it directly with plain
Node — no need to launch the app:

```js
const fs = require('fs');
const { parseMenu } = require('./parser');
const menu = parseMenu(fs.readFileSync('../menu-modal.html', 'utf8'));
console.log(menu.items.length, menu.pages.map(p => p.title));
```

## If you add new menu sections later

- New `<li onclick="showPreview(...)">` or `<div class="deal-card" onclick="showPreview(...)">`
  items are picked up automatically — no code changes needed.
- New JS data arrays (like `specialPizzas`) need one line added to the `DATA_ARRAYS`
  list near the top of `parser.js`, plus a matching `buildList(...)` /
  `buildPizzaRows(...)` call in the HTML's own `<script>`, the same way the existing
  ones work.
