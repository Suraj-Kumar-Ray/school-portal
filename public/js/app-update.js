/* ============================================================
   app-update.js — “the app should tell me there is an update, and update”
   (school's request, 2026-09-18)
   ------------------------------------------------------------
   Two jobs, one file, on every page of the app:

   1. THE FRONT IMAGE. When the app is opened AS an app (installed / standalone), the launch
      screen from `views/partials/launch_screen.ejs` is shown over the page and lifted as soon as
      the page is ready. It is part of the HTML, so it always carries the newest crest and name —
      Android's own splash, drawn from the installed icon, cannot do that.

   2. THE UPDATE. Every page is rendered with the build it belongs to
      (`<meta name="app-release">`, from src/services/release.js). Two ways the app is kept new:

      a) OPENING THE APP. The build of the page is remembered (`localStorage['vvs-release']`).
         Opening the app on a newer build than the one remembered is the normal case after a
         change — the page arrived fresh (the service worker never serves a signed-in page from
         the cache), so nothing has to be tapped: the app quietly throws the OLD copies of its
         files away and says “Updated to the latest version”. That is the promise “I changed
         something, I opened the app, and it updated itself”.

      b) WHILE THE APP IS OPEN. This script also asks `/app-release.json` when the app opens
         (and every few minutes, and whenever it comes back to the front), so a page that was
         already open — or a phone whose copy is somehow behind — gets ONE pill: “Update
         available”. Tapping it throws away the cached copy of the app's files, waits for the
         service worker to hand over, and reloads.

   Nothing here is required for the app to work: with JavaScript off the pages are simply normal
   pages (the launch screen stays hidden), and no update is ever forced on a parent.
   ============================================================ */
(function () {
  'use strict';

  var doc = document;
  var RELEASE = (doc.querySelector('meta[name="app-release"]') || {}).content || '';
  var CHECK_MS = 5 * 60 * 1000;          // ask again every five minutes while the app is open
  var TOAST_MS = 4000;
  var SEEN_KEY = 'vvs-release';           // the build this phone last opened the app on
  var updated = false;                    // the parent already started an update this session

  /* ------------------------------------------------ 1. the app's front image */
  function standalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.navigator.standalone === true) return true;      // iOS
    } catch (e) { /* older browser: treat it as a browser tab */ }

    // The school's own APK: its WebView is not “standalone” and has no iOS flag either, so the
    // only honest way to know is the marker the server puts on the page (X-School-App →
    // `<html data-app-shell="1">`, see views/partials/header.ejs). Without this the front image
    // was never SHOWN in the app — and, while the CSS bug below lasted, never lifted there either.
    if (doc.documentElement && doc.documentElement.getAttribute('data-app-shell') === '1') return true;

    // `?launch=1` lets the office — and the tests — look at the front image in a plain browser
    return /[?&]launch=1/.test(location.search);
  }

  function launchScreen() {
    var screen = doc.getElementById('appLaunch');
    if (!screen || !standalone()) return;
    var MIN_MS = 500;                     // long enough to read, short enough to never annoy
    var MAX_MS = 6000;                    // a slow phone still gets its page
    var shown = Date.now();
    var lifted = false;

    function lift() {
      if (lifted) return;
      lifted = true;
      var wait = Math.max(0, MIN_MS - (Date.now() - shown));
      setTimeout(function () {
        screen.classList.add('is-done');
        setTimeout(function () { screen.hidden = true; }, 320);
      }, wait);
    }

    // EVERY reason to lift is registered BEFORE the screen is shown, so no ordering, no slow
    // request and no browser quirk can ever leave a parent staring at it:
    //   load        — the normal case,
    //   MAX_MS      — the page is slow, the phone is old, a request is stuck,
    //   pageshow    — the page came back from the back/forward cache.
    if (doc.readyState === 'complete') lift();
    else window.addEventListener('load', lift);
    setTimeout(lift, MAX_MS);
    window.addEventListener('pageshow', lift);

    screen.hidden = false;
  }

  /* ------------------------------------------------------- 2. the update tap */
  function pill() {
    var el = doc.getElementById('appUpdate');
    if (el) return el;
    el = doc.createElement('button');
    el.id = 'appUpdate';
    el.type = 'button';
    el.className = 'app-update no-print';
    el.hidden = true;
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<span class="app-update-icon" aria-hidden="true">\u21bb</span>'
      + '<span class="app-update-text">Update available</span>';
    el.addEventListener('click', apply);
    doc.body.appendChild(el);
    return el;
  }

  function show(message) {
    var el = pill();
    if (message) el.querySelector('.app-update-text').textContent = message;
    el.hidden = false;
    el.classList.add('is-in');
  }

  function toast(text) {
    var el = doc.getElementById('appUpdateToast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'appUpdateToast';
      el.className = 'app-update-toast no-print';
      doc.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('is-in');
    setTimeout(function () { el.classList.remove('is-in'); }, TOAST_MS);
  }

  /**
   * Drop the OLD copies of the app's files without reloading.
   *
   * Used when the app was opened onto a newer build: the page itself is already fresh, but the
   * service worker may still be holding yesterday's stylesheet for the offline case. Asking it
   * to refresh keeps the saved copy as new as the app. Failures are ignored — a phone with no
   * worker, or with private mode on, simply keeps its own cache.
   */
  function purgeShell() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      var worker = reg.active || reg.waiting || navigator.serviceWorker.controller;
      if (worker) { try { worker.postMessage({ type: 'REFRESH' }); } catch (e) { /* older worker */ } }
    }).catch(function () { /* nothing cached to drop */ });
  }

  /** throw the cached copy away, then come back on the newest build */
  function apply() {
    updated = true;
    show('Updating…');
    try { sessionStorage.setItem('vvs-updated', '1'); } catch (e) { /* private mode */ }
    var reload = function () { location.reload(); };
    if (!('serviceWorker' in navigator)) return reload();

    navigator.serviceWorker.ready.then(function (reg) {
      // ask the worker to drop its caches AND to step aside if a newer one is installed
      var send = function (worker) {
        if (!worker) return;
        try { worker.postMessage({ type: 'REFRESH' }); } catch (e) { /* older worker */ }
        try { worker.postMessage({ type: 'SKIP_WAITING' }); } catch (e) { /* older worker */ }
      };
      send(reg.waiting);
      send(reg.active);
      var done = false;
      var go = function () { if (!done) { done = true; reload(); } };
      navigator.serviceWorker.addEventListener('controllerchange', go);
      // a worker that has nothing to swap still gets us a fresh page
      reg.update().catch(function () {}).then(function () { setTimeout(go, 900); });
      setTimeout(go, 2500);
    }).catch(reload);
  }

  /** ask the server which build it is on now */
  function check() {
    if (!RELEASE || updated || doc.hidden) return;
    fetch('/app-release.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.id && data.id !== RELEASE) show('Update available');
      })
      .catch(function () { /* offline: the service worker has the app, and the next open retries */ });
  }

  /* ------------------------------------------------------------------ start */
  function start() {
    launchScreen();

    // (a) opening the app on a newer build than last time = the app just updated itself
    var openedOnNewBuild = false;
    try {
      var seen = localStorage.getItem(SEEN_KEY);
      openedOnNewBuild = !!RELEASE && !!seen && seen !== RELEASE;
      if (RELEASE) localStorage.setItem(SEEN_KEY, RELEASE);
    } catch (e) { /* private mode: nothing remembered, the check below still runs */ }
    if (openedOnNewBuild) purgeShell();

    var justUpdated = false;
    try {
      justUpdated = sessionStorage.getItem('vvs-updated') === '1';
      if (justUpdated) sessionStorage.removeItem('vvs-updated');
    } catch (e) { /* private mode */ }
    if (justUpdated || openedOnNewBuild) toast('Updated to the latest version');

    check();
    setInterval(check, CHECK_MS);
    // coming back to the app (or back online) is the moment to look for a new build
    doc.addEventListener('visibilitychange', function () { if (!doc.hidden) check(); });
    window.addEventListener('online', check);

    // A service worker taking over means the app's files changed — but NOT by itself: the very
    // first visit is also a takeover (the worker calls clients.claim()), and showing “Update
    // available” there would offer a parent an update that does not exist. So ask the server.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', check);
    }
  }

  // for the smoke tests, and for anyone curious from the console.
  // `start()` is exposed so the “I opened the app and it had updated itself” path can be
  // checked without reloading the page (see .freebuff/smoke-app-update.js).
  window.vvsAppUpdate = {
    check: check, apply: apply, start: start, release: RELEASE, seenKey: SEEN_KEY,
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})();
