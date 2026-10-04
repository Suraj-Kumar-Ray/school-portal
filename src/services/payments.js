/**
 * ============================================================================
 * payments.js — HOW A PARENT PAYS THE SCHOOL
 * ============================================================================
 *
 * The parent's Fees page can tell a family exactly how much is pending — this file
 * tells them **where to send it**: the UPI id, the bank account, the QR image and
 * the sentence that says what to do after paying.
 *
 * Everything here is the office's own data, stored in `site_content` (the same
 * key/value store the website text uses) and edited on **Admin → Fees →
 * “💳 How parents pay”**. Nothing is hard-coded in a view, and nothing external is
 * called at runtime: the QR is an image the school uploads (or the demo file
 * `public/images/pay-qr.png`, which encodes the demo UPI id, so a scan during a
 * demo still behaves), so the page works even with a poor connection.
 *
 * Two rules this file owns:
 *   1. `get()` — the ONE reader. Every value falls back to a demo default, so the
 *      page is complete before the office saves anything (and the office can see
 *      what a parent sees while filling the form).
 *   2. `upiLink()` — the ONE place a UPI deep link is built (`upi://pay?...`), used
 *      by the parent's “Open UPI app” button. The amount travels with it, so the
 *      UPI app opens with the exact balance already filled in.
 *   3. `accounts()` — the ONE place the bank blocks are grouped. The school keeps a
 *      main account and may add a **second** one (hostel / mess, a separate trust);
 *      the office switches the second one on or off on the same admin form.
 *
 * The demo values are placeholders for the school's real UPI id / accounts — the
 * office must replace them (the admin panel says so on the form, and the parent's
 * page carries a “Demo details — do not send money” line until it does).
 */
const db = require('../db');
const v = require('./validate');
const config = require('../config');

/** Every editable field, in the order the office sees them. */
const FIELDS = [
  'payUpi', 'payPayee',
  'payAcName', 'payAcNo', 'payIfsc', 'payBank', 'payBranch',
  // the OPTIONAL second account (hostel / mess, a second trust …) and the switch that
  // hides it again — a school with one account simply switches it off
  'payAc2Show', 'payAc2Label', 'payAc2Name', 'payAc2No', 'payAc2Ifsc', 'payAc2Bank', 'payAc2Branch',
  'payPhone', 'payNote',
];

/** The QR image (data URI or a path under /images) is edited on its own. */
const QR_FIELD = 'payQr';

/** Longest text each field may hold (the form only shows short boxes). */
const MAX = {
  payUpi: 60, payPayee: 80, payAcName: 80, payAcNo: 40, payIfsc: 20,
  payBank: 60, payBranch: 60, payPhone: 20, payNote: 400,
  payAc2Label: 40, payAc2Name: 80, payAc2No: 40, payAc2Ifsc: 20, payAc2Bank: 60, payAc2Branch: 60,
};

/**
 * What the page shows until the office saves its own details.
 * Deliberately obvious demo values (and a demo QR) so nobody mistakes them for
 * the school's real account.
 */
function defaults() {
  return {
    payUpi: 'greenvalleyvidyavihar@upi',
    payPayee: config.schoolName,
    payAcName: config.schoolName,
    payAcNo: '5012 3456 7890',
    payIfsc: 'SBIN0001234',
    payBank: 'State Bank of India',
    payBranch: 'Demo Town',
    payPhone: config.schoolPhone || '',
    payNote: 'Pay by UPI or bank transfer, then send the payment screenshot to the school office. '
      + 'You can also pay in cash at the school office.',
    // a second account is part of the demo (many schools keep a separate hostel / mess
    // account). The office replaces both numbers, or switches the second one OFF.
    payAc2Show: '1',
    payAc2Label: 'Hostel / mess account', payAc2Name: config.schoolName,
    payAc2No: '7890 1234 5678', payAc2Ifsc: 'HDFC0002345', payAc2Bank: 'HDFC Bank',
    payAc2Branch: 'Demo Town',
  };
}

/** QR shown until the school uploads its own. */
const DEMO_QR = '/images/pay-qr.png';

function rows() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM site_content').all()) out[r.key] = r.value;
  return out;
}

/**
 * The office's payment details, every value falling back to a demo default.
 * `custom` is false while nothing has been saved yet, so the pages can say
 * "demo details — the office will update these".
 */
function get() {
  const stored = rows();
  const def = defaults();
  const out = {};
  for (const f of FIELDS) out[f] = stored[f] !== undefined && stored[f] !== '' ? stored[f] : (def[f] || '');
  out[QR_FIELD] = stored[QR_FIELD] !== undefined && stored[QR_FIELD] !== '' ? stored[QR_FIELD] : DEMO_QR;
  out.demoQr = out[QR_FIELD] === DEMO_QR;
  out.custom = FIELDS.some((f) => stored[f] !== undefined && stored[f] !== '') || stored[QR_FIELD] !== undefined;
  // the second account is shown while its switch is on and it has a number; a stored
  // '0' (the office unticked it) keeps it hidden even though the numbers are kept
  out.payAc2Show = stored.payAc2Show !== undefined ? stored.payAc2Show !== '0' : (def.payAc2Show !== '0');
  if (out.payAc2No && !out.payAc2Label) out.payAc2Label = 'Second account';
  out.hasSecond = !!(out.payAc2No && out.payAc2Show);
  return out;
}

/**
 * Save the form. Every field goes through `validate`, so a half-typed value is
 * refused with a sentence the office can act on instead of being stored.
 * A blank box clears that field (it falls back to the demo value again).
 *
 * Three fields get a SHAPE check as well, because the parent's payment app is the
 * one that has to understand them: the UPI id (`name@bank`), the IFSC code
 * (`ABCD0123456`, stored in capitals) and the WhatsApp number (10 digits). A wrong
 * UPI id is money sent to a stranger, so it is better refused at the office.
 */
function save(body = {}) {
  const c = v.checker();
  const upsert = db.prepare(`INSERT INTO site_content (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const clean = {};
  for (const f of FIELDS) {
    if (f === 'payAc2Show') continue;          // a switch, not text — cleaned below
    clean[f] = c.text(body[f], labelOf(f), { max: MAX[f] });
  }
  clean.payAc2Show = v.isFlag(body.payAc2Show) ? '1' : '0';
  clean.payIfsc = clean.payIfsc.toUpperCase();
  clean.payAc2Ifsc = clean.payAc2Ifsc.toUpperCase();
  clean.payPhone = c.phone(body.payPhone, 'WhatsApp number for the screenshot');
  if (clean.payUpi && !v.isUpiId(clean.payUpi)) {
    c.fail('The UPI ID should look like name@bank — for example greenvalleyvidyavihar@upi.');
  }
  if (clean.payIfsc && !v.isIfsc(clean.payIfsc)) {
    c.fail('The IFSC code is 11 characters: 4 letters, then 0, then 6 letters or digits (like SBIN0001234).');
  }
  // the optional second account: either left completely blank (no second block on the
  // parent's page) or filled in properly — a half-filled one would send money nowhere
  const has2 = ['payAc2Label', 'payAc2Name', 'payAc2No', 'payAc2Ifsc', 'payAc2Bank', 'payAc2Branch']
    .some((f) => clean[f]);
  if (has2 && !clean.payAc2No) c.fail('The second account needs its account number (or leave the whole section empty).');
  if (has2 && !clean.payAc2Ifsc) c.fail('The second account needs its IFSC code (or leave the whole section empty).');
  if (clean.payAc2Ifsc && !v.isIfsc(clean.payAc2Ifsc)) {
    c.fail('The second account’s IFSC code is 11 characters: 4 letters, then 0, then 6 letters or digits.');
  }
  const qr = c.image(body[QR_FIELD], 'QR image', { max: 600000 });
  // An unticked checkbox sends nothing at all, so the form also posts
  // `payAc2ShowSet` — that is how "the office switched the second account off" is
  // told apart from "this form does not carry the switch".
  const writesSwitch = body.payAc2Show !== undefined || body.payAc2ShowSet !== undefined;
  if (!c.ok) return { ok: false, error: c.summary };
  db.transaction(() => {
    for (const f of FIELDS) {
      if (f === 'payAc2Show') continue;                // written below, as a switch
      if (body[f] === undefined) continue;             // a box that was not on the form
      upsert.run(f, clean[f]);
    }
    if (writesSwitch) upsert.run('payAc2Show', clean.payAc2Show);
    if (body[QR_FIELD] !== undefined) upsert.run(QR_FIELD, qr || '');
    if (body.removeQr) upsert.run(QR_FIELD, '');
  })();
  return { ok: true };
}

/** “payAcNo” → “Bank account number” — the label a validation message uses. */
function labelOf(field) {
  return {    payUpi: 'UPI ID', payPayee: 'UPI payee name', payAcName: 'Account holder name',
    payAcNo: 'Bank account number', payIfsc: 'IFSC code', payBank: 'Bank name', payBranch: 'Branch',
    payAc2Label: 'Second account label', payAc2Name: 'Second account holder name',
    payAc2No: 'Second account number', payAc2Ifsc: 'Second account IFSC code',
    payAc2Bank: 'Second account bank name', payAc2Branch: 'Second account branch',
    payPhone: 'WhatsApp number for the screenshot', payNote: 'Note for parents',
  }[field] || field;
}

/**
 * The UPI deep link — `upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…`.
 * A phone that has any UPI app opens it with the payee and the amount filled in;
 * on a desktop it simply does nothing.
 */
function upiLink(pay, { amount = 0, note = '' } = {}) {
  if (!pay || !pay.payUpi) return '';
  const q = new URLSearchParams();
  q.set('pa', String(pay.payUpi).trim());
  if (pay.payPayee) q.set('pn', String(pay.payPayee).trim());
  if (Number(amount) > 0) q.set('am', String(Math.round(Number(amount) * 100) / 100));
  q.set('cu', config.currencyCode || 'INR');
  if (note) q.set('tn', String(note).slice(0, 60));
  return 'upi://pay?' + q.toString();
}

/**
 * An Indian mobile number as `wa.me` wants it — country code first.
 * Numbers are saved as 10 digits, so a bare "9000000000" becomes "919000000000";
 * anything else (already with +91, or a landline) is passed through as digits.
 */
function waNumber(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 10 ? '91' + d : d;
}

/**
 * The WhatsApp link a parent taps AFTER paying — the office's number with the
 * child's name and class already typed in, so the only thing left to do is
 * attach the screenshot. Empty when the school has not set a number.
 */
function waLink(pay, text = '') {
  const n = waNumber(pay && pay.payPhone);
  if (!n) return '';
  return `https://wa.me/${n}` + (text ? '?text=' + encodeURIComponent(text) : '');
}

/**
 * The “copy all payment details” block, split into its pieces so the PARENT'S PAGE can
 * rebuild it in the browser when the amount or the months being paid change
 * (`views/parent/pay.ejs` keeps the pieces in `data-parts`). One wording, two places —
 * the server renders the first version and the browser only replaces the two numbers.
 *
 * `payFor` is what the money is for — “6 late months (Apr 2026 · …)”, “Oct 2026”, or an
 * advance month — because the office has to know WHICH month to post the money to.
 */
function copyParts(pay, { amount = 0, child = '', payFor = '' } = {}) {
  const details = [];
  if (pay.payUpi) details.push(`UPI ID: ${pay.payUpi}${pay.payPayee ? ' (' + pay.payPayee + ')' : ''}`);
  if (pay.payAcNo) details.push(`A/c no: ${pay.payAcNo}${pay.payIfsc ? ' · IFSC ' + pay.payIfsc : ''}`);
  if (pay.payBank) details.push(`${pay.payBank}${pay.payBranch ? ', ' + pay.payBranch : ''}`);
  if (pay.payAc2No && pay.payAc2Show !== false) {
    details.push(`(${pay.payAc2Label || 'Second account'}) A/c no: ${pay.payAc2No}${pay.payAc2Ifsc ? ' · IFSC ' + pay.payAc2Ifsc : ''}`);
    if (pay.payAc2Bank) details.push(`${pay.payAc2Bank}${pay.payAc2Branch ? ', ' + pay.payAc2Branch : ''}`);
  }
  if (pay.payPhone) details.push(`Send the screenshot: ${pay.payPhone}`);
  return { heading: `${config.schoolName} — fee payment`, who: child, amount, payFor, details };
}

/**
 * Every payment detail as ONE block of plain text — the pieces from `copyParts()`
 * written the way a parent would forward them to a relative who can do the transfer.
 */
function allText(pay, { amount = 0, child = '', payFor = '' } = {}) {
  const p = copyParts(pay, { amount, child, payFor });
  const lines = [p.heading];
  if (p.who) lines.push(`${p.who}${amount > 0 ? ' — Rs.' + amount : ''}`);
  if (payFor) lines.push(`Paying for: ${payFor}`);
  return lines.concat(p.details).join('\n');
}

/**
 * The UPI rows a parent reads, ready for the view — value + whether it is worth a
 * copy button (a UPI id is typed into another app; a payee name is not).
 */
function ways(pay) {
  const out = [];
  if (pay.payUpi) out.push({ key: 'upi', icon: '📱', label: 'UPI ID', value: pay.payUpi, copy: true });
  if (pay.payPayee) out.push({ key: 'payee', icon: '🏦', label: 'Account name', value: pay.payPayee, copy: false });
  return out;
}

/**
 * The BANK ACCOUNTS a parent may send the money to — one group per account, each with
 * its own heading and rows. The school keeps a main account and, when the office fills
 * the second one (hostel / mess, a separate trust …), that account shows as another
 * block. A blank group simply does not exist, so a one-account school never sees one.
 */
function accounts(pay) {
  const rows = (p, own) => [
    { key: 'acname' + own, icon: '🏦', label: 'Account holder name', value: p.name, copy: false },
    { key: 'acno' + own, icon: '🔢', label: 'Account number', value: p.no, copy: true },
    { key: 'ifsc' + own, icon: '🔤', label: 'IFSC code', value: p.ifsc, copy: true },
    { key: 'bank' + own, icon: '🏛', label: 'Bank', value: p.bank, copy: false },
    { key: 'branch' + own, icon: '📍', label: 'Branch', value: p.branch, copy: false },
  ].filter((r) => r.value);

  const groups = [
    { key: 'main', label: 'School bank account', rows: rows({
      name: pay.payAcName, no: pay.payAcNo, ifsc: pay.payIfsc, bank: pay.payBank, branch: pay.payBranch,
    }, '') },
  ];
  if (pay.payAc2No && pay.payAc2Show !== false) {
    groups.push({ key: 'second', label: pay.payAc2Label || 'Second account', rows: rows({
      name: pay.payAc2Name, no: pay.payAc2No, ifsc: pay.payAc2Ifsc, bank: pay.payAc2Bank, branch: pay.payAc2Branch,
    }, '2') });
  }
  return groups.filter((g) => g.rows.length);
}

module.exports = {
  FIELDS, QR_FIELD, get, save, upiLink, ways, accounts, defaults, DEMO_QR,
  waNumber, waLink, allText, copyParts,
};
