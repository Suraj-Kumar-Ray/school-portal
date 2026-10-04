// ============================================================
// A teacher's other work — lunch duty and extra classes
// ------------------------------------------------------------
// The school's report (2026-09-20): the lunch break was never mentioned on a teacher's timetable,
// and an extra class handed to a teacher did not reach it either — so give the office's board two
// sections it can assign from. A teacher's week is GENERATED from the class grids
// (services/timetable.js), and a break period belongs to nobody — so lunch duty and an extra
// class can never come out of a class grid. They live in `teacher_duties`, one row per
// teacher/day/period, and `timetable.forTeacher` layers them on top of the generated week.
//
// The rule the school set for both: whichever period is handed out, the teacher must be free then.
// A teacher is FREE in a day+period when
//   • no class grid anywhere carries his name in that day+period, and
//   • he is not already on duty in that same day+period.
// The name on a class grid is typed by the office, so the match is the forgiving one the
// teacher's own week uses (`timetable.rowNamesTeacher`: “Ritu jha” finds “Mrs. Ritu Jha”).
//
// Reads/writes only through this module — routes never touch the table.
// ============================================================
const db = require('../db');
const tt = require('./timetable');

// What can be handed out. `lunch` is a break duty (the children are free, he is not);
// `special` is an extra class, which names the class it is for.
const KINDS = [
  { key: 'lunch', label: 'Lunch break', short: 'Lunch break', emoji: '🍱', color: 'orange', note: 'Teacher covers the lunch break' },
  { key: 'special', label: 'Special class', short: 'Special class', emoji: '📚', color: 'violet', note: 'Additional subject period' },
];
const KIND_KEYS = KINDS.map(k => k.key);
const KIND_BY = new Map(KINDS.map(k => [k.key, k]));

/** The details of a kind. An unknown value reads as a lunch duty (the common case). */
function kindMeta(key) {
  return KIND_BY.get(String(key == null ? '' : key).trim()) || KIND_BY.get('lunch');
}

// ---------- reading ----------

const SELECT = `
  SELECT d.*, c.name AS class_name, c.section AS class_section
  FROM teacher_duties d
  LEFT JOIN classes c ON c.id = d.class_id`;

/** Every duty, in week order (day, period, teacher). */
function list() {
  const order = tt.DAYS.map((d, i) => `WHEN '${d}' THEN ${i}`).join(' ');
  return db.prepare(`${SELECT} ORDER BY CASE d.day ${order} ELSE 9 END, d.period, d.teacher`).all()
    .map(decorate);
}

/**
 * The lunch cover, as the office reads it: one block PER PERIOD, and inside it one chip per
 * teacher. The school's ask (2026-09-20): “a teacher given the period-5 lunch covers the whole
 * week — do not show me that day by day, just show me WHO has period 5”. So rows are folded by
 * period+teacher: the chip carries the teacher's name and, only when a day is missing, which
 * days it covers (a full week says “every school day”).
 */
function lunchByPeriod() {
  const blocks = new Map();
  for (const row of list()) {
    if (row.kind !== 'lunch') continue;
    if (!blocks.has(row.period)) blocks.set(row.period, { period: row.period, teachers: [] });
    const block = blocks.get(row.period);
    let who = block.teachers.find((t) => t.name === row.teacher);
    if (!who) { who = { name: row.teacher, days: [], ids: [] }; block.teachers.push(who); }
    who.days.push(row.day);
    who.ids.push(row.id);
  }
  return [...blocks.values()].sort((a, b) => a.period - b.period).map((block) => ({
    period: block.period,
    teachers: block.teachers.sort((a, b) => a.name.localeCompare(b.name)).map((who) => {
      const ordered = who.days.slice().sort((a, b) => tt.DAYS.indexOf(a) - tt.DAYS.indexOf(b));
      const full = ordered.length === tt.DAYS.length;
      return {
        name: who.name,
        ids: who.ids,
        days: ordered,
        full,
        daysLabel: full ? 'every school day'
          : ordered.length === 1 ? ordered[0]
            : ordered.map((d) => tt.SHORT[d] || d).join(', '),
      };
    }),
    everyDay: block.teachers.every((who) => who.days.length === tt.DAYS.length),
  }));
}

/** The special classes, day by day (week order) — these are one class, one day, so the day matters. */
function specialByDay() {
  return tt.DAYS.map((day) => ({
    day,
    short: tt.SHORT[day] || day,
    rows: list().filter((r) => r.kind === 'special' && r.day === day),
  })).filter((d) => d.rows.length);
}

/** `{ Monday: [ … ], … }` — only the days that have something. */
function byDay() {
  const out = {};
  for (const row of list()) {
    if (!out[row.day]) out[row.day] = [];
    out[row.day].push(row);
  }
  return out;
}

/**
 * The duties of ONE teacher, matched forgivingly by name (the office types the name, and an
 * old row may carry “Ritu jha” while the account says “Mrs. Ritu Jha”).
 */
function forTeacher(fullName) {
  const mine = list().filter((d) => tt.rowNamesTeacher(d.teacher, fullName)
    // a teacher's OWN name always matches itself, however the variants behave
    || String(d.teacher || '').trim().toLowerCase() === String(fullName || '').trim().toLowerCase());
  const bySlot = {};
  for (const d of mine) {
    bySlot[`${d.day}|${d.period}`] = d;
  }
  return { rows: mine, bySlot };
}

// ---------- who is free ----------

/** Name + class label of every teacher standing in a class grid at this day+period. */
function classBusyAt(day, period) {
  return db.prepare(`
    SELECT t.teacher, c.name, c.section FROM timetable t
    JOIN classes c ON c.id = t.class_id
    WHERE t.day = ? AND t.period = ? AND TRIM(COALESCE(t.teacher, '')) <> ''`)
    .all(day, parseInt(period, 10) || 0)
    .map((r) => ({ teacher: r.teacher, where: r.name + (r.section ? ' ' + r.section : '') }));
}

/**
 * WHY a teacher cannot take this day+period, or null when he is free. The words name where he
 * already is, so the office is never left guessing (same sentence shape as the double-booking
 * rule in services/timetable.js).
 */
function busyReason(teacher, day, period) {
  const name = String(teacher == null ? '' : teacher).trim();
  if (!name) return 'Pick a teacher first.';
  const inClass = classBusyAt(day, period).find((r) => tt.rowNamesTeacher(r.teacher, name));
  if (inClass) {
    return `${name} already takes ${inClass.where} in ${day} period ${period} — pick a teacher who is free then.`;
  }
  const duty = db.prepare('SELECT kind FROM teacher_duties WHERE day = ? AND period = ? AND teacher = ?')
    .get(day, parseInt(period, 10) || 0, name);
  if (duty) {
    const meta = kindMeta(duty.kind);
    return `${name} is already on ${meta.label.toLowerCase()} in ${day} period ${period} — `
      + 'take that off the list first, or pick someone else.';
  }
  return null;
}

/** The teachers free in this day+period, each with nothing to explain. */
function freeTeachers(staffNames, day, period) {
  return (staffNames || []).filter((n) => !busyReason(n, day, period));
}

/**
 * Teachers who are free for EVERY selected day at this period. The admin form uses this for
 * multi-day assignments: showing the intersection up front means every name in the list is safe
 * for every checked day, rather than looking free on only the first day.
 */
function freeTeachersForDays(staffNames, days, period) {
  const selected = [...new Set((days || []).filter((d) => tt.DAYS.includes(d)))];
  if (!selected.length) return [];
  return (staffNames || []).filter((name) => selected.every((day) => !busyReason(name, day, period)));
}

// ---------- writing ----------

/**
 * Put a teacher on duty (or on an extra class) for one day+period.
 *
 * Returns `{ ok: true, row }` or `{ ok: false, reason }` — never throws for a rule the school
 * can read. The FREE rule above is enforced here, and the table's UNIQUE keeps a teacher from
 * being written twice into one period even if two people press Save at the same moment.
 * `subject` identifies a special class; a lunch break carries neither class nor subject.
 */
function save({ teacher, day, period, kind, classId, subject }) {
  const meta = kindMeta(kind);
  const name = String(teacher == null ? '' : teacher).trim();
  const dayName = tt.DAYS.includes(day) ? day : '';
  const p = parseInt(period, 10) || 0;
  if (!name) return { ok: false, reason: 'Pick a teacher first.' };
  if (!dayName) return { ok: false, reason: 'Pick the day.' };
  if (!(p >= 1 && p <= 12)) return { ok: false, reason: 'Pick the period.' };
  const busy = busyReason(name, dayName, p);
  if (busy) return { ok: false, reason: busy };

  const cid = meta.key === 'special' ? (parseInt(classId, 10) || null) : null;
  const what = meta.key === 'special' ? String(subject == null ? '' : subject).trim().slice(0, 60) : null;
  db.prepare(`INSERT INTO teacher_duties (teacher, day, period, kind, class_id, subject)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(teacher, day, period)
              DO UPDATE SET kind = excluded.kind, class_id = excluded.class_id, subject = excluded.subject`)
    .run(name, dayName, p, meta.key, cid, what || null);
  const row = db.prepare(`${SELECT} WHERE d.teacher = ? AND d.day = ? AND d.period = ?`).get(name, dayName, p);
  return { ok: true, row: decorate(row) };
}

/** Take one duty off — the ✕ in the office's list. Returns true when a row really went. */
function remove(id) {
  return db.prepare('DELETE FROM teacher_duties WHERE id = ?').run(parseInt(id, 10) || 0).changes > 0;
}

/** Remove a teacher from every selected-day assignment of one kind and period. */
function removeTeacherPeriod({ teacher, period, kind = 'lunch' }) {
  return db.prepare('DELETE FROM teacher_duties WHERE teacher = ? AND period = ? AND kind = ?')
    .run(String(teacher || '').trim(), parseInt(period, 10) || 0, kindMeta(kind).key).changes;
}

/**
 * Assign one kind to many teachers across many days in one atomic operation. Every combination
 * is checked again immediately before writing; a late clash rolls back the whole request, so a
 * multi-day/multi-teacher form can never leave a half-filled assignment behind.
 */
function saveMany({ teachers, days, period, kind, classId, subject }) {
  const names = [...new Set((teachers || []).map((n) => String(n || '').trim()).filter(Boolean))];
  const selectedDays = [...new Set((days || []).filter((d) => tt.DAYS.includes(d)))];
  const p = parseInt(period, 10) || 0;
  const meta = kindMeta(kind);
  if (!names.length) return { ok: false, reason: 'Pick at least one teacher.' };
  if (!selectedDays.length) return { ok: false, reason: 'Pick at least one day.' };
  if (!(p >= 1 && p <= 12)) return { ok: false, reason: 'Pick the period.' };
  const cid = meta.key === 'special' ? (parseInt(classId, 10) || null) : null;
  const what = meta.key === 'special' ? String(subject == null ? '' : subject).trim().slice(0, 60) : null;
  if (meta.key === 'special' && !what) return { ok: false, reason: 'Subject is required for a special class.' };

  for (const day of selectedDays) {
    for (const name of names) {
      const reason = busyReason(name, day, p);
      if (reason) return { ok: false, reason };
    }
  }

  const insert = db.prepare(`INSERT INTO teacher_duties (teacher, day, period, kind, class_id, subject)
                              VALUES (?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    let count = 0;
    for (const day of selectedDays) {
      for (const name of names) {
        insert.run(name, day, p, meta.key, cid, what || null);
        count += 1;
      }
    }
    return count;
  });
  try {
    return { ok: true, count: tx(), teachers: names, days: selectedDays, kind: meta.key };
  } catch (err) {
    return { ok: false, reason: 'One of those assignments was taken while you were saving. Refresh and choose the free names again.' };
  }
}

/** One row, ready for a view or for a teacher's week (labels, emoji, colour). */
function decorate(row) {
  if (!row) return null;
  const meta = kindMeta(row.kind);
  const className = [row.class_name, row.class_section].filter(Boolean).join(' ');
  return {
    id: row.id,
    teacher: row.teacher,
    day: row.day,
    period: row.period,
    kind: meta.key,
    kindLabel: meta.label,
    emoji: meta.emoji,
    color: meta.color,
    classId: row.class_id || null,
    className,
    subject: row.subject || '',
    // The line a teacher reads on his own card. An extra class SAYS it is one (the school asked
    // for exactly that, 2026-09-20: an extra class never reached the teacher's timetable) and
    // adds the subject when the office typed one — the class it is for rides in the chip beside
    // it. A lunch duty needs no more than its own name.
    label: meta.key === 'special'
      ? (row.subject ? `${meta.label} · ${row.subject}` : meta.label)
      : meta.label,
    note: meta.note,
  };
}

module.exports = {
  KINDS, KIND_KEYS, kindMeta,
  list, byDay, forTeacher, classBusyAt, busyReason, freeTeachers, freeTeachersForDays, save, saveMany, remove, removeTeacherPeriod,
  lunchByPeriod, specialByDay,
};
