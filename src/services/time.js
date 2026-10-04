/**
 * ONE source of truth for dates and times: the school runs on IST (Asia/Kolkata).
 *
 * Why this file exists
 * --------------------
 * Every timestamp is written by SQLite as `datetime('now')`, which is **UTC**.
 * Node parses a bare `"2026-09-14 11:20:18"` as *local* time, so printing it
 * directly showed the office and parents a clock **5 hours 30 minutes behind**
 * (a message sent at 17:00 appeared as 11:20).
 *
 * Rules — always follow these:
 *   • STORE in UTC (SQLite's `datetime('now')`) — never change the schema for this.
 *   • DISPLAY in IST, only through the helpers here. Never call `toLocaleString()`
 *     on a raw DB value inside a view.
 *   • "Today" for the school means the IST day, not the UTC day and not the
 *     server's day — use `todayISO()` for that.
 *
 * Views get these for free through `res.locals` (see src/app.js):
 *   <%= fmtDateTime(row.created_at) %>   → 14 Sept, 5:20 PM
 *   <%= fmtDate(row.created_at) %>       → 14 Sept 2026
 *   <%= fmtDayDate(row.created_at) %>    → Monday, 14 September 2026
 *   <%= fmtShortDate(row.created_at) %>  → 14 Sept
 *   <%= fmtTime(row.created_at) %>       → 5:20 PM
 *   <%= fmtDMY(row.due_date) %>          → 14/09/2026  (fee dates are dd/mm/yyyy)
 *
 * The clock is the school's clock — always 12-hour with AM/PM, the way the
 * timetable already writes its period times ("8:40 AM"). Never a 24-hour time.
 */
const TZ = 'Asia/Kolkata';
const TZ_LABEL = 'IST';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;   // India: fixed +05:30, no daylight saving

/* ---------------- parsing ---------------- */

/**
 * Turn anything the database (or JSON) hands us into a real Date.
 * Handles UTC `"YYYY-MM-DD HH:MM:SS"`, ISO strings, date-only `"YYYY-MM-DD"`
 * and the dd/mm/yyyy strings used by the fee table.
 * Returns null for empty/invalid input so callers can show a dash.
 */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  const s = String(value).trim();

  // date only (UTC midnight — the IST calendar date is still the same day)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  // dd/mm/yyyy (fee due_date / paid_date)
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const d = new Date(`${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  // "YYYY-MM-DD HH:MM:SS" from SQLite is UTC and carries no marker — add one
  let iso = s.replace(' ', 'T');
  if (!/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/* ---------------- formatting (always IST) ---------------- */

const OPTS = {
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  dayDate: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  shortDate: { day: 'numeric', month: 'short' },
};

function fmt(value, opts, fallback = '—') {
  const d = toDate(value);
  if (!d) return fallback;
  return d.toLocaleString('en-GB', { timeZone: TZ, ...opts });
}

/**
 * "5:20 PM" — the school's clock, 12-hour with AM/PM.
 * en-GB would give 24-hour and "pm" in lower case, so the meridiem is upper-cased.
 */
function fmtTime(value, fallback = '—') {
  const d = toDate(value);
  if (!d) return fallback;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d);
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  const dayPeriod = (get('dayPeriod') || '').toUpperCase();
  return `${get('hour')}:${get('minute')} ${dayPeriod}`.trim();
}

/** "14 Sept, 5:20 PM" — the default for anything with a clock time. */
function fmtDateTime(value, fallback = '—') {
  const d = toDate(value);
  if (!d) return fallback;
  return `${fmt(d, OPTS.shortDate, fallback)}, ${fmtTime(d, fallback)}`;
}
/** "14 Sept 2026" */
const fmtDate = (v, fb = '—') => fmt(v, OPTS.date, fb);
/** "Monday, 14 September 2026" — page headers, "today is …" */
const fmtDayDate = (v, fb = '—') => fmt(v, OPTS.dayDate, fb);
/** "14 Sept" — compact lists, cards */
const fmtShortDate = (v, fb = '—') => fmt(v, OPTS.shortDate, fb);

/** "14/09/2026" — fee receipts/due dates, matches how due_date is stored */
function fmtDMY(v, fb = '—') {
  const p = istParts(v);
  if (!p) return fb;
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}/${p.year}`;
}
/**
 * "14/09/2026 4:50 PM" — a full stamp for text that leaves the app
 * (WhatsApp/SMS/email bodies), in the same 12-hour style as the screens.
 */
function fmtFullIST(v = new Date(), fb = '—') {
  const d = toDate(v);
  if (!d) return fb;
  return `${fmtDMY(d, fb)} ${fmtTime(d, '')}`.trim();
}

/* ---------------- "now" and "today" in IST ---------------- */

/** IST wall-clock parts of a moment (whatever timezone the server itself is in). */
function istParts(value = new Date()) {
  const d = toDate(value);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const get = t => {
    const p = parts.find(x => x.type === t);
    return p ? parseInt(p.value, 10) : 0;
  };
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour') % 24, minute: get('minute'), second: get('second'),
  };
}

/**
 * A Date whose LOCAL getters return IST wall-clock values.
 * Use it for weekday/date arithmetic (timetable week strip, "is today", …) so
 * the answer is the same whether the server runs in IST, UTC or anywhere else.
 */
function istNow(value = new Date()) {
  const p = istParts(value);
  if (!p) return null;
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/**
 * UTC midnight of the school's (IST) calendar date.
 * Use it for date arithmetic that must not depend on the server's timezone —
 * read and step it with the UTC accessors only.
 */
function istDayAnchor(value = new Date()) {
  const p = istParts(value);
  return p ? new Date(Date.UTC(p.year, p.month - 1, p.day)) : null;
}

/** The school's current year (IST) — footers, "© 2026", application numbers. */
function yearIST(value = new Date()) {
  const p = istParts(value);
  return p ? p.year : new Date().getFullYear();
}

/**
 * UTC bounds of the IST calendar day, as SQLite timestamps.
 * Use it to count "today's" rows in a table that stores UTC:
 *   WHERE created_at >= ? AND created_at < ?   →  istDayBoundsUTC()
 * (India has no daylight saving, so a fixed +05:30 is exact.)
 */
function istDayBoundsUTC(value = new Date()) {
  const p = istParts(value);
  const start = Date.UTC(p.year, p.month - 1, p.day) - IST_OFFSET_MS;
  const toSql = t => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
  return { from: toSql(start), to: toSql(start + 24 * 60 * 60 * 1000) };
}

/** The school's current date as 'YYYY-MM-DD' (IST). */
function todayISO(value = new Date()) {
  const p = istParts(value);
  if (!p) return '';
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * 'YYYY-MM-DD' (what an `<input type="date">` posts) → 'DD/MM/YYYY' (how this
 * app stores dates). Used by the fee receipts, whose `paid_on` column shares the
 * due_date format. An unusable value comes back as today on the school's day.
 */
function dmyFromISO(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return todayDMY();
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** The school's today as 'DD/MM/YYYY' */
function todayDMY(value = new Date()) {
  const p = istParts(value);
  if (!p) return '';
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}/${p.year}`;
}

module.exports = {
  TZ, TZ_LABEL,
  toDate, istParts, istNow, istDayAnchor, todayISO, todayDMY, dmyFromISO, istDayBoundsUTC, yearIST,
  fmtDateTime, fmtDate, fmtDayDate, fmtShortDate, fmtTime, fmtDMY, fmtFullIST,
  // the generic formatter the named helpers are built on — exported for a date that needs
  // options of its own (the exam date-sheet's "Mon 22 Sep" day label uses it). Everything
  // it returns is INST, and a clock time must still go through fmtTime/fmtDateTime.
  fmt,
};
