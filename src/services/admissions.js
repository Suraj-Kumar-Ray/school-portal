const db = require('../db');
const bcrypt = require('bcryptjs');
const { emailSchool } = require('./notify');
const config = require('../config');
const time = require('./time');

function getApplications(status) {
  const where = status ? 'WHERE a.status = ?' : '';
  return db.prepare(`
    SELECT a.*, c.name AS class_name, c.section, u.username AS parent_username
    FROM admissions a
    JOIN classes c ON c.id = a.class_id
    LEFT JOIN users u ON u.id = a.parent_user_id
    ${where} ORDER BY a.submitted_at DESC`).all(...(status ? [status] : []));
}

function getApplication(id) {
  return db.prepare(`
    SELECT a.*, c.name AS class_name, c.section, u.username AS parent_username
    FROM admissions a JOIN classes c ON c.id = a.class_id
    LEFT JOIN users u ON u.id = a.parent_user_id
    WHERE a.id = ?`).get(id);
}

function getApplicationByUser(userId) {
  return db.prepare('SELECT * FROM admissions WHERE parent_user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
}

// Create a new admission application + notify the school.
// parentUserId may be null — parents apply WITHOUT an account; the admin creates
// the parent login later (after approval) from the admin panel.
// Next application number = highest existing number for the year + 1.
// (Counting rows instead breaks as soon as any application is deleted, because
// the count falls back onto a number that already exists.)
function nextApplicationNo(prefix) {
  const rows = db.prepare('SELECT application_no FROM admissions WHERE application_no LIKE ?').all(prefix + '%');
  let max = 0;
  rows.forEach((r) => {
    const n = parseInt(String(r.application_no).slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return prefix + String(max + 1).padStart(4, '0');
}

async function createApplication(data, parentUserId) {
  const year = time.yearIST();   // the school's year (IST), never the server's
  const prefix = `APP-${year}-`;

  const insert = db.prepare(`
    INSERT INTO admissions (application_no, parent_user_id, child_name, child_dob, class_id,
                            parent_name, parent_phone, parent_email, address, previous_school)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  // Retry a few times so two applications arriving together can never crash
  // the form with a duplicate application number.
  let applicationNo = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = nextApplicationNo(prefix);
    try {
      insert.run(candidate, parentUserId, data.child_name, data.child_dob || null, parseInt(data.class_id, 10),
        data.parent_name, data.parent_phone, data.parent_email || null, data.address || null, data.previous_school || null);
      applicationNo = candidate;
      break;
    } catch (e) {
      const uniqueClash = /UNIQUE/i.test(String(e.message || '')) && /application_no/i.test(String(e.message || ''));
      if (!uniqueClash) throw e;
      lastErr = e;
    }
  }
  if (!applicationNo) throw lastErr || new Error('Could not allocate an application number');

  await emailSchool(
    `New admission application ${applicationNo}`,
    `A new admission application has been submitted.\n\n` +
    `Application No : ${applicationNo}\n` +
    `Child          : ${data.child_name} (${data.child_dob || '—'})\n` +
    `Class applied  : ${data.class_name}\n` +
    `Parent         : ${data.parent_name}\n` +
    `Phone          : ${data.parent_phone}\n` +
    `Email          : ${data.parent_email || '—'}\n` +
    `Address        : ${data.address || '—'}\n` +
    `Previous school: ${data.previous_school || '—'}\n\n` +
    `Review it in the admin panel → Admissions. After approving, create the parent login from the same page.`,
    'visitor'                     // it ARRIVED from the website — the office's dock must ring
  );
  return applicationNo;
}

// Approve -> create the student account + login, link the parent, notify school
/**
 * The first free roll number in a class.
 * `students` has UNIQUE (class_id, roll_no), so counting the rows is NOT enough:
 * the office can hand-type roll numbers (leaving gaps), so walk up from 1 and
 * take the first one nobody holds.
 */
function nextFreeRoll(classId) {
  const taken = new Set(db.prepare('SELECT roll_no FROM students WHERE class_id = ?').all(classId).map(r => Number(r.roll_no)));
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

/**
 * The next ADM<year>nnn admission number that is actually free.
 * `admission_no` is UNIQUE, and hand-typed numbers such as "ADM2026007" exist,
 * so this skips any value already in use instead of letting SQLite throw.
 */
function nextFreeAdmissionNo(year) {
  const used = new Set(db.prepare('SELECT admission_no FROM students WHERE admission_no LIKE ?')
    .all(`ADM${year}%`).map(r => String(r.admission_no)));
  for (let n = used.size + 1; ; n++) {
    const candidate = `ADM${year}${String(n).padStart(3, '0')}`;
    if (!used.has(candidate)) return candidate;
  }
}

async function approveApplication(id, adminName) {
  const app = getApplication(id);
  if (!app) throw new Error('Application not found');
  if (app.status === 'Approved') return { application: app, student: null, message: 'already approved' };

  const classId = app.class_id;
  // The class must still exist: a class can be deleted between applying and approving.
  if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(classId)) {
    throw new Error('This application\'s class no longer exists — please ask the parent to apply again, or add the class back.');
  }
  const year = time.yearIST();   // the school's year (IST) — matches createApplication
  const roll = nextFreeRoll(classId);
  const admissionNo = nextFreeAdmissionNo(year);
  // There is one login per child and it belongs to the PARENT (students do not
  // sign in). If the parent already applied from their own account, the child is
  // simply linked to it; otherwise a fresh parent login is created for the office
  // to hand over.
  const password = `vvs@${admissionNo}`;
  let parentUserId = app.parent_user_id;
  let username = app.parent_username || null;
  if (!parentUserId) {
    const taken = db.prepare('SELECT 1 FROM users WHERE username = ?');
    let candidate = `s${classId}r${roll}`;
    let extra = 2;
    while (taken.get(candidate)) candidate = `s${classId}r${roll}-${extra++}`;
    username = candidate;
    parentUserId = db.prepare('INSERT INTO users (username, password_hash, role, full_name, phone) VALUES (?,?,?,?,?)')
      .run(username, bcrypt.hashSync(password, 10), 'parent', app.child_name, app.parent_phone).lastInsertRowid;
  }

  // student record, linked to the parent login
  // the application carries one "parent name" — keep father_name in sync so the
  // student's admission record and the Edit Student form both show it
  // the application already carries the home address — carry it into the student
  // record so the office and the parent see it without re-typing
  db.prepare(`INSERT INTO students (user_id, parent_user_id, admission_no, full_name, class_id, roll_no, dob, parent_name, parent_phone, father_name, portal_password, address)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(parentUserId, parentUserId, admissionNo, app.child_name, classId, roll, app.child_dob, app.parent_name, app.parent_phone, app.parent_name, password, String(app.address || '').trim() || null);

  db.prepare(`UPDATE admissions SET status = 'Approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`)
    .run(adminName, id);

  await emailSchool(
    `Admission approved: ${app.child_name} (${app.application_no})`,
    `${app.child_name} has been admitted to ${app.class_name}${app.section ? ' ' + app.section : ''}.\n\n` +
    `Admission No : ${admissionNo}\n` +
    `Roll No.     : ${roll}\n` +
    `Parent login : ${username || '—'} / ${password}\n` +
    (app.parent_user_id
      ? `The parent's own account already shows this child in their portal.\n\n`
      : `Hand this login to the parent — it opens the child's result, timetable, fees and notices.\n\n`) +
    `Contact the parent at ${app.parent_phone} to confirm.`,
    'office'
  );

  return {
    application: getApplication(id),
    student: { admissionNo, roll, username, password, class_name: app.class_name },
  };
}

async function rejectApplication(id, adminName) {
  const app = getApplication(id);
  if (!app) throw new Error('Application not found');
  db.prepare(`UPDATE admissions SET status = 'Rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`)
    .run(adminName, id);
  await emailSchool(
    `Admission update: ${app.child_name} (${app.application_no})`,
    `The application for ${app.child_name} (${app.class_name}) has been marked as Rejected.\n\nContact the parent at ${app.parent_phone} to discuss.`,
    'office'
  );
  return getApplication(id);
}

// fee structure shown on the public site — admin edits these per class in /admin/fee-structure
// Full per-class model matching the school's printed fee sheet 2026-27:
//   day/hostel amounts for admission fee, form, annual, misc, tuition (monthly),
//   registration (Class 9 & 10 only) + book price. Totals are computed like the sheet.
function getFeeStructure() {
  return db.prepare(`
    SELECT c.id, c.name AS class, c.section, c.class_teacher AS classTeacher,
           c.adm_day, c.adm_hostel, c.form_day, c.form_hostel,
           c.annual_day, c.annual_hostel, c.misc_day, c.misc_hostel,
           c.tuition_day, c.tuition_hostel, c.reg_day, c.reg_hostel,
           c.book_price
    FROM classes c ORDER BY c.id`).all()
    .map(r => {
      // sheet-style totals (new admission includes every row once, incl. first month tuition)
      const newDay = r.adm_day + r.form_day + r.annual_day + r.misc_day + r.tuition_day + r.reg_day;
      const newHostel = r.adm_hostel + r.form_hostel + r.annual_hostel + r.misc_hostel + r.tuition_hostel + r.reg_hostel;
      const repDay = r.annual_day + r.misc_day + r.tuition_day + r.reg_day;
      const repHostel = r.annual_hostel + r.misc_hostel + r.tuition_hostel + r.reg_hostel;
      return { ...r, newDay, newHostel, repDay, repHostel };
    });
}

// group consecutive classes whose fee fields are identical (LKG & KG, Class 1 & 2, …)
function getFeeGroups() {
  const rows = getFeeStructure();
  const groups = [];
  const keyOf = r => ['adm_day','adm_hostel','form_day','form_hostel','annual_day','annual_hostel','misc_day','misc_hostel','tuition_day','tuition_hostel','reg_day','reg_hostel']
    .map(k => r[k]).join('|');
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && keyOf(last.classes[0]) === keyOf(r)) {
      last.classes.push(r);
      last.label = `${last.classes[0].class} & ${r.class}`;
    } else {
      groups.push({ label: r.class, classes: [r] });
    }
  }
  return groups;
}

// Admin creates a parent login for an application (usually after approval).
// Creates the users row with role 'parent', links it to the admission and to any
// student rows created from this application, and notifies the school by email.
function createParentLogin(applicationId, username, password, adminName) {
  const app = getApplication(applicationId);
  if (!app) throw new Error('Application not found');
  if (app.parent_user_id) throw new Error('This application already has a parent login (' + app.parent_username + ').');
  username = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.]{4,30}$/.test(username)) throw new Error('Username must be 4-30 characters — letters, numbers, dot or underscore only.');
  if (!password || String(password).length < 4) throw new Error('Password must be at least 4 characters.');

  const dup = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (dup) throw new Error('This username is already taken — choose another.');

  const bcrypt = require('bcryptjs');
  const info = db.prepare('INSERT INTO users (username, password_hash, role, full_name, phone, email) VALUES (?,?,?,?,?,?)')
    .run(username, bcrypt.hashSync(String(password), 10), 'parent', app.parent_name, app.parent_phone, app.parent_email || null);
  const parentUserId = info.lastInsertRowid;

  db.prepare('UPDATE admissions SET parent_user_id = ? WHERE id = ?').run(parentUserId, applicationId);
  // link any student rows that were created from this application before the login existed
  db.prepare('UPDATE students SET parent_user_id = ? WHERE parent_user_id IS NULL AND parent_name = ? AND parent_phone = ?')
    .run(parentUserId, app.parent_name, app.parent_phone);

  emailSchool(
    `Parent login created: ${app.parent_name} (${app.application_no})`,
    `A parent login was created by ${adminName}.\n\n` +
    `Application No : ${app.application_no}\n` +
    `Parent         : ${app.parent_name}\n` +
    `Username       : ${username}\n` +
    `Share the username/password with the parent on ${app.parent_phone}. They can then log in and see their child's results, fees and timetable.`,
    'office'
  ).catch(() => {});

  return { parentUserId, username, application: getApplication(applicationId) };
}

module.exports = { getApplications, getApplication, getApplicationByUser, createApplication, approveApplication, rejectApplication, createParentLogin, getFeeStructure, getFeeGroups };