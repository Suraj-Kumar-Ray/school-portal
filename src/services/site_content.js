// Admin-editable website content (key/value store -> site_content table).
// Used by the public "About the school" page and the homepage. Falls back to
// config defaults so pages look complete even before the admin saves anything.
const db = require('../db');
const config = require('../config');
// The rules about what text/flags may look like live in ONE file (validate.js),
// so a change there reaches every website field on this page and on every form.
const v = require('./validate');

// every editable about field; facilities is stored as newline-separated lines
const FIELDS = ['intro', 'established', 'affiliation', 'principalName',
  'principalMessage', 'mission', 'vision', 'facilities'];

// every editable contact-page field
const CONTACT_FIELDS = [
  'ctTimingsHeading', 'ctTime1Label', 'ctTime1Value',
  'ctTime2Label', 'ctTime2Value', 'ctTime3Label', 'ctTime3Value',
  'ctTimeNote',
  'ctPhoneHeading', 'ctPhoneNote',
  'ctMapShow', 'ctMapHeading', 'ctMapAddress', 'ctMapQuery',
  'ctMsgHeading', 'ctMsgNote',
];

// every editable homepage field — the whole landing page is admin-controlled
const HOME_FIELDS = [
  'hero1Kicker', 'hero1Title', 'hero1Sub',
  'hero2Kicker', 'hero2Title', 'hero2Sub',
  'hero3Kicker', 'hero3Title', 'hero3Sub',
  'hero4Kicker', 'hero4Title', 'hero4Sub',
  'statStudents', 'statTeachers', 'statClasses', 'statSince',
  'statLabelStudents', 'statSubStudents',
  'statLabelTeachers', 'statSubTeachers',
  'statLabelClasses', 'statSubClasses',
  'statLabelSince', 'statSubSince',
  'admShow', 'admTitle', 'admSub',
  'feeCtaHeading', 'feeCtaText', 'feePill1', 'feePill2', 'feePill3', 'feePill4',
  'galleryHeading', 'galleryNote',
  'glCaption1', 'glCaption2', 'glCaption3', 'glCaption5', 'glCaption6',
  'hostelShow', 'hostelHeading', 'hostelText', 'hostelPill1', 'hostelPill2', 'hostelPill3',
  'whyHeading',
  'feat1Icon', 'feat1Title', 'feat1Text',
  'feat2Icon', 'feat2Title', 'feat2Text',
  'feat3Icon', 'feat3Title', 'feat3Text',
  'feat4Icon', 'feat4Title', 'feat4Text',
  'howItWorksHeading',
  'hiw1Title', 'hiw1Text', 'hiw2Title', 'hiw2Text',
  'hiw3Title', 'hiw3Text', 'hiw4Title', 'hiw4Text',
  'toppersHeading',
  'aboutHeading', 'aboutIntro',
  'posterShow',
];

function readRows() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM site_content').all()) out[r.key] = r.value;
  return out;
}

// merge DB values over the config defaults (about page)
function getAll() {
  const rows = readRows();
  const about = {};
  for (const f of FIELDS) about[f] = rows[f] !== undefined ? rows[f] : (config.about[f] || '');
  about.facilitiesList = about.facilities.split('\n').map(s => s.trim()).filter(Boolean);
  return about;
}

// homepage settings — DB values override config.home defaults
function getHome() {
  const rows = readRows();
  const def = defaultHome();
  const home = {};
  for (const f of HOME_FIELDS) home[f] = rows[f] !== undefined ? rows[f] : (def[f] || '');
  return home;
}

function defaultHome() {
  const h = config.home || {};
  const hero = h.hero && h.hero.length ? h.hero : [];
  const feat = h.features && h.features.length ? h.features : [];
  const stats = h.stats || {};
  const adm = h.admissions || {};
  const fee = h.feeCta || {};
  const gal = h.gallery || {};
  const cap = gal.captions || {};
  const host = h.hostel || {};
  const hiw = h.howItWorks || {};
  const steps = hiw.steps && hiw.steps.length ? hiw.steps : [];
  const pills = fee.pills && fee.pills.length ? fee.pills : [];
  const hPills = host.pills && host.pills.length ? host.pills : [];
  const pick = (i, k, fallback) => (hero[i] && hero[i][k] !== undefined ? hero[i][k] : fallback);
  const featPick = (i, k, fallback) => (feat[i] && feat[i][k] !== undefined ? feat[i][k] : fallback);
  const stepPick = (i, k, fallback) => (steps[i] && steps[i][k] !== undefined ? steps[i][k] : fallback);
  return {
    hero1Kicker: pick(0, 'kicker', `Session ${config.sessionLabel} · ${config.gradesLabel}`),
    hero1Title: pick(0, 'title', "Education builds your child's future."),
    hero1Sub: pick(0, 'sub', 'Quality education for every child — track results, timetable & fees online.'),
    hero2Kicker: pick(1, 'kicker', 'Parent Portal · Online anytime'),
    hero2Title: pick(1, 'title', "Watch your child's progress from home."),
    hero2Sub: pick(1, 'sub', 'Get a phone alert as soon as results are published — fees, timetable and notices in one place.'),
    hero3Kicker: pick(2, 'kicker', `${config.gradesLabel} · Dedicated Teachers`),
    hero3Title: pick(2, 'title', 'Every class has its own class teacher.'),
    hero3Sub: pick(2, 'sub', 'Find out who teaches which subject — all the information is right here on the website.'),
    hero4Kicker: pick(3, 'kicker', `Admissions Open · Session ${config.sessionLabel}`),
    hero4Title: pick(3, 'title', 'New admission? Apply online.'),
    hero4Sub: pick(3, 'sub', 'A 2-minute form — get your application number and track your status anytime. Hostel also available for boys and girls.'),
    statStudents: stats.students || 560,
    statTeachers: stats.teachers || 28,
    statClasses: stats.classes || 15,
    statSince: stats.since || '2011',
    statLabelStudents: stats.labelStudents || 'Students',
    statSubStudents: stats.subStudents || 'enrolled this session',
    statLabelTeachers: stats.labelTeachers || 'Teachers',
    statSubTeachers: stats.subTeachers || 'dedicated staff',
    statLabelClasses: stats.labelClasses || 'Classes',
    statSubClasses: stats.subClasses || config.gradesLabel,
    statLabelSince: stats.labelSince || 'Since',
    statSubSince: stats.subSince || 'years of trust',
    admShow: adm.show === false ? '0' : '1',
    admTitle: adm.title || `📢 Admissions Open for Session ${config.sessionLabel}`,
    admSub: adm.sub || `${config.gradesLabel} · apply online in 2 minutes · get your application number instantly.`,
    feeCtaHeading: fee.heading || 'Fee — simple, class-wise',
    feeCtaText: fee.text || 'Clear class-wise fees — separate rates for Day Scholars and Hostel students · monthly tuition, one-time admission fee. See the full list on the fee page.',
    feePill1: pills[0] || '', feePill2: pills[1] || '', feePill3: pills[2] || '', feePill4: pills[3] || '',
    galleryHeading: gal.heading || '📸 School life',
    galleryNote: gal.note || 'Classrooms, teachers & activities',
    glCaption1: cap.g1 || '👩‍🏫 Our Teachers — View All →',
    glCaption2: cap.g2 || '😊 Our students',
    glCaption3: cap.g3 || '🧑‍🏫 Classrooms',
    glCaption5: cap.g5 || '🎒 School life',
    glCaption6: cap.g6 || '🚌 School Transport',
    hostelShow: host.show === false ? '0' : '1',
    hostelHeading: host.heading || 'School Hostel — Classes 1 – 10 (Boys & Girls)',
    hostelText: host.text || 'A safe hostel inside the school campus — mess, evening study, security and a resident warden. Hostel + mess ≈ ₹4,500/month. Limited seats.',
    hostelPill1: hPills[0] || '', hostelPill2: hPills[1] || '', hostelPill3: hPills[2] || '',
    whyHeading: h.whyHeading || `Why parents choose ${config.schoolName}`,
    feat1Icon: featPick(0, 'icon', '📈'),
    feat1Title: featPick(0, 'title', 'Online Results'),
    feat1Text: featPick(0, 'text', 'Parents get a phone alert as soon as term results are published.'),
    feat2Icon: featPick(1, 'icon', '💳'),
    feat2Title: featPick(1, 'title', 'Monthly Fee Status'),
    feat2Text: featPick(1, 'text', 'See which months are paid and which are pending — from home.'),
    feat3Icon: featPick(2, 'icon', '📬'),
    feat3Title: featPick(2, 'title', 'Message the School'),
    feat3Text: featPick(2, 'text', 'Any question goes straight to the school office.'),
    feat4Icon: featPick(3, 'icon', '👨‍👩‍👧'),
    feat4Title: featPick(3, 'title', 'One Login, All Children'),
    feat4Text: featPick(3, 'text', "One parent login for every child's results, timetable and fees."),
    howItWorksHeading: hiw.heading || '👨‍👩‍👧 How it works for parents',
    hiw1Title: stepPick(0, 'title', 'Apply online'),
    hiw1Text: stepPick(0, 'text', 'A 2-minute form — no need to visit the school.'),
    hiw2Title: stepPick(1, 'title', 'Get your application number'),
    hiw2Text: stepPick(1, 'text', 'Track your status anytime.'),
    hiw3Title: stepPick(2, 'title', 'School approves'),
    hiw3Text: stepPick(2, 'text', 'The office gets notified and confirms the admission.'),
    hiw4Title: stepPick(3, 'title', 'See everything online'),
    hiw4Text: stepPick(3, 'text', 'Results, timetable, fees and notices — with one login.'),
    toppersHeading: h.toppersHeading || '🏆 Our Class Toppers',
    aboutHeading: h.aboutHeading || `A new era of learning at ${config.schoolName}`,
    aboutIntro: h.aboutIntro || (config.about && config.about.intro) || '',
    posterShow: (h.poster && h.poster.show === false) ? '0' : '1',
  };
}

// save the about fields from a posted form (only non-undefined keys are upserted)
function save(body) {
  saveFields(body, FIELDS);
}

// save homepage fields from a posted form
function saveHome(body) {
  saveFields(body, HOME_FIELDS);
}

// On/off switches. They are stored as exactly '0' or '1' so every reader can
// compare them the same way (a stored 'maybe' used to be read as "on").
const FLAG_FIELDS = ['posterShow', 'admShow', 'hostelShow', 'ctMapShow'];

// How long each kind of text may be. Bigger than any sane value, small enough
// that a pasted essay cannot bloat the page or the database.
const MAX_LEN = 300;          // headings, labels, short lines
const MAX_LONG = 4000;        // paragraphs (about intro, principal message, notes)
const LONG_FIELDS = ['intro', 'principalMessage', 'mission', 'vision', 'facilities',
  'ctTimeNote', 'ctPhoneNote', 'ctMsgNote', 'ctMapAddress'];

/**
 * Save a group of site fields (about / homepage / contact page).
 * This is the ONE cleaner for the admin-editable website text:
 *   • flags become '0' / '1'
 *   • text is trimmed and cut to a sane length (never silently unlimited)
 *   • an unknown key in the form is simply ignored — it is not a column
 * Cross-record rules do not exist here, so nothing can "fail".
 */
function saveFields(body, fields) {
  const upsert = db.prepare(`INSERT INTO site_content (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const txn = db.transaction(() => {
    for (const f of fields) {
      if (body[f] === undefined) continue;
      if (FLAG_FIELDS.includes(f)) {
        // a checkbox that the browser did not send, or sent as "maybe", is OFF
        upsert.run(f, v.isFlag(body[f]) ? '1' : '0');
        continue;
      }
      const max = LONG_FIELDS.includes(f) ? MAX_LONG : MAX_LEN;
      upsert.run(f, v.text(body[f], max));
    }
  });
  txn();
}

// contact page: DB values over config defaults
function getContact() {
  const rows = readRows();
  const def = config.contact || {};
  const out = {};
  for (const f of CONTACT_FIELDS) out[f] = rows[f] !== undefined ? rows[f] : (def[f] || '');
  // merge WhatsApp flags onto the school phone list (row: { number, whatsapp })
  const phones = (config.schoolPhones || []).map(p => ({ number: p.number || p, whatsapp: !!p.whatsapp }));
  if (rows.phoneWhatsappFlags) {
    try {
      JSON.parse(rows.phoneWhatsappFlags).forEach((wa, i) => { if (phones[i]) phones[i].whatsapp = wa; });
    } catch (e) { /* ignore bad JSON */ }
  }
  out.phones = phones;
  return out;
}

function saveContact(body) {
  saveFields(body, CONTACT_FIELDS);
}

module.exports = { FIELDS, HOME_FIELDS, CONTACT_FIELDS, getAll, getHome, getContact, save, saveHome, saveContact };