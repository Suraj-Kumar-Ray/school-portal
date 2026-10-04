const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// The database lives in `data/` next to the app — unless DATA_DIR says otherwise, which is
// how a hosting platform (Render disk, a Docker volume, a VPS mount) points the school's
// one file of truth at its persistent disk. The directory is created if missing, so a
// fresh machine boots to a working (empty, seedable) database.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'school.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---- lightweight migrations for databases created before a column existed ----
// (schema.sql stays the source of truth for fresh databases; this keeps old DBs working)
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('students', 'photo', 'photo TEXT');
ensureColumn('teachers', 'photo', 'photo TEXT');
// A timetable slot is not always a subject: assembly, short break, lunch (period 5 in
// most schools), games, activity, test. Old rows are all subject periods.
ensureColumn('timetable', 'kind', "kind TEXT NOT NULL DEFAULT 'class'");
// A notice can later be meant for teachers alone; every notice written before this
// column existed was for the whole school, so that stays the default.
ensureColumn('notices', 'audience', "audience TEXT NOT NULL DEFAULT 'all'");

// ---- student admission record: family, category and contact details ----
for (const [col, ddl] of Object.entries({
  caste: 'caste TEXT',
  category: 'category TEXT',                       // General / OBC / SC / ST / EWS
  blood_group: 'blood_group TEXT',
  father_name: 'father_name TEXT',
  father_occupation: 'father_occupation TEXT',
  mother_name: 'mother_name TEXT',
  mother_occupation: 'mother_occupation TEXT',
  annual_income: 'annual_income TEXT',
  alt_phone: 'alt_phone TEXT',                     // alternate mobile number
  guardian_name: 'guardian_name TEXT',             // local guardian (if any)
  guardian_relation: 'guardian_relation TEXT',
  guardian_phone: 'guardian_phone TEXT',
  aadhaar: 'aadhaar TEXT',                         // student's own 12-digit Aadhaar
  father_aadhaar: 'father_aadhaar TEXT',
  mother_aadhaar: 'mother_aadhaar TEXT',
  address: 'address TEXT',                         // home address (village / town, district, PIN)
})) ensureColumn('students', col, ddl);

// student portal login password, kept in plain text ONLY so the admin can hand out
// and change credentials from the dashboard (admin-only pages).
ensureColumn('students', 'portal_password', 'portal_password TEXT');

// each subject carries its own maximum (e.g. written 90 + oral 10)
ensureColumn('subjects', 'max_marks', 'max_marks REAL NOT NULL DEFAULT 100');

// ---- class fee structure columns (full sheet: day + hostel) ----
for (const [col, ddl] of Object.entries({
  adm_day: 'REAL NOT NULL DEFAULT 3000', adm_hostel: 'REAL NOT NULL DEFAULT 3500',
  form_day: 'REAL NOT NULL DEFAULT 500', form_hostel: 'REAL NOT NULL DEFAULT 500',
  annual_day: 'REAL NOT NULL DEFAULT 2500', annual_hostel: 'REAL NOT NULL DEFAULT 3000',
  misc_day: 'REAL NOT NULL DEFAULT 2500', misc_hostel: 'REAL NOT NULL DEFAULT 3000',
  tuition_day: 'REAL NOT NULL DEFAULT 1300', tuition_hostel: 'REAL NOT NULL DEFAULT 7500',
  reg_day: 'REAL NOT NULL DEFAULT 0', reg_hostel: 'REAL NOT NULL DEFAULT 0',
  book_price: 'REAL NOT NULL DEFAULT 0',
})) ensureColumn('classes', col, ddl);
ensureColumn('teachers', 'qualification', 'qualification TEXT');
ensureColumn('teachers', 'experience_years', 'experience_years INTEGER NOT NULL DEFAULT 0');
ensureColumn('teachers', 'rating', 'rating REAL NOT NULL DEFAULT 0');
ensureColumn('teachers', 'bio', 'bio TEXT');

// ---- fee ledger: partial payments + fines (2026-09-14) ----
// `paid` stays the "month fully settled" flag every other page already reads, but the
// truth about money lives in `paid_amount` (sum of the receipts in `fee_payments`)
// plus the office's `fine`. Existing tables are migrated and the old lump-sum
// "paid" rows are given a matching receipt, so no ledger starts out disagreeing
// with its history.
const feesHadPaidAmount = db.prepare('PRAGMA table_info(fees)').all().some(c => c.name === 'paid_amount');
ensureColumn('fees', 'paid_amount', 'paid_amount REAL NOT NULL DEFAULT 0');
ensureColumn('fees', 'fine', 'fine REAL NOT NULL DEFAULT 0');
ensureColumn('fees', 'fine_note', 'fine_note TEXT');

// school bus / conveyance routes
ensureTable('bus_routes', `CREATE TABLE bus_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_name TEXT NOT NULL,
  fare REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
)`);

// ---- homework, spoken period by period (2026-09-18) ----
// A teacher writes it from his portal, the office from the admin panel; a parent reads it on
// the timetable card of that period. One row per class/day/period — db/schema.sql is the
// source of truth; this migration keeps older databases working.
ensureTable('homework', `CREATE TABLE homework (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  period INTEGER NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  given_by TEXT NOT NULL DEFAULT '',
  given_on TEXT NOT NULL,
  UNIQUE (class_id, day, period)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_homework_class_day ON homework(class_id, day)');

// ---- who DID and who did NOT do it (2026-09-18) ----
// The class teacher (or the office) opens a child's homework page and marks the truth:
// 'not_done' puts a red ✕ on that period's homework band in the parents' timetable,
// 'done' puts a green ✓. NO ROW AT ALL is the normal state — the band stays plain, so
// a parent never sees a mark nobody wrote. Marking is per child, per day, per period;
// the day is stored as written ("Friday"), exactly like the homework rows themselves.
ensureTable('homework_status', `CREATE TABLE homework_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  period INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done', 'not_done')),
  marked_by TEXT NOT NULL DEFAULT '',
  marked_on TEXT NOT NULL,
  UNIQUE (student_id, day, period)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_hwstatus_student_day ON homework_status(student_id, day)');

// one row per money receipt (a month can be paid in parts)
ensureTable('fee_payments', `CREATE TABLE fee_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fee_id INTEGER NOT NULL REFERENCES fees(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  paid_on TEXT,
  mode TEXT NOT NULL DEFAULT 'Cash',
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_fee_payments_fee ON fee_payments(fee_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_fee_payments_student ON fee_payments(student_id)');

// ---- which of the month's TWO bills a receipt settled (2026-09-16) ----
// A hostel student's month is the school fee plus the hostel fee (mess & lodging), and a family
// often pays them at different times. NULL/'' keeps the school's own order — the school fee is
// settled first, then the hostel fee — and the office can label a receipt 'school' or 'hostel'
// when it knows what the money was meant for. Read ONLY through src/services/fees.js
// (`splitMonth`), which is also where the parts of a month are added up.
ensureColumn('fee_payments', 'part', 'part TEXT');

// ---- teacher portal access (2026-09-14) ----
// A teacher signs in with the username/password the office sets. `can_login` is the
// office's on/off switch and `portal_password` keeps that password readable for the
// office only — exactly the convention `students.portal_password` already uses.
ensureColumn('teachers', 'can_login', 'can_login INTEGER NOT NULL DEFAULT 1');
ensureColumn('teachers', 'portal_password', 'portal_password TEXT');

// which sections a teacher may open — one row per granted section. The list of
// sections itself lives in src/services/permissions.js, never in a view.
ensureTable('teacher_permissions', `CREATE TABLE teacher_permissions (
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  perm TEXT NOT NULL,
  granted_by TEXT,
  granted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (teacher_id, perm)
)`);

// WHICH classes that login may work on. The office is not limited to the teacher's
// own class: it can tick any classes, or switch on "all classes". Read by
// src/services/permissions.js (`classesFor`) on every teacher request.
ensureColumn('teachers', 'all_classes', 'all_classes INTEGER NOT NULL DEFAULT 0');
ensureTable('teacher_class_access', `CREATE TABLE teacher_class_access (
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  granted_by TEXT,
  granted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (teacher_id, class_id)
)`);

// key/value store for admin-editable website content (e.g. About the school)
function ensureTable(table, ddl) {
  const found = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (!found) db.exec(ddl);
}
ensureTable('site_content', `CREATE TABLE site_content (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
)`);

// ---- what a parent says they paid (2026-09-15) ----
// A parent who sends the fee by UPI/bank from home files a CLAIM; the office checks it on
// Admin → Fees and records it, which is what writes the receipts into `fee_payments`.
// See src/services/fees.js (`createClaim` / `recordClaim`) and views/parent/pay.ejs.
ensureTable('fee_claims', `CREATE TABLE fee_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  parent_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount REAL NOT NULL,
  mode TEXT NOT NULL DEFAULT 'UPI',
  reference TEXT,
  note TEXT,
  photo TEXT,
  months TEXT,
  paid_on TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT,
  recorded TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_fee_claims_student ON fee_claims(student_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_fee_claims_status ON fee_claims(status)');

// homepage toppers (3 per class) — admin manages them on Admin -> Toppers
ensureTable('class_toppers', `CREATE TABLE class_toppers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_name TEXT NOT NULL,
  rank_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  percentage REAL NOT NULL DEFAULT 0,
  photo TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (class_name, rank_no)
)`);

// ---- the exam date-sheet (2026-09-15) ----
// "When the exams come, switch the timetable off and show the exam one." One row per paper; a NULL
// class_id means the same paper for every class. Read through services/exam_timetable.js,
// which also owns the exam-mode switch in site_content.
ensureTable('exam_timetable', `CREATE TABLE exam_timetable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  paper_date TEXT NOT NULL,
  subject TEXT NOT NULL,
  from_time TEXT,
  to_time TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_exam_timetable_class ON exam_timetable(class_id, paper_date)');

// ---- what a teacher does besides taking a class (2026-09-20) ----
// The school asked for two sections on the office's board — lunch duty and an extra class, each
// handed to a teacher — and for both to show on that teacher's own timetable. A teacher's week is
// generated from the class grids, and
// a break period belongs to nobody — so lunch duty and extra classes live HERE, one row per
// teacher/day/period, and `services/duties.js` layers them onto his week. The UNIQUE index is
// the rule the school asked for: one teacher, one thing at a time.
ensureTable('teacher_duties', `CREATE TABLE teacher_duties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher TEXT NOT NULL,
  day TEXT NOT NULL,
  period INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lunch',       -- 'lunch' (break duty) | 'special' (extra class)
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,   -- the extra class's class
  subject TEXT,                             -- what the extra class is about
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (teacher, day, period)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_teacher_duties_slot ON teacher_duties(day, period)');

// ---- the office's messages to teachers (2026-09-20) ----
// The teacher portal's Messages tab reads THIS table and nothing else: the school's rule is
// that only the office may write to a teacher. One row per teacher, so the same letter can be
// read by one and still wait for the other — db/schema.sql is the source of truth, this keeps
// older databases working. Read through src/services/staff_messages.js.
ensureTable('staff_messages', `CREATE TABLE staff_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'General',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  sent_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_staff_messages_teacher ON staff_messages(teacher_user_id, status)');

// ---- the days the school is shut besides Sunday (2026-09-17) ----
// “Suppose today is Vishwakarma Puja — the school should be able to update it and the
// timetable should show a holiday.” One row per DATE, read only through
// src/services/holidays.js; Sunday is a holiday without a row.
ensureTable('holidays', `CREATE TABLE holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holiday_date TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  greeting TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(holiday_date)');

// ---- day scholar / hostel student (2026-09-16) ----
// Which column of the class fee sheet a child is charged from, and for WHICH months:
// a boarder who joins the hostel in July is at the day rate until June and at the hostel
// rate from July. src/services/stay.js is the only reader of these four columns, and
// src/services/fees.js prices every month through it.
ensureColumn('students', 'stay', "stay TEXT NOT NULL DEFAULT 'day'");
ensureColumn('students', 'hostel_from', 'hostel_from TEXT');
ensureColumn('students', 'hostel_until', 'hostel_until TEXT');

// ---- BED NUMBER, not a room (school's request, 2026-09-16) ----
// The hostel has beds, so the office records a bed number and the screens print “Bed 4”.
// A database created earlier holds `hostel_room` (often “Room 2 · Bed 4”): its bed is
// moved into `hostel_bed` and the old column is dropped, so there is ONE truth. If the
// drop fails on some old SQLite build the column simply stays behind, unused.
ensureColumn('students', 'hostel_bed', 'hostel_bed TEXT');
if (db.prepare('PRAGMA table_info(students)').all().some((c) => c.name === 'hostel_room')) {
  const rows = db.prepare("SELECT id, hostel_room FROM students WHERE hostel_room IS NOT NULL AND TRIM(hostel_room) <> ''").all();
  const upd = db.prepare('UPDATE students SET hostel_bed = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      // strip whatever label the old value carried: “Room 2 · Bed 4” → 4, “Bed no 7” → 7
      const marked = /\bbed\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Za-z0-9/-]+)/i.exec(r.hostel_room)
        || /\broom\b[^\d]*([A-Za-z0-9/-]+)/i.exec(r.hostel_room);
      upd.run(String(marked ? marked[1] : r.hostel_room).trim().toUpperCase().slice(0, 20), r.id);
    }
  })();
  try {
    db.exec('ALTER TABLE students DROP COLUMN hostel_room');
  } catch (err) {
    // an SQLite older than 3.35 cannot drop a column — leaving it is harmless, because
    // nothing reads `hostel_room` any more: src/services/stay.js is the only reader of a
    // stay and it reads `hostel_bed`.
  }
}

// ---- the school store (2026-09-16): the price list + what each child took ----
// Kept apart from `fees` on purpose (a fee row is one child per session MONTH; a store
// item is taken once, or twice, or never) and read through src/services/store.js.
ensureTable('store_items', `CREATE TABLE store_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Books',
  price REAL NOT NULL DEFAULT 0,
  unit TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
)`);
ensureTable('student_items', `CREATE TABLE student_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  item_id INTEGER,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Books',
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  issued_on TEXT NOT NULL,
  note TEXT,
  paid REAL NOT NULL DEFAULT 0,
  paid_on TEXT,
  mode TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_student_items_student ON student_items(student_id)');

// the hostel's mess menu (one row per day + meal) and its daily routine — admin-editable
// on Admin → Hostel, read by the parents of a hostel student in the app.
ensureTable('hostel_menu', `CREATE TABLE hostel_menu (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  meal TEXT NOT NULL,
  items TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (day, meal)
)`);
ensureTable('hostel_routine', `CREATE TABLE hostel_routine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  activity TEXT NOT NULL,
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
)`);

// A new hostel starts with a real menu and a real day, so a boarder's parent opens the
// app to something instead of a blank page. Only when the table is EMPTY — the office's own
// edits are never overwritten by a later start (the rows are also INSERT OR IGNORE, keyed
// on day + meal).
seedHostelContent();

function seedHostelContent() {
  if (!db.prepare('SELECT COUNT(*) n FROM hostel_menu').get().n) {
    const MENU = {
      Monday: { Breakfast: 'Poha, banana and milk', Lunch: 'Dal, rice, roti, mixed sabzi, salad', Snacks: 'Tea and biscuits', Dinner: 'Roti, paneer sabzi, dal, rice' },
      Tuesday: { Breakfast: 'Aloo paratha, curd and tea', Lunch: 'Chana dal, rice, roti, bhindi sabzi', Snacks: 'Samosa and tea', Dinner: 'Roti, aloo-matar, dal, kheer' },
      Wednesday: { Breakfast: 'Idli, sambar and chutney', Lunch: 'Rajma, rice, roti, cabbage sabzi', Snacks: 'Bread pakora and tea', Dinner: 'Roti, kadhi, dal, rice' },
      Thursday: { Breakfast: 'Puri, aloo sabzi and milk', Lunch: 'Moong dal, rice, roti, lauki sabzi', Snacks: 'Fruit and milk', Dinner: 'Roti, soya chunk sabzi, dal, rice' },
      Friday: { Breakfast: 'Upma and milk', Lunch: 'Arhar dal, rice, roti, aloo-gobhi', Snacks: 'Pakora and tea', Dinner: 'Roti, paneer bhurji, dal, rice' },
      Saturday: { Breakfast: 'Paratha, pickle and tea', Lunch: 'Chole, rice, roti, salad', Snacks: 'Biscuits and milk', Dinner: 'Roti, mix veg, dal, rice, fruit' },
      Sunday: { Breakfast: 'Aloo paratha, curd and pickle', Lunch: 'Veg biryani, raita and salad', Snacks: 'Tea and samosa', Dinner: 'Roti, dal makhani, rice, ice cream' },
    };
    const ins = db.prepare('INSERT OR IGNORE INTO hostel_menu (day, meal, items, sort_order) VALUES (?,?,?,?)');
    db.transaction(() => {
      Object.entries(MENU).forEach(([day, meals], d) => {
        Object.entries(meals).forEach(([meal, items], m) => ins.run(day, meal, items, d * 10 + m));
      });
    })();
  }
  if (!db.prepare('SELECT COUNT(*) n FROM hostel_routine').get().n) {
    const ROUTINE = [
      ['05:30', 'Wake up and exercise', 'On the ground, all boarders'],
      ['06:30', 'Study hour', 'Supervised by the warden'],
      ['07:30', 'Breakfast', 'In the mess'],
      ['08:15', 'School', 'With the day scholars'],
      ['13:00', 'Lunch', 'In the mess'],
      ['14:00', 'Rest', 'In the room'],
      ['15:30', 'Games', 'Ground and indoor games'],
      ['17:00', 'Snacks and study hour', ''],
      ['20:00', 'Dinner', 'In the mess'],
      ['21:00', 'Self-study', 'In the study hall'],
      ['22:00', 'Lights out', ''],
    ];
    const ins = db.prepare('INSERT INTO hostel_routine (time, activity, note, sort_order) VALUES (?,?,?,?)');
    db.transaction(() => {
      ROUTINE.forEach(([time, activity, note], i) => ins.run(time, activity, note, i));
    })();
  }
}

// ---- who caused an inbox row (2026-09-16) ----
// The office's notification dock (`services/office_feed.js`) rings when something ARRIVES
// for the school. The `notifications` table is the website inbox, and it also holds the mail
// the office itself generates (a reply sent to a parent, an approval) — without knowing who
// caused a row, the office's own action would ring its own bell 20 seconds later.
// 'visitor' = the public website (contact form, admission form) or a parent; 'parent' = a
// parent's own message; 'office' = the school's own action; 'system' = anything unattributed
// (including every row written before this column existed, which stays quiet by default).
ensureColumn('notifications', 'origin', "origin TEXT NOT NULL DEFAULT 'system'");
db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_origin_read ON notifications(origin, read)');

// ---- one-time repair: a month that was already "paid" before this feature ----
// Before partial payments existed, a paid month carried only `paid = 1`. Give it the
// money and the receipt it was missing, so (a) the collected total is unchanged and
// (b) the parent's receipt history starts from a real row instead of a blank.
const healPaid = db.prepare(`UPDATE fees SET paid_amount = amount
                              WHERE paid = 1 AND paid_amount = 0 AND amount > 0`).run().changes;
if (healPaid && !feesHadPaidAmount) {
  db.prepare(`INSERT INTO fee_payments (fee_id, student_id, amount, paid_on, mode, note)
              SELECT f.id, f.student_id, f.amount, f.paid_date, 'Cash', 'Recorded before receipts were tracked'
              FROM fees f
              WHERE f.paid = 1 AND f.amount > 0 AND f.paid_date IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM fee_payments p WHERE p.fee_id = f.id)`).run();
}

module.exports = db;