/**
 * ============================================================================
 * validate.js — the ONE place that decides what "valid input" means.
 * ============================================================================
 *
 * Why this file exists
 * --------------------
 * Every page that saves something (admin forms, the public admission form, the
 * parent's messages) used to do its own `String(req.body.x).trim()` and its own
 * checks. That is why a blank student name, a roll number of "abc" or a class id
 * that does not exist could reach the database, and why two forms rejected the
 * same mistake with two different messages.
 *
 * Now every write route asks this file first. If the school ever wants a
 * different rule ("names may contain digits", "PIN code is required"), change it
 * HERE and every form follows — nothing else has to be touched.
 *
 * How to use it in a route
 * ------------------------
 *   const v = require('../services/validate');
 *
 *   router.post('/students', (req, res) => {
 *     const c = v.checker();                                  // 1. one checker per request
 *     const name = c.name(req.body.full_name, 'Student name'); // 2. clean + check, top to bottom
 *     const roll = c.int(req.body.roll_no, 'Roll No.', { min: 1, max: 99 });
 *     const cls  = c.id(req.body.class_id, 'Class');
 *     if (!c.ok) return renderForm(c.first);                   // 3. one message, form comes back
 *     ...                                                      // 4. everything below is safe
 *   });
 *
 * Rules of the house
 * ------------------
 * • A method ALWAYS returns a clean value ('' / null / 0 / false) — even when it
 *   failed — so a route can never insert `undefined`, `NaN` or an object.
 * • A method records a SHORT, human message (in the user's own language style:
 *   simple English) and the first one is shown on the form.
 * • Nothing here throws, and nothing here touches the database. A cross-record
 *   rule ("this roll number is already taken in this class") still belongs to the
 *   route, because only the route can read the table.
 * • Optional fields: pass `required: false` (the default) — a blank value simply
 *   comes back blank and no error is recorded.
 */

/** Trim a value to a string (never `undefined`), cut to `max` characters. */
function text(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

/** A multi-line body of text: trimmed at both ends, inner line breaks kept. */
function multiline(value, max = 4000) {
  return text(value, max);
}

/** Digits only — "1234 5678 9012" and "1234-5678-9012" both become "123456789012". */
function digits(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\D/g, '');
}

// ---------------------------------------------------------------- pure checks
// These answer a yes/no question and are handy in views and services too.

/** Indian mobile: exactly 10 digits, starting 6–9. */
function isPhone(value) {
  return /^[6-9]\d{9}$/.test(digits(value));
}
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(text(value, 120));
}
/** A person's name: letters, spaces, dot, apostrophe and hyphen (2–80 chars). */
function isName(value) {
  return /^[A-Za-z][A-Za-z .'-]{1,79}$/.test(text(value, 80));
}
/** "YYYY-MM-DD" and a real calendar date. */
function isDateISO(value) {
  const s = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
/** 12-digit Aadhaar (checks the shape only — the school verifies the document). */
function isAadhaar(value) {
  return /^\d{12}$/.test(digits(value));
}
/**
 * A clock time the school types for a period: `8`, `8:00`, `08:00`, `8:00 am`.
 * Deliberately the same shape the timetable editor has always accepted —
 * `src/services/timetable.js` turns it into 24-hour form for storage.
 */
function isClock(value) {
  return /^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(text(value, 10));
}
/**
 * A UPI id the parent's payment app can actually pay to: `name@bank`
 * (`greenvalleyvidyavihar@upi`, `9876543210@ybl`). Shape only — the school's
 * app is the real test — but it stops "school UPI" or a bare number being saved
 * as the school's payment address.
 */
function isUpiId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,59}@[A-Za-z][A-Za-z0-9]{1,19}$/.test(text(value, 60));
}
/**
 * An IFSC code: 4 letters (bank) + `0` + 6 alphanumerics (branch), e.g.
 * `SBIN0001234`. Case is ignored — it is stored in capitals.
 */
function isIfsc(value) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(text(value, 20).toUpperCase());
}
/** A checkbox / hidden flag: `1`, `on`, `true`, `yes` → true. */
function isFlag(value) {
  return ['1', 'on', 'true', 'yes'].includes(text(value, 10).toLowerCase());
}
/** A photo the app accepts: an uploaded data-URI, or a file bundled in /images/. */
function isImage(value) {
  if (value === undefined || value === null) return false;
  const s = String(value);   // never truncate — a data-URI is long by nature
  return /^data:image\/(jpeg|png|webp|gif);base64,/.test(s) || /^\/images\//.test(s);
}
/** A positive whole number inside a range (a phone number is NOT an int — use phone). */
function isInt(value, { min = -2147483648, max = 2147483647 } = {}) {
  const s = text(value, 20);
  if (!/^-?\d+$/.test(s)) return false;
  const n = parseInt(s, 10);
  return n >= min && n <= max;
}
/** A number (decimals allowed) inside a range. */
function isAmount(value, { min = 0, max = 100000000 } = {}) {
  const s = text(value, 20);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return false;
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= min && n <= max;
}

// ------------------------------------------------------------------- checker
/**
 * One checker per request. Every method cleans a value and, when the value is
 * not acceptable, records a short message.
 */
function checker() {
  const errors = [];

  /** Record a message (also usable directly for cross-record rules). */
  function fail(message) {
    if (message) errors.push(message);
    return null;
  }

  const api = {
    errors,
    fail,
    get ok() { return errors.length === 0; },
    get first() { return errors[0] || ''; },
    /** All messages as one sentence, for pages that show a single banner. */
    get summary() { return errors.join(' '); },

    /** Free text. `required` decides whether blank is a mistake. */
    text(value, label, { max = 200, required = false, min = 1 } = {}) {
      const s = text(value, max);
      if (!s) { if (required) fail(`${label} is required.`); return ''; }
      if (s.length < min) fail(`${label} is too short — at least ${min} characters.`);
      return s;
    },

    /** A long body of text (notice, message, bio, address…). */
    body(value, label, { max = 4000, required = false, min = 1 } = {}) {
      return api.text(value, label, { max, required, min });
    },

    /** A person's name. */
    name(value, label, { required = false } = {}) {
      const s = text(value, 80);
      if (!s) { if (required) fail(`${label} is required.`); return ''; }
      if (!isName(s)) fail(`${label} should be letters only (2–80 characters) — no digits or symbols.`);
      return s;
    },

    /** An integer (roll number, period, rank…). Returns `fallback` when unusable. */
    int(value, label, { min = 1, max = 9999, required = false, fallback = null } = {}) {
      const s = text(value, 20);
      if (!s) { if (required) fail(`${label} is required.`); return fallback; }
      if (!isInt(s, { min, max })) {
        fail(`${label} must be a whole number between ${min} and ${max}.`);
        return fallback;
      }
      return parseInt(s, 10);
    },

    /** A money amount / marks value (decimals allowed), never negative. */
    amount(value, label, { min = 0, max = 100000000, required = false, fallback = null } = {}) {
      const s = text(value, 20);
      if (!s) { if (required) fail(`${label} is required.`); return fallback; }
      if (!isAmount(s, { min, max })) {
        fail(`${label} must be a number between ${min} and ${max}.`);
        return fallback;
      }
      return parseFloat(s);
    },

    /** A database id from a URL or a <select> (must be a positive whole number). */
    id(value, label = 'Selection', { required = true } = {}) {
      const s = text(value, 20);
      if (!s) { if (required) fail(`${label} is required.`); return null; }
      if (!isInt(s, { min: 1 })) { fail(`${label} is not valid — please pick again.`); return null; }
      return parseInt(s, 10);
    },

    /** A value that must be one of a fixed list (status, category, day, kind…). */
    choice(value, label, allowed, { required = false, fallback = null } = {}) {
      const s = text(value, 60);
      if (!s) { if (required) fail(`${label} is required.`); return fallback; }
      if (!allowed.includes(s)) { fail(`${label} is not valid — please pick again.`); return fallback; }
      return s;
    },

    /**
     * An Indian mobile number — stored as 10 digits.
     * "+91 98765 43210" and "098765 43210" are normalised to "9876543210" rather
     * than rejected: people really do type them that way, and the old records
     * already contain 11-digit entries.
     */
    phone(value, label = 'Mobile number', { required = false } = {}) {
      let s = digits(value);
      if (s.length === 12 && s.startsWith('91')) s = s.slice(2);        // +91…
      else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);    // 0…
      if (!s) { if (required) fail(`${label} is required.`); return ''; }
      if (s.length !== 10) fail(`${label} has ${s.length} digits — a mobile number has 10.`);
      else if (!/^[6-9]/.test(s)) fail(`${label} should start with 6, 7, 8 or 9.`);
      return s.length > 10 ? s.slice(0, 10) : s;
    },

    /**
     * A login username (parent/student accounts). Letters, digits, dot, dash and
     * underscore — 3–40 characters. The existing logins ("Sahil", "12345",
     * "applicant1", "s12r1") all pass; an email address would not.
     */
    username(value, label = 'Username', { required = false } = {}) {
      const s = text(value, 40);
      if (!s) { if (required) fail(`${label} is required.`); return ''; }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/.test(s)) {
        fail(`${label} should be 3–40 characters using letters, digits, dot, dash or underscore (no spaces).`);
      }
      return s;
    },

    /** A free password (never logged, never shown anywhere except the admin slip). */
    password(value, label = 'Password', { required = false, min = 4 } = {}) {
      const s = value === undefined || value === null ? '' : String(value).trim();
      if (!s) { if (required) fail(`${label} is required.`); return ''; }
      if (s.length < min || s.length > 60) fail(`${label} should be ${min}–60 characters.`);
      return s;
    },

    /** An email address (blank is fine unless required). */
    email(value, label = 'Email', { required = false } = {}) {
      const s = text(value, 120);
      if (!s) { if (required) fail(`${label} is required.`); return ''; }
      if (!isEmail(s)) fail(`${label} does not look right — use the form name@example.com.`);
      return s;
    },

    /** A date typed as YYYY-MM-DD. `notFuture` blocks tomorrow (used by the DOB field). */
    dateISO(value, label = 'Date', { required = false, notFuture = false } = {}) {
      const s = text(value, 10);
      if (!s) { if (required) fail(`${label} is required.`); return ''; }
      if (!isDateISO(s)) { fail(`${label} is not a valid date.`); return ''; }
      if (notFuture && s > new Date().toISOString().slice(0, 10)) {
        fail(`${label} cannot be in the future.`);
        return '';
      }
      return s;
    },

    /** The student's / parents' 12-digit Aadhaar number. */
    aadhaar(value, label = 'Aadhaar number', { required = false } = {}) {
      const s = digits(value);
      if (!s) { if (required) fail(`${label} is required.`); return ''; }
      if (!isAadhaar(s)) fail(`${label} should be 12 digits (you typed ${s.length}).`);
      return s.slice(0, 12);
    },

    /**
     * A clock time the school types for a period ("8:00", "08:00 am").
     * Returns the cleaned string; the caller stores it with `timetable.to24()`.
     */
    clock(value, label = 'Time', { required = false } = {}) {
      const s = text(value, 10);
      if (!s) { if (required) fail(`${label} is required.`); return ''; }
      if (!isClock(s)) { fail(`${label} should look like 8:00 am or 08:00.`); return ''; }
      return s;
    },

    /**
     * An uploaded photo: a data-URI made in the browser, or a path bundled under
     * /images/. Empty means "remove / keep as is" — the caller decides.
     */
    image(value, label = 'Photo', { max = 500000 } = {}) {
      const raw = value === undefined || value === null ? '' : String(value);
      const s = raw.trim();
      if (!s) return '';
      if (!isImage(s)) { fail(`${label} should be a JPG or PNG image.`); return ''; }
      if (s.length > max) { fail(`${label} is too large — please choose a smaller image.`); return ''; }
      return s;
    },

    /** A checkbox / hidden flag: '1', 'on', 'true', 'yes' → true. */
    bool(value) {
      return isFlag(value);
    },
  };

  return api;
}

module.exports = {
  text, multiline, digits,
  isPhone, isEmail, isName, isDateISO, isAadhaar, isImage, isInt, isAmount,
  isClock, isFlag, isUpiId, isIfsc,
  checker,
};
