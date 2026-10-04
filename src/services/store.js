/**
 * ============================================================================
 * store.js — WHAT A CHILD TAKES FROM THE SCHOOL STORE (books, uniform, …)
 * ============================================================================
 *
 * A school family pays for more than the monthly fee: a book set, a uniform, a
 * notebook bundle. The office keeps a price list, hands the things over on a day, and
 * the money is collected (in full, or in parts, often together with the fee).
 *
 * Two tables, and one door to each:
 *
 *   • **`store_items` — the price list** the office edits on Admin → Store: name,
 *     category, price, unit (“set”, “piece”), and an on/off switch so an old edition
 *     stops being offered without losing the history of children who took it.
 *
 *   • **`student_items` — what a child actually took.** Each row is ONE hand-over:
 *     the item's name and its price are **copied onto the row** (a price-list edit
 *     must never rewrite an old bill), `qty × unit_price` is stored as `amount`, and
 *     `paid` / `paid_on` / `mode` record the money — a part payment leaves a balance,
 *     exactly like a fee month.
 *
 * WHY IT IS A SEPARATE LEDGER FROM `fees`
 * ---------------------------------------
 * `fees` is one row per child per SESSION MONTH — a fixed, predictable bill the school
 * prints. Books are not monthly: a child takes them once, or twice, or not at all. So
 * they stay out of `fees` (nothing here ever writes a `fees` row, and `fees.js` prices
 * nothing from here), and the two only meet in the **readers**: the parent's fee page
 * shows this bill beside the monthly one, the fee reminder adds the item balance to the
 * amount it asks for, and the office's dashboard counts it. That is why there is no
 * second money model — `paid` means here what `paid_amount` means there.
 *
 * The school's day (IST) stamps every issue and every settlement (`time.todayISO()`), so
 * a receipt dated “today” is today in the school's own timezone, never the server's.
 */
const db = require('../db');
const time = require('./time');
const v = require('./validate');

/** The categories a store item may belong to — the form offers exactly these. */
const CATEGORIES = ['Books', 'Uniform', 'Stationery', 'Other'];
const MODES = ['Cash', 'UPI', 'Bank transfer', 'Adjusted in fee'];

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// the price list
// ---------------------------------------------------------------------------

/** The whole price list, active items first — what Admin → Store edits. */
function catalogue({ includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db.prepare(`SELECT * FROM store_items ${where} ORDER BY active DESC, sort_order, id`).all();
}

/** The items a hand-over form may offer (only what is still sold). */
function sellable() {
  return db.prepare('SELECT * FROM store_items WHERE active = 1 ORDER BY sort_order, id').all();
}

/**
 * Add or update one price-list row from the office's form.
 * `id` absent → a new item; an id → that row updated. A blank name is refused BY NAME
 * (the office must see which line), and the price is a real amount (0 is allowed —
 * a free notebook set is a real thing).
 * @returns {{ ok: boolean, id?: number, created?: boolean, error?: string }}
 */
function saveItem(body = {}) {
  const c = v.checker();
  const name = c.text(body.name, 'Item name', { max: 80, required: true });
  const category = c.choice(body.category, 'Category', CATEGORIES, { fallback: 'Books' });
  const price = c.amount(body.price, 'Price', { required: true, fallback: 0 });
  const unit = c.text(body.unit, 'Unit', { max: 20 });
  if (!c.ok) return { ok: false, error: c.summary };

  const id = parseInt(body.id, 10) || 0;
  const active = String(body.active || '') === '' ? 1 : (String(body.active) === '1' ? 1 : 0);
  if (id) {
    const existing = db.prepare('SELECT 1 FROM store_items WHERE id = ?').get(id);
    if (!existing) return { ok: false, error: 'That item is no longer in the price list.' };
    db.prepare('UPDATE store_items SET name = ?, category = ?, price = ?, unit = ?, active = ? WHERE id = ?')
      .run(name, category, price, unit, active, id);
    return { ok: true, id, created: false };
  }
  const order = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM store_items').get().m || 0) + 10;
  const row = db.prepare('INSERT INTO store_items (name, category, price, unit, active, sort_order) VALUES (?,?,?,?,?,?)')
    .run(name, category, price, unit, 1, order);
  return { ok: true, id: Number(row.lastInsertRowid), created: true };
}

/**
 * Take an item off the price list (or put it back). Nothing is deleted while children
 * have taken it — its history belongs to their bills — so this only stops offering it.
 */
function toggleItem(id, active) {
  const row = db.prepare('SELECT * FROM store_items WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'That item is no longer in the price list.' };
  db.prepare('UPDATE store_items SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return { ok: true, name: row.name, active: !!active };
}

/** Delete a price-list row that has never been handed out (refused otherwise, by name). */
function deleteItem(id) {
  const row = db.prepare('SELECT * FROM store_items WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'That item is no longer in the price list.' };
  const used = db.prepare('SELECT COUNT(*) n FROM student_items WHERE item_id = ?').get(id).n;
  if (used) {
    return { ok: false, error: `${used} student(s) already took “${row.name}”. Switch it off instead — deleting it would erase their record.` };
  }
  db.prepare('DELETE FROM store_items WHERE id = ?').run(id);
  return { ok: true, name: row.name };
}

// ---------------------------------------------------------------------------
// what a child took
// ---------------------------------------------------------------------------

const ROW_COLS = `i.id, i.student_id, i.item_id, i.name, i.category, i.qty, i.unit_price,
                  i.amount, i.issued_on, i.note, i.paid, i.paid_on, i.mode, i.created_at,
                  s.full_name, s.roll_no, s.admission_no, s.parent_user_id,
                  c.name AS class_name, c.section`;

const balanceOf = (r) => money(r.amount - r.paid);
const statusOf = (r) => (balanceOf(r) <= 0 ? 'paid' : (r.paid > 0 ? 'partial' : 'due'));

const shape = (r) => ({
  ...r,
  amount: money(r.amount), paid: money(r.paid), unit_price: money(r.unit_price),
  balance: balanceOf(r), status: statusOf(r),
  class_label: `${r.class_name || ''}${r.section ? ' ' + r.section : ''}`.trim(),
});

/**
 * What one child has taken so far, newest first, with the bill added up.
 * @returns {{ items: Array, charged: number, paid: number, balance: number, dueCount: number }}
 */
function billFor(studentId) {
  const rows = db.prepare(`SELECT ${ROW_COLS} FROM student_items i
      JOIN students s ON s.id = i.student_id
      JOIN classes c ON c.id = s.class_id
      WHERE i.student_id = ? ORDER BY i.issued_on DESC, i.id DESC`).all(studentId).map(shape);
  return {
    items: rows,
    charged: money(rows.reduce((a, r) => a + r.amount, 0)),
    paid: money(rows.reduce((a, r) => a + r.paid, 0)),
    balance: money(rows.reduce((a, r) => a + r.balance, 0)),
    dueCount: rows.filter((r) => r.balance > 0).length,
  };
}

/** One issued row, shaped (for a single settle/delete action). */
function issueById(id) {
  const row = db.prepare(`SELECT ${ROW_COLS} FROM student_items i
      JOIN students s ON s.id = i.student_id
      JOIN classes c ON c.id = s.class_id WHERE i.id = ?`).get(id);
  return row ? shape(row) : null;
}

/**
 * Record ONE hand-over: the office picks a child, an item and a quantity.
 * The name and the price are copied from the price list onto the row (so a later price
 * change cannot rewrite this bill), the amount is stored (qty × price), and the date is
 * the SCHOOL's today unless the office picks another day.
 * @returns {{ ok: boolean, id?: number, error?: string }}
 */
function issue(body = {}) {
  const c = v.checker();
  const studentId = c.id(body.student_id, 'Student');
  const qty = c.int(body.qty, 'Quantity', { min: 1, max: 99, fallback: 1 });
  const issuedOn = c.dateISO(body.issued_on, 'Given on', { notFuture: true });
  const note = c.text(body.note, 'Note', { max: 120 });
  const itemId = parseInt(body.item_id, 10) || 0;
  const item = itemId ? db.prepare('SELECT * FROM store_items WHERE id = ?').get(itemId) : null;
  // a one-off that is not in the price list: the office types the name and the amount
  const freeName = c.text(body.free_name, 'Item', { max: 80 });
  const freePrice = body.free_price === undefined || String(body.free_price).trim() === ''
    ? null : c.amount(body.free_price, 'Amount', { fallback: 0 });
  if (!item && !freeName) { if (c.ok) c.fail('Pick an item from the price list, or type what was given.'); }
  if (!c.ok) return { ok: false, error: c.summary };
  if (!db.prepare('SELECT 1 FROM students WHERE id = ?').get(studentId)) {
    return { ok: false, error: 'That student is no longer on the roll.' };
  }

  const name = item ? item.name : freeName;
  const category = item ? item.category : 'Other';
  const unitPrice = item ? money(item.price) : money(freePrice);
  const amount = money(unitPrice * qty);
  const row = db.prepare(`INSERT INTO student_items
    (student_id, item_id, name, category, qty, unit_price, amount, issued_on, note, paid)
    VALUES (?,?,?,?,?,?,?,?,?,0)`)
    .run(studentId, item ? item.id : null, name, category, qty, unitPrice, amount,
      issuedOn || time.todayISO(), note || null);
  return { ok: true, id: Number(row.lastInsertRowid) };
}

/**
 * Take money for one issue. The office may settle a part of it (a family that pays half
 * now), and the amount is refused if it is more than what is still owed — the same rule
 * the fee ledger uses, so over-paying is impossible on both sides.
 * @returns {{ ok: boolean, paid?: number, balance?: number, error?: string }}
 */
function settle(id, body = {}) {
  const row = issueById(id);
  if (!row) return { ok: false, error: 'That item record no longer exists.' };
  const c = v.checker();
  const amount = c.amount(body.amount, 'Amount received', { required: true, fallback: 0 });
  const mode = c.choice(body.mode, 'Mode', MODES, { fallback: 'Cash' });
  const paidOn = c.dateISO(body.paid_on, 'Received on', { notFuture: true });
  if (!c.ok) return { ok: false, error: c.summary };
  if (amount <= 0) return { ok: false, error: 'Enter the amount received.' };
  if (amount > row.balance) {
    return { ok: false, error: `Only ₹${row.balance.toLocaleString('en-IN')} is left on ${row.name}, so ₹${amount.toLocaleString('en-IN')} cannot be received against it.` };
  }
  const total = money(row.paid + amount);
  const fully = money(row.amount - total) <= 0;
  db.prepare('UPDATE student_items SET paid = ?, paid_on = ?, mode = ? WHERE id = ?')
    .run(total, fully ? (paidOn || time.todayISO()) : (row.paid_on || null), mode, id);
  return { ok: true, paid: total, balance: money(row.amount - total) };
}

/** The office made a mistake on one row: clear its money (the “Mark unpaid” of the store). */
function unsettle(id) {
  const row = issueById(id);
  if (!row) return { ok: false, error: 'That item record no longer exists.' };
  db.prepare('UPDATE student_items SET paid = 0, paid_on = NULL, mode = NULL WHERE id = ?').run(id);
  return { ok: true, name: row.name };
}

/** Remove a row the office added by mistake (its money goes with it). */
function deleteIssue(id) {
  const row = issueById(id);
  if (!row) return { ok: false, error: 'That item record no longer exists.' };
  db.prepare('DELETE FROM student_items WHERE id = ?').run(id);
  return { ok: true, name: row.name, student: row.full_name };
}

// ---------------------------------------------------------------------------
// the readers the pages and the reminders use
// ---------------------------------------------------------------------------

/**
 * The issues list the office works from, newest first.
 * `status` is 'due' (nothing paid), 'partial' (some) or 'paid'; `classId` narrows it to
 * one class, `studentId` to one child (the student's own panel).
 */
function rows({ classId = 0, studentId = 0, status = '', limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (classId) { where.push('s.class_id = ?'); args.push(classId); }
  if (studentId) { where.push('i.student_id = ?'); args.push(studentId); }
  const sql = `SELECT ${ROW_COLS} FROM student_items i
      JOIN students s ON s.id = i.student_id
      JOIN classes c ON c.id = s.class_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY i.issued_on DESC, i.id DESC LIMIT ?`;
  const out = db.prepare(sql).all(...args, limit).map(shape);
  return status ? out.filter((r) => r.status === status) : out;
}

/**
 * Every child who still owes for something, with what they owe — read by the office's
 * dashboard, the class filter's totals and the one-click reminder.
 * @returns {Array<{ student_id, full_name, roll_no, class_label, class_name, section,
 *                   parent_user_id, charged, paid, balance, dueCount, pending: Array }>}
 */
function duesFor({ classId = 0 } = {}) {
  const where = ["i.amount - i.paid > 0"];
  const args = [];
  if (classId) { where.push('s.class_id = ?'); args.push(classId); }
  const rowsAll = db.prepare(`SELECT ${ROW_COLS}, u.full_name AS parent_name, u.phone AS parent_phone
      FROM student_items i
      JOIN students s ON s.id = i.student_id
      JOIN classes c ON c.id = s.class_id
      LEFT JOIN users u ON u.id = s.parent_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.id, s.roll_no, i.issued_on`).all(...args).map(shape);
  const byStudent = new Map();
  for (const r of rowsAll) {
    let st = byStudent.get(r.student_id);
    if (!st) {
      st = {
        student_id: r.student_id, full_name: r.full_name, roll_no: r.roll_no,
        class_name: r.class_name, section: r.section, class_label: r.class_label,
        parent_user_id: r.parent_user_id, parent_name: r.parent_name, parent_phone: r.parent_phone,
        charged: 0, paid: 0, balance: 0, dueCount: 0, pending: [],
      };
      byStudent.set(r.student_id, st);
    }
    st.charged = money(st.charged + r.amount);
    st.paid = money(st.paid + r.paid);
    st.balance = money(st.balance + r.balance);
    st.dueCount++;
    st.pending.push({ name: r.name, qty: r.qty, amount: r.amount, paid: r.paid, balance: r.balance, issued_on: r.issued_on });
  }
  return [...byStudent.values()];
}

/** The school's own totals — the four cards at the top of Admin → Store. */
function summary({ classId = 0 } = {}) {
  const args = classId ? [classId] : [];
  const tail = classId ? 'WHERE s.class_id = ?' : '';
  const row = db.prepare(`SELECT
      COUNT(*) issues,
      COALESCE(SUM(i.amount), 0) charged,
      COALESCE(SUM(i.paid), 0) paid,
      COALESCE(SUM(i.amount - i.paid), 0) balance,
      COUNT(DISTINCT CASE WHEN i.amount - i.paid > 0 THEN i.student_id END) owing
    FROM student_items i JOIN students s ON s.id = i.student_id ${tail}`).get(...args);
  return {
    issues: row.issues,
    charged: money(row.charged),
    paid: money(row.paid),
    balance: money(row.balance),
    owing: row.owing,
    catalogue: db.prepare('SELECT COUNT(*) n FROM store_items WHERE active = 1').get().n,
  };
}

/** How many children still owe for something (the dashboard tile). */
function owingCount() {
  return db.prepare(`SELECT COUNT(DISTINCT student_id) n FROM student_items WHERE amount - paid > 0`).get().n;
}

module.exports = {
  CATEGORIES, MODES,
  catalogue, sellable, saveItem, toggleItem, deleteItem,
  issue, settle, unsettle, deleteIssue, issueById,
  billFor, rows, duesFor, summary, owingCount,
};
