/**
 * ============================================================================
 * permissions.js — the ONE place that decides what a teacher may open.
 * ============================================================================
 *
 * Why this file exists
 * --------------------
 * A teacher signs in with the username/password the school office sets, and sees
 * **only the sections the office granted** — nothing else. Before this file the
 * portal had no staff login at all, and "who may see what" lived in the sidebar
 * of each view.
 *
 * Now there are exactly two rules, and both live here:
 *
 *   1. **Permission decides WHICH page opens.** `SECTIONS` below is the whole
 *      list of teacher pages. One row in `teacher_permissions` per granted
 *      section. No grant → the page answers 403 and the sidebar link is not
 *      printed at all.
 *
 *   2. **The office ALSO picks the classes.** `teachers.class_id` is only the
 *      class he is class-teacher of. On top of it the office can tick extra
 *      classes (`teacher_class_access`) or switch on **all classes**
 *      (`teachers.all_classes = 1`) — a subject teacher who handles Class 6, 7
 *      and 8 gets exactly those, and the maths teacher can be given the whole
 *      school. `classesFor()` is the only place that list is computed.
 *
 *      A route still never trusts a class id from the URL or the form: it asks
 *      `withClass()` (src/middleware/auth.js), which only ever returns a class
 *      out of `classesFor()`. A hand-typed `?class=99` falls back to the first
 *      class the teacher really has, so a grant can never leak another class.
 *
 * How to add a teacher section
 * ----------------------------
 *   1. add one entry to `SECTIONS` (key, group, icon, label, hint),
 *   2. write the route in `src/routes/teacher.js` behind `requirePerm('<key>')`,
 *   3. add the view under `views/teacher/`.
 * The admin permission page, the sidebar and the dashboard tiles all read
 * `SECTIONS`, so they pick the new row up on their own.
 *
 * What is deliberately NOT here
 * -----------------------------
 * Money. `fees` is view-only by nature — a teacher can see what is pending in
 * the classes he was given, but recording a payment, adding a fine or sending
 * fee reminders stays in the office's admin panel, which a teacher can never
 * reach (`/admin` requires role `admin`).
 */
const db = require('../db');
const timetable = require('./timetable');   // the week generated from the office's class grids
const duties = require('./duties');          // lunch duty & extra classes (2026-09-20)

/**
 * Every teacher section, in the order the sidebar shows them.
 * `group` only groups them for the human eye; `key` is what is stored.
 */
const SECTIONS = [
  {
    key: 'students', group: 'Classes', icon: '🎓', label: 'Student list',
    hint: 'Names, roll numbers, parents and phone numbers of the classes he was given.',
  },
  {
    key: 'marks', group: 'Classes', icon: '📝', label: 'Marks / Results',
    hint: 'Type or correct exam marks and download the result sheet, class by class.',
  },
  {
    key: 'toppers', group: 'Classes', icon: '🏆', label: 'Class toppers',
    hint: 'Pick the toppers of those classes (name + percentage + photo) for the website.',
  },
  {
    key: 'timetable', group: 'Classes', icon: '🕒', label: 'Timetable',
    hint: 'The weekly timetable and today\'s periods of those classes, with period timings.',
  },
  {
    key: 'notices', group: 'School', icon: '📢', label: 'Notices',
    hint: 'Read notices for those classes and for the whole school.',
  },
  {
    key: 'messages', group: 'Parents', icon: '📬', label: 'Message parents',
    hint: 'Send one short message to every parent of the class he has picked.',
  },
  {
    key: 'fees', group: 'Parents', icon: '💰', label: 'Fees (view only)',
    hint: 'See how much fee is still pending in those classes. Money is recorded by the office only.',
  },
];

/** The keys as a plain list — the only values ever stored in the table. */
const KEYS = SECTIONS.map((s) => s.key);

/**
 * What a teacher's LOGIN NAME may look like — deliberately the SAME shape the
 * login form enforces (`validate.username`), so a name the office sets here is
 * one the teacher can actually type on the sign-in page.
 */
const LOGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/;

/** Is this a name that can be typed into /login? (teachers added with their own
 *  full name as username — as the roster import did — are NOT: no spaces.) */
function isLoginName(username) {
  return LOGIN_NAME.test(String(username == null ? '' : username).trim());
}

/** Is some other login already using this name? (`exceptUserId` = the teacher
 *  himself, so saving his own name back is not "taken".) */
function usernameTaken(username, exceptUserId = 0) {
  const row = db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?')
    .get(String(username || '').trim(), exceptUserId);
  return !!row;
}

/**
 * A free login name to offer the office for a teacher who has none (or whose
 * username is unusable). Prefers the first word of his name, then bumps a
 * number until it is free: `ajay`, `ajay2`, `ajay3`, …
 */
function suggestUsername(teacher = {}) {
  const word = String(teacher.full_name || '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = isLoginName(word) ? word : 'teacher' + (teacher.id || '');
  let name = base;
  for (let n = 2; usernameTaken(name, teacher.user_id) && n < 500; n++) name = base + n;
  return name;
}

// ---------------------------------------------------------------- class scope

/** "Class 9 A" — the label every teacher page prints. */
function classLabel(c) {
  return `${c.name}${c.section ? ' ' + c.section : ''}`;
}

/** Every class of the school, in the Classes page order. */
function allClasses() {
  return db.prepare('SELECT id, name, section FROM classes ORDER BY id').all()
    .map((c) => ({ ...c, label: classLabel(c) }));
}

/**
 * The classes a teacher may work on — the ONE list every teacher route is bound
 * by. Accepts a teacher row or a `teachers.id`.
 *
 *   all_classes = 1  → every class (new classes included)
 *   rows in teacher_class_access → exactly those
 *   nothing at all   → his own class only (how every teacher started out)
 *
 * `own` marks the class he is class-teacher of, so the picker can say so.
 */
function classesFor(teacher) {
  const t = (teacher && typeof teacher === 'object') ? teacher : teacherById(teacher);
  if (!t) return [];
  const all = allClasses().map((c) => ({ ...c, own: c.id === t.class_id }));
  if (t.all_classes) return all;
  const ticked = db.prepare('SELECT class_id FROM teacher_class_access WHERE teacher_id = ?')
    .all(t.id).map((r) => r.class_id);
  if (!ticked.length) return all.filter((c) => c.own);
  return all.filter((c) => ticked.includes(c.id));
}

/** May this teacher open/change THIS class? (a hand-typed id never gets through) */
function canClass(teacher, classId) {
  const want = parseInt(classId, 10) || 0;
  return classesFor(teacher).some((c) => c.id === want);
}

/**
 * Replace one teacher's class scope. `all` = every class; otherwise exactly
 * `classIds`; an empty `classIds` means his own class only. Ids that are not
 * real classes are dropped, never stored.
 */
function setClassScope({ teacherId, all = false, classIds = [], grantedBy = '' }) {
  const valid = new Set(allClasses().map((c) => c.id));
  const clean = [...new Set((classIds || [])
    .map((x) => parseInt(x, 10)).filter((id) => valid.has(id)))];
  db.transaction(() => {
    db.prepare('UPDATE teachers SET all_classes = ? WHERE id = ?').run(all ? 1 : 0, teacherId);
    db.prepare('DELETE FROM teacher_class_access WHERE teacher_id = ?').run(teacherId);
    const ins = db.prepare('INSERT OR IGNORE INTO teacher_class_access (teacher_id, class_id, granted_by) VALUES (?,?,?)');
    for (const id of clean) ins.run(teacherId, id, grantedBy || null);
    // the teacher is told once, on his next page, that the office changed his access
    db.prepare('UPDATE teacher_permissions SET granted_at = datetime(\'now\') WHERE teacher_id = ?').run(teacherId);
  })();
  return { all: !!all, classIds: all ? [] : clean };
}

/** Plain sentence for the admin list: "All classes", a list of names, or "own class". */
function scopeLabel(teacher) {
  const t = (teacher && typeof teacher === 'object') ? teacher : teacherById(teacher);
  if (!t) return '';
  if (t.all_classes) return 'All classes';
  const mine = classesFor(t);
  if (!mine.length) return 'No class';
  if (mine.length === 1 && mine[0].id === t.class_id) return `Own class only (${mine[0].label})`;
  return mine.map((c) => c.label + (c.id === t.class_id ? ' (own)' : '')).join(', ');
}

/** One section by key (or undefined) — used by the admin page and the tests. */
const byKey = (key) => SECTIONS.find((s) => s.key === key);

/** The sections grouped for the admin permission page: [{ group, sections: [...] }] */
function grouped() {
  const out = [];
  const byGroup = new Map();
  for (const s of SECTIONS) {
    if (!byGroup.has(s.group)) {
      const g = { group: s.group, sections: [] };
      byGroup.set(s.group, g);
      out.push(g);
    }
    byGroup.get(s.group).sections.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- reading

/** The granted section keys of one teacher, in `SECTIONS` order. */
function forTeacher(teacherId) {
  const rows = db.prepare('SELECT perm FROM teacher_permissions WHERE teacher_id = ?').all(teacherId);
  const granted = new Set(rows.map((r) => r.perm));
  return KEYS.filter((k) => granted.has(k));   // unknown/removed keys are dropped
}

/** Does this teacher hold this section? (the guard every teacher route uses) */
function has(teacherId, key) {
  if (!KEYS.includes(key)) return false;
  return !!db.prepare('SELECT 1 FROM teacher_permissions WHERE teacher_id = ? AND perm = ?').get(teacherId, key);
}

/** The granted sections as full objects, ready for the sidebar / dashboard tiles. */
function navFor(teacherId) {
  const granted = new Set(forTeacher(teacherId));
  return SECTIONS.filter((s) => granted.has(s.key));
}

/** The teacher row behind a logged-in user, with the class they belong to. */
function teacherForUser(userId) {
  return db.prepare(`
    SELECT t.*, u.username, u.full_name, u.phone AS user_phone, u.role,
           c.name class_name, c.section, c.class_teacher
    FROM teachers t
    JOIN users u ON u.id = t.user_id
    JOIN classes c ON c.id = t.class_id
    WHERE t.user_id = ?`).get(userId) || null;
}

/** One teacher by `teachers.id` (admin pages and tests). */
function teacherById(teacherId) {
  return db.prepare(`
    SELECT t.*, u.username, u.full_name, c.name class_name, c.section
    FROM teachers t
    JOIN users u ON u.id = t.user_id
    JOIN classes c ON c.id = t.class_id
    WHERE t.id = ?`).get(teacherId) || null;
}

/**
 * Every teacher with their grants — the admin "Teacher Access" list.
 * `perms` is always in `SECTIONS` order, and `count` is what the office sees.
 */
function listTeachers() {
  const rows = db.prepare(`
    SELECT t.*, u.username, u.full_name, c.name class_name, c.section
    FROM teachers t
    JOIN users u ON u.id = t.user_id
    JOIN classes c ON c.id = t.class_id
    ORDER BY c.id, t.id`).all();
  const grants = db.prepare('SELECT teacher_id, perm FROM teacher_permissions').all();
  const byTeacher = new Map();
  for (const g of grants) {
    if (!byTeacher.has(g.teacher_id)) byTeacher.set(g.teacher_id, new Set());
    byTeacher.get(g.teacher_id).add(g.perm);
  }
  return rows.map((t) => {
    const held = byTeacher.get(t.id) || new Set();
    const perms = KEYS.filter((k) => held.has(k));
    const classes = classesFor(t);
    return {
      ...t, perms, count: perms.length, sections: SECTIONS.filter((s) => held.has(s.key)),
      // which classes his login can work on (the office's class grant)
      classes, classCount: classes.length, allClasses: !!t.all_classes, scope: scopeLabel(t),
      // `loginOk` is false when his username is really his own name (spaces) —
      // then the office MUST set a login name before he can ever sign in.
      loginOk: isLoginName(t.username),
      suggested: suggestUsername(t),
    };
  });
}

/**
 * When this teacher's access was last changed ('' when nothing is granted).
 * The teacher portal compares this with what the session saw last time, so a
 * teacher is told once — on their next page — that the office changed something.
 */
function latestGrantAt(teacherId) {
  const row = db.prepare('SELECT MAX(granted_at) t FROM teacher_permissions WHERE teacher_id = ?').get(teacherId);
  return (row && row.t) || '';
}

/** "3 of 7 sections" plus the labels — used in banners and logs. */
function describe(keys = []) {
  const list = KEYS.filter((k) => keys.includes(k));
  if (!list.length) return 'No sections';
  const labels = list.map((k) => (byKey(k) || {}).label || k);
  return `${labels.length} of ${KEYS.length} sections — ${labels.join(', ')}`;
}

// ---------------------------------------------------------------- writing

/**
 * Replace one teacher's grants with exactly `keys` (unknown keys are ignored).
 * Used by Admin → Teacher Access. Records who granted it, so the office can see
 * why a section is open.
 */
function setForTeacher({ teacherId, keys = [], grantedBy = '' }) {
  const clean = KEYS.filter((k) => (keys || []).includes(k));
  const del = db.prepare('DELETE FROM teacher_permissions WHERE teacher_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO teacher_permissions (teacher_id, perm, granted_by) VALUES (?,?,?)');
  db.transaction(() => {
    del.run(teacherId);
    for (const k of clean) ins.run(teacherId, k, grantedBy || null);
  })();
  return clean;
}

/** Grant everything (the admin page's "Give all access" button). */
function grantAll(teacherId, grantedBy = '') {
  return setForTeacher({ teacherId, keys: KEYS, grantedBy });
}

/** Take everything away (the "Remove all access" button). */
function revokeAll(teacherId) {
  return setForTeacher({ teacherId, keys: [], grantedBy: '' });
}

/**
 * Everything the teacher's own “My Profile” cards print — computed in ONE place, because the
 * same cards are shown twice: on `/teacher/profile` and as the first block of his dashboard
 * (`views/partials/teacher_profile_cards.ejs`). Two views, one set of facts.
 *
 * Takes the teacher row `teacherForUser()` returns (it carries `username`, `full_name`,
 * `class_name` and `section`), and adds:
 *   `initials`  — the fallback circle when the office has not added a photo,
 *   `myCls`     — the class he is class-teacher of, as every other page labels it. It is NOT
 *                 called `cls`: a page that already has its own `cls` (the dashboard's “class
 *                 being looked at”) must not be shadowed by this spread,
 *   `classes` / `scope` — the classes his login may work on (the office's grant),
 *   `accessible` / `allSections` / `permCount` / `permTotal` — the portal sections, open or
 *   closed, and `permChangedAt` — when the office last touched that access.
 */
function profileFor(teacher) {
  const t = teacher;
  const accessible = navFor(t.id);
  const classes = classesFor(t);
  // the school's messages this teacher has not opened yet — the 🔔 on his hero card
  // (2026-09-19). A message the OFFICE or a colleague sent to his class lands as
  // `direction = 'to_parent'`, unread, for every parent of that class; the teacher reads
  // the same list on /teacher/messages, so the bell counts the same rows.
  const classIds = classes.map((c) => c.id);
  const teacherUnread = classIds.length
    ? db.prepare(`
        SELECT COUNT(DISTINCT m.parent_user_id) c
        FROM messages m
        JOIN students s ON s.parent_user_id = m.parent_user_id
        WHERE m.direction = 'to_parent' AND m.status = 'unread'
          AND s.class_id IN (${classIds.map(() => '?').join(',')})`).get(...classIds).c
    : 0;
  // the week generated from the office's class timetables (2026-09-19) — every period
  // carrying his name on any granted class's grid, plus his lunch duty and extra classes
  // (2026-09-20), the rest FREE (leisure)
  const myDuties = duties.forTeacher(t.full_name);
  const myWeek = timetable.forTeacher({ classIds, fullName: t.full_name }, myDuties.rows);
  // the homework already written for the periods of those classes (day → period → note)
  // — the same rows the parents' timetable reads, so his card and their cards agree
  const hw = require('./homework');
  const myWeekHomework = {};
  for (const cls of classes) {
    const week = hw.forWeek(cls.id);
    for (const dayName of Object.keys(week)) {
      myWeekHomework[dayName] = Object.assign(myWeekHomework[dayName] || {}, week[dayName]);
    }
  }
  return {
    teacherUnread,
    myWeek,
    hwWeekFor: myWeekHomework,
    initials: String(t.full_name || '').split(' ')
      .filter((w) => !/^(mrs|mr|ms|dr|smt|shri)\.?$/i.test(w))
      .map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
    myCls: { label: classLabel({ name: t.class_name, section: t.section }), name: t.class_name, section: t.section },
    classes,
    scope: scopeLabel(t),
    accessible,
    allSections: SECTIONS,
    permCount: accessible.length,
    permTotal: KEYS.length,
    permChangedAt: latestGrantAt(t.id),
  };
}

/**
 * The office switching a teacher's login off/on. Off also means any open session
 * dies on the next click (the teacher guard re-reads this row every request).
 */
function setLogin({ teacherId, canLogin }) {
  db.prepare('UPDATE teachers SET can_login = ? WHERE id = ?').run(canLogin ? 1 : 0, teacherId);
  return canLogin ? 1 : 0;
}

/** Keep the readable copy of the password the office hands out (admin pages only). */
function setPortalPassword({ teacherId, password }) {
  db.prepare('UPDATE teachers SET portal_password = ? WHERE id = ?').run(password || null, teacherId);
}

/**
 * Give a teacher the login name the office chose (it IS `users.username`, the
 * one the sign-in page looks up). Refuses a name that a login form would not
 * accept and one that another account already holds, so the office is told
 * instead of silently breaking the teacher's sign-in.
 */
function setUsername({ teacherId, username }) {
  const teacher = db.prepare('SELECT id, user_id FROM teachers WHERE id = ?').get(teacherId);
  if (!teacher) return { ok: false, error: 'Teacher not found.' };
  const name = String(username == null ? '' : username).trim();
  if (!isLoginName(name)) {
    return { ok: false, error: 'A login name should be 3–40 characters using letters, digits, dot, dash or underscore (no spaces).' };
  }
  if (usernameTaken(name, teacher.user_id)) {
    return { ok: false, error: `The login name “${name}” is already taken — please choose another.` };
  }
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, teacher.user_id);
  return { ok: true, username: name };
}

module.exports = {
  SECTIONS, KEYS, byKey, grouped,
  classLabel, allClasses, classesFor, canClass, setClassScope, scopeLabel,
  forTeacher, has, navFor, describe, latestGrantAt, profileFor,
  teacherForUser, teacherById, listTeachers,
  setForTeacher, grantAll, revokeAll, setLogin, setPortalPassword, setUsername,
  isLoginName, usernameTaken, suggestUsername,
};
