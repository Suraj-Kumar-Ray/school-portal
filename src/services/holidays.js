/**
 * ============================================================================
 * holidays.js — the days the school is SHUT, named out loud
 * ============================================================================
 *
 * School's request (2026-09-17): *“Suppose today is Vishwakarma Puja — the school should be
 * able to update it, and the timetable should show a holiday and ‘Happy Vishwakarma Puja’.”*
 *
 * Sunday has always been a holiday (the timetable grows its own Sunday chip). This is every
 * OTHER day off: a festival, a local bandh, a school function, the summer or winter break.
 * One row per DATE, and every screen reads that row through this file — the parent's
 * timetable, a teacher's, the office's list and the message parents receive.
 *
 * RULES
 *   • A holiday belongs to a DATE on the school's own (IST) calendar, never to “today”, so
 *     tomorrow's card is right even when the server runs in another timezone.
 *   • Sunday needs no row: `isClosed()` answers true for it anyway. The screens must never
 *     show two different reasons for the same day.
 *   • A holiday is school-wide (a village school's festival is not per-class). `classes`
 *     was left out on purpose — if that is ever needed it belongs in a new column, not in a
 *     view's `if`.
 *   • Nothing here is deleted by time: a past holiday stays in the list (the office can see
 *     what was declared, and the year's card keeps its history). The screens only SHOW
 *     today and the coming ones.
 */
const db = require('../db');
const config = require('../config');
const time = require('./time');

const NAME_MAX = 60;          // “Vishwakarma Puja”
const GREETING_MAX = 80;      // “Happy Vishwakarma Puja!”
const NOTE_MAX = 300;         // the sentence a parent may need

/**
 * One row, cleaned — nothing here is ever undefined.
 * Accepts BOTH shapes on purpose: a raw database row (`holiday_date`) and an already cleaned
 * one (`date`). `tellMessage` is called with either (the route passes the row it just read),
 * and a second pass through here must not blank the date out.
 */
function clean(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: String(row.holiday_date || row.date || ''),
    name: String(row.name || '').trim(),
    greeting: String(row.greeting || '').trim(),
    note: String(row.note || '').trim(),
    created_at: row.created_at || '',
  };
}

/** “Friday, 17 September 2026” — the long label every screen and message uses. */
function dayLong(dateStr) {
  return time.fmt(dateStr, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
/** “Fri 17 Sep” — for a chip or a list. */
function dayShort(dateStr) {
  return time.fmt(dateStr, { weekday: 'short', day: 'numeric', month: 'short' });
}
/** “17 September 2026” */
function dayFull(dateStr) {
  return time.fmt(dateStr, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Is this a real calendar date (YYYY-MM-DD)? Blank and “2026-13-40” are not. */
function isDate(value) {
  const s = String(value == null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return !!time.toDate(s);
}

/** Whole days from `today` to `date` — negative for a day that has gone. */
function daysAway(dateStr, now) {
  const today = time.toDate(time.todayISO(now));
  const d = time.toDate(dateStr);
  if (!today || !d) return null;
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

/** The ISO date of a plain Date/ISO value (the one place a date becomes a key). */
function isoOf(value) {
  return isDate(value) ? String(value).trim() : time.todayISO(value);
}

// ---------- reading ----------

/** Every holiday between two dates (both included), date order. Blank = no bound. */
function list({ from = '', to = '' } = {}) {
  const where = [];
  const args = [];
  if (isDate(from)) { where.push('holiday_date >= ?'); args.push(from); }
  if (isDate(to)) { where.push('holiday_date <= ?'); args.push(to); }
  const sql = 'SELECT * FROM holidays'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY holiday_date';
  return db.prepare(sql).all(...args).map(clean);
}

/** Today and everything after it, nearest first. Past holidays are not “upcoming”. */
function upcoming({ now = new Date(), limit = 0 } = {}) {
  const rows = db.prepare('SELECT * FROM holidays WHERE holiday_date >= ? ORDER BY holiday_date')
    .all(time.todayISO(now)).map(clean);
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/** The holidays that have gone, newest first — the office's history. */
function past({ now = new Date(), limit = 0 } = {}) {
  const rows = db.prepare('SELECT * FROM holidays WHERE holiday_date < ? ORDER BY holiday_date DESC')
    .all(time.todayISO(now)).map(clean);
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/** The holiday declared for ONE date, or null. Sundays have no row — see `isClosed`. */
function on(date) {
  return clean(db.prepare('SELECT * FROM holidays WHERE holiday_date = ?').get(isoOf(date)));
}

/** Is this date a Sunday (the weekly holiday)? */
function isSunday(date) {
  const d = time.toDate(isoOf(date));
  return !!d && d.getUTCDay() === 0;
}

/**
 * Is the school closed on this date? Sunday, or a declared holiday.
 * This is the ONE question the timetable asks — do not answer it anywhere else.
 */
function isClosed(date, { now = new Date() } = {}) {
  return isSunday(date) || !!on(date ?? time.todayISO(now));
}

/**
 * Everything a timetable needs about the day on screen, in one object:
 *
 *   { date, name, greeting, note, id, isSunday, isToday, isClosed, holiday }
 *
 * `name` is 'Sunday' on a Sunday with no row, so a card can always print a reason.
 */
function dayState(date, { now = new Date() } = {}) {
  const iso = isoOf(date);
  const holiday = on(iso);
  const sunday = isSunday(iso);
  const today = time.todayISO(now);
  return {
    date: iso,
    holiday,
    id: holiday ? holiday.id : 0,
    isSunday: sunday,
    isToday: iso === today,
    isClosed: sunday || !!holiday,
    name: holiday ? holiday.name : (sunday ? 'Sunday' : ''),
    greeting: holiday ? holiday.greeting : '',
    note: holiday ? holiday.note : '',
    long: dayLong(iso),
    short: dayShort(iso),
  };
}

/** Today's answer (what the parent sees the moment the app opens). */
function today({ now = new Date() } = {}) {
  return dayState(time.todayISO(now), { now });
}

/**
 * The same answer for a whole strip of days: each day object from
 * `services/timetable.js weekStrip()/sundayOfWeek()` gets its `iso`, its `holiday` (or
 * null) and `isClosed` — so a view never looks anything up, it only prints.
 */
function mark(days, { now = new Date() } = {}) {
  const todayIso = time.todayISO(now);
  return (Array.isArray(days) ? days : [days]).filter(Boolean).map((d) => {
    const iso = d.iso || '';
    const state = iso ? dayState(iso, { now }) : null;
    return {
      ...d,
      iso,
      isToday: !!d.isToday || (!!iso && iso === todayIso),
      holiday: state ? state.holiday : null,
      isClosed: state ? state.isClosed : false,
      holidayName: state ? state.name : '',
    };
  });
}

/**
 * The next day the school is OPEN, walking forward from `from` (default: today).
 * Sundays and every declared holiday are skipped — “the school opens again on …” has to be
 * true on a Friday before a long weekend, not just on a Sunday.
 */
function nextOpenDay({ from = '', now = new Date() } = {}) {
  const start = isDate(from) ? from : time.todayISO(now);
  const anchor = time.toDate(start);
  if (!anchor) return null;
  for (let i = 1; i <= 45; i++) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    if (isClosed(iso, { now })) continue;
    return {
      date: iso,
      name: d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }),
      long: dayLong(iso),
      isTomorrow: i === 1,
      after: i - 1,
    };
  }
  return null;
}

/** “Today” / “Tomorrow” / “in 4 days” / “3 days ago” — the line under a date. */
function whenLabel(iso, now = new Date()) {
  const gap = daysAway(iso, now);
  if (gap === null) return '';
  if (gap === 0) return 'Today';
  if (gap === 1) return 'Tomorrow';
  if (gap === -1) return 'Yesterday';
  if (gap > 1) return `In ${gap} days`;
  return `${Math.abs(gap)} days ago`;
}

// ---------- writing (the office's screen) ----------

/**
 * Create or update the holiday of a date. One date = one row (`UNIQUE(holiday_date)`), so
 * saving the same date twice corrects it instead of declaring two holidays on one day.
 */
function save({ id = 0, date, name, greeting = '', note = '' }) {
  const iso = String(date == null ? '' : date).trim();
  if (!isDate(iso)) return { ok: false, error: 'Please pick a date for the holiday.' };
  const label = String(name == null ? '' : name).trim().slice(0, NAME_MAX);
  if (!label) return { ok: false, error: 'Please give the holiday a name (for example “Vishwakarma Puja”).' };
  const greet = String(greeting == null ? '' : greeting).trim().slice(0, GREETING_MAX);
  const body = String(note == null ? '' : note).trim().slice(0, NOTE_MAX);

  const pid = parseInt(id, 10) || 0;
  const clash = db.prepare('SELECT id FROM holidays WHERE holiday_date = ? AND id <> ?').get(iso, pid);
  if (clash) return { ok: false, error: `${dayFull(iso)} is already marked a holiday.`, id: clash.id };

  if (pid) {
    const found = db.prepare('SELECT id FROM holidays WHERE id = ?').get(pid);
    if (!found) return { ok: false, error: 'That holiday was already removed — please add it again.' };
    db.prepare('UPDATE holidays SET holiday_date = ?, name = ?, greeting = ?, note = ? WHERE id = ?')
      .run(iso, label, greet, body, pid);
    return { ok: true, id: pid, updated: true };
  }
  const r = db.prepare('INSERT INTO holidays (holiday_date, name, greeting, note) VALUES (?,?,?,?)')
    .run(iso, label, greet, body);
  return { ok: true, id: r.lastInsertRowid, updated: false };
}

/** Take a holiday off. Returns true when there really was one. */
function remove(id) {
  return db.prepare('DELETE FROM holidays WHERE id = ?').run(parseInt(id, 10) || 0).changes > 0;
}

// ---------- the message parents receive ----------

/**
 * The message the office sends when a holiday is declared (portal message + SMS/WhatsApp).
 * Plain English, warm, and it names the day the school opens again — the one thing a
 * parent with a job actually needs.
 */
function tellMessage(holiday, { now = new Date() } = {}) {
  const h = clean(holiday);
  if (!h) return null;
  const next = nextOpenDay({ from: h.date, now });
  const lines = [
    h.greeting ? `${h.greeting} 🎉` : `🎉 Holiday: ${h.name}`,
    `The school stays closed on ${dayLong(h.date)} (${h.name}).`,
    h.note ? `\n${h.note}` : '',
    next ? `\nThe school opens again on ${next.long}.` : '',
    '\n— ' + config.schoolName,
  ].filter(Boolean);
  return {
    category: 'Holiday',
    subject: `🎉 ${h.name} — school closed on ${dayShort(h.date)}`.slice(0, 120),
    body: lines.join('\n').slice(0, 2000),
    name: h.name,
    date: h.date,
    dateLong: dayLong(h.date),
    opensOn: next ? next.long : '',
  };
}

module.exports = {
  NAME_MAX, GREETING_MAX, NOTE_MAX,
  isDate, daysAway, whenLabel, dayLong, dayShort, dayFull,
  list, upcoming, past, on, isSunday, isClosed, dayState, today, mark, nextOpenDay,
  save, remove, tellMessage,
};
