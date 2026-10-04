/* ============================================================
   Parent app notifications — loaded on every parent page.

   While the app is open it asks the school every 20 seconds:
   "is there anything new for me?". When the school office sends
   something (fee paid, notice, result, PTM invite) the parent gets:

     app is open    →  a loud three-note bell (no audio file —
                       Web Audio, played through a limiter so it is
                       loud AND clean) + a small double vibration
                       + a bright card that slides down from the top
                       and can be swiped left or right to dismiss
     app in the
     background     →  a real notification on the phone itself
                       (status bar, with its own sound), which
                       opens the right page when tapped

   The little red badge on Inbox always updates at once, and the
   same news never pops up twice on the same phone.
   ============================================================ */
(function () {
  'use strict';

  var FEED = '/parent/alerts.json';
  var EVERY = 20000;                 // ask the school every 20 seconds
  var SEEN_KEY = 'vvsSeenAlerts';    // ids already announced on this phone
  var ASK_KEY = 'vvsNotifyAsked';    // the "turn on notifications" prompt
  var CARD_MS = 15000;               // how long a pop-up card stays
  var MAX_CARDS = 3;                 // desktop may stack a few

  // a phone screen is small — one card, with the rest counted inside it
  function maxCards() { return window.innerWidth <= 640 ? 1 : MAX_CARDS; }

  var seen = loadSeen();
  var firstRun = true;
  var busy = false;

  /* ---------------- which ids we already showed ---------------- */
  function loadSeen() {
    try {
      var raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function saveSeen() {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-80))); } catch (e) {}
  }
  function isSeen(key) { return seen.indexOf(key) !== -1; }
  function markSeen(key) { if (!isSeen(key)) { seen.push(key); saveSeen(); } }
  function ls(k, v) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ============================================================
     SOUND — a loud, clean, three-note bell
     ============================================================ */
  var audioCtx = null;
  var master = null;

  function ensureCtx() {
    if (audioCtx) return audioCtx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; return null; }

    // a limiter on the way out: the bell can be turned up loud without
    // crackling when two notes land on top of each other
    try {
      var limiter = audioCtx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 6;
      limiter.ratio.value = 16;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      master = audioCtx.createGain();
      master.gain.value = 1;
      limiter.connect(master);
      master.connect(audioCtx.destination);
      master = limiter;
    } catch (e) {
      master = audioCtx.destination;
    }
    return audioCtx;
  }

  // a tap / keypress is what lets a phone play sound afterwards
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      var ac = ensureCtx();
      if (ac && ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    }, { passive: true });
  });

  // one warm bell note: the note itself + a quieter octave below for body
  function note(ac, freq, at, peak) {
    [1, 0.5].forEach(function (mul, layer) {
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = layer ? 'sine' : 'triangle';
      osc.frequency.value = freq * (layer ? 0.5 : 1);
      var amp = peak * (layer ? 0.42 : 1);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(amp, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + (layer ? 1.05 : 0.8));
      osc.connect(gain);
      gain.connect(master);
      osc.start(at);
      osc.stop(at + 1.1);
    });
  }

  // E5 → B5 → E6, twice in quick succession: impossible to miss, still pleasant
  function ring() {
    var ac = ensureCtx();
    if (!ac) return;
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    if (ac.state !== 'running') return;         // phone is still locked for audio

    var now = ac.currentTime + 0.02;
    [0, 0.62].forEach(function (delay, round) {
      [659.25, 987.77, 1318.51].forEach(function (freq, i) {
        note(ac, freq, now + delay + i * 0.15, round ? 0.5 : 0.62);
      });
    });
  }

  // a small double buzz — phones only buzz after the parent has touched the app
  function buzz() {
    try {
      if (!navigator.vibrate) return;
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      navigator.vibrate([120, 70, 120, 70, 180]);
    } catch (e) {}
  }

  /* ============================================================
     REAL PHONE NOTIFICATIONS (when the app is in the background)

     Two ways, chosen once per page load:
       • inside the school's own APK → the app's native bridge
         (SchoolBridge.notify), because a WebView has no Notification API;
       • everywhere else → the service-worker notification.
     ============================================================ */
  var inApk = (function () {
    try { return !!(window.SchoolBridge && typeof window.SchoolBridge.notify === 'function'); }
    catch (e) { return false; }
  })();

  var askShown = false;

  function notifSupported() {
    if (inApk) return true;             // the bridge below IS the notification on Android
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return false;
    // iPhone only delivers notifications to the app once it is on the home screen
    var ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    var installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    return ios ? installed : true;
  }

  /** has this phone been allowed to ring at all? (the APK answers through the bridge) */
  function notifyAllowed() {
    if (inApk) {
      try { return window.SchoolBridge.notificationState() === 'granted'; } catch (e) { return false; }
    }
    try { return 'Notification' in window && Notification.permission === 'granted'; }
    catch (e) { return false; }
  }

  function showOnPhone(title, body, url, tag) {
    if (inApk) {
      try { window.SchoolBridge.notify(title, body); } catch (e) {}
      return;
    }
    var opts = {
      body: body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: tag || 'vvs',
      renotify: false,
      vibrate: [150, 70, 150],
      data: { url: url || '/parent' },
    };
    try {
      return navigator.serviceWorker.ready.then(function (reg) {
        try { return reg.showNotification(title, opts); }
        catch (e) { return legacyNotification(title, opts); }
      }).catch(function () { legacyNotification(title, opts); });
    } catch (e) {
      return Promise.resolve(legacyNotification(title, opts));
    }
  }

  // old desktop browsers without a service-worker notification
  function legacyNotification(title, opts) {
    try { new Notification(title, opts); } catch (e) {}
  }

  function notifyOnPhone(items) {
    if (!notifSupported() || !notifyAllowed()) return;
    var newest = items[0];
    var title = items.length > 1
      ? items.length + ' new updates from the school'
      : newest.subject;
    var body = items.length > 1
      ? newest.subject + ' — and ' + (items.length - 1) + ' more. Tap to open.'
      : preview(newest.body);
    showOnPhone(title, body, newest.href, 'vvs-' + newest.key);
  }

  /* the one-time "turn on notifications" prompt — the APK asks through its bridge,
     every other phone asks through the browser */
  function askToNotify() {
    if (askShown || !notifSupported()) return;
    if (!inApk && ('Notification' in window) && Notification.permission !== 'default') return;
    if (inApk) {
      var st = 'ask';
      try { st = window.SchoolBridge.notificationState() || 'ask'; } catch (e) {}
      if (st !== 'ask') return;              // granted → nothing to ask; off → Android refuses to ask again
    }
    if (ls(ASK_KEY) === '1') return;
    askShown = true;

    var box = document.createElement('div');
    box.className = 'vvs-ask';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Turn on notifications');
    box.innerHTML =
      '<span class="vvs-ask-ico">🔔</span>' +
      '<span class="vvs-ask-text"><b>Turn on school updates</b>' +
      '<small>Get a notification on this phone even when the app is in the background.</small></span>' +
      '<button type="button" class="vvs-ask-yes">Turn on</button>' +
      '<button type="button" class="vvs-ask-x" aria-label="Not now">✕</button>';
    document.body.appendChild(box);
    requestAnimationFrame(function () { box.classList.add('in'); });

    function drop() {
      box.classList.remove('in');
      setTimeout(function () { box.remove(); }, 300);
    }

    box.querySelector('.vvs-ask-x').addEventListener('click', function () {
      lsSet(ASK_KEY, '1');
      drop();
    });

    // the tap is what the browser needs before it will ask (in the APK the phone asks)
    box.querySelector('.vvs-ask-yes').addEventListener('click', function () {
      lsSet(ASK_KEY, '1');
      if (inApk) {
        try { window.SchoolBridge.askNotifications(); } catch (e) {}
        drop();
        return;
      }
      try {
        Notification.requestPermission().then(function (p) {
          if (p === 'granted') {
            showOnPhone('Notifications are on ✅', 'You will now get school updates on this phone — even in the background.', '/parent', 'vvs-welcome');
          }
        }).catch(function () {});
      } catch (e) {}
      drop();
    });
  }

  /* ============================================================
     THE POP-UP CARD (swipe left or right to dismiss)
     ============================================================ */
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
    // the school runs on IST — format in that zone, never the phone's
    return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  }

  function parseTime(iso) {
    var s = String(iso || '').replace(' ', 'T');
    if (s.indexOf('Z') === -1 && s.indexOf('+') === -1) s += 'Z';   // stored as UTC
    var t = new Date(s);
    return isNaN(t.getTime()) ? null : t;
  }

  // did this arrive in the last few minutes? (only then is a sound worth it)
  function recent(iso) {
    var t = parseTime(iso);
    return !!t && Date.now() - t.getTime() < 6 * 60 * 1000;
  }

  function wrapEl() {
    var w = document.getElementById('vvsNotifyWrap');
    if (!w) {
      w = document.createElement('div');
      w.id = 'vvsNotifyWrap';
      w.className = 'vvs-notify-wrap';
      w.setAttribute('role', 'region');
      w.setAttribute('aria-label', 'New from school');
      document.body.appendChild(w);
    }
    return w;
  }

  function card(item, more) {
    var w = wrapEl();
    var cap = maxCards();
    while (w.children.length >= cap) w.removeChild(w.firstChild);

    var el = document.createElement('div');
    el.className = 'vvs-notify';
    el.setAttribute('role', 'status');

    var icon = item.kind === 'notice' ? '📢' : (item.category === 'Fee' ? '₹' : '🔔');
    // only a MESSAGE has something to mark read — a notice has no unread state, so it gets
    // no ✓ Seen button (and, being unread-free, it never lit a badge in the first place)
    var canSeen = seenId(item) > 0;

    el.innerHTML =
      '<span class="vvs-notify-bar"></span>' +
      '<span class="vvs-notify-ico">' + icon + '</span>' +
      '<span class="vvs-notify-main">' +
        '<span class="vvs-notify-top">' +
          '<span class="vvs-notify-eyebrow">New from school</span>' +
          '<span class="vvs-notify-cat">' + esc(item.category) + '</span>' +
          '<span class="vvs-notify-time">' + esc(when(item.at)) + '</span>' +
        '</span>' +
        '<b class="vvs-notify-subject">' + esc(item.subject) + '</b>' +
        '<span class="vvs-notify-body">' + esc(preview(item.body)) + '</span>' +
        (more > 0 ? '<span class="vvs-notify-more">＋' + more + ' more new update' + (more === 1 ? '' : 's') + ' waiting in your inbox</span>' : '') +
        '<span class="vvs-notify-actions">' +
          '<a class="vvs-notify-open" href="' + esc(item.href) + '">Open now</a>' +
          (canSeen ? '<button type="button" class="vvs-notify-seen">✓ Seen</button>' : '') +
          '<span class="vvs-notify-hint">swipe ← → to dismiss</span>' +
          '<button type="button" class="vvs-notify-x" aria-label="Close">✕</button>' +
        '</span>' +
      '</span>';

    w.appendChild(el);
    // one frame later so the slide-in animation runs
    requestAnimationFrame(function () { el.classList.add('in'); });

    var gone = false;
    function close(dir) {
      if (gone) return;
      gone = true;
      if (dir) {
        el.style.transform = 'translateX(' + (dir * (el.offsetWidth + 40)) + 'px)';
        el.style.opacity = '0';
      } else {
        el.classList.remove('in');
      }
      setTimeout(function () { el.remove(); }, 340);
    }
    el.querySelector('.vvs-notify-x').addEventListener('click', function () { close(0); });
    el.querySelector('.vvs-notify-open').addEventListener('click', function () { close(0); });
    // ✓ Seen: this one message is read on the school's side and the badge drops by one —
    // the card closes itself, because there is nothing left to do with it.
    var seenBtn = el.querySelector('.vvs-notify-seen');
    if (seenBtn) {
      seenBtn.addEventListener('click', function () {
        if (seenBtn.disabled) return;
        seenBtn.disabled = true;
        seenBtn.textContent = '✓ Seen';
        markItemSeen(item, function () { close(0); });
      });
    }
    setTimeout(function () { close(0); }, CARD_MS);

    swipeToDismiss(el, close);
  }

  // drag the card left or right with a finger; let go past 80px and it flies away
  function swipeToDismiss(el, close) {
    var x0 = 0, y0 = 0, dx = 0, dragging = false, decided = false, horizontal = false;

    el.style.touchAction = 'pan-y';

    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true; decided = false; horizontal = false;
      x0 = e.clientX; y0 = e.clientY; dx = 0;
      el.classList.add('dragging');
    });

    el.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var mx = e.clientX - x0;
      var my = e.clientY - y0;

      if (!decided) {
        if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
        decided = true;
        horizontal = Math.abs(mx) > Math.abs(my);   // vertical drag = scrolling, leave it alone
      }
      if (!horizontal) return;

      dx = mx;
      el.style.transform = 'translateX(' + dx + 'px)';
      el.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 220));
      try { e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); } catch (err) {}
    });

    function release() {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      if (!horizontal) return;
      if (Math.abs(dx) > 80) {
        el.style.transition = 'transform .28s ease, opacity .28s ease';
        close(dx > 0 ? 1 : -1);
      } else {
        el.style.transition = 'transform .22s ease, opacity .22s ease';
        el.style.transform = '';
        el.style.opacity = '';
        setTimeout(function () { el.style.transition = ''; }, 260);
      }
    }
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
  }

  function preview(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > 130 ? t.slice(0, 130) + '…' : t;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- the little red badge ---------------- */
  // Every inbox badge on the page: the sidebar, the bottom tab bar, the home
  // tile, and the bell on the child's card. The bell also rings + blinks while
  // the number is showing — and everything goes quiet on its own as soon as
  // the parent has seen it all (count 0).
  //
  // The number is what is still UNREAD, and it only ever comes from the school
  // (`/parent/alerts.json`, or the answer to “✓ Seen”). A badge past 99 would be a
  // three-digit blob on a small circle, so the DISPLAY is capped at “99+” while the
  // real number stays in the tooltip and in the accessible name — the count itself
  // is never faked.
  var BADGE_MAX = 99;
  function badgeText(count) {
    return count > BADGE_MAX ? BADGE_MAX + '+' : String(count);
  }
  function setBadges(count) {
    var els = document.querySelectorAll('[data-badge="parent-inbox"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (count > 0) {
        if (el.hidden) el.hidden = false;
        var text = badgeText(count);
        if (el.textContent.trim() !== text) {
          el.textContent = text;
          el.classList.remove('pop');
          void el.offsetWidth;             // restart the animation
          el.classList.add('pop');
        }
        el.setAttribute('title', count + ' unread message' + (count === 1 ? '' : 's') + ' from school');
      } else {
        el.hidden = true;
        el.textContent = '0';
        el.removeAttribute('title');
      }
      var bell = el.closest ? el.closest('.kid-bell') : null;
      if (bell) bell.classList.toggle('is-ringing', count > 0);
    }
  }

  /* ---------------- “✓ Seen” — one message, marked read ---------------- */
  // The school's rule (2026-09-21): the bell shows a number while something is
  // waiting, and it goes back to 0 once the parent has seen it — the number must
  // not keep growing. The pop-up card IS the parent seeing it, so the card carries
  // its own ✓ Seen button: it marks that ONE message read on the server and repaints
  // every badge from the number the server answers with. `item.key` is 'm<id>' for a
  // message (only messages have a read state — a notice has none, and keeps no badge).
  function seenId(item) {
    var m = /^m(\d+)$/.exec(String((item && item.key) || ''));
    return m ? Number(m[1]) : 0;
  }

  function markItemSeen(item, onDone) {
    var id = seenId(item);
    if (!id) { if (onDone) onDone(null); return; }
    fetch('/parent/messages/seen', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'id=' + encodeURIComponent(id),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && typeof data.unread === 'number') setBadges(data.unread);
        if (onDone) onDone(data);
      })
      .catch(function () { if (onDone) onDone(null); });
  }

  /* ============================================================
     THE LOOP
     ============================================================ */
  function check() {
    if (busy) return;
    busy = true;
    fetch(FEED, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        busy = false;
        if (!data || !data.items) return;

        var onInbox = /^\/parent\/messages/.test(location.pathname);
        setBadges(onInbox ? 0 : (Number(data.unread) || 0));

        // what the parent has not been told about yet on this phone
        var fresh = data.items.filter(function (it) { return !isSeen(it.key); });
        var wasFirstLook = firstRun;
        firstRun = false;

        // on the first look after opening the app, only talk about things that
        // are still unread — anything already dealt with is just remembered
        var talk = wasFirstLook ? fresh.filter(function (it) { return it.unread; }) : fresh;
        data.items.forEach(function (it) { markSeen(it.key); });
        if (!talk.length) return;

        // ---- app in the background: a real notification on the phone ----
        if (document.hidden) { notifyOnPhone(talk); return; }

        // ---- app on screen: bell + buzz + the card ----
        var loud = !wasFirstLook || talk.some(function (it) { return recent(it.at); });
        if (loud) { buzz(); ring(); }

        var show = talk.slice(0, maxCards()).reverse();
        var more = talk.length - show.length;
        show.forEach(function (it, i) { card(it, i === show.length - 1 ? more : 0); });
      })
      .catch(function () { busy = false; });
  }

  // after login / after a tap anywhere, keep an ear out
  setTimeout(function () {
    check();
    if (!/^\/parent\/messages/.test(location.pathname)) setTimeout(askToNotify, 3500);
  }, 900);
  setInterval(check, EVERY);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
  // coming back with the Back button restores a cached page — re-check at once
  window.addEventListener('pageshow', function (e) { if (e.persisted) check(); });
})();
