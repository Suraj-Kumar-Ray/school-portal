/* ============================================================
   THE QUESTION BEFORE A CHANGE — one asker, every page.
   ============================================================

   School's request (2026-09-16): “everywhere something is saved or deleted, ask once —
   do you really want to change this? — so that nothing goes wrong by mistake.”

   Instead of writing a confirm() into eighty different forms, this one script watches
   EVERY form on the page and asks the same way, in the same box, with the same words,
   on the office's screen and on a village phone:

       a delete  →  the red “Yes, delete” box, and it says it cannot be undone
       a save    →  the blue “Yes, save” box, naming the button that was pressed

   WHICH FORMS ARE ASKED
   ---------------------
   Every form that posts (method="POST") and really changes something, EXCEPT the ones
   that say otherwise in their own markup — so the rule lives in one place and a page
   only speaks up when it is an exception:

     data-confirm="own"    the view already shows its own question
                           (fee marks/receipt/fine, timetable delete, topper names,
                           the fee-structure PDF upload) — never asked twice
     data-confirm="off"    never ask: a lookup, a download or a print sheet
     data-confirm-title / data-confirm-msg / data-confirm-ok
                           keep the shared box, use my own words

   Not asked, because asking would be noise (decided here, not per view):
     • a GET form (a search / filter — it changes nothing)
     • a form that opens a new tab, or posts to /print, /pdf, /export, /csv, /download
     • a form the page itself already blocked (it said no on its own)

   WHY IT IS WORTH TRUSTING
   ------------------------
   “No, go back” holds the keyboard focus, Esc closes the box, and a tap outside it
   closes the box too — the safe answer is always the easy one. On “Yes” the form is
   re-submitted through requestSubmit(), so the browser's own required / pattern checks
   still run and every other script on the page (the save chime, the green tick) still
   sees it. The Save button is switched off while the page is posting, so a slow village
   connection cannot turn one tap into two receipts.
   ============================================================ */
(function () {
  'use strict';

  var box = document.getElementById('saveConfirm');
  if (!box) return;
  var titleEl = document.getElementById('saveConfirmTitle');
  var msgEl = document.getElementById('saveConfirmMsg');
  var iconEl = document.getElementById('saveConfirmIcon');
  var yesBtn = document.getElementById('saveYes');
  var noBtn = document.getElementById('saveNo');
  if (!titleEl || !msgEl || !yesBtn || !noBtn) return;

  /* ---------- what counts as a delete ---------- */
  // The words have to match the deed: “Yes, delete” on a red button for something that is
  // going away, “Yes, save” for everything else.
  var DESTRUCTIVE = /\b(delete|deletes|deleting|remove|removes|reject|rejects|discard|clear|reset|close|stop|withdraw|unpaid|block)\b/i;
  // a POST that renders a document is not a change
  var DOC_LIKE = /\/(print|pdf|export|csv|download|invoice)(\/|$|\?)/i;

  var pending = null;      // the form that is waiting for an answer
  var submitter = null;    // the button that was pressed (so the wording names it)
  var posting = false;     // a change is on its way — one tap must not become two saves

  /* ---------- small helpers ---------- */
  // button text without emoji / symbols: “✅ I have paid — tell the school” → “I have paid — tell the school”
  function words(el) {
    if (!el) return '';
    var t = el.textContent || el.value || '';
    return String(t).replace(/[^\x20-\x7E\u00A0-\u024F]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function attr(el, name) { return el ? (el.getAttribute(name) || '').trim() : ''; }

  // A form asks its own way when its markup calls confirm() — that is every inline
  // `onsubmit="return confirm(...)"` and every `onclick="return confirm(...)"` button.
  function asksItself(form, btn) {
    if (attr(form, 'data-confirm').toLowerCase() === 'own') return true;
    if (attr(form, 'data-confirm-by') === 'view') return true;
    if (/confirm\s*\(/.test(form.getAttribute('onsubmit') || '')) return true;
    if (btn && /confirm\s*\(/.test(btn.getAttribute('onclick') || '')) return true;
    return false;
  }

  function shouldAsk(form, btn) {
    if (!form || form.tagName !== 'FORM') return false;
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'post') return false;
    var mode = attr(form, 'data-confirm').toLowerCase();
    if (mode === 'off' || mode === 'own') return false;
    if (asksItself(form, btn)) return false;
    if (form.target && form.target !== '_self') return false;          // opens another tab
    var action = form.getAttribute('action') || '';
    var label = words(btn) || words(form.querySelector('button[type="submit"], input[type="submit"]'));
    if (DOC_LIKE.test(action) && !DESTRUCTIVE.test(action) && !DESTRUCTIVE.test(label)) return false;
    return true;
  }

  /* ---------- the box ---------- */
  var lastFocus = null;
  function open(form, btn) {
    pending = form;
    submitter = btn;
    var label = words(btn) || words(form.querySelector('button[type="submit"], input[type="submit"]')) || 'this';
    var action = form.getAttribute('action') || '';
    var dangerous = DESTRUCTIVE.test(action) || DESTRUCTIVE.test(label);

    var title = attr(form, 'data-confirm-title') || (dangerous ? 'Delete this?' : 'Apply the changes?');
    var msg = attr(form, 'data-confirm-msg') ||
      (dangerous
        ? 'You pressed “' + label + '”. This cannot be undone — do you really want to change it?'
        : 'You pressed “' + label + '”. Do you really want to save this change?');

    titleEl.textContent = title;
    msgEl.textContent = msg;
    iconEl.textContent = dangerous ? '🗑️' : '💾';
    yesBtn.textContent = attr(form, 'data-confirm-ok') || (dangerous ? 'Yes, delete' : 'Yes, save');
    yesBtn.classList.toggle('btn-danger', dangerous);
    yesBtn.classList.toggle('btn-primary', !dangerous);

    lastFocus = document.activeElement;
    box.classList.add('open');
    // the SAFE answer holds the focus: a stray Enter cancels instead of saving
    try { noBtn.focus(); } catch (e) {}
  }

  function close() {
    box.classList.remove('open');
    pending = null;
    submitter = null;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  // while the page is posting, every button on that form stops taking taps — the button
  // itself is NOT disabled, because requestSubmit() must still be able to name it
  function markPosting(form, on) {
    if (!form) return;
    [].forEach.call(form.querySelectorAll('button, input[type="submit"], input[type="image"]'), function (b) {
      b.classList.toggle('is-posting', !!on);
    });
    var pressed = form.querySelector('button[type="submit"].is-posting, input[type="submit"].is-posting');
    if (pressed && pressed.tagName === 'BUTTON') {
      if (on) {
        if (!pressed.getAttribute('data-label')) pressed.setAttribute('data-label', words(pressed));
        pressed.textContent = 'Working…';
      } else if (pressed.getAttribute('data-label')) {
        pressed.textContent = pressed.getAttribute('data-label');
      }
    }
  }

  function go() {
    var form = pending;
    var btn = submitter;
    if (!form) return close();
    box.classList.remove('open');
    pending = null;
    submitter = null;
    posting = true;
    form.setAttribute('data-confirmed', '1');           // the answer to the question below
    markPosting(form, true);
    if (typeof form.requestSubmit === 'function') form.requestSubmit(btn || undefined);
    else form.submit();
  }

  // A field the browser refused (required / wrong shape) means nothing was posted — the
  // form must become usable again, or a missing field would lock the page. The answer is
  // thrown away with it, so the NEXT save asks again instead of passing through quietly.
  document.addEventListener('invalid', function (e) {
    posting = false;
    var form = e.target && e.target.form;
    if (!form) return;
    markPosting(form, false);
    form.removeAttribute('data-confirmed');
  }, true);

  yesBtn.addEventListener('click', go);
  noBtn.addEventListener('click', close);
  box.addEventListener('click', function (e) { if (e.target === box) close(); });
  document.addEventListener('keydown', function (e) {
    if (!box.classList.contains('open')) return;
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && document.activeElement !== yesBtn && document.activeElement !== noBtn) {
      e.preventDefault(); close();
    }
  });

  /* ---------- the one listener ---------- */
  // Bubble phase on purpose: an inline onsubmit / the view's own submit handler runs
  // FIRST. If it already said no (e.defaultPrevented) there is nothing left to ask.
  var clicked = null;
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('button, input[type="submit"], input[type="image"]');
    clicked = t && t.form ? t : null;
  }, true);

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    // our own second pass — the question has been answered
    if (form.getAttribute('data-confirmed') === '1') {
      form.removeAttribute('data-confirmed');
      return;
    }
    if (posting) { e.preventDefault(); return; }       // the change is already on its way
    if (e.defaultPrevented) return;                    // the page handled it its own way
    var btn = (clicked && clicked.form === form) ? clicked : (e.submitter || null);
    clicked = null;
    if (!shouldAsk(form, btn)) return;
    e.preventDefault();
    open(form, btn);
  });
})();
