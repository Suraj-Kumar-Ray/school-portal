/**
 * Parent <-> school structured messaging.
 * Every parent query is a "thread" (root message) that can carry replies.
 * School broadcasts (PTM invites, updates) are standalone to_parent messages.
 */
const db = require('../db');
const config = require('../config');
const { emailSchool } = require('./notify');

const CATEGORIES = ['Fee', 'Performance', 'Timetable', 'Notice', 'PTM', 'General'];

// ---- parent side ----
// parent-initiated conversations (roots) with reply + unread counts
function getParentThreads(parentUserId) {
  return db.prepare(`
    SELECT m.*, s.full_name child_name, c.name AS class_name, c.section,
           (SELECT COUNT(*) FROM messages r WHERE r.thread_id = m.id AND r.direction = 'to_parent' AND r.status = 'unread') AS unread_replies
    FROM messages m
    LEFT JOIN students s ON s.id = m.student_id
    LEFT JOIN classes c ON c.id = s.class_id
    WHERE m.parent_user_id = ? AND m.thread_id IS NULL AND m.direction = 'to_school'
    ORDER BY m.created_at DESC`).all(parentUserId);
}

// one full conversation (root + all replies)
function getThread(threadId, parentUserId) {
  const root = db.prepare(`
    SELECT m.*, s.full_name child_name, c.name AS class_name, c.section
    FROM messages m LEFT JOIN students s ON s.id = m.student_id LEFT JOIN classes c ON c.id = s.class_id
    WHERE m.id = ? AND m.parent_user_id = ?`).get(threadId, parentUserId);
  if (!root) return null;
  const replies = db.prepare(`
    SELECT m.*, u.full_name author_name FROM messages m
    LEFT JOIN users u ON u.id = m.parent_user_id
    WHERE m.id = ? OR m.thread_id = ? ORDER BY m.created_at`).all(threadId, threadId);
  return { root, replies };
}

// school broadcasts / replies visible to the parent
function getSchoolMessages(parentUserId) {
  return db.prepare(`
    SELECT m.* FROM messages m
    WHERE m.parent_user_id = ? AND m.direction = 'to_parent' AND m.thread_id IS NULL
    ORDER BY m.created_at DESC`).all(parentUserId);
}

// ids of the school messages that are still unread — the inbox page grabs these
// BEFORE it marks everything read, so the parent can still see which ones are new
function getUnreadSchoolMessageIds(parentUserId) {
  return db.prepare(`SELECT id FROM messages WHERE parent_user_id = ? AND direction = 'to_parent' AND status = 'unread'`)
    .all(parentUserId).map(r => r.id);
}

/**
 * The few things a parent's inbox CARD shows, read out of the message itself.
 *
 * The office writes these bodies as plain text (see `notifyFeesDue` above), so the headline
 * amount and the one-line preview have to be read out of that text. It happens HERE and only
 * here, so every card agrees and a view never parses a body.
 *
 * The amount is picked in the order a parent would: the message's own “Total balance :
 * Rs.19,745” is what they must pay, the subject's bracket (“Fee pending · 3 months
 * (Rs.19,325)”) is the next best thing (it can differ — the body adds the school store), and
 * the first Rs. figure in the body is the last resort. A plain notice has no amount at all,
 * and then the card simply shows none. Together with the amount the card is told what it MEANS
 * (`tone`: `due` · `paid` · `plain`), because the same ₹ figure has to look like a bill in one
 * message and like a receipt in the next.
 *
 * `preview` is the first four lines (greeting and signature dropped) and `full` is the message
 * exactly as the school wrote it — whatever the button shows must be whole, never a tail.
 */
function cardOf(m) {
  const body = String((m && m.body) || '').replace(/\r/g, '');
  const subject = String((m && m.subject) || '');

  const total = /Total balance\s*:\s*Rs\.?\s*([\d,]+)/i.exec(body);
  // the subject can carry it inside brackets (“Fee pending · 6 months (Rs.12,000)”) or loose
  // (“Payment not found · Rs.600 (Aarav Sharma)”) — both shapes are in use, so try both
  const inSubject = /\(Rs\.?\s*([\d,]+)\)/i.exec(subject) || /Rs\.?\s*([\d,]+)/i.exec(subject);
  const inBody = /Rs\.?\s*([\d,]+)/i.exec(body);
  const money = total || inSubject || inBody;

  // What the money in this message MEANS, so the chip is never misleading: a payment the
  // school received is good news (green), money the family still owes is the one thing they
  // must notice (red), and anything else is just a figure (grey). Without this a “Payment
  // received” card would shout a red figure at a parent who has just paid.
  const tone = !money ? ''
    : (/received|paid|recorded|thank you/i.test(subject) ? 'paid'
      : ((total || /pending|due|not found|fine|balance|arrear/i.test(subject)) ? 'due' : 'plain'));
  const amountLabel = tone === 'paid' ? 'Received'
    : (tone === 'due' ? (total ? 'Total to pay' : 'Amount due') : 'Amount');

  // drop the greeting and the school's signature: they say nothing a card needs, and a
  // preview that starts with “Dear parent,” wastes its one line
  const lines = body.split('\n').map((s) => s.trim()).filter((s) => s
    && !/^dear\b/i.test(s) && !/^[-\u2013\u2014]\s/.test(s) && !/^if you have already paid/i.test(s));
  // A card shows the first FOUR lines, so most messages are read whole without a tap, and
  // long ones still end on a sensible line instead of a tall card (school's request,
  // 2026-09-17: “show four lines, that reads better”).
  const PREVIEW_LINES = 4;
  const previewLines = [];
  let taken = 0;
  for (const line of lines) {
    if (previewLines.length >= PREVIEW_LINES || taken >= 320) break;
    previewLines.push(line);
    taken += line.length + 1;
  }
  let preview = previewLines.join('\n');
  let cut = false;
  if (preview.length > 320) {
    preview = preview.slice(0, 320).replace(/\s+\S*$/, '');
    cut = true;
  }

  // Nothing is ever half-shown. The button opens the message WHOLE — from “Dear parent,” to the
  // school's signature — because revealing only the leftover lines dropped a parent into a
  // mid-sentence fragment (“Nov 2026 — Rs.2,000”) that looked like a glitch (school's request,
  // 2026-09-17). The four lines above are a preview of it, not a replacement for it.
  return {
    amount: money ? money[1] : '',
    amountLabel: money ? amountLabel : '',
    tone,
    preview,
    full: body.trim(),
    hasMore: cut || lines.length > previewLines.length,
  };
}

function markParentMessagesRead(parentUserId) {
  db.prepare(`UPDATE messages SET status = 'read' WHERE parent_user_id = ? AND direction = 'to_parent'`).run(parentUserId);
}

/**
 * ONE message the parent has just SEEN (school's request, 2026-09-21).
 *
 * “The bell on the home page should show a number when something arrives, and it must go back
 * to 0 once the parent has seen it — the number must not keep growing.” Until this existed the
 * ONLY way a badge ever cleared was opening the inbox page (`markParentMessagesRead` above): a
 * parent who had clearly read the pop-up card the app itself put on their screen still left the
 * badge lit, and every new message added one more. So the card's own **✓ Seen** button calls
 * this with that one message, and the row is read from that moment.
 *
 * Guards, in this order: the id is the PARENT's own row (`parent_user_id = ?` — a hand-typed id
 * can never touch another family's mail) and it must be a `to_parent` message. Returns the
 * parent's remaining unread count, so the caller can repaint the badge from the truth instead
 * of guessing.
 */
function markSchoolMessageRead(parentUserId, messageId) {
  if (!parentUserId || !messageId) return null;
  const mine = db.prepare(`SELECT 1 FROM messages
    WHERE id = ? AND parent_user_id = ? AND direction = 'to_parent'`).get(messageId, parentUserId);
  if (!mine) return null;                       // not his mail — nothing is touched
  db.prepare(`UPDATE messages SET status = 'read' WHERE id = ? AND status <> 'read'`).run(messageId);
  return parentUnreadCount(parentUserId);
}

function parentUnreadCount(parentUserId) {
  return db.prepare(`SELECT COUNT(*) c FROM messages WHERE parent_user_id = ? AND direction = 'to_parent' AND status = 'unread'`).get(parentUserId).c;
}

// parent sends a new query (creates a thread) or replies to one
async function sendFromParent({ parentUserId, studentId, category, subject, body, threadId }) {
  const info = db.prepare(`
    INSERT INTO messages (thread_id, parent_user_id, student_id, direction, category, subject, body, status)
    VALUES (?,?,?, 'to_school', ?,?,?, 'unread')`)
    .run(threadId || null, parentUserId, studentId || null, category, subject, body);

  const parent = db.prepare('SELECT full_name, phone FROM users WHERE id = ?').get(parentUserId);
  const child = studentId
    ? db.prepare(`SELECT s.full_name, c.name class_name FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(studentId)
    : null;

  await emailSchool(
    `New message from parent: ${parent.full_name}${child ? ` (about ${child.full_name})` : ''}`,
    `A parent sent a structured message.\n\n` +
    `Parent   : ${parent.full_name} (${parent.phone})\n` +
    `About    : ${child ? `${child.full_name} (${child.class_name})` : 'General / no specific child'}\n` +
    `Category : ${category}\n` +
    `Subject  : ${subject}\n` +
    `Message  : ${body}\n\n` +
    `Reply from the admin panel → Messages.`,
    'parent'                       // a parent wrote it — it must ring the office's dock
  );
  return info.lastInsertRowid;
}

// ---- admin side ----
// all parent queries (roots), newest first
function getAdminConversations(category) {
  const where = category && CATEGORIES.includes(category) ? 'AND m.category = ?' : '';
  return db.prepare(`
    SELECT m.*, s.full_name child_name, c.name AS class_name, c.section, u.full_name parent_name, u.phone parent_phone,
           (SELECT COUNT(*) FROM messages r WHERE r.thread_id = m.id AND r.direction = 'to_school') AS parent_replies,
           (SELECT COUNT(*) FROM messages r WHERE r.thread_id = m.id AND r.direction = 'to_parent') AS school_replies
    FROM messages m
    LEFT JOIN students s ON s.id = m.student_id
    LEFT JOIN classes c ON c.id = s.class_id
    LEFT JOIN users u ON u.id = m.parent_user_id
    WHERE m.direction = 'to_school' AND m.thread_id IS NULL ${where}
    ORDER BY m.created_at DESC`).all(...(category && CATEGORIES.includes(category) ? [category] : []));
}

// Every reply in the given parent queries, oldest first, with the author's name.
// The admin list uses this so the office can read what the parent actually wrote
// instead of only seeing a count of messages.
function getAdminThreads(conversations) {
  const ids = (conversations || []).map(c => c.id);
  if (!ids.length) return (conversations || []).map(c => ({ ...c, thread: [] }));
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT m.*, u.full_name author_name
    FROM messages m LEFT JOIN users u ON u.id = m.parent_user_id
    WHERE m.thread_id IN (${marks})
    ORDER BY m.created_at, m.id`).all(...ids);
  const byRoot = new Map();
  for (const r of rows) {
    if (!byRoot.has(r.thread_id)) byRoot.set(r.thread_id, []);
    byRoot.get(r.thread_id).push(r);
  }
  return (conversations || []).map(c => ({ ...c, thread: byRoot.get(c.id) || [] }));
}

// Parent replies the office has not opened yet. Read this BEFORE
// markAdminMessagesRead(), exactly like the parent inbox does, so the admin page
// can still flag "new from parent" on the render that clears them.
function getNewParentReplyIds() {
  return db.prepare(`SELECT id FROM messages
                     WHERE direction = 'to_school' AND thread_id IS NOT NULL AND status = 'unread'`)
    .all().map(r => r.id);
}

function adminUnreadCount() {
  return db.prepare(`SELECT COUNT(*) c FROM messages WHERE direction = 'to_school' AND status = 'unread'`).get().c;
}

function markAdminMessagesRead() {
  db.prepare(`UPDATE messages SET status = 'read' WHERE direction = 'to_school' AND status = 'unread'`).run();
}

// admin replies to a parent thread
async function replyToThread({ threadId, adminName, body }) {
  const root = db.prepare('SELECT * FROM messages WHERE id = ?').get(threadId);
  if (!root) throw new Error('Thread not found');
  db.prepare(`
    INSERT INTO messages (thread_id, parent_user_id, student_id, direction, category, subject, body, status)
    VALUES (?,?,?, 'to_parent', ?, ?, ?, 'unread')`)
    .run(threadId, root.parent_user_id, root.student_id, root.category, `Re: ${root.subject}`, body);

  await emailSchool(
    `Reply sent to parent (${root.parent_user_id})`,
    `Replied by ${adminName} to thread "${root.subject}" about ${root.student_id || 'general'}.\nReply: ${body}`,
    'office'                       // the school's own reply — it must NOT ring its own dock
  );
}

// ---- system notifications (one parent, no email to the office) ----
// Used when the portal itself has news for a parent — e.g. a fee month was
// marked paid at the office. It lands in the parent's inbox (Message School)
// with the unread badge, exactly like a school broadcast.
function notifyParent({ parentUserId, category = 'General', subject, body }) {
  if (!parentUserId || !subject || !body) return 0;
  db.prepare(`
    INSERT INTO messages (thread_id, parent_user_id, student_id, direction, category, subject, body, status)
    VALUES (NULL, ?, NULL, 'to_parent', ?, ?, ?, 'unread')`)
    .run(parentUserId, category, subject, body);
  return 1;
}

// "your April 2026 fee is paid" — one notification per save, listing every month
function notifyFeePaid({ parentUserId, student, months }) {
  if (!parentUserId || !months || !months.length) return 0;
  const total = months.reduce((a, m) => a + (Number(m.amount) || 0), 0);
  const list = months.map(m => m.term).join(', ');
  const who = student && student.full_name
    ? `${student.full_name}${student.class_name ? ` (${student.class_name}${student.section ? ' ' + student.section : ''})` : ''}`
    : 'your child';
  const subject = months.length === 1
    ? `Fee paid · ${list}`
    : `${months.length} fee months paid · ${list}`;
  const body =
    `Thank you! We have received Rs.${Math.round(total).toLocaleString('en-IN')} for ${who}.\n\n` +
    `Month${months.length === 1 ? '' : 's'} marked paid: ${list}.\n` +
    `The updated month-by-month ledger is available under Fees in your parent portal.\n\n` +
    `— ${config.schoolName}`;
  return notifyParent({ parentUserId, category: 'Fee', subject, body });
}

// “the school has checked the payment you told us about” — a claim the office recorded.
// Lists the months the money went to and what is still pending, so the parent can see the
// same arithmetic the office sees.
function notifyClaimRecorded({ parentUserId, student, claim, receipts, balance }) {
  if (!parentUserId || !claim) return 0;
  const who = student && student.full_name
    ? `${student.full_name}${student.class_name ? ` (${student.class_name}${student.section ? ' ' + student.section : ''})` : ''}`
    : 'your child';
  const got = Math.round(Number(claim.amount) || 0).toLocaleString('en-IN');
  const left = Math.round(Number(balance) || 0).toLocaleString('en-IN');
  const lines = (receipts || [])
    .map(r => `${r.term} — Rs.${Math.round(Number(r.amount) || 0).toLocaleString('en-IN')}`)
    .join('\n');
  const settled = (Number(balance) || 0) <= 0;
  return notifyParent({
    parentUserId,
    category: 'Fee',
    subject: `Payment received · Rs.${got} (${who})`,
    body:
      `We have checked the payment you told us about — thank you.\n\n` +
      `Received : Rs.${got}${claim.reference ? ` (reference ${claim.reference})` : ''}\n` +
      (lines ? `Put in   :\n${lines}\n\n` : '\n') +
      (settled
        ? `Balance  : Nil — nothing is pending for this session.\n\nThank you!\n\n`
        : `Balance  : Rs.${left} still to pay.\n\n`) +
      `The month-by-month record is under Fees in your parent portal.\n\n— ${config.schoolName}`,
  });
}

// “we could not find that payment” — the office rejected a claim, with their reason.
function notifyClaimRejected({ parentUserId, student, claim, note = '' }) {
  if (!parentUserId || !claim) return 0;
  const who = student && student.full_name
    ? `${student.full_name}${student.class_name ? ` (${student.class_name}${student.section ? ' ' + student.section : ''})` : ''}`
    : 'your child';
  const got = Math.round(Number(claim.amount) || 0).toLocaleString('en-IN');
  return notifyParent({
    parentUserId,
    category: 'Fee',
    subject: `Payment not found · Rs.${got} (${who})`,
    body:
      `We could not see a payment of Rs.${got}${claim.reference ? ` (reference ${claim.reference})` : ''} ` +
      `for ${who} on our side.\n\n` +
      (note ? `Office note : ${note}\n\n` : '') +
      `Please check the transaction in your UPI / bank app. If the money left your account, ` +
      `send us the screenshot from this app (Message School) or show it at the school office.\n\n` +
      `— ${config.schoolName}`,
  });
}

// money received — works for a part payment too, and always states what is left
// "Received Rs.500 for September 2026. Balance Rs.800. Thank you."
function notifyFeePayment({ parentUserId, student, month, amount, paidAmount, payable, balance, fine }) {
  if (!parentUserId || !month) return 0;
  const who = student && student.full_name
    ? `${student.full_name}${student.class_name ? ` (${student.class_name}${student.section ? ' ' + student.section : ''})` : ''}`
    : 'your child';
  const got = Math.round(Number(amount) || 0).toLocaleString('en-IN');
  const left = Math.round(Number(balance) || 0).toLocaleString('en-IN');
  const paidSoFar = Math.round(Number(paidAmount) || 0).toLocaleString('en-IN');
  const total = Math.round(Number(payable) || 0).toLocaleString('en-IN');
  const settled = (Number(balance) || 0) <= 0;

  const subject = settled
    ? `Fee paid · ${month.term}`
    : `Part payment received · ${month.term} — Rs.${left} left`;
  const body =
    `We have received Rs.${got} for ${who} — ${month.term}.\n\n` +
    `Fee for the month : Rs.${total}${Number(fine) > 0 ? ` (includes fine Rs.${Math.round(Number(fine)).toLocaleString('en-IN')})` : ''}\n` +
    `Paid so far       : Rs.${paidSoFar}\n` +
    (settled
      ? `Balance           : Nil — this month is fully paid.\n\nThank you!\n\n`
      : `Balance           : Rs.${left}\n\nThe remaining amount can be paid at the school office.\n\n`) +
    // A hostel month is the school fee PLUS the hostel fee (mess & lodging), and the receipt says
    // what is left on each — the one thing a boarding family checks after every payment.
    (Number(month.hostelCharge) > 0
      ? `School fee        : Rs.${Math.round(Number(month.schoolCharge) || 0).toLocaleString('en-IN')} — `
        + `${Number(month.schoolBalance) > 0 ? 'Rs.' + Math.round(Number(month.schoolBalance)).toLocaleString('en-IN') + ' left' : 'paid'}\n`
        + `Hostel fee        : Rs.${Math.round(Number(month.hostelCharge) || 0).toLocaleString('en-IN')} — `
        + `${Number(month.hostelBalance) > 0 ? 'Rs.' + Math.round(Number(month.hostelBalance)).toLocaleString('en-IN') + ' left' : 'paid'}\n\n`
      : '') +
    `— ${config.schoolName}`;
  return notifyParent({ parentUserId, category: 'Fee', subject, body });
}

// a late fine was added by the office to one month
function notifyFine({ parentUserId, student, month, fine, note, balance }) {
  if (!parentUserId || !month || !(Number(fine) > 0)) return 0;
  const who = student && student.full_name
    ? `${student.full_name}${student.class_name ? ` (${student.class_name}${student.section ? ' ' + student.section : ''})` : ''}`
    : 'your child';
  const subject = `Late fee fine added · ${month.term}`;
  const body =
    `A late payment fine of Rs.${Math.round(Number(fine)).toLocaleString('en-IN')} has been added to ` +
    `${who} for ${month.term}.\n\n` +
    (note ? `Reason : ${note}\n\n` : '') +
    `Total for the month : Rs.${Math.round(Number(month.payable) || 0).toLocaleString('en-IN')}\n` +
    (Number(balance) > 0
      ? `Still to pay : Rs.${Math.round(Number(balance)).toLocaleString('en-IN')}\n\nPlease pay at the school office to avoid further delay.\n\n`
      : `This month is fully paid.\n\n`) +
    `— ${config.schoolName}`;
  return notifyParent({ parentUserId, category: 'Fee', subject, body });
}

// the one-click reminder: one portal message per student with an outstanding month
//
// A HOSTEL student's family is not paying for the school month only — the amount
// covers his mess and his lodging too (the hostel column of the fee sheet, see
// `stay.js`). So the message names the hostel part instead of letting the parent
// wonder why a boarder's bill is higher. The answer comes from the months
// themselves, each of which already carries the rate it was priced at (`m.rate`,
// set by `fees.js`) — there is no second opinion and nothing to pass in.
function notifyFeesDue({ parentUserId, student, months, total, fine, items }) {
  const monthsList = months || [];
  const itemsDue = Math.round(Number((items && items.balance) || 0));
  // A child can owe ONLY for books (his months are all paid) — that family still gets one
  // message, so this needs either a month or an item balance.
  if (!parentUserId || (!monthsList.length && itemsDue <= 0)) return 0;
  const who = student && student.full_name
    ? `${student.full_name}${student.class_name ? ` (${student.class_name}${student.section ? ' ' + student.section : ''})` : ''}`
    : 'your child';
  // ---- the TWO bills on one month (2026-09-16) ----------------------------------------------
  // A hostel student's month is the school fee plus the hostel fee (mess & lodging), and many
  // families clear one of them and not the other. So the reminder names BOTH, per month and in
  // total — a parent who has paid the school fee is never asked for it again. Every figure is
  // read from the month's own split (`fees.splitMonth`), never re-added here.
  const schoolDue = monthsList.reduce((a, m) => a + (Number(m.schoolBalance) || 0), 0);
  const hostelDue = monthsList.reduce((a, m) => a + (Number(m.hostelBalance) || 0), 0);
  const hostelMonths = monthsList.filter(m => Number(m.hostelCharge) > 0);
  const list = monthsList.map(m =>
    `${m.term} — Rs.${Math.round(m.balance).toLocaleString('en-IN')}`
    + (Number(m.hostelCharge) > 0
      ? ` (school fee Rs.${Math.round(m.schoolBalance).toLocaleString('en-IN')}`
        + ` + hostel fee Rs.${Math.round(m.hostelBalance).toLocaleString('en-IN')})`
      : '')
    + `${m.overdue ? ' (past the due date)' : ''}`).join('\n');
  const pendingItems = itemsDue > 0 ? items.items.filter((r) => r.balance > 0) : [];
  const subject = monthsList.length === 1
    ? `Fee pending · ${monthsList[0].term}`
    : (monthsList.length
      ? `Fee pending · ${monthsList.length} months (Rs.${Math.round(Number(total) || 0).toLocaleString('en-IN')})`
      : `Books and uniform pending · Rs.${itemsDue.toLocaleString('en-IN')}`);
  const body =
    `Dear parent,\n\nOur records show fees are still pending for ${who}.\n\n` +
    (monthsList.length ? `${list}\n\n` : '') +
    // the items BY NAME, so the parent can check the parcel before paying
    (pendingItems.length
      ? `From the school store:\n${pendingItems.map(r => `${r.name}${r.qty > 1 ? ` x ${r.qty}` : ''} (given ${r.issued_on}) — Rs.${Math.round(r.balance).toLocaleString('en-IN')}`).join('\n')}\n\n`
      : '') +
    (hostelMonths.length
      ? (schoolDue > 0 && hostelDue > 0
        ? `Of this, Rs.${Math.round(schoolDue).toLocaleString('en-IN')} is the school fee and `
          + `Rs.${Math.round(hostelDue).toLocaleString('en-IN')} the hostel fee (mess & lodging, `
          + `for ${hostelMonths.length} month${hostelMonths.length > 1 ? 's' : ''}).\n\n`
        : (hostelDue > 0
          ? `Of this, Rs.${Math.round(hostelDue).toLocaleString('en-IN')} is the hostel fee (mess & lodging, for `
            + `${hostelMonths.length} month${hostelMonths.length > 1 ? 's' : ''}) — your child's school fee is fully paid.\n\n`
          : `Of this, Rs.${Math.round(schoolDue).toLocaleString('en-IN')} is the school fee — the hostel fee `
            + `(mess & lodging) is fully paid.\n\n`))
      : '') +
    (Number(fine) > 0 ? `This includes a late fine of Rs.${Math.round(Number(fine)).toLocaleString('en-IN')}.\n\n` : '') +
    // books, uniform and stationery taken from the school store (2026-09-16). They are the same
    // family's money, so ONE message asks for both — `services/store.js` keeps them in their own
    // ledger (a book set is taken once, a fee month is monthly) and the totals are added here.
    (itemsDue > 0
      ? `Books and uniform from the school : Rs.${itemsDue.toLocaleString('en-IN')}`
        + ` (${pendingItems.length} item(s) not paid yet)\n\n`
      : '') +
    `Total balance : Rs.${(Math.round(Number(total) || 0) + itemsDue).toLocaleString('en-IN')}\n\n` +
    `Please pay at the school office, or tap “💳 Pay now” in this app to pay by UPI / bank transfer.\n\n` +
    `If you have already paid, kindly ignore this message.\n\n` +
    `— ${config.schoolName}`;
  return notifyParent({ parentUserId, category: 'Fee', subject, body });
}

// admin sends a broadcast message (all parents / class parents / one parent)
async function sendToParents({ targets, adminName, category, subject, body }) {
  const insert = db.prepare(`
    INSERT INTO messages (thread_id, parent_user_id, student_id, direction, category, subject, body, status)
    VALUES (NULL, ?, NULL, 'to_parent', ?, ?, ?, 'unread')`);
  const txn = db.transaction(() => {
    for (const pid of targets) insert.run(pid, category, subject, body);
  });
  txn();
  await emailSchool(
    `Message sent to ${targets.length} parent(s)`,
    `Sent by ${adminName} | Category: ${category}\nSubject: ${subject}\n${body}`,
    'office'
  );
  return targets.length;
}

function getAllParentIds() {
  return db.prepare(`SELECT id FROM users WHERE role = 'parent'`).all().map(r => r.id);
}
function getParentIdsForClass(classId) {
  return db.prepare(`SELECT DISTINCT parent_user_id id FROM students WHERE class_id = ? AND parent_user_id IS NOT NULL`).all(classId).map(r => r.id);
}
function getParentName(id) {
  return db.prepare('SELECT full_name, phone FROM users WHERE id = ?').get(id);
}

module.exports = {
  CATEGORIES,
  getParentThreads, getThread, getSchoolMessages, cardOf, getUnreadSchoolMessageIds, markParentMessagesRead,
  markSchoolMessageRead, parentUnreadCount,
  sendFromParent, getAdminConversations, getAdminThreads, getNewParentReplyIds,
  adminUnreadCount, markAdminMessagesRead,
  replyToThread, sendToParents, getAllParentIds, getParentIdsForClass, getParentName,
  notifyParent, notifyFeePaid, notifyFeePayment, notifyFine, notifyFeesDue,
  notifyClaimRecorded, notifyClaimRejected,
};