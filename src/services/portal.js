const db = require('../db');
const time = require('./time');
const notices = require('./notices');   // the one notices filter — parents AND teachers read it

const EXAM_ORDER = ['Term 1', 'Term 2', 'Term 3'];

function getStudentProfile(studentId) {
  return db.prepare(`
    SELECT s.*, c.name AS class_name, c.section, c.class_teacher
    FROM students s
    JOIN classes c ON c.id = s.class_id
    WHERE s.id = ?`).get(studentId);
}

// ---- who teaches this class --------------------------------------------
// "Mrs. / Mr. / Dr." and punctuation are ignored when comparing names, so the
// office can write the class teacher as "Mrs. Suman Kumari" in one place and
// "Suman Kumari" in another and it is still the same person.
function normaliseName(value) {
  return String(value || '')
    .replace(/\b(mrs|mr|ms|miss|dr|smt|shri|sri)\.?\b/gi, ' ')
    .replace(/[^a-z ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function initialsOf(fullName) {
  return String(fullName || '')
    .split(' ')
    .filter((w) => w && !/^(mrs|mr|ms|miss|dr|smt|shri|sri)\.?$/i.test(w))
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/**
 * The class teacher of a class, in the same shape a teacher profile card needs
 * (photo, qualification, experience, rating) — the details the school already
 * maintains in Admin → Teachers and publishes on the website.
 *
 * Which teacher, in order of preference:
 *   1. the one whose name matches `classes.class_teacher` (the office's own entry)
 *   2. a teacher for that class with no subject — i.e. a class teacher
 *   3. any teacher for that class (best rated first)
 *   4. only a name is known → a card with the name and no profile details
 *   5. nothing at all → null, and the view simply shows no card
 */
function getClassTeacher(classId) {
  const cls = db.prepare('SELECT id, name, section, class_teacher FROM classes WHERE id = ?').get(classId);
  const rows = db.prepare(`
    SELECT t.id, t.photo, t.subject, t.qualification, t.experience_years, t.rating, t.bio,
           u.full_name, c.name AS class_name, c.section
    FROM teachers t
    JOIN users u ON u.id = t.user_id
    JOIN classes c ON c.id = t.class_id
    WHERE t.class_id = ?`).all(classId);

  const byRating = (a, b) => (b.rating || 0) - (a.rating || 0) || a.id - b.id;
  const wanted = normaliseName(cls && cls.class_teacher);
  const pick = (wanted && rows.find((r) => normaliseName(r.full_name) === wanted))
    || rows.filter((r) => !r.subject).sort(byRating)[0]
    || rows.slice().sort(byRating)[0]
    || null;

  const classLabel = cls ? `${cls.name}${cls.section ? ' ' + cls.section : ''}` : '';

  if (pick) {
    return {
      name: String(pick.full_name).trim(),
      initial: initialsOf(pick.full_name),
      role: pick.subject ? `${String(pick.subject).trim()} Teacher` : 'Class Teacher',
      photo: pick.photo || null,
      qualification: pick.qualification || '',
      experience_years: pick.experience_years || 0,
      rating: Number(pick.rating) || 0,
      bio: pick.bio || '',
      classLabel,
      hasProfile: true,
    };
  }
  if (cls && cls.class_teacher) {
    return {
      name: String(cls.class_teacher).trim(),
      initial: initialsOf(cls.class_teacher),
      role: 'Class Teacher',
      photo: null,
      qualification: '',
      experience_years: 0,
      rating: 0,
      bio: '',
      classLabel,
      hasProfile: false,
    };
  }
  return null;
}

// [{ subject, term1, term2, term3, avg }]
function getMarksBySubject(studentId) {
  const rows = db.prepare(`
    SELECT su.name AS subject, e.term, m.marks_obtained, m.max_marks
    FROM marks m
    JOIN subjects su ON su.id = m.subject_id
    JOIN exams e ON e.id = m.exam_id
    WHERE m.student_id = ?
    ORDER BY su.name, e.id`).all(studentId);

  const bySubject = {};
  for (const r of rows) {
    if (!bySubject[r.subject]) bySubject[r.subject] = { subject: r.subject };
    bySubject[r.subject][r.term] = { obtained: r.marks_obtained, max: r.max_marks };
  }
  const result = [];
  for (const key of Object.keys(bySubject)) {
    const s = bySubject[key];
    const values = EXAM_ORDER.filter(t => s[t]).map(t => (s[t].obtained / s[t].max) * 100);
    s.avg = values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : 0;   // EXACT at one decimal — no whole-number round-off (2026-09-19)
    result.push(s);
  }
  return result;
}

function getClassNotices(classId) {
  // ONE filter for the whole app (services/notices.js): every notice a parent sees
  // is `audience = 'all'` and addressed to the school or to this class. The teacher
  // portal reads the very same function's twin, so both lists never drift apart.
  return notices.forClass(classId);
}

function getTimetable(classId) {
  return db.prepare(`
    SELECT day, period, subject, teacher FROM timetable
    WHERE class_id = ? ORDER BY day, period`).all(classId);
}

function getFees(studentId) {
  return db.prepare(`
    SELECT * FROM fees WHERE student_id = ? ORDER BY term`).all(studentId);
}

// results officially published for a class (parent notification source)
function getPublishedResults(classId) {
  return db.prepare(`
    SELECT pr.*, e.term, e.year FROM published_results pr
    JOIN exams e ON e.id = pr.exam_id
    WHERE pr.class_id = ? ORDER BY pr.published_at DESC`).all(classId);
}

// newest published result within the alert window (days)
function getNewResultAlert(classId, days = 21) {
  const row = db.prepare(`
    SELECT pr.*, e.term, e.year FROM published_results pr
    JOIN exams e ON e.id = pr.exam_id
    WHERE pr.class_id = ? ORDER BY pr.published_at DESC LIMIT 1`).get(classId);
  if (!row) return null;
  const published = new Date(row.published_at + 'Z');
  const ageDays = (Date.now() - published.getTime()) / 86400000;
  return ageDays <= days ? row : null;
}

// NOTE: there is deliberately NO second “overall average” helper here. A child's average
// and grade are worked out in ONE place — src/services/analysis.js (`forStudent`) — which
// counts a written paper and its oral as one subject, the way a report card does. Anything
// that needs the average (the parent's dashboard, the Result page) reads that service, so
// the ring diagram and the numbers beside it can never tell two different stories.

module.exports = {
  EXAM_ORDER,
  getStudentProfile,
  getClassTeacher,
  getMarksBySubject,
  getClassNotices,
  getTimetable,
  getFees,
  getPublishedResults,
  getNewResultAlert,
};