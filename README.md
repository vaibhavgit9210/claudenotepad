# claudenotepad

A personal notepad for reading and copying analyses Claude writes, on a phone or a laptop, with private notes on each one that sync across devices so they can be relayed later.

Live: https://vaibhavkumar.is-a.dev/claudenotepad/ (repo `vaibhavgit9210/claudenotepad`, GitHub Pages from `gh-pages`).

The design follows mayicestudio.com: a #f5f5f5 ground, black ink, one regular-weight grotesk, a 12 column Swiss grid, and giant initials as the only navigation (hover a letter and it extends into the title; on a phone the full title is shown).

## What is public and what is not

The repo is **public**, so every entry in `notes/` is public too. Don't put anything private in an entry.

Notes are different. They never touch the repo: they live in the `claudenotepad` Cloudflare Worker (a SQLite Durable Object) and every request needs the key. Without the key the page shows "Notes are locked on this device."

## Layout

```
index.html          the whole site (single file, no build step, no external requests)
notes/<slug>.md     one markdown file per entry, the source of truth
worker/             the notes API (Cloudflare Worker + SQLite Durable Object)
```

## Adding an entry

1. Drop the markdown file in `notes/`, e.g. `notes/goa-trip.md`.
2. Add one line to the `ENTRIES` array near the top of the script in `index.html`:

   ```js
   {slug:'goa-trip', letter:'G', title:'Goa trip', date:'2026-11-02', file:'notes/goa-trip.md', blurb:'One line shown under the title'},
   ```

   `slug` must match `^[a-z0-9-]{1,40}$` (it is also the notes bucket name, and `inbox` is reserved). `letter` is the giant initial on the index; if the title starts with it, hovering expands the letter into the title.
3. Push (see Deploy). The entry is at `#/<slug>`.

The renderer handles h1 to h3, paragraphs, bold, italic, links, ordered and unordered lists (one nested level, 2 space indent, with continuation paragraphs), GFM tables, blockquotes, inline code, fenced code and rules. Raw HTML in a .md is shown as text, never injected.

On an entry: "Copy all" copies the .md exactly, "Copy as text" copies it without markdown syntax (links become `text (url)`, table cells are tab separated), "Raw" opens the file, and each section has its own "Copy" word that copies that section's markdown.

## Notes and the key

- Every entry has a Notes section at the bottom; `#/notes` shows every note from every entry and writes new ones to the `inbox`.
- The key is stored in `localStorage` (`cnp.key`) on each device. **Prefer typing the key into the Unlock field** in the Notes section. There is also an unlock link:

  ```
  https://vaibhavkumar.is-a.dev/claudenotepad/#k=<key>
  ```

  The page stores the key and removes it from the address bar, but the browser has already saved the full link in its history (and in synced history and address-bar suggestions), and the key also stays in whatever app the link was pasted into. So if you use the link: don't send it through a synced chat or notes app, delete that history entry afterwards, and rotate `NOTE_KEY` (see Deploy) if you think it leaked. If a device already holds a different key, a link's key replaces it only after the server accepts it, so a stray link cannot log you out. "Lock" in the nav forgets the key on that device.
- Reach of the saved key: `localStorage` is shared by the whole origin, and every project on `vaibhavkumar.is-a.dev` (and the `github.io` URLs, which redirect there) is the same origin. A script bug (XSS) in any sibling page could read `cnp.key` and then read, edit or delete every note. Keep sibling pages free of `innerHTML` with untrusted input. The structural fix, if this ever matters more, is to host the notepad on its own origin (for example a Cloudflare Pages `*.pages.dev` site) and allow only that origin in the worker's CORS list.
- Drafts autosave to `localStorage` (`cnp.draft.<slug>`) on every keystroke and are cleared only after the server confirms the save. Cmd or Ctrl + Enter saves.
- The key itself is never in this repo. It is the worker secret `NOTE_KEY`.

Worker API (all requests need `Authorization: Bearer <key>`): `GET /notes`, `GET /notes?entry=<slug>`, `POST /notes {entry, text}`, `PUT /notes?id=N {text}`, `DELETE /notes?id=N`. See the header of `worker/worker.js`.

## Local dev

```bash
# worker, with NOTE_KEY=<any test key> in worker/.dev.vars (gitignored)
cd worker && npx wrangler dev --port 8787

# site
python3 -m http.server 8765
open "http://localhost:8765/?api=http://localhost:8787#/trivia-night"
```

`?api=` is honoured only when the page itself is on `localhost` or `127.0.0.1` and the override points at `localhost` or `127.0.0.1`, so a crafted link can't send the key anywhere else.

Screenshot hooks (fake notes, no API calls): `#shot=index`, `#shot=entry`, `#shot=notes`. Headless Chrome on macOS won't render narrower than about 500px, so check phone widths with device emulation over the DevTools protocol rather than `--window-size=390,...`.

## Deploy

```bash
git push origin main
git push origin main:gh-pages      # second push, so Pages auto-enables

cd worker
npx wrangler deploy                # vaibhavpro9210 Cloudflare account
npx wrangler secret put NOTE_KEY   # first time, or to rotate the key
```

After rotating the key, every device has to unlock again.
