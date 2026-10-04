// =====================================================
// School branding & app configuration
// Change these values to rebrand the portal for any school.
//
// NOTE: every value below is a FICTIONAL DEMO default. This is a
// sanitised showcase build — no real school, staff or family data.
// =====================================================

// Optional .env file (no dependency). Used for WhatsApp/email gateways:
//   CALLMEBOT_API_KEY=...      CALLMEBOT_PHONE=910000000000   (free automatic WhatsApp)
//   WHATSAPP_API_URL=...       WHATSAPP_API_KEY=...           (paid provider)
(function loadDotEnv() {
  try {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    }
  } catch (e) { /* .env is optional */ }
})();

module.exports = {
  schoolName: 'GREEN VALLEY PUBLIC SCHOOL',
  schoolTypeLine: 'A CO-ED ENGLISH MEDIUM SCHOOL', // shown right below the school name
  schoolTagline: 'Nursery – Class 10 · Parent, Teacher & Admin Portal',
  gradesLabel: 'Nursery – Class 10',      // shown in nav/footer/hero text
  logoEmoji: '🏫',
  logo: '/images/logo.png',            // school logo (circular) — shown in nav, login & sidebar
  currency: '₹',

  // -------- public website --------
  admissionsOpen: true,                       // shows "Admissions Open" banner on home page
  hostelOpen: true,                           // shows hostel seats banner on home + hostel page
  sessionLabel: '2026 – 2027',                // e.g. current academic session
  schoolEmail: 'office@greenvalley.example',       // main email; where application/notification emails go
  schoolEmailAdmissions: 'admissions@greenvalley.example', // admissions contact
  // DEMO ONLY — every parent-facing alert is redirected here so the showcase never
  // messages a real phone. Replace with the school's own number when deploying for real.
  testWhatsappNumber: '+91 90000 00000',
  schoolPhone: '+91 90000 00000',
  schoolPhones: [
    { number: '+91 90000 00000', whatsapp: true },
  ],
  schoolEmails: [
    'office@greenvalley.example',
    'admissions@greenvalley.example',
  ],
  schoolAddress: 'Main Road, Demo Town — 000000',
  schoolHours: 'Mon – Sat · 8:00 AM – 2:00 PM',

  // -------- the sky over the school (sign-in screen: weather + clock) --------
  // `src/services/weather.js` reads exactly this block out. The coordinates are a
  // neutral point so the free Open-Meteo forecast (no key, no sign-up) still works.
  place: {
    label: 'Demo Town',             // what the sign-in screen calls the school's place
    district: 'Demo District',
    lat: 26.8467,
    lon: 80.9462,
    timezone: 'Asia/Kolkata',       // the school runs on IST — see src/services/time.js
    pin: '000000',
  },

  // -------- hostel --------
  hostel: {
    name: 'School Hostel',
    tagline: 'A safe, clean and caring on-campus home for boys and girls of Classes 1 – 10 who live far from school.',
    classes: 'Classes 1 – 10 (Boys & Girls)',
    warden: 'Hostel Warden',
    wardenPhone: '+91 90000 00011',
    hostelEmail: 'hostel@greenvalley.example',
    location: 'Inside school campus, Main Road',
    capacity: 40,               // seats
    perRoom: 4,                 // students per room
    mess: 'Vegetarian mess — Breakfast, Lunch, Evening snacks & Dinner (7 days)',
    security: 'Gate security round-the-clock · doctor on call · CCTV campus',
  },

  // -------- About the school (public about page; editable by admin) --------
  // Default values shown until the admin edits them from Admin → About School.
  // Seed also writes these into the site_content table on a fresh database.
  about: {
    intro: 'GREEN VALLEY PUBLIC SCHOOL is a trusted neighbourhood school — quality education from Class 1 to 10, a disciplined environment and personal attention for every child. Along with studies, children learn values, sports and computers, so they can move ahead in life after school.',
    established: '2011',
    affiliation: 'State Board pattern · Hindi & English medium',
    principalName: 'Mrs. A. Sharma',
    principalMessage: 'Our aim is not just marks — we build confidence, good habits and understanding in every child. School and parents can follow the child\'s full progress together, because when home and school work together, a child does their best.',
    mission: 'To give every child — whatever their family situation — a good education and strong values, so they can stand on their own feet.',
    vision: 'To make every child of the village educated and capable — one who dreams and has the power to achieve those dreams.',
    facilities: 'Smart classrooms\nComputer lab\nLibrary\nScience practical lab\nPlayground & sports\nSafe drinking water & toilets\nHostel on campus (boys & girls)\nMid-day meal\nSchool transport (limited routes)',
  },

  // -------- Contact page content (timings, phone, map, message form) --------
  contact: {
    ctTimingsHeading: '🕐 School Timings',
    ctTime1Label: 'Classes 1 – 5', ctTime1Value: '8:00 AM – 1:30 PM',
    ctTime2Label: 'Classes 6 – 10', ctTime2Value: '8:00 AM – 2:00 PM',
    ctTime3Label: 'Office', ctTime3Value: '8:00 AM – 2:00 PM (Mon – Sat)',
    ctTimeNote: 'Office hours: Mon – Sat, 8 AM – 2 PM',
    ctPhoneHeading: '📱 Phone / WhatsApp',
    ctPhoneNote: 'Tap a number to call · Office hours: Mon – Sat, 8 AM – 2 PM',
    ctMapShow: '1',
    ctMapHeading: '📍 Find us on the map',
    ctMapAddress: 'Main Road, Demo Town — 000000',
    ctMapQuery: 'Demo Town, India',
    ctMsgHeading: '💬 Send us a message',
    ctMsgNote: 'Your message goes straight to the school office inbox',
  },

  // -------- Homepage content (hero slides, stats, features, about teaser) --------
  // Default values shown until the admin edits them from Admin → Homepage.
  // ALL of these are editable from the admin panel (Admin → Homepage).
  home: {
    hero: [
      { kicker: 'Session 2026 – 2027 · Nursery – Class 10', title: "Education builds your child's future.", sub: 'Quality education for every child — track results, timetable & fees online.' },
      { kicker: 'Parent Portal · Online anytime', title: "Watch your child's progress from home.", sub: 'Get a phone alert as soon as results are published — fees, timetable and notices in one place.' },
      { kicker: 'Nursery – Class 10 · Dedicated Teachers', title: 'Every class has its own class teacher.', sub: 'Find out who teaches which subject — all the information is right here on the website.' },
      { kicker: 'Admissions Open · Session 2026 – 2027', title: 'New admission? Apply online.', sub: 'A 2-minute form — get your application number and track your status anytime. Hostel also available for boys and girls.' },
    ],
    stats: {
      students: 560, teachers: 28, classes: 15, since: '2011',
      labelStudents: 'Students', subStudents: 'enrolled this session',
      labelTeachers: 'Teachers', subTeachers: 'dedicated staff',
      labelClasses: 'Classes', subClasses: 'Nursery – Class 10',
      labelSince: 'Since', subSince: 'years of trust',
    },
    admissions: {
      show: true,
      title: '📢 Admissions Open for Session 2026 – 2027',
      sub: 'Nursery – Class 10 · apply online in 2 minutes · get your application number instantly.',
    },
    feeCta: {
      heading: 'Fee — simple, class-wise',
      text: 'Clear class-wise fees — separate rates for Day Scholars and Hostel students · monthly tuition, one-time admission fee. See the full list on the fee page.',
      pills: [
        'LKG – UKG · tuition ₹1,300 – 1,400/mo',
        'Class 1 – 5 · tuition ₹1,600 – 1,800/mo',
        'Class 6 – 8 · tuition ₹1,900/mo',
        'Class 9 – 10 · tuition ₹2,000/mo',
      ],
    },
    gallery: {
      heading: '📸 School life',
      note: 'Classrooms, teachers & activities',
      captions: {
        g1: '👩‍🏫 Our Teachers — View All →',
        g2: '😊 Our students',
        g3: '🧑‍🏫 Classrooms',
        g5: '🎒 School life',
        g6: '🚌 School Transport',
      },
    },
    hostel: {
      show: true,
      heading: 'School Hostel — Classes 1 – 10 (Boys & Girls)',
      text: 'A safe hostel inside the school campus — mess, evening study, security and a resident warden. Hostel + mess ≈ ₹4,500/month. Limited seats.',
      pills: ['Hostel ₹2,500/mo', 'Mess ₹2,000/mo', 'Caution deposit ₹3,000'],
    },
    whyHeading: 'Why parents choose GREEN VALLEY PUBLIC SCHOOL',
    features: [
      { icon: '📈', title: 'Online Results', text: 'Parents get a phone alert as soon as term results are published.' },
      { icon: '💳', title: 'Monthly Fee Status', text: 'See which months are paid and which are pending — from home.' },
      { icon: '✉️', title: 'Message the School', text: 'Any question goes straight to the school office.' },
      { icon: '👨‍👩‍👧', title: 'One Login, All Children', text: "One parent login for every child's results, timetable and fees." },
    ],
    howItWorks: {
      heading: '👨‍👩‍👧 How it works for parents',
      steps: [
        { title: 'Apply online', text: 'A 2-minute form — no need to visit the school.' },
        { title: 'Get your application number', text: 'Track your status anytime.' },
        { title: 'School approves', text: 'The office gets notified and confirms the admission.' },
        { title: 'See everything online', text: 'Results, timetable, fees and notices — with one login.' },
      ],
    },
    toppersHeading: '🏆 Our Class Toppers',
    aboutHeading: 'A new era of learning at GREEN VALLEY PUBLIC SCHOOL',
    aboutIntro: 'GREEN VALLEY PUBLIC SCHOOL is a trusted neighbourhood school — quality education from Class 1 to 10, a disciplined environment and personal attention for every child. Along with studies, children learn values, sports and computers, so they can move ahead in life after school.',
  },

  // -------- session / security --------
  sessionSecret: process.env.SESSION_SECRET || 'school-portal-secret-key',
  port: parseInt(process.env.PORT, 10) || 3000,
};
