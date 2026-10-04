const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');
const adm = require('../services/admissions');
const msg = require('../services/messages');
const staffMsg = require('../services/staff_messages');   // the office's messages TO teachers (2026-09-20)
const alerts = require('../services/alerts');
const site = require('../services/site_content');
const time = require('../services/time');
const pdfHelper = require('../services/students_pdf');
const feeLedger = require('../services/fees');
const timetable = require('../services/timetable');
const examSvc = require('../services/exam_timetable');   // the exam date-sheet + its switch
const hw = require('../services/homework');              // what was given, period by period (2026-09-18)
const duties = require('../services/duties');            // lunch duty & extra classes (2026-09-20)
const holidaySvc = require('../services/holidays');       // the days the school is shut besides Sunday
const marksSheet = require('../services/marks_sheet');
const permService = require('../services/permissions');
const payments = require('../services/payments');
const analysisSvc = require('../services/analysis');   // results as rings (child · class · school)
const parentAccess = require('../services/parent_access'); // what a parent may see (sections + fee lock)
const words = require('../services/words');               // every word on a screen is the office's to change
const staySvc = require('../services/stay');                 // day scholar or hostel student (the fee column)
const hostelSvc = require('../services/hostel');             // the hostel's mess menu, routine and roster
const officeFeed = require('../services/office_feed');   // everything waiting for the office, in one list
const config = require('../config');
const v = require('../services/validate');   // every rule about the office's input lives there
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin'));

const getClasses = () => db.prepare('SELECT * FROM classes ORDER BY id').all();
const getExams = () => db.prepare('SELECT * FROM exams ORDER BY id').all();
const listValue = (value) => (Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]));

// ================= DASHBOARD =================
router.get('/', (req, res) => {
  const totalStudents = db.prepare('SELECT COUNT(*) c FROM students').get().c;
  const totalClasses = db.prepare('SELECT COUNT(*) c FROM classes').get().c;
  const totalTeachers = db.prepare('SELECT COUNT(DISTINCT class_teacher) c FROM classes').get().c;
  const noticesCount = db.prepare('SELECT COUNT(*) c FROM notices').get().c;
  const feesCollected = feeLedger.summary().collected;   // real receipts, part payments included
  const feesTotal = feeLedger.summary().sessionTotal;     // tuition + fines, the whole session
  const classWise = db.prepare(`
    SELECT c.name, COUNT(s.id) students FROM classes c
    LEFT JOIN students s ON s.class_id = c.id GROUP BY c.id ORDER BY c.id`).all();
  const recentNotices = db.prepare('SELECT * FROM notices ORDER BY created_at DESC LIMIT 5').all();
  const pendingApps = db.prepare("SELECT COUNT(*) c FROM admissions WHERE status = 'Pending'").get().c;
  const unreadMail = db.prepare('SELECT COUNT(*) c FROM notifications WHERE read = 0').get().c;
  const recentApps = db.prepare(`
    SELECT a.*, c.name class_name FROM admissions a JOIN classes c ON c.id = a.class_id
    ORDER BY a.submitted_at DESC LIMIT 5`).all();
  // student portal logins — the office hands these out, so they are visible here
  const studentLogins = db.prepare(`
    SELECT s.id, s.roll_no, s.full_name, s.portal_password, u.username,
           c.name class_name, c.section
    FROM students s
    JOIN users u ON u.id = s.user_id
    JOIN classes c ON c.id = s.class_id
    ORDER BY c.id, s.roll_no`).all();
  // parents who say they have paid and are waiting for the office to check it
  const claims = feeLedger.claimStats();
  // every result in the school as circles: the average, one ring per class, and which
  // classes have not had marks entered yet (the office's own to-do list)
  const result = analysisSvc.school();
  // how many children live in the hostel (Admin → Hostel owns the menu, the routine and the
  // roster). Read from the ONE reader of `students.stay`, never counted here by hand.
  const boarders = hostelSvc.count();
  // …and how many of those months the school has actually charged hostel money for, so the
  // office can see at a glance whether a newly-marked boarder has been re-priced yet
  const hostelChargedMonths = feeLedger.ledger().reduce((n, s) => n + s.hostelMonths, 0);
  // the school store: what families still owe for books, uniform and stationery
  const storeSvc = require('../services/store');
  const storeStats = storeSvc.summary();
  // ---- the hostel, as the office watches it every morning (2026-09-16) ----
  // One panel: who boards (and what each family still owes), what is being cooked today, how the
  // hostel day runs, and what the hostel charges add up to. Every number comes from
  // services/hostel.js (the mess menu, the routine, the roster + its money) — the same readers
  // the hostel page, the reminder button and the parent app use.
  const hostelPanel = {
    count: boarders,
    today: hostelSvc.today(),
    mealsSet: hostelSvc.menuCount(),
    routine: hostelSvc.routine(),
    monthlyTotal: db.prepare("SELECT COALESCE(SUM(amount), 0) t FROM hostel_fees WHERE kind = 'monthly'").get().t,
    roster: hostelSvc.roster(),
  };

  res.render('admin/dashboard', {
    title: 'Admin Dashboard',
    stats: {
      totalStudents, totalClasses, totalTeachers, noticesCount, feesCollected, feesTotal,
      pendingApps, unreadMail, pendingClaims: claims.pending, claimAmount: claims.amount,
      marksEntered: result.totals.marksEntered, studentsWithMarks: result.totals.withMarks,
      classesWithoutMarks: result.totals.pendingClasses,
      // what the office lets parents see (Admin → Parent Access)
      parentOpen: parentAccess.getSettings().open,
      parentTotal: parentAccess.getSettings().total,
      parentLock: parentAccess.getSettings().lockUnpaid,
      // children who live in the hostel, and how many months are charged at the hostel rate
      boarders, hostelChargedMonths,
      // books & uniform: who owes, and how much
      storeOwing: storeStats.owing, storeBalance: storeStats.balance,
    },
    hostelPanel,
    classWise, recentNotices, recentApps, studentLogins, result,
    recentClaims: claims.pending ? feeLedger.pendingClaims({ limit: 4 }) : [],
  });
});

// ================= WHAT HAS ARRIVED? (the office notification dock) =================
// Every office page carries a dock in the corner (`public/js/admin-alerts.js`) that asks this
// endpoint every 20 seconds. It lists what is waiting for the office — a parent's message or
// reply, a payment claim to check, an admission application, a website message — and the
// counts are read live, so the number never lies about a backlog. Nothing here writes: an
// arrival leaves this list when the office actually deals with it on its own page
// (`services/office_feed.js` explains the rule, including why the office's own mail stays out).
router.get('/office-feed.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(officeFeed.feed());
});

// ================= STUDENTS =================
// Suggest the next admission number (the school office can overwrite it on the form).
// The year is the school's own (IST) year, and the number skips anything already
// taken — `admission_no` is UNIQUE, and hand-typed numbers such as "ADM2026007"
// mean a simple max+1 would collide.
function nextAdmissionNo() {
  const prefix = `ADM${time.yearIST()}`;
  const used = new Set(db.prepare('SELECT admission_no FROM students WHERE admission_no LIKE ?')
    .all(prefix + '%').map(r => String(r.admission_no)));
  let max = 0;
  for (const value of used) {
    const suffix = value.slice(prefix.length).trim();
    if (!/^\d{1,3}$/.test(suffix)) continue;   // only the simple 001, 002 … sequence
    const n = parseInt(suffix, 10);
    if (n > max) max = n;
  }
  let n = max + 1;
  while (used.has(prefix + String(n).padStart(3, '0'))) n++;
  return prefix + String(n).padStart(3, '0');
}

// Suggest the FIRST ROLL SLOT a class still has free — so after a FULL delete of
// Roll No. 1 the form offers 1 again straight away (and after deleting roll 3 of
// [1,2,4] it offers 3, not 5). Lower numbers are reused before new ones open up.
function nextFreeRoll(classId) {
  const taken = new Set(db.prepare('SELECT roll_no FROM students WHERE class_id = ?')
    .all(classId).map(r => r.roll_no));
  let roll = 1;
  while (taken.has(roll)) roll++;
  return roll;
}

// shared by the students list and the PDF download, so both always show the same rows
function parseStudentFilter(query = {}) {
  const classId = parseInt(query.class, 10) || 0;
  const q = String(query.q || '').trim();
  const where = [];
  const args = [];
  if (classId) { where.push('s.class_id = ?'); args.push(classId); }
  if (q) {
    // "10", "10th", "class 10" → that class ONLY (no other class).
    // Anything else (incl. a 10-digit mobile, admission no, father/mother name) → text search.
    const stripped = q.replace(/\bclass\b/ig, ' ').replace(/(\d+)\s*(?:st|nd|rd|th)\b/ig, '$1')
                      .replace(/[%_]/g, '').trim();
    if (/^\d{1,2}$/.test(stripped)) {
      where.push('c.name LIKE ?');
      args.push('% ' + stripped);          // "Class 10" ends with " 10" — "Class 1" does not
    } else {
      const like = `%${stripped || q.replace(/[%_]/g, '')}%`;
      let clause = `(s.full_name LIKE ? OR s.admission_no LIKE ? OR s.parent_name LIKE ?
        OR s.parent_phone LIKE ? OR s.alt_phone LIKE ? OR s.father_name LIKE ? OR s.mother_name LIKE ?
        OR s.guardian_name LIKE ? OR s.guardian_phone LIKE ? OR s.caste LIKE ? OR s.category LIKE ?
        OR s.address LIKE ? OR c.name LIKE ?`;
      for (let i = 0; i < 13; i++) args.push(like);
      // Aadhaar numbers are usually typed with spaces (1234 5678 9012) — match digits only
      const digits = q.replace(/\D/g, '');
      if (digits.length >= 4) {
        const dLike = `%${digits}%`;
        clause += ` OR REPLACE(REPLACE(s.aadhaar,' ',''),'-','') LIKE ?
          OR REPLACE(REPLACE(s.father_aadhaar,' ',''),'-','') LIKE ?
          OR REPLACE(REPLACE(s.mother_aadhaar,' ',''),'-','') LIKE ?`;
        args.push(dLike, dLike, dLike);
      }
      where.push(clause + ')');
    }
  }
  return { classId, q, where, args };
}

// Admission-record extras: caste / category / blood group / family / guardian.
// Shared by "add student" and "edit student" so both save exactly the same fields.
/** The stay columns, named once (the form, the save and the ledger all read them). */
const STAY_FIELDS = ['stay', 'hostel_from', 'hostel_until', 'hostel_bed'];

const STUDENT_EXTRA_FIELDS = [
  'caste', 'category', 'blood_group',
  'father_name', 'father_occupation', 'mother_name', 'mother_occupation', 'annual_income',
  'alt_phone', 'guardian_name', 'guardian_relation', 'guardian_phone',
  'aadhaar', 'father_aadhaar', 'mother_aadhaar',
  'address',
  // ---- day scholar / hostel student (2026-09-16) ----
  // These four decide the whole fee (which column of the class sheet each month is
  // charged from), so they are listed here to travel with the record — but they are
  // cleaned by src/services/stay.js (`normalise`), never by a plain text check.
  ...STAY_FIELDS,
];

function readStudentExtras(body = {}) {
  const out = {};
  for (const field of STUDENT_EXTRA_FIELDS) out[field] = String(body[field] || '').trim();
  // Aadhaar numbers are typed with spaces — keep the digits only, so every record
  // is stored (and can be searched) in exactly the same shape.
  for (const field of ['aadhaar', 'father_aadhaar', 'mother_aadhaar']) {
    out[field] = out[field].replace(/\D/g, '');
  }
  return out;
}

// Every option the student form offers — kept next to the checks so a new
// option added to the form is added here too (one place, no silent rejects).
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const CATEGORIES = ['General', 'OBC', 'SC', 'ST', 'EWS', 'Other'];

/**
 * The admission-record extras (family, category, Aadhaar, address…).
 * Shared by "add student" and "edit student" so both check exactly the same
 * fields, and every message is worded once by the checker.
 * Everything optional: a blank field stays blank, it is never an error.
 */
function checkStudentExtras(c, extra) {
  return {
    caste: c.name(extra.caste, 'Caste'),
    category: c.choice(extra.category, 'Category', CATEGORIES),
    blood_group: c.choice(extra.blood_group, 'Blood group', BLOOD_GROUPS),
    father_name: c.name(extra.father_name, "Father's name"),
    father_occupation: c.text(extra.father_occupation, "Father's occupation", { max: 60 }),
    mother_name: c.name(extra.mother_name, "Mother's name"),
    mother_occupation: c.text(extra.mother_occupation, "Mother's occupation", { max: 60 }),
    annual_income: c.text(extra.annual_income, 'Annual income', { max: 20 }),
    alt_phone: c.phone(extra.alt_phone, 'Alternate mobile number'),
    guardian_name: c.name(extra.guardian_name, "Guardian's name"),
    guardian_relation: c.text(extra.guardian_relation, 'Guardian relation', { max: 40 }),
    guardian_phone: c.phone(extra.guardian_phone, "Guardian's mobile number"),
    aadhaar: c.aadhaar(extra.aadhaar, "Student's Aadhaar number"),
    father_aadhaar: c.aadhaar(extra.father_aadhaar, "Father's Aadhaar number"),
    mother_aadhaar: c.aadhaar(extra.mother_aadhaar, "Mother's Aadhaar number"),
    address: c.text(extra.address, 'Address', { max: 200 }),
    // Day scholar or hostel student. The month boxes are `<select>`s of the session's own
    // months, so only a real month can arrive; `normalise` also blankes the period of a
    // day scholar (so a stale hostel month can never price a month later) and drops a
    // period that ends before it starts. The one rule lives in src/services/stay.js.
    ...staySvc.normalise({
      stay: extra.stay, hostel_from: extra.hostel_from,
      hostel_until: extra.hostel_until, hostel_bed: extra.hostel_bed,
    }),
  };
}

// blank fields are stored as NULL so the UI can show "—" instead of an empty gap
function blankToNull(value) {
  return value === '' || value === undefined ? null : value;
}

/**
 * Everything the student form needs besides the student itself — the class list and the
 * two STAY answers (day scholar / hostel student, and the session months its period is
 * picked from). Written once because the form is rendered from four places (add, edit and
 * their validation re-renders) and a missed one would silently drop the hostel boxes.
 */
function studentFormData() {
  return {
    classes: getClasses(),
    stayOptions: staySvc.STAYS,
    stayTerms: feeLedger.sessionTerms().map((t) => t.term),
  };
}

function listStudents(filter) {
  const clause = filter.where.length ? 'WHERE ' + filter.where.join(' AND ') : '';
  return db.prepare(`SELECT s.*, c.name class_name, c.section FROM students s
      JOIN classes c ON c.id = s.class_id ${clause} ORDER BY c.id, s.roll_no`).all(...filter.args);
}

router.get('/students', (req, res) => {
  const filter = parseStudentFilter(req.query);
  const students = listStudents(filter);
  res.render('admin/students', {
    title: 'Students', students, classes: getClasses(), classId: filter.classId, q: filter.q,
  });
});

// ---- A4 PDF of student details: one class, or every class in one file ----
router.get('/students/export.pdf', (req, res) => {
  const filter = parseStudentFilter(req.query);
  const students = listStudents(filter);
  const classes = getClasses();

  const groups = [];
  if (filter.classId) {
    const cls = classes.find((c) => c.id === filter.classId);
    groups.push({ className: cls ? pdfHelper.classLabel(cls) : `Class ${filter.classId}`, students });
  } else {
    classes.forEach((cls) => {
      const list = students.filter((s) => s.class_id === cls.id);
      if (list.length) groups.push({ className: pdfHelper.classLabel(cls), students: list });
    });
  }

  if (!groups.length) {
    return res.status(404).render('error', { message: 'No students found for this download.', code: 404 });
  }

  const report = pdfHelper.buildStudentsPdf({
    school: {
      name: config.schoolName,
      typeLine: config.schoolTypeLine,
      address: config.schoolAddress,
      phone: config.schoolPhone,
      email: config.schoolEmail,
      session: config.sessionLabel,
    },
    groups,
    generatedAt: new Date(),
  });

  const filename = `students-${report.fileBase}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', report.buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(report.buffer);
});

// the first roll slot a class still has free — the Add Student form calls this
// whenever the office changes the class, so a freed Roll No. (even 1) is offered
// again the moment it is available
router.get('/students/next-roll', (req, res) => {
  const classId = parseInt(req.query.class, 10) || 0;
  if (!classId || !db.prepare('SELECT 1 FROM classes WHERE id = ?').get(classId)) {
    return res.status(404).json({ error: 'class not found' });
  }
  res.json({ class_id: classId, roll: nextFreeRoll(classId) });
});

router.get('/students/new', (req, res) => {
  const filterClass = parseInt(req.query.class, 10) || 0;
  res.render('admin/student_form', {
    ...studentFormData(),
    title: 'Add Student', student: null, studentUser: null,
    values: filterClass ? { class_id: filterClass } : null,
    error: null, filterClass, suggestedAdmission: nextAdmissionNo(),
    // the first roll slot this class still has free — after a full delete,
    // Roll No. 1 is free again and the form offers it straight away
    suggestedRoll: filterClass ? nextFreeRoll(filterClass) : null,
  });
});

router.post('/students', (req, res) => {
  // ---- 1. every field the office typed is cleaned and checked first ----------
  const c = v.checker();
  const full_name = c.name(req.body.full_name, 'Student name', { required: true });
  const classId = c.id(req.body.class_id, 'Class');
  const roll = c.int(req.body.roll_no, 'Roll No.', { min: 1, max: 99, required: true });
  const dob = c.dateISO(req.body.dob, 'Date of birth', { notFuture: true });
  const parent_phone = c.phone(req.body.parent_phone, 'Parent mobile number');
  const username = c.username(req.body.username, 'Login username', { required: true });
  const password = c.password(req.body.password, 'Password');
  const admissionNo = c.text(req.body.admission_no, 'Admission number', { max: 30 });
  const extra = checkStudentExtras(c, readStudentExtras(req.body));
  // "Parent name" (used by search, PDF and portals) follows the father, else the mother
  const parent_name = extra.father_name || extra.mother_name;
  const values = {
    full_name, class_id: classId, roll_no: roll, dob, parent_name, parent_phone, username, ...extra,
    admission_no: admissionNo,
  };
  const filterClass = parseInt(req.body.filter_class, 10) || 0;
  const rerender = (error) => res.status(400).render('admin/student_form', {
    ...studentFormData(),
    title: 'Add Student', student: null, studentUser: null, values,
    error, filterClass, suggestedAdmission: values.admission_no || nextAdmissionNo(),
  });

  // ---- 2. the classroom rules only the database can answer -------------------
  if (!c.ok) return rerender(c.summary);
  if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(classId)) {
    return rerender('That class does not exist — please pick another one.');
  }
  if (db.prepare('SELECT 1 FROM students WHERE class_id = ? AND roll_no = ?').get(classId, roll)) {
    return rerender(`Roll No. ${roll} already exists in this class.`);
  }
  // admission no is typed by the school office — blank means "give me the next one"
  const admission = values.admission_no || nextAdmissionNo();
  const dupAdm = db.prepare('SELECT full_name, admission_no FROM students WHERE admission_no = ?').get(admission);
  if (dupAdm) return rerender(`Admission no “${admission}” is already used by ${dupAdm.full_name}.`);

  // the login belongs to the PARENT — students never sign in themselves
  const loginPassword = String(password || '').trim() || 'parent123';
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return rerender(`Username “${username}” is already taken — please pick another one.`);
  }
  const stuUser = db.prepare('INSERT INTO users (username, password_hash, role, full_name, phone) VALUES (?,?,?,?,?)')
    .run(username, bcrypt.hashSync(loginPassword, 10), 'parent', full_name, parent_phone);
  const cols = ['user_id', 'parent_user_id', 'admission_no', 'full_name', 'class_id', 'roll_no', 'dob',
    'parent_name', 'parent_phone', 'portal_password', ...STUDENT_EXTRA_FIELDS];
  const row = [stuUser.lastInsertRowid, stuUser.lastInsertRowid, admission, full_name, classId, roll, dob,
    blankToNull(parent_name), blankToNull(parent_phone), loginPassword,
    ...STUDENT_EXTRA_FIELDS.map((f) => blankToNull(extra[f]))];
  // the whole admission (login + record + fee installments) is one transaction:
  // the roll slot this child takes is re-checked inside it, so a slot freed by a
  // FULL DELETE is safe to hand out again and a duplicate can never slip between
  // the check above and the write.
  const createStudent = db.transaction(() => {
    const stu = db.prepare(`INSERT INTO students (${cols.join(', ')})
              VALUES (${cols.map(() => '?').join(',')})`).run(...row);
    // new student → create their monthly fee installments straight away
    feeLedger.syncStudent({ studentId: Number(stu.lastInsertRowid) });
    return stu;
  });
  createStudent();
  res.redirect(`/admin/students?class=${classId}&created=1`);
});

router.get('/students/:id/edit', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });
  const studentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(student.user_id);
  res.render('admin/student_form', {
    ...studentFormData(),
    title: 'Edit Student', student, studentUser, values: null, error: null,
    filterClass: parseInt(req.query.class, 10) || 0,
    // the profile page opens this form, and asks to be returned to (2026-09-20) — without it
    // the office saving a correction lands back on the full list and loses the child
    backTo: req.query.back_to === 'profile' ? 'profile' : '',
  });
});

// ---- ONE STUDENT, THE WHOLE PICTURE (school's request, 2026-09-20) ---------------------
// The Students list used to lead only to the edit form, so READING a child meant hopping
// between five screens: result, fee ledger, timetable, homework, hostel. This page is that
// hop removed — one child, everything the school holds, each figure taken from the service
// that OWNS it (never re-computed here, so it can never disagree with the page it came from).
// Every card carries the door to the tool that changes that part, and the quick actions post
// to those very routes, so a change made here reaches the parent's portal, the marks sheet and
// the ledger at once.
router.get('/students/:id(\\d+)', (req, res) => {
  const studentId = parseInt(req.params.id, 10);
  const student = db.prepare(`SELECT s.*, c.name AS class_name, c.section,
      c.tuition_day, c.tuition_hostel
    FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(studentId);
  if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });

  // the child's months are brought up to date first — exactly what /admin/fees/:id does, so
  // the fee card here can never show a stale session
  feeLedger.syncStudent({ studentId });
  const ledger = feeLedger.studentLedger(studentId);
  const login = db.prepare('SELECT id, username, full_name, phone FROM users WHERE id = ?')
    .get(student.parent_user_id || student.user_id) || null;
  const result = analysisSvc.forStudent(studentId);
  // the parents' own marks table (bands included) from the same service that draws their page
  const marks = analysisSvc.marksRows(studentId);
  // The marks, EXAM BY EXAM: the same sheet the office's Marks page prints, read once per exam
  // and filtered to this child — so the total, the percentage and the rank here are the sheet's
  // own numbers, and an exam nobody has entered yet says so instead of showing a made-up zero.
  const examRows = getExams().map((exam) => {
    const sh = marksSheet.sheet(student.class_id, exam.id);
    if (!sh.subjects.length) return null;
    const mine = marksSheet.withTotals(sh.students, sh.subjects, sh.byStudent)
      .find((r) => r.student.id === studentId);
    return {
      exam,
      maxTotal: marksSheet.fullMarks(sh.subjects),
      total: mine && mine.total !== null ? mine.total : null,
      percent: mine && mine.percent !== null ? mine.percent : null,
      rank: mine ? mine.rank : null,
      // how many of the class's papers the child has, so a half-entered exam reads honestly
      subjects: sh.subjects.length,
      entered: mine ? mine.cells.filter((c) => c !== '').length : 0,
    };
  }).filter(Boolean);
  const day = timetable.DAYS.includes(req.query.day)
    ? req.query.day
    : (timetable.todayName() || 'Monday');
  // the class's periods for the day in view — the SAME reader the parents' timetable and the
  // teacher's day use, so the child's page can never show a period the class does not have
  const ttDay = timetable.dayPeriods(student.class_id, day);

  res.render('admin/student_profile', {
    title: `${student.full_name} — Profile`,
    student, ledger, login, result, marks, ttDay, examRows,
    className: `${student.class_name}${student.section ? ' ' + student.section : ''}`,
    stayNote: staySvc.describe(student),
    timeByPeriod: timetable.timeByPeriod(),
    days: timetable.DAYS, shorts: timetable.SHORT, day,
    hwNotes: hw.forWeek(student.class_id), hwDay: day,
    hwStatuses: hw.statusesForDay(studentId, day),
    // what the store holds for this child — the same reader the store page and the fee
    // reminder use, so the pending amount is one number everywhere
    storeBill: require('../services/store').billFor(studentId),
    payModes: feeLedger.PAY_MODES, payParts: feeLedger.PAY_PARTS,
    filterClass: parseInt(req.query.class, 10) || 0, classes: getClasses(),
    updated: req.query.updated === '1', photo: req.query.photo || '',
    paid: req.query.paid, paidTerm: req.query.term,
    staydone: req.query.staydone || '',
    payErr: req.query.payErr, hwMarked: req.query.marked || '',
  });
});

// ---- HOMEWORK MARKS (2026-09-18): the office can mark too, any child ------------------
// The same three buttons the class teacher has — ✓ Done / ✕ Not done / ↺ Clear. Nothing
// marked means the parents' timetable band stays plain; a mark is the school saying so.
router.get('/students/:id(\\d+)/homework', (req, res) => {
  const student = db.prepare(`SELECT s.*, c.name class_name, c.section FROM students s
    JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(req.params.id);
  if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });
  const day = timetable.DAYS.includes(req.query.day) ? req.query.day : timetable.todayName() || 'Monday';
  const dayPeriods = timetable.dayPeriods(student.class_id, day).filter((p) => !p.isBreak);
  res.render('admin/student_homework', {
    title: `Homework - ${student.full_name}`,
    hwStudent: student,
    hwClassId: student.class_id,
    hwDay: day,
    hwToday: timetable.todayName(),
    hwPeriods: dayPeriods.map((p) => ({ period: p.period, subject: p.subject, emoji: p.emoji })),
    hwPeriodNotes: hw.forDay(student.class_id, day),
    hwStatuses: hw.statusesForDay(student.id, day),
    hwBase: `/admin/students/${student.id}/homework`,
    hwMarked: req.query.marked || '', hwCleared: req.query.cleared === '1',
  });
});

router.post('/students/:id(\\d+)/homework/:period(\\d+)', (req, res) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(req.params.id);
  const c = v.checker();
  const day = c.choice(req.body.day, 'Day', timetable.DAYS);
  const period = c.int(req.params.period, 'Period', { min: 1, max: 12 });
  const status = req.body.status === 'done' ? 'done' : 'not_done';
  const back = (q) => res.redirect(`/admin/students/${req.params.id}/homework` + (q ? `?${q}` : ''));
  if (!student || !c.ok) return back();
  hw.setStatus({ studentId: student.id, day, period, status, markedBy: req.session.user.full_name || 'School office' });
  return back(`marked=${period}&day=${encodeURIComponent(day)}`);
});

router.post('/students/:id(\\d+)/homework/:period(\\d+)/clear', (req, res) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(req.params.id);
  const c = v.checker();
  const day = c.choice(req.body.day, 'Day', timetable.DAYS);
  const period = c.int(req.params.period, 'Period', { min: 1, max: 12 });
  if (student && c.ok) hw.clearStatus({ studentId: student.id, day, period });
  res.redirect(`/admin/students/${req.params.id}/homework?cleared=1&day=${encodeURIComponent(day || '')}`);
});

router.post('/students/:id', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });
  // ---- 1. the same checks as "add student" --------------------------------
  const c = v.checker();
  const full_name = c.name(req.body.full_name, 'Student name', { required: true });
  const classId = c.id(req.body.class_id, 'Class');
  const roll = c.int(req.body.roll_no, 'Roll No.', { min: 1, max: 99, required: true });
  const dob = c.dateISO(req.body.dob, 'Date of birth', { notFuture: true });
  const parent_phone = c.phone(req.body.parent_phone, 'Parent mobile number');
  const filterClass = parseInt(req.body.filter_class, 10) || 0;
  const extra = checkStudentExtras(c, readStudentExtras(req.body));
  // "Parent name" (used by search, PDF and portals) follows the father, else the mother
  const parent_name = extra.father_name || extra.mother_name;
  const studentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(student.user_id);
  // a blank username means "keep the current one" — only a typed value is checked
  const typedUsername = c.username(req.body.username, 'Login username');
  const newUsername = typedUsername || (studentUser ? studentUser.username : '');
  const newPassword = c.password(req.body.password, 'Password');
  const admissionNo = c.text(req.body.admission_no, 'Admission number', { max: 30 });
  const values = {
    full_name, class_id: classId, roll_no: roll, dob, parent_name, parent_phone, ...extra,
    username: newUsername, password: newPassword,
    admission_no: admissionNo,
  };
  const backTo = req.body.back_to === 'profile' ? 'profile' : '';
  const rerender = (error) => res.status(400).render('admin/student_form', {
    ...studentFormData(),
    title: 'Edit Student', student, studentUser, values, error, filterClass, backTo,
  });

  // ---- 2. cross-record rules, then save -----------------------------------
  if (!c.ok) return rerender(c.summary);
  const admission = values.admission_no || student.admission_no;
  // the login the student uses — admin can change it any time
  if (!newUsername) return rerender('Please give this student a login username.');
  if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(classId)) {
    return rerender('That class does not exist — please pick another one.');
  }
  const dupUser = db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(newUsername, student.user_id);
  if (dupUser) return rerender(`Username “${newUsername}” is already taken — please pick another one.`);
  const dupAdm = db.prepare('SELECT full_name FROM students WHERE admission_no = ? AND id <> ?').get(admission, student.id);
  if (dupAdm) return rerender(`Admission no “${admission}” is already used by ${dupAdm.full_name}.`);
  const dupRoll = db.prepare('SELECT full_name FROM students WHERE class_id = ? AND roll_no = ? AND id <> ?').get(classId, roll, student.id);
  if (dupRoll) return rerender(`Roll No. ${roll} is already taken by ${dupRoll.full_name} in this class.`);

  const setCols = ['full_name', 'class_id', 'roll_no', 'admission_no', 'dob', 'parent_name',
    'parent_phone', ...STUDENT_EXTRA_FIELDS];
  const setArgs = [full_name, classId, roll, admission, blankToNull(dob),
    blankToNull(parent_name), blankToNull(parent_phone),
    ...STUDENT_EXTRA_FIELDS.map((f) => blankToNull(extra[f]))];
  db.prepare(`UPDATE students SET ${setCols.map((c) => `${c}=?`).join(', ')} WHERE id=?`)
    .run(...setArgs, student.id);

  // student login: username, name and (when given) a new password
  if (studentUser) {
    const parts = ['username = ?', 'full_name = ?'];
    const args = [newUsername, full_name];
    if (newPassword) {
      parts.push('password_hash = ?');
      args.push(bcrypt.hashSync(newPassword, 10));
      db.prepare('UPDATE students SET portal_password = ? WHERE id = ?').run(newPassword, student.id);
    }
    db.prepare(`UPDATE users SET ${parts.join(', ')} WHERE id = ?`).run(...args, studentUser.id);
  }
  // Keep the fee ledger consistent with the record. A new class moves the child to another
  // column of the sheet, and a day/hostel switch changes WHICH column each month is charged
  // from — a boarder who joined the hostel in July keeps April–June at the day rate.
  // `retuneStudent` is idempotent: it only rewrites a month whose price really changed and
  // that has received no money yet, so calling it on every save is safe and cheap.
  feeLedger.syncStudent({ studentId: student.id });
  feeLedger.retuneStudent(student.id);
  // saved from the child's profile → come back to that profile, not to the whole list
  if (backTo) return res.redirect(`/admin/students/${student.id}?updated=1`
    + (filterClass ? `&class=${filterClass}` : ''));
  res.redirect('/admin/students?' + (filterClass ? `class=${filterClass}&` : '') + 'updated=1');
});

// student profile photo — shown on the landing page for Class 10 toppers.
// Photos are uploaded as small data-URIs (resized in the browser before submit).
router.post('/students/:id/photo', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });
  // accept either an uploaded image (data-URI, resized in the browser) or a bundled /images/... path
  const c = v.checker();
  const photo = req.body.remove ? '' : c.image(req.body.photo, 'Photo', { max: 500000 });
  if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
  db.prepare('UPDATE students SET photo = ? WHERE id = ?').run(photo || null, req.params.id);
  const back = parseInt(req.body.filter_class, 10) || 0;
  const suffix = `photo=${photo ? 'saved' : 'removed'}`;
  // the profile page uploads the photo in place, so it gets the answer itself
  if (req.body.back_to === 'profile') return res.redirect(`/admin/students/${student.id}?${suffix}`);
  res.redirect('/admin/students?' + (back ? `class=${back}&` : '') + suffix);
});

router.post('/students/:id/delete', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (student) {
    // FULL WIPE — a roll number leaves the class completely, so the office can
    // re-admit anyone (even the same Roll No. 1) afterwards without leftovers.
    // Every table that points at the child is cleared in ONE transaction: fees,
    // payments, claims, marks, homework marks, store items, messages about him,
    // his admission row, his login — and the parent login too, but ONLY when no
    // sibling still uses it (a parent with two children keeps their account).
    const wipe = db.transaction(() => {
      db.prepare('DELETE FROM fees WHERE student_id = ?').run(student.id);
      db.prepare('DELETE FROM fee_payments WHERE student_id = ?').run(student.id);
      db.prepare('DELETE FROM fee_claims WHERE student_id = ?').run(student.id);
      db.prepare('DELETE FROM marks WHERE student_id = ?').run(student.id);
      db.prepare('DELETE FROM homework_status WHERE student_id = ?').run(student.id);
      db.prepare('DELETE FROM student_items WHERE student_id = ?').run(student.id);
      db.prepare('DELETE FROM messages WHERE student_id = ?').run(student.id);
      // the parent login is kept while another child still needs it; when it goes,
      // the parent's admission trail, alert history and office conversations go too
      if (student.parent_user_id) {
        const siblings = db.prepare('SELECT COUNT(*) c FROM students WHERE parent_user_id = ? AND id <> ?').get(student.parent_user_id, student.id).c;
        if (!siblings) {
          db.prepare('DELETE FROM alert_log WHERE parent_user_id = ?').run(student.parent_user_id);
          db.prepare('DELETE FROM admissions WHERE parent_user_id = ?').run(student.parent_user_id);
          db.prepare('DELETE FROM messages WHERE parent_user_id = ?').run(student.parent_user_id);
        }
      }
      db.prepare('DELETE FROM students WHERE id = ?').run(student.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(student.user_id);
      if (student.parent_user_id) {
        const siblings = db.prepare('SELECT COUNT(*) c FROM students WHERE parent_user_id = ?').get(student.parent_user_id).c;
        if (!siblings) db.prepare('DELETE FROM users WHERE id = ?').run(student.parent_user_id);
      }
    });
    wipe();
  }
  const back = parseInt(req.body.filter_class, 10) || 0;
  res.redirect('/admin/students?' + (back ? `class=${back}&` : '') + 'deleted=1');
});

// ================= ADMISSIONS =================
router.get('/admissions', (req, res) => {
  const status = ['Pending', 'Approved', 'Rejected'].includes(req.query.status) ? req.query.status : '';
  const applications = adm.getApplications(status);
  const counts = {
    pending: db.prepare("SELECT COUNT(*) c FROM admissions WHERE status = 'Pending'").get().c,
    approved: db.prepare("SELECT COUNT(*) c FROM admissions WHERE status = 'Approved'").get().c,
    rejected: db.prepare("SELECT COUNT(*) c FROM admissions WHERE status = 'Rejected'").get().c,
  };
  res.render('admin/admissions', { title: 'Admissions', applications, counts, status, flash: req.query });
});

router.post('/admissions/:id/approve', async (req, res, next) => {
  try {
    const result = await adm.approveApplication(req.params.id, req.session.user.full_name);
    const q = result.student ? `?approved=1&user=${encodeURIComponent(result.student.username)}&pwd=${result.student.password}&admno=${result.student.admissionNo}` : `?already=1`;
    res.redirect(`/admin/admissions${q}`);
  } catch (err) { next(err); }
});

router.post('/admissions/:id/reject', async (req, res, next) => {
  try {
    await adm.rejectApplication(req.params.id, req.session.user.full_name);
    res.redirect('/admin/admissions?rejected=1');
  } catch (err) { next(err); }
});

// create the parent login for an application (usually after approval) —
// the admin chooses the username & password and shares them with the parent
router.post('/admissions/:id/create-login', (req, res, next) => {
  try {
    // the admin types these by hand, so they are checked like any other form
    const c = v.checker();
    const username = c.username(req.body.username, 'Login username', { required: true });
    const password = c.password(req.body.password, 'Login password', { required: true });
    if (!c.ok) {
      return res.redirect(`/admin/admissions?loginerr=1&msg=${encodeURIComponent(c.summary)}`);
    }
    const result = adm.createParentLogin(req.params.id, username, password, req.session.user.full_name);
    const q = `?login=1&user=${encodeURIComponent(result.username)}&pwd=${encodeURIComponent(password)}&appno=${encodeURIComponent(result.application.application_no)}`;
    res.redirect(`/admin/admissions${q}`);
  } catch (err) {
    // friendly message back on the admissions page instead of a 500
    const msg = encodeURIComponent(err.message || 'Could not create the parent login.');
    res.redirect(`/admin/admissions?loginerr=1&msg=${msg}`);
  }
});

// ================= TOPPERS (homepage, 3 per class) =================
// The homepage "Our Class Toppers" section is fully managed here: name,
// percentage and photo per rank, grouped by class.
const TOPPER_PHOTO_MAX = 400000;

router.get('/toppers', (req, res) => {
  const rows = db.prepare('SELECT * FROM class_toppers ORDER BY sort_order, id').all();
  const groups = [];
  const byClass = new Map();
  for (const r of rows) {
    if (!byClass.has(r.class_name)) {
      const g = { class_name: r.class_name, toppers: [] };
      byClass.set(r.class_name, g);
      groups.push(g);
    }
    byClass.get(r.class_name).toppers.push(r);
  }
  const classNames = db.prepare('SELECT DISTINCT name FROM classes ORDER BY id').all().map(c => c.name);
  res.render('admin/toppers', {
    title: 'Class Toppers', groups, classNames,
    flash: { saved: !!req.query.saved, removed: !!req.query.removed, error: req.query.error || null },
  });
});

// a field repeated in a form arrives as an array — normalise it
function asList(v) { return Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]); }

// Save ONE class card in a single click: all three ranks together —
// names, percentages and the photos that were picked, in one request.
router.post('/toppers/class/save', (req, res) => {
  // Every field of the card is checked by the shared checker, so one bad rank
  // refuses the whole card instead of saving half of it (see validate.js).
  const c = v.checker();
  const className = c.text(req.body.class_name, 'Class name', { max: 60, required: true }).replace(/\s+/g, ' ');
  if (!className) {
    return res.redirect(`/admin/toppers?error=${encodeURIComponent('Class name is missing — please reload the page.')}`);
  }

  const names = asList(req.body.name);
  const pcts = asList(req.body.percentage);
  const photos = asList(req.body.photo);
  const removals = asList(req.body.removePhoto);

  const rows = db.prepare('SELECT * FROM class_toppers WHERE class_name = ? ORDER BY rank_no').all(className);
  const byRank = new Map(rows.map((r) => [r.rank_no, r]));
  const baseSort = rows.length
    ? rows[0].sort_order
    : (db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM class_toppers').get().m + 1);

  const errors = c.errors;
  const plan = [];
  for (let i = 0; i < 3; i++) {
    const rankNo = i + 1;
    const name = c.text(names[i], `Rank ${rankNo} name`, { max: 80 }).replace(/\s+/g, ' ');
    const existing = byRank.get(rankNo) || null;

    // an empty name means "no topper in this rank"
    if (!name) {
      plan.push({ rankNo, remove: true, existing });
      continue;
    }

    // keep the exact percentage the school typed (decimals included); a value
    // that is not a number 0–100 is reported instead of being silently clamped
    const rawPct = c.amount(pcts[i], `Rank ${rankNo} percentage`, { min: 0, max: 100, fallback: 0 });
    const pct = Math.round((rawPct === null ? 0 : rawPct) * 100) / 100;

    let photo = existing ? existing.photo : null;
    if (String(removals[i] || '') === '1') {
      photo = null;
    } else if (String(photos[i] || '').trim()) {
      const clean = c.image(photos[i], `Rank ${rankNo} photo`, { max: TOPPER_PHOTO_MAX });
      // A rejected photo never blanks the one that is already there, and the
      // checker has recorded why — the card is refused below.
      if (clean) photo = clean;
    }

    plan.push({ rankNo, name, pct, photo, remove: false, existing });
  }

  if (!plan.some((p) => !p.remove)) {
    return res.redirect(`/admin/toppers?error=${encodeURIComponent('Please keep at least one topper — or use Delete Card to remove the whole class.')}`);
  }
  if (errors.length) {
    return res.redirect(`/admin/toppers?error=${encodeURIComponent(errors.join(' '))}`);
  }

  const del = db.prepare('DELETE FROM class_toppers WHERE id = ?');
  const upd = db.prepare('UPDATE class_toppers SET name = ?, percentage = ?, photo = ? WHERE id = ?');
  const ins = db.prepare('INSERT INTO class_toppers (class_name, rank_no, name, percentage, photo, sort_order) VALUES (?,?,?,?,?,?)');

  try {
    db.transaction(() => {
      for (const p of plan) {
        if (p.remove) {
          if (p.existing) del.run(p.existing.id);
          continue;
        }
        if (p.existing) upd.run(p.name, p.pct, p.photo, p.existing.id);
        else ins.run(className, p.rankNo, p.name, p.pct, p.photo, baseSort);
      }
    })();
  } catch (err) {
    return res.redirect(`/admin/toppers?error=${encodeURIComponent('Could not save — ' + err.message)}`);
  }

  const first = db.prepare('SELECT id FROM class_toppers WHERE class_name = ? ORDER BY rank_no LIMIT 1').get(className);
  res.redirect(`/admin/toppers?saved=1${first ? '#topper-' + first.id : ''}`);
});

// add a new class card with its 1st topper (ranks 2 & 3 can be filled after)
router.post('/toppers/classes/add', (req, res) => {
  const className = v.text(req.body.class_name, 60).replace(/\s+/g, ' ');
  if (!className) return res.redirect(`/admin/toppers?error=${encodeURIComponent('Please type a class name.')}`);
  const firstName = v.text(req.body.name, 80).replace(/\s+/g, ' ');
  const nextSort = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM class_toppers').get().m) + 1;
  const ins = db.prepare('INSERT INTO class_toppers (class_name, rank_no, name, percentage, sort_order) VALUES (?,?,?,0,?)');
  try {
    if (db.prepare('SELECT 1 FROM class_toppers WHERE class_name = ? AND rank_no = 1').get(className)) {
      return res.redirect(`/admin/toppers?error=${encodeURIComponent(className + ' already has toppers.')}`);
    }
    ins.run(className, 1, firstName || 'Topper 1', nextSort);
    res.redirect('/admin/toppers?saved=1');
  } catch (err) {
    res.redirect(`/admin/toppers?error=${encodeURIComponent('Could not add the class — ' + err.message)}`);
  }
});

// delete a whole class card (all 3 ranks)
router.post('/toppers/classes/delete', (req, res) => {
  const className = v.text(req.body.class_name, 60).replace(/\s+/g, ' ');
  if (className) db.prepare('DELETE FROM class_toppers WHERE class_name = ?').run(className);
  res.redirect('/admin/toppers?removed=1');
});

// ================= INBOX (school notifications) =================
router.get('/inbox', (req, res) => {
  const notifications = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all();
  db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE read = 0').get().c;
  res.render('admin/inbox', { title: 'Inbox', notifications, unread });
});

// ================= MESSAGES (parent queries) =================
router.get('/messages', (req, res) => {
  // Grab the unseen parent replies BEFORE they are marked read, so this render
  // can flag them (same trick the parent inbox uses with newIds).
  const newReplyIds = msg.getNewParentReplyIds();
  msg.markAdminMessagesRead();
  const category = req.query.category || '';
  const conversations = msg.getAdminThreads(msg.getAdminConversations(category));
  const parents = db.prepare(`SELECT u.id, u.full_name, u.phone,
    (SELECT GROUP_CONCAT(s.full_name || ' (' || c.name || ')', ', ') FROM students s JOIN classes c ON c.id = s.class_id WHERE s.parent_user_id = u.id) AS children
    FROM users u WHERE u.role = 'parent' ORDER BY u.full_name`).all();
  const classes = getClasses();
  const newParentReplies = conversations.filter(c => (c.thread || []).some(r => r.direction === 'to_school' && newReplyIds.includes(r.id))).length;
  // the office's other desk, on the same page: a message TO A TEACHER. One row per letter
  // written (see services/staff_messages.js) — only the office can ever write there.
  const teacherList = staffMsg.recipients();
  const recentStaff = db.prepare(`
    SELECT sm.*, u.full_name AS teacher_name FROM staff_messages sm
    JOIN users u ON u.id = sm.teacher_user_id
    ORDER BY sm.id DESC LIMIT 8`).all();
  res.render('admin/messages', {
    title: 'Parent Messages', conversations, parents, classes, categories: msg.CATEGORIES, category, newReplyIds, newParentReplies,
    teacherList, recentStaff, staffCategories: staffMsg.CATEGORIES, staffIcon: staffMsg.iconFor,
  });
});

/**
 * THE OFFICE'S LETTER TO A TEACHER.
 *
 * The school's rule: only the office writes to a teacher, so this is the one and only writer
 * of `staff_messages`. The recipient may be one teacher (picked by `teachers.id`, which the
 * pick list posts) or the whole staff; the service turns either into one row per teacher and
 * the teacher portal's Messages tab reads exactly those rows.
 */
router.post('/messages/teachers/send', (req, res, next) => {
  try {
    const c = v.checker();
    const target = c.choice(req.body.target, 'Recipient', ['all', 'teacher'], { required: true });
    const category = c.choice(req.body.category, 'Category', staffMsg.CATEGORIES, { fallback: 'General' });
    const subject = c.text(req.body.subject, 'Subject', { max: 120, min: 3, required: true });
    const body = c.body(req.body.body, 'Message', { max: 2000, min: 3, required: true });
    const teacherId = target === 'teacher' ? c.id(req.body.teacher_id, 'Teacher') : null;
    if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
    const list = staffMsg.recipients();
    const ids = target === 'all'
      ? list.map((t) => t.user_id)
      : [staffMsg.userIdOfTeacher(teacherId)];
    const sent = staffMsg.send({
      teacherUserIds: ids.filter(Boolean),
      category, subject, body,
      sentBy: req.session.user.full_name,
    });
    if (!sent) return res.redirect('/admin/messages?tnone=1#teacher-staff');
    res.redirect(`/admin/messages?tsent=${sent}#teacher-staff`);
  } catch (err) { next(err); }
});

router.post('/messages/reply', async (req, res, next) => {
  try {
    const c = v.checker();
    const threadId = c.id(req.body.thread_id, 'Conversation');
    // an empty reply is not an error — the admin simply pressed send by mistake
    if (!v.text(req.body.body, 2000)) return res.redirect('/admin/messages');
    const body = c.body(req.body.body, 'Reply', { max: 2000, required: true });
    if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
    await msg.replyToThread({ threadId, adminName: req.session.user.full_name, body });
    res.redirect('/admin/messages?replied=1');
  } catch (err) { next(err); }
});

router.post('/messages/send', async (req, res, next) => {
  try {
    const c = v.checker();
    const target = c.choice(req.body.target, 'Recipient', ['all', 'class', 'parent'], { required: true });
    const category = c.choice(req.body.category, 'Category', msg.CATEGORIES, { required: true });
    const subject = c.text(req.body.subject, 'Subject', { max: 120, min: 3, required: true });
    const body = c.body(req.body.body, 'Message', { max: 2000, min: 3, required: true });
    const classId = target === 'class' ? c.id(req.body.class_id, 'Class') : null;
    const parentId = target === 'parent' ? c.id(req.body.parent_user_id, 'Parent') : null;
    if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
    let targets = [];
    if (target === 'all') targets = msg.getAllParentIds();
    else if (target === 'class') targets = msg.getParentIdsForClass(classId);
    else if (target === 'parent') targets = [parentId];
    if (!targets.length) return res.redirect('/admin/messages?nosend=1');
    const n = await msg.sendToParents({ targets, adminName: req.session.user.full_name, category, subject, body });
    res.redirect(`/admin/messages?sent=${n}`);
  } catch (err) { next(err); }
});

// ================= TEACHERS (public profile cards) =================
router.get('/teachers', (req, res) => {
  // one row per teacher + how many sections his login may open (src/services/permissions.js)
  const teachers = permService.listTeachers();
  res.render('admin/teachers', { title: 'Teachers', teachers, classes: getClasses(), created: req.query.created, updated: req.query.updated, deleted: req.query.deleted, photo: req.query.photo });
});

router.get('/teachers/new', (req, res) => {
  res.render('admin/teacher_form', { title: 'Add Teacher', classes: getClasses(), teacher: null });
});

/**
 * The teacher form → clean, checked values (used by "add" and "edit").
 * `withLogin` is for a NEW teacher only: an existing teacher keeps the login they
 * already have, so the username/password fields are not touched on edit.
 * Ratings are rejected outside 0–5 instead of being silently clamped.
 */
function readTeacherForm(c, body = {}, { withLogin = false } = {}) {
  const out = {
    full_name: c.name(body.full_name, "Teacher's name", { required: true }),
    class_id: c.id(body.class_id, 'Class'),
    subject: c.text(body.subject, 'Subject', { max: 60 }) || null,
    phone: c.phone(body.phone, 'Mobile number'),
    qualification: c.text(body.qualification, 'Qualification', { max: 120 }) || null,
    experience_years: c.int(body.experience_years, 'Experience (years)', { min: 0, max: 60, fallback: 0 }),
    rating: c.amount(body.rating, 'Rating', { min: 0, max: 5, fallback: 0 }),
    bio: c.body(body.bio, 'Bio', { max: 400 }) || null,
  };
  if (withLogin) {
    out.username = c.username(body.username, 'Login username', { required: true });
    out.password = c.password(body.password, 'Password') || 'teacher123';
  }
  return out;
}

router.post('/teachers', (req, res) => {
  const c = v.checker();
  const t = readTeacherForm(c, req.body, { withLogin: true });
  if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(t.username)) {
    return res.status(400).render('error', { message: 'Username already exists.', code: 400 });
  }
  const tUser = db.prepare('INSERT INTO users (username, password_hash, role, full_name, phone) VALUES (?,?,?,?,?)')
    .run(t.username, bcrypt.hashSync(t.password, 10), 'teacher', t.full_name, t.phone);
  db.prepare(`INSERT INTO teachers
    (user_id, class_id, subject, phone, qualification, experience_years, rating, bio)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(tUser.lastInsertRowid, t.class_id, t.subject, t.phone,
      t.qualification, t.experience_years, t.rating, t.bio);
  res.redirect('/admin/teachers?created=1');
});

router.get('/teachers/:id/edit', (req, res) => {
  const teacher = db.prepare(`
    SELECT t.*, u.username, u.full_name, u.email FROM teachers t
    JOIN users u ON u.id = t.user_id WHERE t.id = ?`).get(req.params.id);
  if (!teacher) return res.status(404).render('error', { message: 'Teacher not found.', code: 404 });
  res.render('admin/teacher_form', { title: 'Edit Teacher', classes: getClasses(), teacher });
});

router.post('/teachers/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM teachers WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).render('error', { message: 'Teacher not found.', code: 404 });
  const c = v.checker();
  const f = readTeacherForm(c, req.body);
  if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
  db.prepare('UPDATE users SET full_name = ?, phone = ? WHERE id = ?').run(f.full_name, f.phone, t.user_id);
  db.prepare(`UPDATE teachers SET class_id = ?, subject = ?, phone = ?, qualification = ?,
    experience_years = ?, rating = ?, bio = ? WHERE id = ?`)
    .run(f.class_id, f.subject, f.phone, f.qualification,
      f.experience_years, f.rating, f.bio, req.params.id);
  res.redirect('/admin/teachers?updated=1');
});

// teacher profile photo — same data-URI flow as student photos
router.post('/teachers/:id/photo', (req, res) => {
  const t = db.prepare('SELECT * FROM teachers WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).render('error', { message: 'Teacher not found.', code: 404 });
  const c = v.checker();
  const photo = req.body.remove ? '' : c.image(req.body.photo, 'Photo', { max: 500000 });
  if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
  db.prepare('UPDATE teachers SET photo = ? WHERE id = ?').run(photo || null, req.params.id);
  res.redirect('/admin/teachers?photo=' + (photo ? 'saved' : 'removed'));
});

router.post('/teachers/:id/delete', (req, res) => {
  const t = db.prepare('SELECT * FROM teachers WHERE id = ?').get(req.params.id);
  if (t) {
    db.prepare('DELETE FROM users WHERE id = ?').run(t.user_id);
    db.prepare('DELETE FROM teachers WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/teachers?deleted=1');
});

// ============ TEACHER ACCESS (login + what the login may open) ============
// The whole teacher portal hangs on two switches the office owns:
//   • `teachers.can_login` — off means the teacher cannot sign in at all (and an
//     open session dies on the next click),
//   • one row in `teacher_permissions` per section.
// What the sections ARE lives in src/services/permissions.js — add one there and
// it appears on these pages, in the teacher's sidebar and in his tests.

// the list: one row per teacher with access, login state and quick actions
router.get('/teacher-access', (req, res) => {
  res.render('admin/teacher_access', {
    title: 'Teacher Access',
    teachers: permService.listTeachers(),
    sections: permService.SECTIONS,
    saved: req.query.saved, who: req.query.who,
    loginsaved: req.query.loginsaved, offsaved: req.query.offsaved,
    pwsaved: req.query.pwsaved, namesaved: req.query.namesaved || '',
    err: req.query.err || null,
  });
});

// one teacher: tick the sections that open AND the classes he may work on
router.get('/teachers/:id/permissions', (req, res) => {
  const teacher = permService.teacherById(req.params.id);
  if (!teacher) return res.status(404).render('error', { message: 'Teacher not found.', code: 404 });
  const mine = permService.classesFor(teacher).map((c) => c.id);
  res.render('admin/teacher_permissions', {
    title: `Access — ${teacher.full_name}`,
    teacher,
    classes: permService.allClasses().map((c) => ({ ...c, checked: mine.includes(c.id) })),
    scopeAll: !!teacher.all_classes,
    scopeLabel: permService.scopeLabel(teacher),
    groups: permService.grouped(),
    keys: permService.KEYS,
    granted: permService.forTeacher(teacher.id),
    saved: req.query.saved, count: req.query.count, scope: req.query.scope || '',
    err: req.query.err || null,
  });
});

router.post('/teachers/:id/permissions', (req, res) => {
  const teacher = permService.teacherById(req.params.id);
  if (!teacher) return res.status(404).render('error', { message: 'Teacher not found.', code: 404 });
  const action = String(req.body.action || 'save');   // save | all | none
  let keys;
  if (action === 'all') keys = permService.KEYS;
  else if (action === 'none') keys = [];
  else keys = permService.KEYS.filter((k) => String(req.body['perm_' + k] || '') === '1');
  const granted = permService.setForTeacher({
    teacherId: teacher.id, keys, grantedBy: req.session.user.full_name,
  });
  // WHICH classes those sections apply to. An unticked list means "his own class
  // only", which is how every teacher started out — the office is never forced to
  // think about classes just to save the sections.
  const classIds = permService.allClasses()
    .filter((c) => String(req.body['class_' + c.id] || '') === '1').map((c) => c.id);
  permService.setClassScope({
    teacherId: teacher.id,
    all: String(req.body.all_classes || '') === '1',
    classIds,
    grantedBy: req.session.user.full_name,
  });
  res.redirect(`/admin/teachers/${teacher.id}/permissions?saved=1&count=${granted.length}`
    + '&scope=' + encodeURIComponent(permService.scopeLabel(permService.teacherById(teacher.id))));
});

// The teacher's login: his name on the sign-in page, his password, and the
// office's on/off switch. A blank box keeps what is already there, so the office
// can change one thing without touching the others.
router.post('/teacher-access/:id/login', (req, res) => {
  const teacher = permService.teacherById(req.params.id);
  if (!teacher) return res.status(404).render('error', { message: 'Teacher not found.', code: 404 });
  const c = v.checker();
  const username = c.username(req.body.username, 'Login name');   // '' = keep his current one
  const password = c.password(req.body.password, 'New password', { min: 4 });
  const canLogin = c.bool(req.body.can_login);
  if (!c.ok) return res.redirect('/admin/teacher-access?err=' + encodeURIComponent(c.summary));

  // The name is checked against the whole `users` table (every login is unique),
  // so the office is told about a clash instead of breaking another account.
  let renamed = '';
  if (username && username !== teacher.username) {
    const r = permService.setUsername({ teacherId: teacher.id, username });
    if (!r.ok) return res.redirect('/admin/teacher-access?err=' + encodeURIComponent(r.error));
    renamed = r.username;
  }
  if (password) {
    // the real login hash AND the readable copy the office hands out
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), teacher.user_id);
    permService.setPortalPassword({ teacherId: teacher.id, password });
  }
  permService.setLogin({ teacherId: teacher.id, canLogin });
  res.redirect(`/admin/teacher-access?loginsaved=1&who=${encodeURIComponent(String(teacher.full_name).trim())}`
    + (renamed ? '&namesaved=' + encodeURIComponent(renamed) : '')
    + (password ? '&pwsaved=1' : '') + (canLogin ? '' : '&offsaved=1'));
});

// ============ PARENT ACCESS (what the office lets a parent see) ============
// Two controls, both in src/services/parent_access.js:
//   • every section of the parent app can be switched off (the link disappears AND the
//     page answers 403 — Fees can never be switched off),
//   • and the rest can be closed automatically for a child whose fee is due, leaving
//     Fees and the home page (where the amount and the Pay button are).
// The parent's sidebar, tab bar, home page and route guards all read that one service,
// so this page is the whole control room.
router.get('/parent-access', (req, res) => {
  const settings = parentAccess.getSettings();
  res.render('admin/parent_access', {
    title: 'Parent Access',
    settings,
    groups: parentAccess.grouped(),
    fees: parentAccess.FEES,
    bases: parentAccess.BASES,
    defaultNote: parentAccess.DEFAULT_NOTE,
    saved: req.query.saved, mode: req.query.mode || '', err: req.query.err || null,
  });
});

router.post('/parent-access', (req, res) => {
  const body = Object.assign({}, req.body);
  const action = String(body.action || 'save');
  // “Open everything” / “Close all but Fees” are just the boxes, set in one go — the
  // save itself is the same code path, so the two can never write different things.
  if (action === 'all') for (const k of parentAccess.KEYS) body['show_' + k] = '1';
  if (action === 'none') for (const k of parentAccess.KEYS) body['show_' + k] = '';
  const r = parentAccess.save(body);
  if (!r.ok) return res.redirect('/admin/parent-access?err=' + encodeURIComponent(r.error));
  res.redirect(`/admin/parent-access?saved=1&mode=${action}`);
});

// ================= MARKS =================
router.get('/marks', (req, res) => {
  const classId = parseInt(req.query.class, 10) || 0;
  const examId = parseInt(req.query.exam, 10) || 0;
  const { students, subjects, byStudent } = marksSheet.sheet(classId, examId);
  const rows = marksSheet.withTotals(students, subjects, byStudent);
  const fullMarks = marksSheet.fullMarks(subjects);
  const classes = getClasses();
  const exams = getExams();
  const exam = exams.find((e) => e.id === examId) || null;
  const analysisClass = classId ? classes.find((c) => c.id === classId) : null;

  // ---- the class board: one card per class, so entering marks is “tap the class”.
  // Every count comes from analysisSvc.forClass() — the same service the parents' Result
  // page and the dashboard rings read — so a card can never disagree with the page it
  // opens. `examId` 0 means “every exam so far”, exactly like the rings below.
  const board = classes.map((c) => {
    const a = analysisSvc.forClass(c.id, { examId });
    const state = a.children === 0 ? 'none' : a.withMarks === 0 ? 'empty' : a.withMarks >= a.children ? 'done' : 'partly';
    return {
      id: c.id,
      label: `${c.name}${c.section ? ' ' + c.section : ''}`,
      state,
      children: a.children,
      withMarks: a.withMarks,
      pending: a.pending,
      percent: a.children ? Math.round((a.withMarks / a.children) * 100) : 0,
      average: a.overall ? a.overall.value : null,
      href: `/admin/marks?class=${c.id}${examId ? '&exam=' + examId : ''}`,
      analysis: a,
    };
  });

  res.render('admin/marks', {
    title: 'Marks Entry', classes, exams, classId, examId, exam,
    students, subjects, marksByStudent: byStudent, rows, fullMarks, board,
    boardTotals: {
      classes: board.length,
      done: board.filter((b) => b.state === 'done').length,
      started: board.filter((b) => b.withMarks > 0).length,
      students: board.reduce((n, b) => n + b.children, 0),
      entered: board.reduce((n, b) => n + b.withMarks, 0),
    },
    // the class's result as circles, for the exam being entered (0 = every exam so far) —
    // it is the same object the class's own card was just built from, never a second query
    analysis: classId ? ((board.find((b) => b.id === classId) || {}).analysis || null) : null,
    analysisClassLabel: analysisClass
      ? `${analysisClass.name}${analysisClass.section ? ' ' + analysisClass.section : ''}${examId ? ' · ' + ((exam || {}).term || '') : ' · every exam so far'}`
      : '',
  });
});

// ---- exam result sheet as an A4 landscape PDF (the marks exactly as entered) ----
// The reading, the totalling and the PDF all live in src/services/marks_sheet.js,
// which the class teacher's own result-sheet button uses too — so both sides
// always print the same sheet from the same numbers.
router.get('/marks/export.pdf', (req, res) => {
  const classId = parseInt(req.query.class, 10) || 0;
  const examId = parseInt(req.query.exam, 10) || 0;
  const report = marksSheet.resultSheet({ classId, examId });
  if (!report) {
    return res.status(404).render('error', { message: 'Pick a class and an exam first, then download the result sheet.', code: 404 });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${report.fileBase}.pdf"`);
  res.setHeader('Content-Length', report.buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(report.buffer);
});

// publish an exam result for a class -> parents get notified (portal + SMS/WhatsApp alert)
router.post('/marks/publish', async (req, res, next) => {
  try {
    const c = v.checker();
    const classId = c.id(req.body.class_id, 'Class');
    const examId = c.id(req.body.exam_id, 'Exam');
    if (!c.ok) return res.status(400).render('error', { message: 'Please pick a class and an exam first.', code: 400 });
    if (!db.prepare('SELECT 1 FROM exams WHERE id = ?').get(examId)) {
      return res.status(400).render('error', { message: 'That exam does not exist.', code: 400 });
    }
    db.prepare(`INSERT INTO published_results (class_id, exam_id, published_by) VALUES (?,?,?)
               ON CONFLICT(class_id, exam_id) DO UPDATE SET published_at = datetime('now'), published_by = excluded.published_by`)
      .run(classId, examId, req.session.user.full_name);
    const exam = db.prepare('SELECT term, year FROM exams WHERE id = ?').get(examId);
    const cls = db.prepare('SELECT name, section FROM classes WHERE id = ?').get(classId);
    const alerted = await alerts.resultPublished({
      classId, examId,
      examLabel: `${exam ? exam.term : 'Result'} ${exam ? exam.year : ''}`,
      className: cls ? `${cls.name}${cls.section ? ' ' + cls.section : ''}` : '',
    });
    res.redirect(`/admin/marks?class=${classId}&exam=${examId}&published=1&alerts=${alerted}`);
  } catch (err) { next(err); }
});

router.post('/marks', (req, res) => {
  const { marks } = req.body; // marks = { studentId_subjectId: value }
  const c = v.checker();
  const classId = c.id(req.body.class_id, 'Class');
  const examId = c.id(req.body.exam_id, 'Exam');
  if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
  // Blank = "leave as it is", 0 is a real mark, and a cell outside the subject's
  // own maximum is refused with the child's and subject's name — the same rules
  // a class teacher gets on /teacher/marks, because it is the same code.
  const { badCells } = marksSheet.saveMarks({ classId, examId, marks });
  const q = new URLSearchParams({ class: String(classId), exam: String(examId), saved: '1' });
  if (badCells.length) q.set('bad', String(badCells.length));
  res.redirect(`/admin/marks?${q}`);
});

// ================= NOTICES =================
router.get('/notices', (req, res) => {
  const notices = db.prepare(`
    SELECT n.*, c.name class_name FROM notices n
    LEFT JOIN classes c ON c.id = n.target_class_id ORDER BY n.created_at DESC`).all();
  res.render('admin/notices', { title: 'Notices', notices, classes: getClasses() });
});

router.post('/notices', async (req, res, next) => {
  try {
    const c = v.checker();
    const title = c.text(req.body.title, 'Notice title', { max: 120, min: 3, required: true });
    const body = c.body(req.body.body, 'Notice text', { max: 2000, min: 3, required: true });
    // WHO the notice is for: parents (+ teachers) read an 'all' notice; a 'teachers'
    // notice hides itself from every parent list automatically. Defaults to 'all' —
    // the school said parents must never miss a school notice.
    const audience = req.body.audience === 'teachers' ? 'teachers' : 'all';
    // blank target = the whole school; a typed one must be a real class
    const target = req.body.target_class_id ? c.id(req.body.target_class_id, 'Class') : null;
    if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
    if (target && !db.prepare('SELECT 1 FROM classes WHERE id = ?').get(target)) {
      return res.status(400).render('error', { message: 'That class does not exist — please pick another one.', code: 400 });
    }
    db.prepare('INSERT INTO notices (title, body, target_class_id, posted_by, audience) VALUES (?,?,?,?,?)')
      .run(title, body, target, req.session.user.full_name, audience);
    const cls = target ? db.prepare('SELECT name, section FROM classes WHERE id = ?').get(target) : null;
    // A teachers-only notice never rings a parent's phone — alerts ride only on the
    // notices parents can actually read.
    const alerted = audience === 'all'
      ? await alerts.noticePosted({
          title, body,
          classId: target,
          className: cls ? `${cls.name}${cls.section ? ' ' + cls.section : ''}` : '',
        })
      : 0;
    res.redirect(`/admin/notices?created=1&alerts=${alerted}${audience === 'teachers' ? '&teachersOnly=1' : ''}`);
  } catch (err) { next(err); }
});

router.post('/notices/:id/delete', (req, res) => {
  db.prepare('DELETE FROM notices WHERE id = ?').run(req.params.id);
  res.redirect('/admin/notices?deleted=1');
});

// ================= TIMETABLE =================
// One screen edits the whole week: every cell is a button that opens the period
// editor (subject · teacher · what kind of period it is), each day column can be
// copied onto the other five (Monday–Saturday the same), a period can be added and
// one can be deleted. The writing itself all goes through services/timetable.js.
router.get('/timetable', (req, res) => {
  const classes = getClasses();
  const classId = parseInt(req.query.class, 10) || classes[0]?.id || 0;
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  const { grid } = timetable.weekGrid(classId);
  // the school clock's rows come first (so an empty period is still tappable), plus
  // any period the class already has a slot in
  const rows = timetable.periodRows(classId);
  // The editor opens in one of two ways, and BOTH work without JavaScript: tapped a
  // cell (?day=Monday&period=5) or pressed “➕ Add a period” (?add=1). On a phone the
  // same dialog also opens instantly from the cell's own click handler.
  const editDay = timetable.DAYS.includes(req.query.day) ? req.query.day : '';
  const editPeriod = editDay ? (parseInt(req.query.period, 10) || 0) : 0;
  const free = rows.length ? Math.min(12, rows[rows.length - 1].period + 1) : 1;
  const edit = editPeriod || req.query.add === '1'
    ? (editPeriod
      ? { day: editDay, period: editPeriod, isNew: false, slot: timetable.slot(classId, editDay, editPeriod) }
      : { day: 'Monday', period: free, isNew: true, slot: null })
    : null;
  // the teacher box is a PICK list now (school's request, 2026-09-19): the office picks a
  // name and the timetable engine builds each teacher's own week from it — a typo here
  // used to leave one period off a teacher's week forever.
  const teachers = db.prepare(`
    SELECT DISTINCT u.full_name AS name FROM teachers t
    JOIN users u ON u.id = t.user_id
    WHERE t.can_login = 1
    ORDER BY name`).all().map((r) => r.name);
  // ---- WHAT STILL HAS NO TEACHER (school's request, 2026-09-20) --------------------------
  // A period can carry a subject and still have nobody taking it — the office asked to see
  // that while the timetable is being built, so the count and the exact day/period list are
  // worked out HERE (never in a view) and each such cell is marked “Not assigned yet”.
  // A break kind (lunch, assembly…) never takes a teacher, so it is never counted.
  // ---- WHO IS ALREADY TAKEN IN A PERIOD (school's rule, 2026-09-20) ----------------------
  // One teacher cannot stand in two classes at the same day+period. This map is built once, in
  // the service (never in a view), and printed twice: the editor greys a busy name out for the
  // period being opened, and every fixer row greys out the names busy in ITS OWN period. Both
  // write routes still refuse the save — the greyed list is a help, not the guard.
  const busyElsewhere = timetable.busyMap(classId);
  const unassignedPeriods = [];
  for (const d of timetable.DAYS) {
    for (const p of rows) {
      const s = grid[d] && grid[d][p.period];
      if (!s) continue;
      if (timetable.kindMeta(s.kind || 'class').break === true) continue;
      if (String(s.teacher || '').trim()) continue;
      // `ready` tells the fixer panel whether this period even has a subject to keep: after a
      // RESET (2026-09-20) every period of the class is waiting AND empty, and such a period
      // cannot be handed out from the panel (nothing to write back) — the office opens it and
      // writes the subject first. The panel says so instead of offering a pick list that the
      // route would quietly ignore.
      unassignedPeriods.push({
        day: d, short: timetable.SHORT[d] || d,
        period: p.period, subject: s.subject || '',
        ready: !!String(s.subject || '').trim(),
        // the names this period may NOT be handed to: teacher → the class they are in then
        busy: busyElsewhere[d + '|' + p.period] || {},
      });
    }
  }
  // ---- LUNCH DUTY & EXTRA CLASSES (school's request, 2026-09-20) --------------------------
  // One day+period is on screen at a time, chosen with a plain GET (`dutyday` / `dutyperiod`)
  // so the panel works without JavaScript too. What the office may pick is worked out HERE and
  // handed to the view: only the teachers FREE at that day+period are offered (a class grid
  // carrying his name, or a duty he already has, is why he is not), and the reason a name is
  // missing is shown so nobody is left guessing. The write routes re-check all of it.
  // Lunch and extra class are intentionally independent cards. Each card owns its selected
  // days, all-days switch, period, and free-teacher intersection so changing one never changes
  // the other.
  const defaultDutyDay = timetable.todayName() || 'Monday';
  const lunchPeriod = Object.keys(grid[defaultDutyDay] || {}).map(Number)
    .find((p) => timetable.kindMeta((grid[defaultDutyDay][p] || {}).kind).key === 'lunch') || 5;
  // `weekly` = the lunch cover, which is never a single day: the teacher who takes a period
  // covers it for the whole school week (school's rule, 2026-09-20), so the day picker is not
  // offered for it and any stray `lunchday` in an old link is ignored.
  const readDutyConfig = (prefix, fallbackPeriod, options = {}) => {
    const requested = options.weekly
      ? [...timetable.DAYS]
      : listValue(req.query[`${prefix}day`]).filter((d) => timetable.DAYS.includes(d));
    const all = options.weekly || req.query[`${prefix}all`] === '1' || req.query[`${prefix}all`] === 'on';
    const selectedDays = all || !requested.length ? [...timetable.DAYS] : [...new Set(requested)];
    const parsed = parseInt(req.query[`${prefix}period`], 10);
    const period = parsed >= 1 && parsed <= 12 ? parsed : fallbackPeriod;
    const free = duties.freeTeachersForDays(teachers, selectedDays, period);
    return {
      prefix, days: selectedDays, all, weekly: !!options.weekly,
      day: selectedDays[0] || defaultDutyDay, period, free,
      taken: (teachers || []).length - free.length,
      daysLabel: selectedDays.length === timetable.DAYS.length ? 'every school day' : selectedDays.join(' · '),
    };
  };
  const lunchConfig = readDutyConfig('lunch', lunchPeriod, { weekly: true });
  const specialConfig = readDutyConfig('special', lunchPeriod);
  // Backward-compatible aliases for notices and older links. A notice that came from the
  // special card answers with THAT card's settings, so the office reads the day it acted on.
  const fromSpecial = req.query.dutykind === 'special';
  const noticeConfig = fromSpecial ? specialConfig : lunchConfig;
  const dutyDay = noticeConfig.day;
  const dutyDays = noticeConfig.days;
  const dutyAll = noticeConfig.all;
  const dutyPeriod = noticeConfig.period;
  const dutyFree = noticeConfig.free;
  const dutyTaken = noticeConfig.taken;
  const dutyDaysLabel = noticeConfig.daysLabel;
  const dutyList = duties.list();

  res.render('admin/timetable', {
    title: 'Timetable', classes, classId, cls,
    days: timetable.DAYS, shorts: timetable.SHORT, grid, periodRows: rows,
    kinds: timetable.KINDS, edit, teachers,
    // the periods with a subject but no teacher, and the day-by-day count for the notice
    unassignedPeriods,
    // the busy names: `busyHere` is for the period the editor opened on (the no-JavaScript
    // path), `busyAll` lets the script re-mark the boxes when a different cell is tapped
    busyHere: edit && edit.day ? (busyElsewhere[edit.day + '|' + edit.period] || {}) : {},
    busyAll: busyElsewhere,
    // the duty panel (lunch duty + extra classes) and the day+period it is working on
    dutyKinds: duties.KINDS, dutyDay, dutyDays, dutyDaysLabel, dutyAll, dutyPeriod, lunchPeriod,
    dutyFree, dutyTaken, dutyList, lunchConfig, specialConfig,
    // who already covers which lunch period (one chip per teacher) and the day-wise special
    // classes — read straight from the service, never assembled in the view
    lunchGrouped: duties.lunchByPeriod(), specialGrouped: duties.specialByDay(),
    dutyAdded: req.query.dutyadded || '', dutyKindSaved: req.query.dutykind || '',
    dutyRemoved: req.query.dutyremoved === '1', dutyError: req.query.dutyerr || null,
    unassignedByDay: timetable.DAYS
      .map((d) => ({ day: d, short: timetable.SHORT[d] || d, count: unassignedPeriods.filter((u) => u.day === d).length }))
      .filter((d) => d.count > 0),
    timeByPeriod: timetable.timeByPeriod(),
    periodTimes: timetable.getPeriodTimes(),
    timingsSaved: req.query.timings, saved: req.query.saved, allDaysSaved: req.query.alldays,
    deleted: req.query.deleted, periodDeleted: req.query.periodDeleted,
    copied: req.query.copied, copiedFrom: req.query.from || '',
    error: req.query.err || null,
    // homework written so far — the office writes it here for any class, exactly like the
    // class teacher does from the teacher portal (services/homework.js)
    homeworkWeek: hw.forWeek(classId),
    hwSaved: req.query.hwsaved === '1', hwCleared: req.query.hwcleared === '1',
    hwDay: timetable.DAYS.includes(req.query.hwday) ? req.query.hwday : '',
    standingNote: hw.STANDING_NOTE,
  });
});

// ---- HOMEWORK (2026-09-18): the office writes it for ANY class -------------------------
// The same rules as the teacher's portal: one note per class/day/period, an empty note
// becomes the standing “please check the copy” line at read time, and the period must
// really exist in that class's grid.
router.post('/timetable/homework', (req, res) => {
  const classes = getClasses();
  const classId = parseInt(req.body.class, 10) || 0;
  const cls = classes.find(c => c.id === classId);
  const c = v.checker();
  const day = c.choice(req.body.day, 'Day', timetable.DAYS);
  const period = c.int(req.body.period, 'Period', { min: 1, max: 12 });
  const subject = c.text(req.body.subject, 'Subject', { max: 60 });
  const note = c.text(req.body.note, 'Homework note', { max: 300 });
  const back = `/admin/timetable?class=${classId}&hwsaved=1&hwday=${encodeURIComponent(day || '')}`;
  if (!cls || !c.ok) return res.redirect(`/admin/timetable?class=${classId}&hwsaved=0`);
  const slot = db.prepare('SELECT subject FROM timetable WHERE class_id = ? AND day = ? AND period = ?')
    .get(classId, day, period);
  if (!slot) return res.redirect(`/admin/timetable?class=${classId}&hwsaved=0`);
  hw.setNote({ classId, day, period, subject: subject || slot.subject, note, givenBy: 'School office' });
  res.redirect(back);
});

router.post('/timetable/homework/clear', (req, res) => {
  const c = v.checker();
  const classId = c.id(req.body.class, 'Class');
  const day = c.choice(req.body.day, 'Day', timetable.DAYS);
  const period = c.int(req.body.period, 'Period', { min: 1, max: 12 });
  if (c.ok) hw.clearNote({ classId, day, period });
  res.redirect(`/admin/timetable?class=${classId || ''}&hwcleared=1&hwday=${encodeURIComponent(day || '')}`);
});

// the school's clock timings for each period (parents see these on every card)
router.post('/timetable/timings', (req, res) => {
  // A row is only stored when it makes sense: a period number, two clock times,
  // and an end after the start — otherwise the parent cards would show nonsense.
  // The clock-time rule itself lives in validate.js (`c.clock`).
  const list = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
  const c = v.checker();
  const periods = list(req.body.period);
  const froms = list(req.body.from);
  const tos = list(req.body.to);
  for (let i = 0; i < periods.length; i++) {
    const p = v.text(periods[i], 4);
    if (!p) continue;
    const from = c.clock(froms[i], `Period ${p} start time`);
    const to = c.clock(tos[i], `Period ${p} end time`);
    if (!from || !to) continue;
    if (timetable.to24(from) >= timetable.to24(to)) {
      c.fail(`Period ${p}: the end time must be after the start time.`);
    }
  }
  if (!c.ok) return res.redirect('/admin/timetable?err=' + encodeURIComponent(c.summary));
  const n = timetable.savePeriodTimes(req.body);
  res.redirect(`/admin/timetable?timings=${n}`);
});

// Save ONE period (the editor dialog), or the same period on all six days
// (`all_days`). A brand-new period may carry its own clock time in the same step.
router.post('/timetable', (req, res) => {
  const c = v.checker();
  const classId = c.id(req.body.class_id, 'Class');
  const day = c.choice(req.body.day, 'Day', timetable.DAYS, { required: true });
  const period = c.int(req.body.period, 'Period number', { min: 1, max: 12, required: true });
  // what the period IS. An unknown/missing value reads as a normal subject period.
  const kind = c.choice(req.body.kind, 'Period type', timetable.KIND_KEYS, { fallback: 'class' }) || 'class';
  const isBreak = timetable.isBreakKind(kind);
  // A subject period must name its subject; a break (assembly · lunch · games) has a
  // name of its own, so the box may be left empty and the kind's label is used. The words
  // say what to DO about it — “Subject is required” alone left the office guessing whether
  // the period needs a name or a break. (Measured 2026-09-20.)
  let subject = c.text(req.body.subject, 'Subject', { max: 60 });
  if (!isBreak && !subject) {
    c.fail('Subject is required — write what this period teaches, or pick a break (a break needs none).');
  }
  // the teacher must be a REAL staff name (the pick list in the editor) — a stray name
  // would build no teacher's week and silently lose the period from every teacher page.
  // A name ALREADY standing on that exact period is accepted too (school's request,
  // 2026-09-20): the demo grid carries names from the imported sheet that have no staff
  // login yet, and saving such a period answered “Teacher is not valid” — so the office
  // could not touch it at all, not even to hand it to a real teacher or leave it unassigned.
  const staffNames = db.prepare(`
    SELECT DISTINCT u.full_name AS name FROM teachers t
    JOIN users u ON u.id = t.user_id ORDER BY name`).all().map((r) => r.name);
  const standing = String((timetable.slot(classId, day, period) || {}).teacher || '').trim();
  // The refusal must say what to DO about it, exactly like the subject's words above: the
  // office hit “Teacher is not valid — please pick again” while all it wanted was to park a
  // period (school's question, 2026-09-20: “if this comes up, how do I make the existing
  // record Not assigned yet?”). So the message names the two ways out, and the flat options
  // (empty = “— Not assigned yet —”, plus whatever already stands on the period) are read
  // straight from the editor's pick list.
  let teacher = '';
  if (!isBreak) {
    teacher = c.text(req.body.teacher, 'Teacher', { max: 60 });
    const allowed = staffNames.concat([standing, '']);
    if (teacher && !allowed.includes(teacher)) {
      c.fail('That teacher is not on the school staff list — pick a name from the pick list, '
        + 'or choose “— Not assigned yet —” to leave the period without a teacher.');
      teacher = '';
    }
  }
  const allDays = c.bool(req.body.all_days);
  // ONE TEACHER, ONE CLASS AT A TIME (school's rule, 2026-09-20): a period may not be handed
  // to a name that is already standing in another class at that day+period. Only a CHANGE is
  // checked — a name already on this very cell can be saved again (the office is editing the
  // subject or just saving), which keeps the imported sheet, where 162 rows are double-booked,
  // fully editable. A break never carries a teacher, and “— Not assigned yet —” never clashes.
  if (!isBreak && teacher && teacher !== standing) {
    for (const d of (allDays ? timetable.DAYS : [day])) {
      const clash = timetable.teacherClash({ teacher, day: d, period, exceptClassId: classId });
      if (clash) { c.fail(timetable.clashMessage(teacher, clash)); break; }
    }
  }
  // “Add a period” may set the clock time too — both boxes filled, and the same rule the
  // Period timings panel uses: the end must be after the start.
  const fromRaw = v.text(req.body.from, 10);
  const toRaw = v.text(req.body.to, 10);
  let timing = null;
  if (fromRaw || toRaw) {
    const from = c.clock(fromRaw, 'Start time', { required: true });
    const to = c.clock(toRaw, 'End time', { required: true });
    if (from && to && timetable.to24(from) >= timetable.to24(to)) {
      c.fail('The period cannot end before it starts — please check the times.');
    }
    timing = { from, to };
  }
  if (!c.ok) {
    return res.redirect(`/admin/timetable?class=${classId || ''}&day=${encodeURIComponent(day)}&period=${period || ''}&err=${encodeURIComponent(c.summary)}`);
  }
  if (timing) timetable.setPeriodTime(period, timing.from, timing.to);
  const days = allDays ? timetable.DAYS : [day];
  for (const d of days) timetable.saveSlot({ classId, day: d, period, subject, teacher, kind });
  res.redirect(`/admin/timetable?class=${classId}&saved=1${allDays ? '&alldays=1' : ''}`);
});

// ---- LUNCH DUTY & EXTRA CLASSES (school's request, 2026-09-20) --------------------------
// Two sections on this board, as the school asked: one to put a teacher on lunch duty, one to hand
// out an extra class — and both must show on that teacher's own timetable. They are the same row in
// `teacher_duties` (services/duties.js), differing only in the kind: a lunch duty keeps the break
// supervised, an extra class names the class it is for. The rule the school set for both — the
// teacher must be free in that period — is enforced in the service, so this route only has to
// carry the office's answer back to the page.
router.post('/timetable/duty', (req, res) => {
  const c = v.checker();
  const classId = c.id(req.body.class_id, 'Class');
  const rawDays = listValue(req.body.days).concat(listValue(req.body.day));
  const allDays = String(req.body.all_days || '') === '1' || String(req.body.all_days || '') === 'on';
  const days = allDays ? [...timetable.DAYS] : [...new Set(rawDays.filter((d) => timetable.DAYS.includes(d)))];
  if (!days.length) c.fail('Pick at least one day.');
  const period = c.int(req.body.period, 'Period', { min: 1, max: 12, required: true });
  const kind = c.choice(req.body.kind, 'What', duties.KIND_KEYS, { required: true });
  const rawTeachers = listValue(req.body.teachers).concat(listValue(req.body.teacher));
  const teacherNames = [...new Set(rawTeachers.map((name) => c.text(name, 'Teacher', { max: 60 })).filter(Boolean))];
  if (!teacherNames.length) c.fail('Pick at least one teacher.');
  const staffNames = db.prepare(`
    SELECT DISTINCT u.full_name AS name FROM teachers t
    JOIN users u ON u.id = t.user_id ORDER BY name`).all().map((r) => r.name);
  teacherNames.forEach((name) => {
    if (!staffNames.includes(name)) c.fail(`${name} is not on the staff list — choose a free name shown on the page.`);
  });
  // Extra classes no longer ask for a class: the subject and period are enough for the
  // teacher's own timetable, and the selected teacher must still be free at that period.
  const dutyClass = null;
  const subject = kind === 'special' ? c.text(req.body.duty_subject, 'Subject', { max: 60, required: true }) : '';
  const firstDay = days[0] || '';
  const prefix = kind === 'special' ? 'special' : 'lunch';
  const back = `/admin/timetable?class=${classId || ''}&${prefix}day=${encodeURIComponent(firstDay)}&${prefix}period=${period || ''}${allDays ? `&${prefix}all=1` : ''}`;
  if (!c.ok) return res.redirect(`${back}&dutyerr=${encodeURIComponent(c.summary)}`);
  const out = duties.saveMany({ teachers: teacherNames, days, period, kind, classId: dutyClass, subject });
  if (!out.ok) return res.redirect(`${back}&dutyerr=${encodeURIComponent(out.reason)}`);
  res.redirect(`${back}&dutyadded=${out.count}&dutykind=${out.kind}`);
});

// Take one duty off the list (the ✕). Nothing else moves — the teacher simply has that hour
// back, and his own timetable shows Leisure again.
router.post('/timetable/duty/remove', (req, res) => {
  const c = v.checker();
  const classId = c.id(req.body.class_id, 'Class');
  const day = timetable.DAYS.includes(req.body.day) ? req.body.day : '';
  const period = parseInt(req.body.period, 10) || '';
  // The lunch cover is a WEEKLY job, and the board shows it as one chip per teacher. Its ✕ must
  // therefore take the WHOLE week back (2026-09-20) — otherwise one name would carry six ✕ and
  // the office would have to tap each day to undo a single decision.
  if (req.body.weekly === '1') {
    const kind = c.choice(req.body.kind, 'What', duties.KIND_KEYS, { required: true });
    const teacher = c.text(req.body.teacher, 'Teacher', { max: 80, required: true });
    if (c.ok) duties.removeTeacherPeriod({ teacher, period, kind });
  } else {
    const id = c.int(req.body.duty_id, 'Duty', { min: 1, required: true });
    if (c.ok) duties.remove(id);
  }
  res.redirect(`/admin/timetable?class=${classId || ''}&dutyday=${encodeURIComponent(day)}`
    + `&dutyperiod=${period}&dutyremoved=1`);
});

// ---- RESET one class's week (school's request, 2026-09-20) ------------------------------
// “Give the office a reset button — one tap and every period comes back as “Not assigned
// yet”, then they build the week again.” Two rules the school set, both kept here:
//   • the class IN VIEW only — the page carries this class's id in the form, and every
//     other class (and the school clock) is left exactly as it was
//   • never without the popup: the button opens the confirmation dialog and ONLY that
//     dialog's form posts here (its hidden field is what names the class)
// The rows stay and are emptied (services/timetable.resetClass), so the office's grid keeps
// every period on screen — each one reading “Not assigned yet” — and nothing is deleted.
router.post('/timetable/reset', (req, res) => {
  const c = v.checker();
  const classId = c.id(req.body.class_id, 'Class', { required: true });
  if (!c.ok) return res.redirect(`/admin/timetable?err=${encodeURIComponent(c.summary)}`);
  const cleared = timetable.resetClass(classId);
  res.redirect(`/admin/timetable?class=${classId}&reset=${cleared}`);
});

// ---- the “Not assigned yet” fixer (school's request, 2026-09-20) ------------------------
// Until a period carries a name the grid prints no subject for it, so the office asked for
// a way to hand out those periods WITHOUT opening each cell one by one. This fills only
// the name: the subject and the kind already stored are read back from the timetable and
// written unchanged, so nothing the office typed is lost — the cell simply shows its
// subject again the moment the name is in.
//   • one period  → the row's own 👤 Assign button (sends `period`)
//   • a whole day → the day header's select (sends `all=1`)
router.post('/timetable/assign', (req, res) => {
  const c = v.checker();
  const classId = c.id(req.body.class_id, 'Class');
  const day = c.choice(req.body.day, 'Day', timetable.DAYS, { required: true });
  const one = c.int(req.body.period, 'Period number', { min: 1, max: 12 });
  // the name must be a REAL staff name — the same rule the editor's pick list follows
  const staffNames = db.prepare(`
    SELECT DISTINCT u.full_name AS name FROM teachers t
    JOIN users u ON u.id = t.user_id ORDER BY name`).all().map((r) => r.name);
  const teacher = c.choice(req.body.teacher, 'Teacher', staffNames, { required: true });
  const wholeDay = c.bool(req.body.all);
  const back = `/admin/timetable?class=${classId || ''}`;
  if (!c.ok) return res.redirect(`${back}&err=${encodeURIComponent(c.summary)}`);

  // Which periods are still waiting? Worked out from the grid here — the browser is never
  // trusted with the list, and a break (lunch, assembly…) is never given a teacher. A period
  // that a RESET emptied has no subject either, so it is skipped too: this panel writes a
  // NAME only (its whole point is that the subject already stands there), and handing a name
  // to a period with nothing written in it would put a teacher on an empty cell.
  const { grid } = timetable.weekGrid(classId);
  const waiting = [];
  for (const r of timetable.periodRows(classId)) {
    const s = grid[day] && grid[day][r.period];
    if (!s) continue;
    if (timetable.kindMeta(s.kind || 'class').break === true) continue;
    if (!String(s.subject || '').trim()) continue;
    if (String(s.teacher || '').trim()) continue;
    waiting.push(r.period);
  }
  const periods = wholeDay ? waiting : (waiting.includes(one) ? [one] : []);
  if (!periods.length) return res.redirect(`${back}&assigned=0&day=${encodeURIComponent(day)}`);

  // ONE TEACHER, ONE CLASS AT A TIME (school's rule, 2026-09-20) — and here every period is
  // waiting, so the name is always new and every clash is a real one: NOTHING is written and
  // the office is told which class already has that teacher in that period. This is what makes
  // the day's “same teacher for all” box safe too — one clash refuses the whole day.
  for (const p of periods) {
    const clash = timetable.teacherClash({ teacher, day, period: p, exceptClassId: classId });
    if (clash) return res.redirect(`${back}&err=${encodeURIComponent(timetable.clashMessage(teacher, clash))}`);
  }

  let n = 0;
  for (const p of periods) {
    const s = timetable.slot(classId, day, p);
    if (!s) continue;
    timetable.saveSlot({
      classId, day, period: p,
      subject: s.subject,                 // kept exactly as typed — only the name changes
      teacher, kind: s.kind || 'class',
    });
    n += 1;
  }
  res.redirect(`${back}&assigned=${n}&who=${encodeURIComponent(teacher)}&day=${encodeURIComponent(day)}`);
});

// Remove one period (the 🗑 in the editor) — from this day, or from every day.
router.post('/timetable/delete', (req, res) => {
  const c = v.checker();
  const classId = c.id(req.body.class_id, 'Class');
  const day = c.choice(req.body.day, 'Day', timetable.DAYS, { required: true });
  const period = c.int(req.body.period, 'Period number', { min: 1, max: 12, required: true });
  const allDays = c.bool(req.body.all_days);
  if (!c.ok) return res.redirect(`/admin/timetable?class=${classId || ''}&err=${encodeURIComponent(c.summary)}`);
  const removed = allDays
    ? timetable.deletePeriod(classId, period)
    : (timetable.deleteSlot(classId, day, period) ? 1 : 0);
  res.redirect(`/admin/timetable?class=${classId}&deleted=${removed}${allDays ? '&alldays=1' : ''}`);
});

// ⧉ Copy one day's whole timetable onto the other five — “Monday se Saturday same”.
router.post('/timetable/copy-day', (req, res) => {
  const c = v.checker();
  const classId = c.id(req.body.class_id, 'Class');
  const day = c.choice(req.body.day, 'Day', timetable.DAYS, { required: true });
  if (!c.ok) return res.redirect(`/admin/timetable?class=${classId || ''}&err=${encodeURIComponent(c.summary)}`);
  // ⧉ would carry a whole day onto the other five, so the same rule is asked first. It asks it
  // about REAL STAFF names only (school's rule, 2026-09-20): a name that came with the imported
  // sheet builds no teacher's week yet, and the sheet carries 162 rows where the same imported
  // name stands in two classes at one period — checking those would make ⧉ refuse on nearly
  // every class. The editor and the fixer DO check every name, because there the office is
  // choosing a name on purpose.
  const staffOnly = db.prepare(`
    SELECT DISTINCT u.full_name AS name FROM teachers t
    JOIN users u ON u.id = t.user_id`).all().map((r) => r.name);
  for (const row of timetable.dayPeriods(classId, day)) {
    if (!String(row.teacher || '').trim()) continue;
    if (!staffOnly.includes(row.teacher)) continue;
    for (const d of timetable.DAYS.filter((x) => x !== day)) {
      const clash = timetable.teacherClash({ teacher: row.teacher, day: d, period: row.period, exceptClassId: classId });
      if (clash) return res.redirect(`/admin/timetable?class=${classId}&err=${encodeURIComponent(timetable.clashMessage(row.teacher, clash))}`);
    }
  }
  const r = timetable.copyDayToAll(classId, day);
  res.redirect(`/admin/timetable?class=${classId}&copied=${r.slots}&from=${encodeURIComponent(day)}`);
});

// Take one whole period off a class (all six days) — the 🗑 beside a period row.
router.post('/timetable/period/delete', (req, res) => {
  const c = v.checker();
  const classId = c.id(req.body.class_id, 'Class');
  const period = c.int(req.body.period, 'Period number', { min: 1, max: 12, required: true });
  if (!c.ok) return res.redirect(`/admin/timetable?class=${classId || ''}&err=${encodeURIComponent(c.summary)}`);
  const removed = timetable.deletePeriod(classId, period);
  res.redirect(`/admin/timetable?class=${classId}&periodDeleted=${removed}&period=${period}`);
});

// Add or move ONE period on the school clock (the timings panel's “Add / change” box).
// Only that one period is written, so the rest of the clock is never disturbed.
router.post('/timetable/timings/set', (req, res) => {
  const c = v.checker();
  const period = c.int(req.body.period, 'Period number', { min: 1, max: 12, required: true });
  const from = c.clock(req.body.from, 'Start time', { required: true });
  const to = c.clock(req.body.to, 'End time', { required: true });
  if (from && to && timetable.to24(from) >= timetable.to24(to)) {
    c.fail(`Period ${period}: the end time must be after the start time.`);
  }
  if (!c.ok) return res.redirect('/admin/timetable?err=' + encodeURIComponent(c.summary));
  timetable.setPeriodTime(period, from, to);
  res.redirect('/admin/timetable?timings=1');
});

// Take one period off the SCHOOL clock (Period timings panel). Its slots are kept, so
// the office can put the time back without losing the week's work.
router.post('/timetable/timings/remove', (req, res) => {
  const c = v.checker();
  const period = c.int(req.body.remove_period, 'Period number', { min: 1, max: 12, required: true });
  if (!c.ok) return res.redirect('/admin/timetable?err=' + encodeURIComponent(c.summary));
  const left = timetable.removePeriodTime(period);
  res.redirect(`/admin/timetable?timingsremoved=${period}&timings=${left}`);
});

// Take one period off every class at once?  No — a period belongs to a class; use the
// row's 🗑 on each class. (Kept as a note so the next reader does not add a school-wide
// delete: it would silently wipe six days × thirteen classes.)

// ================= EXAM TIME TABLE =================
// The school's request: "when the exams come, switch the timetable off and show the exam one."
// The office types the date-sheet here (one paper = one row, `class_id` NULL = the same
// paper for every class) and flips ONE switch. While it is on, the parents' and the
// teachers' Timetable page shows this date-sheet instead of the weekly grid — the weekly
// timetable itself is never touched, so switching off brings it back untouched.
/**
 * WHICH date-sheet is on the table: a class id, or `0` for the school-wide sheet.
 * `class=0` (and the friendlier `scope=all`) both mean “every class”; the FIRST class is
 * only fallen back to when the URL says nothing at all — otherwise `0 || first` would
 * silently turn the school-wide sheet into LKG's.
 */
function examScope(req) {
  const raw = req.query.class !== undefined
    ? String(req.query.class)
    : (req.query.scope === 'all' ? '0' : '');
  if (raw === '') return null;
  return Math.max(0, parseInt(raw, 10) || 0);
}

/**
 * WHICH exam's date-sheet is being worked on. A paper must never be typed into a void, so
 * this always answers a real exam id: the one in the URL (`?exam=`) or the form wins, else
 * the exam the switch is on for, else the newest exam in the school. `0` only when the
 * school has no exam at all — and then the page says so instead of saving loose papers.
 */
function examWorkId(req) {
  const asked = parseInt((req.body && req.body.exam) || req.query.exam, 10) || 0;
  if (asked && examSvc.getExam(asked)) return asked;
  const mode = examSvc.getMode();
  if (mode.examId) return mode.examId;
  const list = examSvc.listExams();
  return list.length ? list[0].id : 0;
}
/** The URL a write route should land back on — same class, same exam, same messages. */
const examBack = (q) => '/admin/exam-timetable?' + new URLSearchParams(q).toString();

router.get('/exam-timetable', (req, res) => {
  const classes = getClasses();
  const mode = examSvc.getMode();
  const exams = examSvc.listExams();
  const examId = examWorkId(req);
  const workExam = examId ? examSvc.getExam(examId) : null;
  const asked = examScope(req);
  const scope = asked === null ? (classes[0] ? classes[0].id : 0) : asked;
  const cls = scope ? db.prepare('SELECT * FROM classes WHERE id = ?').get(scope) : null;
  /** carry the exam AND the scope through every link and form on the page */
  const keepExam = (q = {}) => examBack({ exam: examId || '', class: scope, ...q });
  // What THIS scope really sees: its own papers PLUS the ones typed for every class, each
  // row marked so the office can tell them apart (an “every class” paper is edited in one
  // place and appears in all thirteen classes).
  const rows = examSvc.papersForClass(scope, { examId })
    .map(p => ({
      ...p,
      own: (p.class_id || 0) === scope,
      // the 12-hour clock label is built here, once — the view never formats a time
      timeLabel: (p.from_time || p.to_time)
        ? timetable.timeRange(timetable.to24(p.from_time), timetable.to24(p.to_time)) : '',
      dateLong: examSvc.dayLong(p.paper_date),
      dateShort: examSvc.dayShort(p.paper_date),
    }));
  // …grouped by date, the way the date-sheet is read
  const days = {};
  for (const p of rows) {
    if (!days[p.paper_date]) days[p.paper_date] = { date: p.paper_date, dateLong: p.dateLong, papers: [] };
    days[p.paper_date].papers.push(p);
  }
  const editId = parseInt(req.query.paper, 10) || 0;
  const paper = editId ? examSvc.getPaper(editId) : null;
  const editor = paper ? { paper, isNew: false } : (req.query.add === '1' ? { paper: null, isNew: true } : null);
  res.render('admin/exam_timetable', {
    title: 'Exam Time Table',
    classes, cls, scope, days: Object.values(days), rows,
    mode, exams, examId, workExam, keepExam,
    counts: examSvc.countsByClass({ examId }),
    editor, preview: examSvc.previewFor(scope, examId), todayISO: time.todayISO(),
    saved: req.query.saved, deleted: req.query.deleted, cleared: req.query.cleared,
    copied: req.query.copied, copyClasses: req.query.classes,
    modeSaved: req.query.mode, told: req.query.told, alerts: req.query.alerts, nosend: req.query.nosend,
    err: req.query.err || null,
  });
});

// the switch: exam mode on/off, which exam, and the sentence parents read
router.post('/exam-timetable/mode', (req, res) => {
  const c = v.checker();
  const on = c.bool(req.body.on);
  const examId = c.id(req.body.exam_id, 'Exam', { required: false }) || 0;
  const note = c.text(req.body.note, 'Message shown to parents', { max: examSvc.NOTE_MAX });
  if (!c.ok) return res.redirect('/admin/exam-timetable?err=' + encodeURIComponent(c.summary));
  examSvc.setMode({ on, examId, note });
  res.redirect(examBack({ exam: examId || '', mode: on ? 'on' : 'off' }));
});

// add or update ONE paper
router.post('/exam-timetable/paper', (req, res) => {
  const examId = examWorkId(req);
  const back = (q) => res.redirect(examBack({ exam: examId || '', class: req.body.scope_class || '', ...q }));
  const c = v.checker();
  const id = c.id(req.body.id, 'Paper', { required: false }) || 0;
  const classId = c.id(req.body.class_id, 'Class', { required: false }) || 0;   // blank = every class
  const paperDate = c.dateISO(req.body.paper_date, 'Exam date', { required: true });
  const subject = c.text(req.body.subject, 'Subject', { max: examSvc.SUBJECT_MAX, required: true });
  const from = c.clock(req.body.from, 'Start time');
  const to = c.clock(req.body.to, 'End time');
  if ((from && !to) || (!from && to)) c.fail('Please give both the start and the end time (or leave both empty).');
  if (from && to && timetable.to24(from) >= timetable.to24(to)) {
    c.fail('The paper cannot end before it starts — please check the times.');
  }
  const note = c.text(req.body.note, 'Note', { max: examSvc.PAPER_NOTE_MAX });
  if (!c.ok) return back({ err: c.summary });
  if (!examId) return back({ err: 'Pick the exam first — a paper has to belong to an exam.' });
  const r = examSvc.savePaper({
    id, examId, classId,
    paper_date: paperDate, subject, note,
    from_time: from ? timetable.to24(from) : '',
    to_time: to ? timetable.to24(to) : '',
  });
  if (!r.ok) return back({ err: r.error });
  back({ saved: r.updated ? '1' : 'new' });
});

router.post('/exam-timetable/paper/delete', (req, res) => {
  const examId = examWorkId(req);
  const c = v.checker();
  const id = c.id(req.body.id, 'Paper', { required: true });
  if (!c.ok) return res.redirect(examBack({ exam: examId || '', class: req.body.scope_class || '', err: c.summary }));
  const gone = examSvc.deletePaper(id);
  res.redirect(examBack({ exam: examId || '', class: req.body.scope_class || '', deleted: gone ? 1 : 0 }));
});

// empty ONE scope — a class's own papers, or the school-wide sheet (“all classes”)
router.post('/exam-timetable/clear', (req, res) => {
  const examId = examWorkId(req);
  const c = v.checker();
  const classId = c.id(req.body.class_id, 'Class', { required: false }) || 0;
  if (!c.ok) return res.redirect(examBack({ exam: examId || '', class: classId, err: c.summary }));
  const n = examSvc.clearPapers(classId, { examId });
  res.redirect(examBack({ exam: examId || '', class: classId, cleared: n }));
});

// ⧉ copy a date-sheet onto other classes (their own papers of this exam are replaced)
router.post('/exam-timetable/copy', (req, res) => {
  const c = v.checker();
  const from = c.id(req.body.from_class_id, 'Copy from', { required: false }) || 0;
  const raw = Array.isArray(req.body.to_class_id) ? req.body.to_class_id : [req.body.to_class_id];
  const to = raw.map(x => parseInt(x, 10) || 0).filter(Boolean);
  if (!to.length) c.fail('Please pick at least one class to copy the date-sheet to.');
  const examId = examWorkId(req);
  if (!c.ok) return res.redirect(examBack({ exam: examId || '', class: from || '', err: c.summary }));
  const r = examSvc.copyPapers({ examId, fromClassId: from, toClassIds: to });
  res.redirect(examBack({ exam: examId || '', class: from || '', copied: r.papers, classes: r.classes }));
});

// 📲 send the date-sheet to the parents (portal message + SMS/WhatsApp log)
router.post('/exam-timetable/tell', async (req, res, next) => {
  try {
    const c = v.checker();
    const scope = c.choice(req.body.scope, 'Send to', ['all', 'class'], { required: true });
    const classId = scope === 'class' ? c.id(req.body.class_id, 'Class') : 0;
    const examId = examWorkId(req);
    if (!c.ok) return res.redirect(examBack({ exam: examId || '', class: classId, err: c.summary }));
    const targets = scope === 'class' ? msg.getParentIdsForClass(classId) : msg.getAllParentIds();
    if (!targets.length) return res.redirect(examBack({ exam: examId || '', class: classId, nosend: 1 }));
    const message = examSvc.tellMessage(classId, { examId });
    const sent = await msg.sendToParents({
      targets, adminName: req.session.user.full_name,
      category: message.category, subject: message.subject, body: message.body,
    });
    const sheet = examSvc.forClass(classId, { examId });
    const alerted = await alerts.examSheet({
      classId: scope === 'class' ? classId : null,
      label: message.label,
      first: sheet.summary.first ? sheet.summary.first.dateShort : '',
      last: sheet.summary.last ? sheet.summary.last.dateShort : '',
    });
    res.redirect(examBack({ exam: examId || '', class: classId, told: sent, alerts: alerted }));
  } catch (err) { next(err); }
});

// ================= FEE STRUCTURE (full sheet — day/hostel per class, publicly shown) =================
const FEE_PDF_PATH = path.join(__dirname, '..', '..', 'public', 'uploads', 'fee-structure.pdf');

router.get('/fee-structure', (req, res) => {
  const classes = db.prepare('SELECT * FROM classes ORDER BY id').all();
  const routes = db.prepare('SELECT * FROM bus_routes ORDER BY sort_order, id').all();
  const err = req.query.err;
  res.render('admin/fee_structure', {
    title: 'Fee Structure', classes, routes,
    saved: req.query.saved, created: req.query.created, deleted: req.query.deleted, err,
    repriced: req.query.repriced,
    routesaved: req.query.routesaved, routedeleted: req.query.routedeleted,
    hasFeePdf: fs.existsSync(FEE_PDF_PATH),
    pdfsaved: req.query.pdfsaved, pdfremoved: req.query.pdfremoved,
  });
});

// upload / remove the fee-structure PDF that the public fee page offers for download
router.post('/fee-structure/pdf', (req, res) => {
  if (req.body.action === 'remove') {
    try { fs.unlinkSync(FEE_PDF_PATH); } catch (e) { /* file already gone */ }
    return res.redirect('/admin/fee-structure?pdfremoved=1');
  }
  const m = String(req.body.fee_pdf || '').match(/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.redirect('/admin/fee-structure?err=' + encodeURIComponent('Please upload only a PDF file.'));
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100) return res.redirect('/admin/fee-structure?err=' + encodeURIComponent('The PDF looks empty — please try another file.'));
  if (buf.length > 8 * 1024 * 1024) return res.redirect('/admin/fee-structure?err=' + encodeURIComponent('The PDF is larger than 8MB — please upload a smaller file.'));
  fs.mkdirSync(path.dirname(FEE_PDF_PATH), { recursive: true });
  fs.writeFileSync(FEE_PDF_PATH, buf);
  res.redirect('/admin/fee-structure?pdfsaved=1');
});

router.post('/fee-structure', (req, res) => {
  const upd = db.prepare(`UPDATE classes SET
    adm_day=?, adm_hostel=?, form_day=?, form_hostel=?, annual_day=?, annual_hostel=?,
    misc_day=?, misc_hostel=?, tuition_day=?, tuition_hostel=?, reg_day=?, reg_hostel=?, book_price=?
    WHERE id=?`);
  // Every fee on the sheet is money, checked by the shared checker: a blank box
  // counts as 0, but a box that is not a number refuses the WHOLE save (and says
  // which one) instead of quietly becoming 0 on a page parents can read.
  const c = v.checker();
  const money = (key, label) => {
    const n = c.amount(req.body[key], label, { min: 0, max: 10000000, fallback: 0 });
    return n === null ? 0 : n;
  };
  const FEE_COLUMNS = [
    ['adm', 'admission fee'], ['form', 'form fee'], ['annual', 'annual fee'],
    ['misc', 'miscellaneous fee'], ['tuition', 'monthly tuition'], ['reg', 'registration fee'],
  ];
  const rows = getClasses().map((cls) => {
    const id = cls.id;
    const where = cls.name + (cls.section ? ' ' + cls.section : '');
    const values = [];
    for (const [key, label] of FEE_COLUMNS) {
      values.push(money(`${key}_day_${id}`, `${where} · ${label} (day scholar)`));
      values.push(money(`${key}_hostel_${id}`, `${where} · ${label} (hostel)`));
    }
    values.push(money(`book_${id}`, `${where} · book price`));
    return { values: [...values, id] };
  });
  if (!c.ok) {
    const msg = c.errors.slice(0, 3).join(' ') + (c.errors.length > 3 ? ` (+${c.errors.length - 3} more)` : '');
    return res.redirect('/admin/fee-structure?err=' + encodeURIComponent(msg));
  }
  const txn = db.transaction(() => {
    for (const r of rows) upd.run(...r.values);
  });
  txn();
  // unpaid installments follow the new class tuition, so the ledger never shows old prices
  const repriced = getClasses().reduce((sum, c) => sum + feeLedger.retuneClass(c.id), 0);
  res.redirect('/admin/fee-structure?saved=1&repriced=' + repriced);
});

// add a new class (name + section). Fees default to blank/new — edit after adding.
router.post('/classes/new', (req, res) => {
  const c = v.checker();
  // "Class 11" / "LKG" / "Nursery" — letters, digits and spaces only
  const rawName = c.text(req.body.name, 'Class name', { max: 30, min: 1, required: true });
  const name = rawName.replace(/\s+/g, ' ');
  if (name && !/^[A-Za-z0-9][A-Za-z0-9 .-]{0,29}$/.test(name)) {
    return res.redirect('/admin/fee-structure?err=' + encodeURIComponent('Class name should be letters, digits and spaces only.'));
  }
  const section = c.text(req.body.section, 'Section', { max: 3 }).toUpperCase() || 'A';
  if (!name) return res.redirect('/admin/fee-structure?err=' + encodeURIComponent('Enter a class name.'));
  if (db.prepare('SELECT 1 FROM classes WHERE name = ? AND section = ?').get(name, section)) {
    return res.redirect('/admin/fee-structure?err=' + encodeURIComponent('That class already exists.'));
  }
  db.prepare(`INSERT INTO classes (name, section)
    VALUES (?,?)`).run(name, section);
  res.redirect('/admin/fee-structure?created=1');
});

// delete a class — only allowed when nothing references it (students/fees/marks)
router.post('/classes/:id/delete', (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
  if (!cls) return res.redirect('/admin/fee-structure');
  const refs = db.prepare(`SELECT
      (SELECT COUNT(*) FROM students WHERE class_id = ?) +
      (SELECT COUNT(*) FROM fees WHERE student_id IN (SELECT id FROM students WHERE class_id = ?)) +
      (SELECT COUNT(*) FROM marks WHERE student_id IN (SELECT id FROM students WHERE class_id = ?)) +
      (SELECT COUNT(*) FROM timetable WHERE class_id = ?) +
      (SELECT COUNT(*) FROM teachers WHERE class_id = ?) AS c`).get(cls.id, cls.id, cls.id, cls.id, cls.id).c;
  if (refs > 0) {
    return res.redirect('/admin/fee-structure?err=' + encodeURIComponent(`${cls.name}${cls.section ? ' ' + cls.section : ''} cannot be deleted — first remove its students, teachers and timetable.`));
  }
  db.prepare('DELETE FROM classes WHERE id = ?').run(cls.id);
  db.prepare('DELETE FROM subjects WHERE class_id = ?').run(cls.id);
  res.redirect('/admin/fee-structure?deleted=1');
});

// ================= BUS ROUTES (conveyance, public fee page) =================
router.post('/bus-routes', (req, res) => {
  const c = v.checker();
  const route_name = c.text(req.body.route_name, 'Route name', { max: 60, min: 2, required: true });
  const fare = c.amount(req.body.fare, 'Monthly fare', { min: 0, max: 100000, fallback: 0 });
  if (!c.ok) return res.redirect('/admin/fee-structure?err=' + encodeURIComponent(c.first));
  const n = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 m FROM bus_routes').get().m;
  db.prepare('INSERT INTO bus_routes (route_name, fare, sort_order) VALUES (?,?,?)')
    .run(route_name, fare, n);
  res.redirect('/admin/fee-structure?routesaved=1');
});

router.post('/bus-routes/:id/delete', (req, res) => {
  db.prepare('DELETE FROM bus_routes WHERE id = ?').run(req.params.id);
  res.redirect('/admin/fee-structure?routedeleted=1');
});

// ================= THE SCHOOL STORE (books, uniform, stationery) =================
//
// A family pays for more than the monthly fee: a book set, a uniform, notebooks. The
// school's own price list lives here, the office records what a child took, and the money
// is received against that record (in full or in parts) — the same shape a fee month has.
// Nothing on this page writes a `fees` row: src/services/store.js keeps its own ledger, and
// the parent's fee page + the fee reminders read it beside the monthly bill.
//
// The page fits a phone: the price list is one card per item, the issues list is the shared
// `.card-table`, and every action (settle · unpaid · remove) is a full-width button.
router.get('/store', (req, res) => {
  const classId = parseInt(req.query.class, 10) || 0;
  const status = ['due', 'partial', 'paid'].includes(String(req.query.status)) ? String(req.query.status) : '';
  const store = require('../services/store');
  const issues = store.rows({ classId, status, limit: 300 });
  res.render('admin/store', {
    title: 'School store',
    classes: getClasses(), classId, status,
    students: listStudents({ where: [], args: [] }),
    catalogue: store.catalogue(), sellable: store.sellable(),
    categories: store.CATEGORIES, modes: store.MODES,
    issues,
    dues: store.duesFor({ classId }),
    stats: store.summary({ classId }),
    currency: config.currency,
    itemSaved: req.query.itemsaved ? String(req.query.itemsaved) : '',
    itemCreated: req.query.itemcreated === '1',
    itemOff: req.query.itemoff ? String(req.query.itemoff) : '',
    itemDeleted: req.query.itemdeleted ? String(req.query.itemdeleted) : '',
    issued: req.query.issued ? String(req.query.issued) : '',
    issuedAmount: Number(req.query.amount) || 0,
    settled: req.query.settled ? String(req.query.settled) : '',
    unsettled: req.query.unsettled ? String(req.query.unsettled) : '',
    issueDeleted: req.query.issuedeleted ? String(req.query.issuedeleted) : '',
    err: req.query.err || null,
  });
});

/** Where an answer goes: the store page keeps the office's class filter and its place. */
function storeBack(req, query) {
  const q = new URLSearchParams(query);
  const cls = String((req.body && req.body.filter_class) || '').trim();
  if (cls) q.set('class', cls);
  return `/admin/store?${q}`;
}

// add an item to the price list, or save one the office edited
router.post('/store/items', (req, res) => {
  const store = require('../services/store');
  const r = store.saveItem(req.body);
  if (!r.ok) return res.redirect(storeBack(req, { err: r.error }) + '#price-list');
  res.redirect(storeBack(req, r.created
    ? { itemcreated: '1', itemsaved: String(req.body.name || '').trim() }
    : { itemsaved: String(req.body.name || '').trim() }) + '#price-list');
});

// stop offering an item (its history stays on the children's bills) — or offer it again
router.post('/store/items/:id/toggle', (req, res) => {
  const store = require('../services/store');
  const on = String(req.body.active) === '1';
  const r = store.toggleItem(parseInt(req.params.id, 10), on);
  if (!r.ok) return res.redirect(storeBack(req, { err: r.error }) + '#price-list');
  res.redirect(storeBack(req, { itemoff: `${r.name}${on ? ' is offered again' : ' is no longer offered'}` }) + '#price-list');
});

// delete an item that nobody has taken (refused, by name, once a child has one)
router.post('/store/items/:id/delete', (req, res) => {
  const store = require('../services/store');
  const r = store.deleteItem(parseInt(req.params.id, 10));
  if (!r.ok) return res.redirect(storeBack(req, { err: r.error }) + '#price-list');
  res.redirect(storeBack(req, { itemdeleted: r.name }) + '#price-list');
});

// record what a child took — the amount comes from the price list × the quantity
router.post('/store/issue', (req, res) => {
  const store = require('../services/store');
  const r = store.issue(req.body);
  if (!r.ok) return res.redirect(storeBack(req, { err: r.error }) + '#record');
  const row = store.issueById(r.id);
  res.redirect(storeBack(req, {
    issued: `${row.name}${row.qty > 1 ? ` × ${row.qty}` : ''} → ${row.full_name}`,
    amount: String(Math.round(row.amount)),
  }) + '#issues');
});

// money received against one issue (a part payment leaves a balance)
router.post('/store/issues/:id/settle', (req, res) => {
  const store = require('../services/store');
  const r = store.settle(parseInt(req.params.id, 10), req.body);
  if (!r.ok) return res.redirect(storeBack(req, { err: r.error }) + '#issues');
  res.redirect(storeBack(req, {
    settled: r.balance > 0
      ? `₹${Math.round(r.paid).toLocaleString('en-IN')} received · ₹${Math.round(r.balance).toLocaleString('en-IN')} still to pay`
      : `Settled in full (₹${Math.round(r.paid).toLocaleString('en-IN')})`,
  }) + '#issues');
});

// the office made a mistake: clear the money on one row
router.post('/store/issues/:id/unsettle', (req, res) => {
  const store = require('../services/store');
  const r = store.unsettle(parseInt(req.params.id, 10));
  if (!r.ok) return res.redirect(storeBack(req, { err: r.error }) + '#issues');
  res.redirect(storeBack(req, { unsettled: r.name }) + '#issues');
});

router.post('/store/issues/:id/delete', (req, res) => {
  const store = require('../services/store');
  const r = store.deleteIssue(parseInt(req.params.id, 10));
  if (!r.ok) return res.redirect(storeBack(req, { err: r.error }) + '#issues');
  res.redirect(storeBack(req, { issuedeleted: `${r.name} (${r.student})` }) + '#issues');
});

// ================= HOSTEL (the hostel the children live in) =================
//
// Four things live on this one page, because they are one job:
//   • the fee charges the public hostel page shows (`hostel_fees`),
//   • the weekly MESS MENU — what a boarder eats, day by day (2026-09-16),
//   • the DAILY ROUTINE — how his day goes (2026-09-16),
//   • the ROSTER of boarders, with the month each one joined and his room.
// The menu and the routine are what a hostel parent reads in the app, and they fit a
// phone: one card per day for the menu, one line per entry for the routine.
router.get('/hostel', (req, res) => {
  const fees = db.prepare('SELECT * FROM hostel_fees ORDER BY sort_order').all();
  const monthlyTotal = fees.filter(f => f.kind === 'monthly').reduce((a, f) => a + f.amount, 0);
  const week = hostelSvc.week();
  const today = week.find((d) => d.isToday) || null;
  // The roster comes with its MONEY (`hostelSvc.roster()`): the monthly fee still owed and what
  // the family took from the school store. That is what the send-due icon beside a name acts on,
  // and it is read from services/fees.js + services/store.js, never re-added up here.
  const roster = hostelSvc.roster();
  res.render('admin/hostel', {
    title: 'Hostel', fees, monthlyTotal,
    week, today, menu: hostelSvc.menuRows(), menuCount: hostelSvc.menuCount(),
    meals: hostelSvc.MEALS, routine: hostelSvc.routine(),
    boarders: roster.list, boarderCount: roster.totals.boarders, hostelMoney: roster.totals,
    boarderOwing: roster.totals.owing,
    hostel: hostelSvc.info(), currency: config.currency,
    saved: req.query.saved, skipped: Number(req.query.skipped) || 0,
    menusaved: req.query.menusaved ? Number(req.query.menusaved) : null,
    menuclear: Number(req.query.menuclear) || 0,
    routinesaved: req.query.routinesaved ? Number(req.query.routinesaved) : null,
    stayDone: req.query.staydone ? String(req.query.staydone) : '',
    err: req.query.err || null,
    // the answer to the send-due icon beside a name (the same flash the fees list uses)
    remindedOne: req.query.remindedOne || '',
    remindMonths: req.query.months, remindAmount: req.query.amount,
    remindAlerts: req.query.alerts, remindErr: req.query.remindErr || null,
  });
});

// the weekly mess menu — one field per day + meal (`items_Monday_Breakfast`)
router.post('/hostel/menu', (req, res) => {
  const r = hostelSvc.saveMenu(req.body);
  if (!r.ok) return res.redirect('/admin/hostel?err=' + encodeURIComponent(r.error));
  const q = new URLSearchParams({ menusaved: `${r.saved}` });
  if (r.cleared) q.set('menuclear', String(r.cleared));
  res.redirect(`/admin/hostel?${q}#mess`);
});

// the hostel's daily routine — a list of (time, activity, note) lines
router.post('/hostel/routine', (req, res) => {
  const r = hostelSvc.saveRoutine(req.body);
  if (!r.ok) return res.redirect('/admin/hostel?err=' + encodeURIComponent(r.error));
  res.redirect(`/admin/hostel?routinesaved=${r.saved}#routine`);
});

// One-tap "he is in the hostel now" / "he has gone home" from the roster — the same
// columns the student form writes, and the same re-pricing the ledger needs.
router.post('/hostel/boarders/:id/stay', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });
  const want = String(req.body.stay || '').trim();
  if (!staySvc.STAY_KEYS.includes(want)) {
    return res.redirect('/admin/hostel?err=' + encodeURIComponent('Choose day scholar or hostel student.'));
  }
  const next = want === 'hostel'
    ? { ...staySvc.normalise({ stay: 'hostel', hostel_from: req.body.hostel_from, hostel_until: req.body.hostel_until, hostel_bed: req.body.hostel_bed }), }
    : staySvc.normalise({ stay: 'day' });
  db.prepare('UPDATE students SET stay = ?, hostel_from = ?, hostel_until = ?, hostel_bed = ? WHERE id = ?')
    .run(next.stay, blankToNull(next.hostel_from), blankToNull(next.hostel_until), blankToNull(next.hostel_bed), student.id);
  feeLedger.syncStudent({ studentId: student.id });
  const changed = feeLedger.retuneStudent(student.id);
  const done = `${student.full_name} — ${staySvc.stayLabel({ stay: next.stay })}${changed ? ` (${changed} month(s) re-priced)` : ''}`;
  // switched from the child's profile → the answer belongs on that profile
  if (req.body.back_to === 'profile') {
    return res.redirect(`/admin/students/${student.id}?staydone=${encodeURIComponent(done)}`);
  }
  res.redirect(`/admin/hostel?staydone=${encodeURIComponent(done)}#boarders`);
});

router.post('/hostel', (req, res) => {
  const rows = db.prepare('SELECT * FROM hostel_fees ORDER BY sort_order').all();
  const upd = db.prepare('UPDATE hostel_fees SET label = ?, amount = ?, note = ?, kind = ? WHERE id = ?');
  // A row with a label and a real amount is saved; anything else is SKIPPED and
  // counted, so the office is told instead of quietly thinking it saved.
  let saved = 0, skipped = 0;
  const txn = db.transaction(() => {
    for (const r of rows) {
      const c = v.checker();
      const label = c.text(req.body[`label_${r.id}`], 'Fee label', { max: 60 });
      const amount = c.amount(req.body[`amount_${r.id}`], 'Amount', { min: 0, max: 10000000 });
      const note = c.text(req.body[`note_${r.id}`], 'Note', { max: 120 });
      const kind = req.body[`kind_${r.id}`] === 'onetime' ? 'onetime' : 'monthly';
      if (!label || amount === null) { skipped++; continue; }
      upd.run(label, amount, note, kind, r.id);
      saved++;
    }
  });
  txn();
  const q = new URLSearchParams({ saved: `${saved}` });
  if (skipped) q.set('skipped', String(skipped));
  res.redirect(`/admin/hostel?${q}`);
});

// ================= ABOUT SCHOOL (public about page content) =================
router.get('/about', (req, res) => {
  const about = site.getAll();
  res.render('admin/about', { title: 'About School', about, saved: req.query.saved });
});

router.post('/about', (req, res) => {
  site.save(req.body);
  res.redirect('/admin/about?saved=1');
});

// ================= HOMEPAGE / WEBSITE CONTENT =================
// Everything shown on the landing page — hero slide text, stats numbers,
// feature cards, about teaser — plus photo uploads that replace the
// bundled slide / gallery images.
const HOME_IMAGES = {
  hero1: ['Hero slide 1', 'slides/slide-1.png'],
  hero2: ['Hero slide 2', 'slides/slide-2.png'],
  hero3: ['Hero slide 3', 'slides/slide-3.png'],
  hero4: ['Hero slide 4', 'slides/slide-4.png'],
  aboutImg: ['About section photo', 'school-building.png'],
  g1: ['Gallery · Our Teachers', 'gallery/g1.png'],
  g2: ['Gallery · Our Students', 'gallery/g2.png'],
  g3: ['Gallery · Classrooms', 'gallery/g3.png'],
  g5: ['Gallery · School Life', 'gallery/g5.png'],
  g6: ['Gallery · School Transport', 'gallery/g6.png'],
  poster1: ['Poster 1', 'poster-1.png'],
  poster2: ['Poster 2', 'poster-2.png'],
  poster3: ['Poster 3', 'poster-3.png'],
  poster4: ['Poster 4', 'poster-4.png'],
};

function saveImageFromDataUri(dataUri, relPath) {
  const m = /^data:image\/(jpeg|png|webp|gif);base64,(.+)$/.exec(String(dataUri || ''));
  if (!m) return false;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 6 * 1024 * 1024) return false;
  const abs = path.join(__dirname, '..', '..', 'public', 'images', relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return true;
}

router.get('/homepage', (req, res) => {
  res.render('admin/homepage', {
    title: 'Homepage', home: site.getHome(),
    images: HOME_IMAGES, saved: req.query.saved, error: req.query.error,
    removed: req.query.removed || 0,
  });
});

// ================= CONTACT PAGE CONTENT =================
router.get('/contact-page', (req, res) => {
  res.render('admin/contact_page', {
    title: 'Contact Page', ct: site.getContact(), school: config,
    saved: req.query.saved, error: req.query.error,
  });
});

router.post('/contact-page', (req, res) => {
  if (req.body.ctMapShow === undefined) req.body.ctMapShow = '0';
  site.saveContact(req.body);
  // WhatsApp flags per phone number (saved into config-like DB keys)
  const phones = config.schoolPhones || [];
  const wa = phones.map((p, i) => (req.body['ctWa' + i] !== undefined));
  const waKey = JSON.stringify(wa);
  const upsert = db.prepare('INSERT INTO site_content (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run('phoneWhatsappFlags', waKey);
  res.redirect('/admin/contact-page?saved=1');
});

router.post('/homepage', (req, res) => {
  // checkboxes: absent from the form means unchecked ('0')
  for (const cb of ['admShow', 'hostelShow', 'posterShow']) {
    if (req.body[cb] === undefined) req.body[cb] = '0';
  }
  site.saveHome(req.body);
  let changed = 0, failed = 0, removed = 0;
  for (const key of Object.keys(HOME_IMAGES)) {
    const field = key + 'Photo';
    if (req.body[field] && /^data:image\//.test(req.body[field])) {
      if (saveImageFromDataUri(req.body[field], HOME_IMAGES[key][1])) changed++;
      else failed++;
    }
  }
  // poster slots can be emptied: "Remove this poster" deletes the file so the
  // slot disappears from the public slider (hero/gallery uploads never remove)
  for (const key of ['poster1', 'poster2', 'poster3', 'poster4']) {
    if (req.body[key + 'Remove'] === '1' && !req.body[key + 'Photo']) {
      try {
        fs.unlinkSync(path.join(__dirname, '..', '..', 'public', 'images', HOME_IMAGES[key][1]));
        removed++;
      } catch (e) { /* file already absent */ }
    }
  }
  if (failed) {
    res.redirect('/admin/homepage?error=' + encodeURIComponent('Text saved. ' + failed + ' photo(s) could not be saved (too large or invalid).'));
  } else if (removed) {
    res.redirect('/admin/homepage?saved=1&removed=' + removed);
  } else {
    res.redirect('/admin/homepage?saved=1');
  }
});

// ================= SMS/WHATSAPP ALERTS (log of alerts sent to parents) =================
router.get('/alerts', (req, res) => {
  const event = req.query.event || '';
  const alertsList = db.prepare(`
    SELECT * FROM alert_log
    ${event ? 'WHERE event = ?' : ''}
    ORDER BY id DESC LIMIT 200`).all(...(event ? [event] : []));
  const counts = {
    // "today" means the school's IST day — alert_log dates are UTC
    today: (() => { const b = time.istDayBoundsUTC(); return db.prepare('SELECT COUNT(*) c FROM alert_log WHERE created_at >= ? AND created_at < ?').get(b.from, b.to).c; })(),
    sms: db.prepare("SELECT COUNT(*) c FROM alert_log WHERE channel = 'sms'").get().c,
    whatsapp: db.prepare("SELECT COUNT(*) c FROM alert_log WHERE channel = 'whatsapp'").get().c,
    demo: db.prepare("SELECT COUNT(*) c FROM alert_log WHERE status = 'demo'").get().c,
    sent: db.prepare("SELECT COUNT(*) c FROM alert_log WHERE status = 'sent'").get().c,
  };
  res.render('admin/alerts', {
    title: 'Parent Alerts', list: alertsList, event, counts,
    smsOn: alerts.smsEnabled(), waOn: alerts.waEnabled(),
  });
});

// ================= FEES =================
// Students are added/edited from the Students page, so the monthly installment
// rows are kept in sync here — every student always shows up in Fees Management.
//
// Money since 2026-09-14: a month can be paid in parts (receipts live in
// `fee_payments`) and the office can add a late fine. Every total on this page
// comes from `feeLedger`, so the office and the parent portal can never disagree.
const FEE_STATUSES = feeLedger.STUDENT_STATUS;   // all | due | partial | overdue | cleared

// the student + their parent, as every fee action needs them (404 when unknown)
function feeStudent(id) {
  return db.prepare(`
    SELECT s.id, s.full_name, s.parent_user_id, s.parent_phone, s.parent_name,
           c.name AS class_name, c.section
    FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(id);
}

// student-wise overview: one row per student, their 12 months live on their own page
router.get('/fees', (req, res) => {
  const classId = parseInt(req.query.class, 10) || 0;
  const synced = feeLedger.syncStudent({ classId: classId || null });
  const q = String(req.query.q || '').trim();
  const status = FEE_STATUSES.includes(req.query.status) ? req.query.status : 'all';

  const all = feeLedger.ledger({ classId, q });
  const totals = feeLedger.summary({ classId, q });
  const students = status === 'all' ? all : all.filter((s) => (status === 'due' ? s.status !== 'cleared' : s.status === status));
  // Who the reminder button can reach, in the two scopes the office asked for:
  //   overdue — a real balance PAST its due date (the default, and the safe one)
  //   dues    — every student with a balance on any month, later months included
  // Both counts are computed here so the button shows exactly what it will send.
  const overdueDues = feeLedger.dues({ classId });
  const allDues = feeLedger.dues({ classId, overdueOnly: false });
  const sum = (list) => list.reduce((n, d) => n + d.due, 0);

  res.render('admin/fees', {
    title: 'Fees', students, classes: getClasses(), classId, q, status,
    totals, feesTotal: totals.sessionTotal,
    dueCount: overdueDues.length,
    dueAmount: sum(overdueDues),
    allDueCount: allDues.length,
    allDueAmount: sum(allDues),
    // money that actually came in, for the office's own filter scope
    collected: feeLedger.collections({ classId }),
    reminded: req.query.reminded,
    notified: req.query.notified,
    remindedStudents: req.query.students,
    remindedWho: req.query.who,
    // the same answer, for a reminder sent from the send icon beside a name on this page
    remindedOne: req.query.remindedOne,
    remindMonths: req.query.months,
    remindAmount: req.query.amount,
    remindErr: req.query.remindErr,
    created: synced.created,
    paid: req.query.paid, unpaid: req.query.unpaid,
    payErr: req.query.payErr,
    // “how parents pay” — UPI / bank / QR, edited on this page (payments.js)
    pay: payments.get(),
    paysaved: req.query.paysaved, paySaveErr: req.query.paySaveErr || null,
    // what parents say they have paid — the office's to-do list
    claims: feeLedger.pendingClaims(),
    claimAmount: feeLedger.claimStats().amount,
    claimRecorded: req.query.claimRecorded, claimRejected: req.query.claimRejected,
    term: req.query.term,
  });
});

// The office's own payment details: where a parent sends the fee.
// One form, one place (src/services/payments.js) — the parent's Fees page reads the
// very same values, so the UPI id a parent copies is the one the office typed.
router.post('/fees/payment-details', (req, res) => {
  const r = payments.save(req.body);
  if (!r.ok) return res.redirect('/admin/fees?paySaveErr=' + encodeURIComponent(r.error));
  res.redirect('/admin/fees?paysaved=1');
});

// one student's ledger: only their month-by-month details
router.get('/fees/:studentId(\\d+)', (req, res) => {
  const studentId = parseInt(req.params.studentId, 10);
  feeLedger.syncStudent({ studentId });
  const student = feeLedger.studentLedger(studentId);
  if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });
  const filterClass = parseInt(req.query.class, 10) || student.class_id;
  res.render('admin/fee_student', {
    title: `Fees - ${student.full_name}`, student, filterClass,
    payModes: feeLedger.PAY_MODES,
    // which of a month's two bills a receipt settled — '' (school fee first) | 'school' | 'hostel'
    payParts: feeLedger.PAY_PARTS,
    saved: req.query.saved, notified: req.query.notified,
    paid: req.query.paid, feeTerm: req.query.term, fined: req.query.fined,
    payErr: req.query.payErr, fineErr: req.query.fineErr,
    // this child's own claims (waiting ones can be recorded right here)
    claims: feeLedger.studentClaims(studentId, { limit: 10 }),
    claimRecorded: req.query.claimRecorded, claimRejected: req.query.claimRejected,
    // “📲 Send due message” — the answer to the office's own one-family reminder
    remindedOne: req.query.remindedOne, remindMonths: req.query.months, remindAmount: req.query.amount,
    remindAlerts: req.query.alerts, remindErr: req.query.remindErr,
    today: time.todayISO(),
  });
});

// ---- the office checks what parents say they paid (claims) ----
// A parent who pays from home files a claim on /parent/pay. Nothing has moved in the
// ledger yet — these two routes are the office's decision. “Record” runs the money model
// (oldest first, or the months the parent named), “Not received” closes it with a reason
// and tells the parent.
router.post('/fees/claims/:claimId(\\d+)/record', async (req, res, next) => {
  const claimId = parseInt(req.params.claimId, 10);
  // the same buttons sit on the Fees list and on one student's ledger — the form says
  // which page the office was standing on, so the answer comes back to that page
  const backTo = parseInt(req.body.back, 10) || 0;
  const back = (query) => res.redirect((backTo ? `/admin/fees/${backTo}` : '/admin/fees')
    + '?' + new URLSearchParams(query));
  try {
    const c = v.checker();
    const note = c.text(req.body.decision_note, 'Note', { max: 200 });
    if (!c.ok) return back({ payErr: c.first });

    const r = feeLedger.recordClaim({ claimId, decidedBy: req.session.user.username, note });
    if (!r.ok) return back({ payErr: r.error });
    const student = r.row;
    if (student.parent_user_id) {
      const after = feeLedger.studentLedger(student.student_id);
      msg.notifyClaimRecorded({
        parentUserId: student.parent_user_id, student, claim: student,
        receipts: r.receipts, balance: after ? after.balance : 0,
      });
      const parent = db.prepare('SELECT id, full_name, phone FROM users WHERE id = ?').get(student.parent_user_id);
      if (parent) {
        // the SMS/WhatsApp alert lists the months the money went into, and what is left —
        // `months`/`total` are what alerts.feePaid builds that sentence from
        await alerts.feePaid({
          recipients: [{
            parentUserId: parent.id, name: parent.full_name, phone: parent.phone,
            child: student.full_name, klass: `${student.class_name}${student.section ? ' ' + student.section : ''}`,
          }],
          months: r.receipts,
          total: r.total,
          balance: after ? after.balance : 0,
        });
      }
    }
    const done = 'claimRecorded=' + encodeURIComponent(student.full_name)
      + '&paid=' + encodeURIComponent(String(Math.round(r.total)))
      + '&term=' + encodeURIComponent(r.receipts.map(x => x.term).join(', '))
      + '&notified=1';
    res.redirect((backTo ? `/admin/fees/${backTo}` : '/admin/fees') + '?' + done);
  } catch (err) {
    next(err);
  }
});

router.post('/fees/claims/:claimId(\\d+)/reject', (req, res) => {
  const claimId = parseInt(req.params.claimId, 10);
  const backTo = parseInt(req.body.back, 10) || 0;
  const back = (query) => res.redirect((backTo ? `/admin/fees/${backTo}` : '/admin/fees')
    + '?' + new URLSearchParams(query));
  const c = v.checker();
  const note = c.text(req.body.decision_note, 'Reason', { max: 200 });
  if (!c.ok) return back({ payErr: c.first });
  const r = feeLedger.rejectClaim({ claimId, decidedBy: req.session.user.username, note });
  if (!r.ok) return back({ payErr: r.error });
  if (r.row.parent_user_id) {
    msg.notifyClaimRejected({ parentUserId: r.row.parent_user_id, student: r.row, claim: r.row, note });
  }
  const done = 'claimRejected=' + encodeURIComponent(r.row.full_name);
  res.redirect((backTo ? `/admin/fees/${backTo}` : '/admin/fees') + '?' + done);
});

// ---- money in: a lump the office took at the counter, spread over the months ----
// “He gave Rs.3,000” is how the office thinks. One entry fills the oldest unpaid months
// (or the months the parent pointed at) and leaves the rest pending.
router.post('/fees/:studentId(\\d+)/quick', async (req, res, next) => {
  const studentId = parseInt(req.params.studentId, 10);
  // the child's profile has its own “money in” form (2026-09-20) and asks to be answered
  // where it stands, so the office does not lose the child it was reading
  const backToProfile = req.body.back_to === 'profile';
  const back = (query) => {
    const params = new URLSearchParams(query);
    const cls = parseInt(req.body.filter_class, 10) || 0;
    if (cls) params.set('class', String(cls));
    res.redirect(backToProfile
      ? `/admin/students/${studentId}?${params}`
      : `/admin/fees/${studentId}?${params}`);
  };
  try {
    const c = v.checker();
    const amount = c.amount(req.body.amount, 'Amount received', { min: 1, max: 1000000, required: true });
    const mode = c.choice(req.body.mode, 'Payment mode', feeLedger.PAY_MODES, { fallback: 'Cash' });
    const paidOn = c.dateISO(req.body.paid_on, 'Payment date');
    const note = c.text(req.body.note, 'Note', { max: 200 });
    const months = String(req.body.months || '').split(',').map(s => parseInt(s, 10)).filter(Boolean);
    if (!c.ok) return back({ payErr: c.first });

    const student = feeStudent(studentId);
    if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });

    // a boarder's money can be meant for one bill of the month (school fee / hostel fee);
    // '' keeps the school's own order — school fee first, then the hostel (see services/fees.js)
    const part = c.choice(req.body.part, 'Apply to', feeLedger.PAY_PART_KEYS, { fallback: '' });
    if (!c.ok) return back({ payErr: c.first });
    const result = feeLedger.recordAuto({
      studentId, amount, paidOn: paidOn ? time.dmyFromISO(paidOn) : time.todayDMY(), mode, note, months, part,
    });
    if (!result.ok) return back({ payErr: result.error });

    if (student.parent_user_id) {
      const after = feeLedger.studentLedger(studentId);
      msg.notifyClaimRecorded({
        parentUserId: student.parent_user_id, student,
        claim: { amount, reference: '', mode }, receipts: result.receipts,
        balance: after ? after.balance : 0,
      });
      // and the same news on SMS/WhatsApp, like every other receipt the office writes
      const payer = db.prepare('SELECT id, full_name, phone FROM users WHERE id = ?').get(student.parent_user_id);
      if (payer) {
        await alerts.feePaid({
          recipients: [{
            parentUserId: payer.id, name: payer.full_name, phone: payer.phone,
            child: student.full_name, klass: `${student.class_name}${student.section ? ' ' + student.section : ''}`,
          }],
          months: result.receipts,
          total: amount,
          balance: after ? after.balance : 0,
        });
      }
    }
    const paidQuery = 'paid=' + encodeURIComponent(String(Math.round(amount)))
      + '&term=' + encodeURIComponent(result.receipts.map(x => x.term).join(', '))
      + '&notified=1';
    res.redirect(backToProfile
      ? `/admin/students/${studentId}?${paidQuery}`
      : `/admin/fees/${studentId}?${paidQuery}`);
  } catch (err) {
    next(err);
  }
});

// ---- money in: one receipt for a month (part payment or the full balance) ----
// This is the only way money enters the ledger, so a partial payment added here is
// visible everywhere at once: the month's paid/balance, the parent's portal and the
// receipt history.
router.post('/fees/:studentId(\\d+)/pay', async (req, res, next) => {
  const studentId = parseInt(req.params.studentId, 10);
  const back = (query) => {
    const params = new URLSearchParams(query);
    const cls = parseInt(req.body.filter_class, 10) || 0;
    if (cls) params.set('class', String(cls));
    res.redirect(`/admin/fees/${studentId}?${params}`);
  };
  try {
    const c = v.checker();
    const feeId = c.id(req.body.fee_id, 'Month');
    const amount = c.amount(req.body.amount, 'Amount received', { min: 1, max: 1000000, required: true });
    const mode = c.choice(req.body.mode, 'Payment mode', feeLedger.PAY_MODES, { fallback: 'Cash' });
    const paidOn = c.dateISO(req.body.paid_on, 'Payment date');
    const note = c.text(req.body.note, 'Note', { max: 200 });
    // which bill of the month this money settled: '' (school fee first) | 'school' | 'hostel'
    const part = c.choice(req.body.part, 'Apply to', feeLedger.PAY_PART_KEYS, { fallback: '' });
    if (!c.ok) return back({ payErr: c.first });

    const student = feeStudent(studentId);
    if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });

    const receiptOn = paidOn ? time.dmyFromISO(paidOn) : time.todayDMY();
    const result = feeLedger.recordPayment({ feeId, studentId, amount, paidOn: receiptOn, mode, note, part });
    if (!result.ok) return back({ payErr: result.error });

    // whose month was it, and what is left now — for the parent's notification
    const after = feeLedger.studentLedger(studentId);
    const month = after.months.find((m) => m.id === feeId);
    if (month && student.parent_user_id) {
      msg.notifyFeePayment({
        parentUserId: student.parent_user_id, student, month,
        amount, paidAmount: month.paid_amount, payable: month.payable,
        balance: month.balance, fine: month.fine,
      });
      const parent = db.prepare('SELECT id, full_name, phone FROM users WHERE id = ?').get(student.parent_user_id);
      if (parent) {
        await alerts.feePaid({
          recipients: [{
            parentUserId: parent.id, name: parent.full_name, phone: parent.phone,
            child: student.full_name, klass: `${student.class_name}${student.section ? ' ' + student.section : ''}`,
          }],
          months: [{ term: month.term }],
          total: amount, balance: month.balance,
        });
      }
    }

    back({ paid: String(Math.round(amount)), term: month ? month.term : '', notified: '1' });
  } catch (err) { next(err); }
});

// ---- late fine: the office adds (or clears) it by hand on one month ----
router.post('/fees/:studentId(\\d+)/fine', (req, res, next) => {
  const studentId = parseInt(req.params.studentId, 10);
  const back = (query) => {
    const params = new URLSearchParams(query);
    const cls = parseInt(req.body.filter_class, 10) || 0;
    if (cls) params.set('class', String(cls));
    res.redirect(`/admin/fees/${studentId}?${params}`);
  };
  try {
    const c = v.checker();
    const feeId = c.id(req.body.fee_id, 'Month');
    const fine = c.amount(req.body.fine, 'Fine', { min: 0, max: 100000, required: true });
    const note = c.text(req.body.fine_note, 'Reason', { max: 200 });
    if (!c.ok) return back({ fineErr: c.first });

    const student = feeStudent(studentId);
    if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });

    const before = feeLedger.studentLedger(studentId).months.find((m) => m.id === feeId);
    const result = feeLedger.setFine({ feeId, studentId, fine, note });
    if (!result.ok) return back({ fineErr: result.error });

    const month = feeLedger.studentLedger(studentId).months.find((m) => m.id === feeId);
    // tell the parent only when a fine was actually added (not when the office clears one)
    const added = month ? month.fine - (before ? before.fine : 0) : 0;
    if (added > 0 && month && student.parent_user_id) {
      msg.notifyFine({
        parentUserId: student.parent_user_id, student, month,
        fine: month.fine, note, balance: month.balance,
      });
    }
    back({ fined: month ? String(Math.round(month.fine)) : '0', term: month ? month.term : '' });
  } catch (err) { next(err); }
});

// staged save: the ledger page collects the month toggles client-side and sends
// only the months the office actually changed. Money is recorded as a receipt (so a
// part payment is visible everywhere), and the parent is notified for each month
// that became fully paid.
router.post('/fees/:studentId(\\d+)/save', async (req, res, next) => {
  try {
    const studentId = parseInt(req.params.studentId, 10);
    const filterClass = parseInt(req.body.filter_class, 10) || 0;
    const receiptOn = time.todayDMY();   // receipt date on the school's (IST) day, not UTC

    // the form posts m<feeId> = 'paid' | 'unpaid' for every changed month.
    // Anything else is ignored — a stray value must never be read as "unpaid".
    const changes = [];
    for (const [key, value] of Object.entries(req.body)) {
      const m = /^m(\d+)$/.exec(key);
      if (!m) continue;
      if (value !== 'paid' && value !== 'unpaid') continue;
      changes.push({ id: parseInt(m[1], 10), paid: value === 'paid' ? 1 : 0 });
    }

    const student = feeStudent(studentId);
    if (!student) return res.status(404).render('error', { message: 'Student not found.', code: 404 });

    // "Mark Paid" records a receipt for the money still missing (tuition + fine − paid
    // so far, usually the whole month); "Mark Unpaid" reverses the month by removing
    // its receipts, so the history never keeps money the office took back.
    const newlyPaid = [];
    const refunded = [];
    let changed = 0;
    db.transaction(() => {
      for (const c of changes) {
        const fee = db.prepare(`SELECT id, term, amount, fine, paid_amount, paid FROM fees
                                WHERE id = ? AND student_id = ?`).get(c.id, studentId);
        if (!fee) continue;
        if (c.paid) {
          const balance = feeLedger.money(fee.amount + fee.fine - fee.paid_amount);
          if (balance <= 0) continue;                 // already settled — nothing to record
          const receipt = feeLedger.recordPayment({
            feeId: fee.id, studentId, amount: balance, paidOn: receiptOn,
            mode: 'Cash', note: 'Marked paid in the ledger',
          });
          if (!receipt.ok) continue;
          changed++;
          if (receipt.paid) newlyPaid.push({ term: fee.term, amount: balance });
        } else {
          const removed = feeLedger.clearReceipts(fee.id);
          // a month paid before receipts existed has no rows to remove — clear the flag
          const legacy = removed === 0 && fee.paid === 1;
          if (legacy) db.prepare('UPDATE fees SET paid = 0, paid_date = NULL WHERE id = ?').run(fee.id);
          if (!removed && !legacy) continue;
          changed++;
          refunded.push({ term: fee.term, amount: fee.paid_amount });
        }
      }
    })();

    // 1) portal notification (always) — 2) SMS/WhatsApp receipt (when a gateway is set up)
    const notified = msg.notifyFeePaid({
      parentUserId: student.parent_user_id, student, months: newlyPaid,
    });
    if (newlyPaid.length && student.parent_user_id) {
      const parent = db.prepare('SELECT id, full_name, phone FROM users WHERE id = ?').get(student.parent_user_id);
      if (parent) {
        await alerts.feePaid({
          recipients: [{
            parentUserId: parent.id, name: parent.full_name, phone: parent.phone,
            child: student.full_name, klass: `${student.class_name}${student.section ? ' ' + student.section : ''}`,
          }],
          months: newlyPaid,
          total: newlyPaid.reduce((a, m) => a + (Number(m.amount) || 0), 0),
        });
      }
    }

    const query = new URLSearchParams({ saved: String(changed), notified: String(notified) });
    if (refunded.length) query.set('unpaid', String(refunded.length));
    if (filterClass) query.set('class', String(filterClass));
    res.redirect(`/admin/fees/${studentId}?${query}`);
  } catch (err) { next(err); }
});

// ================= the fee reminder's view of the store =================
//
// A reminder asks a family for everything the school is owed, so the school store's unpaid
// items join the fee dues here — and a child who owes ONLY for books (his months are settled,
// so `fees.dues()` never lists him) is added to the list instead of being forgotten. The two
// ledgers stay separate (see src/services/store.js): this only JOINS their answers, and every
// figure comes from the service that owns it.
function withStoreDues(dues, { classId = 0 } = {}) {
  const store = require('../services/store');
  const bills = new Map(store.duesFor({ classId }).map((d) => [d.student_id, store.billFor(d.student_id)]));
  const seen = new Set();
  const out = dues.map((d) => {
    seen.add(d.id);
    const bill = bills.get(d.id);
    return { ...d, itemsBill: bill || { items: [], balance: 0 }, itemsDue: bill ? bill.balance : 0 };
  });
  for (const [studentId, bill] of bills) {
    if (seen.has(studentId) || !bill.balance) continue;
    const who = db.prepare(`SELECT s.id, s.full_name, s.roll_no, s.parent_user_id, s.stay,
                                   c.name AS class_name, c.section, u.full_name AS parent_name, u.phone AS parent_phone
                            FROM students s JOIN classes c ON c.id = s.class_id
                            LEFT JOIN users u ON u.id = s.parent_user_id WHERE s.id = ?`).get(studentId);
    if (!who) continue;
    out.push({
      ...who, id: who.id, months: [], monthsCount: 0, due: 0, fine: 0,
      hostelMonths: 0, hostelDue: 0, schoolDue: 0, isBoarder: who.stay === 'hostel', hostel_bed: null,
      itemsBill: bill, itemsDue: bill.balance,
    });
  }
  return out;
}

// one click → every student whose fee is past its due date gets a portal message
// AND an SMS/WhatsApp alert. The recipient list is the fee service's own dues list,
// so the button can never reach a different set of parents than the table shows.
router.post('/fees/remind', async (req, res, next) => {
  try {
    const classId = parseInt(req.body.class, 10) || 0;
    // the office chooses the reach: only months past their due date, or everyone still
    // carrying a balance. Anything else falls back to the safe 'overdue' scope.
    const overdueOnly = req.body.who !== 'dues';
    feeLedger.syncStudent({ classId: classId || null }); // make sure nobody is missing from the ledger
    const dues = withStoreDues(feeLedger.dues({ classId, overdueOnly }), { classId });

    let notified = 0;
    for (const d of dues) {
      if (!d.parent_user_id) continue;
      notified += msg.notifyFeesDue({
        parentUserId: d.parent_user_id,
        student: d,
        months: d.months,
        total: d.due,
        fine: d.fine,
        items: d.itemsBill,
      });
    }

    const alertsSent = await alerts.feeReminders(dues.map((d) => ({
      parentUserId: d.parent_user_id, name: d.parent_name, phone: d.parent_phone,
      child: d.full_name, klass: `${d.class_name}${d.section ? ' ' + d.section : ''}`,
      unpaidMonths: d.monthsCount, totalDue: d.due,
      // a boarder's alert names the TWO bills — the school fee and the hostel fee (mess &
      // lodging) — because a family often clears one of them and not the other
      hostelMonths: d.hostelMonths, hostelDue: d.hostelDue, schoolDue: d.schoolDue,
      // …and the books/uniform a family still owes for
      itemsDue: d.itemsDue || 0,
    })));

    const query = new URLSearchParams({
      reminded: String(alertsSent),
      notified: String(notified),
      students: String(dues.length),
      who: overdueOnly ? 'overdue' : 'dues',
    });
    if (classId) query.set('class', String(classId));
    res.redirect(`/admin/fees?${query}`);
  } catch (err) { next(err); }
});

// ---- remind ONE family, from that child's own ledger (school's request, 2026-09-15) ----
// Standing on a child's ledger with three months pending used to mean going back to the list and
// hoping the bulk panel included him. This sends the same reminder — portal message + one
// SMS/WhatsApp alert — for that ONE student, and the money it names comes from the same service
// the button is rendered from (`feeLedger.dues`), so the sentence and the screen cannot disagree.
router.post('/fees/:studentId(\\d+)/remind', async (req, res, next) => {
  const studentId = parseInt(req.params.studentId, 10);
  // Where the office tapped decides where the answer appears. The child's own ledger is the usual
  // case; the send icon beside a name on `/admin/fees` carries `back=list`, so chasing one family
  // does not throw the office out of the list it is working through (and the class filter with it).
  const back = (query) => {
    // …and Admin → Hostel carries `back=hostel`, so chasing a boarder from the roster answers on
    // the roster (at the boarders panel), instead of throwing the office out to the fee list.
    if (req.body && req.body.back === 'hostel') {
      return res.redirect(`/admin/hostel?${new URLSearchParams(query)}#boarders`);
    }
    if (req.body && req.body.back === 'list') {
      const cls = String(req.body.class || '').trim();
      if (cls) query.class = cls;
      return res.redirect(`/admin/fees?${new URLSearchParams(query)}`);
    }
    return res.redirect(`/admin/fees/${studentId}?${new URLSearchParams(query)}`);
  };
  try {
    feeLedger.syncStudent({ studentId });
    // every month still carrying a balance — not just the late ones: the office is looking at
    // the whole ledger and is asking about what is left, late or not
    const d = feeLedger.dues({ overdueOnly: false }).find((x) => x.id === studentId);
    if (!d) {
      // his months may all be settled and only a book set unpaid — that is still a due message
      const itemsOnly = require('../services/store').billFor(studentId);
      if (!itemsOnly.balance) return back({ remindErr: 'Nothing is pending for this student — there is no due message to send.' });
      const who = db.prepare(`SELECT s.full_name, s.parent_user_id, s.parent_name, s.parent_phone,
                                     s.roll_no, s.stay, c.name AS class_name, c.section
                              FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(studentId);
      if (!who || !who.parent_user_id) return back({ remindErr: 'No parent login is linked to this student, so no message can reach them.' });
      const dueItem = { ...who, id: studentId, months: [], due: 0, fine: 0 };
      const sentItems = msg.notifyFeesDue({
        parentUserId: who.parent_user_id, student: dueItem, months: [], total: 0, fine: 0, items: itemsOnly,
      });
      const alertsItems = await alerts.feeReminders([{
        parentUserId: who.parent_user_id, name: who.parent_name, phone: who.parent_phone,
        child: who.full_name, klass: `${who.class_name}${who.section ? ' ' + who.section : ''}`,
        unpaidMonths: 0, totalDue: 0, itemsDue: itemsOnly.balance,
      }]);
      return back({
        remindedOne: who.full_name, months: '0', amount: String(Math.round(itemsOnly.balance)),
        notified: String(sentItems), alerts: String(alertsItems),
      });
    }
    if (!d.parent_user_id) return back({ remindErr: 'No parent login is linked to this student, so no message can reach them.' });

    // …and the books/uniform this child still owes for, so ONE message asks for everything
    const itemsBill = require('../services/store').billFor(studentId);
    const notified = msg.notifyFeesDue({
      parentUserId: d.parent_user_id,
      student: d,
      months: d.months,
      total: d.due,
      fine: d.fine,
      items: itemsBill,
    });
    const sent = await alerts.feeReminders([{
      parentUserId: d.parent_user_id, name: d.parent_name, phone: d.parent_phone,
      child: d.full_name, klass: `${d.class_name}${d.section ? ' ' + d.section : ''}`,
      unpaidMonths: d.monthsCount, totalDue: d.due,
      hostelMonths: d.hostelMonths, hostelDue: d.hostelDue, schoolDue: d.schoolDue,
      itemsDue: itemsBill.balance,
    }]);

    back({
      remindedOne: d.full_name, months: String(d.monthsCount),
      amount: String(Math.round(d.due)), notified: String(notified), alerts: String(sent),
    });
  } catch (err) { next(err); }
});

// ================= HOLIDAYS (2026-09-17) ================================================
//
// “Suppose today is Vishwakarma Puja — the school should be able to update it, and the
// timetable should show a holiday and ‘Happy Vishwakarma Puja’.”
//
// One row per DATE (services/holidays.js). While a date is marked, the parents' and the
// teachers' Timetable page shows the holiday card instead of the periods, the day strip
// marks it, and the parents' home page carries a warm line. Sunday needs no row.
const holBack = (q = {}) => '/admin/holidays?' + new URLSearchParams(q).toString();

router.get('/holidays', (req, res) => {
  const today = time.todayISO();
  const editId = parseInt(req.query.holiday, 10) || 0;
  const editing = editId ? db.prepare('SELECT * FROM holidays WHERE id = ?').get(editId) : null;
  const state = holidaySvc.today();
  // every holiday row, with the labels the screen prints (the view never formats a date)
  const decorate = (h) => ({
    ...h,
    dateLong: holidaySvc.dayLong(h.date),
    dateShort: holidaySvc.dayShort(h.date),
    isToday: h.date === today,
    isPast: h.date < today,
    when: holidaySvc.whenLabel(h.date),
    opensOn: (() => { const n = holidaySvc.nextOpenDay({ from: h.date }); return n ? n.long : ''; })(),
  });
  res.render('admin/holidays', {
    title: 'Holidays',
    todayISO: today,
    state,
    upcoming: holidaySvc.upcoming().map(decorate),
    past: holidaySvc.past({ limit: 12 }).map(decorate),
    editor: editing ? { holiday: {
      id: editing.id, date: editing.holiday_date, name: editing.name,
      greeting: editing.greeting || '', note: editing.note || '',
    }, isNew: false } : (req.query.add === '1' ? { holiday: null, isNew: true } : null),
    nextOpen: holidaySvc.nextOpenDay(),
    saved: req.query.saved, deleted: req.query.deleted, told: req.query.told,
    alerts: req.query.alerts, nosend: req.query.nosend,
    err: req.query.err || null,
  });
});

// add or correct ONE holiday
router.post('/holidays', (req, res) => {
  const c = v.checker();
  const id = c.id(req.body.id, 'Holiday', { required: false }) || 0;
  const date = c.dateISO(req.body.date, 'Holiday date', { required: true });
  const name = c.text(req.body.name, 'Holiday name', { max: holidaySvc.NAME_MAX, required: true });
  const greeting = c.text(req.body.greeting, 'Wish for the parents', { max: holidaySvc.GREETING_MAX });
  const note = c.text(req.body.note, 'Note', { max: holidaySvc.NOTE_MAX });
  if (!c.ok) return res.redirect(holBack({ err: c.summary }));
  const r = holidaySvc.save({ id, date, name, greeting, note });
  if (!r.ok) return res.redirect(holBack({ err: r.error }));
  res.redirect(holBack({ saved: r.updated ? 'updated' : 'new' }));
});

router.post('/holidays/delete', (req, res) => {
  const c = v.checker();
  const id = c.id(req.body.id, 'Holiday', { required: true });
  if (!c.ok) return res.redirect(holBack({ err: c.summary }));
  const gone = holidaySvc.remove(id);
  res.redirect(holBack({ deleted: gone ? 1 : 0 }));
});

// 📲 tell every parent (portal message + the SMS/WhatsApp alert) — one tap, like the
// exam date-sheet's “Tell parents”. The message names the day the school opens again.
router.post('/holidays/tell', async (req, res, next) => {
  try {
    const c = v.checker();
    const id = c.id(req.body.id, 'Holiday', { required: true });
    if (!c.ok) return res.redirect(holBack({ err: c.summary }));
    const row = db.prepare('SELECT * FROM holidays WHERE id = ?').get(id);
    if (!row) return res.redirect(holBack({ err: 'That holiday was already removed.' }));
    const message = holidaySvc.tellMessage(row);
    const targets = msg.getAllParentIds();
    if (!targets.length) return res.redirect(holBack({ nosend: 1 }));
    const sent = await msg.sendToParents({
      targets, adminName: req.session.user.full_name,
      category: message.category, subject: message.subject, body: message.body,
    });
    const alerted = await alerts.holidayDeclared({
      name: message.name, dateLong: message.dateLong, opensOn: message.opensOn,
    });
    res.redirect(holBack({ told: sent, alerts: alerted }));
  } catch (err) { next(err); }
});

// ================= WORDS (2026-09-17) ====================================================
//
// “Give the office the option to update every single thing, down to a single word, and make it
// easy from a phone.”
//
// One saved change = one rule in `services/words.js`, applied to the finished HTML of every
// page. There are no per-screen rules on purpose: the school asked to change A word, and that
// word should change wherever it is printed. The page shows which screens that is (the phrase
// catalogue, harvested from the views by `.freebuff/harvest-words.js`), so nothing is a
// surprise. The editor is NEVER rewritten by its own rules — that is what makes it undoable.
const wordsBack = (q = {}) => '/admin/wording?' + new URLSearchParams(q).toString();

router.get('/wording', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const all = words.catalogue();
  // only what matches — a phone cannot scroll 2000 phrases, and the office can always search
  const matches = (q ? all.filter((p) => p.t.toLowerCase().includes(q)) : all).slice(0, 200);
  res.render('admin/words', {
    title: 'Words',
    rules: words.list(),
    catalogue: matches,
    catalogueTotal: all.length,
    matched: q ? all.filter((p) => p.t.toLowerCase().includes(q)).length : all.length,
    q: req.query.q || '',
    editing: req.query.edit ? words.get(req.query.edit) : null,
    from: req.query.from || '',
    saved: req.query.saved, removed: req.query.removed, cleared: req.query.cleared,
    same: req.query.same,
    err: req.query.err || null,
  });
});

// save ONE change (the same phrase again corrects it; the app's own words = remove the rule)
router.post('/wording', (req, res) => {
  const r = words.save({ from: req.body.from, to: req.body.to, id: req.body.id });
  if (!r.ok) return res.redirect(wordsBack({ err: r.error, from: req.body.from || '' }));
  if (r.unchanged) return res.redirect(wordsBack({ same: 1 }));
  res.redirect(wordsBack(r.removed ? { removed: 1 } : { saved: 1 }));
});

router.post('/wording/delete', (req, res) => {
  const gone = words.remove(req.body.id);
  res.redirect(wordsBack(gone ? { removed: 1 } : { err: 'That change was already gone.' }));
});

// “give me the app's own words back” — every change, in one tap
router.post('/wording/clear', (req, res) => {
  const n = words.clear();
  res.redirect(wordsBack({ cleared: n }));
});

module.exports = router;