/**
 * ============================================================================
 * weather.js — the sky over Demo Town, Demo Town, and the clock that goes with it
 * ============================================================================
 *
 * The school asked for the sign-in screen to show its own place: what the weather is doing
 * today, the next few days, and the time in the school's own clock (IST — `services/time.js`
 * owns dates and times everywhere else in this portal).
 *
 * **Why Open-Meteo** (`api.open-meteo.com`): it is free, needs no API key, no sign-up and no
 * billing, it answers in JSON, and it reports in the place's own timezone. That is the same
 * kind of outbound call the WhatsApp/SMS gateways already make, so it adds no new kind of
 * dependency. One request every 15 minutes is enough for the whole school.
 *
 * **The rule: a village without internet must still get the sign-in screen.** Nothing here
 * ever throws at its caller.
 *
 *   - `get()`  always answers at once. Before the first forecast it answers `ok:false`, and it
 *               kicks off a background refresh so the next visitor sees real data.
 *   - A failed refresh **keeps the last good forecast** and marks it `stale`, rather than
 *               blanking a page that was fine a minute ago.
 *   - The clock on the page is ticked by the browser from `serverNow` (this server's clock,
 *               in IST), so time keeps moving even with the forecast switched off.
 *   - Only ONE request is ever in the air, however many phones ask for it at the same moment.
 *
 * Used by `GET /weather.json` (`src/routes/public.js`) and drawn by
 * `public/js/login-weather.js` in the strip at the bottom of `views/login.ejs`.
 *
 *   node -e "require('./src/services/weather').prime().then(w=>console.log(w))"
 */
const config = require('../config');

const place = config.place;

const API = 'https://api.open-meteo.com/v1/forecast';
const TTL_MS = 15 * 60 * 1000;     // a forecast older than this is refreshed
const TIMEOUT_MS = 6000;           // a slow gateway must never hold the page
const FORECAST_DAYS = 6;           // today + the next five

// The WMO code the forecast carries → the words and the picture a parent reads in one look.
// The words are deliberately the plain ones a school notice would use (no "cumulonimbus").
const CODES = {
  0: ['Clear sky', '☀️'],
  1: ['Mainly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Cloudy', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Drizzle', '🌦️'],
  55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'],
  57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'],
  63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'],
  73: ['Snow', '🌨️'],
  75: ['Heavy snow', '🌨️'],
  77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'],
  81: ['Showers', '🌧️'],
  82: ['Heavy showers', '🌧️'],
  85: ['Snow showers', '🌨️'],
  86: ['Snow showers', '🌨️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm with hail', '⛈️'],
  99: ['Thunderstorm with hail', '⛈️'],
};
// A code nobody has seen before still has to print something honest.
const UNKNOWN = ['Weather', '🌡️'];

/** A WMO code as a picture + plain words. Unknown codes get a safe, honest answer. */
function describe(code) {
  const n = Number(code);
  const hit = CODES[Math.round(n)];
  return { code: Number.isFinite(n) ? n : null, label: hit ? hit[0] : UNKNOWN[0], icon: hit ? hit[1] : UNKNOWN[1] };
}

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
};

let cache = null;      // the last GOOD forecast — kept even after it goes stale
let fetchedAt = 0;     // when it arrived (ms)
let inFlight = null;   // the one request currently in the air, shared by everyone

/**
 * Ask Open-Meteo once. Never rejects: on any failure (no internet, slow answer, junk
 * payload, a school server with no outbound route) it resolves with what we already had —
 * or `null` when there has never been a good forecast.
 */
async function refresh() {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const url = `${API}?latitude=${place.lat}&longitude=${place.lon}`
      + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min'
      + `&timezone=${encodeURIComponent(place.timezone)}&forecast_days=${FORECAST_DAYS}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error('forecast answered ' + res.status);
      const j = await res.json();
      if (!j || !j.current || !j.daily || !(j.daily.time || []).length) throw new Error('forecast was not readable');

      const cur = j.current;
      const days = j.daily.time.slice(0, FORECAST_DAYS).map((date, i) => ({
        date,
        ...describe(j.daily.weather_code[i]),
        maxC: num(j.daily.temperature_2m_max[i]),
        minC: num(j.daily.temperature_2m_min[i]),
      }));

      cache = {
        ok: true,
        localTime: cur.time || null,          // the place's own clock, from the API
        now: {
          tempC: num(cur.temperature_2m),
          feelsC: num(cur.apparent_temperature),
          humidity: num(cur.relative_humidity_2m),
          windKph: num(cur.wind_speed_10m),
          ...describe(cur.weather_code),
        },
        days,
      };
      fetchedAt = Date.now();
      return cache;
    } catch (e) {
      // Silent on purpose: the office does not want a broken widget to fill the log every
      // 15 minutes. `get()`/`prime()` already tell the page the truth (`ok:false`/`stale`).
      return cache;
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * The payload the page asks for. Always answers immediately; if the forecast on hand is
 * missing or older than 15 minutes it starts a refresh in the background and returns what
 * it has (marked `stale`). `serverNow` is the anchor the browser ticks its clock from.
 */
function get() {
  const age = cache ? Date.now() - fetchedAt : null;
  const needsRefresh = !cache || age > TTL_MS;
  if (needsRefresh) refresh();          // fire and forget — the caller is answered now

  return {
    ok: !!(cache && cache.ok),
    stale: !!(cache && needsRefresh),
    ageMs: age,
    serverNow: Date.now(),
    place: { label: place.label, district: place.district, timezone: place.timezone },
    localTime: cache ? cache.localTime : null,
    now: cache ? cache.now : null,
    days: cache ? cache.days : [],
  };
}

/**
 * The same payload, but a FIRST visitor waits for the very first forecast (up to 6 seconds)
 * instead of being told "no weather". Every later visit answers from the cache at once.
 */
async function prime() {
  if (!cache) await refresh();
  return get();
}

module.exports = { describe, get, prime, refresh, place };
