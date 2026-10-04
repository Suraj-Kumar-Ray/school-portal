/**
 * ============================================================================
 * words.js — EVERY WORD ON THE SCREEN IS THE OFFICE'S TO CHANGE
 * ============================================================================
 *
 * School's request (2026-09-17): *“Give the office the option to update every single thing,
 * down to a single word, and make it easy from a phone.”*
 *
 * A school renames things. “Overall Average” becomes “Your Result” on the parents' screen, the
 * fee page's “Pay now” becomes “Pay the school”, the login card changes to the office's own
 * words. Writing a code change for every word is not a thing the office can do, so the words
 * themselves are data:
 *
 *   `site_content` key `wtext.<id>`  →  `{"from":"Overall Average","to":"Your Result"}`
 *
 * and this file applies them to the finished HTML of every page (see `rewrite()`), just before
 * it leaves the server:
 *
 *   • only TEXT (the words between tags) and the four attributes that are words —
 *     `placeholder`, `title`, `aria-label`, `alt`;
 *   • never inside `<script>`, `<style>`, `<textarea>` or an HTML comment, so no behaviour and
 *     no plumbing is ever touched;
 *   • the replacements are HTML-escaped, and a rule may not contain `<` or `>` at all, so a
 *     change can never inject markup;
 *   • **the editor page itself is never rewritten** (`/admin/wording`), so the office can always
 *     open it and undo anything, however wrong it went;
 *   • a phrase is ONE rule: saving the same “from” again corrects it, and saving it with empty
 *     words (or removing it) puts the app's own words back.
 *
 * Nothing here is per-screen on purpose: the school asked for one word to change, not the same
 * change made on five pages. A rule applies wherever that phrase is printed, and the editor
 * shows exactly which screens that is (`src/services/words_catalogue.json`).
 *
 * With no rules saved, `rewrite()` returns the HTML untouched — byte for byte. That is what
 * keeps this feature invisible until the office actually uses it.
 */
const db = require('../db');
const v = require('./validate');

const PREFIX = 'wtext.';
const MAX_FROM = 120;          // “Overall Average”
const MAX_TO = 200;            // the school's own sentence in its place

// ---------- storing ----------

const rows = () => db.prepare('SELECT key, value FROM site_content WHERE key LIKE ?').all(PREFIX + '%');

function parse(row) {
  try {
    const o = JSON.parse(row.value);
    const from = String(o && o.from || '').trim();
    const to = String(o && o.to || '').trim();
    if (!from || !to) return null;
    return { id: row.key.slice(PREFIX.length), from, to };
  } catch (e) { return null; }                       // a hand-edited row is ignored, never fatal
}

/**
 * Every saved change, longest phrase FIRST, so “Overall Average card” wins over
 * “Overall Average” whatever order the rows come back in.
 *
 * Read through a 2-second cache: a page asks for the rules once, and a save is visible on the
 * next click (the office's own reload), which is also why `save()`/`remove()` clear it.
 */
let cache = null;
let stamped = 0;
function rules() {
  const now = Date.now();
  if (!cache || now - stamped > 2000) {
    cache = rows().map(parse).filter(Boolean).sort((a, b) => b.from.length - a.from.length);
    stamped = now;
  }
  return cache;
}
const refresh = () => { stamped = 0; };

/** The office's list: one entry per saved change, in reading order. */
function list() {
  return rows().map(parse).filter(Boolean).sort((a, b) => a.from.localeCompare(b.from));
}
const count = () => list().length;
function get(id) { return list().find((r) => r.id === String(id)) || null; }

/** The HTML entities a phrase may carry in a view (“Books &amp; uniform”). */
const ENTITIES = [['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&#x27;', "'"]];
const decode = (s) => ENTITIES.reduce((x, [a, b]) => x.split(a).join(b), s);
const encode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Does this phrase hold a character that a view may have written as an entity? */
const needsDecode = (s) => /[&<>"']/.test(s);

/**
 * The office's words in, the school's words out.
 * Returns the SAME string when nothing matched, so an untouched page is never rewritten.
 */
function fix(text, listRules) {
  if (!/[A-Za-z]/.test(text)) return text;                  // numbers, money, punctuation
  const trimmed = text.trim();
  if (!trimmed) return text;                                // the whitespace between two tags
  let s = trimmed.replace(/\s+/g, ' ');                     // a phrase in a view may wrap lines
  let hit = false;
  for (const r of listRules) {
    if (s.includes(r.from)) { s = s.split(r.from).join(r.to); hit = true; continue; }
    if (needsDecode(r.from) || needsDecode(s)) {
      const flat = decode(s);
      if (flat.includes(r.from)) { s = flat.split(r.from).join(r.to); hit = true; }
    }
  }
  return hit ? encode(s) : text;                            // untouched nodes keep their bytes
}

/** `<script>` / `<style>` / `<textarea>` / comments are hidden while the words are swapped. */
const HIDDEN = /<(script|style|textarea)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;

/**
 * The finished page, in the office's words.
 * `path` exists for ONE reason: the editor is never rewritten (it has to stay usable).
 */
function rewrite(html, path = '') {
  if (typeof html !== 'string' || !html) return html;
  const listRules = rules();
  if (!listRules.length) return html;
  if (String(path).indexOf('/admin/wording') === 0) return html;

  const hidden = [];
  let out = html.replace(HIDDEN, (m) => `\u0000${hidden.push(m) - 1}\u0000`);
  // the words between tags
  out = out.replace(/>([^<]+)</g, (m, text) => '>' + fix(text, listRules) + '<');
  // …and the four attributes that are words a person reads
  out = out.replace(/\b(placeholder|title|aria-label|alt)="([^"]*)"/g,
    (m, name, val) => `${name}="${fix(val, listRules)}"`);
  return out.replace(/\u0000(\d+)\u0000/g, (m, i) => hidden[Number(i)]);
}

// ---------- writing (the office's screen) ----------

/**
 * A checked phrase: plain words only — nothing here can ever become markup.
 *
 * Over-long input is REFUSED, not quietly cut: half a sentence on a parent's screen is worse
 * than a message asking the office to shorten it.
 */
function word(value, label, max) {
  const c = v.checker();
  const raw = String(value == null ? '' : value).trim();
  const s = c.text(value, label, { max, required: true });
  if (/[<>]/.test(raw)) c.fail(`${label} cannot contain the < or > characters.`);
  if (raw.length > max) c.fail(`${label} is too long — keep it under ${max} characters.`);
  return { ok: c.ok, error: c.summary, value: s };
}

/**
 * Save ONE change.
 *
 *   • the same “from” again corrects the rule instead of making a second one;
 *   • “to” equal to “from” (or empty) means *the app's own words, please* — the rule is dropped;
 *   • `id` is the rule being edited, so the office can fix a typo in the left box too (and if
 *     that moved onto a phrase that already has a rule, the two become one).
 */
function save({ from = '', to = '', id = '' }) {
  const a = word(from, 'What the app says', MAX_FROM);
  if (!a.ok) return { ok: false, error: a.error };
  const b = word(to, 'What it should say', MAX_TO);
  if (!b.ok) return { ok: false, error: b.error };
  const mine = String(id || '');
  const same = list().find((r) => r.from === a.value && r.id !== mine);
  const put = (rowId) => db.prepare(`INSERT INTO site_content (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(PREFIX + rowId, JSON.stringify({ from: a.value, to: b.value }));

  // “the same words in both boxes” is not a change: while EDITING a rule it means *give me the
  // app's own words back* (the rule goes), and while adding one there is simply nothing to do —
  // reporting that as “removed” would tell the office something happened when nothing did.
  if (a.value === b.value) {
    let gone = 0;
    if (mine) gone += db.prepare('DELETE FROM site_content WHERE key = ?').run(PREFIX + mine).changes;
    if (same) gone += db.prepare('DELETE FROM site_content WHERE key = ?').run(PREFIX + same.id).changes;
    refresh();
    return gone ? { ok: true, id: '', removed: true } : { ok: true, id: '', unchanged: true };
  }
  const target = same ? same.id : (mine || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  if (mine && same && mine !== same.id) db.prepare('DELETE FROM site_content WHERE key = ?').run(PREFIX + mine);
  put(target);
  refresh();
  return { ok: true, id: target, updated: !!(mine || same) };
}

function remove(id) {
  const gone = db.prepare('DELETE FROM site_content WHERE key = ?').run(PREFIX + String(id || '')).changes > 0;
  refresh();
  return gone;
}

/** “Give me the app's own words back” — every change, in one go. */
function clear() {
  const n = db.prepare('DELETE FROM site_content WHERE key LIKE ?').run(PREFIX + '%').changes;
  refresh();
  return n;
}

/** The phrases the screens are built from — the searchable list on the office's page. */
function catalogue() {
  try { return require('./words_catalogue.json').phrases || []; }
  catch (e) { return []; }
}

module.exports = {
  MAX_FROM, MAX_TO,
  list, count, get, rules, refresh, rewrite, fix,
  save, remove, clear, catalogue,
};
