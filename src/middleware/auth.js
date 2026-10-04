/**
 * Route guards. Every guard is written so a page can never rely on the sidebar
 * alone: hiding a link is cosmetics, this is the lock.
 *
 *   requireRole('admin')     — only the school office
 *   requireTeacher()         — a teacher whose login is switched ON. Also loads
 *                              the teacher row onto `req.teacher` and the granted
 *                              sections onto `res.locals`, so every teacher view
 *                              and the sidebar share ONE source of truth.
 *   requirePerm('marks')     — and THIS section must have been granted by the office.
 *   withClass()              — and which class the page is about, out of the
 *                              classes the office gave him. A class id typed into
 *                              the URL or the form is only ever accepted if it is
 *                              one of those; otherwise the first class he really
 *                              has is used. Views print `viewClass`.
 *   requireParentSection(k)  — the parent app's twin of `requirePerm`: the office can
 *                              switch any parent section off (Admin → Parent Access),
 *                              and a child whose fee is due can be closed down to Fees
 *                              only. Reads `res.locals.parentAccess`, which the parent
 *                              routes fill in (src/services/parent_access.js).
 */
const perm = require('../services/permissions');
const parentAccess = require('../services/parent_access');

// Require a logged-in user
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// Require a specific role
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', { message: 'Access denied. You do not have permission to view this page.', code: 403 });
    }
    next();
  };
}

/**
 * The teacher portal's front door.
 * A teacher only gets in with a login the office created AND left switched on.
 * The teacher row is re-read on every request, so switching a login off in the
 * admin panel closes the teacher's open session on their very next click.
 */
function requireTeacher() {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    // an admin or a parent who lands on /teacher goes to their own section
    if (req.session.user.role !== 'teacher') {
      return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/parent');
    }
    const teacher = perm.teacherForUser(req.session.user.id);
    if (!teacher || !teacher.can_login) {
      req.session.user = null;
      return res.redirect('/login?off=1');
    }
    req.teacher = teacher;
    res.locals.teacher = teacher;
    res.locals.teacherPerms = perm.forTeacher(teacher.id);
    res.locals.teacherNav = perm.navFor(teacher.id);
    // "the office changed my access" — shown once, on the next page the teacher opens
    const stamp = perm.latestGrantAt(teacher.id);
    res.locals.permChanged = req.session.permSeen !== undefined && req.session.permSeen !== stamp;
    req.session.permSeen = stamp;
    next();
  };
}

/**
 * WHICH class the page is about.
 *
 * A teacher is no longer locked to the class in his own row: the office ticks the
 * classes a login may work on (or switches on "all classes") and this middleware
 * hands the route exactly one of them. Nothing below reads a class id from the
 * URL or the form directly — a hand-typed `?class=99` (or a tampered hidden field)
 * falls back to the first class the teacher really has, so a page can never show
 * another class's children, marks or money.
 *
 * Puts on every teacher view:
 *   `viewClass`   — the class this page is about (id, name, section, label, own)
 *   `viewClasses` — every class he may switch to, each with its own `href`
 *   `multiClass`  — true when there is more than one (the header shows the picker)
 */
function withClass() {
  return (req, res, next) => {
    const teacher = req.teacher
      || (req.session.user ? perm.teacherForUser(req.session.user.id) : null);
    if (!teacher) return res.redirect('/login');
    const allowed = perm.classesFor(teacher);
    if (!allowed.length) {
      return res.status(403).render('error', {
        message: 'No class is open for your login. Please ask the school office to give you a class.',
        code: 403,
      });
    }
    const asked = parseInt(req.query.class || (req.body && req.body.class_id), 10) || 0;
    const current = allowed.find((c) => c.id === asked)
      || allowed.find((c) => c.id === teacher.class_id)
      || allowed[0];
    // switching class keeps the rest of the query string (exam, day, search …)
    const href = (id) => {
      const u = new URL(req.originalUrl, 'http://local');
      u.searchParams.set('class', String(id));
      return u.pathname + (u.search || '');
    };
    req.classRoom = current;
    res.locals.viewClass = current;
    res.locals.viewClasses = allowed.map((c) => ({ ...c, href: href(c.id) }));
    res.locals.multiClass = allowed.length > 1;
    next();
  };
}

/**
 * One section of the teacher portal. Missing grant → 403 with a plain-English
 * sentence the teacher can act on ("ask the school office").
 */
function requirePerm(key) {
  return (req, res, next) => {
    const teacher = req.teacher
      || (req.session.user ? perm.teacherForUser(req.session.user.id) : null);
    if (!teacher) return res.redirect('/login');
    if (!perm.has(teacher.id, key)) {
      const section = perm.byKey(key) || { label: key };
      return res.status(403).render('error', {
        message: `${section.label} is not open for your login. Please ask the school office to give you access to it.`,
        code: 403,
      });
    }
    req.section = perm.byKey(key) || null;
    next();
  };
}

/**
 * Like `requirePerm(key)`, but the page opens READ-ONLY when the section was never
 * granted: `next(false)` tells the route which flavour it is running. `false` also
 * means every writer behind the route must refuse — the same rule the profile page
 * already lives by (no POST route behind it).
 *
 * Why (2026-09-19): the school wants the bottom bar to always show the third icon
 * (Messages) and the second (Timetable) EVEN for a teacher with no grant, so his app
 * never looks broken or half-built. Reading the timetable or the office's notes costs
 * nothing; writing (homework, sending to parents) stays locked behind the office's
 * grant exactly as before.
 */
function requirePermOpen(key) {
  return (req, res, next) => {
    const teacher = req.teacher
      || (req.session.user ? perm.teacherForUser(req.session.user.id) : null);
    if (!teacher) return res.redirect('/login');
    // ALWAYS continue — just say (res.locals.permOpen) whether the granted flavour runs.
    // The route reads the flag to hide its forms; the POST routes behind it keep the hard
    // `requirePerm` guard, so the read-only flavour can never write.
    res.locals.permOpen = perm.has(teacher.id, key);
    next();
  };
}

/**
 * One section of the PARENT app.
 *
 * The office may switch a section off for everybody, and a child with a pending fee
 * may be closed down to Fees only (both rules live in src/services/parent_access.js).
 * The link is not printed in that case — this is the lock behind it, so a parent who
 * still has the old screen open (or types the URL) is answered honestly instead.
 */
function requireParentSection(key) {
  return (req, res, next) => {
    const a = res.locals.parentAccess || parentAccess.forChild(0);
    if (parentAccess.has(a, key)) return next();
    return res.status(403).render('error', { message: parentAccess.denyMessage(key, a), code: 403 });
  };
}

module.exports = { requireLogin, requireRole, requireTeacher, requirePerm, requirePermOpen, requireParentSection, withClass };
