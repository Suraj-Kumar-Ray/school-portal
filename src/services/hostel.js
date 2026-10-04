/**
 * ============================================================================
 * hostel.js — THE HOSTEL ITSELF: mess menu, daily routine, and who boards
 * ============================================================================
 *
 * A hostel parent asks three things the day scholar's parent never does:
 *
 *   • **what is my child eating today?** → the weekly mess MENU (`hostel_menu`),
 *   • **how does his day go?**            → the daily ROUTINE (`hostel_routine`),
 *   • **who is with him?**                → the roster of boarders (from the
 *     `students.stay` column, read through `stay.js`).
 *
 * Everything here is admin-editable on **Admin → Hostel** (fits a phone: one card
 * per day for the menu, one row per entry for the routine) and read by the parent
 * app on `/parent/hostel` — which opens for a BOARDER only. A day scholar's parent
 * never sees any of it, because `parent_access.js` closes that section for a child
 * who is not in the hostel (see `forChild`).
 *
 * The days are the school's own (Monday → Sunday) and today is the SCHOOL's today
 * (IST), the same anchor the timetable uses, so "today's meals" can never point at
 * the wrong day on a server running in another timezone.
 *
 * What this file does NOT decide: whether a child is a boarder, and what his fee is.
 * That is `stay.js` (+ `fees.js` for the money) — one rule, one place.
 */
const db = require('../db');
const time = require('./time');
const timetable = require('./timetable');
const fees = require('./fees');
const stay = require('./stay');
const v = require('./validate');

// The hostel runs all seven days — Sunday is a school holiday, not a hostel holiday,
// so the menu has a Sunday too (a boarder eats all week).
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };

/**
 * The four meals, in the order they are served, each with the time it is served at.
 *
 * The time is written in the portal's ONE clock style — 12-hour with upper-case AM/PM, the same
 * shape `time.js` prints (`7:30 AM`, never `7:30 am` and never `19:30`). The office and the
 * parents read these strings straight from a card, so `smoke-time-ist.js` treats a lower-case
 * "am" as a bare clock and fails — which is how this shape was caught (2026-09-16).
 */
const MEALS = [
  { key: 'Breakfast', icon: '🍞', time: '7:30 AM' },
  { key: 'Lunch', icon: '🍛', time: '1:00 PM' },
  { key: 'Snacks', icon: '☕', time: '5:00 PM' },
  { key: 'Dinner', icon: '🍽️', time: '8:00 PM' },
];
const MEAL_KEYS = MEALS.map((m) => m.key);

const ROUTINE_LIMIT = 30;        // a day has 24 hours; 30 entries is already generous

/** The school's today as a weekday name — Sunday included (the hostel never closes). */
function todayName(now) {
  const day = time.istDayAnchor(now).getUTCDay();          // 0 Sun … 6 Sat
  return DAYS[(day + 6) % 7];                              // Mon=0 … Sun=6
}

/**
 * The whole week, ready for a view: every day with its four meals (a meal nobody has
 * filled in comes back as an empty string, so the page can say "not set yet" instead
 * of losing its shape), and `isToday` on exactly one of them.
 */
function week(now) {
  const rows = db.prepare('SELECT day, meal, items FROM hostel_menu').all();
  const filled = new Map();
  for (const r of rows) filled.set(`${r.day}|${r.meal}`, r.items);
  const today = todayName(now);
  return DAYS.map((day) => ({
    name: day,
    short: SHORT[day],
    isToday: day === today,
    meals: MEALS.map((m) => ({
      ...m,
      items: filled.get(`${day}|${m.key}`) || '',
      set: filled.has(`${day}|${m.key}`),
    })),
  }));
}

/** Just today, for the home card — null meals are shown as "not set yet". */
function today(now) {
  return week(now).find((d) => d.isToday) || null;
}

/** The saved week as plain rows, for the editor (day → meal → text). */
function menuRows() {
  const out = {};
  for (const r of db.prepare('SELECT day, meal, items FROM hostel_menu').all()) {
    if (!out[r.day]) out[r.day] = {};
    out[r.day][r.meal] = r.items;
  }
  return out;
}

/** How many of the 28 possible meals (7 days × 4) are filled in — the panel's count. */
function menuCount() {
  return db.prepare('SELECT COUNT(*) n FROM hostel_menu WHERE TRIM(items) <> \'\'').get().n;
}

/**
 * Save the menu from the admin form. One field per day + meal
 * (`items_Monday_Breakfast`). A field left empty REMOVES that meal, which is how
 * the office says "we do not serve snacks on Sunday" — a blank row is not a meal.
 * @returns {{ ok: boolean, saved: number, cleared: number, error?: string }}
 */
function saveMenu(body = {}) {
  if (String(body.menuSet || '') !== '1') return { ok: false, error: 'The menu form was not sent from the hostel page.' };
  const c = v.checker();
  const values = {};
  for (const day of DAYS) {
    for (const meal of MEAL_KEYS) {
      const raw = body[`items_${day}_${meal}`];
      const text = c.text(raw, `${day} ${meal}`, { max: 200 });
      values[`${day}|${meal}`] = text;
    }
  }
  if (!c.ok) return { ok: false, error: c.summary };

  const del = db.prepare('DELETE FROM hostel_menu WHERE day = ? AND meal = ?');
  const upsert = db.prepare(`INSERT INTO hostel_menu (day, meal, items, sort_order) VALUES (?,?,?,?)
    ON CONFLICT(day, meal) DO UPDATE SET items = excluded.items, sort_order = excluded.sort_order`);
  let saved = 0;
  let cleared = 0;
  db.transaction(() => {
    DAYS.forEach((day, d) => {
      MEAL_KEYS.forEach((meal, m) => {
        const items = values[`${day}|${meal}`];
        if (!items) {
          if (del.run(day, meal).changes) cleared++;
          return;
        }
        upsert.run(day, meal, items, d * 10 + m);
        saved++;
      });
    });
  })();
  return { ok: true, saved, cleared };
}

/** The daily routine as a view reads it (with the time already in 12-hour form). */
function routine() {
  return db.prepare('SELECT id, time, activity, note FROM hostel_routine ORDER BY sort_order, id').all()
    .map((r) => ({ ...r, label: timetable.timeLabel(r.time) || r.time }));
}

/**
 * Save the routine: a list of (time, activity, note) rows. Every row that carries an
 * activity is kept, every blank row is dropped; a row with a time but no activity is
 * refused by name so the office knows which line it was.
 * Times go through the timetable's own `to24()`, so "5:30 am" and "05:30" are one thing.
 */
function saveRoutine(body = {}) {
  if (String(body.routineSet || '') !== '1') return { ok: false, error: 'The routine form was not sent from the hostel page.' };
  const c = v.checker();
  const rows = [];
  const problems = [];
  const times = Array.isArray(body.time) ? body.time : (body.time === undefined ? [] : [body.time]);
  const activities = Array.isArray(body.activity) ? body.activity : (body.activity === undefined ? [] : [body.activity]);
  const notes = Array.isArray(body.note) ? body.note : (body.note === undefined ? [] : [body.note]);
  for (let i = 0; i < activities.length && rows.length < ROUTINE_LIMIT; i++) {
    const label = String(activities[i] || '').trim();
    if (!label) continue;                                  // an unused line on the form
    // free text, not a name: an entry is often “Wake up & exercise” or “Study hour (2nd)
    const activity = c.text(label, `Routine entry ${i + 1}`, { max: 60 });
    const at = timetable.to24(times[i] || '');
    if (!at) { problems.push(`The routine entry “${label}” needs a time like 5:30 am or 05:30.`); continue; }
    rows.push({ time: at, activity, note: String(notes[i] || '').trim().slice(0, 60) });
  }
  if (!c.ok) return { ok: false, error: c.summary };
  if (problems.length) return { ok: false, error: problems.join(' ') };
  if (!rows.length) return { ok: false, error: 'Add at least one routine entry (a time and what happens at it).' };

  const ins = db.prepare('INSERT INTO hostel_routine (time, activity, note, sort_order) VALUES (?,?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM hostel_routine').run();
    rows.forEach((r, i) => ins.run(r.time, r.activity, r.note, i));
  })();
  return { ok: true, saved: rows.length };
}

/**
 * WHO BOARDS — the roster the office works from, newest stay decision included.
 * One query, joined to the class, ordered the way the students list is.
 */
function boarders() {
  const rows = db.prepare(`
    SELECT s.id, s.full_name, s.admission_no, s.roll_no, s.photo,
           s.stay, s.hostel_from, s.hostel_until, s.hostel_bed,
           s.parent_name, s.parent_phone, s.parent_user_id,
           c.name AS class_name, c.section, c.tuition_day, c.tuition_hostel
    FROM students s JOIN classes c ON c.id = s.class_id
    WHERE s.stay = 'hostel'
    ORDER BY c.id, s.roll_no`).all();
  const terms = fees.sessionTerms().map((t) => t.term);
  return rows.map((s) => {
    const months = stay.hostelMonths(s, terms);
    return {
      ...s,
      class_label: `${s.class_name}${s.section ? ' ' + s.section : ''}`,
      stay_note: stay.describe(s),
      monthCount: months.length,
      sessionMonths: terms.length,
      hostelRate: Number(s.tuition_hostel) || 0,
      dayRate: Number(s.tuition_day) || 0,
      fromIndex: months.length ? terms.indexOf(months[0]) : -1,
      toIndex: months.length ? terms.indexOf(months[months.length - 1]) : -1,
      months,
    };
  });
}

/**
 * WHO BOARDS, AND WHAT EACH FAMILY STILL OWES — the roster joined to the two money readers.
 *
 * The roster above answers "who lives here". A hostel office asks a second question at the same
 * moment — "and who owes us?" — because a boarder is billed twice over: the monthly fee (priced
 * from the class's HOSTEL column while he is in the hostel) and whatever he took from the school
 * store. The send-reminder button beside a name has to know whether there is anything to chase.
 *
 * So nothing is calculated here. The amounts are read from the two services that already own
 * them:
 *
 *   • `fees.dues({ overdueOnly: false })` — every unpaid month, late or not (a boarder's later
 *     months are not "due" in September just because they are unpaid yet),
 *   • `store.duesFor()` — books, uniform and stationery still to collect.
 *
 * Which means the number beside a name on Admin → Hostel, the one on the dashboard and the one
 * inside the parent's reminder can never disagree: they are the same field.
 *
 * `overdueMonths` counts only the months whose due date has passed — it is what makes the send
 * button blink, and it is a fact about the data, never decoration.
 *
 * @returns {{ list: Array, totals: { boarders, owing, pending, overdue, hostelMonthsDue } }}
 */
function roster() {
  const list = boarders();
  const monthsDue = new Map(fees.dues({ overdueOnly: false }).map((d) => [d.id, d]));
  const storeDue = new Map(require('./store').duesFor().map((d) => [d.student_id, d]));
  const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

  const rows = list.map((b) => {
    const m = monthsDue.get(b.id) || null;
    const s = storeDue.get(b.id) || null;
    const monthsDueMoney = m ? m.due : 0;
    const itemsDue = s ? s.balance : 0;
    return {
      ...b,
      overdueMonths: m ? m.months.filter((x) => x.overdue).length : 0,
      monthsDueCount: m ? m.monthsCount : 0,
      monthsDueMoney: round2(monthsDueMoney),
      hostelMonthsDue: m ? m.hostelMonths : 0,
      hostelDueMoney: round2(m ? m.hostelDue : 0),
      itemsDue: round2(itemsDue),
      pending: round2(monthsDueMoney + itemsDue),
    };
  });

  return {
    list: rows,
    totals: {
      boarders: rows.length,
      owing: rows.filter((b) => b.pending > 0).length,
      pending: round2(rows.reduce((a, b) => a + b.pending, 0)),
      overdue: rows.filter((b) => b.overdueMonths > 0).length,
      hostelMonthsDue: rows.reduce((a, b) => a + b.monthsDueCount, 0),
    },
  };
}

/** How many boarders the school has (the admin dashboard tile). */
function count() {
  return db.prepare("SELECT COUNT(*) n FROM students WHERE stay = 'hostel'").get().n;
}

/** The hostel's own details (warden, capacity…) live in config — read once here. */
function info() {
  const school = require('../config');
  return school.hostel;
}

module.exports = {
  DAYS, SHORT, MEALS, MEAL_KEYS, ROUTINE_LIMIT,
  todayName, today, week, menuRows, menuCount, saveMenu,
  routine, saveRoutine, boarders, roster, count, info,
};
