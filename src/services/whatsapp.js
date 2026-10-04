/**
 * WhatsApp sending service (admission alerts).
 *
 * Tries to deliver for real, in this order:
 *   1. Generic provider webhook        (env: WHATSAPP_API_URL + WHATSAPP_API_KEY)
 *      — works with WATI / Interakt / AiSensy / Meta Cloud API bridges etc.
 *   2. CallMeBot free API              (env: CALLMEBOT_API_KEY)
 *      — FREE option: the school's own WhatsApp number receives the message
 *        automatically. One-time setup: from the school's WhatsApp, send
 *        "I allow callmebot to send me messages" to +34 644 51 95 23,
 *        then note the apikey it replies with and put it in .env as
 *        CALLMEBOT_API_KEY=... (CALLMEBOT_PHONE = the school WhatsApp number).
 *   3. No gateway configured -> status 'demo'
 *      — the message is still logged (admin Inbox + data/alerts_log.txt) and
 *        the public page offers a one-tap "send on WhatsApp" fallback.
 */
const https = require('https');
const http = require('http');
const db = require('../db');
const config = require('../config');
const time = require('./time');

function ascii(s) { return String(s).replace(/[^\x20-\x7E\n]/g, ' ').replace(/[ \t]+/g, ' ').trim(); }

function schoolWhatsappDigits() {
  const wa = (config.schoolPhones || []).find(p => p.whatsapp);
  const num = (wa && (wa.number || wa)) || config.schoolPhone || '';
  const digits = String(num).replace(/\D/g, '');
  return digits.length === 10 ? '91' + digits : digits;
}

// SAFETY during the testing phase: while config.testWhatsappNumber is set,
// EVERY WhatsApp message (including the parent confirmation) is delivered to
// that number only — no outside number can ever receive a message by mistake.
// Remove testWhatsappNumber from src/config.js when going live.
function safetyDigits(intendedDigits) {
  const test = String(config.testWhatsappNumber || '').replace(/\D/g, '');
  if (test) return test.length === 10 ? '91' + test : test;
  return intendedDigits;
}

function post(urlString, body) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlString);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => {
        r.resume(); r.on('end', () => resolve(true));
      });
      req.on('error', () => resolve(false));
      req.write(body); req.end();
    } catch (e) { resolve(false); }
  });
}

function get(urlString) {
  return new Promise((resolve) => {
    try {
      const lib = urlString.startsWith('http:') ? http : https;
      lib.get(urlString, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode >= 200 && r.statusCode < 300)); })
        .on('error', () => resolve(false));
    } catch (e) { resolve(false); }
  });
}

// deliver one message; returns 'sent' | 'demo'
async function deliver(phoneDigits, message) {
  if (!phoneDigits || !message) return 'demo';
  const text = ascii(message);
  try {
    if (process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_KEY) {
      const body = JSON.stringify({
        phone: phoneDigits.startsWith('91') && phoneDigits.length === 12 ? '+' + phoneDigits : '+91' + phoneDigits,
        message: text.slice(0, 1000),
        apiKey: process.env.WHATSAPP_API_KEY,
      });
      const ok = await post(process.env.WHATSAPP_API_URL, body);
      return ok ? 'sent' : 'demo';
    }
    if (process.env.CALLMEBOT_API_KEY) {
      const to = process.env.CALLMEBOT_PHONE
        ? String(process.env.CALLMEBOT_PHONE).replace(/\D/g, '')
        : phoneDigits;
      const url = `https://api.callmebot.com/whatsapp.php?phone=%2B${to}&text=${encodeURIComponent(text.slice(0, 900))}&apikey=${encodeURIComponent(process.env.CALLMEBOT_API_KEY)}`;
      const ok = await get(url);
      return ok ? 'sent' : 'demo';
    }
  } catch (e) { /* never break the form because of a gateway */ }
  return 'demo';
}

function log(kind, title, body, phone, status, origin = 'system') {
  try {
    db.prepare('INSERT INTO notifications (kind, title, body, origin) VALUES (?,?,?,?)')
      .run(kind, title, body, origin);
  } catch (e) { /* db may not be ready in rare cases */ }
  try {
    const fs = require('fs');
    const path = require('path');
    const logFile = path.join(__dirname, '..', '..', 'data', 'whatsapp_log.txt');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] WhatsApp (${status}) -> ${phone || '-'}\n${body}\n${'-'.repeat(70)}\n`);
  } catch (e) { /* ignore */ }
}

// ---------- public API ----------

// parent gets: application no + status link + thank-you
async function admissionConfirmation(app) {
  const intended = String(app.parentPhone || '').replace(/\D/g, '');
  const digits = safetyDigits(intended); // testing phase: redirected to the school's test number
  const msg =
    `🎓 ${config.schoolName}\n\n` +
    `Thank you for choosing ${config.schoolName}!\n\n` +
    `Your admission application has been received.\n` +
    `Application No: ${app.applicationNo}\n` +
    `Child: ${app.childName}\n` +
    `Class: ${app.className}\n\n` +
    `Check your status anytime: ${app.statusUrl}\n\n` +
    `Our team will soon contact you on this number. — ${config.schoolName}, ${config.schoolPhone}`;
  const status = await deliver(digits, msg);
  // 'visitor' → a family applied through the website; that is news for the office, not noise
  // it made itself. See `src/services/office_feed.js`.
  log('whatsapp', `WhatsApp to parent: ${app.parentName} (${app.parentPhone})`, msg, app.parentPhone, status, 'visitor');
  return status;
}

// school WhatsApp gets the full form details
async function admissionToSchool(app) {
  const msg =
    `📢 NEW ADMISSION APPLICATION\n\n` +
    `Application No : ${app.applicationNo}\n` +
    `Child          : ${app.childName}${app.childDob ? ' (DOB: ' + app.childDob + ')' : ''}\n` +
    `Class applied  : ${app.className}\n` +
    `Parent         : ${app.parentName}\n` +
    `Phone          : ${app.parentPhone}\n` +
    `Email          : ${app.parentEmail || '—'}\n` +
    `Address        : ${app.address || '—'}\n` +
    `Previous school: ${app.previousSchool || '—'}\n` +
    `Submitted      : ${time.fmtFullIST()}\n\n` +
    `Review: Admin panel -> Admissions`;
  const to = safetyDigits(schoolWhatsappDigits());
  const status = await deliver(to, msg);
  log('whatsapp', `WhatsApp to school: new application ${app.applicationNo}`, msg, to, status, 'visitor');
  return status;
}

// click-to-chat fallback used by the public page (works with zero setup):
// opens the school's WhatsApp chat with the full details pre-filled
function clickToChatUrl(app) {
  // the full application form as filled by the parent — nothing is left out
  const msg =
    `📢 NEW ADMISSION APPLICATION\n` +
    `Application No: ${app.applicationNo}\n` +
    `Child: ${app.childName}` +
    (app.childDob ? `\nDate of birth: ${app.childDob}` : '') +
    `\nClass applied: ${app.className}\n` +
    `Parent/Guardian: ${app.parentName}\n` +
    `Phone: ${app.parentPhone}` +
    (app.parentEmail ? `\nEmail: ${app.parentEmail}` : '') +
    (app.address ? `\nAddress: ${app.address}` : '') +
    (app.previousSchool ? `\nPrevious school: ${app.previousSchool}` : '') +
    (app.statusUrl ? `\n\nSubmitted: ${time.fmtFullIST()}\nStatus: ${app.statusUrl}` : '');
  return `https://wa.me/${safetyDigits(schoolWhatsappDigits())}?text=${encodeURIComponent(msg)}`;
}

module.exports = { admissionConfirmation, admissionToSchool, clickToChatUrl, schoolWhatsappDigits, safetyDigits };
