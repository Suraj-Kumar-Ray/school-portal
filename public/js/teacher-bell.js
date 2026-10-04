/* ============================================================
   The teacher's 🔔 — loaded on every teacher page.

   School's request (2026-09-19): “put a bell at the top right of the teacher's name
   card; a message sent by the admin should make it blink, with a sound.”

   So this script is the teacher-side twin of the office's dock
   (public/js/admin-alerts.js) and the parent's alert card (parent-alerts.js):

     1. asks /teacher/alerts.json every 20 seconds — the school's UNREAD messages for
        HIS classes (the same rows /teacher/messages reads),
     2. the moment a NEW message is seen (one the bell has never counted on THIS
        computer) it RINGS — three bright notes through a limiter, Web Audio, no file —
        and buzzes a phone that allows it,
     3. the bell BLINKS while anything is waiting; the blink stops only when the count
        reaches zero (opening /teacher/messages marks the school's messages read and
        the next poll sees 0),
     4. the badge always shows the true count — never a cached guess (no-store).

   One thing is remembered on THIS computer (localStorage), because it is about this
   desk, not the school's data:  vvsTeacherRang — message keys already rung for, so the
   same arrival never rings twice.
   ============================================================ */
(function () {
  'use strict';

  var FEED = '/teacher/alerts.json';
  var EVERY = 20000;                 // ask the school every 20 seconds
  var RANG_KEY = 'vvsTeacherRang';   // arrivals already announced aloud on this computer

  var bell = document.getElementById('pfBell');
  if (!bell) return;

  var rang = (function () {
    try {
      var raw = JSON.parse(localStorage.getItem(RANG_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  })();
  function has(key) { return rang.indexOf(key) !== -1; }
  function remember(key) {
    if (!has(key)) {
      rang.push(key);
      try { localStorage.setItem(RANG_KEY, JSON.stringify(rang.slice(-200))); } catch (e) {}
    }
  }

  /* ---------------- the state of the bell ---------------- */
  function paint(count) {
    count = Number(count) || 0;
    if (count > 0) {
      bell.classList.remove('is-quiet');
      bell.classList.add('is-new');
      bell.dataset.count = String(count);
      var badge = bell.querySelector('.pf-bell-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'pf-bell-badge';
        bell.appendChild(badge);
      }
      badge.textContent = String(count);
      var label = count === 1 ? 'message from the school office — open your inbox'
                              : 'messages from the school office — open your inbox';
      bell.setAttribute('aria-label', count + ' ' + label);
      bell.title = count + ' ' + label;
    } else {
      bell.classList.remove('is-new');
      bell.classList.add('is-quiet');
      bell.dataset.count = '0';
      var b = bell.querySelector('.pf-bell-badge');
      if (b) b.remove();
      bell.setAttribute('aria-label', 'No new messages from the school office');
      bell.title = 'No new messages from the school office';
    }
  }

  /* ============================================================
     SOUND — the same bright office bell the admin dock rings
     (three notes ×2 through a limiter; Web Audio, no file)
     ============================================================ */
  var audioCtx = null;
  var bus = null;

  function ensureCtx() {
    if (audioCtx) return audioCtx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; return null; }
    try {
      var limiter = audioCtx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 6;
      limiter.ratio.value = 16;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      limiter.connect(audioCtx.destination);
      bus = limiter;
    } catch (e) {
      bus = audioCtx.destination;
    }
    return audioCtx;
  }

  // a tap / keypress is what lets a browser play sound afterwards
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      var ac = ensureCtx();
      if (ac && ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    }, { passive: true });
  });

  function note(ac, freq, at, peak) {
    [1, 0.5].forEach(function (mul, layer) {
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = layer ? 'sine' : 'triangle';
      osc.frequency.value = freq * (layer ? 0.5 : 1);
      var amp = peak * (layer ? 0.4 : 1);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(amp, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + (layer ? 1.0 : 0.75));
      osc.connect(gain);
      gain.connect(bus || ac.destination);
      osc.start(at);
      osc.stop(at + 1.05);
    });
  }

  // G5 → C6 → E6, twice — the same bell the office hears, so “a message arrived”
  // sounds the same everywhere in the school
  function ring() {
    var ac = ensureCtx();
    if (!ac) return;
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    if (ac.state !== 'running') return;      // this browser has not been touched yet
    var now = ac.currentTime + 0.02;
    [0, 0.72].forEach(function (delay, round) {
      [783.99, 1046.5, 1318.51].forEach(function (freq, i) {
        note(ac, freq, now + delay + i * 0.16, round ? 0.55 : 0.7);
      });
    });
  }

  function buzz() {
    try {
      if (!navigator.vibrate) return;
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      navigator.vibrate([140, 80, 140, 80, 220]);
    } catch (e) {}
  }

  /* ---------------- the loop ---------------- */
  var firstLook = true;
  var busy = false;

  function check() {
    if (busy) return;
    busy = true;
    fetch(FEED, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        busy = false;
        if (!data || typeof data.unread === 'undefined') return;
        paint(data.unread);

        var latest = data.latest;
        if (!latest || !data.unread) { firstLook = false; return; }

        // a message the bell has never counted on THIS computer…
        var fresh = !has(latest.key);
        remember(latest.key);

        // …rings — but only if it really JUST arrived (a first look at a day-old
        // backlog is simply there; the badge shows it, the room stays quiet)
        var justIn = firstLook ? fresh : (fresh || firstLook);
        firstLook = false;
        if (fresh && justIn) { ring(); buzz(); }
      })
      .catch(function () { busy = false; });
  }

  setTimeout(check, 700);
  setInterval(check, EVERY);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', function (e) { if (e.persisted) check(); });
})();
