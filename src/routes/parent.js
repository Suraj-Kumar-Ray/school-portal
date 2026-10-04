const express = require('express');
const db = require('../db');
const svc = require('../services/portal');
const adm = require('../services/admissions');
const msg = require('../services/messages');
const tt = require('../services/timetable');
const examSvc = require('../services/exam_timetable'); // exam date-sheet (timetable paused)
const feeSvc = require('../services/fees');  // instalments, part payments and fines
const payments = require('../services/payments'); // where a parent sends the money (UPI · bank · QR)
const analysis = require('../services/analysis'); // results as rings: overall · subjects · terms
const time = require('../services/time');    // every date the portal stores is the school's (IST) day
const v = require('../services/validate');   // one place for every input rule
const access = require('../services/parent_access'); // what the OFFICE lets a parent see
const hostelSvc = require('../services/hostel');     // the mess menu, the daily routine, his bed
const storeSvc = require('../services/store');       // books, uniform: what he took from the store
const staySvc = require('../services/stay');         // day scholar or hostel student (the sent fee)
const hold = require('../services/holidays');         // the days the school is shut besides Sunday
const hw = require('../services/homework');           // what was given, period by period (2026-09-18)
const { requireRole, requireParentSection } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('parent'));

// ---------- WHAT THE SCHOOL LETS THIS PARENT SEE ----------
// The office owns two switches (Admin → Parent Access): each section can be closed for
// everybody, and a child whose fee is due can be closed down to Fees only. They are read
// on EVERY parent request — including the two message routes below, which sit before the
// child is known — so switching a section off closes an open session on the next tap.
// `res.locals.parentAccess` is the ONE answer every page, the sidebar and the phone tab
// bar read (src/services/parent_access.js).
router.use((req, res, next) => {
  const a = access.forChild(0);           // switches only — no child known here yet
  res.locals.parentAccess = a;
  res.locals.parentNav = access.navFor(a);
  res.locals.parentTabs = access.tabFor(a);
  next();
});

// ---------- NOTIFICATION FEED ----------
// The parent app asks this every few seconds while it is open. When the school
// sends something new (fee paid, notice, result, PTM invite) the phone plays a
// sound and shows a bright pop-up card. Small JSON — messages + class notices.
router.get('/alerts.json', (req, res) => {
  const uid = req.session.user.id;
  const messages = msg.getSchoolMessages(uid).slice(0, 6).map(m => ({
    key: 'm' + m.id,
    kind: 'message',
    category: m.category,
    subject: m.subject,
    body: m.body,
    at: m.created_at,
    unread: m.status !== 'read',
    href: '/parent/messages',
  }));

  const child = db.prepare('SELECT class_id FROM students WHERE parent_user_id = ? ORDER BY id LIMIT 1').get(uid);
  const notices = child ? svc.getClassNotices(child.class_id).slice(0, 3).map(n => ({
    key: 'n' + n.id,
    kind: 'notice',
    category: 'Notice',
    subject: n.title,
    body: n.body,
    at: n.created_at,
    unread: false,
    href: '/parent/notices',
  })) : [];

  const items = messages.concat(notices)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 5);

  res.set('Cache-Control', 'no-store');
  res.json({ unread: msg.parentUnreadCount(uid), items });
});

// ---------- MESSAGES (works even for applicants without children yet) ----------
// This route sits ABOVE the child middleware on purpose — an applicant with no child yet
// still needs the inbox. That also means it must ask the access rules itself, about the
// child it is really showing.

/** The child the inbox is about: the one asked for, else the parent's first child (0 = none). */
function inboxChildId(req) {
  const asked = parseInt(req.query.child, 10) || 0;
  const row = asked
    ? db.prepare('SELECT id FROM students WHERE id = ? AND parent_user_id = ?').get(asked, req.session.user.id)
    : db.prepare('SELECT id FROM students WHERE parent_user_id = ? ORDER BY id LIMIT 1').get(req.session.user.id);
  return row ? row.id : 0;
}

/** Is the inbox open for this child? Renders the 403 itself, so callers just return. */
function inboxOpen(res, childId) {
  const a = access.forChild(childId);
  if (access.has(a, 'inbox')) return true;
  res.status(403).render('error', { message: access.denyMessage('inbox', a), code: 403 });
  return false;
}

router.get('/messages', requireParentSection('inbox'), (req, res) => {
  const uid = req.session.user.id;
  if (!inboxOpen(res, inboxChildId(req))) return;
  // Read what is UNREAD before anything is marked read: the school messages the parent must
  // see flagged NEW, and each conversation's own count of unread replies. Reading the count
  // after the mark made `unread_replies` always 0, so a conversation card could never say
  // “1 new” and could never open itself the way the school-message cards do.
  const newIds = msg.getUnreadSchoolMessageIds(uid);
  const threads = msg.getParentThreads(uid).map(t => ({ ...t, thread: msg.getThread(t.id, uid) }));
  msg.markParentMessagesRead(uid);
  // Each message carries the pieces its CARD shows (amount + one-line preview), read by the
  // service — the view slices `schoolMessages` for the “latest 3 + See all” rule and prints
  // `m.card`, so no template ever parses a message body.
  const schoolMessages = msg.getSchoolMessages(uid).map(m => ({ ...m, card: msg.cardOf(m) }));
  const children = db.prepare(`SELECT s.id, s.full_name, c.name class_name, c.section
    FROM students s JOIN classes c ON c.id = s.class_id WHERE s.parent_user_id = ? ORDER BY s.id`)
    .all(uid);
  // The inbox sits ABOVE the child middleware, so `res.locals.child` does not exist
  // here — the card needs the row fetched by hand, and the fee ledger read for the same
  // child id the inbox decided to show.
  const cardChildId = inboxChildId(req);
  const child = db.prepare(`SELECT s.*, c.name class_name, c.section FROM students s
    JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(cardChildId);
  // the page opens as TWO small cards — Notices and Messages — that a parent toggles
  // between; the class notices ride along here so both cards are filled by this one route
  const classNotices = cardChildId
    ? svc.getClassNotices(db.prepare('SELECT class_id FROM students WHERE id = ?').get(cardChildId).class_id)
    : [];
  // the child card at the top of the page needs the same self-calculated lateness the
  // home and fees pages show in their round seal (null when nothing is late)
  const feePosition = cardChildId ? feeSvc.studentLedger(cardChildId) : null;
  const overdueInfo = (() => {
    const od = feePosition ? feePosition.months.find(m => m.overdue && m.balance > 0 && feeSvc.parseDue(m.due_date)) : null;
    if (!od) return null;
    const days = Math.max(0, Math.floor((feeSvc.startOfToday() - feeSvc.parseDue(od.due_date)) / 86400000));
    return days > 0 ? { days, term: od.term, amount: Math.round(od.balance).toLocaleString('en-IN'), due: od.due_date } : null;
  })();
  res.render('parent/messages', { title: 'Messages', threads, schoolMessages, children, child, childId: cardChildId, categories: msg.CATEGORIES, newIds, overdueInfo, classNotices });
});

/**
 * “I HAVE SEEN THIS ONE” — the ✓ Seen button on the app's own pop-up card (school's request,
 * 2026-09-21).
 *
 * The badge on the child's card and on the Inbox tab counts the messages that are still
 * unread. Until now the ONLY way that number came down was opening the inbox page, so a parent
 * who read the card the app had just put on their screen still found the bell lit — and every
 * new message added one more (“ye nahi no badhte chala jaye”). This marks THAT one message read
 * and answers with the parent's remaining count, so the card can repaint the badge from the
 * school's own number instead of guessing, and the bell stops ringing the moment it reaches 0.
 *
 * A parent can only ever reach his own mail (`markSchoolMessageRead` filters by the logged-in
 * user id). This route is deliberately NOT behind the inbox section switch: the office can
 * close the inbox (and a fee-locked home page hides the bell altogether), but a message the app
 * itself put on the parent's screen is still theirs to mark as read, and a closed section must
 * never leave a badge nobody can clear.
 */
router.post('/messages/seen', (req, res) => {
  const uid = req.session.user.id;
  const id = parseInt(req.body.id, 10) || 0;
  const unread = id ? msg.markSchoolMessageRead(uid, id) : null;
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: unread !== null, unread: unread === null ? msg.parentUnreadCount(uid) : unread });
});

router.post('/messages', requireParentSection('inbox'), async (req, res, next) => {
  try {
    if (!inboxOpen(res, inboxChildId(req))) return;
    const c = v.checker();
    const category = c.choice(req.body.category, 'Category', msg.CATEGORIES, { required: true });
    const subject = c.text(req.body.subject, 'Subject', { max: 120, min: 3, required: true });
    const body = c.body(req.body.body, 'Message', { max: 2000, min: 3, required: true });
    const studentId = c.id(req.body.student_id, 'Child', { required: false });
    if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
    // a parent may only write about their OWN child — the id comes from a form
    if (studentId && !ownsChild(req.session.user.id, studentId)) {
      return res.status(403).render('error', { message: 'That child is not on your account.', code: 403 });
    }
    await msg.sendFromParent({
      parentUserId: req.session.user.id,
      studentId,
      category, subject, body,
    });
    res.redirect('/parent/messages?sent=1');
  } catch (err) { next(err); }
});

/** Is this child linked to the signed-in parent's account? */
function ownsChild(parentUserId, studentId) {
  return !!db.prepare('SELECT 1 FROM students WHERE id = ? AND parent_user_id = ?').get(studentId, parentUserId);
}

router.post('/messages/:threadId/reply', requireParentSection('inbox'), async (req, res, next) => {
  try {
    // an empty reply is not an error — the parent just pressed send too early
    if (!v.text(req.body.body, 2000)) return res.redirect('/parent/messages');
    const c = v.checker();
    const body = c.body(req.body.body, 'Reply', { max: 2000, min: 2, required: true });
    // the thread is looked up BY THIS PARENT — someone else's id finds nothing
    const thread = msg.getThread(req.params.threadId, req.session.user.id);
    if (!thread) return res.status(404).render('error', { message: 'Conversation not found.', code: 404 });
    // the fee rule is about the child the conversation is about
    if (!inboxOpen(res, thread.root.student_id)) return;
    if (!c.ok) return res.status(400).render('error', { message: c.summary, code: 400 });
    await msg.sendFromParent({
      parentUserId: req.session.user.id,
      studentId: thread.root.student_id,
      category: thread.root.category,
      subject: `Re: ${thread.root.subject}`,
      body,
      threadId: thread.root.id,
    });
    res.redirect('/parent/messages?sent=1');
  } catch (err) { next(err); }
});

// list of children linked to this parent account
router.use((req, res, next) => {
  const children = db.prepare(`
    SELECT s.id, s.full_name, s.photo, s.roll_no, s.admission_no, s.dob, s.blood_group,
           c.name AS class_name, c.section
    FROM students s JOIN classes c ON c.id = s.class_id
    WHERE s.parent_user_id = ?
    ORDER BY s.id`).all(req.session.user.id);
  if (!children.length) {
    // no child yet -> show admission application status (pending / rejected)
    const application = adm.getApplicationByUser(req.session.user.id);
    if (application) {
      const app = db.prepare(`
        SELECT a.*, c.name AS class_name, c.section FROM admissions a
        JOIN classes c ON c.id = a.class_id WHERE a.id = ?`).get(application.id);
      return res.render('parent/application', { title: 'Admission Status', app });
    }
    return res.status(404).render('error', { message: 'No children are linked to this account.', code: 404 });
  }
  res.locals.children = children;
  res.locals.childId = parseInt(req.query.child || req.params.child || children[0].id, 10);
  if (!children.find(c => c.id === res.locals.childId)) res.locals.childId = children[0].id;

  // the child whose page is open — every parent page can then offer the
  // "call / WhatsApp the school" buttons (views/partials/child_help.ejs)
  res.locals.child = children.find(c => c.id === res.locals.childId);
  // …and what THIS child's parent may open. Recomputed here because the fee rule is
  // about the child: with the lock on, a child whose fee is due keeps the home page
  // (the amount and the Pay button live there) and Fees, and loses the rest.
  res.locals.parentAccess = access.forChild(res.locals.childId);
  res.locals.parentNav = access.navFor(res.locals.parentAccess);
  res.locals.parentTabs = access.tabFor(res.locals.parentAccess);
  next();
});

router.get('/', (req, res) => {
  const child = res.locals.children.find(c => c.id === res.locals.childId);
  const profile = svc.getStudentProfile(res.locals.childId);
  // The result, read from the ONE analysis service (a written paper and its oral are one
  // subject there — the way a report card reads). The home page shows the single ring on
  // the Overall Average card; the full diagram (subject circles, terms, marks table) lives
  // on /parent/performance, so the home tab carries no second copy of the subject numbers.
  const result = analysis.forStudent(res.locals.childId);
  // ---- is today a holiday? (2026-09-17) ----------------------------------------------------
  // Sunday, or a date the office marked on Admin → Holidays. The home page says it above
  // everything else, in the office's own words, because “no school today” is the first thing
  // a parent needs on a festival morning. Read through services/holidays.js — never here.
  const holidayToday = hold.today();
  const openAgain = holidayToday.isClosed ? hold.nextOpenDay() : null;
  // the fee position, read from the fee service so the app and the office's ledger
  // can never disagree — money received (part payments included), balance and fines
  const position = feeSvc.studentLedger(res.locals.childId);
  const fees = position ? position.months : [];
  const paid = position ? position.receivedTotal : 0;
  // A hostel student's month is TWO bills — the school fee and the hostel fee (mess & lodging) —
  // and the home card names both, because that is the question a boarding family actually has
  // ("have we paid the school fee or the hostel fee?"). Read from the same ledger the fee page
  // and the office use; both are zero for a school-only child.
  const feeTotals = position ? {
    total: position.sessionTotal, paid: position.receivedTotal, balance: position.balance,
    overdue: position.overdueAmount, fine: position.fineTotal,
    overdueMonths: position.overdueMonths, partialMonths: position.partialMonths,
    isBoarder: position.isBoarder,
    schoolCharged: position.schoolCharged, schoolPaid: position.schoolPaid, schoolBalance: position.schoolBalance,
    hostelCharged: position.hostelCharged, hostelPaid: position.hostelPaid, hostelBalance: position.hostelBalance,
    schoolStatus: position.schoolStatus, hostelStatus: position.hostelStatus,
  } : {
    total: 0, paid: 0, balance: 0, overdue: 0, fine: 0, overdueMonths: 0, partialMonths: 0,
    isBoarder: false, schoolCharged: 0, schoolPaid: 0, schoolBalance: 0,
    hostelCharged: 0, hostelPaid: 0, hostelBalance: 0, schoolStatus: 'none', hostelStatus: 'none',
  };
  // The four months the parent most recently had to pay — the first question a parent
  // asks at the office is "did I pay the last months?", so the home page answers it
  // without opening the ledger (school's request, 2026-09-15). Read from the SAME ledger
  // the fees page uses, and only months whose due date has actually arrived are counted
  // (a month with no due date is not "arrived" — never treat a missing date as due).
  const today = feeSvc.startOfToday();
  const dueMonths = position
    ? position.months.filter((m) => { const due = feeSvc.parseDue(m.due_date); return due ? due <= today : false; })
    : [];
  const recentMonths = dueMonths.slice(-4)
    .map((m) => ({ term: m.term, status: m.status, balance: m.balance }));
  // …and the NEXT month still to be paid, shown on its own highlighted line so a parent
  // can pay it before it becomes late. Only months whose due date has NOT arrived count,
  // and a child who has paid the whole session ahead simply has none.
  const nextMonth = position
    ? position.months.find((m) => {
      const due = feeSvc.parseDue(m.due_date);
      return m.balance > 0 && due && due > today;
    })
    : null;
  const upcomingMonth = nextMonth
    ? { term: nextMonth.term, due_date: nextMonth.due_date, balance: nextMonth.balance }
    : null;
  // ---- HOW LATE IS IT? (2026-09-18, self-calculated) -----------------------------------
  // The school asked for a strip that says by itself how many days a payment has been past
  // its due date — nothing stored, nothing to maintain: the day count is worked out right
  // here from the OLDEST unpaid month's due date against today (IST midnight), every time
  // the page loads. When nothing is overdue the strip simply does not exist.
  const oldestOverdue = position
    ? position.months.find((m) => m.overdue && m.balance > 0 && feeSvc.parseDue(m.due_date))
    : null;
  let daysLate = 0;
  if (oldestOverdue) {
    const due = feeSvc.parseDue(oldestOverdue.due_date);
    daysLate = Math.max(0, Math.floor((today - due) / 86400000));
  }
  const overdueInfo = daysLate > 0 ? {
    days: daysLate,
    term: oldestOverdue.term,
    amount: Math.round(oldestOverdue.balance).toLocaleString('en-IN'),
  } : null;
  // ---- HOW MUCH OF EACH LIST THE HOME PAGE SHOWS (school's request, 2026-09-17) -----------
  // “Give me a 'see more', not a page that keeps getting longer.” Every section on the home
  // page is a SHORT peek with a link to the page that holds the whole list, so the home page
  // stays about the same height whether the school has posted 3 notices or 300. The counters
  // (`noticesCount`, `publishedTotal`, `updatesTotal`) are what the links say, so the words
  // and the list can never disagree.
  const HOME_NOTICES = 3;
  const HOME_RESULTS = 2;
  const HOME_UPDATES = 2;
  const classNotices = svc.getClassNotices(profile.class_id);
  const notices = classNotices.slice(0, HOME_NOTICES);
  const newResult = svc.getNewResultAlert(profile.class_id);
  const publishedAll = svc.getPublishedResults(profile.class_id);
  const published = publishedAll.slice(0, HOME_RESULTS);
  const admission = adm.getApplicationByUser(req.session.user.id);
  // portal notifications from the school (fee paid at the office, broadcasts, PTM invites)
  const allUpdates = msg.getSchoolMessages(req.session.user.id);
  // The home page draws the SAME card as the inbox, so each of these carries the pieces the
  // card needs (amount + preview + the whole message) from the one reader, `messages.cardOf`.
  const updates = allUpdates.slice(0, HOME_UPDATES).map(u => ({ ...u, card: msg.cardOf(u) }));
  const unreadUpdates = msg.parentUnreadCount(req.session.user.id);
  // A fee message the parent has NOT read yet turns the Fees Paid card red
  // (school's request, 2026-09-15) — the loudest thing on the page. Three conditions,
  // all needed: the child really owes money, the message is still unread, and it is a
  // message that ASKS for money. A receipt (“Fee paid · …”, “Payment received · …”) and a
  // rejected claim (“Payment not found · …”) carry the same Fee category and must NEVER
  // paint the card red — that would be a false alarm. Opening the inbox marks the message
  // read and the card goes back to normal on its own, so the red is never wallpaper.
  const isReceipt = (u) => /(fee paid|months paid|payment received|payment not found)/i.test(u.subject || '');
  const asksForMoney = (u) => /fee/i.test(u.category || '') || /(fee pending|fine added)/i.test(u.subject || '');
  const feeAlert = feeTotals.balance > 0
    ? (allUpdates.find(u => u.status !== 'read' && asksForMoney(u) && !isReceipt(u)) || null)
    : null;

  // ---- HOSTEL (2026-09-16) ------------------------------------------------------------------
  // A child who LIVES in the hostel gets one more thing on his home page: what he is eating
  // today and how much of this session's fee is the hostel part. A DAY SCHOLAR's home page is
  // untouched — `res.locals.parentAccess.hostel` is already false for him (`parent_access.js`
  // closes the section for a child who is not a boarder), so there is nothing to hide here and
  // no chance of a mess menu appearing for a child who comes from home.
  const isBoarder = !!(res.locals.parentAccess && res.locals.parentAccess.hostel);
  // Today's four meals, from the ONE reader the admin hostel page writes through, so the
  // parent and the office can never see two different menus.
  const hostelToday = isBoarder ? hostelSvc.today() : null;
  const hostelFee = shouldShowHostelFee(position) ? {
    months: position.hostelMonths,
    charged: position.hostelCharged,
    balance: position.hostelBalance,
    // the HOSTEL PART of one hostel month (mess & lodging), read off the ledger's own split.
    // `position.hostelRate` is the whole month (school fee + this), so printing it beside the
    // hostel-only total would read as two different amounts (caught on the live page, 2026-09-16).
    rate: (position.months.find((m) => m.hostelCharge > 0) || {}).hostelCharge || 0,
  } : null;

  res.render('parent/dashboard', {
    title: `Dashboard - ${child.full_name}`, child, profile, fees, paid, feeTotals,
    notices, newResult, published, admission, updates, unreadUpdates,
    noticesCount: classNotices.length,
    // what the “See all …” links are allowed to promise
    publishedTotal: publishedAll.length,
    updatesTotal: allUpdates.length,
    pendingFees: fees.filter(f => f.balance > 0).length,
    result, recentMonths, upcomingMonth,
    // the self-calculated lateness strip (days past the due date) — null when nothing is late
    overdueInfo,
    // is today a holiday? the banner at the top of the page (school's request, 2026-09-17)
    holidayToday, openAgain,
    feeAlert: feeAlert ? { subject: feeAlert.subject, category: feeAlert.category } : null,
    monthsSettled: position ? position.paidMonths : 0,
    monthsTotal: position ? position.totalMonths : 0,
    // the hostel block (null for a day scholar — the view then draws nothing at all)
    hostelToday, hostelFee,
    // books & uniform taken from the school store — every child can take them, so this is NOT
    // gated on the hostel and not a switchable section: it belongs to Fees, which is always open
    items: storeSvc.billFor(res.locals.childId),
    hostelBed: isBoarder && position ? position.hostel_bed : '',
    hostelInfo: isBoarder ? hostelSvc.info() : null,
    stayNote: position ? position.stayNote : '',
  });
});

/**
 * Should the home page carry the hostel-money line at all?
 * Only when the child really is charged the hostel rate in at least one month of this
 * session (`fees.studentLedger` counts those months), and there is money to show. A boarder
 * who joined the hostel next month, or whose hostel months are all paid, simply has none.
 */
function shouldShowHostelFee(position) {
  return !!position && position.hostelMonths > 0 && position.hostelCharged > 0;
}

// The child's result, told twice on purpose: the RINGS first (how is he doing, at a
// glance — one circle per subject, best first, plus a term row), then the term-wise bar
// chart and the marks table for the detail. All three read the same numbers.
router.get('/performance', requireParentSection('result'), (req, res) => {
  const child = res.locals.children.find(c => c.id === res.locals.childId);
  // each row of the marks table carries the band of its own average, so the table shows the
  // same green / amber / red the circles do. A row with NO marks at all stays grey —
  // `band(0)` would call an empty subject “needs help”, which is not true, it is “not entered”.
  // every row's band, the oral rule and the always-visible decimal live in the service
  // (`analysis.marksRows`) — the office's view of the same child reads the same function,
  // so the parent's table and the office's can never drift apart
  const marks = analysis.marksRows(res.locals.childId);
  const result = analysis.forStudent(res.locals.childId);
  res.render('parent/performance', {
    title: `Performance - ${child.full_name}`, child, marks,
    overallAvg: result.overall ? result.overall.value : 0, result,
  });
});

// month-by-month ledger the parent can check: what was charged, what was received
// (in parts if that is how it was paid), any late fine and what is still left.
router.get('/fees', (req, res) => {
  const child = res.locals.children.find(c => c.id === res.locals.childId);
  const position = feeSvc.studentLedger(res.locals.childId);
  // The page reads NEWEST MONTH FIRST (April 2026 = the last card at the bottom),
  // so the list grows upward as the session runs — the school asked for that.
  // `later` marks a month whose due date has not come yet (nothing to pay yet),
  // and `isNext` the one month the parent has to pay next (totals.nextDue).
  const today = feeSvc.startOfToday();
  const nextDueId = position && position.nextDue ? position.nextDue.id : 0;
  const fees = (position ? position.months : []).map((m) => {
    const due = feeSvc.parseDue(m.due_date);
    return {
      ...m,
      later: !!due && due > today && m.balance > 0,
      // ringed in the list: every late month (they are all asked for together) plus the
      // one month to pay when nothing is late yet
      isNext: m.overdue || m.id === nextDueId,
      // the flag itself goes on ONE card: the month to pay first (the oldest unpaid one)
      flag: m.id === nextDueId,
    };
  }).reverse();
  // The “pay next” line aggregates EVERYTHING that is already late, not just the oldest
  // month — the school asks a parent for all the overdue months together. `upcoming` is
  // the next month that is owed but not late yet (usually the running month).
  const session = position ? position.months : [];
  const late = session.filter((m) => m.overdue);
  const upcoming = session.find((m) => m.balance > 0 && !m.overdue) || null;
  const totals = position ? {
    total: position.sessionTotal, paid: position.receivedTotal, balance: position.balance,
    overdue: position.overdueAmount, fine: position.fineTotal,
    overdueMonths: position.overdueMonths, partialMonths: position.partialMonths,
    paidMonths: position.paidMonths, totalMonths: position.totalMonths,
    nextDue: position.nextDue,
    overdueFrom: late.length ? late[0] : null,
    // the late months BY NAME, so "4 months" can never be read as a Apr→Sep run when
    // some months in between were paid
    overdueTerms: late.map((m) => m.term),
    upcoming,
    // ---- the hostel part of this bill (2026-09-16) --------------------------------------
    // A boarder's parent is paying for TWO things in one list: the school fee and the hostel fee
    // (mess & lodging). Both are read from the SAME ledger (`fees.studentLedger` splits every
    // month with `fees.splitMonth`), never re-added here — so the figures on this page, in a
    // reminder and in the office's own ledger can never disagree. A day scholar's hostel part is
    // zero everywhere and his school fee is his whole month.
    isBoarder: position.isBoarder,
    stay: position.stay,
    stayNote: position.stayNote,
    hostelMonths: position.hostelMonths,
    hostelCharged: position.hostelCharged,
    hostelPaid: position.hostelPaid,
    hostelBalance: position.hostelBalance,
    hostelStatus: position.hostelStatus,
    hostelRate: position.hostelRate,
    dayRate: position.dayRate,
    schoolCharged: position.schoolCharged,
    schoolPaid: position.schoolPaid,
    schoolBalance: position.schoolBalance,
    schoolStatus: position.schoolStatus,
    schoolOverdue: position.schoolOverdue,
    hostelOverdue: position.hostelOverdue,
    fineCharged: position.fineCharged,
    finePaid: position.finePaid,
    fineBalance: position.fineBalance,
    hostelBed: position.hostel_bed || '',
  } : {
    total: 0, paid: 0, balance: 0, overdue: 0, fine: 0, overdueMonths: 0, partialMonths: 0,
    paidMonths: 0, totalMonths: 0, nextDue: null, overdueFrom: null, overdueTerms: [], upcoming: null,
    isBoarder: false, stay: 'day', stayNote: '',
    hostelMonths: 0, hostelCharged: 0, hostelPaid: 0, hostelBalance: 0, hostelStatus: 'none',
    hostelRate: 0, dayRate: 0, schoolCharged: 0, schoolPaid: 0, schoolBalance: 0, schoolStatus: 'none',
    schoolOverdue: 0, hostelOverdue: 0, fineCharged: 0, finePaid: 0, fineBalance: 0, hostelBed: '',
  };
  // ---- BOOKS & UNIFORM (the school store, 2026-09-16) --------------------------------------
  // What this child has taken from the school besides the monthly fee, with the money on it.
  // It is a SEPARATE ledger from `fees` (a fee row is one month; a book set is taken once), so
  // the page shows it as its own panel and adds it to the one bill the parent has to settle.
  const items = storeSvc.billFor(res.locals.childId);
  res.render('parent/fees', {
    title: `Fees - ${child.full_name}`, child, fees, totals, items,
    // what the parent has told the school about their payments (and how it ended)
    claims: feeSvc.studentClaims(res.locals.childId, { limit: 6 }),
    receipts: position ? position.receiptList : [],
    // the OLDEST unpaid month — the banner says "past the due date since …", so it must
    // be read from the session order, not from the newest-first list on screen
    firstOverdue: position ? (position.months.find(m => m.overdue) || null) : null,
    // the self-calculated lateness (2026-09-18): days past the oldest overdue due date,
    // worked out here on every load — null when nothing is late (the badge then hides)
    overdueInfo: (() => {
      const od = position ? position.months.find(m => m.overdue && m.balance > 0 && feeSvc.parseDue(m.due_date)) : null;
      if (!od) return null;
      const days = Math.max(0, Math.floor((feeSvc.startOfToday() - feeSvc.parseDue(od.due_date)) / 86400000));
      return days > 0 ? { days, term: od.term, amount: Math.round(od.balance).toLocaleString('en-IN'), due: od.due_date } : null;
    })(),
  });
});

// ---------- PAY FEES (UPI · bank · QR) ----------
// “Where do I send the money?” — answered with the school's own details, read from
// ONE place (services/payments.js, edited on Admin → Fees). The amount at the top is
// what the office asks for in one go: every late month added up, or the month about to
// fall due. Nothing is charged on this page — the parent pays in their own UPI/bank
// app and sends the screenshot; the office records the receipt in Admin → Fees and
// the parent is notified the moment it is marked paid. A parent with nothing pending
// sees a plain “all clear” instead of a pay button.
router.get('/pay', (req, res) => {
  const child = res.locals.children.find(c => c.id === res.locals.childId);
  const position = feeSvc.studentLedger(res.locals.childId);
  const session = position ? position.months : [];
  const late = session.filter(m => m.overdue);
  const upcoming = session.find(m => m.balance > 0 && !m.overdue) || null;
  // the one number the parent acts on: everything that is late, else the next month
  const amount = Math.round(late.reduce((a, m) => a + m.balance, 0) || (upcoming ? upcoming.balance : 0));
  // Months the parent may pay EARLY (2026-09-15): unpaid months that are not late and not
  // the one the school asks for today. Schools do accept advance payment — parents who
  // come to the office in harvest season like to clear two or three months at once — so
  // the page offers the coming months as add-on chips. Only the first four, because a
  // long list turns a simple page into a puzzle.
  const asked = new Set(late.map(m => m.id));
  if (upcoming) asked.add(upcoming.id);
  const advance = session.filter(m => m.balance > 0 && !m.overdue && !asked.has(m.id))
    .slice(0, 4)
    .map(m => ({ id: m.id, term: m.term, balance: m.balance, due_date: m.due_date }));
  // WHAT the money is for, in the parent's own words — the office needs this to post the
  // receipt to the right month ("6 late months (Apr 2026 · …)" / "Oct 2026").
  const dueLabel = late.length
    ? `${late.length} late month${late.length === 1 ? '' : 's'} (${late.map(m => m.term).join(' · ')})`
    : (upcoming ? upcoming.term : '');
  const pay = payments.get();
  const klass = [child.class_name, child.section].filter(Boolean).join(' ');
  const kid = `${child.full_name}${klass ? ' (' + klass + ')' : ''}`;
  // this sentence travels with the UPI link and the WhatsApp screenshot message, so
  // the office sees exactly who paid for whom without asking
  const ref = `Fees — ${kid}`.slice(0, 60);
  const waText = `${ref} — payment done, screenshot attached.`;
  // the self-calculated lateness for the hero badge (same arithmetic as the fees page's
  // “due from N days” round seal): days past the oldest overdue due date, null when clean
  const overdueInfo = (() => {
    const od = session.find(m => m.overdue && m.balance > 0 && feeSvc.parseDue(m.due_date)) || null;
    if (!od) return null;
    const days = Math.max(0, Math.floor((feeSvc.startOfToday() - feeSvc.parseDue(od.due_date)) / 86400000));
    return days > 0 ? { days, term: od.term, amount: Math.round(od.balance).toLocaleString('en-IN'), due: od.due_date } : null;
  })();
  res.render('parent/pay', {
    title: `Pay Fees - ${child.full_name}`, child, pay, overdueInfo,
    ways: payments.ways(pay),                 // the UPI rows
    accounts: payments.accounts(pay),         // one block per bank account (usually two)
    amount, late, upcoming, advance, dueLabel,
    // the months the page is asking for right now — the claim form names them, so the
    // office's one-click “Record” puts the money in exactly the months the parent meant
    dueMonthIds: [...late.map(m => m.id), ...(upcoming ? [upcoming.id] : [])],
    todayISO: time.todayISO(),
    claims: feeSvc.studentClaims(child.id, { limit: 5 }),
    claimSaved: req.query.claim, claimErr: req.query.claimErr || null,
    balance: position ? position.balance : 0,
    paid: position ? position.receivedTotal : 0,
    ref,                                       // the UPI note the page keeps up to date
    upi: payments.upiLink(pay, { note: ref }),
    upiBase: payments.upiLink(pay),           // no amount/note — the page adds them live
    waLink: payments.waLink(pay, waText),
    waBase: payments.waLink(pay),             // the bare wa.me link for the live message
    waText,
    allText: payments.allText(pay, { amount, child: kid, payFor: dueLabel }),
    copyParts: payments.copyParts(pay, { amount, child: kid, payFor: dueLabel }),
  });
});

// ---------- “I HAVE PAID” — the parent tells the school what they sent ----------
// Paying from home cannot move the school's record by itself, so this files a CLAIM for
// the office (Admin → Fees → Payment claims). A claim is never money: only the office
// recording it writes receipts, which is why the parent is told “the school will check”.
// The optional screenshot is resized in the browser before it is sent (see pay.ejs).
router.post('/pay/claim', (req, res) => {
  const child = res.locals.children.find(c => c.id === res.locals.childId);
  const back = (query) => res.redirect(`/parent/pay?child=${child.id}&` + new URLSearchParams(query));
  const c = v.checker();
  const amount = c.amount(req.body.amount, 'Amount you paid', { min: 1, max: 10000000, required: true });
  const mode = c.choice(req.body.mode, 'How you paid', feeSvc.PAY_MODES, { fallback: 'UPI', required: true });
  const reference = c.text(req.body.reference, 'Reference number', { max: 60 });
  const note = c.text(req.body.note, 'Note', { max: 300 });
  const paidOn = c.dateISO(req.body.paid_on, 'Payment date', { notFuture: true });
  const photo = c.image(req.body.photo, 'Payment screenshot', { max: 500000 });
  const months = String(req.body.months || '').split(',').map(s => parseInt(s, 10)).filter(Boolean);
  if (!c.ok) return back({ claimErr: c.first });

  const r = feeSvc.createClaim({
    studentId: child.id, parentUserId: req.session.user.id,
    amount, mode, reference, note, photo, months,
    paidOn: paidOn ? time.dmyFromISO(paidOn) : time.todayDMY(),
  });
  if (!r.ok) return back({ claimErr: r.error });
  res.redirect(`/parent/pay?child=${child.id}&claim=${r.id}`);
});

router.get('/notices', requireParentSection('notices'), (req, res) => {
  const child = res.locals.children.find(c => c.id === res.locals.childId);
  const profile = svc.getStudentProfile(res.locals.childId);
  const notices = svc.getClassNotices(profile.class_id);
  res.render('parent/notices', { title: `Notices - ${child.full_name}`, child, notices });
});

// phone-first timetable: day chips + one big card per period
router.get('/timetable', requireParentSection('timetable'), (req, res) => {
  const child = res.locals.children.find(c => c.id === res.locals.childId);
  const profile = svc.getStudentProfile(res.locals.childId);
  const today = tt.todayName();                       // '' on Sunday (school closed)
  const isSunday = !today;
  // ---- HOLIDAYS (2026-09-17) --------------------------------------------------------------
  // Sunday is a holiday without a row; a festival is a row the office adds on Admin →
  // Holidays. Both land in the SAME place here: every day of the strip carries its date,
  // its holiday (or null) and `isClosed`, worked out by services/holidays.js. The view only
  // prints — it never looks a date up.
  const strip = hold.mark(tt.weekStrip());
  const sunday = hold.mark([tt.sundayOfWeek()])[0];
  const todayEntry = strip.find(d => d.isToday) || (sunday.isToday ? sunday : null);
  // which day is on screen: the one they tapped, else today, else Monday
  const chosen = req.query.day === 'Sunday' ? 'Sunday' : (tt.DAYS.includes(req.query.day) ? req.query.day : '');
  const viewing = chosen ? ([...strip, sunday].find(d => d.name === chosen) || null) : todayEntry;
  const day = (viewing && viewing.name) || today || 'Monday';
  const selected = strip.find(d => d.name === day) || null;
  // the holiday card takes the place of the periods: today when nothing was tapped, or the
  // holiday day the parent tapped. Another day still shows its own periods normally.
  const onHoliday = !!viewing && viewing.isClosed;
  const showingHoliday = onHoliday || (isSunday && !chosen);
  const periods = showingHoliday ? [] : tt.dayPeriods(profile.class_id, day);
  const counts = tt.countsByDay(profile.class_id);
  const { grid, periods: gridPeriods } = tt.weekGrid(profile.class_id);
  // the holiday card's words: the office's own wish first, then a plain reason
  const holidayCard = showingHoliday ? {
    name: (viewing && viewing.holidayName) || 'Sunday',
    greeting: viewing && viewing.holiday ? viewing.holiday.greeting : '',
    note: viewing && viewing.holiday ? viewing.holiday.note : '',
    isToday: !!(viewing && viewing.isToday),
    label: viewing ? viewing.long : tt.todayLabel(),
    isSunday: !!(viewing && viewing.name === 'Sunday'),
  } : null;
  // the school opens again after the LAST closed day in a row — “Monday” has to be true
  // even when the Monday after a festival is closed too
  const openAgain = hold.nextOpenDay({ from: (viewing && viewing.iso) || time.todayISO() });

  res.render('parent/timetable', {
    title: `Time Table - ${child.full_name}`, child, profile,
    // who takes this class — shown beside the child's name (same details as the website)
    classTeacher: svc.getClassTeacher(profile.class_id),
    // exam days: when the office switched exam mode on AND this class has papers, the
    // date-sheet replaces the weekly grid on the page (services/exam_timetable.js).
    exam: examSvc.forClass(profile.class_id),
    days: tt.DAYS, shorts: tt.SHORT, day, selected, periods, counts, strip, sunday, isSunday,
    // the day on screen as the holiday service sees it (Sunday included) — the day chips
    // mark the tapped one from this, and the holiday card reads its greeting/note
    viewing,
    // what a slot can be (subject period · assembly · lunch · games…), so a break reads
    // as a break and not as a class with a teacher
    kinds: tt.KINDS,
    showingHoliday, todayName: today, todayLabel: tt.todayLabel(),
    // the day's homework, keyed by period — each subject period's card prints its own line
    // (services/homework.js: the teacher or the office writes it; an empty note still says
    // “Homework given — please check the copy.” so a parent never reads a blank)
    homeworkDay: showingHoliday ? {} : hw.forDay(profile.class_id, day),
    // how the school marked THIS child (✓ done / ✕ not done), keyed by period. Nothing
    // marked → an empty map → the bands stay plain, exactly as the school asked:
    // a parent is never shown a claim no teacher made.
    homeworkMarks: showingHoliday ? {} : hw.statusesForDay(child.id, day),
    // the holiday card (null on a normal school day) and the day the school opens again
    holidayCard, openAgain,
    holidayLabel: holidayCard ? holidayCard.label : '',
    holidayIsToday: !!(holidayCard && holidayCard.isToday),
    todayISO: time.todayISO(),
    nextSchoolDay: tt.nextSchoolDay(),
    // the coming holidays, nearest first — “is there a long weekend coming?”
    upcomingHolidays: hold.upcoming({ limit: 4 }).map(h => ({
      ...h, dateShort: hold.dayShort(h.date), dateLong: hold.dayLong(h.date),
      when: hold.whenLabel(h.date),
    })),
    // true when the parent is looking at a day that is not today (so we can offer a way back)
    viewingOtherDay: !!chosen && chosen !== (todayEntry ? todayEntry.name : today),
    timeByPeriod: tt.timeByPeriod(),
    grid, gridPeriods,
  });
});

// ================= THE HOSTEL (a boarder's parent only) =================
// When a child lives in the hostel, his parent has one more question every day: what is he
// eating, and how is his day going? The page answers it in the shape a phone wants
// (2026-09-16): a row of SMALL CARDS first — one per thing a parent looks for (today's meals,
// the week, his day, his bed, his school day, the hostel fee) — and the full section opens
// when the card is tapped. On the office's screen every section is simply open.
//
// A boarder's parent also keeps an eye on SCHOOL, so his class, Roll No., his class teacher and
// today's periods are on this page too — the family sees both halves of their child's day in
// one place instead of hopping between tabs.
//
// It opens for a BOARDER only: `requireParentSection('hostel')` is closed for a day
// scholar by `parent_access.forChild()` whatever the office's switch says, and this page
// says so in plain words instead of showing an empty hostel to a child who goes home.
router.get('/hostel', requireParentSection('hostel'), (req, res) => {
  const child = res.locals.children.find(c => c.id === res.locals.childId);
  const profile = svc.getStudentProfile(res.locals.childId);
  const row = db.prepare(`SELECT stay, hostel_from, hostel_until, hostel_bed FROM students WHERE id = ?`)
    .get(res.locals.childId) || {};
  const week = hostelSvc.week();
  const position = feeSvc.studentLedger(res.locals.childId);
  // the SCHOOL half of his day, from the same timetable service the Timetable tab uses: '' on
  // Sunday, and the periods of the class that is running now
  const schoolDay = tt.todayName();
  const schoolPeriods = schoolDay ? tt.dayPeriods(profile.class_id, schoolDay) : [];
  const items = storeSvc.billFor(res.locals.childId);

  res.render('parent/hostel', {
    title: `Hostel - ${child.full_name}`, child, profile,
    week,
    today: week.find(d => d.isToday) || null,
    meals: hostelSvc.MEALS,
    routine: hostelSvc.routine(),
    hostel: hostelSvc.info(),
    bed: row.hostel_bed || '',
    stayNote: staySvc.describe(row),
    // ---- the school half ----
    classTeacher: svc.getClassTeacher(profile.class_id),
    schoolDay: schoolDay || '',
    schoolDayLabel: tt.todayLabel(),
    schoolPeriods,
    schoolHoliday: !schoolDay,
    nextSchoolDay: tt.nextSchoolDay(),
    // the hostel part of the bill, read from the SAME ledger the fee page and the office use
    hostelMonths: position ? position.hostelMonths : 0,
    totalMonths: position ? position.totalMonths : 0,
    hostelRate: position ? position.hostelRate : 0,
    dayRate: position ? position.dayRate : 0,
    hostelBalance: position ? position.hostelBalance : 0,
    hostelCharged: position ? position.hostelCharged : 0,
    hostelPaid: position ? position.hostelPaid : 0,
    hostelStatus: position ? position.hostelStatus : 'none',
    // the SCHOOL fee half of the same months — a boarding family reads both here, exactly as
    // on the fee page (the hostel page is not the whole bill either)
    schoolCharged: position ? position.schoolCharged : 0,
    schoolPaid: position ? position.schoolPaid : 0,
    schoolBalance: position ? position.schoolBalance : 0,
    schoolStatus: position ? position.schoolStatus : 'none',
    balance: position ? position.balance : 0,
    // hostel months whose due date has PASSED and that still carry a balance — the card at the
    // top of this page turns red for them, exactly as the fee card on the home page does, so a
    // family that is behind cannot miss it while scrolling
    hostelOverdueMonths: position
      ? position.months.filter(m => m.rate === 'hostel' && m.balance > 0 && m.overdue).length : 0,
    hostelOverdueMoney: position
      ? position.months.filter(m => m.rate === 'hostel' && m.balance > 0 && m.overdue)
        .reduce((a, m) => a + m.balance, 0) : 0,
    feeMonths: position ? position.months.slice(-3).reverse() : [],
    // books & uniform taken from the store (shown here too — it is the same family's bill)
    items,
  });
});

module.exports = router;