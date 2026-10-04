/**
 * ============================================================================
 * office_feed.js — everything that has ARRIVED for the school office
 * ============================================================================
 *
 * The office should never have to open four pages to find out whether anybody is
 * waiting for them. This is the ONE reader of “what came in since I last looked?”,
 * and the dock in the corner of every office page (`public/js/admin-alerts.js`) is
 * only a window onto it.
 *
 * Four things count as an arrival — everything a parent or a visitor sends the
 * school, and nothing the school sends itself:
 *
 *   1. `messages`      a parent's new message, or their reply in a conversation
 *                      the office has not opened yet (`status = 'unread'`)
 *   2. `fee_claims`    a parent says they have paid and the office has to check it
 *   3. `admissions`    an application still waiting to be approved or rejected
 *   4. `notifications` the website inbox — a contact-form message, a parent's
 *                      first login … but NOT the mail the office itself generated.
 *                      That is what `notifications.origin` is for (see
 *                      `src/services/notify.js`): without it, the office's own
 *                      reply to a parent would ring the office's own bell.
 *
 * Every item carries a STABLE `key` (`claim:12`, `message:88`, …). The dock compares
 * those keys against the ones it has already announced on this computer, so the same
 * arrival is never rung twice — and an item that disappears (a claim was recorded, a
 * reply was read) simply leaves the list, which is exactly how it should read: the
 * list IS the office's to-do, and the count is honest at all times.
 *
 * `openCounts()` is small enough to render on a page; `items()` is what the dock asks
 * for every 20 seconds. Nothing here writes anything.
 */
const db = require('../db');
const config = require('../config');
const time = require('./time');

/** How many rows each source may contribute (an old backlog must not flood the dock). */
const PER_SOURCE = 12;

function money(n) {
  return `${config.currency}${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
}

/** One line of a message body, short enough for the dock. */
function preview(text, max = 120) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** `Class 10 A` — the child's class as every other screen prints it. */
function klass(name, section) {
  return [name, section].filter(Boolean).join(' ').trim();
}

/* ============================================================================
   1. Parent messages and replies the office has not opened
   ============================================================================ */
function messageItems() {
  return db.prepare(`
    SELECT m.id, m.subject, m.body, m.category, m.thread_id, m.created_at,
           u.full_name AS parent_name, u.phone AS parent_phone,
           s.full_name AS child_name, c.name AS class_name, c.section
    FROM messages m
    LEFT JOIN users u ON u.id = m.parent_user_id
    LEFT JOIN students s ON s.id = m.student_id
    LEFT JOIN classes c ON c.id = s.class_id
    WHERE m.direction = 'to_school' AND m.status = 'unread'
    ORDER BY m.id DESC LIMIT ?`).all(PER_SOURCE).map((r) => ({
    key: `message:${r.id}`,
    kind: 'message',
    icon: '📬',
    label: r.thread_id ? 'Reply from a parent' : 'New parent message',
    title: r.subject,
    body: [
      r.parent_name || 'A parent',
      r.child_name ? `about ${r.child_name}${klass(r.class_name, r.section) ? ` (${klass(r.class_name, r.section)})` : ''}` : '',
      preview(r.body),
    ].filter(Boolean).join(' · '),
    href: '/admin/messages',
    at: r.created_at,
  }));
}

/* ============================================================================
   2. Fee claims — “I have paid”, waiting for the office to check
   ============================================================================ */
function claimItems() {
  return db.prepare(`
    SELECT c.id, c.amount, c.mode, c.reference, c.paid_on, c.created_at,
           s.full_name AS child_name, cl.name AS class_name, cl.section,
           u.full_name AS parent_name
    FROM fee_claims c
    JOIN students s ON s.id = c.student_id
    JOIN classes cl ON cl.id = s.class_id
    LEFT JOIN users u ON u.id = c.parent_user_id
    WHERE c.status = 'pending'
    ORDER BY c.id DESC LIMIT ?`).all(PER_SOURCE).map((r) => ({
    key: `claim:${r.id}`,
    kind: 'claim',
    icon: '💳',
    label: 'Payment claim',
    title: `${money(r.amount)} payment claim`,
    body: [
      `${r.parent_name || 'A parent'} says they paid by ${r.mode}`,
      r.reference ? `ref ${r.reference}` : '',
      `for ${r.child_name}${klass(r.class_name, r.section) ? ` (${klass(r.class_name, r.section)})` : ''}`,
    ].filter(Boolean).join(' · '),
    href: '/admin/fees#claims',
    at: r.created_at,
  }));
}

/* ============================================================================
   3. Admission applications waiting for a decision
   ============================================================================ */
function admissionItems() {
  return db.prepare(`
    SELECT a.id, a.application_no, a.child_name, a.parent_name, a.parent_phone,
           a.submitted_at, c.name AS class_name, c.section
    FROM admissions a
    JOIN classes c ON c.id = a.class_id
    WHERE a.status = 'Pending'
    ORDER BY a.id DESC LIMIT ?`).all(PER_SOURCE).map((r) => ({
    key: `admission:${r.id}`,
    kind: 'admission',
    icon: '📋',
    label: 'Admission application',
    title: `Application ${r.application_no}`,
    body: [
      `${r.child_name} for ${klass(r.class_name, r.section) || 'the school'}`,
      `${r.parent_name}${r.parent_phone ? ` · ${r.parent_phone}` : ''}`,
    ].filter(Boolean).join(' · '),
    href: '/admin/admissions',
    at: r.submitted_at,
  }));
}

/* ============================================================================
   4. The website inbox (contact form, a parent's first login …)
   ============================================================================ */
// `origin` keeps the office's own mail out of its own bell. Rows written before the
// column existed default to 'system', and anything the office caused is 'office'.
function inboxItems() {
  return db.prepare(`
    SELECT id, kind, title, body, created_at
    FROM notifications
    WHERE read = 0 AND origin <> 'office'
    ORDER BY id DESC LIMIT ?`).all(PER_SOURCE).map((r) => ({
    key: `note:${r.id}`,
    kind: 'inbox',
    icon: r.kind === 'login' ? '🔑' : '✉️',
    label: r.kind === 'login' ? 'Login notice' : 'Website message',
    title: r.title,
    body: preview(r.body),
    href: '/admin/inbox',
    at: r.created_at,
  }));
}

/* ============================================================================
   The feed
   ============================================================================ */

/**
 * Everything waiting for the office, newest first, each with the key the dock
 * remembers. `limit` caps the whole list — the dock scrolls, so it is never a
 * wall of text.
 */
function items({ limit = 40 } = {}) {
  const all = [...messageItems(), ...claimItems(), ...admissionItems(), ...inboxItems()];
  all.sort((a, b) => {
    const da = time.toDate(a.at);
    const db_ = time.toDate(b.at);
    return (db_ ? db_.getTime() : 0) - (da ? da.getTime() : 0);
  });
  return all.slice(0, limit);
}

/** The four kinds, named once — so a count can never be summed twice by accident. */
const COUNT_KINDS = ['message', 'claim', 'admission', 'inbox'];

/**
 * How many of each kind are waiting, plus the total — the dock's badge.
 * Read live on every office page (`res.locals.officeOpen`, src/app.js) so the number the
 * office sees is never a cached guess.
 */
function openCounts() {
  const one = (sql) => db.prepare(sql).get().c;
  const counts = {
    message: one("SELECT COUNT(*) c FROM messages WHERE direction = 'to_school' AND status = 'unread'"),
    claim: one("SELECT COUNT(*) c FROM fee_claims WHERE status = 'pending'"),
    admission: one("SELECT COUNT(*) c FROM admissions WHERE status = 'Pending'"),
    inbox: one("SELECT COUNT(*) c FROM notifications WHERE read = 0 AND origin <> 'office'"),
  };
  counts.total = COUNT_KINDS.reduce((n, k) => n + counts[k], 0);
  return counts;
}

/** The shape the dock polls: the counts (always live) plus the list itself. */
function feed({ limit = 40 } = {}) {
  const counts = openCounts();
  const list = items({ limit });
  return {
    ok: true,
    total: counts.total,
    counts,
    items: list,
    // `total` counts everything waiting; `items` may be capped for the dock
    more: Math.max(0, counts.total - list.length),
  };
}

module.exports = { items, openCounts, feed, PER_SOURCE };
