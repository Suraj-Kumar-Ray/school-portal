/**
 * ============================================================================
 * stay.js — DAY SCHOLAR or HOSTEL STUDENT, and what that changes about money
 * ============================================================================
 *
 * The school teaches two kinds of children in the same classes: those who come
 * from home and those who live in the hostel. Its printed fee sheet therefore has
 * TWO columns for every charge (`classes.tuition_day` / `tuition_hostel`,
 * `adm_day` / `adm_hostel`, …), and the two must never be mixed up: a day scholar
 * billed the hostel rate — or the other way round — is the mistake this file
 * exists to make impossible.
 *
 * A child can also JOIN the hostel in the middle of a session (admission first, hostel a
 * few months later), or leave it. So "is he a hostel student?"
 * is not a yes/no anymore — it is a PERIOD, and the rate of each month is decided
 * by where that month falls in it:
 *
 *     Apr   May   Jun  │ Jul   Aug   Sep   …      ← session months
 *     └──── day rate ──┴──── hostel rate ─────┘     ← joined the hostel in July
 *
 *   • `stay = 'hostel'` and no `hostel_from`     → the whole session at the hostel
 *     rate (a boarder from the first day),
 *   • `stay = 'hostel'` with `hostel_from`       → months BEFORE it stay at the day
 *     rate, so a mid-session joiner is never charged for months he was at home,
 *   • `hostel_until` set                          → months AFTER it go back to the
 *     day rate (he left the hostel),
 *   • `stay = 'day'`                              → the hostel period is ignored
 *     completely. A day scholar never sees a hostel month, whatever is left in
 *     those columns from an earlier stay.
 *
 * Both dates are SESSION MONTHS in the same shape the fee ledger already uses for
 * its terms — "Jul 2026" — read from `fees.sessionTerms()`, so there is no second
 * date format anywhere.
 *
 * This module is deliberately PURE (no database, no Express): it is the single
 * reader of the two columns, it is what `fees.js` prices months with, and it is
 * easy to test on its own. The hostel's own content (mess menu, routine, roster)
 * lives next door in `hostel.js`.
 */

// the session's month keys, April → March — the same shape `fees.sessionTerms()`
// writes into `fees.term`, and the only labels the office ever picks.
const MONTH_ORDER = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

const STAYS = [
  {
    key: 'day', label: 'Day scholar', short: 'Day', icon: '🏫',
    hint: 'Comes to school from home — the school fee only.',
  },
  {
    key: 'hostel', label: 'Hostel student', short: 'Hostel', icon: '🏠',
    hint: 'Lives in the school hostel — school fee and mess, charged at the hostel rate.',
  },
];
const STAY_KEYS = STAYS.map((s) => s.key);

/** "Jul 2026" → { key: 'Jul', year: 2026 }; anything else is not a month we know. */
const TERM_RE = /^([A-Za-z]{3})\s+(\d{4})$/;

/**
 * Clean a month the office typed or picked, or '' when it is not a real session
 * month. Case and spacing are forgiven ("jul 2026", "JUL  2026"), a wrong month
 * name is not — a typo here would silently move a fee.
 */
function parseTerm(value) {
  const m = TERM_RE.exec(String(value || '').trim());
  if (!m) return '';
  const key = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  const i = MONTH_ORDER.indexOf(key);
  if (i < 0) return '';
  return `${MONTH_ORDER[i]} ${Number(m[2])}`;
}

/**
 * A month as a single comparable number, so "is this month inside his hostel
 * period?" is one comparison instead of a list walk. `session-year * 12 + position` keeps
 * the session order (Apr → Mar) AND stays correct across a session boundary:
 * Apr 2026 < Jul 2026 < Mar 2027 < Apr 2027.
 * Returns null for a value that is not a session month (a blank column, or junk).
 */
function termIndex(term) {
  const clean = parseTerm(term);
  if (!clean) return null;
  const [key, year] = clean.split(' ');
  const pos = MONTH_ORDER.indexOf(key);              // Apr=0 … Dec=8, Jan=9, Feb=10, Mar=11
  const cal = Number(year);
  // A session BEGINS in April, so Jan/Feb/Mar belong to the session that started the
  // previous April. Folding that in is what makes the run monotone ACROSS a session
  // boundary too (Apr 2027 comes after Mar 2027). Without it every January sorted
  // *before* the previous April, and a hostel date typed for the next session could
  // quietly move a month into this year's hostel period (2026-09-16).
  const sessionYear = pos >= 9 ? cal - 1 : cal;
  return sessionYear * 12 + pos;
}

/** 'day' | 'hostel' — anything unexpected in the column reads as a day scholar. */
function stayOf(student) {
  return student && String(student.stay || '').trim() === 'hostel' ? 'hostel' : 'day';
}

/** Is he in the hostel at all? (What the parent app keys every hostel page on.) */
function isBoarder(student) {
  return stayOf(student) === 'hostel';
}

/**
 * WHICH RATE DOES THIS MONTH CARRY — 'hostel' or 'day'.
 * The one function every price, every label and every parent sentence comes from.
 * @param {object} student row with `stay`, `hostel_from`, `hostel_until`
 * @param {string} term session month, e.g. "Jul 2026"
 */
function rateKind(student, term) {
  if (!isBoarder(student)) return 'day';
  const t = termIndex(term);
  if (t === null) return 'day';                    // a month we cannot read is never the dearer one
  const from = termIndex(student.hostel_from);
  const until = termIndex(student.hostel_until);
  if (from !== null && t < from) return 'day';     // he was still at home
  if (until !== null && t > until) return 'day';   // he had already left the hostel
  return 'hostel';
}

/** The same answer as a label a parent reads under a month. */
function rateLabel(student, term) {
  return rateKind(student, term) === 'hostel' ? 'Hostel rate' : 'Day-scholar rate';
}

/** Short state of one student — the chip the office sees on a student card. */
function stayLabel(student) {
  if (!isBoarder(student)) return 'Day scholar';
  return 'Hostel student';
}

/**
 * The stay told in one sentence — used on the child's card and in the hostel page
 * header, so a parent always knows which months are charged at which rate.
 * Examples: "Hostel student since Jul 2026 · earlier months at the day rate",
 *           "Hostel student for the whole session",
 *           "Left the hostel after Dec 2026 · later months at the day rate",
 *           "Day scholar".
 */
function describe(student) {
  if (!isBoarder(student)) return 'Day scholar';
  const from = parseTerm(student.hostel_from);
  const until = parseTerm(student.hostel_until);
  if (from && until) return `Hostel student ${from} → ${until} · the months outside it are at the day rate`;
  if (from) return `Hostel student since ${from} · earlier months at the day rate`;
  if (until) return `Hostel student until ${until} · later months at the day rate`;
  return 'Hostel student for the whole session';
}

/** How many of these months are charged at the hostel rate (and which). */
function hostelMonths(student, terms = []) {
  return terms.filter((term) => rateKind(student, term) === 'hostel');
}

/**
 * A boarder's BED NUMBER, cleaned. The hostel has beds, not rooms (the school asked for
 * that on 2026-09-16), so only the number is kept: an office that types “Bed 4”, “bed no 4”
 * or a leftover “Room 2 · Bed 4” all end up as `4`, and the screens print the word “Bed”
 * themselves. Anything that is not a number is kept as typed (a dorm may say “B-12”).
 */
function bedOf(value) {
  const raw = String(value == null ? '' : value).trim().slice(0, 20);
  if (!raw) return '';
  const marked = /\bbed\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Za-z0-9/-]+)/i.exec(raw);
  if (marked) return marked[1].toUpperCase();
  const roomed = /\broom\b[^\d]*([A-Za-z0-9/-]+)/i.exec(raw);   // “Room 7 →” alone
  if (roomed) return roomed[1].toUpperCase();
  return raw.toUpperCase();
}

/**
 * The four stay columns, cleaned and made consistent — THE one place the office's
 * answers become stored values, used by both "add student" and "edit student".
 *
 * The important rule: a **day scholar's** hostel months are wiped. If the office
 * switches a boarder back to "day scholar" (or a child simply goes home), those
 * months must not be left behind to re-appear if the switch is ever flipped back,
 * and the ledger must re-price him at the day rate — which `fees.retuneStudent()`
 * does from these same columns.
 */
function normalise(input = {}) {
  const stay = STAY_KEYS.includes(String(input.stay || '').trim()) ? String(input.stay).trim() : 'day';
  const bed = bedOf(input.hostel_bed != null ? input.hostel_bed : input.hostel_room);
  if (stay !== 'hostel') return { stay: 'day', hostel_from: '', hostel_until: '', hostel_bed: '' };
  const from = parseTerm(input.hostel_from);
  const until = parseTerm(input.hostel_until);
  // A period that ends before it starts would price every month wrongly; the later
  // month is the one the office typed last, so the earlier one is dropped rather
  // than guessing — and the page shows both boxes, so nothing is hidden.
  const f = termIndex(from);
  const u = termIndex(until);
  return {
    stay: 'hostel',
    hostel_from: from,
    hostel_until: (f !== null && u !== null && u < f) ? '' : until,
    hostel_bed: bed,
  };
}

/** Is this student charged the hostel rate in ANY month of the session? */
function hasHostelMonths(student, terms = []) {
  return hostelMonths(student, terms).length > 0;
}

module.exports = {
  MONTH_ORDER, STAYS, STAY_KEYS,
  parseTerm, termIndex, stayOf, isBoarder, rateKind, rateLabel, stayLabel,
  describe, hostelMonths, hasHostelMonths, normalise, bedOf,
};
