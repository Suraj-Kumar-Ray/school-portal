// ============================================================
// Class timetable
// ------------------------------------------------------------
// The `timetable` table stores one row per class/day/period
// (subject + teacher). It has no clock times, so the school's
// period timings live in `site_content.periodTimes` (JSON) and
// the admin can edit them on the Timetable page. Parents then get
// a phone-first view: day chips + one big card per period.
// ============================================================
const db = require('../db');
const time = require('./time');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed',
  Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat',
};
// school day is 8:00 AM – 2:00 PM, so 8 periods with a short break + lunch fit exactly
const DEFAULT_PERIOD_TIMES = [
  { period: 1, from: '08:00', to: '08:40' },
  { period: 2, from: '08:40', to: '09:20' },
  { period: 3, from: '09:20', to: '10:00' },
  { period: 4, from: '10:15', to: '10:55' },
  { period: 5, from: '10:55', to: '11:35' },
  { period: 6, from: '12:00', to: '12:40' },
  { period: 7, from: '12:40', to: '13:20' },
  { period: 8, from: '13:20', to: '14:00' },
];

// ---------- what a slot can be ----------
//
// A school day is not only subject periods: there is an assembly, a short break,
// lunch (period 5 in most schools), games, an activity and the odd test. The admin
// picks the `kind` in the period editor and the parents get a card that matches —
// lunch is never shown as a class, and never with a teacher it does not have.
// `break: true` means the children are free (no subject teacher to print).
// `note` is the small line a parent reads under the period (never printed for a
// normal subject period — there the teacher's name takes that place).
const KINDS = [
  { key: 'class', label: 'Subject period', emoji: '📚', color: 'slate', break: false, note: '' },
  { key: 'assembly', label: 'Assembly', emoji: '🎏', color: 'amber', break: true, note: 'Whole school together' },
  { key: 'break', label: 'Short break', emoji: '☕', color: 'lime', break: true, note: 'Free time' },
  { key: 'lunch', label: 'Lunch break', emoji: '🍱', color: 'orange', break: true, note: 'Lunch — children eat' },
  { key: 'games', label: 'Games / PT', emoji: '⚽', color: 'lime', break: true, note: 'On the ground' },
  { key: 'activity', label: 'Activity', emoji: '🎨', color: 'rose', break: true, note: 'Activity period' },
  { key: 'test', label: 'Test / Exam', emoji: '📝', color: 'violet', break: false, note: 'Test in this period' },
];
/** The keys as a plain list — the only values the editor may submit. */
const KIND_KEYS = KINDS.map(k => k.key);
const KIND_BY_KEY = new Map(KINDS.map(k => [k.key, k]));

/** The details of a kind. An unknown/legacy value reads as a normal subject period. */
function kindMeta(key) {
  return KIND_BY_KEY.get(String(key == null ? '' : key).trim()) || KIND_BY_KEY.get('class');
}

/** Is this a break (assembly · lunch · games …) — i.e. no subject teacher to print? */
function isBreakKind(key) {
  return kindMeta(key).break === true;
}

// ---------- period timings ----------

/** "8:00", "08:00", "8 am", "2pm" → "08:00" (24h) — '' when unreadable. */
function normaliseTime(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h < 0 || h > 23 || min > 59) return '';
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

/** "08:40" → "8:40 AM" */
function timeLabel(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return String(value || '');
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

/** "08:00","08:40" → "8:00 – 8:40 AM" (compact, phone friendly) */
function timeRange(from, to) {
  const a = timeLabel(from);
  const b = timeLabel(to);
  if (!a || !b) return a || b || '';
  return `${a.replace(/ (AM|PM)$/, '')} – ${b}`;
}

/** The school's period timings — admin-editable, sensible defaults otherwise. */
function getPeriodTimes() {
  const row = db.prepare("SELECT value FROM site_content WHERE key = 'periodTimes'").get();
  let list = null;
  if (row && row.value) {
    try {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed) && parsed.length) list = parsed;
    } catch (e) { /* fall back to defaults */ }
  }
  const out = (list || DEFAULT_PERIOD_TIMES).map(p => ({
    period: parseInt(p.period, 10) || 0,
    from: normaliseTime(p.from) || String(p.from || ''),
    to: normaliseTime(p.to) || String(p.to || ''),
  })).filter(p => p.period > 0);
  out.sort((a, b) => a.period - b.period);
  return out.map(p => ({
    ...p,
    label: timeRange(p.from, p.to),
  }));
}

/** Save the timings from the admin form (arrays: period[], from[], to[]). */
function savePeriodTimes({ period, from, to }) {
  const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const ps = asList(period); const fs = asList(from); const ts = asList(to);
  const list = [];
  for (let i = 0; i < ps.length; i++) {
    const p = parseInt(ps[i], 10);
    if (!p) continue;
    list.push({
      period: p,
      from: normaliseTime(fs[i]) || '08:00',
      to: normaliseTime(ts[i]) || '08:40',
    });
  }
  list.sort((a, b) => a.period - b.period);
  const value = JSON.stringify(list.length ? list : DEFAULT_PERIOD_TIMES);
  db.prepare(`INSERT INTO site_content (key, value) VALUES ('periodTimes', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
  return list.length;
}

/**
 * Add or move ONE period on the school clock — used by “Add a period”, where the
 * office types period 9 with its time and expects it to appear for every class.
 * (The whole clock is still editable in one go on Admin → Timetable → Period timings.)
 */
function setPeriodTime(period, from, to) {
  const p = parseInt(period, 10);
  if (!p) return 0;
  // read through getPeriodTimes() so the defaults are used on a school that never
  // touched the clock — adding period 9 there must not wipe periods 1–8
  const list = getPeriodTimes().map(t => ({ period: t.period, from: t.from, to: t.to }));
  const entry = { period: p, from: normaliseTime(from) || '', to: normaliseTime(to) || '' };
  const i = list.findIndex(t => t.period === p);
  if (i >= 0) list[i] = entry; else list.push(entry);
  list.sort((a, b) => a.period - b.period);
  db.prepare(`INSERT INTO site_content (key, value) VALUES ('periodTimes', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(list));
  return list.length;
}

/** Take one period off the school clock. Its slots stay, so nothing is lost. */
function removePeriodTime(period) {
  const p = parseInt(period, 10);
  if (!p) return 0;
  const list = getPeriodTimes().filter(t => t.period !== p)
    .map(t => ({ period: t.period, from: t.from, to: t.to }));
  db.prepare(`INSERT INTO site_content (key, value) VALUES ('periodTimes', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(list));
  return list.length;
}

/** Period number → timing, for the admin grid and the parent cards. */
function timeByPeriod() {
  const map = new Map();
  for (const p of getPeriodTimes()) map.set(p.period, p);
  return map;
}

// ---------- days ----------

/**
 * Monday→Saturday strip for the week that contains `now`, with the real date of
 * each day so a parent can see "Wed 16" at a glance.
 */
function weekStrip(now) {
  // The school week is anchored on the SCHOOL's day (IST) and walked in UTC, so the
  // strip is identical whether the server runs in IST, UTC or anywhere else.
  const today = time.istDayAnchor(now);            // UTC midnight of the IST date
  const dow = today.getUTCDay();                   // 0 Sun … 6 Sat
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return DAYS.map((name, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return {
      name,
      short: SHORT[name],
      date: d.getUTCDate(),
      month: d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
      long: d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
      isToday: d.getTime() === today.getTime(),
      isPast: d.getTime() < today.getTime(),
      // YYYY-MM-DD of this day — the key every other service (holidays, exam sheet) needs.
      // Kept here so a caller never has to rebuild a date from `date` + `month`.
      iso: d.toISOString().slice(0, 10),
    };
  });
}

/**
 * The Sunday of the week the parent is looking at — the school's weekly holiday.
 * It sits right after Saturday on the day strip (and is "today" when today is
 * Sunday), so the holiday is never missing from the row the parent reads.
 */
function sundayOfWeek(now) {
  const today = time.istDayAnchor(now);
  const dow = today.getUTCDay();                          // 0 Sun … 6 Sat
  const sun = new Date(today);
  sun.setUTCDate(today.getUTCDate() + (dow === 0 ? 0 : 7 - dow));
  return {
    name: 'Sunday',
    short: 'Sun',
    date: sun.getUTCDate(),
    month: sun.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
    long: sun.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
    isToday: dow === 0,
    iso: sun.toISOString().slice(0, 10),
  };
}

/** Today's real weekday name, or '' on Sunday (school closed). */
function todayName(now) {
  // Use the same IST calendar date as every other portal feature. `istDayAnchor()`
  // is a UTC anchor and can still point to yesterday around midnight in India.
  const iso = time.todayISO(now);
  const day = time.toDate(iso).getUTCDay();
  return day === 0 ? '' : DAYS[day - 1];
}

/** The school's today as a readable label — "Sunday, 20 September". */
function todayLabel(now) {
  if (now instanceof Date && Number.isNaN(now.getTime())) now = undefined;
  return time.istDayAnchor(now).toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/**
 * The next day the school is open (Sundays are skipped) — used for the
 * "school opens again on …" line a parent reads on a holiday.
 */
function nextSchoolDay(now) {
  const anchor = time.istDayAnchor(now);
  for (let i = 1; i <= 7; i++) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() + i);
    const dow = d.getUTCDay();               // 0 Sun … 6 Sat
    if (dow === 0) continue;                 // Sunday — school closed
    return {
      name: DAYS[dow - 1],
      long: d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
      isTomorrow: i === 1,
    };
  }
  return null;
}

// ---------- periods ----------

// a friendly emoji + colour per subject so the cards are readable at a glance
const SUBJECT_STYLES = [
  [/(sanskrit|sank|hindi|eng|english)/i, '📖', 'blue'],
  [/(math|ganit)/i, '🔢', 'violet'],
  [/(physic|phy)/i, '🧲', 'cyan'],
  [/(chem)/i, '🧪', 'green'],
  [/(bio)/i, '🌿', 'emerald'],
  [/(sci)/i, '🔬', 'teal'],
  [/(computer|comp)/i, '💻', 'indigo'],
  [/(sst|social|history|civics|geograph)/i, '🌏', 'amber'],
  [/(gk|general knowledge)|e\.?v\.?s/i, '🧠', 'pink'],
  [/(draw|art|craft)/i, '🎨', 'rose'],
  [/(oral|activity|game|sport|physical|p\.?e\.?|yoga)/i, '🏃', 'lime'],
  [/(urdu|bengali|maithili|bhojpuri)/i, '📝', 'orange'],
];

function subjectStyle(subject) {
  const s = String(subject || '');
  for (const [re, emoji, color] of SUBJECT_STYLES) {
    if (re.test(s)) return { emoji, color };
  }
  return { emoji: '📚', color: 'slate' };
}

/** One day's periods for a class, each with its timing, kind and card style. */
function dayPeriods(classId, day) {
  const rows = db.prepare(`
    SELECT period, subject, teacher, kind FROM timetable
    WHERE class_id = ? AND day = ? ORDER BY period`).all(parseInt(classId, 10) || 0, day);
  const times = timeByPeriod();
  // A row the office has RESET carries nothing at all (no subject, no teacher — see
  // resetClass below). That is not a period yet, so the parents' and the teacher's cards
  // never print a blank one: the class simply has fewer periods while the week is rebuilt.
  return rows.filter(r => String(r.subject || '').trim() || String(r.teacher || '').trim()).map(r => {
    const t = times.get(r.period);
    const meta = kindMeta(r.kind);
    // a break prints its own emoji/colour; a subject period is styled by its name
    const style = meta.key === 'class'
      ? subjectStyle(r.subject)
      : { emoji: meta.emoji, color: meta.color };
    return {
      period: r.period,
      kind: meta.key,
      kindLabel: meta.label,
      kindNote: meta.note || '',
      isBreak: meta.break === true,
      subject: r.subject,
      teacher: r.teacher || '',
      from: t ? t.from : '',
      to: t ? t.to : '',
      timeLabel: t ? t.label : '',
      emoji: style.emoji,
      color: style.color,
    };
  });
}

/** How many periods each day of the week has (used on the day chips). */
function countsByDay(classId) {
  const rows = db.prepare(`
    SELECT day, COUNT(*) c FROM timetable WHERE class_id = ? GROUP BY day`).all(parseInt(classId, 10) || 0);
  const out = {};
  for (const r of rows) out[r.day] = r.c;
  return out;
}

/** Whole week as a grid (used by the admin page and the parents' "see the whole week" view). */
function weekGrid(classId) {
  const rows = db.prepare('SELECT * FROM timetable WHERE class_id = ? ORDER BY day, period').all(parseInt(classId, 10) || 0);
  const grid = {};
  const periods = new Set();
  for (const r of rows) {
    if (!grid[r.day]) grid[r.day] = {};
    grid[r.day][r.period] = r;
    periods.add(r.period);
  }
  return { grid, periods: [...periods].sort((a, b) => a - b) };
}

/**
 * Every period ROW the office's grid should show for a class.
 *
 * The school clock comes first, so an EMPTY period 8 is still on screen and can be
 * filled in with one tap — previously the grid only listed periods that already had a
 * slot, which is exactly why a new period could not be added. Any period the class
 * already has a slot in is added too, so a slot can never be hidden by a missing time.
 */
function periodRows(classId) {
  const map = new Map();
  for (const t of getPeriodTimes()) {
    map.set(t.period, { period: t.period, label: t.label, from: t.from, to: t.to });
  }
  const rows = db.prepare('SELECT DISTINCT period FROM timetable WHERE class_id = ?')
    .all(parseInt(classId, 10) || 0);
  for (const r of rows) {
    if (!map.has(r.period)) map.set(r.period, { period: r.period, label: '', from: '', to: '' });
  }
  return [...map.values()].sort((a, b) => a.period - b.period);
}

// ---------- writing one slot (the office's editor) ----------

/** One slot as stored, or null — what the editor opens on. */
function slot(classId, day, period) {
  return db.prepare('SELECT * FROM timetable WHERE class_id = ? AND day = ? AND period = ?')
    .get(parseInt(classId, 10) || 0, String(day || ''), parseInt(period, 10) || 0) || null;
}

/**
 * Create or replace one slot (same day/period = an update, never a duplicate).
 * A break keeps the kind's own label when the office leaves the name blank, and
 * stores no teacher — a lunch break has none to print on the parent's card.
 */
function saveSlot({ classId, day, period, subject, teacher, kind }) {
  const meta = kindMeta(kind);
  const name = String(subject == null ? '' : subject).trim() || meta.label;
  const who = meta.break ? '' : String(teacher == null ? '' : teacher).trim();
  db.prepare(`INSERT INTO timetable (class_id, day, period, subject, teacher, kind) VALUES (?,?,?,?,?,?)
             ON CONFLICT(class_id, day, period)
             DO UPDATE SET subject = excluded.subject, teacher = excluded.teacher, kind = excluded.kind`)
    .run(parseInt(classId, 10) || 0, day, parseInt(period, 10) || 0, name, who || null, meta.key);
  return { kind: meta.key, subject: name, teacher: who };
}

/** Remove one slot. Returns true when there really was one. */
function deleteSlot(classId, day, period) {
  const r = db.prepare('DELETE FROM timetable WHERE class_id = ? AND day = ? AND period = ?')
    .run(parseInt(classId, 10) || 0, String(day || ''), parseInt(period, 10) || 0);
  return r.changes > 0;
}

/** Remove ONE period from every day of a class — "take period 8 off this class". */
function deletePeriod(classId, period) {
  const r = db.prepare('DELETE FROM timetable WHERE class_id = ? AND period = ?')
    .run(parseInt(classId, 10) || 0, parseInt(period, 10) || 0);
  return r.changes;
}

// ---------- one teacher, one class at a time ----------
//
// The school's rule (2026-09-20): put a constraint on it — a teacher assigned to a period must not
// be assigned anywhere else in that same period. A teacher stands in ONE class in a given
// day+period; the same name may still teach period 2 on Monday in one class and period 2 on
// Tuesday in another (only the day+period pair is unique), and nothing stops two teachers from
// sharing a period in different classes.
//
// The rule lives here so every writer asks the SAME question:
//   • `teacherClash`  — the write routes ask before saving; it names the class the teacher is
//     already in, or null.
//   • `busyMap`       — what the pages print, `{ 'Monday|2': { 'Parvati Devi': 'LKG' } }`, so the
//     editor and the fixer grey those names out instead of letting the office pick one and read
//     about it afterwards.
//
// The demo sheet came in with double-booked names already (measured 2026-09-20: 162 rows where
// one name stands in two classes at the same period). That is why the routes check a CHANGE
// only: a name that already stands on the very period being saved can be saved again — the
// office is editing the subject, or simply pressing Save — so the imported week stays editable.

/** The class a teacher already stands in for this day+period, or null. */
function teacherClash({ teacher, day, period, exceptClassId }) {
  const name = String(teacher == null ? '' : teacher).trim();
  if (!name) return null;
  const r = db.prepare(`
    SELECT c.name, c.section FROM timetable t
    JOIN classes c ON c.id = t.class_id
    WHERE t.day = ? AND t.period = ? AND TRIM(COALESCE(t.teacher, '')) = ? AND t.class_id <> ?
    LIMIT 1`).get(day, parseInt(period, 10) || 0, name, parseInt(exceptClassId, 10) || 0);
  if (!r) return null;
  return { className: r.name + (r.section ? ' ' + r.section : ''), day, period: parseInt(period, 10) || 0 };
}

/**
 * `{ 'Monday|2': { 'Parvati Devi': 'LKG' } }` — every teacher already standing in a period,
 * counted across the OTHER classes only (the class being edited may of course keep its own).
 */
function busyMap(exceptClassId) {
  const rows = db.prepare(`
    SELECT t.day, t.period, t.teacher, c.name, c.section FROM timetable t
    JOIN classes c ON c.id = t.class_id
    WHERE t.class_id <> ? AND TRIM(COALESCE(t.teacher, '')) <> ''`).all(parseInt(exceptClassId, 10) || 0);
  const out = {};
  for (const r of rows) {
    const k = r.day + '|' + r.period;
    if (!out[k]) out[k] = {};
    out[k][r.teacher] = r.name + (r.section ? ' ' + r.section : '');
  }
  return out;
}

/** The words every refusal uses, so the office reads the same sentence everywhere. */
function clashMessage(teacher, clash) {
  return `${teacher} already takes ${clash.className} in ${clash.day} period ${clash.period} — `
    + 'a teacher cannot be in two classes at the same time. Pick someone else, or clear that period first.';
}

/**
 * Wipe ONE class's week — the office's reset button (school's request, 2026-09-20:
 * the reset button should leave every period reading “Not assigned yet”, ready to be edited again).
 *
 * The rows themselves are kept — they are what puts every period on the office's grid — but
 * they are emptied: no subject, no teacher, and the kind goes back to a plain subject period
 * (so a lunch or an assembly is cleared too, which is what “clear everything” means here).
 * Every period of the class therefore reads “Not assigned yet” on the grid, and nothing is
 * deleted. TWO limits, both asked for by the school:
 *   • it touches THIS class only — the caller passes the class the office is looking at
 *   • period TIMINGS are not touched (they are the school's clock, shared by every class)
 *
 * Callers must ask for confirmation first: the page shows a popup and only the popup's form
 * posts here. Returns how many periods were emptied.
 */
function resetClass(classId) {
  const r = db.prepare(`
    UPDATE timetable SET subject = '', teacher = NULL, kind = 'class'
    WHERE class_id = ?`).run(parseInt(classId, 10) || 0);
  return r.changes;
}

/**
 * Copy one day's whole timetable onto every other day of the week.
 *
 * This is the "Monday to Saturday the same" case the school asked for: instead of
 * typing the same 8 periods six times, the office fills Monday and presses ⧉ once.
 * The rows are copied exactly as they are — breaks, subjects and teachers included —
 * and each target day is replaced (never merged), so the week really is identical.
 */
function copyDayToAll(classId, day) {
  const cid = parseInt(classId, 10) || 0;
  const source = db.prepare('SELECT period, subject, teacher, kind FROM timetable WHERE class_id = ? AND day = ? ORDER BY period')
    .all(cid, day);
  if (!source.length) return { days: 0, slots: 0 };
  const targets = DAYS.filter(d => d !== day);
  const wipe = db.prepare('DELETE FROM timetable WHERE class_id = ? AND day = ?');
  const put = db.prepare(`INSERT INTO timetable (class_id, day, period, subject, teacher, kind) VALUES (?,?,?,?,?,?)
                         ON CONFLICT(class_id, day, period)
                         DO UPDATE SET subject = excluded.subject, teacher = excluded.teacher, kind = excluded.kind`);
  const run = db.transaction(() => {
    for (const d of targets) {
      wipe.run(cid, d);
      for (const s of source) put.run(cid, d, s.period, s.subject, s.teacher, s.kind || 'class');
    }
  });
  run();
  return { days: targets.length, slots: source.length * targets.length };
}

// ============================================================================
// THE TEACHER'S OWN WEEK — generated, never typed twice (2026-09-19)
// ============================================================================
// The office writes ONE timetable per class, with the teacher's name on every period
// (`timetable.teacher`). THIS reader turns those class grids into the week of one
// teacher: for every class he was granted, every day, the periods that carry his
// name. A period with no class at that hour (or another teacher's name on it) is a
// FREE period — `free: true` — which is what the school asked to see as “leisure”.
// The name is matched case-insensitively and forgivingly, because the office types
// it into a text box: “R. jha”, “Ritu jha” and “RITU JHA” all find the same teacher.
//
// `nameVariants(fullName)` builds the family of names that match him; the office's
// own typing is the data, so the match has to be as forgiving as typing is loose.
function nameVariants(fullName) {
  const raw = String(fullName || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return [];
  const set = new Set([raw]);
  // initials: “Ritu jha” → “r jha”, “r. jha”, “r.jha”
  const words = raw.split(' ');
  if (words.length >= 2) {
    const last = words[words.length - 1];
    const initials = words.slice(0, -1).map(w => w[0]).join('');
    set.add(`${initials} ${last}`);
    set.add(initials.split('').join('. ') + ' ' + last);
    set.add(initials.split('').join('.') + '. ' + last);
    set.add(initials.split('').join('.') + '.' + last);
    // surname first: “jha, ritu” / “jha ritu”
    set.add(`${last} ${words.slice(0, -1).join(' ')}`);
  }
  return [...set].filter(Boolean);
}

/** Does a timetable row's teacher field name THIS teacher? (forgiving, case-insensitive) */
function rowNamesTeacher(rowTeacher, fullName) {
  const cell = String(rowTeacher || '').trim().toLowerCase();
  if (!cell) return false;
  const variants = nameVariants(fullName);
  // the cell may also carry the class after the name — “Ritu jha (10 A)” — so a
  // variant sitting at the START of the cell counts too
  return variants.some(v => cell === v || cell.startsWith(v + ' ') || cell.startsWith(v + ' (') || cell.startsWith(v + ','));
}

/**
 * One teacher's whole week, built from the office's class timetables.
 *
 * Returns `{ week, days, periods, count, free }` where `week[day][period]` is either
 *   `{ busy: true,  classId, classLabel, subject, kind, from, to, timeLabel, emoji, color }`
 * or `{ busy: false, from, to, timeLabel }`  ← a FREE period (the school's “leisure”).
 * The hour runs from the class's own rows: a period the teacher is free in but that
 * exists on the classes' grids still shows its clock time — leisure at a known hour.
 * Breaks (assembly · lunch · games) are NOT the teacher's work and are skipped: the
 * whole school is at lunch together, so they never read as his periods or as leisure.
 *
 * The optional second argument carries the school's OTHER work for this teacher — lunch duty
 * and extra classes, already read and decorated by `services/duties.js`. A duty takes its slot
 * (never “Leisure”, and it counts as work), and it may sit at an hour none of his classes runs —
 * that hour then joins his day, so the card shows with its clock time.
 */
function forTeacher(teacher, dutyRows) {
  const classIds = (teacher && teacher.classIds) || [];
  const fullName = (teacher && teacher.fullName) || '';
  const days = DAYS;
  const week = {};
  for (const d of days) week[d] = {};
  const periodsSet = new Set();
  let count = 0;

  const rows = classIds.length ? db.prepare(`
    SELECT t.class_id, c.name class_name, c.section, t.day, t.period, t.subject, t.teacher, t.kind
    FROM timetable t JOIN classes c ON c.id = t.class_id
    WHERE t.class_id IN (${classIds.map(() => '?').join(',')})
    ORDER BY t.period`).all(...classIds) : [];

  const times = timeByPeriod();
  const busyAt = {};                      // day -> period -> {…}
  // ---- the break his classes run (school's ask, 2026-09-20) ------------------------------
  // the school's report that a teacher's lunch break was never mentioned — it belongs to no teacher,
  // and it used to read “Leisure” on his own week, as if he were simply free (or as if the
  // school ran no break at all). `breakSeen` counts, per day and per KIND (assembly · short
  // break · lunch · games…), how many of his classes take that break in each period; the hour
  // they mostly share becomes the break his own day shows. That count matters: one class that
  // lunches a period late (Class 2 at 12:50) must not put a SECOND “Lunch break” on his day.
  const breakSeen = {};
  // ---- the school's other work (2026-09-20) --------------------------------------------
  // Lunch duty and extra classes cannot come out of a class grid (a break belongs to nobody),
  // so the caller passes them in — already read and decorated by services/duties.js. A duty
  // period is HIS period: it takes the slot, counts as work, and is never “Leisure”.
  const duties = Array.isArray(dutyRows) ? dutyRows : ((dutyRows && dutyRows.rows) || []);
  const dutyAt = {};
  for (const d of duties) {
    if (!d || !DAYS.includes(d.day)) continue;
    if (!dutyAt[d.day]) dutyAt[d.day] = {};
    dutyAt[d.day][d.period] = d;
    periodsSet.add(d.period);
    count += 1;
  }
  for (const r of rows) {
    periodsSet.add(r.period);
    const meta = kindMeta(r.kind);
    if (meta.break) {
      // a break is nobody's period — but his day still SHOWS it, by its own name
      if (!breakSeen[r.day]) breakSeen[r.day] = {};
      if (!breakSeen[r.day][meta.key]) breakSeen[r.day][meta.key] = { meta, at: {} };
      const at = breakSeen[r.day][meta.key].at;
      at[r.period] = (at[r.period] || 0) + 1;
      continue;
    }
    const mine = rowNamesTeacher(r.teacher, fullName);
    const t = times.get(r.period);
    if (!busyAt[r.day]) busyAt[r.day] = {};
    if (mine) {
      count += 1;
      busyAt[r.day][r.period] = {
        busy: true,
        classId: r.class_id,
        classLabel: [r.class_name, r.section].filter(Boolean).join(' '),
        subject: r.subject,
        kind: meta.key,
        kindLabel: meta.label,
        from: t ? t.from : '', to: t ? t.to : '',
        timeLabel: t ? t.label : '',
        emoji: subjectStyle(r.subject).emoji,
        color: subjectStyle(r.subject).color,
      };
    }
  }

  // The break his own day shows: per day and per kind, the period MOST of his classes share.
  // A tie keeps them all, and each kind stands on its own — so an assembly in the morning and
  // the lunch stay two separate cards, while the odd late lunch of one class drops out.
  const breakAt = {};
  for (const d of Object.keys(breakSeen)) {
    breakAt[d] = {};
    for (const k of Object.keys(breakSeen[d])) {
      const { meta, at } = breakSeen[d][k];
      const best = Math.max(...Object.values(at));
      for (const p of Object.keys(at)) {
        if (at[p] !== best) continue;
        breakAt[d][p] = {
          kind: meta.key, kindLabel: meta.label, kindNote: meta.note || '',
          emoji: meta.emoji, color: meta.color,
        };
      }
    }
  }

  // every hour that exists on any of his classes' grids becomes a row of his day —
  // busy where his name is written, FREE everywhere else (the school's “leisure”)
  const hourPeriods = [...periodsSet].sort((a, b) => a - b);
  for (const d of days) {
    for (const p of hourPeriods) {
      const t = times.get(p);
      const duty = dutyAt[d] && dutyAt[d][p];
      const brk = breakAt[d] && breakAt[d][p];
      week[d][p] = duty
        ? {
          busy: true,
          duty: true,
          kind: duty.kind,
          kindLabel: duty.kindLabel,
          emoji: duty.emoji,
          color: duty.color,
          label: duty.label,
          className: duty.className || '',
          subject: duty.subject || '',
          from: t ? t.from : '', to: t ? t.to : '', timeLabel: t ? t.label : '',
        }
        : (busyAt[d] && busyAt[d][p]
          ? busyAt[d][p]
          : (brk
            // the school's break: named on his day, counted as neither work nor a free hour
            ? {
              busy: false, break: true, kind: brk.kind, kindLabel: brk.kindLabel,
              kindNote: brk.kindNote, emoji: brk.emoji, color: brk.color,
              from: t ? t.from : '', to: t ? t.to : '', timeLabel: t ? t.label : '',
            }
            : { busy: false, from: t ? t.from : '', to: t ? t.to : '', timeLabel: t ? t.label : '' }));
    }
  }

  // how many FREE hours the week has (shown on the profile's glance chip). The school's
  // breaks are neither his work nor a spare hour, so they are left out of it.
  let breaks = 0;
  for (const d of days) {
    for (const p of hourPeriods) if (week[d][p] && week[d][p].break) breaks += 1;
  }
  const totalHours = days.length * hourPeriods.length;
  const free = Math.max(0, totalHours - count - breaks);
  return { week, days, periods: hourPeriods, count, breaks, free, totalHours };
}

module.exports = {
  DAYS, SHORT, DEFAULT_PERIOD_TIMES,
  KINDS, KIND_KEYS, kindMeta, isBreakKind,
  // `to24` is the public name of normaliseTime: "8:00 am" / "08:00" → "08:00",
  // '' when the text is not a time at all (routes use it to validate input).
  to24: normaliseTime,
  normaliseTime, timeLabel, timeRange,
  getPeriodTimes, savePeriodTimes, setPeriodTime, removePeriodTime, timeByPeriod,
  weekStrip, sundayOfWeek, todayName, todayLabel, nextSchoolDay, dayPeriods, countsByDay, weekGrid,
  periodRows, slot, saveSlot, deleteSlot, deletePeriod, resetClass, copyDayToAll,
  teacherClash, busyMap, clashMessage,
  forTeacher, nameVariants, rowNamesTeacher,
  subjectStyle,
};
