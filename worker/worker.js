// claudenotepad notes API, behind vaibhavkumar.is-a.dev/claudenotepad/
//
// Every request except OPTIONS needs "Authorization: Bearer <NOTE_KEY>".
// GET    /notes             all notes, newest first, max 1000: [{id, ts, entry, text, edited}]
// GET    /notes?entry=slug  same, one entry only
// POST   /notes             {entry, text} -> 201 note
// PUT    /notes?id=N        {text} -> 200 note (sets edited)
// DELETE /notes?id=N        -> {ok:true}, 404 if missing
//
//
// Edited copies of an entry's markdown. Every save is a new version (last 100 kept).
// GET    /doc?entry=slug           latest version {id, ts, entry, text}, or null if never edited
// GET    /doc?entry=slug&id=N      one version, 404 if missing
// GET    /doc/versions?entry=slug  [{id, ts, len}] newest first
// PUT    /doc?entry=slug           {text, base} -> 200 new version. base = id the edit
//                                  started from (0 = the original .md); 409 if stale.
//
// entry: /^[a-z0-9-]{1,40}$/ ("inbox" = general bucket). text: 1 to 20000 chars
// after cleaning (docs 200000). 5000 notes max. ts/edited are ms epoch ints,
// edited null if never.

import { DurableObject } from 'cloudflare:workers';

const ALLOWED_ORIGINS = [
  'https://vaibhavkumar.is-a.dev',
  'https://vaibhavgit9210.github.io',
];
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const SLUG = /^[a-z0-9-]{1,40}$/;
const MAX_BODY = 64 * 1024, MAX_TEXT = 20000, MAX_NOTES = 5000;
const MAX_DOC_BODY = 1024 * 1024, MAX_DOC = 200000, KEEP_VERSIONS = 100;

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (ALLOWED_ORIGINS.includes(origin) || LOCAL.test(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

// Strip control chars except \n and \t, plus bidi, zero-width and invisible format
// chars (soft hyphen, Arabic letter mark, Mongolian vowel separator). Keeps newlines.
function clean(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .trim();
}

async function sha(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

// Constant-time: compare fixed-length digests, never the raw strings.
async function keyOk(req, key) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') || '');
  const a = await sha(m ? m[1] : ''), b = await sha(key);
  let diff = m ? 0 : 1;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class Notebook extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER, edited INTEGER, entry TEXT, text TEXT)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_notes_entry ON notes(entry)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS docs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, entry TEXT, text TEXT)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_docs_entry ON docs(entry, id)');
  }
  doc(entry, id) {
    const cols = 'SELECT id, ts, entry, text FROM docs WHERE entry = ?';
    return (id
      ? this.sql.exec(`${cols} AND id = ?`, entry, id)
      : this.sql.exec(`${cols} ORDER BY id DESC LIMIT 1`, entry)).toArray()[0] || null;
  }
  versions(entry) {
    return this.sql.exec('SELECT id, ts, length(text) len FROM docs WHERE entry = ? ORDER BY id DESC LIMIT ?',
      entry, KEEP_VERSIONS).toArray();
  }
  // Saves only if the edit started from the latest version, so two devices
  // never silently overwrite each other. Returns {conflict} or the new version.
  saveDoc(entry, text, base) {
    const latest = this.doc(entry);
    if ((latest ? latest.id : 0) !== base) return { conflict: latest && { id: latest.id, ts: latest.ts } };
    const id = this.sql.exec('INSERT INTO docs(ts, entry, text) VALUES(?, ?, ?) RETURNING id',
      Date.now(), entry, text).one().id;
    this.sql.exec(`DELETE FROM docs WHERE entry = ? AND id NOT IN
      (SELECT id FROM docs WHERE entry = ? ORDER BY id DESC LIMIT ?)`, entry, entry, KEEP_VERSIONS);
    return this.doc(entry, id);
  }
  one(id) {
    return this.sql.exec('SELECT id, ts, entry, text, edited FROM notes WHERE id = ?', id).toArray()[0] || null;
  }
  list(entry) {
    const cols = 'SELECT id, ts, entry, text, edited FROM notes';
    return entry
      ? this.sql.exec(`${cols} WHERE entry = ? ORDER BY id DESC LIMIT 1000`, entry).toArray()
      : this.sql.exec(`${cols} ORDER BY id DESC LIMIT 1000`).toArray();
  }
  add(entry, text) {
    if (this.sql.exec('SELECT COUNT(*) c FROM notes').one().c >= MAX_NOTES) return null;
    const id = this.sql.exec('INSERT INTO notes(ts, edited, entry, text) VALUES(?, NULL, ?, ?) RETURNING id',
      Date.now(), entry, text).one().id;
    return this.one(id);
  }
  edit(id, text) {
    this.sql.exec('UPDATE notes SET text = ?, edited = ? WHERE id = ?', text, Date.now(), id);
    return this.one(id);
  }
  remove(id) {
    if (!this.one(id)) return false;
    this.sql.exec('DELETE FROM notes WHERE id = ?', id);
    return true;
  }
}

async function docRoute(req, url, nb, json) {
  const entry = url.searchParams.get('entry') || '';
  if (!SLUG.test(entry)) return json({ error: 'bad entry' }, 400);
  if (url.pathname === '/doc/versions')
    return req.method === 'GET' ? json(await nb.versions(entry)) : json({ error: 'method not allowed' }, 405);

  if (req.method === 'GET') {
    const raw = url.searchParams.get('id');
    if (raw === null) return json(await nb.doc(entry));
    if (!/^[1-9]\d{0,15}$/.test(raw)) return json({ error: 'bad id' }, 400);
    const d = await nb.doc(entry, Number(raw));
    return d ? json(d) : json({ error: 'not found' }, 404);
  }
  if (req.method !== 'PUT') return json({ error: 'method not allowed' }, 405);

  if (Number(req.headers.get('Content-Length') || 0) > MAX_DOC_BODY) return json({ error: 'too large' }, 413);
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_DOC_BODY) return json({ error: 'too large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object' || typeof body.text !== 'string') return json({ error: 'bad text' }, 400);
  if (!Number.isSafeInteger(body.base) || body.base < 0) return json({ error: 'bad base' }, 400);
  const text = clean(body.text.replace(/\r\n?/g, '\n'));
  if (text.length < 1 || text.length > MAX_DOC) return json({ error: 'bad text' }, 400);
  const r = await nb.saveDoc(entry, text + '\n', body.base);
  return r.conflict !== undefined ? json({ error: 'conflict', latest: r.conflict }, 409) : json(r);
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!env.NOTE_KEY) return json({ error: 'not configured' }, 500);
    if (!(await keyOk(req, env.NOTE_KEY))) return json({ error: 'locked' }, 401);

    const url = new URL(req.url);
    const nb = env.NOTEBOOK.get(env.NOTEBOOK.idFromName('main'));
    if (url.pathname === '/doc' || url.pathname === '/doc/versions') return docRoute(req, url, nb, json);
    if (url.pathname !== '/notes') return json({ error: 'not found' }, 404);

    if (req.method === 'GET') {
      const entry = url.searchParams.get('entry');
      if (entry !== null && !SLUG.test(entry)) return json({ error: 'bad entry' }, 400);
      return json(await nb.list(entry));
    }

    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE')
      return json({ error: 'method not allowed' }, 405);

    let id = null;
    if (req.method !== 'POST') {
      id = Number(url.searchParams.get('id'));
      if (!/^[1-9]\d{0,15}$/.test(url.searchParams.get('id') || '')) return json({ error: 'bad id' }, 400);
    }
    if (req.method === 'DELETE')
      return (await nb.remove(id)) ? json({ ok: true }) : json({ error: 'not found' }, 404);

    // POST / PUT: JSON body, size capped before and after reading.
    if (Number(req.headers.get('Content-Length') || 0) > MAX_BODY) return json({ error: 'too large' }, 413);
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY) return json({ error: 'too large' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
    if (!body || typeof body !== 'object' || typeof body.text !== 'string') return json({ error: 'bad text' }, 400);
    const text = clean(body.text);
    if (text.length < 1 || text.length > MAX_TEXT) return json({ error: 'bad text' }, 400);

    if (req.method === 'POST') {
      if (typeof body.entry !== 'string' || !SLUG.test(body.entry)) return json({ error: 'bad entry' }, 400);
      const note = await nb.add(body.entry, text);
      return note ? json(note, 201) : json({ error: 'notebook full' }, 429);
    }
    const note = await nb.edit(id, text);
    return note ? json(note) : json({ error: 'not found' }, 404);
  },
};
