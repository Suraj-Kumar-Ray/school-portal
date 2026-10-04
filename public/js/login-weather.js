/* ============================================================================
   login-weather.js — the sky over the school, and the school's clock
   ----------------------------------------------------------------------------
   Fills the strip at the bottom of the sign-in screen:

       ⛅  27°C  Partly cloudy        DEMO TOWN        🕐 4:38 PM IST
       [Today] [Fri] [Sat] [Sun] [Mon] [Tue]   (each with its picture and hi/lo)

   Two rules decide how this is written:

   1. **The clock belongs to the school, not to the phone.** A village phone's clock can be
      minutes (or months) out, so the time is anchored on `serverNow` from /weather.json and
      then ticked forward locally. `Date.now()` is only used to measure how long ago the
      answer arrived. IST is a fixed +05:30 offset, worked out with `getUTC*` — this file
      never calls a locale formatter, exactly like the rest of the project.
   2. **No internet is not an error.** If /weather.json cannot be reached the row is still
      shown with the place and the ticking clock, and the forecast part is simply left out.
      The school's phone, email, hours and address sit right below it either way.

   No framework, no build step: the same plain style as the other scripts in /js.
   ============================================================================ */
(function () {
  'use strict';

  var row = document.getElementById('loginWeather');
  if (!row) return;

  var elIcon = document.getElementById('lwIcon');
  var elTemp = document.getElementById('lwTemp');
  var elCond = document.getElementById('lwCond');
  var elClock = document.getElementById('lwClock');
  var elDays = document.getElementById('lwDays');

  var IST_OFFSET_MS = 330 * 60 * 1000;                 // the school's +05:30
  var WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var anchor = Date.now();        // when we started counting (phone's own clock)
  var serverNow = Date.now();     // the school server's clock at that same moment

  // ---- the clock ----------------------------------------------------------
  // A plain 12-hour clock (the whole portal prints 4:38 PM, never 16:38).
  function clockText(ms) {
    var d = new Date(ms + IST_OFFSET_MS);
    var h = d.getUTCHours();
    var m = d.getUTCMinutes();
    var ampm = h < 12 ? 'AM' : 'PM';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + (m < 10 ? '0' + m : m) + ' ' + ampm;
  }

  function tick() {
    if (elClock) elClock.textContent = clockText(serverNow + (Date.now() - anchor));
  }

  // ---- the forecast -------------------------------------------------------
  function dayLabel(dateISO, index) {
    if (index === 0) return 'Today';
    var d = new Date(dateISO + 'T00:00:00Z');         // the date as the API gave it
    return isNaN(d.getTime()) ? '' : WEEK[d.getUTCDay()];
  }

  function fillDays(days) {
    if (!elDays || !days || !days.length) return;
    var html = '';
    for (var i = 0; i < days.length; i++) {
      var d = days[i] || {};
      var hi = d.maxC === null || d.maxC === undefined ? '—' : Math.round(d.maxC) + '°';
      var lo = d.minC === null || d.minC === undefined ? '—' : Math.round(d.minC) + '°';
      html += '<span class="lw-day">'
        + '<b>' + dayLabel(d.date, i) + '</b>'
        + '<i aria-hidden="true">' + (d.icon || '') + '</i>'
        + '<small>' + hi + ' <u>' + lo + '</u></small>'
        + '</span>';
    }
    elDays.innerHTML = html;
  }

  function showWeather(data) {
    var now = data.now || {};
    if (elIcon) elIcon.textContent = now.icon || '🌡️';
    if (elTemp) elTemp.textContent = (now.tempC === null || now.tempC === undefined) ? '—' : Math.round(now.tempC) + '°C';
    if (elCond) {
      var bits = [];
      if (now.label) bits.push(now.label);
      if (now.humidity !== null && now.humidity !== undefined) bits.push(now.humidity + '% humidity');
      elCond.textContent = bits.join(' · ');
    }
    fillDays(data.days);
  }

  // Show the row as soon as this script runs: the place and the ticking clock are always
  // worth having, even when the forecast never arrives.
  row.hidden = false;
  tick();
  setInterval(tick, 1000);

  var stop = null;
  try {
    if (window.AbortController) {
      stop = new AbortController();
      setTimeout(function () { stop.abort(); }, 8000);   // never leave a request hanging
    }
  } catch (e) { stop = null; }

  fetch('/weather.json', { signal: stop ? stop.signal : undefined, cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      // the school's clock wins over the phone's
      if (typeof data.serverNow === 'number') { serverNow = data.serverNow; anchor = Date.now(); }
      tick();
      if (data.ok && data.now) showWeather(data);
    })
    .catch(function () { /* offline: the clock keeps ticking, no forecast shown */ });
})();
