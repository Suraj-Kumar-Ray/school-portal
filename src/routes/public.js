const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const adm = require('../services/admissions');
const weather = require('../services/weather');   // the sky over the school — sign-in screen
const site = require('../services/site_content');
const wa = require('../services/whatsapp');
const v = require('../services/validate');   // one place for every input rule
const { notify, emailSchool } = require('../services/notify');
const noticesSvc = require('../services/notices');   // one filter for every notice list

const router = express.Router();

// public pages: anonymous only (logged-in users go straight to their portal)
function guestOnly(req, res, next) {
  if (req.session.user) {
    const r = req.session.user.role;
    return res.redirect(r === 'admin' ? '/admin' : r === 'teacher' ? '/teacher' : '/parent');
  }
  next();
}

// The sign-in screen's weather + clock. Public (the screen is for people who are not signed in
// yet), and `no-store` on purpose: the payload carries the server's clock, which the page ticks
// forward — a cached copy would hand the page an old anchor and show the wrong time.
router.get('/weather.json', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await weather.prime());
  } catch (e) { next(e); }
});

router.get('/', guestOnly, (req, res) => {
  const classes = db.prepare('SELECT COUNT(*) c FROM classes').get().c;
  const students = db.prepare('SELECT COUNT(*) c FROM students').get().c;
  const teachers = db.prepare('SELECT COUNT(*) c FROM teachers').get().c;
  // the website shows only all-school notices — exactly the list every parent can see
  const notices = noticesSvc.forAll(4);
  const tickerNotices = noticesSvc.forAll(8);
  // homepage toppers — 3 per class, fully managed by the admin (Admin -> Toppers)
  const topperRows = db.prepare(`
    SELECT class_name, rank_no, name, percentage, photo
    FROM class_toppers ORDER BY sort_order, id`).all();
  const topperGroups = [];
  const byClass = new Map();
  for (const t of topperRows) {
    if (!byClass.has(t.class_name)) {
      const g = { class_name: t.class_name, toppers: [] };
      byClass.set(t.class_name, g);
      topperGroups.push(g);
    }
    byClass.get(t.class_name).toppers.push(t);
  }
  const feeStructure = adm.getFeeStructure();
  const recentApps = db.prepare(`SELECT COUNT(*) c FROM admissions WHERE status = 'Approved'`).get().c;
  const about = site.getAll();
  const home = site.getHome();
  // one-time success banner after an application is submitted (no account yet)
  const applySuccess = req.session.applySuccess || null;
  delete req.session.applySuccess;
  if (applySuccess) applySuccess.originUrl = `${req.protocol}://${req.get('host')}`;
  res.render('public/home', { title: null, classes, students, teachers, notices, tickerNotices, topperGroups, feeStructure, recentApps, about, home, applySuccess });
});

// About the school — content is editable by the admin (Admin → About School)
router.get('/about', guestOnly, (req, res) => {
  const about = site.getAll();
  const counts = {
    classes: db.prepare('SELECT COUNT(*) c FROM classes').get().c,
    students: db.prepare('SELECT COUNT(*) c FROM students').get().c,
    teachers: db.prepare('SELECT COUNT(DISTINCT class_teacher) c FROM classes').get().c,
  };
  res.render('public/about', { title: 'About Us', about, counts });
});

// Fee structure is informational & safe for everyone (anonymous parents, and logged-in
// users who want the full sheet / PDF) — no guestOnly guard here.
router.get('/fee-structure', (req, res) => {
  const groups = adm.getFeeGroups();
  const routes = db.prepare('SELECT * FROM bus_routes ORDER BY sort_order, id').all();
  // snapshot cards at the top of the page — computed from admin-edited class fees,
  // so they never drift from the per-class sheets below
  const all = groups.flatMap(g => g.classes);
  const rng = k => {
    const v = all.map(r => r[k]).filter(n => n > 0);
    if (!v.length) return null;
    return { min: Math.min(...v), max: Math.max(...v) };
  };
  const fmt = o => o
    ? (o.min === o.max ? `₹${o.min.toLocaleString('en-IN')}` : `₹${o.min.toLocaleString('en-IN')} – ₹${o.max.toLocaleString('en-IN')}`)
    : '—';
  const snapshot = {
    adm_day: fmt(rng('adm_day')),
    adm_hostel: fmt(rng('adm_hostel')),
    tuition_day: fmt(rng('tuition_day')),
    tuition_hostel: fmt(rng('tuition_hostel')),
  };
  // true if the admin has uploaded a fee-structure PDF (shown as the Download button)
  const hasFeePdf = fs.existsSync(path.join(__dirname, '..', '..', 'public', 'uploads', 'fee-structure.pdf'));
  res.render('public/fee_structure', { title: 'Fee Structure', groups, routes, snapshot, hasFeePdf });
});

// Our Teachers — teacher profile cards (photo, qualification, experience, rating)
router.get('/teachers', guestOnly, (req, res) => {
  const teachers = db.prepare(`
    SELECT t.id, t.photo, t.qualification, t.experience_years, t.rating, t.bio, t.subject,
           u.full_name, c.name AS class_name, c.section
    FROM teachers t
    JOIN users u ON u.id = t.user_id
    JOIN classes c ON c.id = t.class_id
    ORDER BY c.id`).all();
  res.render('public/teachers', { title: 'Our Teachers', teachers });
});

router.get('/contact', guestOnly, (req, res) => {
  res.render('public/contact', { title: 'Contact Us', sent: req.query.sent, error: req.query.error, ct: site.getContact() });
});

// public contact form — message goes straight to the school office inbox.
// Every rule comes from the shared checker, so this form and the admission form
// cannot drift apart on what a name / phone / email has to look like.
router.post('/contact', (req, res) => {
  const c = v.checker();
  const name = c.name(req.body.name, 'Your name', { required: true });
  const phone = c.phone(req.body.phone, 'Mobile number', { required: true });
  const email = c.email(req.body.email, 'Email');
  const subject = c.text(req.body.subject, 'Subject', { max: 120, min: 3, required: true });
  const message = c.body(req.body.message, 'Message', { max: 2000, min: 10, required: true });
  if (!c.ok) return res.redirect('/contact?error=' + encodeURIComponent(c.first));
  // 'visitor' → this is a stranger writing to the school, so it rings the office's
  // notification dock (`src/services/office_feed.js`), unlike the mail the office sends out.
  notify('email', `Contact form: ${subject} (${name})`,
    `From: ${name}\nPhone: ${phone}${email ? '\nEmail: ' + email : ''}\nSubject: ${subject}\n\n${message}`,
    'visitor');
  res.redirect('/contact?sent=1');
});

// hostel: information + fee structure (fee rows are editable by admin)
router.get('/hostel', guestOnly, (req, res) => {
  const fees = db.prepare('SELECT * FROM hostel_fees ORDER BY sort_order').all();
  const monthlyTotal = fees.filter(f => f.kind === 'monthly').reduce((a, f) => a + f.amount, 0);
  res.render('public/hostel', { title: 'School Hostel', fees, monthlyTotal });
});

router.get('/apply', guestOnly, (req, res) => {
  const classes = db.prepare('SELECT * FROM classes ORDER BY id').all();
  res.render('public/apply', { title: 'Apply for Admission', classes, error: null, values: {} });
});

router.post('/apply', guestOnly, async (req, res, next) => {
  try {
    const d = req.body;
    const classes = db.prepare('SELECT * FROM classes ORDER BY id').all();

    // trim the text fields we care about
    for (const k of ['child_name', 'parent_name', 'parent_phone', 'parent_email', 'address', 'previous_school']) {
      if (typeof d[k] === 'string') d[k] = d[k].trim();
    }

    // ---------- collect ALL mistakes so the parent can fix them in one go ----------
    // The RULES live in src/services/validate.js (shared with the admin forms and
    // the contact page); the WORDING below is parent-facing and gentler, and the
    // applicant sees every problem at once instead of one per attempt.
    const errors = [];
    const isBlank = (x) => !x || !String(x).trim();
    const nameOk = v.isName;

    if (isBlank(d.child_name)) errors.push("Please enter the child's full name");
    else if (!nameOk(d.child_name)) errors.push("The child's name should use letters only (at least 2 letters)");

    // Date of birth: no age limit — a child of any age can apply.
    // The only rule is that the date cannot be in the future.
    if (!isBlank(d.child_dob)) {
      const dob = new Date(d.child_dob);
      if (isNaN(dob.getTime()) || dob > new Date()) errors.push('Date of birth is not valid (cannot be in the future)');
    }

    if (isBlank(d.class_id)) errors.push('Please select a class');

    if (isBlank(d.parent_name)) errors.push("Please enter the parent/guardian's name");
    else if (!nameOk(d.parent_name)) errors.push("The parent/guardian's name should use letters only");

    // phone: exactly 10 digits, starting 6-9 (Indian mobile)
    const phone = v.digits(d.parent_phone);
    d.parent_phone = phone;
    if (isBlank(phone)) errors.push('Phone number is required (10 digits)');
    else if (phone.length !== 10) errors.push(`The phone number has only ${phone.length} digits — 10 digits are needed`);
    else if (!v.isPhone(phone)) errors.push('The phone number should start with 6, 7, 8 or 9');

    // email: if given, must look like an email
    if (!isBlank(d.parent_email) && !v.isEmail(d.parent_email)) {
      errors.push('Invalid email — enter it like rahul@gmail.com (with @ and .com)');
    }

    // no username/password here — the school office creates the parent login
    // after approving the admission (Admin → Admissions → Create Parent Login)

    if (errors.length) {
      return res.status(400).render('public/apply', {
        title: 'Apply for Admission', classes,
        error: errors.map(e => `<li>${e}</li>`).join(''),
        values: d,
      });
    }

    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(parseInt(d.class_id, 10));
    if (!cls) return res.status(400).render('public/apply', { title: 'Apply for Admission', classes, error: 'Invalid class selected.', values: d });

    // application only — no account is created at this stage
    const className = `${cls.name}${cls.section ? ' ' + cls.section : ''}`;
    const applicationNo = await adm.createApplication({ ...d, class_name: className }, null);

    // WhatsApp alerts (never block the form if a gateway is slow/unavailable)
    const appInfo = {
      applicationNo, childName: d.child_name, childDob: d.child_dob,
      className, parentName: d.parent_name, parentPhone: d.parent_phone,
      parentEmail: d.parent_email, address: d.address, previousSchool: d.previous_school,
      statusUrl: `${req.protocol}://${req.get('host')}/apply/status`,
    };
    let waParent = 'demo', waSchool = 'demo';
    try {
      [waParent, waSchool] = await Promise.all([
        wa.admissionConfirmation(appInfo),
        wa.admissionToSchool(appInfo),
      ]);
    } catch (e) { /* gateway hiccup — the application itself is safe */ }
    const waChatUrl = wa.clickToChatUrl(appInfo);

    // back to the home page with a success banner (the parent has no account yet)
    req.session.applySuccess = { applicationNo, childName: d.child_name, parentName: d.parent_name, phone: d.parent_phone, waParent, waSchool, waChatUrl };
    res.redirect('/?applied=' + encodeURIComponent(applicationNo));
  } catch (err) {
    next(err);
  }
});

// public application status check — by application number + parent phone (no login needed)
router.get('/apply/status', (req, res) => {
  res.render('public/apply_status', { title: 'Application Status', app: null, searched: false, no: '' });
});

router.post('/apply/status', (req, res) => {
  // length-capped + digits-only, so the lookup can only ever be a plain string
  const no = v.text(req.body.application_no, 20).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const phone = v.digits(req.body.parent_phone).slice(0, 10);
  const app = no && phone
    ? db.prepare(`SELECT a.*, c.name AS class_name, c.section FROM admissions a JOIN classes c ON c.id = a.class_id
                  WHERE UPPER(a.application_no) = ? AND a.parent_phone = ?`).get(no, phone)
    : null;
  res.render('public/apply_status', { title: 'Application Status', app: app || null, searched: true, no });
});

module.exports = router;