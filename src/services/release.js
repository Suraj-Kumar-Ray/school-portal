/**
 * ============================================================================
 * release.js — “has the app changed since this page was built?”
 * ============================================================================
 *
 * School's request (2026-09-18): “the moment I change anything, opening the app should offer an
 * update and everything — even the app's front image — should update.”
 *
 * One answer, for the whole app. A page is rendered with the release it was built from
 * (`<meta name="app-release">`, see `views/partials/header.ejs`); the phone asks
 * `/app-release.json` for the release the SERVER is on now; if the two differ, the parent (or
 * the office, or a teacher) sees one tap that refreshes the caches and reloads the app.
 *
 * What goes into the stamp:
 *
 *   • the service worker's own `VERSION` (`public/sw.js`) — the app's named release, and
 *   • a short hash of every watched file's `path:size:mtime`, so a change nobody remembered to
 *     number is still a change. A hash of sizes + times, not of contents: the project is ~3 MB
 *     and this runs on page requests, so it must not read a single file. An edit that keeps a
 *     file at exactly the same size AND the same mtime does not exist in practice.
 *
 * Watched: `views/**`, `src/**`, `public/js/**`, `public/css/**`, `public/icons/**` and the app's
 * own files in `public/` (sw.js, the manifest, the logo). NOT watched on purpose:
 *
 *   • `public/uploads/**` — the office's own PDFs (a fee structure upload is content, not a release),
 *   • `public/images/students|teachers/**` — photos added during the day,
 *   • the database — content is never cached, so it is already fresh on every open.
 *
 * Cheap by design: a stat() per file behind a 4-second cache, so a page request never pays for it
 * twice, and a broken stamp can never take a page down (every caller guards for it).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SW_FILE = path.join(ROOT, 'public', 'sw.js');

/** directories walked in full, and the loose files that matter in `public/` */
const DIRS = [
  path.join(ROOT, 'views'),
  path.join(ROOT, 'src'),
  path.join(ROOT, 'public', 'css'),
  path.join(ROOT, 'public', 'js'),
  path.join(ROOT, 'public', 'icons'),
];
const FILES = [
  SW_FILE,
  path.join(ROOT, 'public', 'manifest.webmanifest'),
  path.join(ROOT, 'public', 'images', 'logo.png'),
];
const SKIP_DIRS = new Set(['node_modules', 'uploads', '.git']);

let cache = null;
let stamped = 0;

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
      continue;
    }
    let st;
    try { st = fs.statSync(full); } catch (e2) { continue; }
    out.push(`${path.relative(ROOT, full).replace(/\\/g, '/')}:${st.size}:${Math.round(st.mtimeMs)}`);
  }
}

/** The release the server is on, right now. Cached for a few seconds. */
function info() {
  const now = Date.now();
  if (cache && now - stamped < 4000) return cache;

  const lines = [];
  for (const f of FILES) {
    try {
      const st = fs.statSync(f);
      lines.push(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch (e) { /* a file that is not there just is not part of the stamp */ }
  }
  for (const d of DIRS) walk(d, lines);
  lines.sort();

  let version = '?';
  try {
    version = (fs.readFileSync(SW_FILE, 'utf8').match(/const VERSION = '([^']+)'/) || [null, '?'])[1];
  } catch (e) { /* keep '?' */ }

  const hash = crypto.createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 8);
  cache = {
    id: `${version}.${hash}`,      // what a page and the phone compare
    version,                       // the app's named release (public/sw.js)
    hash,
    files: lines.length,
    changed: lines.length ? Number(lines.map((l) => Number(l.split(':')[2])).sort((a, b) => b - a)[0]) : 0,
  };
  stamped = now;
  return cache;
}

/** force the next call to look again (used by the tests) */
const refresh = () => { stamped = 0; };

module.exports = { info, refresh };
