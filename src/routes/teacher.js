/**
 * ============================================================================
 * Teacher portal — /teacher
 * ============================================================================
 *
 * A teacher signs in with the username/password the school office sets. Two rules
 * decide everything they can (and cannot) do:
 *
 *   1. `requireTeacher()` — the login exists AND the office has left it switched
 *      on (`teachers.can_login`). Switching it off kills the teacher's open
 *      session on their very next click, because the row is re-read every request.
 *   2. `requirePerm('<section>')` — the office granted that one section
 *      (`teacher_permissions`). No grant → 403 with a plain-English sentence, and
 *      the link is not printed in the sidebar at all.
 *
 * On top of both, **the office picks the classes he may work on** (own class, a few
 * ticked classes, or all classes — see `teacher_class_access` /
 * `teachers.all_classes`) and `withClass()` turns a request into exactly ONE of
 * them. Not one route below reads a class id from the URL or the form, so a teacher
 * can never see or change a class the office did not give him — even if a grant is
 * wrong. A teacher with more than one class gets a class picker at the top of every
 * page.
 *
 * The list of sections itself lives in `src/services/permissions.js`, and the
 * marks grid, the totalling and the result PDF are shared with the office through
 * `src/services/marks_sheet.js`, so the two sides can never disagree.
 */
const express = require('express');
const db = require('../db');
const v = require('../services/validate');
const perm = require('../services/permissions');
const msg = require('../services/messages');
const staffMsg = require('../services/staff_messages');   // the office's letters TO him (2026-09-20)
const tt = require('../services/timetable');
const examSvc = require('../services/exam_timetable'); // exam date-sheet (timetable paused)
const hold = require('../services/holidays');           // the days the school is shut besides Sunday
const hw = require('../services/homework');              // what was given, period by period (2026-09-18)
const duties = require('../services/duties');            // lunch duty & extra classes the office handed out
const time = require('../services/time');               // the school's own (IST) calendar day
const feeLedger = require('../services/fees');
const marksSheet = require('../services/marks_sheet');
const analysisSvc = require('../services/analysis');   // results as rings (shared with the office)
const config = require('../config');
const { requireTeacher, requirePerm, requirePermOpen, withClass } = require('../middleware/auth');

const router = express.Router();
router.use(requireTeacher());
// resolves WHICH class the page is about (office's class grant) onto req.classRoom
router.use(withClass());
// The badge on his Messages tab (sidebar and bottom bar both read it): how many letters from
// the office he has not opened yet. One small indexed count per page — the same idea as the
// office's own dock, one role over. Read-only here; the office is the only writer
// (services/staff_messages.js).
router.use((req, res, next) => {
  res.locals.staffUnread = staffMsg.unreadCount(req.session.user && req.session.user.id);
  next();
});

const TOPPER_PHOTO_MAX = 400000;
const TOPPER_RANKS = 3;

/**
 * The class THIS page is about — resolved by `withClass()` out of the classes the
 * office granted. Never a class id taken straight from the URL or the form.
 */
const viewClass = (req) => req.classRoom;
const getExams = () => db.prepare('SELECT * FROM exams ORDER BY id').all();
const noticesSvc = require('../services/notices');   // same list the parent portal reads
/**
 * The SAME list a parent reads — services/notices.js is the one filter. Any limit is a
 * plain Array slice on top, so the dashboard's “last 3” and the full page can never
 * disagree about what is in the list.
 */
const noticesFor = (classId, limit = null) => {
  const rows = noticesSvc.forClass(classId);
  return limit ? rows.slice(0, limit) : rows;
};

// ================= DASHBOARD =================
router.get('/', (req, res) => {
  const t = req.teacher;
  const cl = viewClass(req);
  const students = marksSheet.studentsOf(cl.id);
  const subjects = marksSheet.subjectsOf(cl.id);
  const exams = getExams();
  const today = tt.todayName();
  const todayPeriods = today ? tt.dayPeriods(cl.id, today) : [];

  const can = (key) => perm.has(t.id, key);
  // the school's notices reach EVERY teacher (school's request, 2026-09-19: the dashboard
  // shows the last three under At a glance + a “See all”) — reading notices is not a grant-
  // gated power; only the dedicated page's extra powers are. 3 here, the rest on /teacher/notices.
  const notices = noticesFor(cl.id, 3);
  const feeSummary = can('fees') ? feeLedger.summary({ classId: cl.id }) : null;
  const topperCount = can('toppers')
    ? db.prepare('SELECT COUNT(*) c FROM class_toppers WHERE class_name = ?').get(cl.name).c
    : 0;
  const lastResult = can('marks') ? db.prepare(`
    SELECT pr.published_at, e.term, e.year FROM published_results pr
    JOIN exams e ON e.id = pr.exam_id
    WHERE pr.class_id = ? ORDER BY pr.published_at DESC LIMIT 1`).get(cl.id) : null;

  res.render('teacher/dashboard', {
    title: 'Teacher Dashboard',
    cls: { label: cl.label, name: cl.name, section: cl.section },
    // the same cards his My Profile page prints, straight under the page title
    ...perm.profileFor(t),
    // …but the login chip rides beside the title here (school's request), not in the login card
    credInHeader: true,
    // …and the dashboard stays SHORT (school's request, 2026-09-19): only the hero + assign
    // strip + At a glance card, then the timetable panel. The 🔑 login, 🎓 record, 🏫 classes
    // and 🗓 week cards live on the My Profile page alone.
    dashboardOnly: true,
    students, subjects, exams, today, todayPeriods,
    notices, feeSummary, topperCount, lastResult,
    sections: perm.navFor(t.id),
    permCount: res.locals.teacherPerms.length,
    permTotal: perm.KEYS.length,
    // tonight's date/timings read from the same helpers every other page uses
    todayLabel: tt.todayLabel(),
    timeByPeriod: tt.timeByPeriod(),
    saved: req.query.saved,
  });
});

/**
 * MY PROFILE — **read-only, and that is the whole point.**
 *
 * A teacher sees the record the school office keeps for him: photo, name, class he is
 * class-teacher of, subject, phone, qualification, experience, rating, bio, his login
 * name, whether that login is switched on, the classes his login may work on, and every
 * portal section with “Open” or “Closed” against it.
 *
 * There is **no form on this page and no POST route behind it** — not one field is his to
 * change. The teacher row, the class grant (`teacher_class_access` / `all_classes`), the
 * login switch (`can_login`) and the section grants (`teacher_permissions`) are all
 * written from Admin → Teachers / Teacher Access only. His readable password is NOT
 * printed here either (the office keeps that copy for handing out), so a shoulder in the
 * staff room can never read it off his screen.
 *
 * It needs no permission of its own: it is his own data, so it stays open even for a
 * teacher whose every section is still switched off.
 */
/**
 * THE EYE on the login card — his own credentials, on request.
 *
 * The school asked (2026-09-18) for the login name and password at the card's top-right with an
 * eye to read the password. The password is deliberately NOT part of the rendered page: the card
 * ships dots only, and this one endpoint answers the tap, with `no-store` so neither the browser
 * nor a proxy keeps a copy. It is his OWN password (the readable copy the office keeps to hand
 * over in `teachers.portal_password`), and it answers `password: null` when the office stored
 * none — the card then says “Ask the office” instead of showing nothing.
 *
 * Note it reads nothing from the request body: no field here is writable (see `/profile`).
 */
router.get('/login.json', (req, res) => {
  const t = req.teacher;
  res.set('Cache-Control', 'no-store');
  res.json({
    username: t.username,
    password: t.portal_password || null,
    canLogin: !!t.can_login,
  });
});

// ================= THE 🔔 ON HIS CARD — what has ARRIVED from the office =================
// The hero card carries a bell (partials/teacher_profile_cards.ejs). This one endpoint is
// what the bell's script polls (public/js/teacher-bell.js): the school's unread messages
// for HIS classes, so the count is live without a reload and a NEW one rings aloud —
// exactly what the office's own dock (admin-alerts.js + office-feed.json) does, one role over.
// It answers his own data only, so like /login.json it needs no section permission.
router.get('/alerts.json', (req, res) => {
  const t = req.teacher;
  const classIds = perm.classesFor(t).map((c) => c.id);
  const unread = classIds.length
    ? db.prepare(`
        SELECT COUNT(DISTINCT m.parent_user_id) c
        FROM messages m
        JOIN students s ON s.parent_user_id = m.parent_user_id
        WHERE m.direction = 'to_parent' AND m.status = 'unread'
          AND s.class_id IN (${classIds.map(() => '?').join(',')})`).get(...classIds).c
    : 0;
  const latest = classIds.length ? db.prepare(`
      SELECT m.id, m.subject, m.category, m.created_at, u.full_name AS sent_by
      FROM messages m
      JOIN students s ON s.parent_user_id = m.parent_user_id
      LEFT JOIN users u ON u.id = s.parent_user_id
      WHERE m.direction = 'to_parent' AND m.status = 'unread'
        AND s.class_id IN (${classIds.map(() => '?').join(',')})
      ORDER BY m.id DESC LIMIT 1`).get(...classIds) : null;
  res.set('Cache-Control', 'no-store');
  res.json({
    unread,
    latest: latest ? {
      key: `m${latest.id}`,
      subject: latest.subject,
      category: latest.category,
      from: latest.sent_by || 'The school office',
      at: latest.created_at,
    } : null,
  });
});

router.get('/profile', (req, res) => {
  const t = req.teacher;
  res.render('teacher/profile', {
    title: 'My Profile',
    teacher: t,
    // one builder for every card, shared with the dashboard block (public partial)
    ...perm.profileFor(t),
  });
});

// ================= STUDENTS (own class, read-only) =================
// Every teacher may always view the names in the classes the office assigned; section
// permissions still control editing and other student actions.
router.get('/students/names.json', requirePermOpen('students'), (req, res) => {
  const cl = viewClass(req);
  const rows = db.prepare('SELECT id, full_name, roll_no FROM students WHERE class_id = ? ORDER BY roll_no').all(cl.id);
  res.set('Cache-Control', 'no-store').json({ class: cl.label, students: rows });
});

router.get('/students', requirePermOpen('students'), (req, res) => {
  const cl = viewClass(req);
  const students = db.prepare(`
    SELECT s.*, u.username FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.class_id = ? ORDER BY s.roll_no`).all(cl.id);
  const q = String(req.query.q || '').trim().slice(0, 40);
  const shown = q
    ? students.filter((s) => [s.full_name, s.admission_no, s.parent_name, s.parent_phone,
      s.father_name, s.mother_name, s.blood_group].some((x) => String(x || '').toLowerCase().includes(q.toLowerCase())))
    : students;
  res.render('teacher/students', {
    title: `Students — ${cl.label}`,
    cls: { label: cl.label, name: cl.name, section: cl.section },
    students: shown, total: students.length, q,
  });
});

// ---- HOMEWORK MARKS (2026-09-18): ✓ done / ✕ not done, child by child ------------------
// The school's ask: a child who comes without his homework gets a ✕ on the parents'
// timetable; one who did it and says so gets a ✓; a child nobody marked shows NOTHING.
// The marker page is the child's own homework day — the teacher may only open children
// of a class the office granted (withClass()), never an id from the URL.
router.get('/students/:id(\\d+)/homework', requirePerm('students'), withClass(), (req, res) => {
  const cl = viewClass(req);
  const student = db.prepare('SELECT * FROM students WHERE id = ? AND class_id = ?').get(req.params.id, cl.id);
  if (!student) return res.status(404).render('error', { message: 'Student not found in your class.', code: 404 });
  const day = tt.DAYS.includes(req.query.day) ? req.query.day : tt.todayName() || 'Monday';
  const dayPeriods = tt.dayPeriods(cl.id, day).filter((p) => !p.isBreak);
  res.render('teacher/student_homework', {
    title: `Homework — ${student.full_name}`,
    hwStudent: student,
    hwClassId: cl.id,
    hwDay: day,
    hwToday: tt.todayName(),
    hwPeriods: dayPeriods.map((p) => ({ period: p.period, subject: p.subject, emoji: p.emoji })),
    hwPeriodNotes: hw.forDay(cl.id, day),
    hwStatuses: hw.statusesForDay(student.id, day),
    hwBase: `/teacher/students/${student.id}/homework`,
    hwMarked: req.query.marked || '', hwCleared: req.query.cleared === '1',
  });
});

router.post('/students/:id(\\d+)/homework/:period(\\d+)', requirePerm('students'), withClass(), (req, res) => {
  const cl = viewClass(req);
  const student = db.prepare('SELECT id FROM students WHERE id = ? AND class_id = ?').get(req.params.id, cl.id);
  const c = v.checker();
  const day = c.choice(req.body.day, 'Day', tt.DAYS);
  const period = c.int(req.params.period, 'Period', { min: 1, max: 12 });
  const status = req.body.status === 'done' ? 'done' : 'not_done';
  const back = (q) => res.redirect(`/teacher/students/${req.params.id}/homework?class=${cl.id}` + (q ? `&${q}` : ''));
  if (!student || !c.ok) return back();
  hw.setStatus({ studentId: student.id, day, period, status, markedBy: req.session.user.full_name || '' });
  return back(`marked=${period}&day=${encodeURIComponent(day)}`);
});

router.post('/students/:id(\\d+)/homework/:period(\\d+)/clear', requirePerm('students'), withClass(), (req, res) => {
  const cl = viewClass(req);
  const student = db.prepare('SELECT id FROM students WHERE id = ? AND class_id = ?').get(req.params.id, cl.id);
  const c = v.checker();
  const day = c.choice(req.body.day, 'Day', tt.DAYS);
  const period = c.int(req.params.period, 'Period', { min: 1, max: 12 });
  if (student && c.ok) hw.clearStatus({ studentId: student.id, day, period });
  res.redirect(`/teacher/students/${req.params.id}/homework?class=${cl.id}&cleared=1&day=${encodeURIComponent(day || '')}`);
});

// ================= MARKS / RESULTS (own class) =================
router.get('/marks', requirePerm('marks'), (req, res) => {
  const cl = viewClass(req);
  const exams = getExams();
  // the latest exam is pre-picked, so a teacher who opens the page can start typing
  const examId = parseInt(req.query.exam, 10) || (exams.length ? exams[exams.length - 1].id : 0);
  const { students, subjects, byStudent } = marksSheet.sheet(cl.id, examId);
  const rows = marksSheet.withTotals(students, subjects, byStudent);
  const full = marksSheet.fullMarks(subjects);
  const published = examId
    ? db.prepare('SELECT published_at FROM published_results WHERE class_id = ? AND exam_id = ?').get(cl.id, examId)
    : null;
  res.render('teacher/marks', {
    title: `Marks — ${cl.label}`,
    cls: { label: cl.label, name: cl.name, section: cl.section },
    exams, examId, students, subjects, rows, full,
    // how the class is doing, as circles — the same service the office & parents read
    analysis: analysisSvc.forClass(cl.id, { examId }),
    submitted: examId ? students.some((s) => byStudent.get(s.id)) : false,
    published: published ? published.published_at : null,
    saved: req.query.saved, bad: req.query.bad,
  });
});

router.post('/marks', requirePerm('marks'), (req, res) => {
  // the class comes from the office's grant (`withClass`), never straight from the form
  const cl = viewClass(req);
  const c = v.checker();
  const examId = c.id(req.body.exam_id, 'Exam');
  if (!c.ok) return res.redirect(`/teacher/marks?class=${cl.id}`);
  if (!db.prepare('SELECT 1 FROM exams WHERE id = ?').get(examId)) {
    return res.status(400).render('error', { message: 'That exam does not exist.', code: 400 });
  }
  // A result is read-only once the office publishes it — the parents have already
  // been alerted, so a later silent edit would change a number a family has seen.
  const published = db.prepare('SELECT 1 FROM published_results WHERE class_id = ? AND exam_id = ?')
    .get(cl.id, examId);
  if (published) {
    return res.status(403).render('error', {
      message: 'This result has already been published to parents, so it cannot be changed. Please contact the school office.',
      code: 403,
    });
  }
  const { badCells } = marksSheet.saveMarks({ classId: cl.id, examId, marks: req.body.marks });
  const q = new URLSearchParams({ exam: String(examId), saved: '1', class: String(cl.id) });
  if (badCells.length) q.set('bad', String(badCells.length));
  res.redirect(`/teacher/marks?${q}`);
});

// the same A4 result sheet the office prints
router.get('/marks/export.pdf', requirePerm('marks'), (req, res) => {
  const cl = viewClass(req);
  const examId = parseInt(req.query.exam, 10) || 0;
  const report = marksSheet.resultSheet({ classId: cl.id, examId });
  if (!report) {
    return res.status(404).render('error', { message: 'Pick an exam first, then download the result sheet.', code: 404 });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${report.fileBase}.pdf"`);
  res.setHeader('Content-Length', report.buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(report.buffer);
});

// ================= CLASS TOPPERS (the class open on this page) =================
// The office group toppers by class NAME ("Class 9"), which is the name of the class
// the teacher picked — so a teacher edits that card and nobody else's.
router.get('/toppers', requirePerm('toppers'), (req, res) => {
  const cl = viewClass(req);
  const rows = db.prepare('SELECT * FROM class_toppers WHERE class_name = ? ORDER BY rank_no').all(cl.name);
  const byRank = new Map(rows.map((r) => [r.rank_no, r]));
  const ranks = [];
  for (let i = 1; i <= TOPPER_RANKS; i++) {
    const r = byRank.get(i) || null;
    ranks.push({ rank: i, name: r ? r.name : '', percentage: r ? r.percentage : '', photo: r ? r.photo : null });
  }
  const classNames = db.prepare('SELECT name FROM classes ORDER BY id').all().map((c) => c.name);
  res.render('teacher/toppers', {
    title: `Class Toppers — ${cl.label}`,
    cls: { label: cl.label, name: cl.name, section: cl.section },
    ranks,
    onWebsite: classNames.includes(cl.name),
    flash: { saved: req.query.saved, error: req.query.error || null },
  });
});

router.post('/toppers', requirePerm('toppers'), (req, res) => {
  const cl = viewClass(req);
  const back = (qs) => res.redirect(`/teacher/toppers?class=${cl.id}&${qs}`);
  const asList = (x) => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
  const c = v.checker();
  const names = asList(req.body.name);
  const pcts = asList(req.body.percentage);
  const photos = asList(req.body.photo);
  const removals = asList(req.body.removePhoto);

  const rows = db.prepare('SELECT * FROM class_toppers WHERE class_name = ? ORDER BY rank_no').all(cl.name);
  const byRank = new Map(rows.map((r) => [r.rank_no, r]));
  const baseSort = rows.length
    ? rows[0].sort_order
    : (db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM class_toppers').get().m + 1);

  const plan = [];
  const errors = c.errors;
  for (let i = 0; i < TOPPER_RANKS; i++) {
    const rankNo = i + 1;
    const name = c.text(names[i], `Rank ${rankNo} name`, { max: 80 }).replace(/\s+/g, ' ');
    const existing = byRank.get(rankNo) || null;
    if (!name) { plan.push({ rankNo, remove: true, existing }); continue; }
    // keep the exact percentage typed, decimals included (97.1 stays 97.1)
    const rawPct = c.amount(pcts[i], `Rank ${rankNo} percentage`, { min: 0, max: 100, fallback: 0 });
    const pct = Math.round((rawPct === null ? 0 : rawPct) * 100) / 100;
    let photo = existing ? existing.photo : null;
    if (String(removals[i] || '') === '1') photo = null;
    else if (String(photos[i] || '').trim()) {
      const clean = c.image(photos[i], `Rank ${rankNo} photo`, { max: TOPPER_PHOTO_MAX });
      if (clean) photo = clean;
    }
    plan.push({ rankNo, name, pct, photo, remove: false, existing });
  }

  if (!plan.some((p) => !p.remove)) {
    return back('error=' + encodeURIComponent('Please keep at least one topper — or leave every name blank to remove the card.'));
  }
  if (errors.length) return back('error=' + encodeURIComponent(errors.join(' ')));

  const del = db.prepare('DELETE FROM class_toppers WHERE id = ?');
  const upd = db.prepare('UPDATE class_toppers SET name = ?, percentage = ?, photo = ? WHERE id = ?');
  const ins = db.prepare('INSERT INTO class_toppers (class_name, rank_no, name, percentage, photo, sort_order) VALUES (?,?,?,?,?,?)');
  try {
    db.transaction(() => {
      for (const p of plan) {
        if (p.remove) { if (p.existing) del.run(p.existing.id); continue; }
        if (p.existing) upd.run(p.name, p.pct, p.photo, p.existing.id);
        else ins.run(cl.name, p.rankNo, p.name, p.pct, p.photo, baseSort);
      }
    })();
  } catch (err) {
    return back('error=' + encodeURIComponent('Could not save — ' + err.message));
  }
  back('saved=1');
});

// ================= TIMETABLE (the class open on this page) =================
// Timetable is the ONE page every teacher keeps, granted or not (school's request,
// 2026-09-19): reading his week costs nothing, and the bottom bar's second icon must
// always work. `requirePermOpen` runs the SAME render and just says (next(false))
// whether the homework editor may be written — everything else on the page is the
// office's own grid, already read-only.
router.get('/timetable', requirePermOpen('timetable'), (req, res) => {
  const cl = viewClass(req);
  const canTimetable = res.locals.permOpen !== false;   // false = read-only flavour
  const days = tt.DAYS;
  // the same week grid and day helpers the office and the parent portal use
  const { grid, periods } = tt.weekGrid(cl.id);
  // ---- holidays, the same as the parents see (2026-09-17) ----------------------------
  // Sunday is a holiday without a row; a festival is a row the office adds on
  // Admin → Holidays. Every day of the strip carries its date and its holiday, so the day
  // strip marks a closed day and the card below says why. Never look a date up in a view.
  const strip = hold.mark(tt.weekStrip());
  const sunday = hold.mark([tt.sundayOfWeek()])[0];
  const today = tt.todayName();                 // '' on Sunday (school closed)
  // A rolling seven-date window keeps today in the centre: three dates before,
  // today, and three dates after. It rebuilds from IST on every request, so the
  // window advances automatically each morning.
  const centreISO = time.todayISO();
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekdayShort = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const centreDate = new Date(`${centreISO}T00:00:00Z`);
  const dateStrip = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(centreDate);
    d.setUTCDate(d.getUTCDate() + i - 3);
    const iso = d.toISOString().slice(0, 10);
    const state = hold.dayState(iso);
    return {
      iso, name: weekdayNames[d.getUTCDay()], short: weekdayShort[d.getUTCDay()],
      date: d.getUTCDate(), long: state.long, isToday: iso === centreISO,
      holiday: state.holiday, isClosed: state.isClosed, holidayName: state.name,
    };
  });
  const isSunday = !today;
  const todayEntry = today ? (strip.find((d) => d.isToday) || null) : sunday;
  const chosen = req.query.day === 'Sunday' ? 'Sunday' : (days.includes(req.query.day) ? req.query.day : '');
  // The rolling strip is the date source for selected days. Using the weekly class strip here
  // loses the actual date (especially on Sunday) and can label a future day as past.
  const viewing = chosen ? ([...dateStrip, sunday].find((d) => d.name === chosen) || null) : todayEntry;
  const day = (viewing && viewing.name) || today || 'Monday';
  const selected = dateStrip.find((d) => d.name === day) || null;
  const showingHoliday = !!(viewing && viewing.isClosed) || (isSunday && !chosen);
  const holidayCard = showingHoliday ? {
    name: (viewing && viewing.holidayName) || 'Sunday',
    greeting: viewing && viewing.holiday ? viewing.holiday.greeting : '',
    note: viewing && viewing.holiday ? viewing.holiday.note : '',
    isToday: !!(viewing && viewing.isToday),
    label: viewing ? viewing.long : tt.todayLabel(),
    isSunday: !!(viewing && viewing.name === 'Sunday'),
  } : null;
  const openAgain = hold.nextOpenDay({ from: (viewing && viewing.iso) || time.todayISO() });
  // ---- HIS day (2026-09-19): only the periods that carry HIS name --------------------
  // The school asked for a teacher page that shows the teacher's OWN timetable — the
  // class grid's other rows are somebody else's work. `tt.forTeacher` (the same engine
  // the 🗓 My week card reads) marks busy where his name sits on the grid and FREE
  // (leisure) everywhere else; this route picks just the busy slots of the day on screen.
  // HIS week is built from EVERY class grid the office may give him (the admin's class
  // scope) — the school's ask: build the teachers' timetables by teacher NAME, keeping the
  // children's class grid out of them. One name scan across LKG…Class 10 finds his hours; the rest are
  // leisure. (Only the class grid editor below stays on the class in view.)
  const myClassIds = perm.classesFor(req.teacher).map((c) => c.id);
  // his OTHER work too (school's request, 2026-09-20): lunch duty and extra classes the office
  // handed out — a break belongs to no class grid, so those rows can only come from
  // services/duties.js, and they take their slot in his week like any period.
  const myDuties = duties.forTeacher(req.teacher.full_name);
  const myWeek = tt.forTeacher({ classIds: myClassIds, fullName: req.teacher.full_name }, myDuties.rows);
  const myDay = showingHoliday ? {} : (myWeek.week[day] || {});
  // busy entries grouped by period — one period may carry him in two classes only if
  // the office ever double-books; each entry still shows its own class label
  const busyByPeriod = {};
  for (const p of Object.keys(myDay).map(Number)) {
    if (myDay[p] && myDay[p].busy) (busyByPeriod[p] = busyByPeriod[p] || []).push({ ...myDay[p], period: p });
  }
  // the clock decides the order (7:20 → 8:10 → …), not the period number — a day reads
  // like a timeline even if the office ever numbers the periods unusually
  const startOf = (p) => {
    const t = tt.timeByPeriod().get(p);
    return t ? (t.from || '') : '';
  };
  const byClock = (a, b) => (startOf(a) || '99').localeCompare(startOf(b) || '99') || a - b;
  const myPeriods = Object.keys(busyByPeriod).map(Number).sort(byClock)
    .flatMap((p) => busyByPeriod[p]);
  const myDayBusyCount = Object.keys(busyByPeriod).length;
  // HIS free hours on the day on screen — the periods the school runs but no class of
  // his has. A BREAK is not one of them (the school asked for the break to be NAMED on
  // his own week, 2026-09-20: the school's lunch break was not mentioned on it at all),
  // so it gets a card of its own and never reads as a spare hour. Both are arranged BY
  // THE CLOCK, together with his periods.
  const myDayBreakSlots = Object.keys(myDay).map(Number)
    .filter((p) => myDay[p] && myDay[p].break)
    .sort(byClock)
    .map((p) => ({ period: p, ...myDay[p] }));
  const myDayFreeSlots = Object.keys(myDay).map(Number)
    .filter((p) => myDay[p] && !myDay[p].busy && !myDay[p].break)
    .sort(byClock)
    .map((p) => ({ period: p, timeLabel: myDay[p].timeLabel || '' }));
  const myDayFree = myDayFreeSlots.length;
  // One timeline for the teacher: his periods, the school's breaks and his Leisure hours
  // share the same clock order, so nothing gets pushed into a block at the bottom. Inside
  // one period his own period wins over the break, then the break, then Leisure.
  const rank = (t) => (t === 'busy' ? 0 : (t === 'break' ? 1 : 2));
  const myTimeline = [
    ...myPeriods.map((p) => ({ type: 'busy', ...p })),
    ...myDayBreakSlots.map((b) => ({ type: 'break', ...b })),
    ...myDayFreeSlots.map((f) => ({ type: 'free', ...f })),
  ].sort((a, b) => byClock(a.period, b.period) || (rank(a.type) - rank(b.type)));
  // HIS period count per day — the day chips show this, not the class grid's counts
  const myPeriodsPerDay = {};
  for (const dName of myWeek.days) {
    const dSlots = myWeek.week[dName] || {};
    myPeriodsPerDay[dName] = Object.keys(dSlots).map(Number).filter((p) => dSlots[p] && dSlots[p].busy).length;
  }
  // the homework editor writes into the CLASS IN VIEW's grid (hw.setNote is keyed by
  // class) — so its rows list only the periods of that class, not every class his week
  // touches. The picker above switches the class; the rows follow it.
  const myPeriodsThisClass = myPeriods.filter((p) => p.classLabel === cl.label);
  // the SAME grid every class of his follows, Monday → Saturday, FREE hours included —
  // a period without his name shows as leisure, so the page reads as HIS week
  const myWeekGrid = myWeek;
  // ---- THE OFFICE MAY HAND THE PEN (2026-09-19) --------------------------------
  // “if the admin is busy he assigns a teacher to update the timetable” — the timetable
  // grant IS that assignment: with it the editor on this page writes the class grid
  // (subject · teacher pick list), and the staff pick list comes from the real teachers.
  const staffNames = db.prepare(`
    SELECT DISTINCT u.full_name AS name FROM teachers t
    JOIN users u ON u.id = t.user_id WHERE t.can_login = 1
    ORDER BY name`).all().map((r) => r.name);
  res.render('teacher/timetable', {
    title: 'Your Timetable',
    cls: { label: cl.label, name: cl.name, section: cl.section },
    days, shorts: tt.SHORT, grid, periods, kinds: tt.KINDS,
    strip, dateStrip, sunday, selected,
    // the day on screen as the holiday service sees it (Sunday included) — the day chips
    // mark the tapped one from this
    viewing,
    today, day, isSunday, showingHoliday, holidayCard, openAgain,
    holidayIsToday: !!(holidayCard && holidayCard.isToday),
    holidayLabel: holidayCard ? holidayCard.label : '',
    // (the “coming holidays” list belongs to the parents' page alone — a class teacher reads the
    // holiday card and the day strip here, and `services/holidays.js` answers him from the same
    // row the office wrote)
    todayISO: time.todayISO(),
    todayPeriods: showingHoliday ? [] : tt.dayPeriods(cl.id, day),
    viewingOtherDay: !!chosen && chosen !== today,
    timeByPeriod: tt.timeByPeriod(),
    periodsPerDay: tt.countsByDay(cl.id),
    nextSchoolDay: tt.nextSchoolDay(),
    // exam days: the office's date-sheet replaces the week grid (services/exam_timetable.js)
    exam: examSvc.forClass(cl.id),
    // HIS periods for the day on screen + his whole week (the day tabs show which days he teaches)
    myPeriods, myTimeline, myPeriodsThisClass, myDayBusyCount, myDayBreakSlots, myDayFreeSlots, myDayFree, myPeriodsPerDay, myWeek, myWeekGrid, staffNames,
    // homework written so far, keyed [day][period] — the editor shows what is on file and
    // the parent's timetable reads the SAME rows (services/homework.js)
    homeworkWeek: hw.forWeek(cl.id),
    canTimetable,
    homeworkSaved: req.query.saved === '1', homeworkCleared: req.query.cleared === '1',
    homeworkMissed: req.query.saved === '0',
    standingNote: hw.STANDING_NOTE,
  });
});

// ================= THE ONE-TAP HOMEWORK BOARD (2026-09-19) ==============================
// The school does not let teachers use phones, so opening one child at a time was too
// slow. This page shows the WHOLE CLASS at once, every child × every subject period of
// the day: one tap on a cell sets ✓ done, another sets ✕ not done, a third clears it.
// The tap goes to /teacher/homework/tap (JSON, no page reload) and the cell flips
// instantly — a day's round for the whole room takes seconds on a desktop.
router.get('/homework-board', requirePermOpen('students'), (req, res) => {
  const cl = viewClass(req);
  const today = tt.todayName() || 'Monday';            // Sunday: show Monday's list
  const day = tt.DAYS.includes(req.query.day) ? req.query.day : today;
  const periods = tt.dayPeriods(cl.id, day).filter((p) => !p.isBreak)
    .map((p) => ({ period: p.period, subject: p.subject, emoji: p.emoji }));
  const students = db.prepare(`
    SELECT s.id, s.full_name, s.roll_no, s.photo FROM students s
    WHERE s.class_id = ? ORDER BY s.roll_no`).all(cl.id);
  const marks = hw.statusesForClassDay(cl.id, day);
  const notDone = hw.notDoneForClassDay(cl.id, day);
  // roll the not-done list up per child: "Ravi — P2, P4"
  const notDoneByChild = {};
  for (const r of notDone) {
    if (!notDoneByChild[r.id]) notDoneByChild[r.id] = { name: r.full_name, roll: r.roll_no, periods: [] };
    notDoneByChild[r.id].periods.push(r.period);
  }
  res.render('teacher/homework_board', {
    title: `Homework board — ${cl.label}`,
    cls: { label: cl.label, name: cl.name, section: cl.section },
    boardDay: day, boardToday: today, boardPeriods: periods, boardStudents: students,
    boardMarks: marks, boardNotDone: notDoneByChild,
    boardMarkedBy: req.session.user.full_name || '',
    prevDay: tt.DAYS[Math.max(0, tt.DAYS.indexOf(day) - 1)] || null,
    nextDay: tt.DAYS[tt.DAYS.indexOf(day) + 1] || null,
  });
});

// one tap = one mark. JSON in, JSON out — the board flips the cell itself and never
// reloads, so marking a whole room is a column of taps, not a page each.
router.post('/homework/tap', requirePermOpen('students'), (req, res) => {
  const cl = viewClass(req);
  const c = v.checker();
  const studentId = c.id(req.body.student, 'Student');
  const day = c.choice(req.body.day, 'Day', tt.DAYS);
  const period = c.int(req.body.period, 'Period', { min: 1, max: 12 });
  // '' = clear (take the mark back), else 'done' | 'not_done'
  const status = req.body.status === 'done' ? 'done'
    : req.body.status === 'not_done' ? 'not_done' : '';
  if (!c.ok) return res.status(400).json({ ok: false, error: c.summary });
  // the child must really be in a class the office granted — never a guessed id
  const student = db.prepare('SELECT id FROM students WHERE id = ? AND class_id = ?').get(studentId, cl.id);
  if (!student) return res.status(404).json({ ok: false, error: 'Student not in your class.' });
  if (status === '') hw.clearStatus({ studentId, day, period });
  else hw.setStatus({ studentId, day, period, status, markedBy: req.session.user.full_name || '' });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, status, day, period, studentId });
});

// ================= HOMEWORK — write it where the timetable already is (2026-09-18) ======
// The school's ask: “the timetable should show what homework was given; teachers upload it
// from their portal, and if a teacher forgets to type the detail there must still be a line
// — homework given, please check the copy.” The editor lives ON the timetable page, one box
// per period of the day on screen; POSTs come back to the same day. A teacher only ever
// writes his OWN granted classes (`req.classRoom`) — never a class id from the form.
// Homework is always available to a signed-in teacher; the timetable grant only controls
// editing the office's period grid, not recording homework for parents.
router.post('/timetable/homework', requirePermOpen('timetable'), (req, res) => {
  const cl = viewClass(req);
  const c = v.checker();
  const day = c.choice(req.body.day, 'Day', tt.DAYS);
  const period = c.int(req.body.period, 'Period', { min: 1, max: 12 });
  const subject = c.text(req.body.subject, 'Subject', { max: 60 });
  const note = c.text(req.body.note, 'Homework note', { max: 300 });
  // Use the selected calendar date when the form provides it. Weekday indexes are not
  // enough on Sunday because tt.todayName() is intentionally empty on the school holiday.
  const selectedDate = c.dateISO(req.body.date, 'Date', { required: true });
  const todayISO = time.todayISO();
  const isPast = selectedDate ? selectedDate < todayISO
    : (!!tt.todayName() && tt.DAYS.indexOf(day) < tt.DAYS.indexOf(tt.todayName()));
  if (!c.ok || isPast) return res.redirect(`/teacher/timetable?saved=0&class=${cl.id}&day=${encodeURIComponent(day || '')}`);
  // the period must really exist in this class's grid — never invent a slot
  const slot = db.prepare('SELECT subject FROM timetable WHERE class_id = ? AND day = ? AND period = ?')
    .get(cl.id, day, period);
  if (!slot) return res.redirect(`/teacher/timetable?saved=0&class=${cl.id}&day=${encodeURIComponent(day)}`);
  hw.setNote({
    classId: cl.id, day, period,
    subject: subject || slot.subject,
    note,
    givenBy: req.session.user.full_name || '',
  });
  res.redirect(`/teacher/timetable?saved=1&class=${cl.id}&day=${encodeURIComponent(day)}`);
});

router.post('/timetable/homework/clear', requirePerm('timetable'), (req, res) => {
  const cl = viewClass(req);
  const c = v.checker();
  const day = c.choice(req.body.day, 'Day', tt.DAYS);
  const period = c.int(req.body.period, 'Period', { min: 1, max: 12 });
  const selectedDate = c.dateISO(req.body.date, 'Date', { required: true });
  const isPast = selectedDate && selectedDate < time.todayISO();
  if (c.ok && !isPast) hw.clearNote({ classId: cl.id, day, period });
  res.redirect(`/teacher/timetable?cleared=1&class=${cl.id}&day=${encodeURIComponent(day || '')}`);
});

// ================= THE OFFICE'S PEN: an assigned teacher edits the grid ==================
// “the admin is busy, so he assigns a teacher to update the timetable” — the timetable
// grant is that assignment in writing. The same slot the office saves (subject · teacher
// from the real staff list · kind), and only into the class he holds the grant for
// (`req.classRoom` — a class id from the form can never pick another class).
router.post('/timetable/slot', requirePerm('timetable'), (req, res) => {
  const cl = viewClass(req);
  const c = v.checker();
  const day = c.choice(req.body.day, 'Day', tt.DAYS, { required: true });
  const period = c.int(req.body.period, 'Period number', { min: 1, max: 12, required: true });
  const kind = c.choice(req.body.kind, 'Period type', tt.KIND_KEYS, { fallback: 'class' }) || 'class';
  const isBreak = tt.isBreakKind(kind);
  // A subject period must name its subject; a break carries a name of its own, so its box may be
  // left empty. The words say what to DO about it — the same sentence the office's own grid uses,
  // because with the grant on this IS the office's pen. (Measured 2026-09-20: the school hit
  // “Subject is required. Teacher is not valid — please pick again.” and the period could not be
  // saved at all.)
  const subject = isBreak
    ? c.text(req.body.subject, 'Name', { max: 60 })
    : c.text(req.body.subject, 'Subject', { max: 60 });
  if (!isBreak && !subject) {
    c.fail('Subject is required — write what this period teaches, or pick a break (a break needs none).');
  }
  const staffNames = db.prepare(`
    SELECT DISTINCT u.full_name AS name FROM teachers t
    JOIN users u ON u.id = t.user_id ORDER BY name`).all().map((r) => r.name);
  // The name must be a REAL staff name — or the one ALREADY standing on this very period. That
  // second way is what makes a period editable at all: the grid carries names from the imported
  // sheet that have no staff login yet, and refusing them left the office unable to type a
  // subject, hand the period to a real teacher, or park it. The refusal names both ways out
  // instead of the old flat “Teacher is not valid”.
  const standing = String((tt.slot(cl.id, day, period) || {}).teacher || '').trim();
  let teacher = '';
  if (!isBreak) {
    teacher = c.text(req.body.teacher, 'Teacher', { max: 60 });
    const allowed = staffNames.concat([standing, '']);
    if (teacher && !allowed.includes(teacher)) {
      c.fail('That teacher is not on the school staff list — pick a name from the pick list, '
        + 'or choose “— no teacher yet —” to leave the period without a teacher.');
      teacher = '';
    }
  }
  if (!c.ok || !day) return res.redirect(`/teacher/timetable?class=${cl.id}&sloterr=${encodeURIComponent(c.summary || 'Check the form')}`);
  // ONE TEACHER, ONE CLASS AT A TIME (school's rule, 2026-09-20): the same guard the office's
  // own grid uses, because the timetable grant makes this the office's pen. Only a CHANGE is
  // checked — a name already standing on this very period may be saved again, which keeps a
  // period whose name came with the imported sheet editable.
  if (!isBreak && teacher && teacher !== standing) {
    const clash = tt.teacherClash({ teacher, day, period, exceptClassId: cl.id });
    if (clash) return res.redirect(`/teacher/timetable?class=${cl.id}&day=${encodeURIComponent(day)}&sloterr=${encodeURIComponent(tt.clashMessage(teacher, clash))}`);
  }
  tt.saveSlot({ classId: cl.id, day, period, subject, teacher, kind });
  res.redirect(`/teacher/timetable?class=${cl.id}&day=${encodeURIComponent(day)}&slotsaved=1`);
});

router.post('/timetable/slot/delete', requirePerm('timetable'), (req, res) => {
  const cl = viewClass(req);
  const c = v.checker();
  const day = c.choice(req.body.day, 'Day', tt.DAYS);
  const period = c.int(req.body.period, 'Period', { min: 1, max: 12 });
  if (c.ok) tt.deleteSlot(cl.id, day, period);
  res.redirect(`/teacher/timetable?class=${cl.id}&day=${encodeURIComponent(day || '')}&slotdel=1`);
});

// ================= NOTICES (read-only) =================
// Reading a notice is NOT a grant-gated power (school's rule, 2026-09-19: the dashboard shows
// them whatever the office ticked) — so this page opens for every teacher, and the toggle it
// shares with /messages therefore always works. Nothing on it writes, so there is nothing for
// a missing grant to lock.
router.get('/notices', requirePermOpen('notices'), (req, res) => {
  const cl = viewClass(req);
  // the parent portal's list PLUS the office's teachers-only memos — forStaff is
  // forClass plus the staff half, so a teacher never misses what a parent reads
  const notices = noticesSvc.forStaff(cl.id);
  res.render('teacher/notices', {
    title: `Notices — ${cl.label}`,
    cls: { label: cl.label, name: cl.name, section: cl.section },
    notices,
    // the shared 📢 Notices | 📨 Messages toggle (partials/teacher_msg_tabs.ejs)
    msgTab: 'notices',
    noticeCount: notices.length,
  });
});

// ================= 📨 MESSAGES — what the OFFICE sent HIM (2026-09-20) =================
//
// The school's rule: the teacher's message section carries TWO tabs — 📢 Notices (the
// school's notices, the same list a parent reads) and 📨 Messages, which holds only what
// the office sent him. And ONLY the office may write to a teacher; nobody else. So this page
// is a read-only inbox: `services/staff_messages.js` is written by Admin → Messages alone,
// and nothing on this page can send anywhere. The toggle's other half is /teacher/notices.
//
// The third icon of the bottom bar is ALWAYS there (school's request, 2026-09-19), so a
// teacher with no 'messages' grant opens the same page — the parents' writing desk below
// simply is not printed for him (the POST route keeps its hard guard as well).
router.get('/messages', requirePermOpen('messages'), (req, res) => {
  const cl = viewClass(req);
  const t = req.teacher;
  const parents = msg.getParentIdsForClass(cl.id);
  const canMessages = res.locals.permOpen !== false;   // false = nothing to write, inbox only
  // his own inbox, newest first. `unread` is taken BEFORE the letters are marked read, so
  // the render that clears the badge can still say “2 new”.
  const staffInbox = staffMsg.inboxFor(t.user_id);
  const staffNew = staffMsg.unreadCount(t.user_id);
  staffMsg.markRead(t.user_id);
  const notices = noticesSvc.forStaff(cl.id);
  // the school's notes for his classes — direction to_parent, newest first. This is the
  // same stream the bell counts; kept BELOW the inbox, folded away, for a class teacher who
  // wants to see what the office told his parents.
  const classIds = perm.classesFor(t).map((c) => c.id);
  const notesToClass = classIds.length ? db.prepare(`
      SELECT m.subject, m.body, m.category, m.created_at, c.name class_name
      FROM messages m
      JOIN students s ON s.parent_user_id = m.parent_user_id
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE m.direction = 'to_parent' AND s.class_id IN (${classIds.map(() => '?').join(',')})
      GROUP BY m.id ORDER BY m.id DESC LIMIT 6`).all(...classIds) : [];
  res.render('teacher/messages', {
    title: 'Messages',
    cls: { label: cl.label, name: cl.name, section: cl.section },
    // the shared 📢 Notices | 📨 Messages toggle (partials/teacher_msg_tabs.ejs)
    msgTab: 'messages',
    noticeCount: notices.length,
    staffInbox, staffNew, staffIcon: staffMsg.iconFor, notesToClass,
    categories: msg.CATEGORIES,
    parentCount: parents.length,
    sent: req.query.sent,
    err: req.query.err || null,
    canMessages,
  });
});

router.post('/messages', requirePerm('messages'), async (req, res, next) => {
  try {
    const t = req.teacher;
    const cl = viewClass(req);
    const c = v.checker();
    const category = c.choice(req.body.category, 'Category', msg.CATEGORIES, { fallback: 'General' });
    const subject = c.text(req.body.subject, 'Subject', { max: 120, min: 3, required: true });
    const body = c.body(req.body.body, 'Message', { max: 2000, min: 3, required: true });
    if (!c.ok) return res.redirect(`/teacher/messages?class=${cl.id}&err=${encodeURIComponent(c.summary)}`);
    // only the parents of the class open on this page — the class comes from the grant
    const targets = msg.getParentIdsForClass(cl.id);
    if (!targets.length) {
      return res.redirect(`/teacher/messages?class=${cl.id}&err=${encodeURIComponent('No parent login is linked to this class yet — please ask the school office.')}`);
    }
    const n = await msg.sendToParents({
      targets, category, subject, body,
      adminName: `${t.full_name} (${cl.label})`,
    });
    res.redirect(`/teacher/messages?class=${cl.id}&sent=${n}`);
  } catch (err) { next(err); }
});

// ================= FEES (view only) =================
// A teacher can see what is pending in their own class. Recording a payment, adding
// a fine or sending fee reminders stays with the office — a teacher never reaches
// /admin (that route requires role `admin`).
router.get('/fees', requirePerm('fees'), (req, res) => {
  const cl = viewClass(req);
  const synced = feeLedger.syncStudent({ classId: cl.id });
  const totals = feeLedger.summary({ classId: cl.id });
  const students = feeLedger.ledger({ classId: cl.id })
    .map((s) => ({
      id: s.id, full_name: s.full_name, roll_no: s.roll_no,
      status: s.status, pending: s.pending, overdueAmount: s.overdueAmount,
      months: s.months.filter((m) => m.balance > 0)
        .map((m) => ({ term: m.term, balance: m.balance, overdue: m.overdue })),
      paidMonths: s.paidMonths, totalMonths: s.totalMonths,
    }))
    .filter((s) => s.pending > 0)
    .sort((a, b) => b.pending - a.pending);
  res.render('teacher/fees', {
    title: `Fees — ${cl.label}`,
    cls: { label: cl.label, name: cl.name, section: cl.section },
    totals, students, created: synced.created,
    schoolPhone: config.schoolPhone,
  });
});

module.exports = router;
