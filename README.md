# claudenotepad

An information terminal between a Claude Code session and a web page. It looks like the Claude Code CLI: `>` prompts, `⏺` responses, a prompt box at the bottom. Claude Code posts to it from a shell with `./cnp`, and you read it, comment on it and leave notes from any device.

Live: https://vaibhavkumar.is-a.dev/claudenotepad/ (repo `vaibhavgit9210/claudenotepad`, GitHub Pages from `gh-pages`).

## What is public and what is not

The repo is **public**, but it holds no content. Every message, note and comment lives in the `claudenotepad` Cloudflare Worker (a SQLite Durable Object, vaibhavpro9210 account), and every request needs the key. Without it the page only says "Locked".

## On the page

- **Notes:** type in the bottom box and press Enter. The note is added to the end of the feed. Shift+Enter adds a newline. Unsent text autosaves to `localStorage` (`cnp.draft`).
- **Comments:** select any text inside one message and a "+ comment" button appears. Enter saves. Hover a highlighted passage to read its comment, with edit and delete (delete asks twice). On touch screens, tap the highlight instead.
- **Anchors:** a comment stores its message id, start and end offsets into the message's rendered text, and the quoted text. If the message is edited, the comment moves to the nearest copy of its quote. If the quote is gone, it is listed under the message as "comment on text that changed".
- **Live:** the page polls `/feed?rev=N` every 4 seconds while visible. That costs almost nothing when nothing changed, so a post from Claude Code shows up within seconds.
- **Key:** when locked, the bottom box asks for the key (masked). `/lock` forgets it on this device. There is also `#k=<key>`, which is stored and then scrubbed from the address bar, but it stays in browser history, so typing the key is better.

## From Claude Code: `./cnp`

```bash
./cnp feed                 # everything, with ids, and comments under each message
./cnp new REV              # same, but only if anything changed since REV (feed prints it)
./cnp user 'prompt text'   # a "> prompt" line
./cnp claude - < reply.md  # a response (markdown)
./cnp note 'text'          # a note, as if typed in the box
./cnp edit 4 - < fixed.md  # replace message 4
./cnp rm 4                 # delete message 4 and its comments
./cnp reply c2 'text'      # replace comment 2's text
./cnp rmc c2               # delete comment 2
```

The key comes from `CNP_KEY` or the gitignored `.note-key`. Set `CNP_API` to point at a local worker.

Worker API (all requests need `Authorization: Bearer <key>`): `GET /feed[?rev=N]`, `POST /msg {kind: user|claude|note, text}`, `PUT|DELETE /msg?id=N`, `POST /comment {msg, start, end, quote, text}`, `PUT|DELETE /comment?id=N`. The routes from the old reader (`/notes`, `/doc`) are still there, and so is their data. See the header of `worker/worker.js`.

## Rendering

Claude messages are markdown, built as DOM nodes (never `innerHTML`): headings (shown bold), paragraphs, bold, italic, inline code, links and bare URLs (http, https and mailto only), `-` and numbered lists with nesting, blockquotes, fenced code, tables and rules. User prompts and notes are shown as plain text.

## Local dev

```bash
# worker, with NOTE_KEY=<any test key> in worker/.dev.vars (gitignored)
cd worker && npx wrangler dev --port 8787

# site
python3 -m http.server 8765
open "http://localhost:8765/?api=http://localhost:8787"
```

`?api=` is honoured only when the page is on localhost and the override also points at localhost.

Screenshot hooks (fake data, no API calls): `#shot=feed`, `#shot=comment` (one comment open), `#shot=locked`. Use `--timeout=4000` with headless Chrome.

## Deploy

```bash
git push origin main
git push origin main:gh-pages

cd worker
npx wrangler deploy                # vaibhavpro9210 Cloudflare account
npx wrangler secret put NOTE_KEY   # to rotate the key; every device then unlocks again
```
