/**
 * Notification service.
 *
 * Every notification is:
 *   1. Stored in the `notifications` table  -> visible in the admin Inbox
 *   2. Appended to data/mail_log.txt         -> readable even with no SMTP
 *   3. Emailed to the school if SMTP is configured (see README / env vars)
 *
 * `origin` says WHO caused the row, and it is not decoration: the office's notification dock
 * (services/office_feed.js + public/js/admin-alerts.js) rings for anything that ARRIVED for the
 * school and ignores what the school itself produced — otherwise the office would hear its own
 * bell every time it replied to a parent.
 *
 *   'visitor'  the public website — a contact-form message, an admission application
 *   'parent'   a parent's own message from their app
 *   'office'   the school's own action (a reply, an approval) — never rings
 *   'system'   unattributed; also every row written before this column existed (quiet)
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');

const MAIL_LOG = path.join(__dirname, '..', '..', 'data', 'mail_log.txt');

function notify(kind, title, body, origin = 'system') {
  db.prepare('INSERT INTO notifications (kind, title, body, origin) VALUES (?,?,?,?)')
    .run(kind, title, body, origin);
  fs.mkdirSync(path.dirname(MAIL_LOG), { recursive: true });
  fs.appendFileSync(MAIL_LOG, `[${new Date().toISOString()}] ${title}\n${body}\n${'-'.repeat(70)}\n`);
}

async function emailSchool(subject, text, origin = 'system') {
  notify('email', subject, text, origin);
  // Real email only if SMTP is configured
  if (process.env.SMTP_HOST) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || config.schoolEmail,
        to: process.env.SCHOOL_EMAIL || config.schoolEmail,
        subject: `[${config.schoolName}] ${subject}`,
        text,
      });
      fs.appendFileSync(MAIL_LOG, `SMTP: email sent to ${config.schoolEmail}\n`);
      return true;
    } catch (err) {
      fs.appendFileSync(MAIL_LOG, `SMTP ERROR: ${err.message}\n`);
      return false;
    }
  }
  fs.appendFileSync(MAIL_LOG, `SMTP not configured — email logged locally. Set SMTP_HOST, SMTP_USER, SMTP_PASS to send real mail.\n`);
  return false;
}

module.exports = { notify, emailSchool };