const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const db = require('./db');
const msg = require('./services/messages');
const time = require('./services/time');
const aadhaar = require('./services/aadhaar');
const parentAccess = require('./services/parent_access'); // what the office lets a parent see
const officeFeed = require('./services/office_feed');      // what has arrived for the office (the corner bell)
const words = require('./services/words');                // every word on a page is the office's to change
const release = require('./services/release');            // which build of the app this is (the update prompt)
const timetable = require('./services/timetable');        // short day names for the teacher's week card

const authRoutes = require('./routes/auth');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const parentRoutes = require('./routes/parent');
const teacherRoutes = require('./routes/teacher');

const app = express();

/**
 * Is this request the school's own APK? Its WebView sets `school_app=1` before it makes any request
 * (android/java/…/MainActivity.java), and a WebView sends its cookies on every navigation by
 * itself — which is exactly why the marker is a cookie and not a header: a header only travels on
 * the one request the app builds, never on the pages the parent clicks into.
 *
 * Read straight off the raw header — no cookie-parser dependency for one boolean (the project has
 * no cookie-reading library and does not need one).
 */
function isAppCookie(req) {
  const jar = req.headers.cookie;
  if (!jar) return false;
  return jar.split(';').some((part) => part.trim() === 'school_app=1');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true, limit: '30mb' })); // 30mb so data-URI photos + the admin fee-structure PDF upload fine

// ---- parent app (PWA): manifest, service worker, offline page ----
// served explicitly so browsers get the manifest MIME type they insist on,
// and so the service worker is allowed to control the whole site.
app.get('/manifest.webmanifest', (req, res) =>
  res.type('application/manifest+json').sendFile(path.join(__dirname, '..', 'public', 'manifest.webmanifest')));
app.get('/sw.js', (req, res) => {
  res.set('Service-Worker-Allowed', '/');
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript').sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- THE RELEASE STAMP (school's request, 2026-09-18) --------------------------------------
// “The moment I change anything, opening the app should offer an update.” Every page carries the
// release it was built from in `<meta name="app-release">`; `public/js/app-update.js` compares it
// with this endpoint (never cached) and shows one tap that clears the caches and reloads. The
// stamp is a hash of the watched files' sizes and times — see src/services/release.js.
app.get('/app-release.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(release.info());
});
// serve Chart.js from node_modules
app.use('/vendor/chart.js', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist')));

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 },
}));

// expose current user + school branding to all views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.query = req.query;
  res.locals.school = config;
  // …and the build this page belongs to, so the app can tell when the server has moved on
  try { res.locals.appRelease = release.info().id; } catch (e) { res.locals.appRelease = ''; }
  // …and whether this request came from the school's own APK, whose WebView has no Notification
  // API: the pages then skip the “turn on notifications” prompt instead of offering something that
  // cannot work on that phone. The app says so TWO ways, and either one is enough:
  //
  //   X-School-App: 1  — on the one request it makes itself;
  //   school_app=1     — a cookie it sets before that request, which the WebView then sends with every
  //                   navigation by itself. That cookie is what makes the marker survive normal
  //                   clicking around (and the `data-app-shell` marker is what tells
  //                   public/js/app-update.js that this WebView IS the app, so the front image is
  //                   shown there — a WebView matches neither `display-mode: standalone` nor
  //                   iOS's flag).
  //
  // Never trust the header alone: it is not sent on navigations the WebView starts on its own.
  res.locals.appShell = req.get('x-school-app') === '1' || isAppCookie(req);
  // EVERY date/time shown must be IST and must go through these helpers —
  // the database stores UTC (see src/services/time.js for why).
  res.locals.tz = time.TZ;
  res.locals.tzLabel = time.TZ_LABEL;
  res.locals.fmtDateTime = time.fmtDateTime;
  res.locals.fmtDate = time.fmtDate;
  res.locals.fmtDayDate = time.fmtDayDate;
  res.locals.fmtShortDate = time.fmtShortDate;
  res.locals.fmtTime = time.fmtTime;
  res.locals.fmtDMY = time.fmtDMY;
  // the teacher's week card prints short day names from the same table the timetable uses
  res.locals.ttShort = (d) => timetable.SHORT[d] || d;
  // Aadhaar numbers are stored as digits and always shown grouped (1234 5678 9012)
  res.locals.fmtAadhaar = aadhaar.format;
  res.locals.istToday = time.todayISO;
  res.locals.istYear = time.yearIST;
  // admission poster bell: on by default, admin can hide it from Admin → Homepage
  const ps = db.prepare("SELECT value FROM site_content WHERE key = 'posterShow'").get();
  res.locals.posterShow = !ps || ps.value !== '0';
  // poster slides — every poster file that exists is shown in the sliding window
  const posterDir = path.join(__dirname, '..', 'public', 'images');
  res.locals.posterSlides = ['poster-1.png', 'poster-2.png', 'poster-3.png', 'poster-4.png']
    .filter(f => fs.existsSync(path.join(posterDir, f)));
  // unread message badges for the sidebar
  if (req.session.user && req.session.user.role === 'parent') {
    res.locals.unreadParent = msg.parentUnreadCount(req.session.user.id);
    // which sections the office lets a parent open (Admin → Parent Access). Only the
    // switches here — the fee rule needs the child, which /parent resolves per request
    // and overrides this with (src/routes/parent.js). Needed here as well so every page
    // that shows the parent menu (for example the public website) has an answer.
    res.locals.parentAccess = parentAccess.forChild(0);
    res.locals.parentNav = parentAccess.navFor(res.locals.parentAccess);
    res.locals.parentTabs = parentAccess.tabFor(res.locals.parentAccess);
  } else if (req.session.user && req.session.user.role === 'admin') {
    res.locals.unreadAdmin = msg.adminUnreadCount();
    // …and the corner bell every office page carries (`partials/office_dock.ejs`). It is
    // rendered with the true number, so the dock is right from the first paint; after that
    // `public/js/admin-alerts.js` keeps it live. Four counts over small, indexed tables.
    res.locals.officeOpen = officeFeed.openCounts();
    // …and how many words the office has changed (Admin → Words), for the menu badge
    res.locals.wordsCount = words.rules().length;
  }
  // the teacher's own sections are loaded per request by requireTeacher()
  // (src/middleware/auth.js) so a permission change takes effect on the next click
  next();
});

// ---- EVERY WORD ON A PAGE IS THE OFFICE'S TO CHANGE (Admin → Words) ------------------------
// The saved rules (services/words.js) are applied to the FINISHED html, a moment before it
// leaves the server: text between tags, plus placeholder/title/aria-label/alt. A change needs
// no code, no template edit and no restart.
//   • `?words=off` on any page shows it in the app's own words (useful for comparing),
//   • the editor page itself is never rewritten, so the office can always undo,
//   • and with nothing saved this is a no-op, byte for byte.
// Wrapped in try/catch like every other decoration: a bad rule must never take a page down.
app.use((req, res, next) => {
  // The page's own path, read HERE and not inside the hook: a mounted router rewrites
  // `req.url` (and so `req.path`) while the request travels through it, so by the time the
  // page is sent, `/admin/wording` would look like `/wording` and the “never rewrite the
  // editor” rule would quietly stop working. `originalUrl` cannot change.
  const pagePath = String(req.originalUrl || '').split('?')[0];
  const send = res.send.bind(res);
  res.send = (body) => {
    try {
      if (typeof body === 'string' && req.query.words !== 'off') {
        const ct = String(res.get('Content-Type') || '');
        const looksHtml = !ct && /^\s*(<!DOCTYPE|<html)/i.test(body);
        if (ct.startsWith('text/html') || looksHtml) body = words.rewrite(body, pagePath);
      }
    } catch (err) { /* never break a page because of a word */ }
    return send(body);
  };
  next();
});

// ---- health check (the platform's uptime probe) -------------------------------------------
// A hosting platform calls this every few seconds; the database query proves more than
// “the process is alive” — it proves the ONE file of truth is readable where it sits.
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT COUNT(*) AS n FROM classes').get();
    res.json({ ok: true, school: config.schoolName });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'database not reachable' });
  }
});

// offline page shown by the service worker (needs school locals, so it lives here)
app.get('/offline', (req, res) => res.render('offline', { title: 'Offline' }));

app.use(authRoutes);
app.use(publicRoutes);   // public website: home, fee structure, teachers, apply
app.use('/admin', adminRoutes);
app.use('/parent', parentRoutes);
// teachers: only the sections the school office granted (src/services/permissions.js)
app.use('/teacher', teacherRoutes);
// students do not sign in — every child's data lives in the parent portal
app.use('/student', (req, res) => res.redirect('/parent'));

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.', code: 404 });
});

module.exports = app;