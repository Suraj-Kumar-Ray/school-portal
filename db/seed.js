/**
 * Seed script - generates a full demo dataset:
 *   - 1 admin, 52 students; every child's login belongs to its parent (students never sign in)
 *   - Classes LKG, KG, UKG, Class 1-10 (4 students each)
 *   - Full per-class fee sheet (day + hostel): admission fee/form, annual,
 *     miscellaneous, monthly tuition, registration (Class 9-10), book price
 *   - Bus / conveyance routes, subjects, exams, marks, fees, notices, timetables
 *
 * Run: npm run seed
 * Demo logins are printed at the end.
 */
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const time = require('../src/services/time');   // the school's own (IST) calendar day

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'school.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new Database(DB_PATH);
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
db.pragma('journal_mode = WAL');

// ---- deterministic pseudo-random generator (seeded) ----
let seedState = 2026;
function rand() {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}
function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

const YEAR = 2026;
const MONTHS = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];
const NEXT_YEAR = YEAR + 1;

// ---- helpers ----
const insert = db.prepare.bind(db);
const addUser = db.prepare('INSERT INTO users (username, password_hash, role, full_name, email, phone) VALUES (?,?,?,?,?,?)');

// ============ ADMIN ============
addUser.run('admin', bcrypt.hashSync('admin123', 10), 'admin', 'School Administrator', 'admin@school.edu', '9876543210');

// ============ CLASSES (school order LKG → Class 10) ============
// Fees from the school's printed sheet 2026-27 (day scholar / hostel student).
// Shared values: admission fee 3000/3500, form 500/500, annual 2500/3000,
// miscellaneous 2500/3000 (one-time/yearly). Monthly tuition & 9-10 reg differ.
const CLASS_NAMES = ['LKG', 'KG', 'UKG', 'Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10'];
const TUITION_DAY = [1300, 1300, 1400, 1600, 1600, 1700, 1700, 1800, 1800, 1900, 1900, 2000, 2000];
const TUITION_HOSTEL = [7250, 7250, 7500, 7500, 7500, 7500, 7500, 7500, 7500, 7500, 7500, 7500, 7500];
const BOOK_PRICES = [1650, 1850, 2100, 4341, 4578, 4781, 5292, 5597, 5981, 6016, 6141, 0, 0]; // no books for 9-10 (school list ends at Class 8)

const SUBJECTS = {
  LKG: ['English', 'Hindi', 'Maths', 'Rhymes', 'Art & Craft', 'EVS'],
  KG: ['English', 'Hindi', 'Maths', 'Rhymes', 'Art & Craft', 'EVS'],
  UKG: ['English', 'Hindi', 'Maths', 'Rhymes', 'Art & Craft', 'EVS'],
  1: ['English', 'Hindi', 'Maths', 'EVS', 'Art & Craft', 'Rhymes'],
  2: ['English', 'Hindi', 'Maths', 'EVS', 'Art & Craft', 'Rhymes'],
  3: ['English', 'Hindi', 'Maths', 'Science', 'Social Studies', 'Computer', 'Art'],
  4: ['English', 'Hindi', 'Maths', 'Science', 'Social Studies', 'Computer', 'Art'],
  5: ['English', 'Hindi', 'Maths', 'Science', 'Social Studies', 'Computer', 'Art'],
  6: ['English', 'Hindi', 'Maths', 'Science', 'Social Studies', 'Computer', 'Sanskrit', 'Physical Education'],
  7: ['English', 'Hindi', 'Maths', 'Science', 'Social Studies', 'Computer', 'Sanskrit', 'Physical Education'],
  8: ['English', 'Hindi', 'Maths', 'Science', 'Social Studies', 'Computer', 'Sanskrit', 'Physical Education'],
  9: ['English', 'Hindi', 'Maths', 'Science', 'Social Studies', 'Computer', 'Sanskrit', 'Physical Education'],
  10: ['English', 'Hindi', 'Maths', 'Science', 'Social Studies', 'Computer', 'Sanskrit', 'Physical Education'],
};
// class teacher names (LKG/KG/UKG + one per class) — for the classes.class_teacher text
const TEACHER_NAMES = {
  LKG: 'Mrs. Rekha Devi', KG: 'Mrs. Suman Kumari', UKG: 'Mrs. Neha Gupta',
  1: 'Mrs. Anita Verma', 2: 'Mr. Rajesh Kumar', 3: 'Ms. Sunita Rao', 4: 'Mr. Vikram Singh',
  5: 'Mrs. Priya Sharma', 6: 'Mr. Amit Joshi', 7: 'Ms. Divya Nair', 8: 'Mr. Karan Mehta',
  9: 'Mrs. Ritu Bansal', 10: 'Mr. Suresh Iyer',
};

const classIds = {}; // key = class name (LKG…Class 10)
for (let i = 0; i < CLASS_NAMES.length; i++) {
  const name = CLASS_NAMES[i];
  const num = Number(name.split(' ')[1]) || name;
  const reg = num === 9 || num === 10 ? 12000 : 0;
  const info = db.prepare(`INSERT INTO classes
    (name, section, class_teacher, adm_day, adm_hostel, form_day, form_hostel,
     annual_day, annual_hostel, misc_day, misc_hostel, tuition_day, tuition_hostel,
     reg_day, reg_hostel, book_price)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name, '', TEACHER_NAMES[name],
      3000, 3500, 500, 500, 2500, 3000, 2500, 3000,
      TUITION_DAY[i], TUITION_HOSTEL[i], reg, reg, BOOK_PRICES[i]);
  classIds[name] = info.lastInsertRowid;
  for (const subj of SUBJECTS[num]) {
    db.prepare('INSERT INTO subjects (class_id, name) VALUES (?,?)').run(classIds[name], subj);
  }
}

// ============ TEACHERS (one class teacher per class; each one CAN sign in) ============
// Every teacher gets a login (username teacher1…teacher13, password teacher123) and the
// class-level sections granted by default, so the office can see the teacher portal
// straight away. "Fees" is deliberately NOT granted — money is the office's job.
// Every teacher uses an initials avatar — this build bundles no portrait images.
const teachers = ['Mrs. Rekha Devi', 'Mrs. Suman Kumari', 'Mrs. Neha Gupta',
  'Mrs. Anita Verma', 'Mr. Rajesh Kumar', 'Ms. Sunita Rao', 'Mr. Vikram Singh', 'Mrs. Priya Sharma', 'Mr. Amit Joshi',
  'Ms. Divya Nair', 'Mr. Karan Mehta', 'Mrs. Ritu Bansal', 'Mr. Suresh Iyer'];
const teacherProfile = [
  { qualification: 'N.T.T. (Nursery Teacher Training)', experience_years: 8, rating: 4.8, bio: 'Nursery class teacher — learning through play, the first foundation of a child\'s schooling.' },
  { qualification: 'N.T.T., D.El.Ed.', experience_years: 6, rating: 4.7, bio: 'KG teacher — rhymes, counting, and learning to read and write.' },
  { qualification: 'D.El.Ed.', experience_years: 9, rating: 4.6, bio: 'UKG teacher — gets the children ready for school.' },
  { qualification: 'M.A. Hindi, B.Ed.', experience_years: 15, rating: 4.9, bio: 'Hindi & language teacher — makes reading and writing feel easy to every child.' },
  { qualification: 'M.Sc. Mathematics, B.Ed.', experience_years: 12, rating: 4.7, bio: 'Maths teacher — teaches tables and sums with games and fun.' },
  { qualification: 'M.A. English, B.Ed.', experience_years: 10, rating: 4.8, bio: 'English teacher — gives equal attention to spoken English and grammar.' },
  { qualification: 'M.Sc. Physics, B.Ed.', experience_years: 16, rating: 4.6, bio: 'Science teacher — teaches through experiments and practicals.' },
  { qualification: 'M.A. Social Studies, B.Ed.', experience_years: 9, rating: 4.5, bio: 'Social Studies teacher — history and geography told like a story.' },
  { qualification: 'B.Sc. Computer, PGDCA', experience_years: 8, rating: 4.8, bio: 'Computer teacher — computer basics and typing for every child.' },
  { qualification: 'M.A. Sanskrit, B.Ed.', experience_years: 7, rating: 4.7, bio: 'Sanskrit & values teacher — good conduct along with the lessons.' },
  { qualification: 'M.P.Ed., NIS Coach', experience_years: 11, rating: 4.6, bio: 'Physical Education teacher — sports, yoga and good health.' },
  { qualification: 'M.Com., B.Ed.', experience_years: 14, rating: 4.9, bio: 'Commerce & maths teacher — teaches hard work and discipline.' },
  { qualification: 'M.Sc. Chemistry, B.Ed.', experience_years: 6, rating: 4.5, bio: 'Science teacher — loves chemistry experiments.' },
];
// No bundled portraits in this build: every teacher gets an initials avatar.
// This sanitised build ships no portrait files, so every teacher gets a clean initials
// avatar (photo = null) — no real faces anywhere in the repository.
const photoFor = () => null;
const IS_FEMALE = /^Mrs\.|^Ms\./;
CLASS_NAMES.forEach((name, i) => {
  const tUser = addUser.run(`teacher${i + 1}`, bcrypt.hashSync('teacher123', 10), 'teacher', teachers[i],
    `teacher${i + 1}@school.edu`, `98${randInt(10000000, 99999999)}`);
  const profile = teacherProfile[i];
  const photo = photoFor(IS_FEMALE.test(teachers[i]));
  const tInfo = db.prepare(`INSERT INTO teachers
    (user_id, class_id, phone, photo, qualification, experience_years, rating, bio, can_login, portal_password)
    VALUES (?,?,?,?,?,?,?,?,1,?)`)
    .run(tUser.lastInsertRowid, classIds[name], `98${randInt(10000000, 99999999)}`,
      photo, profile.qualification, profile.experience_years, profile.rating, profile.bio, 'teacher123');
  const grantPerm = db.prepare(`INSERT INTO teacher_permissions (teacher_id, perm, granted_by) VALUES (?,?,?)`);
  for (const p of ['students', 'marks', 'toppers', 'timetable', 'notices', 'messages']) {
    grantPerm.run(tInfo.lastInsertRowid, p, 'School office (default)');
  }
});

// ============ EXAMS ============
const examIds = {};
for (const term of ['Term 1', 'Term 2', 'Term 3']) {
  const info = db.prepare('INSERT INTO exams (term, year) VALUES (?,?)').run(term, YEAR);
  examIds[term] = info.lastInsertRowid;
}

// ============ STUDENTS, USERS, PARENTS ============
const firstName = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Kabir',
  'Aadhya', 'Diya', 'Ananya', 'Ira', 'Saanvi', 'Myra', 'Aarohi', 'Navya', 'Pari', 'Anika'];
const lastName = ['Sharma', 'Verma', 'Gupta', 'Kumar', 'Singh', 'Patel', 'Reddy', 'Iyer', 'Nair', 'Mehta',
  'Joshi', 'Chopra', 'Malhotra', 'Kapoor', 'Bansal', 'Agarwal', 'Khan', 'Das', 'Roy', 'Bose'];
const fatherFirst = ['Ramesh', 'Suresh', 'Dinesh', 'Mahesh', 'Rajesh', 'Anil', 'Sanjay', 'Vijay', 'Prakash', 'Mohan',
  'Ashok', 'Ravi', 'Kiran', 'Arun', 'Naveen', 'Deepak', 'Manoj', 'Harish', 'Ganesh', 'Sandeep'];

let studentCounter = 0;
for (const name of CLASS_NAMES) {
  const classId = classIds[name];
  const studentsInClass = 4;
  for (let r = 1; r <= studentsInClass; r++) {
    studentCounter++;
    const n = studentCounter;
    const fname = pick(firstName);
    const lname = pick(lastName);
    const fullName = `${fname} ${lname}`;
    const fatherName = `${pick(fatherFirst)} ${lname}`;
    const phone = `98${randInt(10000000, 99999999)}`;

    // one login per child and the PARENT owns it — students never sign in
    const parUser = addUser.run(`parent${n}`, bcrypt.hashSync('parent123', 10), 'parent', `${fatherName} (Parent of ${fullName})`,
      `${fatherName.toLowerCase().replace(/\s+/g, '.')}@parent.school.edu`, phone);

    const stu = db.prepare(`INSERT INTO students
      (user_id, admission_no, full_name, class_id, roll_no, parent_user_id, dob, parent_name, parent_phone, portal_password)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(parUser.lastInsertRowid, `ADM${YEAR}${String(n).padStart(3, '0')}`, fullName, classId, r,
        parUser.lastInsertRowid, `${randInt(1, 28).toString().padStart(2, '0')}/${randInt(1, 12).toString().padStart(2, '0')}/${YEAR - randInt(5, 16)}`,
        fatherName, phone, 'parent123');

    // ---- marks for all 3 terms ----
    const subjRows = db.prepare('SELECT id FROM subjects WHERE class_id = ?').all(classId);
    for (const exam of ['Term 1', 'Term 2', 'Term 3']) {
      for (const subj of subjRows) {
        const ability = rand();
        const marks = Math.min(100, Math.max(35, Math.round(100 * ability + randInt(-8, 8))));
        db.prepare('INSERT INTO marks (student_id, subject_id, exam_id, marks_obtained, max_marks) VALUES (?,?,?,?,100)')
          .run(stu.lastInsertRowid, subj.id, examIds[exam], marks);
      }
    }

    // ---- fees: monthly installments matching this class's monthly tuition ----
    const monthlyAmt = TUITION_DAY[CLASS_NAMES.indexOf(name)];
    MONTHS.forEach((month, idx) => {
      const year = idx >= 9 ? NEXT_YEAR : YEAR;
      const paid = rand() < 0.78 ? 1 : 0;
      db.prepare('INSERT INTO fees (student_id, term, amount, paid, due_date, paid_date) VALUES (?,?,?,?,?,?)')
        .run(stu.lastInsertRowid, `${month.slice(0, 3)} ${year}`, monthlyAmt, paid, `10/${String(idx + 1).padStart(2, '0')}/${year}`,
          paid ? `${String(randInt(1, 9)).padStart(2, '0')}/${String(idx + 1).padStart(2, '0')}/${year}` : null);
    });
  }
}

// ============ TOPPER PORTRAITS (demo) ============
const topperStudents = db.prepare(`
  SELECT s.id, ROUND(AVG(m.marks_obtained * 100.0 / m.max_marks)) pct
  FROM marks m
  JOIN students s ON s.id = m.student_id
  JOIN classes c ON c.id = s.class_id
  WHERE c.name = 'Class 10'
  GROUP BY s.id ORDER BY pct DESC LIMIT 3`).all();
// No bundled photos in this demo: every student keeps an initials avatar.

// ============ BUS / CONVEYANCE ROUTES (from the printed sheet) ============
const busRoutes = [
  ['Mahadattpur', 1300], ['Singhia Makanpur', 1300], ['Bus Stand Demo Town', 1300],
  ['Bari Makanpur', 1700], ['Panchgachia', 1800], ['Latra + Navtolia', 1900],
  ['Gopalpur Muslimtola', 2000], ['Gopalpur', 1900], ['Saidpur', 2000],
  ['Tintanga Karari', 2100], ['Tulsipur', 1600], ['Murli', 1500],
  ['Madrauni', 1900], ['Dhruvganj', 1600], ['Laualagan', 2000],
  ['Bhatgama', 1800], ['Khairpur', 1600], ['Pakra', 1300],
];
busRoutes.forEach((r, i) => {
  db.prepare('INSERT INTO bus_routes (route_name, fare, sort_order) VALUES (?,?,?)').run(r[0], r[1], i);
});

// ============ NOTICES ============
const notices = [
  { title: 'School reopens after holidays', body: 'School will reopen on Monday. All students must report at 8:00 AM in proper uniform.', target: null },
  { title: 'Annual Sports Day', body: 'Annual Sports Day will be held on December 12. Parents are cordially invited. Events start at 9:00 AM.', target: null },
  { title: 'PTM - Parent Teacher Meeting', body: 'Parent Teacher Meeting for all classes on Saturday, 10:00 AM to 1:00 PM. Please collect your child\u2019s progress report.', target: null },
  { title: 'Science Exhibition (Classes 6-10)', body: 'Science exhibition on October 5. Students of classes 6 to 10 must submit their projects by October 1.', target: 'Class 6' },
  { title: 'Field Trip - Classes 1-2', body: 'A field trip to the city museum has been arranged for classes 1 and 2 on November 20. Consent forms must be submitted by November 10.', target: 'Class 1' },
  { title: 'Exam schedule released', body: 'Term 3 exam schedule has been published. Check the exam timetable on the notice board and the portal.', target: null },
];
for (const n of notices) {
  const target = n.target === null ? null : classIds[n.target];
  db.prepare('INSERT INTO notices (title, body, target_class_id, posted_by) VALUES (?,?,?,?)')
    .run(n.title, n.body, target, 'School Administration');
}

// ============ TIMETABLE ============
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
for (const name of CLASS_NAMES) {
  const num = Number(name.split(' ')[1]) || name;
  const subs = SUBJECTS[num];
  const periods = 8;
  for (let d = 0; d < days.length; d++) {
    for (let p = 1; p <= periods; p++) {
      const subject = subs[(p + d) % subs.length];
      db.prepare('INSERT INTO timetable (class_id, day, period, subject, teacher) VALUES (?,?,?,?,?)')
        .run(classIds[name], days[d], p, subject, pick(teachers));
    }
  }
}

// ============ MULTI-CHILD DEMO PARENT ============
// 'parentmulti' has TWO children in different classes (Class 5 and Class 9)
const multiParent = addUser.run('parentmulti', bcrypt.hashSync('parent123', 10), 'parent', 'Dinesh Kumar (Demo - 2 children)', null, '9876500099');
const extraStudents = [
  { name: 'Aarav Kumar', className: 'Class 5', dob: '2013-08-19' },
  { name: 'Priya Kumar', className: 'Class 9', dob: '2009-11-30' },
];
extraStudents.forEach((es, i) => {
  const clsId = classIds[es.className];
  const roll = db.prepare('SELECT COALESCE(MAX(roll_no),0)+1 r FROM students WHERE class_id = ?').get(clsId).r;
  // both children hang off the same parent login — the portal has a child picker
  const stu = db.prepare('INSERT INTO students (user_id, admission_no, full_name, class_id, roll_no, parent_user_id, dob, parent_name, parent_phone, portal_password) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(multiParent.lastInsertRowid, `ADM${YEAR}M${i + 1}`, es.name, clsId, roll, multiParent.lastInsertRowid, es.dob, 'Dinesh Kumar', '9876500099', 'parent123');
  const subjRows = db.prepare('SELECT id FROM subjects WHERE class_id = ?').all(clsId);
  for (const exam of ['Term 1', 'Term 2', 'Term 3']) {
    for (const subj of subjRows) {
      const marks = Math.min(100, Math.max(35, Math.round(rand() * 90 + 8)));
      db.prepare('INSERT INTO marks (student_id, subject_id, exam_id, marks_obtained, max_marks) VALUES (?,?,?,?,100)')
        .run(stu.lastInsertRowid, subj.id, examIds[exam], marks);
    }
  }
  const monthlyAmt = TUITION_DAY[CLASS_NAMES.indexOf(es.className)];
  MONTHS.forEach((month, idx) => {
    const year = idx >= 9 ? NEXT_YEAR : YEAR;
    const paid = rand() < 0.78 ? 1 : 0;
    db.prepare('INSERT INTO fees (student_id, term, amount, paid, due_date, paid_date) VALUES (?,?,?,?,?,?)')
      .run(stu.lastInsertRowid, `${month.slice(0, 3)} ${year}`, monthlyAmt, paid, `10/${String(idx + 1).padStart(2, '0')}/${year}`,
        paid ? `${String(randInt(1, 9)).padStart(2, '0')}/${String(idx + 1).padStart(2, '0')}/${year}` : null);
  });
});

// ============ DEMO MESSAGES (parent <-> school) ============
const parent1Id = db.prepare("SELECT id FROM users WHERE username = 'parent1'").get().id;
const multiId = multiParent.lastInsertRowid;
const priyaStu = db.prepare("SELECT id FROM students WHERE full_name = 'Priya Kumar' AND parent_user_id = ?").get(multiId).id;
const mIns = db.prepare("INSERT INTO messages (thread_id, parent_user_id, student_id, direction, category, subject, body, status, created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now', ?))");
const t1 = mIns.run(null, parent1Id, 1, 'to_school', 'Fee', 'Fee receipt not received',
  'Sir, I paid the fee in cash but I have not received the receipt. Please check and confirm.', 'read', '-1 day').lastInsertRowid;
mIns.run(t1, parent1Id, 1, 'to_parent', 'Fee', 'Re: Fee receipt not received',
  'Dear parent, your payment is recorded as paid. You can see it under Fees in your portal. — School Office', 'unread', '-20 hours');
mIns.run(null, parent1Id, 1, 'to_school', 'PTM', 'PTM date for my child',
  'When is the parent teacher meeting? Will it also be possible to talk online?', 'unread', '-5 hours');
mIns.run(null, parent1Id, null, 'to_parent', 'PTM', 'Parent-Teacher Meeting this Saturday',
  'PTM for all classes is on Saturday, 10:00 AM to 1:00 PM. Please come and collect your child\'s progress report. — School Office', 'unread', '-3 hours');
mIns.run(null, multiId, priyaStu, 'to_school', 'General', 'My daughter Priya needs a fee receipt copy',
  'We paid the April fees at the office on Monday but the portal still shows it as unpaid. Please check once. — Priya\'s parent', 'unread', '-2 hours');

// ============ SAMPLE SMS/WHATSAPP ALERTS (demo log) ============
const aIns = db.prepare(`INSERT INTO alert_log
  (parent_user_id, parent_name, child_name, child_class, phone, channel, event, message, status, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,datetime('now', ?))`);
const p1u = db.prepare('SELECT full_name, phone FROM users WHERE id = ?').get(parent1Id);
const mpu = db.prepare('SELECT full_name, phone FROM users WHERE id = ?').get(multiId);
const p1Child = db.prepare("SELECT s.full_name, TRIM(c.name || ' ' || c.section) klass FROM students s JOIN classes c ON c.id = s.class_id WHERE s.parent_user_id = ? ORDER BY s.id LIMIT 1").get(parent1Id);
const multiChild = db.prepare("SELECT s.full_name, TRIM(c.name || ' ' || c.section) klass FROM students s JOIN classes c ON c.id = s.class_id WHERE s.full_name = 'Priya Kumar'").get();
aIns.run(parent1Id, p1u.full_name, p1Child.full_name, p1Child.klass, p1u.phone, 'sms', 'result_published',
  `📢 Result published: Term 2 2026 for ${p1Child.klass}. ${p1Child.full_name}'s result is ready. Log in to the Parent Portal for full marks and the report card. — GREEN VALLEY PUBLIC SCHOOL, +91 98765 43210`, 'demo', '-6 hours');
aIns.run(parent1Id, p1u.full_name, p1Child.full_name, p1Child.klass, p1u.phone, 'sms', 'fee_due',
  `💳 Fee reminder: ${p1Child.full_name} (${p1Child.klass}) — 1 month(s) unpaid. Please pay at the school office by the 10th. — GREEN VALLEY PUBLIC SCHOOL, +91 98765 43210`, 'demo', '-1 day');
aIns.run(multiId, mpu.full_name, multiChild.full_name, multiChild.klass, mpu.phone, 'whatsapp', 'notice',
  `📢 New notice for ${multiChild.klass}: Science Exhibition (Classes 6-10). Science exhibition on October 5. Students of classes 6 to 10 must submit their projects by October 1. — GREEN VALLEY PUBLIC SCHOOL, +91 98765 43210`, 'demo', '-3 hours');

// ============ ADMISSION APPLICATIONS ============
function addAdmission({ appNo, username, child, dob, className, parent, phone, status, reviewedBy }) {
  let parentUserId = db.prepare('SELECT id FROM users WHERE username = ?').get(username)?.id;
  if (!parentUserId) {
    parentUserId = addUser.run(username, bcrypt.hashSync('parent123', 10), 'parent', parent, null, phone).lastInsertRowid;
  }
  const appInfo = db.prepare(`INSERT INTO admissions
    (application_no, parent_user_id, child_name, child_dob, class_id, parent_name, parent_phone, parent_email, address, previous_school, status, submitted_at, reviewed_by, reviewed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now','-2 days'),?,datetime('now','-1 day'))`)
    .run(appNo, parentUserId, child, dob, classIds[className], parent, phone, `${username}@gmail.com`, 'Village Road, District', 'Govt. Primary School', status, reviewedBy);
  return appInfo;
}
addAdmission({ appNo: 'APP-2026-0001', username: 'applicant1', child: 'Rohan Meena', dob: '2011-04-12', className: 'Class 9', parent: 'Suresh Meena', phone: '9876500001', status: 'Pending' });
addAdmission({ appNo: 'APP-2026-0002', username: 'applicant2', child: 'Kavita Yadav', dob: '2009-09-23', className: 'Class 10', parent: 'Ram Yadav', phone: '9876500002', status: 'Pending' });
const appInfo3 = addAdmission({ appNo: 'APP-2026-0003', username: 'parent1', child: 'Vivaan Agarwal', dob: '2016-02-14', className: 'Class 1', parent: 'Prakash Agarwal', phone: '9812345678', status: 'Approved', reviewedBy: 'School Administration' });
db.prepare('UPDATE students SET parent_user_id = (SELECT parent_user_id FROM admissions WHERE id = ?) WHERE id = 1').run(appInfo3.lastInsertRowid);

// ============ NOTIFICATIONS (school inbox) ============
const notif = db.prepare('INSERT INTO notifications (kind, title, body, created_at) VALUES (?,?,?,datetime(\'now\', ?))');
notif.run('email', 'New admission application APP-2026-0001', 'A new admission application has been submitted.\n\nApplication No: APP-2026-0001\nChild: Rohan Meena (2011-04-12)\nClass applied: Class 9 A\nParent: Suresh Meena\nPhone: 9876500001', '-2 days');
notif.run('email', 'New admission application APP-2026-0002', 'A new admission application has been submitted.\n\nApplication No: APP-2026-0002\nChild: Kavita Yadav (2009-09-23)\nClass applied: Class 10 A\nParent: Ram Yadav\nPhone: 9876500002', '-1 day');
notif.run('system', 'Welcome! Configure SMTP for real emails', 'Emails are logged here and to data/mail_log.txt. Set SMTP_HOST, SMTP_USER, SMTP_PASS env vars to send real emails to admissions@greenvalleyvidyavihar.edu', '-3 days');

// ============ ABOUT SCHOOL CONTENT (admin-editable public page) ============
const aboutDefaults = require('../src/config').about;
const sIns = db.prepare('INSERT INTO site_content (key, value) VALUES (?, ?)');
for (const [key, val] of Object.entries(aboutDefaults)) {
  sIns.run(key, val);
}

// ============ PUBLISH RESULTS (Term 1 & Term 2 for all classes) ============
for (const name of CLASS_NAMES) {
  for (const term of ['Term 1', 'Term 2']) {
    db.prepare('INSERT INTO published_results (class_id, exam_id, published_by) VALUES (?,?,?)')
      .run(classIds[name], examIds[term], 'School Administration');
  }
}

// ============ ONE EXAMPLE HOLIDAY (services/holidays.js) ============
// The demo row the school can see and delete: a festival, which is exactly the case the
// office asked for (“suppose today is Vishwakarma Puja”). Dates are the school's own IST
// day; a fresh seed marks the NEXT 17 September, and Sunday is never added — it is a
// holiday without a row.
{
  const iso = `${time.yearIST()}-09-17`;
  if (!db.prepare('SELECT 1 FROM holidays WHERE holiday_date = ?').get(iso)) {
    db.prepare('INSERT INTO holidays (holiday_date, name, greeting, note) VALUES (?,?,?,?)')
      .run(iso, 'Vishwakarma Puja', 'Happy Vishwakarma Puja!', 'Puja is held in the morning — no classes today.');
  }
}

console.log('✅ Database seeded successfully!');
console.log('\n🔑 DEMO LOGINS');
console.log('──────────────────────────────────────────────');
console.log('Admin   :  admin   / admin123');
console.log('Teachers:  teacher1 .. teacher13  (password: teacher123) — each opens his OWN class only, with the');
console.log('           sections the office grants on Admin → Teacher Access (seeded: students, marks, toppers,');
console.log('           timetable, notices, messages — NOT fees, and never the Admin panel)');
console.log('Parents :  parent1 .. parent52  (password: parent123) — each login opens the child\'s result, timetable & fees');
console.log('──────────────────────────────────────────────');
console.log('💡 Classes: LKG, KG, UKG + Class 1-10 (4 students each).');
console.log('    parentmulti / parent123  → one parent login with 2 children (Class 5 & Class 9)');
db.close();
