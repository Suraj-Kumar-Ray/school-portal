/**
 * SMS / WhatsApp alert service.
 *
 * Every alert is:
 *   1. Stored in the `alert_log` table          -> visible in the admin "Alerts" page
 *   2. Appended to data/alerts_log.txt          -> readable even with no gateway
 *   3. Actually delivered IF a gateway is configured:
 *        SMS      -> Fast2SMS  (env: SMS_API_KEY)
 *        WhatsApp -> generic provider webhook  (env: WHATSAPP_API_URL + WHATSAPP_API_KEY)
 *
 * Without a gateway the row is kept with status 'demo' so the school can
 * review exactly what WOULD be sent, then enable delivery later.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const db = require('../db');
const config = require('../config');
const time = require('./time');

const ALERT_LOG = path.join(__dirname, '..', '..', 'data', 'alerts_log.txt');

const EVENTS = {
  RESULT: 'result_published',
  FEE: 'fee_due',
  FEE_PAID: 'fee_paid',
  NOTICE: 'notice',
  EXAM: 'exam_sheet',          // the exam date-sheet went out (2026-09-15)
  HOLIDAY: 'holiday',          // a holiday was declared (2026-09-17)
  SYSTEM: 'system',
};

function smsEnabled() { return !!(process.env.SMS_API_KEY); }
function waEnabled() { return !!(process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_KEY); }
// channels that should actually be delivered (falls back to demo sms)
function channels() {
  const c = [];
  if (smsEnabled()) c.push('sms');
  if (waEnabled()) c.push('whatsapp');
  return c.length ? c : ['sms'];
}

function ascii(s) { return s.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim(); }

async function deliver(phone, message, channel) {
  if (!phone) return 'demo';
  try {
    if (channel === 'sms' && smsEnabled()) {
      // Fast2SMS bulk API (India) — route=qt keeps it simple
      const url = 'https://www.fast2sms.com/dev/bulkV2' +
        `?authorization=${encodeURIComponent(process.env.SMS_API_KEY)}` +
        `&route=qt&numbers=${encodeURIComponent(phone)}` +
        `&message=${encodeURIComponent(ascii(message).slice(0, 300))}`;
      await new Promise((resolve) => {
        https.get(url, (r) => { r.resume(); r.on('end', resolve); }).on('error', () => resolve());
      });
      return 'sent';
    }
    if (channel === 'whatsapp' && waEnabled()) {
      const body = JSON.stringify({
        phone: phone.startsWith('+') ? phone : `+91${phone}`,
        message: ascii(message).slice(0, 1000),
        apiKey: process.env.WHATSAPP_API_KEY,
      });
      await new Promise((resolve) => {
        const req = https.request(process.env.WHATSAPP_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (r) => { r.resume(); r.on('end', resolve); });
        req.on('error', () => resolve());
        req.write(body);
        req.end();
      });
      return 'sent';
    }
  } catch (err) { /* never break the portal because of a gateway */ }
  return 'demo';
}

function logRow(row) {
  db.prepare(`INSERT INTO alert_log
    (parent_user_id, parent_name, child_name, child_class, phone, channel, event, message, status)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(row.parentUserId, row.name, row.child || null, row.klass || null,
      row.phone || null, row.channel, row.event, row.message, row.status);
  fs.mkdirSync(path.dirname(ALERT_LOG), { recursive: true });
  fs.appendFileSync(ALERT_LOG,
    `[${new Date().toISOString()}] ${row.channel.toUpperCase()} (${row.status}) → ${row.name}${row.phone ? ' ' + row.phone : ''}${row.child ? ' — ' + row.child + (row.klass ? ' (' + row.klass + ')' : '') : ''}\n${row.message}\n${'-'.repeat(70)}\n`);
}

// Send one alert to a list of recipients. Each recipient: { parentUserId, name, phone, child?, klass? }.
async function send({ recipients, event, message, toChildren }) {
  if (!recipients || !recipients.length) return 0;
  const chs = channels();
  let count = 0;
  for (const r of recipients) {
    for (const ch of chs) {
      const body = message(r);
      const status = await deliver(r.phone, body, ch);
      logRow({ ...r, child: toChildren ? r.child : null, klass: toChildren ? r.klass : null, channel: ch, event, message: body, status });
      count++;
    }
  }
  return count;
}

// ---------- helpers to build recipient lists ----------

// every parent who has at least one admitted child
function allParentsWithChildren() {
  return db.prepare(`
    SELECT u.id parentUserId, u.full_name name, u.phone,
      (SELECT GROUP_CONCAT(s.full_name || ' (' || TRIM(c.name || ' ' || c.section) || ')', ', ')
       FROM students s JOIN classes c ON c.id = s.class_id WHERE s.parent_user_id = u.id) children
    FROM users u
    WHERE u.role = 'parent'
      AND EXISTS (SELECT 1 FROM students s WHERE s.parent_user_id = u.id)
    ORDER BY u.full_name`).all();
}

// parents (per child) for one specific class — used for result & class notices
function parentsForClass(classId) {
  return db.prepare(`
    SELECT u.id parentUserId, u.full_name name, u.phone,
           s.full_name child, TRIM(c.name || ' ' || c.section) klass
    FROM students s
    JOIN classes c ON c.id = s.class_id
    JOIN users u ON u.id = s.parent_user_id
    WHERE s.class_id = ? AND s.parent_user_id IS NOT NULL
    ORDER BY u.full_name`).all(classId);
}

// parents with unpaid, overdue fee months (per child) — used by the fee-reminder action
// "Due" now means a real balance: what is left after part payments, plus any fine.
// The school's day (IST) decides what is past its due date, not UTC.
function parentsWithOverdueFees() {
  return db.prepare(`
    SELECT u.id parentUserId, u.full_name name, u.phone,
           s.full_name child, TRIM(c.name || ' ' || c.section) klass,
           COUNT(*) unpaidMonths,
           COALESCE(SUM(f.amount + f.fine - f.paid_amount), 0) totalDue,
           MIN(date(substr(f.due_date,7,4) || '-' || substr(f.due_date,4,2) || '-' || substr(f.due_date,1,2))) firstDue
    FROM fees f
    JOIN students s ON s.id = f.student_id
    JOIN classes c ON c.id = s.class_id
    JOIN users u ON u.id = s.parent_user_id
    WHERE f.paid = 0 AND s.parent_user_id IS NOT NULL
      AND (f.amount + f.fine - f.paid_amount) > 0
      AND date(substr(f.due_date,7,4) || '-' || substr(f.due_date,4,2) || '-' || substr(f.due_date,1,2)) <= date(?)
    GROUP BY s.id
    ORDER BY u.full_name`).all(time.todayISO());
}

// ---------- event senders ----------

// Result published for a class -> alert the parents of that class
async function resultPublished({ classId, examId, examLabel, className }) {
  const recipients = parentsForClass(classId).map(r => ({
    ...r,
    child: r.child, klass: r.klass,
  }));
  return send({
    recipients, event: EVENTS.RESULT, toChildren: true,
    message: (r) => `📢 Result published: ${examLabel} for ${className || r.klass}. ${r.child}'s result is ready. Log in to the Parent Portal for full marks and the report card. — ${config.schoolName}, ${config.schoolPhone}`,
  });
}

// New notice posted -> alert the right parents (all or one class)
async function noticePosted({ title, body, classId, className }) {
  const recipients = classId
    ? parentsForClass(classId)
    : allParentsWithChildren().map(r => ({ parentUserId: r.parentUserId, name: r.name, phone: r.phone }));
  const shortBody = (body || '').slice(0, 120);
  return send({
    recipients, event: EVENTS.NOTICE, toChildren: !!classId,
    message: () => `📢 New notice${className ? ' for ' + className : ''}: ${title}. ${shortBody}${shortBody ? '' : ''} Open the Parent Portal for the full notice and details. — ${config.schoolName}, ${config.schoolPhone}`,
  });
}

// Fee reminder -> alert parents who have unpaid overdue months.
// The caller may pass the recipient list (the fee service's own dues list) so the
// reminder can never disagree with what the Fees page shows.
// A HOSTEL student's reminder names the TWO bills — the school fee and the hostel fee (mess &
// lodging) — so a boarder's parent is never handed a bill that is bigger than the school month
// with no explanation, and never has to guess which of the two is unpaid. `schoolDue` and
// `hostelDue` arrive with the recipient list, computed by `fees.dues()` from the same months the
// parent's own fee page shows.
async function feeReminders(recipients) {
  if (!recipients) recipients = parentsWithOverdueFees();
  const split = (r) => {
    const school = Math.round(Number(r.schoolDue) || 0);
    const hostel = Math.round(Number(r.hostelDue) || 0);
    if (!school && !hostel) return '';
    if (hostel && school) return ` (school fee ${config.currency}${school.toLocaleString('en-IN')} + hostel fee ${config.currency}${hostel.toLocaleString('en-IN')})`;
    if (hostel) return ` (this is the hostel fee — the school fee is clear)`;
    return ` (this is the school fee — the hostel fee is clear)`;
  };
  return send({
    recipients, event: EVENTS.FEE, toChildren: true,
    message: (r) => `💳 Fee reminder: ${r.child} (${r.klass}) — ${r.unpaidMonths} month(s) unpaid, total ${config.currency}${Math.round(r.totalDue).toLocaleString('en-IN')}`
      + split(r)
      + (Number(r.itemsDue) > 0
        ? ` Plus ${config.currency}${Math.round(r.itemsDue).toLocaleString('en-IN')} for books/uniform from the school store.`
        : '')
      + `. Please pay at the school office by the 10th. — ${config.schoolName}, ${config.schoolPhone}`,
  });
}

// Fee received -> thank the parent (one alert per save, listing the months paid).
// When money is still left on those months the alert says so, so a part payment
// does not read like a settled bill.
async function feePaid({ recipients, months, total, balance = 0 }) {
  if (!recipients || !recipients.length || !months || !months.length) return 0;
  const list = months.map(m => m.term).join(', ');
  const left = Math.round(Number(balance) || 0);
  return send({
    recipients, event: EVENTS.FEE_PAID, toChildren: true,
    message: (r) => `✅ Fee received: ${config.currency}${Math.round(total).toLocaleString('en-IN')} for ${r.child} (${r.klass}) — ${list} marked paid.`
      + (left > 0 ? ` Balance still due: ${config.currency}${left.toLocaleString('en-IN')}.` : '')
      + ` Thank you! — ${config.schoolName}, ${config.schoolPhone}`,
  });
}

/**
 * Exam date-sheet released → tell the parents. Per class when a class id is given
 * (the child's own first paper is named), otherwise every parent of the school.
 * The date-sheet itself was already sent to the portal by messages.sendToParents —
 * this is the SMS/WhatsApp half, and it is logged in the Alert log either way.
 */
async function examSheet({ classId = null, label = 'Exam', first = '', last = '' }) {
  const recipients = classId
    ? parentsForClass(classId)
    : allParentsWithChildren().map(r => ({ parentUserId: r.parentUserId, name: r.name, phone: r.phone }));
  return send({
    recipients, event: EVENTS.EXAM, toChildren: !!classId,
    message: (r) => `📝 ${label} exam time table is out`
      + (first ? `: first paper on ${first}` : '')
      + (last && last !== first ? `, last on ${last}` : '')
      + `. Full date-sheet: Parent Portal → Timetable. — ${config.schoolName}, ${config.schoolPhone}`,
  });
}

/**
 * A holiday declared → tell every parent of the school.
 * The portal message was already sent by messages.sendToParents — this is the
 * SMS/WhatsApp half, and it is logged in the Alert log either way. It names the day the
 * school opens again, which is the only thing a working parent has to arrange.
 */
async function holidayDeclared({ name, dateLong = '', opensOn = '' }) {
  const recipients = allParentsWithChildren()
    .map(r => ({ parentUserId: r.parentUserId, name: r.name, phone: r.phone }));
  return send({
    recipients, event: EVENTS.HOLIDAY, toChildren: false,
    message: () => `🎉 ${name}: the school stays closed${dateLong ? ' on ' + dateLong : ''}`
      + (opensOn ? `. Opens again on ${opensOn}` : '')
      + `. — ${config.schoolName}, ${config.schoolPhone}`,
  });
}

module.exports = { EVENTS, send, resultPublished, noticePosted, feeReminders, feePaid, examSheet, holidayDeclared, smsEnabled, waEnabled, channels };
