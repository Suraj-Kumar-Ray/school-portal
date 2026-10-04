// ============================================================
// Homework — what was given, period by period
// ------------------------------------------------------------
// The school's ask (2026-09-18): “the timetable should also show what homework
// was given.” A teacher writes it from his portal (the timetable page he already
// opens), the office writes it from the admin panel; a parent reads it right on
// the period's card in the timetable.
//
// One row per class/day/period (UNIQUE), so a note can never disagree with the
// timetable itself. An EMPTY note is a real, useful state: the school asked for a
// standing line — “Homework given — please check the copy” — for the day a
// teacher knows he gave homework but does not type the detail. The parent always
// reads SOMETHING; never a blank.
// ============================================================
const db = require('../db');
const time = require('./time');

/** The standing line, in the school's own words — never a bare empty box. */
const STANDING_NOTE = 'Homework given — please check the copy.';

/** What the parent reads for a row: the note, or the standing line for an empty one. */
function displayNote(row) {
  if (!row) return null;
  const note = String(row.note || '').trim();
  return note || STANDING_NOTE;
}

/** Is this note the standing line itself (a row the teacher left empty)? */
function isStanding(row) {
  return !!row && !String(row.note || '').trim();
}

/**
 * Every homework note of ONE class for ONE day, keyed by period number, ready for the
 * timetable view: { [period]: { note, givenBy, givenOn, isStanding, isToday } }.
 * Only subject periods carry homework — a lunch break has nothing to check in a copy.
 */
function forDay(classId, day) {
  const today = time.todayISO();
  const rows = db.prepare(
    'SELECT period, note, given_by, given_on FROM homework WHERE class_id = ? AND day = ?'
  ).all(classId, day);
  const byPeriod = {};
  for (const r of rows) {
    byPeriod[r.period] = {
      note: displayNote(r),
      givenBy: r.given_by || '',
      givenOn: r.given_on || '',
      isStanding: isStanding(r),
      isToday: r.given_on === today,
      older: r.given_on !== today,
    };
  }
  return byPeriod;
}

/**
 * The same map for a WHOLE week — the teacher's and the office's editor reads this,
 * one column per day, so one screen writes the week's homework.
 */
function forWeek(classId) {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const rows = db.prepare('SELECT day, period, note, given_by, given_on FROM homework WHERE class_id = ?')
    .all(classId);
  const week = {};
  for (const d of days) week[d] = {};
  for (const r of rows) {
    if (!week[r.day]) continue;
    week[r.day][r.period] = { note: r.note || '', givenBy: r.given_by || '', givenOn: r.given_on || '' };
  }
  return week;
}

/**
 * Write ONE period's homework. The note is cleaned by the caller (validate.text);
 * an empty note stores the standing line as '' — the display layer says the words.
 * Returns the row that is now on file.
 */
function setNote({ classId, day, period, subject, note, givenBy }) {
  const clean = String(note || '').trim();
  db.prepare(`
    INSERT INTO homework (class_id, day, period, subject, note, given_by, given_on)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (class_id, day, period)
    DO UPDATE SET note = excluded.note, subject = excluded.subject,
                  given_by = excluded.given_by, given_on = excluded.given_on
  `).run(classId, day, period, subject || '', clean, givenBy || '', time.todayISO());
  return db.prepare('SELECT * FROM homework WHERE class_id = ? AND day = ? AND period = ?')
    .get(classId, day, period);
}

/** Remove one period's homework (the ✕ on the editor). */
function clearNote({ classId, day, period }) {
  db.prepare('DELETE FROM homework WHERE class_id = ? AND day = ? AND period = ?')
    .run(classId, day, period);
}

/** How many notes this class carries today — the office's quick “did teachers write?” glance. */
function countToday(classId) {
  return db.prepare('SELECT COUNT(*) AS n FROM homework WHERE class_id = ? AND given_on = ?')
    .get(classId, time.todayISO()).n;
}

// ---- WHO DID IT, and who did not (2026-09-18) ----------------------------------------
// The school's ask: “if a child comes without his homework the teacher opens his profile
// and marks homework-not-done — the timetable then shows a ✕ on that period; if he did it
// and says so, a ✓. By default NOTHING — if no teacher marks anything the band stays plain,
// so a parent is never told something nobody said.”

/**
 * One child's marks for ONE timetable day, keyed by period:
 *   { [period]: { status: 'done' | 'not_done', markedBy, markedOn } }
 * Every other period is simply absent — the view prints nothing for it, which is
 * exactly the "by default nothing" the school asked for.
 */
function statusesForDay(studentId, day) {
  const rows = db.prepare(
    'SELECT period, status, marked_by, marked_on FROM homework_status WHERE student_id = ? AND day = ?'
  ).all(studentId, day);
  const map = {};
  for (const r of rows) {
    map[r.period] = { status: r.status, markedBy: r.marked_by || '', markedOn: r.marked_on || '' };
  }
  return map;
}

/**
 * Write (or overwrite) one child's mark for a day/period. `status` is 'done' | 'not_done';
 * anything else is refused rather than half-written.
 */
function setStatus({ studentId, day, period, status, markedBy }) {
  if (status !== 'done' && status !== 'not_done') return null;
  db.prepare(`
    INSERT INTO homework_status (student_id, day, period, status, marked_by, marked_on)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (student_id, day, period)
    DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by, marked_on = excluded.marked_on
  `).run(studentId, day, period, status, markedBy || '', time.todayISO());
  return db.prepare('SELECT * FROM homework_status WHERE student_id = ? AND day = ? AND period = ?')
    .get(studentId, day, period);
}

/** Take a mark back — the band returns to plain for that period. */
function clearStatus({ studentId, day, period }) {
  db.prepare('DELETE FROM homework_status WHERE student_id = ? AND day = ? AND period = ?')
    .run(studentId, day, period);
}

/**
 * THE WHOLE CLASS'S MARKS FOR A DAY — the one-tap board's data (2026-09-19).
 * The school does not let teachers use phones, so marking one child at a time was too
 * slow: this reads EVERY child's marks of one class/day in ONE query, keyed
 * `[studentId][period] = { status, markedBy, markedOn }` — the board renders the whole
 * room at once and each cell is a single tap.
 */
function statusesForClassDay(classId, day) {
  const rows = db.prepare(`
    SELECT hs.student_id, hs.period, hs.status, hs.marked_by, hs.marked_on
    FROM homework_status hs
    JOIN students s ON s.id = hs.student_id
    WHERE s.class_id = ? AND hs.day = ?`).all(classId, day);
  const map = {};
  for (const r of rows) {
    if (!map[r.student_id]) map[r.student_id] = {};
    map[r.student_id][r.period] = { status: r.status, markedBy: r.marked_by || '', markedOn: r.marked_on || '' };
  }
  return map;
}

/**
 * The children who did NOT do their homework for a day — the teacher's follow-up list
 * and the parents' "previous day" cross. One row per child+period, newest marking first.
 */
function notDoneForClassDay(classId, day) {
  return db.prepare(`
    SELECT s.id, s.full_name, s.roll_no, hs.period, hs.marked_by, hs.marked_on
    FROM homework_status hs
    JOIN students s ON s.id = hs.student_id
    WHERE s.class_id = ? AND hs.day = ? AND hs.status = 'not_done'
    ORDER BY s.roll_no, hs.period`).all(classId, day);
}

/** The mark row itself, so the marker page can show who said it and when. */
function statusRow(studentId, day, period) {
  return db.prepare('SELECT * FROM homework_status WHERE student_id = ? AND day = ? AND period = ?')
    .get(studentId, day, period) || null;
}

module.exports = { STANDING_NOTE, forDay, forWeek, setNote, clearNote, countToday, displayNote, isStanding,
  statusesForDay, setStatus, clearStatus, statusRow, statusesForClassDay, notDoneForClassDay };
