-- School Portal Database Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student', 'parent')),
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,             -- e.g. "LKG", "KG", "UKG", "Class 5"
  section TEXT DEFAULT 'A',
  class_teacher TEXT,
  -- ---- fee structure (per the school's printed sheet; DAY scholar & HOSTEL student) ----
  adm_day REAL NOT NULL DEFAULT 3000,      -- admission fee (day) — one-time
  adm_hostel REAL NOT NULL DEFAULT 3500,   -- admission fee (hostel) — one-time
  form_day REAL NOT NULL DEFAULT 500,      -- admission form (day) — one-time
  form_hostel REAL NOT NULL DEFAULT 500,   -- admission form (hostel) — one-time
  annual_day REAL NOT NULL DEFAULT 2500,   -- annual fee (day) — yearly
  annual_hostel REAL NOT NULL DEFAULT 3000,-- annual fee (hostel) — yearly
  misc_day REAL NOT NULL DEFAULT 2500,     -- miscellaneous charge (day) — yearly
  misc_hostel REAL NOT NULL DEFAULT 3000,  -- miscellaneous charge (hostel) — yearly
  tuition_day REAL NOT NULL DEFAULT 1300,  -- tuition (day) — monthly
  tuition_hostel REAL NOT NULL DEFAULT 7500,-- tuition (hostel) — monthly
  reg_day REAL NOT NULL DEFAULT 0,         -- registration fee (day) — only Class 9 & 10
  reg_hostel REAL NOT NULL DEFAULT 0,      -- registration fee (hostel) — only Class 9 & 10
  book_price REAL NOT NULL DEFAULT 0,      -- book set price (from "Book Prices" list)
  UNIQUE (name, section)
);

-- school bus / conveyance routes with their monthly fare (admin-editable)
CREATE TABLE IF NOT EXISTS bus_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_name TEXT NOT NULL,
  fare REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  max_marks REAL NOT NULL DEFAULT 100,   -- written 90 + oral 10, activity subjects 50
  UNIQUE (class_id, name)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admission_no TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  roll_no INTEGER NOT NULL,
  parent_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  dob TEXT,
  parent_name TEXT,
  parent_phone TEXT,
  caste TEXT,
  category TEXT,                     -- General / OBC / SC / ST / EWS
  blood_group TEXT,
  father_name TEXT,
  father_occupation TEXT,
  mother_name TEXT,
  mother_occupation TEXT,
  annual_income TEXT,
  alt_phone TEXT,                    -- alternate mobile number
  guardian_name TEXT,                -- local guardian (if any)
  guardian_relation TEXT,
  guardian_phone TEXT,
  aadhaar TEXT,                      -- student's own 12-digit Aadhaar number
  father_aadhaar TEXT,
  mother_aadhaar TEXT,
  address TEXT,                      -- home address (village / town, district, PIN)
  portal_password TEXT,              -- shown to the admin so student logins can be handed out
  photo TEXT,                        -- profile photo (data URI or /images/... path); shown for Class 10 toppers
  -- ---- day scholar or hostel student (2026-09-16) ----
  -- 'day' | 'hostel'. A boarder's months are charged at the class's HOSTEL column
  -- (classes.tuition_hostel), a day scholar's at the day column — and a child who joins
  -- the hostel mid-session is charged the hostel rate only FROM that month.
  -- `hostel_from` / `hostel_until` are session months ("Jul 2026"); blank from = since the
  -- session began, blank until = still boarding. See src/services/stay.js, which is the ONE
  -- reader of these four columns, and never a view.
  stay TEXT NOT NULL DEFAULT 'day',
  hostel_from TEXT,
  hostel_until TEXT,
  hostel_bed TEXT,                  -- e.g. "Room 4 · Bed 7"
  UNIQUE (class_id, roll_no)
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,             -- e.g. "Term 1", "Term 2"
  year INTEGER NOT NULL,
  UNIQUE (term, year)
);

-- The EXAM date-sheet ("when the exams come, switch the timetable off and show the exam one").
-- One row per paper; `class_id` NULL means the same paper for every class. While the
-- office switches exam mode ON (site_content.examModeOn), the parents' and teachers'
-- Timetable page shows THIS instead of the weekly grid — see services/exam_timetable.js.
CREATE TABLE IF NOT EXISTS exam_timetable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,     -- which exam (Term 1 2026…)
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,  -- NULL = every class
  paper_date TEXT NOT NULL,        -- YYYY-MM-DD — the school's (IST) day
  subject TEXT NOT NULL,
  from_time TEXT,                  -- HH:MM, 24h; '' when the office fixes no time
  to_time TEXT,
  note TEXT,                       -- "bring your own graph paper"
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  marks_obtained REAL NOT NULL,
  max_marks REAL NOT NULL DEFAULT 100,
  UNIQUE (student_id, subject_id, exam_id)
);

-- The days the school is SHUT besides Sunday: a festival, a local bandh, a school
-- function, the summer break. One row per DATE (the school's own IST day), and every
-- screen reads it through src/services/holidays.js — the timetable card, the day strip,
-- the parents' home page and the message the office sends out.
CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holiday_date TEXT NOT NULL UNIQUE,      -- YYYY-MM-DD
  name TEXT NOT NULL,                     -- “Vishwakarma Puja”
  greeting TEXT,                          -- “Happy Vishwakarma Puja!” (optional)
  note TEXT,                              -- the extra sentence a parent may need
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(holiday_date);

-- What a teacher does besides taking a class: lunch break duty, and an extra (special)
-- class the office hands out. A teacher's own week is generated from the class grids, and
-- a break period belongs to nobody — that is why these live in their own table. One row
-- per teacher/day/period; the UNIQUE makes “one teacher, one thing at a time” a fact of
-- the data, not just a check in a route. Read only through src/services/duties.js.
CREATE TABLE IF NOT EXISTS teacher_duties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher TEXT NOT NULL,
  day TEXT NOT NULL,
  period INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lunch',     -- 'lunch' (break duty) | 'special' (extra class)
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  subject TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (teacher, day, period)
);
CREATE INDEX IF NOT EXISTS idx_teacher_duties_slot ON teacher_duties(day, period);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,  -- NULL = all classes
  posted_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  audience TEXT NOT NULL DEFAULT 'all'   -- 'all' = parents too · 'teachers' = staff only
);

CREATE TABLE IF NOT EXISTS timetable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  day TEXT NOT NULL,              -- Monday..Saturday
  period INTEGER NOT NULL,
  subject TEXT NOT NULL,
  teacher TEXT,
  kind TEXT NOT NULL DEFAULT 'class', -- class | assembly | break | lunch | games | activity | test
  UNIQUE (class_id, day, period)
);

-- HOMEWORK, spoken period by period (2026-09-18): “the timetable should show what homework
-- was given.” A teacher writes it from his portal and the office writes it from the admin
-- panel; a parent reads it ON the timetable card of that period. One row per class/day/period,
-- so it cannot disagree with the timetable itself. `given_on` is the school's (IST) day the
-- note was written, so a parent can tell today's homework from an older one. A row whose
-- note is empty carries the standing instruction the school asked for: “Homework given —
-- please check the copy.”
CREATE TABLE IF NOT EXISTS homework (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  day TEXT NOT NULL,              -- Monday..Saturday — the timetable day it belongs to
  period INTEGER NOT NULL,        -- the period it was given in
  subject TEXT NOT NULL,          -- copied from the timetable slot when written
  note TEXT NOT NULL DEFAULT '',  -- '' = the standing “please check the copy” line
  given_by TEXT NOT NULL DEFAULT '',  -- teacher's name or 'School office'
  given_on TEXT NOT NULL,         -- YYYY-MM-DD (IST) — when it was written
  UNIQUE (class_id, day, period)
);

-- WHO DID and who did NOT do the homework (2026-09-18): the class teacher or the office
-- marks the truth on a child's homework page — 'not_done' shows a red ✕ on that period's
-- band in the parents' timetable, 'done' a green ✓. A child with NO row here shows no
-- mark at all, which is the normal state: nobody marked him, so nothing is claimed.
CREATE TABLE IF NOT EXISTS homework_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  day TEXT NOT NULL,              -- Monday..Saturday — the timetable day it belongs to
  period INTEGER NOT NULL,        -- the period whose homework is being marked
  status TEXT NOT NULL CHECK (status IN ('done', 'not_done')),
  marked_by TEXT NOT NULL DEFAULT '',  -- who wrote the mark (teacher / office name)
  marked_on TEXT NOT NULL,        -- YYYY-MM-DD (IST) — when the mark was made
  UNIQUE (student_id, day, period)
);
CREATE INDEX IF NOT EXISTS idx_hwstatus_student_day ON homework_status(student_id, day);

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  subject TEXT,                -- NULL = class teacher (all subjects)
  phone TEXT,
  photo TEXT,                  -- profile photo (data URI or /images/... path)
  qualification TEXT,          -- education e.g. "M.A. Hindi, B.Ed."
  experience_years INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0,   -- shown as stars on the public profile card
  bio TEXT,                    -- short intro shown on the public card
  can_login INTEGER NOT NULL DEFAULT 1,  -- the office's on/off switch for this login
  portal_password TEXT,        -- readable password the office hands out (admin pages only)
  all_classes INTEGER NOT NULL DEFAULT 0, -- 1 = may work on EVERY class, not just his own
  UNIQUE (user_id)
);

-- What ONE teacher may open in the teacher portal. A teacher has no access until
-- the office grants a section here — the grants decide WHICH pages open.
-- The list of sections is defined once in src/services/permissions.js.
CREATE TABLE IF NOT EXISTS teacher_permissions (
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  perm TEXT NOT NULL,                      -- students | marks | toppers | timetable | notices | messages | fees
  granted_by TEXT,                         -- who gave this access (admin name)
  granted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (teacher_id, perm)
);

-- WHICH classes a teacher works on (the office picks them — a teacher is NOT
-- limited to `teachers.class_id`). Rules, all applied in
-- src/services/permissions.js:
--   • `teachers.all_classes = 1`  → every class in the school, forever (new
--     classes included, which is why it is a flag and not one row per class),
--   • rows here                   → exactly these classes,
--   • no row at all               → his own class only (the old behaviour).
CREATE TABLE IF NOT EXISTS teacher_class_access (
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  granted_by TEXT,                         -- who gave this access (admin name)
  granted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (teacher_id, class_id)
);

CREATE TABLE IF NOT EXISTS fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term TEXT NOT NULL,          -- month label e.g. 'April 2026'
  amount REAL NOT NULL,        -- monthly tuition the class is charged
  paid INTEGER NOT NULL DEFAULT 0,          -- DERIVED: 1 when paid_amount covers amount + fine
  due_date TEXT,
  paid_date TEXT,              -- DERIVED: date of the receipt that closed the month
  paid_amount REAL NOT NULL DEFAULT 0,      -- money actually received so far (sum of fee_payments)
  fine REAL NOT NULL DEFAULT 0,             -- late-payment fine the office added by hand
  fine_note TEXT,                           -- why the fine was added (optional)
  UNIQUE (student_id, term)
);

-- one row per money receipt. A month can carry several (partial payments):
--   Rs.500 on 05/09 + Rs.800 on 19/09 closes a Rs.1,300 installment.
-- `fees.paid_amount` is always kept equal to SUM(amount) of these rows, so the
-- ledger, the parent portal and the receipt history can never disagree.
CREATE TABLE IF NOT EXISTS fee_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fee_id INTEGER NOT NULL REFERENCES fees(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  paid_on TEXT,                             -- receipt date, DD/MM/YYYY on the school's (IST) day
  mode TEXT NOT NULL DEFAULT 'Cash',        -- Cash | UPI | Cheque | Bank transfer | Other
  note TEXT,
  -- which of the month's two bills this money settled: 'school' | 'hostel' | NULL (the
  -- school's own order — school fee first, then the hostel fee). A hostel student's month
  -- carries both bills; see src/services/fees.js (`splitOf` / `splitMonth`).
  part TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- What a parent says they have paid. A parent paying from home (UPI / bank) cannot make
-- the school's record change by itself, so the app files a CLAIM here: the amount, the mode,
-- the reference they can read off the slip, an optional screenshot and the months they meant.
-- Nothing in this table is money — the office checks it (Admin -> Fees) and only *recording*
-- it writes receipts into `fee_payments`, exactly like a payment taken at the counter.
CREATE TABLE IF NOT EXISTS fee_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  parent_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount REAL NOT NULL,
  mode TEXT NOT NULL DEFAULT 'UPI',         -- UPI | Bank transfer | Cash | Cheque | Other
  reference TEXT,                           -- UPI UTR / cheque no. / what the bank shows
  note TEXT,                                -- anything the parent wants to say
  photo TEXT,                               -- the payment screenshot (small data URI)
  months TEXT,                              -- JSON list of fee ids the parent meant (may be [])
  paid_on TEXT,                             -- the day the parent says they paid (DD/MM/YYYY)
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | recorded | rejected
  created_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT,                          -- the office login that decided it
  decision_note TEXT,                       -- why it was rejected, or the office's remark
  recorded TEXT                             -- JSON summary of the receipts recording created
);
CREATE INDEX IF NOT EXISTS idx_fee_claims_student ON fee_claims(student_id);
CREATE INDEX IF NOT EXISTS idx_fee_claims_status ON fee_claims(status);

-- parent <-> school structured messaging
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,  -- root message id of the conversation
  parent_user_id INTEGER NOT NULL REFERENCES users(id),
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL, -- which child the message is about
  direction TEXT NOT NULL CHECK (direction IN ('to_school', 'to_parent')),
  category TEXT NOT NULL DEFAULT 'General',   -- Fee | Performance | Timetable | Notice | PTM | General
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',       -- unread | read
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

-- office -> teacher messages (2026-09-20)
-- The school's rule: ONLY the office writes to a teacher — nobody else. One row per teacher,
-- so each has his own read state on the same letter. Read through src/services/staff_messages.js.
CREATE TABLE IF NOT EXISTS staff_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'General',   -- General | Class work | Duty | Exam | Meeting | Holiday | Urgent
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',       -- unread | read
  sent_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_messages_teacher ON staff_messages(teacher_user_id, status);

-- admission applications submitted through the public website
CREATE TABLE IF NOT EXISTS admissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_no TEXT UNIQUE NOT NULL,
  parent_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  child_name TEXT NOT NULL,
  child_dob TEXT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  parent_name TEXT NOT NULL,
  parent_phone TEXT NOT NULL,
  parent_email TEXT,
  address TEXT,
  previous_school TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
  submitted_at TEXT DEFAULT (datetime('now')),
  reviewed_by TEXT,
  reviewed_at TEXT
);

-- school inbox: notifications generated by the system (email log + events)
-- `origin` says WHO caused the row, so the office's notification dock can ring for things that
-- arrived for the school and stay silent for the school's own mail (see src/services/notify.js
-- and src/services/office_feed.js): 'office' | 'visitor' | 'parent' | 'system'.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,          -- 'email' | 'login' | 'system'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'system',   -- office | visitor | parent | system
  created_at TEXT DEFAULT (datetime('now')),
  read INTEGER NOT NULL DEFAULT 0
);

-- the hostel's weekly MESS MENU — what food is served, day by day (admin-editable).
-- The boarders' parents read it in the app (what happens in the hostel day by day); a
-- day scholar's parent never sees it. Read through src/services/hostel.js.
CREATE TABLE IF NOT EXISTS hostel_menu (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,             -- Monday … Sunday (the hostel runs all seven days)
  meal TEXT NOT NULL,            -- Breakfast | Lunch | Snacks | Dinner
  items TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (day, meal)
);

-- the hostel's DAILY ROUTINE (timings) — admin-editable, shown to hostel parents
-- beside the menu so they can see the whole day: wake-up, study hours, games, lights out.
CREATE TABLE IF NOT EXISTS hostel_routine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,            -- "05:30" (24-hour, the way the timetable stores its periods)
  activity TEXT NOT NULL,        -- "Wake up & exercise"
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- THE SCHOOL STORE — what a family pays for besides the monthly fee
-- ============================================================================
-- A book set, a uniform, a notebook bundle: handed over on a day, paid in full or in
-- parts. Kept OUT of `fees` on purpose (a fee row is one child per session MONTH; a
-- store item is taken once, or twice, or never) and read through src/services/store.js.
-- The two ledgers meet only in the readers: the parent's fee page shows this bill beside
-- the monthly one, and a fee reminder adds the item balance to what it asks for.

-- the price list the office edits (name, category, price, unit) — an item is switched
-- OFF rather than deleted once a child has taken it, so no bill loses its history
CREATE TABLE IF NOT EXISTS store_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Books',   -- Books / Uniform / Stationery / Other
  price REAL NOT NULL DEFAULT 0,
  unit TEXT,                                -- "set", "piece", "pair" (optional)
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ONE hand-over. The item's name and price are COPIED here (a later price-list edit
-- must never rewrite an old bill), `amount` is qty × unit_price, and `paid` is what has
-- been received against this row (a part payment leaves a balance, like a fee month).
CREATE TABLE IF NOT EXISTS student_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  item_id INTEGER,                          -- the catalogue row it came from (NULL = a one-off)
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Books',
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  issued_on TEXT NOT NULL,                  -- the SCHOOL's day (IST)
  note TEXT,
  paid REAL NOT NULL DEFAULT 0,
  paid_on TEXT,
  mode TEXT,                                -- Cash / UPI / Bank transfer / Adjusted in fee
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_student_items_student ON student_items(student_id);

-- boys hostel fee structure shown on the public hostel page (admin-editable)
CREATE TABLE IF NOT EXISTS hostel_fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  kind TEXT NOT NULL DEFAULT 'monthly' CHECK (kind IN ('monthly', 'onetime')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- SMS/WhatsApp alerts sent to parents (result published, fee due, new notice)
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  parent_name TEXT,
  child_name TEXT,
  child_class TEXT,
  phone TEXT,
  channel TEXT NOT NULL DEFAULT 'sms',        -- sms | whatsapp
  event TEXT NOT NULL DEFAULT 'system',       -- result_published | fee_due | notice | system
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'demo',        -- demo (no gateway) | sent | failed
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alert_log_parent ON alert_log(parent_user_id);

-- published exam results -> notifies parents when a result is released
CREATE TABLE IF NOT EXISTS published_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  published_at TEXT DEFAULT (datetime('now')),
  published_by TEXT,
  UNIQUE (class_id, exam_id)
);

-- homepage toppers: 3 toppers per class, fully admin-managed (Admin -> Toppers)
CREATE TABLE IF NOT EXISTS class_toppers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_name TEXT NOT NULL,          -- display label e.g. "Class 10"
  rank_no INTEGER NOT NULL,          -- 1 = gold, 2 = silver, 3 = bronze
  name TEXT NOT NULL,
  percentage REAL NOT NULL DEFAULT 0,
  photo TEXT,                        -- data URI or /images/... path; NULL = initials avatar
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (class_name, rank_no)
);

-- editable "About the school" content shown on the public about page (admin-edited)
CREATE TABLE IF NOT EXISTS site_content (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_marks_student ON marks(student_id);
CREATE INDEX IF NOT EXISTS idx_fees_student ON fees(student_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_fee ON fee_payments(fee_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_student ON fee_payments(student_id);