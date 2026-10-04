/* ============================================================
   Prefetch on hover — the office's pages open instantly.

   A class list is half a megabyte of HTML: without this, every click shows a blank screen while
   the server renders and the browser parses it. Pointing at a link is a strong hint of where you
   are going, so the page is fetched into the browser's cache first and the click becomes instant.

   Deliberately careful:
     • only on a device with a real pointer (a thumb does not hover), so a phone never wastes data,
     • only same-origin links that actually change the page — never /logout, never a #fragment on
       the page we are already on, never a download, never a new tab,
     • one fetch per URL, at most 3 in flight, and skipped while the connection is slow or the
       browser says it is saving data,
     • 80ms of hover first, so sweeping the pointer across a list does not fire a fetch per row.
   ============================================================ */
(function () {
  'use strict';

  if (!window.fetch) return;
  var hoverCapable = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (!hoverCapable) return;
  // A class list is ~700 KB of HTML, so this is a fast-connection trick only: on 2g/3g (or with
  // data saver on) a wrong guess would cost the school a minute of their bandwidth for nothing.
  if (navigator.connection) {
    var c = navigator.connection;
    if (c.saveData) return;
    if (c.effectiveType && c.effectiveType !== '4g') return;
  }

  var seen = {};
  var inflight = 0;
  var MAX = 3;

  function sameOrigin(url) {
    return url.origin === location.origin;
  }

  function worthIt(a) {
    if (a.hasAttribute('data-no-prefetch')) return false;
    if (a.target && a.target !== '_self') return false;
    if (a.hasAttribute('download')) return false;
    if (a.getAttribute('rel') === 'external') return false;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return false;
    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return false; }
    if (!sameOrigin(url)) return false;
    if (url.pathname === '/logout') return false;
    if (url.pathname === location.pathname && url.search === location.search) return false;  // we are here
    if (seen[url.href]) return false;
    return url;
  }

  function warm(url) {
    if (inflight >= MAX || seen[url.href]) return;
    seen[url.href] = 1;
    inflight++;
    fetch(url.href, { credentials: 'same-origin', priority: 'low' })
      .catch(function () {})
      .then(function () { inflight--; });
  }

  var timer = null;
  var pending = null;

  document.addEventListener('pointerover', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var url = worthIt(a);
    if (!url) return;
    pending = url;
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      if (pending) warm(pending);
      pending = null;
    }, 80);
  }, { passive: true });

  // a hover that ends before the timer fires should not warm anything
  document.addEventListener('pointerout', function () {
    pending = null;
  }, { passive: true });

  // the pointer is already on a link and the user presses the key/touch — warm it now
  document.addEventListener('pointerdown', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var url = worthIt(a);
    if (url) warm(url);
  }, { passive: true, capture: true });
})();
