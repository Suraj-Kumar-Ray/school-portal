/**
 * ============================================================================
 * parent_access.js — WHAT THE SCHOOL LETS A PARENT SEE
 * ============================================================================
 *
 * The parent app has five sections besides Fees. Until now every one of them was
 * open to every parent. This file is the ONE place that decides which of them a
 * parent is allowed to open — and the school office owns every switch.
 *
 * Two things the office can do, both on **Admin → Parent Access**:
 *
 *   1. **Switch a section off** for everybody. A school that does not want the
 *      timetable in the app, or that has no marks yet, simply switches it off —
 *      the link disappears from the menu AND the page answers 403 (hiding a link
 *      is cosmetics, the guard is the lock — same rule as the teacher portal).
 *
 *   2. **Close everything when the fee is not paid.** With this switch on, a child
 *      whose fee is due loses every other section and keeps **Fees and the home
 *      page only** — the home page is where the amount and the 💳 Pay button live,
 *      so a locked parent can still see what to pay and pay it. Reading the fee
 *      position happens through `src/services/fees.js` (`studentLedger`), the same
 *      ledger the office works from, so the lock can never disagree with the bill.
 *      The office picks WHEN it closes: on the first LATE month (recommended —
 *      a family that is one month ahead is not punished), or on the first month
 *      that is merely unpaid.
 *
 * **Fees can never be switched off.** A parent who cannot open the fee page cannot
 * pay — that would lock the money away from the school. It is deliberately not in
 * `SECTIONS`, and `forChild()` always reports it as open.
 *
 * `forChild()` is the ONE reader the parent's routes, the sidebar, the phone tab
 * bar and the home page all share: one object of `true`/`false` per section plus
 * `locked` (why the rest is shut) and the sentence the parent is shown. Nothing in
 * the parent portal decides this on its own.
 *
 * How to add a section
 * --------------------
 *   1. add one entry to `SECTIONS` (key · group · icon · label · href · hint ·
 *      `home` — where it also shows on the home page),
 *   2. add its key to `ORDER` (the menu position),
 *   3. wrap the route in `requireParentSection('<key>')` (src/middleware/auth.js)
 *      and put the view's own parts behind `parentAccess.<key>`.
 * The admin page, the sidebar, the tab bar and the tests all read `SECTIONS`, so
 * they pick the new row up on their own.
 */
const db = require('../db');
const v = require('./validate');
const fees = require('./fees');
const stay = require('./stay');   // day scholar or hostel student — the hostel section keys on it

/**
 * Every section the office may switch off, in the order a human reads them.
 * `details` has no page of its own — it is the child's record on the home page
 * (the ℹ️ button and the details box it opens).
 */
const SECTIONS = [
  {
    key: 'result', group: 'Academics', icon: '📈', label: 'Result & Performance',
    href: '/parent/performance',
    hint: 'Marks, the subject circles, term-by-term progress and the result PDF.',
    home: 'the Overall Average card on the home page',
  },
  {
    key: 'timetable', group: 'Academics', icon: '🕒', label: 'Timetable',
    href: '/parent/timetable',
    hint: "The week's period chart and today's periods, with the period timings.",
    // the holiday banner is the timetable's news too, so it is named here — with the switch
    // OFF the banner stays (the school being shut is not the timetable's secret) but drops
    // its link, because a home page never prints a section this login cannot open
    home: 'the Timetable tile and the holiday banner (no link to it when this section is off)',
  },
  {
    key: 'hostel', group: 'Hostel', icon: '🏠', label: 'Hostel',
    href: '/parent/hostel',
    hint: 'The mess menu day by day, how the hostel day runs, his room and the hostel charges — for a child who lives in the hostel.',
    home: 'the Hostel card on the home page (shown for a hostel student only)',
  },
  {
    key: 'notices', group: 'School', icon: '📢', label: 'Notices',
    href: '/parent/notices',
    hint: 'Notices for the child\'s class and for the whole school.',
    home: 'the Notices tile and the notices list',
  },
  {
    key: 'inbox', group: 'School', icon: '✉️', label: 'Message the school',
    href: '/parent/messages',
    hint: 'Read what the school sent and write back (fees, PTM, any question).',
    home: 'the inbox tile, the 🔔 bell on the child\'s card and the updates list',
  },
  {
    key: 'details', group: 'The child', icon: '🪪', label: "Child's details",
    href: '/parent',
    hint: "The child's full record — date of birth, blood group, parents' names, Aadhaar numbers, address.",
    home: 'the ℹ️ button on the child\'s card and the details box',
  },
];

/**
 * The one section that can never be switched off, and is not part of `SECTIONS`:
 * the office must always be able to ask a parent for money, and a locked parent
 * must always be able to see the amount and pay it.
 */
const FEES = {
  key: 'fees', group: 'Money', icon: '₹', label: 'Fees', href: '/parent/fees',
  hint: 'The month-by-month ledger, the pay page and the payment claims — always open.',
};

const KEYS = SECTIONS.map((s) => s.key);

/** Where each key sits in the menu (Fees between Timetable and Notices, as it always was). */
const ORDER = ['result', 'timetable', 'hostel', 'fees', 'notices', 'inbox'];

/** The four the phone's bottom bar can hold, between Home and the end. */
// `hostel` sits here so a BOARDER's parent reaches today's meals with one tap from anywhere in
// the app (2026-09-16). It is a section like any other: a day scholar never opens it
// (`forChild`), so his bar keeps the five tabs it had. The bar is `display: flex` with
// `flex: 1; min-width: 0` per tab, so six short labels fit a phone without overflowing.
const TAB_KEYS = ['result', 'timetable', 'hostel', 'fees', 'inbox'];

/**
 * When the office's “close the other sections” switch fires.
 * `overdue` (the default) is kind: a family that has paid up to last month keeps
 * the whole app, only a month PAST its due date closes it.
 */
const BASES = [
  { key: 'overdue', label: 'a month is LATE — its due date has passed (recommended)' },
  { key: 'unpaid', label: 'ANY month is still unpaid, even before its due date' },
];

/** What a parent is told while the other sections are closed, until the office writes its own. */
const DEFAULT_NOTE = 'Please pay the pending school fee. The other sections of this app '
  + 'open again as soon as the school office records your payment.';

/** `result` → `parentShowResult` — the key it is stored under in `site_content`. */
function storeKey(key) {
  return 'parentShow' + key.charAt(0).toUpperCase() + key.slice(1);
}

/** Every row of the key/value store, for the readers below (one query, one place). */
function stored() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM site_content').all()) out[r.key] = r.value;
  return out;
}

/** A section entry by key — `fees` included, so callers never special-case it. */
function byKey(key) {
  return SECTIONS.find((s) => s.key === key) || (key === FEES.key ? FEES : null);
}

/** A section missing from the store has never been touched → open (the app as it always was). */
function getSettings() {
  const s = stored();
  const sections = {};
  for (const k of KEYS) sections[k] = s[storeKey(k)] === undefined ? true : s[storeKey(k)] !== '0';
  return {
    sections,
    open: KEYS.filter((k) => sections[k]).length,
    total: KEYS.length,
    lockUnpaid: s.parentLockUnpaid === '1',
    basis: BASES.some((b) => b.key === s.parentLockBasis) ? s.parentLockBasis : 'overdue',
    note: (s.parentLockNote && String(s.parentLockNote).trim()) || DEFAULT_NOTE,
    custom: s.parentLockUnpaid !== undefined || KEYS.some((k) => s[storeKey(k)] !== undefined),
  };
}

/**
 * Save the switches. The form always carries the lock switches; the section boxes
 * are only trusted when the form says it printed them (`parentSwitchesSet`), so a
 * page that never showed them can never switch everything off by accident.
 */
function save(body = {}) {
  const c = v.checker();
  const note = c.text(body.parentLockNote, 'Message shown to the parent', { max: 300 });
  const basis = c.choice(body.parentLockBasis, 'Close the other sections when',
    BASES.map((b) => b.key), { fallback: 'overdue' }) || 'overdue';
  const lockUnpaid = v.isFlag(body.parentLockUnpaid);
  const switches = {};
  for (const k of KEYS) switches[k] = v.isFlag(body['show_' + k]);
  const writesSwitches = body.parentSwitchesSet !== undefined;
  if (!c.ok) return { ok: false, error: c.summary };

  const upsert = db.prepare(`INSERT INTO site_content (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  db.transaction(() => {
    upsert.run('parentLockUnpaid', lockUnpaid ? '1' : '0');
    upsert.run('parentLockBasis', basis);
    upsert.run('parentLockNote', note);
    if (writesSwitches) for (const k of KEYS) upsert.run(storeKey(k), switches[k] ? '1' : '0');
  })();
  return { ok: true };
}

/**
 * What THIS child's parent may open, right now.
 *
 * Returned shape (read by the routes, the sidebar, the tab bar and the views):
 *   result · timetable · notices · inbox · details — one boolean each (after both rules)
 *   fees · home                                    — always true
 *   locked                                         — the fee rule closed the rest
 *   note                                           — the sentence the parent is shown
 *   money                                          — { balance, overdue } when it was checked
 *   settings                                       — the office's raw switches (admin pages/tests)
 *
 * `childId` of 0 (a parent with no child yet, e.g. an applicant) skips the fee rule:
 * there is nothing to owe.
 */
function forChild(childId) {
  const s = getSettings();
  const out = Object.assign({}, s.sections, {
    fees: true,
    home: true,
    locked: false,
    note: s.note,
    money: null,
    settings: s,
    open: s.open,
    total: s.total,
  });

  // HOSTEL is not only the office's switch — it is about the CHILD (2026-09-16). A hostel
  // page belongs to a child who LIVES in the hostel, so a day scholar's app never grows one
  // and the office cannot open it for him: both must be true. This is what keeps the two
  // kinds of family apart — a day scholar's parent reads no mess menu, no room, no hostel
  // charges, and a boarder's parent gets all of it without losing the rest of the app.
  out.hostel = !!(s.sections.hostel && childId && isBoarder(childId));
  if (!s.lockUnpaid || !childId) return out;

  // The fee position comes from the ONE fee service — the same months, receipts and
  // fines the office's ledger shows. If it cannot be read we do NOT lock: a parent
  // must never lose the app because of a query error.
  let position = null;
  try { position = fees.studentLedger(childId); } catch (e) { position = null; }
  if (!position) return out;

  out.money = {
    balance: position.balance, overdue: position.overdueAmount,
    overdueMonths: position.overdueMonths, paid: position.receivedTotal,
  };
  const owed = s.basis === 'unpaid' ? position.balance : position.overdueAmount;
  if (owed > 0) {
    out.locked = true;
    for (const k of KEYS) out[k] = false;
  }
  return out;
}

/**
 * Is this child a boarder? One tiny read, and only when a child is known.
 * Read through `stay.js`, the same rule the fee ledger prices months with, so the page
 * that opens and the rate that is charged can never disagree.
 */
function isBoarder(childId) {
  if (!childId) return false;
  const row = db.prepare('SELECT stay, hostel_from, hostel_until FROM students WHERE id = ?').get(childId);
  return !!row && stay.isBoarder(row);
}

/** May this parent open `key`? (`fees` and `home` always yes.) */
function has(access, key) {
  if (key === 'home' || key === FEES.key) return true;
  const a = access || forChild(0);
  return !!a[key];
}

/**
 * The URL prefixes that light a menu row up as “you are here”.
 * Fees covers the pay page too — a parent paying a UPI payment is still on the fee
 * section, and the tab must not go dark while they are in the middle of it.
 */
const MATCH = {
  result: ['/parent/performance'],
  timetable: ['/parent/timetable'],
  hostel: ['/parent/hostel'],
  fees: ['/parent/fees', '/parent/pay'],
  notices: ['/parent/notices'],
  inbox: ['/parent/messages'],
};

/** The menu the parent's app prints — only the open sections, Fees always in it. */
function navFor(access) {
  const a = access || forChild(0);
  return ORDER
    .map((k) => byKey(k))
    .filter((s) => s && (s.key === FEES.key || a[s.key]))
    .map((s) => ({ key: s.key, icon: s.icon, label: s.label, href: s.href, match: MATCH[s.key] || [s.href] }));
}

/** The phone's bottom tabs: Home first, then the open ones among `TAB_KEYS`. */
function tabFor(access) {
  const a = access || forChild(0);
  return TAB_KEYS
    .map((k) => byKey(k))
    .filter((s) => s && (s.key === FEES.key || a[s.key]))
    .map((s) => ({ key: s.key, icon: s.icon, label: s.label, href: s.href,
      match: MATCH[s.key] || [s.href],
      short: s.key === 'inbox' ? 'Inbox' : s.label.split(' ')[0] }));
}

/** The five sections grouped for the admin page (`[{ group, sections }]`), as the teacher page does. */
function grouped() {
  const groups = [];
  for (const s of SECTIONS) {
    let g = groups.find((x) => x.group === s.group);
    if (!g) { g = { group: s.group, sections: [] }; groups.push(g); }
    g.sections.push(s);
  }
  return groups;
}

/**
 * The sentence a parent is shown when a section is shut. One wording, one place — the
 * route guard (src/middleware/auth.js) and the message routes both use it, so the parent
 * is never told two different things about the same switch. It always says WHO can help.
 */
function denyMessage(key, access) {
  const section = byKey(key) || { label: key };
  // The hostel section has a third reason to be closed — this child is not a boarder — and
  // saying “not open for parents” would be misleading, so it is named honestly.
  if (key === 'hostel' && !(access && access.hostel)) {
    return 'The Hostel section is for a child who lives in the school hostel, and only while the '
      + 'school office has it switched on. This child is shown as a day scholar — please call the '
      + 'school office if that is not right.';
  }
  return (access && access.locked)
    ? `${section.label} is closed for this child until the school fee is paid. The Fees section is open — please pay the fee and it opens again.`
    : `${section.label} is not open for parents in this app. Please call the school office if you need it.`;
}

/**
 * The sentence a parent reads while the other sections are shut. Always says WHY,
 * so it never looks like a broken app, and what to do about it.
 */
function lockSentence(access) {
  const a = access || {};
  return a.note || DEFAULT_NOTE;
}

module.exports = {
  SECTIONS, FEES, KEYS, ORDER, TAB_KEYS, BASES, DEFAULT_NOTE,
  storeKey, byKey, getSettings, save, forChild, has, isBoarder, navFor, tabFor, grouped,
  denyMessage, lockSentence,
};
