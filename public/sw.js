/* ============================================================
   Parent app service worker
   ------------------------------------------------------------
   • keeps the app shell (css, icons, logo) so the app opens fast
     and shows an offline page instead of a browser error
   • NEVER caches a signed-in page — HTML is always fetched fresh,
     so nothing leaks between parents sharing one phone
   • new versions activate immediately (skipWaiting + claim) and the
     page reloads itself once, so the phone always runs the newest
     code the moment the school office updates it
   • shows the school's notifications on the phone itself (parent-alerts.js
     calls registration.showNotification) and opens the right page when
     the parent taps one
   ============================================================ */

const VERSION = 'v12';  // v6: the app icon became the school's round badge (no blue box behind it).
                        // v7: the school sent its new crest — icon AND logo both changed, so the
                        //     copy kept in the app shell has to be replaced on the next open.
                        // v8: the app can update itself on one tap (app-update.js) and this worker
                        //     learned REFRESH / SKIP_WAITING to help it
                        // v9: every request asks the tunnel for the APP, not for its warning page
                        //     (see “the tunnel's own warning page” below) — a parent's installed
                        //     app has no “Visit Site” button to tap
                        // v10: `hidden` means hidden again (one rule in style.css) and the front
                        //     image is shown in the school's own APK too — the precached style.css
                        //     has to be replaced or an offline page still carries the old rule
                        // v11: the wall answered even for the STYLESHEET on a first visit (mobile
                        //     Chrome UA → 2,819 bytes of text/html for /css/style.css), so the page
                        //     opened unstyled. Now the worker wins the visit cookie ITSELF and
                        //     retries the asset — the parent never taps anything.
                        // v12: the Inbox badge now clears when the parent has SEEN a message (the
                        //     pop-up card's ✓ Seen), so the precached style.css has to be
                        //     replaced or an offline page still shows the old badge sizing.
const SHELL = 'vvs-shell-' + VERSION;
const RUNTIME = 'vvs-runtime-' + VERSION;

// small, public, never-personal files
const PRECACHE = [
  '/offline',
  '/css/style.css',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.webmanifest',
];

const CACHEABLE = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|webmanifest)$/i;

/* ---- the tunnel's own warning page ----------------------------------------------------
   The free ngrok link answers a BROWSER with its “You are about to visit …” page
   (`Ngrok-Error-Code: ERR_NGROK_6024`) instead of the school's site. A parent can tap through
   that in Chrome, but an INSTALLED app has no such button — it would just show ngrok's warning
   for ever. One request header makes ngrok serve the app itself, and it means nothing to any
   other host, so every request this worker makes carries it. If the wall still arrives (a page
   loaded before this worker was installed), the parent gets a sentence in the school's own
   words telling them the one tap that fixes it — never ngrok's warning. */
const WALL_CODE = 'ERR_NGROK_6024';
const isWall = (res) => !!res && res.headers.get('ngrok-error-code') === WALL_CODE;

/** the same request, asking the tunnel for the app instead of its warning page */
function appRequest(req) {
  try {
    const headers = new Headers(req.headers);
    headers.set('ngrok-skip-browser-warning', '1');
    const init = { headers, credentials: 'same-origin', redirect: 'follow' };
    // a navigation Request cannot be copied together with its own mode ('navigate' is not a mode
    // a script may construct) — build it from the URL and let the browser pick the default
    if (req.mode === 'navigate') return new Request(req.url, init);
    return new Request(req, init);
  } catch (e) {
    return req;                                   // something exotic: fetch it untouched
  }
}

/* ---- winning the visit cookie OURSELVES (v11) ------------------------------------------
   The wall stops a request only when it looks like a BROWSER (a UA header) and the request
   carries neither the skip header (our fetches always do) nor the `abuse_interstitial` cookie
   that the wall's “Visit Site” button sets. A NAVIGATION that slipped past this worker (the
   very first load, before the worker was controlling the page) got the wall, the parent tapped
   “Visit Site”, and the page loaded — but its stylesheet, images and scripts are SEPARATE GETs
   from the browser's cache/HTTP stack, with the worker now in charge. They used to meet the
   wall too (measured: /css/style.css → 2,819 bytes of text/html) and the browser threw them
   away — the unstyled-page bug the school saw on a phone.

   The fix asks the tunnel for the wall page OURSELVES, with the browser's own cookies — the
   wall answers a fetch that carries a UA and NO skip header with the interstitial AND its
   `Set-Cookie: abuse_interstitial=…` — which the browser stores for this origin. From then on
   every request (worker or not) carries the cookie and the wall lets everything through. */
let cookieWon = false;                            // one attempt per worker lifetime
async function winVisitCookie() {
  if (cookieWon) return;
  cookieWon = true;
  try {
    // no skip header on PURPOSE: this fetch is the “browser visit” the wall expects
    await fetch(self.location.origin + '/', { credentials: 'include', redirect: 'follow' });
  } catch (e) { cookieWon = false; }              // offline: try again on the next wall
}

const WALL_PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>One more tap</title></head>'
  + '<body style="font:16px/1.55 system-ui,-apple-system,sans-serif;margin:0;padding:30px 22px;'
  + 'color:#0f172a;background:#f4f7fc">'
  + '<h1 style="font-size:20px;margin:0 0 10px">The school app needs one tap</h1>'
  + '<p>Open the school link in <b>Chrome</b> on this phone and tap <b>“Visit Site”</b> once. '
  + 'After that this app opens normally.</p>'
  + '<p><a href="/parent" style="color:#2563eb;font-weight:600">Try again</a></p></body></html>';

/** cache the app shell WITHOUT ever storing a tunnel warning page in its place */
function precacheInto(cache) {
  return Promise.all(PRECACHE.map((url) =>
    fetch(appRequest(new Request(new URL(url, self.location.origin))))
      .then((res) => (res && res.ok && !isWall(res) ? cache.put(url, res) : null))
      .catch(() => null)
  ));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then(precacheInto)
      .then(() => self.skipWaiting())
  );
});

// tapping a notification brings the app forward on that page
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/parent';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.indexOf(self.location.origin) === 0);
      if (open) {
        return open.focus().then(() => (open.navigate ? open.navigate(target) : null)).catch(() => {});
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : null;
    })
  );
});

// ---- the app's update tap (public/js/app-update.js) -------------------------------------
// REFRESH: throw the cached copy of the app's files away and fetch the current ones, so the
//          reload that follows is a genuinely new app rather than the old one served from here.
// SKIP_WAITING: a newer worker is installed but waiting its turn — step aside now.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (data.type === 'REFRESH') {
    event.waitUntil(
      caches.delete(RUNTIME)
        .then(() => caches.open(SHELL))
        .then(precacheInto)
        .then(() => {
          return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) =>
            Promise.all(list.map((c) => (c.postMessage ? c.postMessage({ type: 'REFRESHED' }) : null)))
          );
        })
        .catch(() => {})
    );
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // never touch other origins
  if (url.pathname === '/sw.js') return;                // let the browser fetch it directly
  if (url.pathname.startsWith('/logout')) return;       // always hit the server

  // pages: network first (never cached), offline page as the fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(appRequest(req)).then(async (res) => {
        if (isWall(res)) { await winVisitCookie(); return new Response(WALL_PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
        return res;
      }).catch(() =>
        caches.match('/offline').then((page) => page || new Response(
          '<h1>You are offline</h1><p>Connect to the internet and try again.</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        ))
      )
    );
    return;
  }

  // static assets: newest from the network first, cached copy only when offline
  // (the school updates the app often, so fresh CSS/JS matters more than a saved
  //  millisecond — the cache is the offline safety net)
  if (CACHEABLE.test(url.pathname)) {
    event.respondWith(
      fetch(appRequest(req)).then(async (res) => {
        if (isWall(res)) {
          // The wall answered for a STYLESHEET (or a script, an image…). Win the
          // visit cookie, then ask once more — with the cookie in the jar the
          // tunnel serves the school's own file.
          await winVisitCookie();
          const second = await fetch(appRequest(req)).catch(() => null);
          if (second && second.ok && !isWall(second)) {
            const copy = second.clone();
            caches.open(RUNTIME).then((cache) => cache.put(req, copy)).catch(() => {});
            return second;
          }
          // still walled (the cookie needs a reload to reach the non-worker GETs):
          // a cached copy from an earlier visit is far better than a page of HTML
          const hit = await caches.match(req);
          if (hit) return hit;
          return second || res;
        }
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('/offline')))
    );
  }
});
