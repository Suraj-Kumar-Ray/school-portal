const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { emailSchool } = require('../services/notify');
const v = require('../services/validate');   // input rules live there, never here

const router = express.Router();

// Parents, the school office and TEACHERS sign in — students never log in
// themselves (they are not allowed phones in school), a parent sees their
// child's data. A teacher login is created and switched on/off by the office,
// and it only opens the sections the office granted (src/services/permissions.js).
const VALID_ROLES = ['parent', 'admin', 'teacher'];
const ROLE_LABELS = { parent: 'Parent', admin: 'Admin', teacher: 'Teacher' };
// where each role lands after signing in
const HOME = { admin: '/admin', parent: '/parent', teacher: '/teacher' };

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const role = VALID_ROLES.includes(req.query.role) ? req.query.role : '';
  // `off=1` is set when a signed-in teacher's login was switched off by the office
  const error = req.query.off
    ? 'This login has been switched off by the school office. Please contact them if this is a mistake.'
    : null;
  res.render('login', { error, role, roleLabel: ROLE_LABELS[role] || '' });
});

router.post('/login', async (req, res, next) => {
  try {
    // The login form is checked too (length/characters), so a hand-written POST
    // cannot flood the query with a megabyte string. The password is compared
    // EXACTLY as typed — never trimmed or cleaned.
    const c = v.checker();
    const username = c.username(req.body.username, 'Username');
    const password = req.body.password === undefined || req.body.password === null
      ? '' : String(req.body.password);
    const role = c.choice(req.body.role, 'Role', VALID_ROLES);
    const selectedRole = role || '';
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).render('login', { error: 'Invalid username or password.', role: selectedRole, roleLabel: ROLE_LABELS[selectedRole] || '' });
    }
    // A teacher login the office switched OFF cannot sign in at all. The office
    // does this when a teacher leaves, instead of deleting the whole record.
    if (user.role === 'teacher') {
      const t = db.prepare('SELECT can_login FROM teachers WHERE user_id = ?').get(user.id);
      if (!t || !t.can_login) {
        return res.status(401).render('login', {
          error: 'This teacher login is switched off. Please contact the school office.',
          role: selectedRole, roleLabel: ROLE_LABELS[selectedRole] || '',
        });
      }
    }
    // make sure the person picked the right role — each role has its own section
    if (selectedRole && user.role !== selectedRole) {
      return res.status(401).render('login', {
        error: `This username is ${ROLE_LABELS[user.role] === 'Admin' ? 'an' : 'a'} ${ROLE_LABELS[user.role]} account. Please go back and choose “${ROLE_LABELS[user.role]}”.`,
        role: selectedRole, roleLabel: ROLE_LABELS[selectedRole] || '',
      });
    }
    req.session.user = { id: user.id, username: user.username, role: user.role, full_name: user.full_name };

    // Notify the school when a parent with a pending admission logs in,
    // so the school can reach out and follow up.
    if (user.role === 'parent') {
      const pending = db.prepare(`
        SELECT a.*, c.name AS class_name FROM admissions a
        JOIN classes c ON c.id = a.class_id
        WHERE a.parent_user_id = ? AND a.status = 'Pending' ORDER BY a.id DESC LIMIT 1`).get(user.id);
      if (pending) {
        await emailSchool(
          `Parent login: ${pending.parent_name} (${pending.application_no})`,
          `${pending.parent_name} just logged into the portal to check their admission application for ${pending.child_name} (${pending.class_name || '—'}).\n\n` +
          `Application : ${pending.application_no}\n` +
          `Phone       : ${pending.parent_phone}\n` +
          `Review it in the admin panel → Admissions and contact the parent.`,
          'visitor'   // the parent's own sign-in — it reached the office from outside
        );
      }
    }
    res.redirect(HOME[user.role] || '/parent');
  } catch (err) {
    next(err);
  }
});

// how a parent installs the phone app — works signed in or not, and the page
// checks the phone's browser live so the office can see what is blocking an install
router.get('/install', (req, res) => res.render('install', { title: 'Install app' }));

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;