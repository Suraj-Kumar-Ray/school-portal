// ============================================================
// Exam time table — "when the exams come, switch the timetable off and
// show the exam one" (school's request, 2026-09-15)
// ------------------------------------------------------------
// Two things live here, and they are deliberately separate:
//
//   1. THE DATE-SHEET — `exam_timetable`: one row per paper (class, date, subject,
//      start/end, note). A row with `class_id` NULL is the same paper for every class,
//      which is how a school-wide date-sheet is typed once.
//   2. THE SWITCH — site_content `examModeOn` / `examModeExamId` / `examModeNote`.
//      While it is on, `forClass()` answers `showing: 'exam'` and the parents' and
//      teachers' Timetable page shows the date-sheet INSTEAD of the weekly grid.
//
// The weekly timetable itself is never touched: switching exam mode off brings the
// normal periods back exactly as they were. A class with no paper listed falls back to
// its weekly timetable even while the switch is on (a parent must never be left with an
// empty page), and that fallback is said out loud on the page.
//
// Clock labels come from services/timetable.js (`timeRange`), so a paper's time reads
// “9:00 – 12:00 PM” in the same 12-hour style as every other screen. Dates are the IST
// calendar day, formatted here — never in a view.
// ============================================================
const db = require('../db');
const config = require('../config');
const time = require('./time');
const tt = require('./timetable');       // one owner for clock-time labels

const ON = 'examModeOn';
const EXAM = 'examModeExamId';
const NOTE = 'examModeNote';

const NOTE_MAX = 300;
const SUBJECT_MAX = 60;
const PAPER_NOTE_MAX = 120;

// ---------- the switch ----------

/** What the office set: `{ on, examId, note }`. Never throws on an empty store. */
function getMode() {
  const rows = db.prepare(`SELECT key, value FROM site_content WHERE key IN (?,?,?)`).all(ON, EXAM, NOTE);
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  const examId = parseInt(s[EXAM], 10) || 0;
  return {
    on: s[ON] === '1',
    examId,
    exam: examId ? getExam(examId) : null,
    note: (s[NOTE] || '').trim(),
  };
}

/** The exam row (Term 1 2026…), or null when there is none / it was deleted. */
function getExam(examId) {
  return db.prepare('SELECT id, term, year FROM exams WHERE id = ?').get(parseInt(examId, 10) || 0) || null;
}

/** “Term 1 2026” — one label for the screens and the message the office sends. */
function examLabel(exam) {
  return exam ? `${exam.term} ${exam.year}`.trim() : '';
}

/** Every exam the office can pick from (newest first — the coming one is usually latest). */
function listExams() {
  return db.prepare('SELECT id, term, year FROM exams ORDER BY year DESC, id DESC').all();
}

/** Save the switch. Only an existing exam id is stored; anything else is dropped. */
function setMode({ on, examId, note }) {
  const id = getExam(examId) ? parseInt(examId, 10) : 0;
  const upsert = db.prepare(`INSERT INTO site_content (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  db.transaction(() => {
    upsert.run(ON, on ? '1' : '0');
    upsert.run(EXAM, id ? String(id) : '');
    upsert.run(NOTE, String(note == null ? '' : note).trim().slice(0, NOTE_MAX));
  })();
  return getMode();
}

// ---------- the date-sheet ----------

/** One paper row, cleaned (blank times become '', a blank note becomes ''). */
function cleanPaper(row) {
  return {
    id: row.id,
    exam_id: row.exam_id || 0,
    class_id: row.class_id || 0,
    paper_date: String(row.paper_date || ''),
    subject: String(row.subject || ''),
    from_time: String(row.from_time || ''),
    to_time: String(row.to_time || ''),
    note: String(row.note || ''),
  };
}

/**
 * The papers of ONE class, date order. A paper added for “every class” (class_id NULL)
 * belongs to this class too — that is what makes a school-wide date-sheet possible.
 */
function papersForClass(classId, { examId = 0 } = {}) {
  const cid = parseInt(classId, 10) || 0;
  const params = [cid];
  let sql = `SELECT * FROM exam_timetable WHERE (class_id = ? OR class_id IS NULL)`;
  if (examId) { sql += ' AND exam_id = ?'; params.push(parseInt(examId, 10) || 0); }
  sql += ' ORDER BY paper_date, from_time, subject';
  return db.prepare(sql).all(...params).map(cleanPaper);
}

/** The papers typed for ONE class exactly (no “all classes” rows) — the office editor. */
function papersOfClass(classId, { examId = 0 } = {}) {
  const cid = parseInt(classId, 10) || 0;
  const params = [cid];
  let sql = 'SELECT * FROM exam_timetable WHERE class_id = ?';
  if (examId) { sql += ' AND exam_id = ?'; params.push(parseInt(examId, 10) || 0); }
  sql += ' ORDER BY paper_date, from_time, subject';
  return db.prepare(sql).all(...params).map(cleanPaper);
}

/** Every paper of the school-wide sheet (class_id NULL) — the office editor's other half. */
function papersForAll() {
  return db.prepare('SELECT * FROM exam_timetable WHERE class_id IS NULL ORDER BY paper_date, from_time, subject')
    .all().map(cleanPaper);
}

/** One paper by id (the office editor), cleaned — or null when it is gone. */
function getPaper(id) {
  const row = db.prepare('SELECT * FROM exam_timetable WHERE id = ?').get(parseInt(id, 10) || 0);
  return row ? cleanPaper(row) : null;
}

/** How many papers each class has (the office's “who is still empty” list). */
function countsByClass({ examId = 0 } = {}) {
  const params = [];
  let sql = `SELECT COALESCE(class_id, 0) cid, COUNT(*) n FROM exam_timetable`;
  if (examId) { sql += ' WHERE exam_id = ?'; params.push(parseInt(examId, 10) || 0); }
  sql += ' GROUP BY COALESCE(class_id, 0)';
  const out = {};
  for (const r of db.prepare(sql).all(...params)) out[r.cid] = r.n;
  return out;
}

/** Create or replace one paper (an id updates it in place, so dates cannot fork). */
function savePaper({ id = 0, examId = 0, classId = 0, paper_date, subject, from_time, to_time, note }) {
  const row = [
    getExam(examId) ? parseInt(examId, 10) : null,
    parseInt(classId, 10) > 0 ? parseInt(classId, 10) : null,   // 0 = every class
    String(paper_date || ''),
    String(subject || '').trim(),
    String(from_time || ''),
    String(to_time || ''),
    String(note || '').trim().slice(0, PAPER_NOTE_MAX),
  ];
  const pid = parseInt(id, 10) || 0;
  if (pid) {
    const found = db.prepare('SELECT id FROM exam_timetable WHERE id = ?').get(pid);
    if (!found) return { ok: false, error: 'That paper was already removed — please add it again.' };
    db.prepare(`UPDATE exam_timetable SET exam_id=?, class_id=?, paper_date=?, subject=?, from_time=?, to_time=?, note=? WHERE id=?`)
      .run(...row, pid);
    return { ok: true, id: pid, updated: true };
  }
  const r = db.prepare(`INSERT INTO exam_timetable (exam_id, class_id, paper_date, subject, from_time, to_time, note)
                        VALUES (?,?,?,?,?,?,?)`).run(...row);
  return { ok: true, id: r.lastInsertRowid, updated: false };
}

/** Remove one paper. Returns true when there really was one. */
function deletePaper(id) {
  return db.prepare('DELETE FROM exam_timetable WHERE id = ?').run(parseInt(id, 10) || 0).changes > 0;
}

/** Empty ONE scope — a class's own papers, or the school-wide sheet (0). */
function clearPapers(classId, { examId = 0 } = {}) {
  const cid = parseInt(classId, 10) || 0;
  const params = [cid];
  let sql = 'DELETE FROM exam_timetable WHERE class_id = ?';
  if (examId) { sql += ' AND exam_id = ?'; params.push(parseInt(examId, 10) || 0); }
  return db.prepare(sql).run(...params).changes;
}

/**
 * Copy the school-wide sheet onto a set of classes (or the other way round: a class's
 * sheet onto others). The target's own papers of that exam are replaced — the office is
 * copying a date-sheet, not merging two, and the page says so before it runs.
 */
function copyPapers({ examId = 0, fromClassId = 0, toClassIds = [] }) {
  const eid = getExam(examId) ? parseInt(examId, 10) : 0;
  const source = parseInt(fromClassId, 10) > 0 ? papersOfClass(fromClassId, { examId: eid }) : papersForAll();
  const targets = [...new Set((Array.isArray(toClassIds) ? toClassIds : [toClassIds])
    .map((v) => parseInt(v, 10) || 0).filter((v) => v > 0))];
  if (!source.length || !targets.length) return { copied: 0, classes: 0, papers: source.length };
  const wipe = db.prepare('DELETE FROM exam_timetable WHERE class_id = ? AND exam_id IS ?');
  const put = db.prepare(`INSERT INTO exam_timetable (exam_id, class_id, paper_date, subject, from_time, to_time, note)
                          VALUES (?,?,?,?,?,?,?)`);
  const txn = db.transaction(() => {
    for (const cid of targets) {
      wipe.run(cid, source[0].exam_id || null);
      for (const p of source) put.run(p.exam_id || null, cid, p.paper_date, p.subject, p.from_time, p.to_time, p.note);
    }
  });
  txn();
  return { copied: source.length * targets.length, classes: targets.length, papers: source.length };
}

// ---------- what a parent / teacher sees ----------

/** “Mon 22 Sep” — the short day label a phone card can carry. */
function dayShort(dateStr) {
  return time.fmt(dateStr, { weekday: 'short', day: 'numeric', month: 'short' });
}
/** “Monday, 22 September 2026” */
function dayLong(dateStr) {
  return time.fmt(dateStr, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** Days between two YYYY-MM-DD strings (b - a), or null when either is unreadable. */
function daysBetween(a, b) {
  const d1 = time.toDate(a);
  const d2 = time.toDate(b);
  if (!d1 || !d2) return null;
  return Math.round((d2.getTime() - d1.getTime()) / 86400000);
}

/**
 * The whole answer for one class — the ONE function the parent page, the teacher page
 * and the office preview all read.
 *
 *   showing   'exam'    → the date-sheet is on screen (switch on AND this class has papers)
 *             'regular' → the weekly timetable (with `because` saying why)
 *   because   '' | 'off' | 'no-papers'
 */
function forClass(classId, { now = new Date(), examId = null } = {}) {
  const mode = getMode();
  const today = time.todayISO(now);
  // The switch's exam decides what parents see; a caller may ask about a DIFFERENT exam
  // (the office previewing next term's date-sheet) by passing one in.
  const useExam = examId === null ? mode.examId : (parseInt(examId, 10) || 0);
  const papers = papersForClass(classId, { examId: useExam });
  const showing = mode.on ? (papers.length ? 'exam' : 'regular') : 'regular';
  const because = mode.on ? (papers.length ? '' : 'no-papers') : 'off';

  const list = papers.map((p) => {
    const gap = daysBetween(today, p.paper_date);
    const timeLabel = p.from_time || p.to_time
      ? tt.timeRange(tt.to24(p.from_time), tt.to24(p.to_time))
      : '';
    return {
      ...p,
      dateShort: dayShort(p.paper_date),
      dateLong: dayLong(p.paper_date),
      timeLabel,
      isToday: p.paper_date === today,
      isPast: !!p.paper_date && p.paper_date < today,
      isTomorrow: gap === 1,
      daysAway: gap,
    };
  });

  // papers grouped by date, in date order — the shape both views print
  const days = [];
  for (const p of list) {
    let d = days[days.length - 1];
    if (!d || d.date !== p.paper_date) {
      d = {
        date: p.paper_date,
        dateShort: p.dateShort,
        dateLong: p.dateLong,
        isToday: p.isToday,
        isPast: p.isPast,
        isTomorrow: p.isTomorrow,
        papers: [],
      };
      days.push(d);
    }
    d.papers.push(p);
  }

  const next = list.find((p) => !p.isPast) || null;          // the paper still to come
  const lastPast = [...list].reverse().find((p) => p.isPast) || null;
  return {
    on: mode.on,
    showing,
    because,
    examId: mode.examId,
    exam: mode.exam,
    label: examLabel(mode.exam) || 'Exam time table',
    note: mode.note,
    papers: list,
    days,
    next,
    today: list.filter((p) => p.isToday),
    summary: {
      total: list.length,
      days: days.length,
      first: list.length ? list[0] : null,
      last: list.length ? list[list.length - 1] : null,
      done: list.filter((p) => p.isPast).length,
      // “the last paper was on 25 Sept” — the office needs this to switch the mode off
      allOver: list.length > 0 && lastPast === list[list.length - 1],
    },
  };
}

/** The same sheet for the office's own preview, for a class it may not be looking at. */
function previewFor(classId, examId = null) {
  const exam = forClass(classId, { examId });
  return { ...exam, showing: exam.papers.length ? 'exam' : 'regular' };
}

/** A plain-text date-sheet — the body of the message parents receive. */
function sheetText(classId, { now = new Date(), examId = null } = {}) {
  const sheet = forClass(classId, { now, examId });
  if (!sheet.papers.length) return '';
  const lines = sheet.papers.map((p) => {
    const at = p.timeLabel ? ` · ${p.timeLabel}` : '';
    return `• ${p.dateShort} — ${p.subject}${at}${p.note ? ` (${p.note})` : ''}`;
  });
  return lines.join('\n');
}

/**
 * The message parents receive when the office sends the date-sheet out.
 * `classId` 0 = the school-wide sheet (the papers typed for “all classes”).
 * Plain English, one line per paper — a parent reads it on a phone.
 */
function tellMessage(classId, { now = new Date(), examId = null } = {}) {
  const sheet = forClass(parseInt(classId, 10) || 0, { now, examId });
  const label = sheet.label;
  const lines = sheet.papers.map((p) => {
    const at = p.timeLabel ? ` (${p.timeLabel})` : '';
    return `• ${p.dateShort} — ${p.subject}${at}${p.note ? ` · ${p.note}` : ''}`;
  });
  const body = [
    `${label} exam time table is out${sheet.papers.length ? ':' : '.'}`,
    lines.length ? `\n${lines.join('\n')}` : '',
    sheet.note ? `\n${sheet.note}` : '',
    `\nOpen the app → 🕒 Timetable to see it any time.`,
    `\n— ${config.schoolName}`,
  ].filter(Boolean).join('\n');
  return {
    category: 'Timetable',
    subject: `📝 ${label} — exam time table`.slice(0, 120),
    body: body.slice(0, 2000),
    label,
    papers: sheet.papers.length,
  };
}

module.exports = {
  NOTE_MAX, SUBJECT_MAX, PAPER_NOTE_MAX,
  getMode, setMode, listExams, getExam, examLabel,
  papersForClass, papersOfClass, papersForAll, countsByClass, getPaper,
  savePaper, deletePaper, clearPapers, copyPapers,
  forClass, previewFor, sheetText, tellMessage, dayShort, dayLong,
};
