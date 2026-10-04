// ============================================================
// Fee ledger
// ------------------------------------------------------------
// The `fees` table holds one row per student per month of the
// session (April → March). Students are added/edited/deleted from
// many places, so instead of relying on whoever added the student
// to also create the fee rows, this module *synchronises* the two:
//
//   • syncStudent(s)  — create the missing monthly installments for
//                       every student (or one student / one class)
//   • retuneStudent / retuneClass — when a class's monthly tuition
//                       changes (or a student moves to another class),
//                       untouched installments follow the new amount so
//                       the ledger never shows stale prices.
//
// Everything here is idempotent: running it twice changes nothing the
// second time (UNIQUE(student_id, term) + INSERT OR IGNORE).
//
// ---- money (2026-09-14) ------------------------------------
// A month is NOT a yes/no flag any more. Real parents pay in parts and
// the office adds a late fine, so a month carries:
//
//   payable    = amount + fine        what the school is owed for it
//   paid_amount                       money actually received (sum of receipts)
//   balance    = payable - paid_amount
//   status     = paid | partial | overdue | due
//
// The receipts themselves live in `fee_payments` (one row per payment, so a
// month can be paid 500 + 800). `fees.paid_amount` is always kept equal to
// SUM(receipts) by `recompute()`, and `fees.paid` / `fees.paid_date` stay as
// the derived "month fully settled" flag every older page already reads.
// ============================================================

const db = require('../db');
const time = require('./time');
// The day-scholar / hostel-student rule (which month is charged at which column of the
// class fee sheet). Pure and dependency-free, so the ledger can price a month without
// knowing anything about the hostel's pages. See `rateFor()` below.
const stay = require('./stay');

// session runs April → March, like the school's session year
const SESSION_MONTHS = [
  { key: 'Apr', month: 4 },
  { key: 'May', month: 5 },
  { key: 'Jun', month: 6 },
  { key: 'Jul', month: 7 },
  { key: 'Aug', month: 8 },
  { key: 'Sep', month: 9 },
  { key: 'Oct', month: 10 },
  { key: 'Nov', month: 11 },
  { key: 'Dec', month: 12 },
  { key: 'Jan', month: 1 },
  { key: 'Feb', month: 2 },
  { key: 'Mar', month: 3 },
];

// how the money came in — one place, used by the form, the validator and the views
const PAY_MODES = ['Cash', 'UPI', 'Cheque', 'Bank transfer', 'Other'];

// ---- SCHOOL FEE and HOSTEL FEE: the two bills inside one month (2026-09-16) ------------
//
// A hostel student's month is TWO bills in one row, and a family does not always pay them
// together: many parents settle the school fee and let the hostel (mess & lodging) run on, or
// pay a part of each. Showing them one number — which is what the page used to do — is exactly
// the confusion the school asked to remove.
//
// So every month is read as:
//
//   SCHOOL fee  = the class's DAY column: what the school costs that class, for every child
//   HOSTEL fee  = the rest of the hostel column: boarding, mess and lodging (`hostel - day`)
//
// Both come from the school's own printed sheet (`classes.tuition_day` / `tuition_hostel`), so
// no figure is invented here — and a day scholar's school fee IS his whole month, while his
// hostel fee is zero in every direction. A late fine is neither: it stays its own third part.
//
// Money is spread over the parts in one fixed order — **school, then hostel, then fine** —
// which is how the school collects: a part payment settles the school fee first. A receipt can
// be LABELLED when the office knows otherwise (`fee_payments.part`): a payment the parent meant
// for the hostel then fills that part first and only spills over if it is already full.
const PAY_PARTS = [
  { key: '', label: 'School fee first', hint: 'settles the school fee first, then the hostel fee' },
  { key: 'school', label: 'School fee', hint: 'only the school fee part of the month' },
  { key: 'hostel', label: 'Hostel fee (mess & lodging)', hint: 'only the hostel part of the month' },
];
const PAY_PART_KEYS = PAY_PARTS.map((p) => p.key);
// the order money fills a month in, when nothing is labelled
const PARTS_ORDER = ['school', 'hostel', 'fine'];

// a month can be in exactly one of these states
const MONTH_STATUS = ['paid', 'partial', 'overdue', 'due'];
// what the office can filter the students list by
const STUDENT_STATUS = ['all', 'due', 'partial', 'overdue', 'cleared'];

const EPS = 0.005;                                   // half a paisa — avoids float noise
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// which session (April → March) does this date belong to?
function sessionStartYear(now = time.istNow()) {
  // istNow() reads as IST, so the session flips on the school's April, not the server's
  const y = now.getFullYear();
  return now.getMonth() + 1 >= 4 ? y : y - 1;
}

// the 12 installments of a session: term label + due date (10th of the month)
function sessionTerms(now = time.istNow()) {
  const start = sessionStartYear(now);
  return SESSION_MONTHS.map(({ key, month }) => {
    const year = month >= 4 ? start : start + 1;
    return {
      term: `${key} ${year}`,
      due: `10/${String(month).padStart(2, '0')}/${year}`,
    };
  });
}

function ratesByClass() {
  const map = new Map();
  db.prepare('SELECT id, tuition_day, tuition_hostel FROM classes').all()
    .forEach(c => map.set(c.id, {
      day: Number(c.tuition_day) || 0,
      hostel: Number(c.tuition_hostel) || 0,
    }));
  return map;
}

/**
 * ONE MONTH'S PRICE for one student — the single price rule of the whole ledger.
 *
 * A day scholar always pays his class's day column. A boarder pays the hostel column
 * from the month he joined, and the day column for the months before it (and after he
 * left) — that decision is `stay.rateKind()`, so the hostel rate, the parent's
 * “Hostel rate” tag on a month and the reminder's amount can never disagree.
 *
 * @param {object} student row carrying `class_id`, `stay`, `hostel_from`, `hostel_until`
 * @param {string} term    session month, e.g. "Jul 2026"
 * @param {Map}    [rates] `ratesByClass()` when pricing many months at once
 */
function rateFor(student, term, rates) {
  const r = (rates || ratesByClass()).get(student.class_id) || { day: 0, hostel: 0 };
  return stay.rateKind(student, term) === 'hostel' ? r.hostel : r.day;
}

// The stay columns every pricing decision reads — listed once so a query that feeds
// syncStudent / retune / the ledger cannot forget one of them.
const STAY_COLS = 'stay, hostel_from, hostel_until, hostel_bed';

/**
 * Create any missing monthly installments.
 * @param {{ studentId?: number, classId?: number }} [scope] — default: every student
 * @returns {{ created: number, students: number, terms: number }}
 */
function syncStudent({ studentId = null, classId = null } = {}) {
  let students;
  if (studentId) {
    students = db.prepare(`SELECT id, class_id, ${STAY_COLS} FROM students WHERE id = ?`).all(studentId);
  } else if (classId) {
    students = db.prepare(`SELECT id, class_id, ${STAY_COLS} FROM students WHERE class_id = ?`).all(classId);
  } else {
    students = db.prepare(`SELECT id, class_id, ${STAY_COLS} FROM students`).all();
  }
  if (!students.length) return { created: 0, students: 0, terms: 0 };

  const rates = ratesByClass();
  const terms = sessionTerms();
  const ins = db.prepare(`INSERT OR IGNORE INTO fees (student_id, term, amount, paid, due_date)
                          VALUES (?, ?, ?, 0, ?)`);
  let created = 0;
  db.transaction(() => {
    for (const s of students) {
      // each month priced by ITS OWN rate: a boarder who joined in July is at the day
      // rate for April–June and at the hostel rate from July on.
      for (const t of terms) {
        created += ins.run(s.id, t.term, rateFor(s, t.term, rates), t.due).changes;
      }
    }
  })();

  return { created, students: students.length, terms: terms.length };
}

/**
 * Re-price a student's untouched installments — for the class he is in NOW, and for
 * whether he is a day scholar or a hostel student in each of those months.
 *
 * This is what makes the day/hostel switch safe to flip at any time: marking a child as a
 * boarder from July re-prices April–June at the day rate and July onward at the hostel
 * rate, and switching him back to a day scholar puts every untouched month back to the day
 * rate. A month that has already received money (or is closed) keeps its price — the parent
 * and the receipt history must not change under them mid-payment.
 * @returns {number} how many months changed price
 */
function retuneStudent(studentId) {
  const stu = db.prepare(`SELECT id, class_id, ${STAY_COLS} FROM students WHERE id = ?`).get(studentId);
  if (!stu) return 0;
  const rates = ratesByClass();
  const upd = db.prepare(`UPDATE fees SET amount = ?
                          WHERE student_id = ? AND term = ? AND paid = 0 AND paid_amount = 0
                            AND amount <> ?`);
  let changed = 0;
  db.transaction(() => {
    for (const t of sessionTerms()) {
      const amount = rateFor(stu, t.term, rates);
      changed += upd.run(amount, studentId, t.term, amount).changes;
    }
  })();
  return changed;
}

/** Same as retuneStudent, for every student of a class (fee structure or stay changed). */
function retuneClass(classId) {
  const ids = db.prepare('SELECT id FROM students WHERE class_id = ?').all(classId).map(r => r.id);
  let changed = 0;
  for (const id of ids) changed += retuneStudent(id);
  return changed;
}

// ------------------------------------------------------------
// Money helpers — every page reads the ledger through these, so
// the admin page and the parent portal can never disagree.
// ------------------------------------------------------------

// due dates are stored as DD/MM/YYYY
function parseDue(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value || '').trim());
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}

// Midnight of the SCHOOL's day (IST), not the server's — "overdue" must flip on the
// school's own calendar day even if the app is hosted in another timezone.
// Compares like-for-like with parseDue(), which also builds a local-midnight date.
function startOfToday() {
  const p = time.istParts();
  return new Date(p.year, p.month - 1, p.day);
}

function isOverdue(month, today) {
  if (month.status === 'paid') return false;
  const due = parseDue(month.due_date);
  return due ? due < today : false;
}

/** amount + fine — what the school is owed for that month */
function payable(month) { return money((Number(month.amount) || 0) + (Number(month.fine) || 0)); }

/**
 * THE SPLIT — a month's tuition as { school, hostel }. Pure, and the only place it is decided,
 * so the parent's page, the office's ledger, the PDF and a reminder can never disagree.
 * A day scholar (or a boarder's month before he joined) is entirely school fee.
 * @param {{ amount?: number, rate?: string, dayRate?: number }} month
 */
function splitOf(month = {}) {
  const total = money(month.amount);
  if (month.rate !== 'hostel') return { school: total, hostel: 0 };
  const school = Math.min(money(month.dayRate), total);
  return { school: money(school), hostel: money(total - school) };
}

/** One part's state, for a badge: none (nothing charged) · paid · part · open. */
function partStatus(charge, paid) {
  const c = money(charge), p = money(paid);
  if (c <= EPS) return 'none';
  if (p + EPS >= c) return 'paid';
  return p > EPS ? 'part' : 'open';
}

/**
 * SPLIT ONE MONTH, MONEY INCLUDED — writes the school/hostel/fine parts onto the month object.
 *
 * The money received on the month is spread over the parts in `PARTS_ORDER`, and a labelled
 * receipt (`receipt.part` = 'school' | 'hostel') fills its own part first. Money beyond every
 * part (only possible after a price drop or a removed fine) is kept on the part the receipt
 * named, so a receipt is never silently dropped from the sums.
 *
 * Reads `month.amount`, `month.fine`, `month.rate`, `month.dayRate`, `month.paid_amount`,
 * `month.receipts`; adds `schoolCharge/Paid/Balance`, `hostelCharge/Paid/Balance`,
 * `fineCharge/Paid/Balance` and `schoolStatus/hostelStatus`.
 */
function splitMonth(month) {
  const { school, hostel } = splitOf(month);
  const parts = {
    school: { charge: school, paid: 0 },
    hostel: { charge: hostel, paid: 0 },
    fine: { charge: money(month.fine), paid: 0 },
  };
  for (const r of (month.receipts || [])) {
    let left = money(r.amount);
    if (!(left > 0)) continue;
    // a labelled receipt starts at its own part (if the label is one we know)
    const first = PAY_PART_KEYS.includes(r.part) && r.part ? r.part : '';
    const order = first ? [first, ...PARTS_ORDER.filter((k) => k !== first)] : PARTS_ORDER;
    for (const key of order) {
      if (left <= EPS) break;
      const room = money(parts[key].charge - parts[key].paid);
      if (room <= EPS) continue;
      const take = money(Math.min(room, left));
      parts[key].paid = money(parts[key].paid + take);
      left = money(left - take);
    }
    if (left > EPS) {
      const home = first || 'school';
      parts[home].paid = money(parts[home].paid + left);
    }
  }
  for (const key of PARTS_ORDER) {
    month[`${key}Charge`] = money(parts[key].charge);
    month[`${key}Paid`] = money(parts[key].paid);
    month[`${key}Balance`] = Math.max(0, money(parts[key].charge - parts[key].paid));
  }
  month.schoolStatus = partStatus(month.schoolCharge, month.schoolPaid);
  month.hostelStatus = partStatus(month.hostelCharge, month.hostelPaid);
  return month;
}

function toMonth(row, today) {
  const month = {
    // the FEE row id (not the student id — the row also carries s.id, which is why
    // this is read from the aliased column)
    id: row.fee_id,
    term: row.term,
    amount: money(row.amount),
    fine: money(row.fine),
    fine_note: row.fine_note || '',
    paid_amount: money(row.paid_amount),
    due_date: row.due_date,
    paid_date: row.paid_date,
    receipts: [],
  };
  month.payable = payable(month);
  month.balance = Math.max(0, money(month.payable - month.paid_amount));
  month.status = !month.balance
    ? 'paid'
    : month.paid_amount > 0
      ? (isOverdue({ ...month, status: 'partial' }, today) ? 'overdue' : 'partial')
      : (isOverdue({ ...month, status: 'due' }, today) ? 'overdue' : 'due');
  month.partly = month.status === 'partial' || (month.status === 'overdue' && month.paid_amount > 0);
  month.overdue = month.status === 'overdue';
  month.percent = month.payable > 0 ? Math.min(100, Math.round((month.paid_amount / month.payable) * 100)) : (month.paid_amount ? 100 : 0);
  return month;
}

// ------------------------------------------------------------
// Receipts — the money actually received
// ------------------------------------------------------------

/**
 * Bring one month back in line with its receipts: `paid_amount` = SUM(receipts)
 * and `paid` / `paid_date` derived from it. Call after ANY change to a month or
 * its receipts. Returns the new state, or null if the month is gone.
 */
function recompute(feeId) {
  const fee = db.prepare('SELECT id, amount, fine FROM fees WHERE id = ?').get(feeId);
  if (!fee) return null;
  const total = money(db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM fee_payments WHERE fee_id = ?')
    .get(feeId).s);
  const owed = money(fee.amount + fee.fine);
  const settled = total + EPS >= owed;
  const last = db.prepare('SELECT paid_on FROM fee_payments WHERE fee_id = ? ORDER BY id DESC LIMIT 1').get(feeId);
  db.prepare('UPDATE fees SET paid_amount = ?, paid = ?, paid_date = ? WHERE id = ?')
    .run(total, settled ? 1 : 0, settled ? (last ? last.paid_on : null) : null, feeId);
  return { feeId, paid_amount: total, paid: settled ? 1 : 0, balance: Math.max(0, money(owed - total)) };
}

/**
 * Record money received for one month. Partial amounts are welcome; over-paying
 * is not (the caller blocks it first, and this is the last line of defence).
 * @returns {{ ok: boolean, error?: string, paid_amount?: number, paid?: number, balance?: number }}
 */
function recordPayment({ feeId, studentId, amount, paidOn, mode = 'Cash', note = '', part = '' }) {
  const fee = db.prepare('SELECT * FROM fees WHERE id = ? AND student_id = ?').get(feeId, studentId);
  if (!fee) return { ok: false, error: 'That month is not part of this student’s ledger.' };
  const value = money(amount);
  if (!(value > 0)) return { ok: false, error: 'Enter the amount received (more than zero).' };
  const owed = money(fee.amount + fee.fine);
  const balance = Math.max(0, money(owed - fee.paid_amount));
  if (value > balance + EPS) {
    return { ok: false, error: `That is more than the balance of Rs.${Math.round(balance).toLocaleString('en-IN')} on that month.` };
  }
  // which bill the money was meant for ('' = the school's own order: school fee first)
  const label = PAY_PART_KEYS.includes(String(part || '').trim()) ? String(part).trim() : '';
  db.prepare(`INSERT INTO fee_payments (fee_id, student_id, amount, paid_on, mode, note, part)
              VALUES (?,?,?,?,?,?,?)`)
    .run(feeId, studentId, value, paidOn || time.todayDMY(), PAY_MODES.includes(mode) ? mode : 'Cash', note || null, label || null);
  return { ok: true, ...recompute(feeId) };
}

/** Remove every receipt of a month — the office is undoing a payment. */
function clearReceipts(feeId) {
  const removed = db.prepare('DELETE FROM fee_payments WHERE fee_id = ?').run(feeId).changes;
  recompute(feeId);
  return removed;
}

/**
 * Set (or clear) the late fine on one month. A fine is added by hand — the
 * office decides; the parent sees it on the portal and is notified.
 * @returns {{ ok: boolean, error?: string, fine?: number }}
 */
function setFine({ feeId, studentId, fine, note = '' }) {
  const fee = db.prepare('SELECT * FROM fees WHERE id = ? AND student_id = ?').get(feeId, studentId);
  if (!fee) return { ok: false, error: 'That month is not part of this student’s ledger.' };
  const value = money(fine);
  if (value < 0) return { ok: false, error: 'A fine cannot be negative.' };
  if (value > 100000) return { ok: false, error: 'That fine looks wrong — please check the amount.' };
  db.prepare('UPDATE fees SET fine = ?, fine_note = ? WHERE id = ?').run(value, note || null, feeId);
  recompute(feeId);
  return { ok: true, fine: value };
}

// ------------------------------------------------------------
// Student-wise ledger — the Fees page groups everything under the
// student, and a student's own page lists only their 12 months.
// ------------------------------------------------------------

/**
 * One row per student with their installments folded in.
 * @param {{ classId?: number, studentId?: number, q?: string }} [filter]
 */
function ledger({ classId = 0, studentId = 0, q = '' } = {}) {
  const where = [];
  const args = [];
  if (classId) { where.push('s.class_id = ?'); args.push(classId); }
  if (studentId) { where.push('s.id = ?'); args.push(studentId); }
  const search = String(q || '').trim().toLowerCase();
  if (search) {
    where.push(`(LOWER(s.full_name) LIKE ? OR LOWER(COALESCE(s.admission_no, '')) LIKE ?
                 OR CAST(s.roll_no AS TEXT) = ? OR LOWER(COALESCE(s.parent_name, '')) LIKE ?)`);
    const like = `%${search}%`;
    args.push(like, like, search, like);
  }
  const scope = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT s.id, s.full_name, s.roll_no, s.admission_no, s.parent_name, s.parent_phone,
           s.parent_user_id, s.photo,
           s.stay, s.hostel_from, s.hostel_until, s.hostel_bed,
           c.id AS class_id, c.name AS class_name, c.section,
           c.tuition_day, c.tuition_hostel,
           f.id AS fee_id, f.term, f.amount, f.fine, f.fine_note, f.paid_amount,
           f.paid, f.due_date, f.paid_date
    FROM students s
    JOIN classes c ON c.id = s.class_id
    LEFT JOIN fees f ON f.student_id = s.id
    ${scope}
    ORDER BY c.id, s.roll_no, f.id`).all(...args);

  // every receipt of the students in scope, in one query (same filter, so a
  // class view does not drag in the whole school's receipts)
  const receipts = db.prepare(`
    SELECT p.id, p.fee_id, p.student_id, p.amount, p.paid_on, p.mode, p.note, p.part
    FROM fee_payments p
    JOIN students s ON s.id = p.student_id
    ${scope}
    ORDER BY p.id`).all(...args);
  const byFee = new Map();
  for (const r of receipts) {
    if (!byFee.has(r.fee_id)) byFee.set(r.fee_id, []);
    byFee.get(r.fee_id).push({ ...r, amount: money(r.amount) });
  }

  const today = startOfToday();
  const byStudent = new Map();
  for (const r of rows) {
    let st = byStudent.get(r.id);
    if (!st) {
      st = {
        id: r.id, full_name: r.full_name, roll_no: r.roll_no, admission_no: r.admission_no,
        parent_name: r.parent_name, parent_phone: r.parent_phone, parent_user_id: r.parent_user_id,
        photo: r.photo,
        class_id: r.class_id, class_name: r.class_name, section: r.section,
        // ---- day scholar or hostel student (2026-09-16) ----
        // The stay columns travel WITH the student so every page (the office's ledger, the
        // parent's fee page, the PDF, the reminder) reads the same state without a second
        // query — and `stayNote` is the sentence they all show.
        stay: stay.stayOf(r), isBoarder: stay.isBoarder(r),
        hostel_from: r.hostel_from || '', hostel_until: r.hostel_until || '',
        hostel_bed: r.hostel_bed || '', stayNote: stay.describe(r),
        hostelMonths: 0, hostelBalance: 0, hostelCharged: 0, hostelPaid: 0, hostelRate: 0, dayRate: 0,
        schoolCharged: 0, schoolPaid: 0, schoolBalance: 0, schoolOverdue: 0, hostelOverdue: 0,
        fineCharged: 0, finePaid: 0, fineBalance: 0,
        schoolStatus: 'none', hostelStatus: 'none',
        months: [], paidMonths: 0, partialMonths: 0, totalMonths: 0,
        collected: 0, pending: 0, sessionTotal: 0, fineTotal: 0, balance: 0,
        overdueMonths: 0, overdueAmount: 0, nextDue: null,
      };
      st.hostelRate = Number(r.tuition_hostel) || 0;
      st.dayRate = Number(r.tuition_day) || 0;
      byStudent.set(r.id, st);
    }
    if (!r.fee_id) continue;                       // student has no installments yet
    const month = toMonth(r, today);
    month.receipts = byFee.get(month.id) || [];
    // which column of the fee sheet this month was charged from — read from the SAME rule
    // that priced it, so the tag a parent reads can never contradict the amount
    month.rate = stay.rateKind(r, month.term);
    month.rateLabel = month.rate === 'hostel' ? 'Hostel rate' : 'Day-scholar rate';
    month.dayRate = st.dayRate;
    month.hostelRate = st.hostelRate;
    // the two bills inside this month, and the money spread over them (school → hostel → fine)
    splitMonth(month);
    if (month.rate === 'hostel') st.hostelMonths++;
    st.schoolCharged += month.schoolCharge;
    st.schoolPaid += month.schoolPaid;
    st.hostelCharged += month.hostelCharge;
    st.hostelPaid += month.hostelPaid;
    st.fineCharged += month.fineCharge;
    st.finePaid += month.finePaid;
    if (month.overdue) {
      st.schoolOverdue += month.schoolBalance;
      st.hostelOverdue += month.hostelBalance;
    }
    st.months.push(month);
    st.totalMonths++;
    st.sessionTotal += month.payable;              // tuition + fine = what is owed
    st.collected += month.paid_amount;
    st.fineTotal += month.fine;
    if (month.status === 'paid') st.paidMonths++;
    else {
      st.pending += month.balance;
      if (month.paid_amount > 0) st.partialMonths++;
      if (month.overdue) { st.overdueMonths++; st.overdueAmount += month.balance; }
      if (!st.nextDue) st.nextDue = month;
    }
  }

  const list = [...byStudent.values()];
  for (const st of list) {
    st.sessionTotal = money(st.sessionTotal);
    st.collected = money(st.collected);
    st.pending = money(st.pending);
    st.fineTotal = money(st.fineTotal);
    st.overdueAmount = money(st.overdueAmount);
    st.balance = st.pending;                                    // everything still owed
    // ---- the two bills, session-wide (the number a parent's page leads with) ----
    st.schoolCharged = money(st.schoolCharged);
    st.schoolPaid = money(st.schoolPaid);
    st.schoolBalance = Math.max(0, money(st.schoolCharged - st.schoolPaid));
    st.hostelCharged = money(st.hostelCharged);
    st.hostelPaid = money(st.hostelPaid);
    st.hostelBalance = Math.max(0, money(st.hostelCharged - st.hostelPaid));
    st.fineCharged = money(st.fineCharged);
    st.finePaid = money(st.finePaid);
    st.fineBalance = Math.max(0, money(st.fineCharged - st.finePaid));
    st.schoolOverdue = money(st.schoolOverdue);
    st.hostelOverdue = money(st.hostelOverdue);
    st.schoolStatus = partStatus(st.schoolCharged, st.schoolPaid);
    st.hostelStatus = partStatus(st.hostelCharged, st.hostelPaid);
    st.paidPercent = st.sessionTotal
      ? Math.min(100, Math.round((st.collected / st.sessionTotal) * 100)) : 0;
    st.percent = st.totalMonths ? Math.round((st.paidMonths / st.totalMonths) * 100) : 0;
    st.status = !st.totalMonths ? 'none'
      : !st.balance ? 'cleared'
        : st.overdueMonths ? 'overdue'
          : st.partialMonths ? 'partial' : 'due';
  }
  return list;
}

/** One-line summary for a filter, used on the fees page. */
function summary({ classId = 0, q = '' } = {}) {
  const list = ledger({ classId, q });
  const totals = {
    students: list.length,
    collected: 0, pending: 0, overdue: 0, fine: 0, sessionTotal: 0,
    paidMonths: 0, totalMonths: 0,
    cleared: 0, dueStudents: 0, overdueStudents: 0, partialStudents: 0,
  };
  for (const st of list) {
    totals.collected += st.collected;
    totals.pending += st.pending;
    totals.overdue += st.overdueAmount;
    totals.fine += st.fineTotal;
    totals.sessionTotal += st.sessionTotal;
    totals.paidMonths += st.paidMonths;
    totals.totalMonths += st.totalMonths;
    if (st.status === 'cleared') totals.cleared++;
    else totals.dueStudents++;
    if (st.overdueMonths) totals.overdueStudents++;
    if (st.partialMonths) totals.partialStudents++;
  }
  for (const k of ['collected', 'pending', 'overdue', 'fine', 'sessionTotal']) totals[k] = money(totals[k]);
  return totals;
}

/**
 * Money that actually came in — today and this month, for the office's own filter scope.
 *
 * `fee_payments.paid_on` is stored as DD/MM/YYYY in the school's own day (IST), so both
 * figures are string matches against that same format: never a timezone guess.
 * @returns {{ today: number, todayCount: number, month: number, monthCount: number, monthLabel: string }}
 */
function collections({ classId = 0 } = {}) {
  const now = time.istNow();
  const today = time.todayDMY();                       // DD/MM/YYYY, IST
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const monthTail = `%/${mm}/${now.getFullYear()}`;    // any day of this month
  const scope = classId ? 'AND s.class_id = ?' : '';
  const args = classId ? [classId] : [];

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN p.paid_on = ?  THEN p.amount END), 0) AS today,
      COALESCE(SUM(CASE WHEN p.paid_on LIKE ? THEN p.amount END), 0) AS month,
      COALESCE(SUM(CASE WHEN p.paid_on = ?  THEN 1 END), 0) AS today_n,
      COALESCE(SUM(CASE WHEN p.paid_on LIKE ? THEN 1 END), 0) AS month_n
    FROM fee_payments p JOIN students s ON s.id = p.student_id
    WHERE 1=1 ${scope}`).get(today, monthTail, today, monthTail, ...args);

  return {
    today: money(row.today),
    todayCount: row.today_n,
    month: money(row.month),
    monthCount: row.month_n,
    monthLabel: time.fmt(now, { month: 'long', year: 'numeric' }),
  };
}

/**
 * Who still owes money — the list behind the one-click reminder.
 *
 * A month counts as due once its **due date has passed** (`overdueOnly`, the
 * default): the later months of the session (Apr → Mar) are not "due" in
 * September just because they are unpaid. Passing `overdueOnly: false` gives
 * every student with an outstanding balance on any month.
 * @returns {Array<{ id, full_name, class_name, section, parent_user_id, parent_name,
 *                   parent_phone, months, monthsCount, due, fine }>}
 */
function dues({ classId = 0, overdueOnly = true } = {}) {
  const today = startOfToday();
  const out = [];
  for (const st of ledger({ classId })) {
    const late = st.months.filter(m =>
      m.balance > 0 && (!overdueOnly || isOverdue(m, today)));
    if (!late.length) continue;
    // A hostel student's reminder must say that the hostel part is in the amount — the
    // family is paying for food and lodging as well, and the office needs to see it too.
    const hostelLate = late.filter((m) => m.rate === 'hostel');
    out.push({
      id: st.id, full_name: st.full_name, roll_no: st.roll_no,
      class_id: st.class_id, class_name: st.class_name, section: st.section,
      parent_user_id: st.parent_user_id, parent_name: st.parent_name, parent_phone: st.parent_phone,
      stay: st.stay, isBoarder: st.isBoarder, hostel_bed: st.hostel_bed,
      months: late,
      monthsCount: late.length,
      hostelMonths: hostelLate.length,
      // what is owed, said the way the parent's page says it: the school fee and the hostel fee
      // (mess & lodging) as two separate asks, with the late fine beside them
      schoolDue: money(late.reduce((a, m) => a + m.schoolBalance, 0)),
      hostelDue: money(late.reduce((a, m) => a + m.hostelBalance, 0)),
      fineDue: money(late.reduce((a, m) => a + m.fineBalance, 0)),
      due: money(late.reduce((a, m) => a + m.balance, 0)),
      fine: money(late.reduce((a, m) => a + m.fine, 0)),
    });
  }
  return out;
}

/**
 * Record ONE payment over SEVERAL months, oldest first.
 *
 * The office does not think in months when a parent hands over money — "he gave Rs.3,000" —
 * and a parent paying from home sends one amount too. So a lump is spread over the months
 * that still owe money, oldest first, stopping when the money runs out: Rs.3,000 over
 * Rs.1,300 installments settles May and June and puts Rs.400 into July. One receipt per
 * month touched, so the ledger, the parent's history and every total stay in one piece.
 *
 * `months` (fee ids) only decides the ORDER — a month the parent named is filled before the
 * rest, which is what makes an advance payment land in the month the parent meant.
 * @returns {{ ok: boolean, error?: string, receipts?: Array<{fee_id, term, amount}>, total?: number }}
 */
function recordAuto({ studentId, amount, paidOn, mode = 'Cash', note = '', months = [], part = '' } = {}) {
  const value = money(amount);
  if (!(value > 0)) return { ok: false, error: 'Enter the amount received (more than zero).' };
  const student = studentLedger(studentId);
  if (!student) return { ok: false, error: 'That student is not in the fee ledger.' };

  const named = (months || []).map((n) => parseInt(n, 10)).filter(Boolean);
  const open = student.months.filter((m) => m.balance > 0);
  // the months the payer meant come first (in the order they named them), then the rest of
  // the session in order — so an unnamed lump always pays the oldest debt first
  const order = named
    .map((id) => open.find((m) => m.id === id))
    .filter(Boolean)
    .concat(open.filter((m) => !named.includes(m.id)));

  const owed = money(open.reduce((a, m) => a + m.balance, 0));
  if (value > owed + EPS) {
    return {
      ok: false,
      error: `That is more than the balance of Rs.${Math.round(owed).toLocaleString('en-IN')} on the whole session.`,
    };
  }

  const receipts = [];
  let left = value;
  const write = db.transaction(() => {
    for (const m of order) {
      if (left <= EPS) break;
      const take = money(Math.min(m.balance, left));
      if (!(take > 0)) continue;
      const r = recordPayment({ feeId: m.id, studentId, amount: take, paidOn, mode, note, part });
      if (!r.ok) throw new Error(r.error);
      receipts.push({ fee_id: m.id, term: m.term, amount: take });
      left = money(left - take);
    }
  });
  try {
    write();
  } catch (e) {
    return { ok: false, error: e.message || 'That payment could not be recorded.' };
  }
  return { ok: true, receipts, total: value, left: money(left) };
}

// ------------------------------------------------------------
// Claims — a parent says “I have paid this much”, the office confirms it
// ------------------------------------------------------------
// The parent's own words, kept as a row the office acts on. A claim never changes a
// month by itself: `recordClaim()` runs the money model (`recordAuto`) and only then does
// the ledger move — the same rule every other payment follows.

const CLAIM_STATUS = ['pending', 'recorded', 'rejected'];

/** One claim, with the student it belongs to (null when the id is unknown). */
function claim(id) {
  return db.prepare(`
    SELECT c.*, s.full_name, s.class_id, cl.name AS class_name, cl.section,
           u.full_name AS parent_name, u.phone AS parent_phone
    FROM fee_claims c
    JOIN students s ON s.id = c.student_id
    JOIN classes cl ON cl.id = s.class_id
    LEFT JOIN users u ON u.id = c.parent_user_id
    WHERE c.id = ?`).get(id) || null;
}

/** The months a claim names, as `fees` rows the view can print (term + balance now). */
function claimMonths(row) {
  let ids = [];
  try { ids = JSON.parse(row.months || '[]'); } catch (e) { ids = []; }
  const out = [];
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const m = db.prepare(`SELECT id, term, amount, fine, paid_amount FROM fees WHERE id = ? AND student_id = ?`)
      .get(id, row.student_id);
    if (!m) continue;
    const now = toMonth({ ...m, fee_id: m.id, due_date: null, paid_date: null, fine_note: '' }, startOfToday());
    out.push({ id: m.id, term: m.term });
    out[out.length - 1].balance = now.balance;
  }
  return out;
}

/** Decorate a claim row for the office's list. */
function withClaimExtras(row) {
  if (!row) return row;
  const out = { ...row };
  out.monthList = claimMonths(row);
  try { out.recordedList = JSON.parse(row.recorded || '[]'); } catch (e) { out.recordedList = []; }
  return out;
}

/**
 * A parent files a claim: “I have paid Rs.X by UPI, reference …”.
 * Refused when it is not money (zero/negative) or more than the whole session's balance —
 * a claim above the debt would only ever be rejected by the office.
 */
function createClaim({
  studentId, parentUserId = null, amount, mode = 'UPI', reference = '', note = '',
  photo = '', months = [], paidOn = '',
} = {}) {
  const value = money(amount);
  if (!(value > 0)) return { ok: false, error: 'Enter the amount you paid (more than zero).' };
  if (value > 10000000) return { ok: false, error: 'That amount looks wrong — please check it.' };
  const student = studentLedger(studentId);
  if (!student) return { ok: false, error: 'This child is not in the fee ledger yet.' };
  if (value > money(student.balance) + EPS) {
    return {
      ok: false,
      error: `Your pending fee is Rs.${Math.round(student.balance).toLocaleString('en-IN')} — please check the amount.`,
    };
  }
  const ids = (months || []).map((n) => parseInt(n, 10)).filter(Boolean);
  const info = db.prepare(`INSERT INTO fee_claims
      (student_id, parent_user_id, amount, mode, reference, note, photo, months, paid_on)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(studentId, parentUserId, value, PAY_MODES.includes(mode) ? mode : 'UPI',
      (reference || '').slice(0, 60) || null, (note || '').slice(0, 300) || null,
      photo || null, JSON.stringify(ids), paidOn || time.todayDMY());
  return { ok: true, id: info.lastInsertRowid, amount: value };
}

/** Every waiting claim, newest first — the office's “somebody says they paid” list. */
function pendingClaims({ limit = 60 } = {}) {
  return db.prepare(`
    SELECT c.*, s.full_name, s.class_id, cl.name AS class_name, cl.section,
           u.full_name AS parent_name, u.phone AS parent_phone
    FROM fee_claims c
    JOIN students s ON s.id = c.student_id
    JOIN classes cl ON cl.id = s.class_id
    LEFT JOIN users u ON u.id = c.parent_user_id
    WHERE c.status = 'pending'
    ORDER BY c.id DESC LIMIT ?`).all(limit).map(withClaimExtras);
}

/** How many claims are waiting, and how much money they are about (for the badges). */
function claimStats() {
  const row = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount), 0) total
                          FROM fee_claims WHERE status = 'pending'`).get();
  return { pending: row.n, amount: money(row.total) };
}

/**
 * One student's claims — what the parent sees, and what the office sees on their page.
 * The child's own name / class travel with each row (a claim is shown in three places and
 * the office's confirm line reads the name out loud), read from the same joins as
 * `pendingClaims()` so both lists are shaped alike.
 */
function studentClaims(studentId, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT c.*, s.full_name, s.class_id, cl.name AS class_name, cl.section,
           u.full_name AS parent_name, u.phone AS parent_phone
    FROM fee_claims c
    JOIN students s ON s.id = c.student_id
    JOIN classes cl ON cl.id = s.class_id
    LEFT JOIN users u ON u.id = c.parent_user_id
    WHERE c.student_id = ?
    ORDER BY c.id DESC LIMIT ?`).all(studentId, limit).map(withClaimExtras);
}

/**
 * The office confirms a claim: the money is recorded over the months (the ones the parent
 * named first, then oldest first) and the claim is closed. Returns everything the caller
 * needs to notify the parent and to leave the office a record of what happened.
 */
function recordClaim({ claimId, decidedBy = '', note = '' } = {}) {
  const row = claim(claimId);
  if (!row) return { ok: false, error: 'That claim is no longer there.' };
  if (row.status !== 'pending') return { ok: false, error: 'That claim has already been decided.' };
  const ids = (() => { try { return JSON.parse(row.months || '[]'); } catch (e) { return []; } })();
  const res = recordAuto({
    studentId: row.student_id, amount: row.amount, paidOn: row.paid_on,
    mode: row.mode, note: `Claimed by parent #${row.id}`, months: ids,
  });
  if (!res.ok) return { ok: false, error: res.error, row };
  db.prepare(`UPDATE fee_claims SET status = 'recorded', decided_at = datetime('now'),
              decided_by = ?, decision_note = ?, recorded = ? WHERE id = ?`)
    .run(decidedBy || null, note || null, JSON.stringify(res.receipts), row.id);
  return { ok: true, row, receipts: res.receipts, total: res.total };
}

/** The office says “we have not received this” — the parent is told why. */
function rejectClaim({ claimId, decidedBy = '', note = '' } = {}) {
  const row = claim(claimId);
  if (!row) return { ok: false, error: 'That claim is no longer there.' };
  if (row.status !== 'pending') return { ok: false, error: 'That claim has already been decided.' };
  db.prepare(`UPDATE fee_claims SET status = 'rejected', decided_at = datetime('now'),
              decided_by = ?, decision_note = ? WHERE id = ?`)
    .run(decidedBy || null, note || null, row.id);
  return { ok: true, row };
}

/** Everything one student's page needs — totals plus the receipts, newest first. */
function studentLedger(studentId) {
  const [student] = ledger({ studentId });
  if (!student) return null;
  student.receiptList = student.months
    .flatMap(m => m.receipts.map(r => ({ ...r, term: m.term })))
    .sort((a, b) => b.id - a.id);
  student.receivedTotal = money(student.months.reduce((a, m) => a + m.paid_amount, 0));
  return student;
}

module.exports = {
  SESSION_MONTHS, PAY_MODES, PAY_PARTS, PAY_PART_KEYS, MONTH_STATUS, STUDENT_STATUS, CLAIM_STATUS,
  syncStudent, retuneStudent, retuneClass, ratesByClass, rateFor,
  ledger, summary, dues, collections, studentLedger,
  recordPayment, recordAuto, clearReceipts, setFine, recompute,
  splitOf, splitMonth, partStatus,
  createClaim, claim, claimStats, pendingClaims, studentClaims, recordClaim, rejectClaim,
  payable, parseDue, startOfToday, money,
  sessionTerms, sessionStartYear,
};
