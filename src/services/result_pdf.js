// ============================================================
// Exam result sheet (A4 landscape) — built on the tiny PDF writer
// in students_pdf.js, so no npm package or internet is needed.
//
//   subjects: [{ name, max_marks }]
//   rows:     [{ roll_no, full_name, admission_no, cells: [value|''], total, percent, rank }]
// ============================================================

const { Pdf, textWidth, fitText, prettyNow } = require('./students_pdf');

const L_W = 841.89;    // A4 landscape width  (points)
const L_H = 595.28;    // A4 landscape height
const M = 28;          // page margin
const BOTTOM = L_H - 46;

function num(v) {
  const n = Number(String(v === undefined || v === null ? '' : v).replace(/%/g, ''));
  return Number.isFinite(n) ? n : null;
}

function buildResultSheetPdf({ school = {}, className = 'Class', examLabel = '', subjects = [], rows = [], generatedAt = new Date() } = {}) {
  const doc = new Pdf(L_W, L_H);
  const width = L_W - M * 2;

  // ---- column plan ---------------------------------------------------------
  const fixed = [
    { label: '#', w: 20 },
    // “Roll No.” (never the bare “Roll”) and wide enough to print on one line at size 7 —
    // the extra 12 units come off Student Name, so the table still fills the sheet exactly
    { label: 'Roll No.', w: 40 },
    { label: 'Student Name', w: 138 },
  ];
  const tail = [
    { label: 'Total', w: 46 },
    { label: '%', w: 38 },
    { label: 'Rank', w: 34 },
  ];
  const used = fixed.reduce((n, c) => n + c.w, 0) + tail.reduce((n, c) => n + c.w, 0);
  const subjWidth = Math.max(20, (width - used) / Math.max(1, subjects.length));
  const cols = [...fixed, ...subjects.map((s) => ({ label: s.name, w: subjWidth, max: s.max_marks })),
    ...tail];
  const tableWidth = cols.reduce((n, c) => n + c.w, 0);

  let pageCount = 0;

  const head = () => {
    let y = 40;
    doc.text(school.name || 'School', L_W / 2, y, { size: 15, bold: true, align: 'center', gray: 0.09 });
    y += 14;
    if (school.typeLine) { doc.text(school.typeLine, L_W / 2, y, { size: 8, align: 'center', gray: 0.35, maxWidth: width }); y += 11; }
    if (school.address) { doc.text(school.address, L_W / 2, y, { size: 8, align: 'center', gray: 0.35, maxWidth: width }); y += 11; }
    const contact = [school.phone ? `Phone: ${school.phone}` : '', school.email ? `Email: ${school.email}` : '', school.session ? `Session: ${school.session}` : '']
      .filter(Boolean).join('   |   ');
    if (contact) { doc.text(contact, L_W / 2, y, { size: 7.5, align: 'center', gray: 0.45, maxWidth: width }); y += 11; }
    doc.line(M, y, L_W - M, y, { gray: 0.55, width: 1 });
    return y;
  };

  // a narrow column still fits the label: one line if it fits, else two lines, else small + "..."
  function headerLines(label, avail) {
    if (textWidth(label, 7) <= avail) return { lines: [label], size: 7 };
    const words = String(label).split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      const mid = Math.ceil(words.length / 2);
      const two = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
      const widest = Math.max(...two.map((t) => textWidth(t, 6.4)));
      if (widest <= avail) return { lines: two, size: 6.4 };
    }
    const widest = Math.max(...words.map((w) => textWidth(w, 6)));
    if (words.length > 1 && widest <= avail) return { lines: words, size: 6 };
    return { lines: [fitText(label, 6, avail)], size: 6 };
  }

  const tableHead = (top) => {
    const h = 25;
    doc.rect(M, top, tableWidth, h, { fill: 0.92 });
    let x = M;
    cols.forEach((c) => {
      const { lines, size } = headerLines(c.label, c.w - 3);
      const startY = lines.length > 1 ? top + 9 : top + 11;
      lines.slice(0, 2).forEach((line, i) => {
        doc.text(line, x + c.w / 2, startY + i * 7.2, { size, bold: true, gray: 0.12, align: 'center' });
      });
      if (c.max) doc.text(`(${c.max})`, x + c.w / 2, top + 21, { size: 6, gray: 0.45, align: 'center' });
      x += c.w;
    });
    doc.line(M, top + h, M + tableWidth, top + h, { gray: 0.6, width: 0.8 });
    return top + h;
  };

  const drawRow = (top, row, index) => {
    const h = 17;
    if (index % 2 === 1) doc.rect(M, top, tableWidth, h, { fill: 0.965 });
    const cells = [
      String(index + 1),
      String(row.roll_no === undefined || row.roll_no === null ? '' : row.roll_no),
      row.full_name || '',
      ...subjects.map((_, i) => (row.cells[i] === undefined || row.cells[i] === null ? '' : String(row.cells[i]))),
      row.total === null || row.total === undefined ? '' : String(row.total),
      row.percent === null || row.percent === undefined ? '' : `${row.percent}%`,
      row.rank === null || row.rank === undefined ? '' : String(row.rank),
    ];
    let x = M;
    cols.forEach((c, i) => {
      const isName = c.label === 'Student Name';
      const size = isName ? 7.8 : 7.2;
      const align = isName ? 'left' : 'center';
      const text = isName ? fitText(cells[i], size, c.w - 8) : cells[i];
      if (isName) doc.text(text, x + 4, top + 11.4, { size, gray: 0.1, maxWidth: c.w - 8 });
      else doc.text(text, x + c.w / 2, top + 11.4, { size, gray: c.max ? 0.15 : 0.28, align });
      x += c.w;
    });
    doc.line(M, top + h, M + tableWidth, top + h, { gray: 0.86, width: 0.6 });
    return top + h;
  };

  let index = 0;
  let first = true;
  while (first || index < rows.length) {
    doc.addPage();
    pageCount++;
    let y = head();
    y += 20;
    doc.text(`RESULT SHEET — ${String(className).toUpperCase()}`, M + 2, y, { size: 12, bold: true, gray: 0.1, maxWidth: 400 });
    doc.text(`${examLabel}${first ? '' : '  (continued)'}`, L_W - M, y, { size: 9.5, bold: true, align: 'right', gray: 0.35, maxWidth: 240 });
    y += 12;
    doc.text(`${rows.length} student${rows.length === 1 ? '' : 's'}   ·   ${subjects.length} subjects   ·   generated on ${prettyNow(generatedAt)}`,
      M + 2, y, { size: 7.5, gray: 0.42 });
    y += 10;
    doc.line(M, y, L_W - M, y, { gray: 0.8 });
    y += 8;
    y = tableHead(y);
    while (index < rows.length && y + 17 <= BOTTOM) {
      y = drawRow(y, rows[index], index);
      index++;
    }
    first = false;
  }

  return {
    buffer: doc.build((pageIndex, totalPages) => {
      const y = L_H - 30;
      doc.line(M, y, L_W - M, y, { gray: 0.8 });
      doc.text(`${school.name || 'School'}   ·   Result sheet   ·   ${className}   ·   ${examLabel}`,
        M, y + 11, { size: 7, gray: 0.45, maxWidth: 420 });
      doc.text(`Page ${pageIndex + 1} of ${totalPages}`, L_W - M, y + 11, { size: 7, gray: 0.45, align: 'right' });
    }),
    pages: pageCount,
    fileBase: `result-${String(className).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  };
}

module.exports = { buildResultSheetPdf, num };
