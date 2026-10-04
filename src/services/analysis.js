/**
 * ============================================================================
 * Result analysis — the numbers behind the ring diagrams
 * ============================================================================
 *
 * One place that reads `marks` and says, in plain words a village parent can read:
 *
 *   • how the child is doing overall (one big ring: percentage + grade),
 *   • subject by subject (one ring per subject, best first),
 *   • term by term (Term 1 → Term 3, so a rise or a fall is visible),
 *   • the same answers for a whole class (office's marks page) and for the whole
 *     school (admin dashboard: one ring per class, which also shows which classes
 *     have not had results entered yet).
 *
 * The views only draw; every rule about how a percentage is worked out lives here,
 * so the parent's page and the office's dashboard can never disagree.
 *
 * RULES THAT MATTER
 *   - A written subject and its oral paper are ONE subject for analysis: `MATHS` and
 *     `MATHS ORAL` are added up (77 + 4 of 100), because that is the number a report
 *     card and a parent use. The marks table still lists them as entered.
 *   - A subject is only counted when it actually has marks — a subject with no entry
 *     never shows as 0%, it is simply not in the list (the caller gets `pending`).
 *   - Nothing is invented: with no marks at all the caller gets `hasMarks: false`, the
 *     views show one line saying so, and every percentage is `null` (never NaN).
 */

const db = require('../db');
const portal = require('./portal');

const TERMS = portal.EXAM_ORDER;   // ['Term 1', 'Term 2', 'Term 3']

/** A percentage kept EXACT at one decimal (77.4, 92.5) — the school asked for the real
 *  figure everywhere a percentage is shown, never a whole-number round-off (2026-09-19). */
function pct(obtained, max) {
  const m = Number(max) || 0;
  if (!(m > 0)) return null;
  const v = (Number(obtained) || 0) / m * 100;
  return Math.max(0, Math.min(100, exact(v)));
}

/**
 * The EXACT average the marks add up to, at ONE decimal place (77.4, 79.5, 68.25…) —
 * the school asked for the real figure instead of a rounded one (2026-09-19).
 * One decimal is what a report card shows; `toFixed(1)` also kills the binary
 * float dust (66.60000000000001 → 66.6).
 */
function exact(value) {
  if (value === null || value === undefined || !isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(1));
}

/** The unrounded percentage (clamped 0–100) — the OVERALL average is worked out from
 *  these, so the big number says exactly what the marks add up to, not a twice-rounded
 *  near-miss of it. */
function pctRaw(obtained, max) {
  const m = Number(max) || 0;
  if (!(m > 0)) return null;
  const v = (Number(obtained) || 0) / m * 100;
  return Math.max(0, Math.min(100, v));
}

/**
 * The word and colour a percentage deserves, plus the report-card grade.
 * THE SCHOOL'S OWN GRADING SHEET (2026-09-19, from the office's register):
 *   90–100 A · Super               80–90  A · Excellent
 *   70–80  B+ · Good               60–70  B · Progressive
 *   50–60  C+ · Can do better      40–50  C · Need attention
 *   below 40 C · Need more hard work
 */
function band(value) {
  if (value === null || value === undefined) {
    return { tone: 'none', word: 'No marks yet', grade: '—' };
  }
  const v = Number(value);
  if (v >= 90) return { tone: 'good', word: 'Super', grade: 'A' };
  if (v >= 80) return { tone: 'good', word: 'Excellent', grade: 'A' };
  if (v >= 70) return { tone: 'ok', word: 'Good', grade: 'B+' };
  if (v >= 60) return { tone: 'ok', word: 'Progressive', grade: 'B' };
  if (v >= 50) return { tone: 'warn', word: 'Can do better', grade: 'C+' };
  if (v >= 40) return { tone: 'warn', word: 'Need attention', grade: 'C' };
  return { tone: 'bad', word: 'Need more hard work', grade: 'C' };
}

/** The same thresholds as `views/parent/performance.ejs` — one definition, not two. */
function gradeOf(value) {
  return band(value).grade;
}

/** Show a percentage with the decimal ALWAYS visible — 96 → "96.0", 96.7 stays "96.7".
 *  The school wants the decimal place on every percentage, even on whole numbers,
 *  so "is this rounded?" can never be asked again (2026-09-19). */
function fmtPct(value) {
  if (value === null || value === undefined || !isFinite(Number(value))) return null;
  return Number(value).toFixed(1);
}

/** 'MATHS ORAL' → 'MATHS' (the written paper it belongs to); anything else is itself. */
function baseSubject(name) {
  const s = String(name || '').trim();
  const m = /^(.*?)\s+ORAL$/i.exec(s);
  return (m ? m[1] : s).trim().toUpperCase();
}

/** One ring, with the fine print underneath it. */
function ring(label, value, note) {
  const b = band(value);
  return {
    label,
    value: value === null || value === undefined ? null : exact(value),
    // the percentage WITH its decimal always visible (96 → "96.0%") — the school wants
    // the decimal place on screen everywhere, even on whole numbers (2026-09-19)
    text: value === null || value === undefined ? null : fmtPct(value) + '%',
    note: note || '',
    tone: b.tone,
    word: b.word,
    grade: b.grade,
    // the dash-offset the view needs for an SVG circle of radius 52 — computed here so
    // the template holds no arithmetic (and the tests can check the number directly)
    dash: value === null || value === undefined
      ? 0
      : Number(((1 - Math.max(0, Math.min(100, value)) / 100) * 2 * Math.PI * 52).toFixed(2)),
  };
}

/**
 * Everything the child's Result page draws.
 * @returns {{ hasMarks, overall, subjects, terms, totals, best, weakest, line, chart, facts }}
 *   `terms` carries `delta` / `direction` ('first' · 'up' · 'down' · 'same' · 'none'),
 *   `chart` is the graph's data (one entry per subject, one value per term), and `facts`
 *   is the three chips the parent's page and the printed PDF both read.
 */
function forStudent(studentId) {
  const marks = portal.getMarksBySubject(studentId);

  // a written subject and its oral paper are one ring; a term total per subject keeps
  // the same shape as the leaf values (obtained, max)
  const subjects = new Map();
  for (const m of marks) {
    const key = baseSubject(m.subject);
    if (!subjects.has(key)) subjects.set(key, { label: key, obtained: 0, max: 0, entries: 0, orals: false, perTerm: {} });
    const s = subjects.get(key);
    if (/ORAL$/i.test(String(m.subject).trim())) s.orals = true;
    for (const t of TERMS) {
      if (!m[t]) continue;
      s.obtained += Number(m[t].obtained) || 0;
      s.max += Number(m[t].max) || 0;
      s.entries += 1;
      // the SAME cells are kept term by term as well, so the graph is drawn from the
      // numbers the circles were made of — never from a second, separate query
      if (!s.perTerm[t]) s.perTerm[t] = { obtained: 0, max: 0 };
      s.perTerm[t].obtained += Number(m[t].obtained) || 0;
      s.perTerm[t].max += Number(m[t].max) || 0;
    }
  }

  const bySubject = [...subjects.values()]
    .filter((s) => s.entries > 0 && s.max > 0)
    .map((s) => ({
      ...ring(s.label, pct(s.obtained, s.max),
        `${s.obtained} of ${s.max}${s.orals ? ' · written + oral' : ''}`),
      raw: pctRaw(s.obtained, s.max),          // unrounded — feeds the EXACT overall average
      obtained: s.obtained, max: s.max, entries: s.entries, perTerm: s.perTerm,
    }))
    // best first: the diagram is an analysis, not an alphabetical list
    .sort((a, b) => (b.value || 0) - (a.value || 0) || a.label.localeCompare(b.label));

  const totals = {
    obtained: bySubject.reduce((a, s) => a + s.obtained, 0),
    max: bySubject.reduce((a, s) => a + s.max, 0),
    subjects: bySubject.length,
    entries: bySubject.reduce((a, s) => a + s.entries, 0),
  };
  const hasMarks = bySubject.length > 0;

  // the overall figure is the average of the subject percentages — worked out from the
  // UNROUNDED ones and kept at one decimal, so the number the child's dashboard, the
  // Result page and the printed PDF all show is exactly what the marks add up to
  const overallValue = hasMarks
    ? exact(bySubject.reduce((a, s) => a + s.raw, 0) / bySubject.length)
    : null;
  const overall = hasMarks
    ? ring('Overall average', overallValue,
      `${totals.obtained} of ${totals.max} marks · ${totals.subjects} subject${totals.subjects === 1 ? '' : 's'}` +
      ` · best ${bySubject[0].label} ${bySubject[0].value}%`)
    : null;

  // term by term, across every subject that has that term
  const terms = TERMS.map((t) => {
    let obtained = 0;
    let max = 0;
    let count = 0;
    for (const m of marks) {
      if (!m[t]) continue;
      obtained += Number(m[t].obtained) || 0;
      max += Number(m[t].max) || 0;
      count += 1;
    }
    if (!count || !(max > 0)) return ring(t, null, 'not entered yet');
    return ring(t, pct(obtained, max), `${count} paper${count === 1 ? '' : 's'} · ${obtained} of ${max}`);
  });

  // the bars of the graph: the same subjects in the same order (best first), one bar per
  // term. A term with no marks is `null` and is simply not drawn — never a 0% bar.
  const chart = bySubject.map((s) => ({
    label: s.label,
    terms: TERMS.map((t) => {
      const cell = s.perTerm[t];
      return !cell || !(Number(cell.max) > 0)
        ? { term: t, value: null }
        : { term: t, value: pct(cell.obtained, cell.max) };
    }),
  }));

  // term by term, each one against the term BEFORE it (skipping terms with nothing
  // entered): “up 5” / “down 4” is what makes the row worth looking at. Null is its own
  // state — never a made-up 0.
  let previous = null;
  for (const tr of terms) {
    if (tr.value === null) {
      tr.delta = null;
      tr.direction = 'none';
      continue;
    }
    if (previous === null) {
      tr.delta = null;
      tr.direction = 'first';
    } else {
      tr.delta = exact(tr.value - previous);       // one decimal here too — 2.0999999996 is not a number a parent reads
      tr.direction = tr.delta > 0 ? 'up' : (tr.delta < 0 ? 'down' : 'same');
    }
    previous = tr.value;
  }

  const best = hasMarks ? bySubject[0] : null;
  // "needs work" is only said when there IS a weakest paper and more than one subject —
  // with a single subject it is not a comparison, just the one result
  const weakest = hasMarks && bySubject.length > 1 ? bySubject[bySubject.length - 1] : null;
  // the chips keep a ready-made "96.0%" text so every surface prints the decimal the
  // same way — the school's always-visible-decimal rule (2026-09-19)
  if (best) best.text = fmtPct(best.value) + '%';
  if (weakest) weakest.text = fmtPct(weakest.value) + '%';

  let line = 'No marks have been entered yet — the diagram fills in as the school adds results.';
  if (hasMarks) {
    line = `Average ${fmtPct(overallValue)}% (${band(overallValue).word.toLowerCase()})`;
    if (best) line += ` · best ${best.label} ${fmtPct(best.value)}%`;
    if (weakest && weakest.value !== best.value) line += ` · needs work ${weakest.label} ${fmtPct(weakest.value)}%`;
  }

  // the facts a parent reads first, as data — the view only draws them, and the printed
  // PDF card is laid out from the very same object
  const facts = {
    value: overallValue,
    grade: overall ? overall.grade : null,
    word: overall ? overall.word : null,
    best: best ? { label: best.label, value: best.value } : null,
    weakest: weakest ? { label: weakest.label, value: weakest.value } : null,
    termsEntered: terms.filter((t) => t.value !== null).length,
    termsTotal: terms.length,
    subjects: totals.subjects,
    obtained: totals.obtained,
    max: totals.max,
  };

  return { hasMarks, overall, subjects: bySubject, terms, totals, best, weakest, line, chart, facts };
}

/**
 * ONE CHILD'S MARKS TABLE, ready to print — every paper exactly as the school entered it,
 * subject by subject and term by term, each row carrying the band of its OWN average.
 *
 * This is the table the parent's Result page shows under the circles, and it lives here (not
 * in a route) so the office's view of the same child can never disagree with the parents'.
 * Two rules are the school's:
 *
 *   • an ORAL paper is folded into its written subject in the circles and the graph, so its
 *     own row gets **no band word** — “2 of 10 · Needs help” in red beside a written paper
 *     that is doing well would worry a parent about a number the diagram already counts right
 *   • a row with NO marks at all stays grey: “not entered” is not the same as “doing badly”
 */
function marksRows(studentId) {
  return portal.getMarksBySubject(studentId).map((m) => {
    const entered = TERMS.some((t) => m[t]);
    const standalone = entered && !/ORAL$/i.test(String(m.subject).trim());
    const b = band(standalone ? m.avg : null);
    return {
      ...m,
      tone: b.tone,
      word: b.word,
      avgText: m.avg === null || m.avg === undefined ? null : fmtPct(m.avg) + '%',
      entered,
    };
  });
}

/**
 * One class, for the office's marks page: how the class is doing per subject for the
 * exam being looked at (or for every exam when `examId` is 0), plus how many children
 * have marks at all — that is the “results added so far” progress.
 */
function forClass(classId, { examId = 0 } = {}) {
  const cid = parseInt(classId, 10) || 0;
  const eid = parseInt(examId, 10) || 0;
  const where = ['s.class_id = ?'];
  const args = [cid];
  if (eid) { where.push('m.exam_id = ?'); args.push(eid); }

  const rows = db.prepare(`
    SELECT su.name AS subject, m.marks_obtained ob, m.max_marks mx, m.student_id sid
    FROM marks m
    JOIN subjects su ON su.id = m.subject_id
    JOIN students s ON s.id = m.student_id
    WHERE ${where.join(' AND ')}`).all(...args);

  const subjects = new Map();
  for (const r of rows) {
    const key = baseSubject(r.subject);
    if (!subjects.has(key)) subjects.set(key, { label: key, obtained: 0, max: 0, students: new Set() });
    const s = subjects.get(key);
    s.obtained += Number(r.ob) || 0;
    s.max += Number(r.mx) || 0;
    s.students.add(r.sid);
  }
  const rings = [...subjects.values()]
    .filter((s) => s.max > 0)
    .map((s) => ({
      ...ring(s.label, pct(s.obtained, s.max), `${s.students.size} student${s.students.size === 1 ? '' : 's'} · ${Math.round(s.obtained)} of ${Math.round(s.max)}`),
      raw: pctRaw(s.obtained, s.max),          // unrounded — feeds the EXACT class average
      students: s.students.size,
    }))
    .sort((a, b) => (b.value || 0) - (a.value || 0) || a.label.localeCompare(b.label));

  const totals = {
    obtained: rings.reduce((a, s) => a + s.obtained, 0),
    max: rings.reduce((a, s) => a + s.max, 0),
    subjects: rings.length,
  };
  const overallValue = rings.length
    ? exact(rings.reduce((a, s) => a + s.raw, 0) / rings.length)
    : null;

  const children = db.prepare('SELECT COUNT(*) c FROM students WHERE class_id = ?').get(cid).c;
  const withMarks = db.prepare(`
    SELECT COUNT(DISTINCT m.student_id) c FROM marks m
    JOIN students s ON s.id = m.student_id
    WHERE s.class_id = ?${eid ? ' AND m.exam_id = ?' : ''}`).get(...(eid ? [cid, eid] : [cid])).c;

  return {
    hasMarks: rings.length > 0,
    rank: 0,                                   // filled by school() when it needs the class order
    overall: rings.length
      ? ring('Class average', overallValue,
        `${withMarks} of ${children} student${children === 1 ? '' : 's'} have marks · ${rings.length} subject${rings.length === 1 ? '' : 's'}`)
      : null,
    subjects: rings,
    totals,
    children,
    withMarks,
    pending: Math.max(0, children - withMarks),
    line: rings.length
      ? `Class average ${fmtPct(overallValue)}% (${band(overallValue).word.toLowerCase()}) · best ${rings[0].label} ${fmtPct(rings[0].value)}%`
      : 'No marks entered for this class yet.',
  };
}

/**
 * The whole school, for the admin dashboard: one ring per class (a class with no marks
 * reads “no marks yet”), which is also the office's to-do list of results still to enter.
 */
function school() {
  const perClass = db.prepare(`
    SELECT c.id, c.name, c.section,
           (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) students,
           COUNT(m.id) entries,
           COUNT(DISTINCT m.student_id) with_marks,
           SUM(m.marks_obtained) obtained,
           SUM(m.max_marks) maxmarks
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id
    LEFT JOIN marks m ON m.student_id = s.id
    GROUP BY c.id ORDER BY c.id`).all();

  const subjectRows = db.prepare(`
    SELECT su.name AS subject, SUM(m.marks_obtained) ob, SUM(m.max_marks) mx,
           COUNT(DISTINCT m.student_id) students
    FROM marks m JOIN subjects su ON su.id = m.subject_id
    GROUP BY su.id ORDER BY su.name`).all();

  const subjectMap = new Map();
  for (const r of subjectRows) {
    const key = baseSubject(r.subject);
    if (!subjectMap.has(key)) subjectMap.set(key, { label: key, obtained: 0, max: 0 });
    const s = subjectMap.get(key);
    s.obtained += Number(r.ob) || 0;
    s.max += Number(r.mx) || 0;
  }
  const bySubject = [...subjectMap.values()].filter((s) => s.max > 0)
    .map((s) => ({
      ...ring(s.label, pct(s.obtained, s.max), `${Math.round(s.obtained)} of ${Math.round(s.max)}`),
      raw: pctRaw(s.obtained, s.max),          // unrounded — feeds the EXACT school average
    }))
    .sort((a, b) => (b.value || 0) - (a.value || 0) || a.label.localeCompare(b.label));

  const withMarks = db.prepare('SELECT COUNT(DISTINCT student_id) c FROM marks').get().c;
  const totalStudents = db.prepare('SELECT COUNT(*) c FROM students').get().c;
  const marksEntered = db.prepare('SELECT COUNT(*) c FROM marks').get().c;

  const classes = perClass.map((c, i) => {
    const value = Number(c.maxmarks) > 0 ? pct(c.obtained, c.maxmarks) : null;
    const guide = value === null ? 'no marks yet' : `${c.with_marks} of ${c.students} children`;
    return {
      id: c.id,
      label: `${c.name}${c.section ? ' ' + c.section : ''}`,
      value,
      tone: band(value).tone,
      word: band(value).word,
      // `note` is what the ring partial prints under the circle; `guide` is kept as the
      // same sentence for callers that read it by that name
      note: guide,
      guide,
      rank: 0,                                  // set below, once the class averages are known
      students: c.students,
      withMarks: c.with_marks,
      entries: c.entries,
      i,
    };
  });
  // the classes that DO have marks get a rank — “2nd best in school” is what makes the
  // diagram worth looking at; a class with nothing entered stays at 0 and is listed last
  classes.filter((c) => c.value !== null)
    .sort((a, b) => b.value - a.value || a.i - b.i)
    .forEach((c, i) => { c.rank = i + 1; });
  // and the VIEW asks for the interesting circles first: the classes with marks (best
  // average first), then the ones still to enter, in class order — so the office is not
  // scrolling past twelve grey circles to find the one class that has a result
  const ordered = classes
    .slice()
    .sort((a, b) => (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0)
      || (b.value || 0) - (a.value || 0) || a.i - b.i);

  const overallValue = bySubject.length
    ? exact(bySubject.reduce((a, s) => a + s.raw, 0) / bySubject.length)
    : null;
  const ranked = classes.filter((c) => c.value !== null).sort((a, b) => b.value - a.value);
  const pendingClasses = classes.filter((c) => c.value === null);

  return {
    hasMarks: bySubject.length > 0,
    overall: bySubject.length
      ? ring('School average', overallValue,
        `${marksEntered} marks · ${withMarks} of ${totalStudents} student${totalStudents === 1 ? '' : 's'}`)
      : null,
    classes: ordered,
    topClass: ranked[0] || null,
    lastClass: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    subjects: bySubject,
    bestSubject: bySubject[0] || null,
    weakestSubject: bySubject.length > 1 ? bySubject[bySubject.length - 1] : null,
    totals: { marksEntered, withMarks, totalStudents, classes: classes.length, pendingClasses: pendingClasses.length },
    pendingClassNames: pendingClasses.map((c) => c.label),
    line: bySubject.length
      ? `School average ${fmtPct(overallValue)}% (${band(overallValue).word.toLowerCase()}) · ${withMarks} of ${totalStudents} children have marks`
      : 'No marks entered anywhere yet — enter marks on 📝 Marks Entry and this diagram fills in.',
  };
}

module.exports = { TERMS, band, gradeOf, fmtPct, baseSubject, pct, ring, forStudent, forClass, school, marksRows };
