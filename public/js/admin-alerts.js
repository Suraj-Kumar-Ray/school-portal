/* ============================================================
   Office notifications — the bell in the corner of every admin page.

   School's request (2026-09-16): "if any notification comes to the admin, whatever it is,
   it should make a sound — and instead of pop-up after pop-up I want to see on the side
   that a notification has arrived."

   So there is NO pop-up here. One bell stays while anything is waiting for the office
   (`partials/office_dock.ejs`, rendered with the true count) — a big one inline at the top right
   of the DASHBOARD, a floating one in the corner of every other office page — and this script:

     1. asks `/admin/office-feed.json` every 20 seconds,
     2. rings LOUD (Web Audio, three bright notes through a limiter — no audio file) the
        moment something NEW has arrived, with a buzz on a phone,
     3. makes the bell BLINK. The corner bell blinks for what is NEW until the office ticks it off;
        the dashboard's big bell blinks for as long as ANYTHING is waiting (it is the office's
        to-do, so it only goes quiet when the list is really empty — that is what “blink while a
        notification is there” means on a dashboard),
     4. keeps the number honest at all times: it is what is still waiting, so dealing with
        a claim or a reply makes it go down on its own within 20 seconds.

   Two things are remembered on THIS computer (localStorage), because they are about this
   office desk, not about the school's data:

       vvsOfficeRang  keys we have already rung for  → the same arrival never rings twice
       vvsOfficeSeen  keys the office has ticked off  → ONE ROW AT A TIME (school's request,
                       2026-09-16: “make mark-as-seen selective — this one is seen”). The ✓ on a
                       row is the only thing that clears it; opening the dock no longer clears
                       anything, and “Mark all seen” in the footer is the quick way to clear the
                       lot. A ticked row also stops the corner bell's blinking.
       vvsOfficeMute  the office silenced the bell   → the 🔔 in the panel toggles it

   The feed itself (what counts as an arrival, and why the office's own mail stays out) lives
   in `src/services/office_feed.js`. Nothing here decides anything about a notification.
   ============================================================ */
(function () {
  'use strict';

  var FEED = '/admin/office-feed.json';
  var EVERY = 20000;                 // ask the school every 20 seconds
  var RANG_KEY = 'vvsOfficeRang';    // arrivals already announced aloud
  var SEEN_KEY = 'vvsOfficeSeen';    // arrivals the office has looked at
  var MUTE_KEY = 'vvsOfficeMute';

  var dock = document.getElementById('officeDock');
  if (!dock) return;
  var btn = document.getElementById('officeDockBtn');
  var panel = document.getElementById('officeDockPanel');
  var badge = document.getElementById('officeDockBadge');
  var countEl = document.getElementById('officeDockCount');
  var listEl = document.getElementById('officeDockList');
  var muteBtn = document.getElementById('officeDockMute');
  var closeBtn = document.getElementById('officeDockClose');
  var seenBtn = document.getElementById('officeDockSeen');

  // the dashboard's big bell behaves slightly differently from the floating corner one (see the
  // header note): it stays on the screen at zero and blinks for the whole backlog
  var inline = dock.classList.contains('office-dock-inline');
  var note = document.getElementById('officeDockNote');

  var rang = load(RANG_KEY);
  var seen = load(SEEN_KEY);
  var latest = null;                 // the last feed we were given
  var firstLook = true;
  var busy = false;
  var flashed = false;               // is the bell blinking right now?

  /* ---------------- what this desk remembers ---------------- */
  function load(key) {
    try {
      var raw = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function save(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr.slice(-200))); } catch (e) {}
  }
  function has(arr, key) { return arr.indexOf(key) !== -1; }
  function add(arr, storeKey, key) { if (!has(arr, key)) { arr.push(key); save(storeKey, arr); } }

  function muted() {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
  }
  function setMuted(on) {
    try { localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch (e) {}
    if (muteBtn) {
      muteBtn.textContent = on ? '🔕' : '🔔';
      muteBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      muteBtn.title = on ? 'Bell is muted — tap to unmute' : 'Mute the bell';
    }
  }

  /* ============================================================
     SOUND — three bright notes, twice, through a limiter
     ============================================================ */
  var audioCtx = null;
  var bus = null;

  function ensureCtx() {
    if (audioCtx) return audioCtx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; return null; }
    try {
      // the limiter lets the bell be turned up loud and still stay clean when two notes
      // land on top of each other (same trick the parent app's bell uses)
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

  // G5 → C6 → E6, twice: a bright office bell — louder than the parent app's, still pleasant
  function ring() {
    if (muted()) return;
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

  /* ============================================================
     TIME — the school runs on IST, so relative times are read in it
     ============================================================ */
  function parseTime(iso) {
    var s = String(iso || '').replace(' ', 'T');
    if (s.indexOf('Z') === -1 && s.indexOf('+') === -1) s += 'Z';   // stored as UTC
    var t = new Date(s);
    return isNaN(t.getTime()) ? null : t;
  }

  function when(iso) {
    var t = parseTime(iso);
    if (!t) return '';
    var mins = Math.round((Date.now() - t.getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hrs / 24);
    if (days === 1) return 'Yesterday';
    return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  }

  // did this arrive in the last few minutes? (only then is the first look worth a bell)
  function recent(iso) {
    var t = parseTime(iso);
    return !!t && Date.now() - t.getTime() < 5 * 60 * 1000;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ============================================================
     THE DOCK
     ============================================================ */
  function setTotal(total, messages) {
    total = Number(total) || 0;
    if (total > 0) {
      if (badge) {
        badge.hidden = false;
        if (badge.textContent.trim() !== String(total)) {
          badge.textContent = String(total);
          badge.classList.remove('pop');
          void badge.offsetWidth;              // restart the little pop
          badge.classList.add('pop');
        }
      }
    } else {
      close();                                  // nothing left to read
      if (badge) { badge.hidden = true; badge.textContent = '0'; }
    }

    if (inline) {
      // the dashboard's bell is ALWAYS on the screen — dimmed when there is nothing to do, and
      // carrying the same plain words the office can read from a step away
      dock.hidden = false;
      dock.classList.toggle('is-quiet', total === 0);
      if (note) {
        note.textContent = total === 0 ? 'Nothing is waiting'
          : total + (total === 1 ? ' thing is waiting for the office' : ' things are waiting for the office');
      }
    } else if (total === 0) {
      dock.hidden = true;                       // a floating bell for nothing is just clutter
    } else {
      dock.hidden = false;
    }

    if (countEl) countEl.textContent = String(total);
    // the Parent Messages badge in the sidebar, updated while the office sits on this page
    var navBadge = document.querySelector('[data-badge="office-messages"]');
    if (navBadge) {
      messages = Number(messages) || 0;
      navBadge.hidden = messages === 0;
      navBadge.textContent = String(messages);
    }

    // …and the bell's own state, on EVERY poll and in BOTH shapes: a page that was just opened
    // must show a blinking corner bell while anything is still unticked, not only when something
    // happens to arrive while the office is looking at the screen
    applyBlink();
  }

  /*
   * One row per arrival: the icon, the words, a link to the page that deals with it, and its own
   * ✓ MARK AS SEEN. The row is NOT one big link any more — the tick has to be a real target of
   * its own, or a thumb aiming at it would open the page instead (school's request, 2026-09-16).
   */
  function rows(items) {
    if (!items.length) return '<p class="od-empty">Nothing is waiting right now.</p>';
    return items.map(function (it) {
      var done = has(seen, it.key);
      var hint = done ? 'Seen — tap to undo' : 'Mark as seen';
      return '<div class="od-row' + (done ? ' is-ticked' : ' is-fresh') + '" data-key="' + esc(it.key) + '">' +
        '<span class="od-row-ico" aria-hidden="true">' + esc(it.icon) + '</span>' +
        '<a class="od-row-main" href="' + esc(it.href) + '">' +
          '<span class="od-row-top">' +
            '<span class="od-row-label">' + esc(it.label) + '</span>' +
            '<span class="od-row-time">' + esc(when(it.at)) + '</span>' +
          '</span>' +
          '<b class="od-row-title">' + esc(it.title) + '</b>' +
          '<span class="od-row-body">' + esc(it.body) + '</span>' +
        '</a>' +
        '<button type="button" class="od-row-seen' + (done ? ' is-done' : '') + '"' +
          ' data-seen="' + esc(it.key) + '" aria-pressed="' + (done ? 'true' : 'false') + '"' +
          ' aria-label="' + hint + '" title="' + hint + '">✓</button>' +
      '</div>';
    }).join('');
  }

  /** How many of the listed arrivals the office has not ticked off yet. */
  function unseenCount(items) {
    return (items || []).filter(function (it) { return !has(seen, it.key); }).length;
  }

  function draw(items) {
    if (!listEl) return;
    listEl.innerHTML = rows(items || []);
    var pill = document.getElementById('officeDockNew');
    if (pill) {
      var n = unseenCount(items);
      pill.hidden = n === 0;
      pill.textContent = n + ' new';
    }
  }

  /** Tick ONE arrival off — or untick it, if the office tapped the wrong row. */
  function markSeen(key, on) {
    var at = seen.indexOf(key);
    if (on === false) { if (at !== -1) seen.splice(at, 1); }
    else if (at === -1) { seen.push(key); }
    save(SEEN_KEY, seen);
    if (latest) draw(latest.items);
    applyBlink();
  }

  /** “Mark all seen” — the quick way to clear the whole list at once. */
  function markAllSeen() {
    ((latest && latest.items) || []).forEach(function (it) { if (!has(seen, it.key)) seen.push(it.key); });
    save(SEEN_KEY, seen);
    if (latest) draw(latest.items);
    applyBlink();
  }

  function blink(on) {
    flashed = !!on;
    dock.classList.toggle('is-new', !!on);
  }

  /*
   * Is the bell blinking? Two honest answers, one per shape:
   *   inline (dashboard) — while ANYTHING is waiting: the bell is the office's to-do list, so it
   *                        blinks until the work is actually dealt with (nothing to dismiss)
   *   corner (all pages) — only while an arrival is still UNTICKED; ticking it (✓ on the row, or
   *                        “Mark all seen”) stops it, exactly like the parent app's badge
   */
  function applyBlink() {
    var items = (latest && latest.items) || [];
    var waiting = !!(latest && Number(latest.total) > 0);
    blink(inline ? waiting : unseenCount(items) > 0);
  }

  // Opening the dock changes NOTHING about what is seen (school's request, 2026-09-16: “mark as
  // seen should be selective”). The office reads the list and ticks the ones it has dealt with;
  // “Mark all seen” clears the lot when that is quicker.
  function open() {
    if (!panel) return;
    panel.hidden = false;
    dock.classList.add('is-open');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    if (latest) draw(latest.items);
  }

  function close() {
    if (!panel) return;
    panel.hidden = true;
    dock.classList.remove('is-open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function isOpen() { return panel && !panel.hidden; }

  /* ---------------- the loop ---------------- */
  function check() {
    if (busy) return;
    busy = true;
    fetch(FEED, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        busy = false;
        if (!data || !data.items) return;
        latest = data;

        // what this desk has not been told about yet
        var fresh = data.items.filter(function (it) { return !has(rang, it.key); });
        var wasFirstLook = firstLook;
        firstLook = false;

        // remember everything: the sound is a one-off per arrival, never per poll
        data.items.forEach(function (it) { add(rang, RANG_KEY, it.key); });

        setTotal(data.total, data.counts && data.counts.message);
        if (isOpen()) draw(data.items);

        if (!fresh.length) return;

        // the office just opened the app: only something that has really just arrived is
        // worth a bell — a backlog from yesterday is simply there, in the corner
        var loud = !wasFirstLook || fresh.some(function (it) { return recent(it.at); });
        if (loud) { ring(); buzz(); }
        applyBlink();
      })
      .catch(function () { busy = false; });
  }

  /* ---------------- wiring ---------------- */
  setMuted(muted());
  if (btn) btn.addEventListener('click', function (e) {
    e.stopPropagation();
    isOpen() ? close() : open();
  });
  if (closeBtn) closeBtn.addEventListener('click', function (e) { e.stopPropagation(); close(); });
  // “Mark all seen” — and the per-row ✓ is delegated, because the rows are re-rendered on every
  // poll and on every tick (one listener, not one per row)
  if (seenBtn) seenBtn.addEventListener('click', function (e) { e.stopPropagation(); markAllSeen(); });
  if (listEl) listEl.addEventListener('click', function (e) {
    var tick = e.target && e.target.closest && e.target.closest('[data-seen]');
    if (!tick) return;
    e.preventDefault();
    e.stopPropagation();          // the tick is not the row's link
    var key = tick.getAttribute('data-seen');
    markSeen(key, !has(seen, key));
  });
  if (muteBtn) muteBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    setMuted(!muted());
    if (!muted()) ring();           // so the office hears what it just switched back on
  });
  // a tap anywhere else closes the panel (the bell itself is the only thing that opens it).
  // A tap on a ROW's link (the page that deals with it) also closes it, so the office comes back
  // to a bell that is exactly as they left it.
  document.addEventListener('click', function (e) {
    if (!isOpen()) return;
    var inside = dock.contains(e.target);
    var rowLink = e.target && e.target.closest && e.target.closest('.od-row-main');
    if (!inside || rowLink) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) close();
  });

  setTimeout(check, 700);
  setInterval(check, EVERY);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', function (e) { if (e.persisted) check(); });
})();
