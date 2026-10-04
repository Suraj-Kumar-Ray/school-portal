/* ============================================================
   Admin save feedback — one shared place, every admin page.

     1. a short chime when a save / update / delete actually goes through
     2. the green ✅ tick animation — “Saved!”, or “Sent successfully!” when the
        message that came back is about something going OUT to parents
     3. the "Saved" message moves INTO the card that was updated, so the
        admin sees it right where they clicked Save (if the page has no
        single obvious save card, it slides in as an on-screen alert instead)

   Loaded only for admins (footer.ejs). No audio file needed — the chime is
   two soft sine notes from the Web Audio API.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- sound ---------------- */
  var CHIME_KEY = 'vvsChimeAt';
  var audioCtx = null;

  // one shared context for the whole page (browsers cap how many you may open)
  function ensureCtx() {
    if (audioCtx) return audioCtx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; }
    return audioCtx;
  }

  // a click/keypress lets the browser start audio, so later chimes always ring
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      var ac = ensureCtx();
      if (ac && ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    }, { once: true, passive: true });
  });

  function chime(kind) {
    var ac = ensureCtx();
    if (!ac) return;
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }

    var now = ac.currentTime;
    var notes = kind === 'error' ? [415.3, 311.1] : [784, 1174.7];   // soft two-note bell
    notes.forEach(function (freq, i) {
      var t = now + i * 0.14;
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.55);
    });
    try { sessionStorage.setItem(CHIME_KEY, String(Date.now())); } catch (e) {}
  }

  // one chime per save: the click already rings in the old page, so the page
  // that comes back from the redirect stays quiet when it is the same save
  function chimeOnce(kind) {
    var last = 0;
    try { last = Number(sessionStorage.getItem(CHIME_KEY)) || 0; } catch (e) {}
    if (Date.now() - last < 4000) return;
    chime(kind);
  }

  window.vvsChime = chime;   // so a page's own popup can ring too

  /* a form that really submits (any native confirm was already answered).
     Only POST — a search / filter form is not an update. */
  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return;          // the page shows its own popup first
    var form = e.target;
    if (!form || (form.getAttribute('method') || 'get').toLowerCase() !== 'post') return;
    chime('ok');
  });

  /* "OK" on any confirm dialog = the save is happening now */
  var nativeConfirm = window.confirm;
  window.confirm = function () {
    var answer = nativeConfirm.apply(window, arguments);
    if (answer) chime('ok');
    return answer;
  };

  /* the OK button of a page's own centered save popup */
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest &&
      e.target.closest('#saveYes, .save-confirm-actions .btn-primary');
    if (btn) chime('ok');
  }, true);

  /* ---------------- tick + message ---------------- */
  var flash = document.querySelector('.main > .alert.success') ||
              document.querySelector('.main > .alert.error');
  if (!flash) return;
  var isError = flash.classList.contains('error');

  /* A send is not a save (school's request, 2026-09-15): when a message went OUT to parents, the
     big tick has to say so. The views mark those alerts `data-flash="sent"` (fee reminders, one
     family's due message, a reply, an announcement, a notice, a date-sheet), and everything else
     keeps saying “Saved!”. The words on screen have to match what just happened. */
  var wasSend = !isError && flash.getAttribute('data-flash') === 'sent';

  chimeOnce(isError ? 'error' : 'ok');
  if (!isError) showTick();

  function showTick() {
    var box = document.createElement('div');
    box.className = 'tick-overlay';
    box.innerHTML =
      '<div class="tick-circle"><svg viewBox="0 0 52 52">' +
      '<circle cx="26" cy="26" r="24"/><path d="M14 27l8 8 16-16"/></svg></div>' +
      '<div class="tick-text">' + (wasSend ? 'Sent successfully!' : 'Saved!') + '</div>';
    document.body.appendChild(box);
    setTimeout(function () {
      box.classList.add('hide');
      setTimeout(function () { box.remove(); }, 400);
    }, 1700);
  }

  function submitBtn(form) {
    return form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  }

  /* Where the message goes — and it NEVER moves the page.

     School's complaint (2026-09-15, again): “I refresh the fees page and I end up at the bottom.”
     The message used to `scrollIntoView` the card it moved itself into, which dragged the office to
     the bottom of a 336-card list as soon as the page loaded — and a refresh keeps the flash in the
     URL, so a plain F5 did it too. The full-screen tick and the chime already announce that the
     change went through, so the message now simply sits where it belongs:

       `data-flash-into=".remind-panel"`  the VIEW names the home. A send uses this: you press send
                                          in the reminder panel and the answer appears in it.
       `data-flash-into="toast"`          the on-screen toast (fixed at the top, always visible,
                                          nothing moves) — for an answer about one row in a long
                                          list, where there is no single card it belongs to.
       (nothing)                          the one obvious save card on the page, as before; if the
                                          page has no such card, it becomes the toast.

     Nothing about a message is worth moving someone's screen for. */
  function flashHome(el) {
    var sel = el.getAttribute('data-flash-into');
    if (!sel || sel === 'toast') return false;             // “toast” = deliberately the toast
    var home = null;
    try { home = document.querySelector(sel); } catch (e) { home = null; }
    if (!home) return false;                                 // a selector with no target → fall back
    var body = home.querySelector('.panel-body') || home;
    body.appendChild(el);
    el.classList.add('alert-in-card');
    return true;
  }

  // The card that was just saved = a real POST form with its own submit button,
  // which is not a per-row button sitting inside a table. When a page has more
  // than one such form (per-class saves, delete rows, …) we only pick it if
  // exactly one of them looks like the "save" action — otherwise we do not guess.
  function savedCard() {
    var candidates = [].slice.call(document.querySelectorAll('main form')).filter(function (f) {
      if ((f.getAttribute('method') || 'get').toLowerCase() !== 'post') return false;
      if (f.closest('table')) return false;
      return !!submitBtn(f);
    });
    if (candidates.length <= 1) return candidates[0] || null;

    var saveish = candidates.filter(function (f) {
      var btn = submitBtn(f);
      var label = (btn.textContent || btn.value || '').trim();
      return /save|apply|update|publish|post|create/i.test(label);
    });
    return saveish.length === 1 ? saveish[0] : null;
  }

  function moveIntoCard(el) {
    var form = savedCard();
    if (!form) return false;
    var btn = submitBtn(form);
    if (!btn) return false;

    // walk up to the block that sits directly inside the form / card body
    var anchor = btn;
    while (anchor.parentElement && anchor.parentElement !== form &&
           !anchor.parentElement.classList.contains('panel-body')) {
      anchor = anchor.parentElement;
    }
    if (!anchor.parentElement) return false;

    el.classList.add('alert-in-card');
    anchor.parentElement.insertBefore(el, anchor);
    // …and NO scroll: the page stays exactly where the office left it (see the note above — this
    // `scrollIntoView` is what used to send them to the bottom of the fees list).
    return true;
  }

  function toast(el) {
    var box = document.createElement('div');
    box.className = 'flash-toast' + (isError ? ' error' : '');
    box.setAttribute('role', 'status');
    box.innerHTML = el.innerHTML;

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'flash-toast-x';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', function () { box.remove(); });
    box.appendChild(close);

    document.body.appendChild(box);
    setTimeout(function () {
      box.classList.add('hide');
      setTimeout(function () { box.remove(); }, 400);
    }, 6000);
  }

  if (flash.getAttribute('data-flash-into') === 'toast') return toast(flash);
  if (!isError && flashHome(flash)) return;      // the view named the panel it belongs in
  if (!isError && moveIntoCard(flash)) return;   // success → shown in the card it belongs to
  toast(flash);                                  // otherwise → on-screen alert, always visible
})();
