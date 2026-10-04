/* ============================================================
   Stay where you were — one shared script for every signed-in page.

   The school's complaint (2026-09-15): “I update something and the website goes to the bottom.”
   Work far down a long list — a student's fee ledger, the timetable, the payment details — press
   Save, and the page comes back from its redirect somewhere else entirely: the browser has no
   scroll to restore because the URL changed, and the save message then moves into the card it was
   saved from, dragging the page to wherever that card sits.

   So this script is deliberately narrow. It puts the scroll back in exactly two cases:

     1. a form on this page was just submitted (a save), or
     2. the browser went Back or Forward (setting `scrollRestoration = 'manual'` switched off the
        browser's own restore, so this replaces it).

   A save at the very top counts as a spot too (`0` is a position, not “nothing”): the office was
   reading the money cards, pressed send, and must stay there — that case used to fall through and
   leave the page to be dragged around by whatever else wanted to scroll it (school's complaint,
   2026-09-15).

   Anything else — tapping “Fees” in the bar, opening a page from a message — starts at the TOP.
   That matters: a fee list is 336 cards, so restoring an old spot on a fresh visit would drop the
   office into the middle of the list, under the four money cards they came to read.

   And after a SEARCH the caret goes back into the search box, scrolled into view, instead of the
   old spot — the box is what the hands are going to next.

   Nothing here touches a page's data — it is only where the page is looking.
   ============================================================ */
(function () {
  'use strict';

  // We put the scroll back ourselves, so the browser must not guess at it as well. (Where this is
  // not supported the call is ignored and the browser restores natively — still correct.)
  if ('scrollRestoration' in history) { try { history.scrollRestoration = 'manual'; } catch (e) {} }

  var POS = 'vvsScroll:';    // this page's last spot
  var SAVE = 'vvsSaving:';   // a form on this page was just submitted
  var here = location.pathname;

  function remember() {
    try { sessionStorage.setItem(POS + here, String(Math.round(window.scrollY || window.pageYOffset || 0))); }
    catch (e) { /* private mode — the page simply opens at the top, as before */ }
  }

  function takePos() {
    var y = null;
    try {
      y = sessionStorage.getItem(POS + here);
      sessionStorage.removeItem(POS + here);   // one comeback per leaving
    } catch (e) {}
    return y === null ? null : Number(y) || 0;
  }

  function takeSave() {
    var flag = false;
    try {
      flag = sessionStorage.getItem(SAVE + here) === '1';
      sessionStorage.removeItem(SAVE + here);
    } catch (e) {}
    return flag;
  }

  /* ---- on the way out ---- */

  // A save: mark the page so the redirect's landing gets the spot back, whatever the message
  // says. Only a POST counts — every filter and search box on these pages is a GET, and coming back
  // from a filter wants the top of the new, shorter list, not the bottom of the old one.
  // The marker is per path, so it can only ever restore the page it was set on.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f && String(f.method || '').toLowerCase() === 'get') return;
    try { sessionStorage.setItem(SAVE + here, '1'); } catch (e2) {}
    remember();
  });

  // Leaving at all (a link, Back, closing the tab) — the spot for a Back to come back to.
  window.addEventListener('pagehide', remember);

  /* ---- on the way in ---- */

  // A URL that arrives with a fragment (`/admin/toppers?saved=1#topper-3`) has its own target.
  if (location.hash) { takePos(); takeSave(); return; }

  var y = takePos();
  var saving = takeSave();
  var cameBack = false;
  try {
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    cameBack = !!nav && nav.type === 'back_forward';
  } catch (e) {}

  // A search was just run on this page: the box is where the hands are going next.
  if (/[?&]q=/.test(location.search)) {
    var box = document.querySelector('input[name="q"], input[type="search"]');
    if (box && !box.disabled && !box.readOnly) {
      try {
        box.focus({ preventScroll: true });
        var end = box.value.length;
        box.setSelectionRange(end, end);      // keep the caret at the end of what was typed
        box.scrollIntoView({ block: 'center', behavior: 'instant' });
      } catch (e) {}
    }
    return;                                   // the results, not the old spot, are what to show
  }

  if (y !== null && (saving || cameBack)) {
    // `instant` — a smooth scroll would visibly slide the page on every save. A saved spot of 0
    // (the top) needs no scrolling, but it is still a spot: the page must not move from here.
    if (y) {
      try { window.scrollTo({ top: y, behavior: 'instant' }); }
      catch (e) { window.scrollTo(0, y); }
    }
  }
})();
