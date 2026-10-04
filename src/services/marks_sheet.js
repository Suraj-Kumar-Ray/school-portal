/**
 * ============================================================================
 * marks_sheet.js — one class's marks: read them, total them, save them, print them.
 * ============================================================================
 *
 * Why this file exists
 * --------------------
 * The office (`/admin/marks`) and a class teacher (`/teacher/marks`) must show the
 * SAME grid, apply the SAME rules and print the SAME result sheet. Before this
 * file each route did its own reading and totalling, so a change in one page
 * could quietly disagree with the other.
 *
 * Rules the school asked for, kept here so both pages obey them:
 *   • A **blank** cell means "leave this mark as it is" — it is NOT a zero.
 *   • `0` is a real mark and is stored as one.
 *   • A mark above the subject's own maximum (written 90 + oral 10, activity 50)
 *     or below 0 is refused, and the page says WHICH child and subject.
 *   • Rank is on the total, and equal totals share a rank.
 *
 * A class teacher can never reach another class: the class id always comes from
 * `teachers.class_id` (see src/routes/teacher.js), never from the form.
 */
const db = require('../db');
const config = require('../config');
const resultPdf = require('./result_pdf');
const pdfHelper = require('./students_pdf');

/** Students of a class, in roll order. */
function studentsOf(classId) {
  if (!classId) return [];
  return db.prepare('SELECT * FROM students WHERE class_id = ? ORDER BY roll_no').all(classId);
}

/** The subjects of a class, each with its own maximum marks. */
function subjectsOf(classId) {
  if (!classId) return [];
  return db.prepare('SELECT * FROM subjects WHERE class_id = ? ORDER BY id').all(classId);
}

/**
 * Everything a marks page needs for one class + exam.
 * `byStudent` maps studentId → { subjectId: marks_obtained }.
 */
function sheet(classId, examId) {
  const students = studentsOf(classId);
  const subjects = subjectsOf(classId);
  const byStudent = new Map();
  if (classId && examId && students.length) {
    const rows = db.prepare(`SELECT m.student_id, m.subject_id, m.marks_obtained FROM marks m
      WHERE m.exam_id = ? AND m.student_id IN (SELECT id FROM students WHERE class_id = ?)`)
      .all(examId, classId);
    for (const r of rows) {
      if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, {});
      byStudent.get(r.student_id)[r.subject_id] = r.marks_obtained;
    }
  }
  return { students, subjects, byStudent };
}

/** The full marks of a class — the denominator of every percentage. */
function fullMarks(subjects = []) {
  return subjects.reduce((n, s) => n + (Number(s.max_marks) || 100), 0);
}

/** Total, percentage and rank per student (equal totals share a rank). */
function withTotals(students, subjects, byStudent) {
  const maxTotal = fullMarks(subjects);
  const rows = students.map((stu) => {
    const got = byStudent.get(stu.id) || {};
    const anyMark = subjects.some((s) => got[s.id] !== undefined);
    const total = subjects.reduce((n, s) => n + (got[s.id] === undefined ? 0 : Number(got[s.id])), 0);
    return {
      student: stu,
      cells: subjects.map((s) => (got[s.id] === undefined ? '' : got[s.id])),
      maxTotal,
      total: anyMark ? Math.round(total * 100) / 100 : null,
      percent: anyMark && maxTotal ? Math.round((total / maxTotal) * 10000) / 100 : null,
      rank: null,
    };
  });
  let lastTotal = null;
  let lastRank = 0;
  rows.filter((r) => r.total !== null).sort((a, b) => b.total - a.total)
    .forEach((r, i) => {
      if (r.total !== lastTotal) { lastRank = i + 1; lastTotal = r.total; }
      r.rank = lastRank;
    });
  return rows;
}

/**
 * Save the marks of one class + exam.
 * `marks` is the raw form object: keys `${studentId}_${subjectId}`.
 * @returns {{ saved: number, badCells: string[] }} — `badCells` carries one plain
 *   sentence per refused cell ("Aarav Sharma → Maths (0–100)") so the page can warn.
 */
function saveMarks({ classId, examId, marks }) {
  const subjects = subjectsOf(classId);
  const students = studentsOf(classId);
  const upsert = db.prepare(`
    INSERT INTO marks (student_id, subject_id, exam_id, marks_obtained, max_marks)
    VALUES (?,?,?,?,?)
    ON CONFLICT(student_id, subject_id, exam_id) DO UPDATE SET
      marks_obtained = excluded.marks_obtained, max_marks = excluded.max_marks`);
  const badCells = [];
  let saved = 0;
  const txn = db.transaction(() => {
    for (const stu of students) {
      for (const subj of subjects) {
        const val = marks ? marks[`${stu.id}_${subj.id}`] : null;
        if (val === undefined || val === null || String(val).trim() === '') continue;
        const max = Number(subj.max_marks) || 100;
        const n = parseFloat(String(val));
        if (!Number.isFinite(n)) { badCells.push(`${stu.full_name} → ${subj.name}`); continue; }
        if (n < 0 || n > max) { badCells.push(`${stu.full_name} → ${subj.name} (0–${max})`); continue; }
        upsert.run(stu.id, subj.id, examId, n, max);
        saved++;
      }
    }
  });
  txn();
  return { saved, badCells };
}

/**
 * The A4 landscape result sheet, exactly as the office prints it.
 * @returns {{ buffer, fileBase, className, examLabel }|null} null when the class
 *   or the exam does not exist, or the class has no students yet.
 */
function resultSheet({ classId, examId }) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!cls || !exam) return null;
  const { students, subjects, byStudent } = sheet(classId, examId);
  if (!students.length) return null;
  const rows = withTotals(students, subjects, byStudent).map((r) => ({
    roll_no: r.student.roll_no,
    full_name: r.student.full_name,
    admission_no: r.student.admission_no,
    cells: r.cells,
    total: r.total,
    percent: r.percent,
    rank: r.rank,
  }));
  const className = pdfHelper.classLabel(cls);
  const examLabel = `${exam.term} ${exam.year}`;
  const report = resultPdf.buildResultSheetPdf({
    school: {
      name: config.schoolName, typeLine: config.schoolTypeLine, address: config.schoolAddress,
      phone: config.schoolPhone, email: config.schoolEmail, session: config.sessionLabel,
    },
    className, examLabel, subjects, rows, generatedAt: new Date(),
  });
  return { ...report, className, examLabel };
}

module.exports = { studentsOf, subjectsOf, sheet, fullMarks, withTotals, saveMarks, resultSheet };
