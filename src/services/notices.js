/**
 * ============================================================================
 * notices.js — EVERY notice that reaches a parent also reaches a teacher
 * ----------------------------------------------------------------------------
 * The school's rule (2026-09-19): a notice is for the school, so whatever a
 * parent sees on the parent portal, a teacher sees the same. One filter lives
 * here and every reader uses it:
 *
 *     audience = 'all'      → all-school notices only          (the website)
 *     audience = 'class'    → school notices + that class's     (parent portal,
 *                                                                teacher portal)
 *
 * If the office later posts a notice meant only for teachers, it hides itself
 * from parents automatically — the audience filter here is the only gate.
 * ============================================================================
 */
const db = require('../db');
const time = require('./time');

/** How long a notice wears its bright "New" tag — one week, matching the parent portal. */
const NOTICE_NEW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The one filter, written once:
 *   - `audience === 'class'` adds "…or just that class" to every all-school notice.
 *   - notices addressed to teachers alone (`audience = 'teachers'`) are never in a
 *     parent's list — the WHERE clause refuses them in both flavours.
 */
const AUDIENCE_WHERE = {
  all: `n.audience = 'all'`,
  class: `n.audience = 'all' AND (n.target_class_id IS NULL OR n.target_class_id = ?)`,
};

/** Stamp `isNew` — the bright flag a parent already knows from the portal. */
function withFresh(rows) {
  const now = Date.now();
  return rows.map((n) => {
    const at = time.toDate(n.created_at);
    const age = at ? now - at.getTime() : Infinity;
    return { ...n, isNew: age >= 0 && age <= NOTICE_NEW_MS };
  });
}

/** All-school notices — the public website's ticker and home page. */
function forAll(limit = null) {
  const rows = db.prepare(`
    SELECT n.*, c.name AS class_name FROM notices n
    LEFT JOIN classes c ON c.id = n.target_class_id
    WHERE ${AUDIENCE_WHERE.all}
    ORDER BY n.created_at DESC ${limit ? 'LIMIT ' + limit : ''}`).all();
  return withFresh(rows);
}

/**
 * What one class reads: every school notice + the ones addressed to that class.
 * The parent portal and the teacher portal call this with the same id, so the
 * two lists are always the same list.
 */
function forClass(classId) {
  const rows = db.prepare(`
    SELECT n.*, c.name AS class_name FROM notices n
    LEFT JOIN classes c ON c.id = n.target_class_id
    WHERE ${AUDIENCE_WHERE.class}
    ORDER BY n.created_at DESC`).all(classId);
  return withFresh(rows);
}

/**
 * What a teacher reads on the full notices page: everything a parent reads
 * PLUS the staff-only memos the office posts. Parents never see the second half.
 */
function forStaff(classId) {
  const rows = db.prepare(`
    SELECT n.*, c.name AS class_name FROM notices n
    LEFT JOIN classes c ON c.id = n.target_class_id
    WHERE (n.audience = 'all' AND (n.target_class_id IS NULL OR n.target_class_id = ?))
       OR n.audience = 'teachers'
    ORDER BY n.created_at DESC`).all(classId);
  return withFresh(rows);
}

module.exports = { forAll, forClass, forStaff, NOTICE_NEW_MS };
