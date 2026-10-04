/**
 * ============================================================================
 * staff_messages.js — the OFFICE's messages to teachers
 * ============================================================================
 *
 * The school's rule (2026-09-20): a teacher's Messages tab shows what the office sent
 * him, and **only the office may write to a teacher** — nobody else, not a colleague,
 * not a parent. That rule is structural here: nothing in this file can be reached from
 * the teacher's own routes (they only read), and the single writer is the office's
 * Admin → Messages page.
 *
 * The teacher portal's two tabs are split by WHO the letter is for:
 *
 *   📢 Notices  — the school's notices (plus the “teachers only” memos), the same list
 *                 a parent reads. `services/notices.js` is the one filter.
 *   📨 Messages — THIS table: a letter the office addressed to him personally.
 *
 * One row per teacher, not one row per letter: the same message sent to the whole staff
 * is written once for each of them, so one teacher marking it read never clears another
 * teacher's badge.
 */
const db = require('../db');

/**
 * The categories the office picks from. Deliberately about a TEACHER's day (a duty, an
 * exam, a meeting) rather than the parents' list — the two desks say different things.
 */
const CATEGORIES = ['General', 'Class work', 'Duty', 'Exam', 'Meeting', 'Holiday', 'Urgent'];

/** The little sign in front of a card — the office never types it. */
function iconFor(category) {
  switch (category) {
    case 'Duty': return '🍱';
    case 'Class work': return '📚';
    case 'Exam': return '📝';
    case 'Meeting': return '👥';
    case 'Holiday': return '🎉';
    case 'Urgent': return '⚠️';
    default: return '🏫';
  }
}

/**
 * Write one message for each of the given teacher logins (`users.id`).
 *
 * Duplicates are dropped, blank ids and a blank subject/body write nothing, and the
 * whole fan-out is one transaction: either every teacher on the list has the letter or
 * none does — a half-sent staff message would leave the office guessing.
 */
function send({ teacherUserIds, category = 'General', subject, body, sentBy = '' }) {
  const ids = [...new Set((teacherUserIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const title = String(subject || '').trim();
  const text = String(body || '').trim();
  if (!ids.length || !title || !text) return 0;
  const cat = CATEGORIES.includes(category) ? category : 'General';
  const ins = db.prepare(`
    INSERT INTO staff_messages (teacher_user_id, category, subject, body, sent_by)
    VALUES (?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const id of ids) ins.run(id, cat, title, text, String(sentBy || ''));
  })();
  return ids.length;
}

/** A teacher's own inbox, newest first. Blank for a login that is not a teacher. */
function inboxFor(teacherUserId, limit = 40) {
  if (!teacherUserId) return [];
  return db.prepare(`
    SELECT * FROM staff_messages WHERE teacher_user_id = ?
    ORDER BY id DESC LIMIT ?`).all(teacherUserId, limit);
}

/** How many letters are still waiting for him — the badge on his Messages tab. */
function unreadCount(teacherUserId) {
  if (!teacherUserId) return 0;
  return db.prepare(`SELECT COUNT(*) c FROM staff_messages WHERE teacher_user_id = ? AND status = 'unread'`)
    .get(teacherUserId).c;
}

/**
 * He has opened the tab, so the letters are read. Called AFTER the count is taken, so
 * the render that clears the badge can still say “2 new”.
 */
function markRead(teacherUserId) {
  if (!teacherUserId) return 0;
  return db.prepare(`UPDATE staff_messages SET status = 'read' WHERE teacher_user_id = ? AND status = 'unread'`)
    .run(teacherUserId).changes;
}

/**
 * Every teacher login the office can address — the recipient pick list, with his class
 * so the office can tell two teachers of the same name apart.
 */
function recipients() {
  return db.prepare(`
    SELECT t.id AS teacher_id, t.user_id, t.can_login, u.full_name AS name,
           c.name AS class_name, c.section
    FROM teachers t
    JOIN users u ON u.id = t.user_id
    JOIN classes c ON c.id = t.class_id
    ORDER BY u.full_name`).all();
}

/** One teacher login by `teachers.id` — how the office's pick list is stored back. */
function userIdOfTeacher(teacherId) {
  const row = db.prepare('SELECT user_id FROM teachers WHERE id = ?').get(teacherId);
  return row ? row.user_id : null;
}

module.exports = { CATEGORIES, iconFor, send, inboxFor, unreadCount, markRead, recipients, userIdOfTeacher };
