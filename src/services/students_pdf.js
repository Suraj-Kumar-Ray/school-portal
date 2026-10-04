// ============================================================
// Minimal, dependency-free PDF writer.
// Used for the admin "Download students (A4 PDF)" feature: it
// produces a real, multi-page A4 PDF using the built-in
// Helvetica fonts, so no npm package (or internet) is needed.
// ============================================================

const time = require('./time');
const aadhaar = require('./aadhaar');

const PAGE_W = 595.28;   // A4 width  in points
const PAGE_H = 841.89;   // A4 height in points

// --- text helpers -----------------------------------------------------------
// Helvetica is a WinAnsi font: accents render, everything else is best-effort.
function sanitize(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\u20b9/g, 'Rs.')                    // ₹
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u00b7\u2022\u25cf]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2192/g, '->')
    .replace(/[^\x20-\x7e]/g, '?');
}

function escapeText(str) {
  return sanitize(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Helvetica averages ~0.5 em per character — close enough for alignment + truncation
function textWidth(str, size) {
  return sanitize(str).length * size * 0.5;
}

function fitText(str, size, maxWidth) {
  const s = sanitize(str);
  if (textWidth(s, size) <= maxWidth) return s;
  let out = '';
  for (const ch of s) {
    if (textWidth(out + ch + '...', size) > maxWidth) break;
    out += ch;
  }
  return out + '...';
}

// --- tiny PDF document ------------------------------------------------------
class Pdf {
  /** page size in points — A4 portrait by default, pass (P, L) for landscape */
  constructor(width = PAGE_W, height = PAGE_H) {
    this.w = width;
    this.h = height;
    this.pages = [];
    this.page = null;
  }

  addPage() {
    this.page = [];
    this.pages.push(this.page);
    return this.page;
  }

  raw(op) {
    if (!this.page) this.addPage();
    this.page.push(op);
  }

  /** y is measured from the TOP of the page (easier for layouts) */
  text(str, x, y, opts = {}) {
    const size = opts.size || 9;
    const text = opts.maxWidth ? fitText(str, size, opts.maxWidth) : sanitize(str);
    const width = textWidth(text, size);
    let left = x;
    if (opts.align === 'right') left = x - width;
    else if (opts.align === 'center') left = x - width / 2;
    const gray = opts.gray === undefined ? 0 : opts.gray;
    const font = opts.bold ? '/F2' : '/F1';
    this.raw(
      `BT ${gray} g ${font} ${size} Tf 1 0 0 1 ${left.toFixed(2)} ${(this.h - y).toFixed(2)} Tm (${escapeText(text)}) Tj ET`
    );
    return width;
  }

  line(x1, y1, x2, y2, opts = {}) {
    const gray = opts.gray === undefined ? 0.75 : opts.gray;
    const w = opts.width || 0.7;
    this.raw(
      `q ${gray} G ${w} w ${x1.toFixed(2)} ${(this.h - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.h - y2).toFixed(2)} l S Q`
    );
  }

  rect(x, y, w, h, opts = {}) {
    const ops = ['q'];
    if (opts.fill !== undefined) ops.push(`${opts.fill} g`);
    if (opts.stroke !== undefined) ops.push(`${opts.stroke} G ${opts.lineWidth || 0.7} w`);
    ops.push(`${x.toFixed(2)} ${(this.h - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`);
    if (opts.fill !== undefined && opts.stroke !== undefined) ops.push('B');
    else if (opts.fill !== undefined) ops.push('f');
    else ops.push('S');
    ops.push('Q');
    this.raw(ops.join(' '));
  }

  /** Build the final PDF file. footer(pageIndex, totalPages) is drawn on every page. */
  build(footer) {
    const total = this.pages.length;
    if (footer) {
      const keep = this.page;
      this.pages.forEach((page, i) => {
        this.page = page;
        footer(i, total);
      });
      this.page = keep;
    }

    const fontNormal = 3 + total * 2;
    const fontBold = fontNormal + 1;
    const size = fontBold + 1;               // number of objects + 1 (object 0 is the free head)

    const chunks = [];
    let cursor = 0;
    const offsets = [];
    const push = (str) => {
      const buf = Buffer.from(str, 'latin1');
      chunks.push(buf);
      cursor += buf.length;
    };
    const obj = (num, body) => {
      offsets[num] = cursor;
      push(`${num} 0 obj\n${body}\nendobj\n`);
    };

    push('%PDF-1.4\n');

    const kids = [];
    this.pages.forEach((_, i) => kids.push(`${3 + i * 2} 0 R`));
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${total} >>`);

    this.pages.forEach((page, i) => {
      const content = page.join('\n');
      obj(3 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.w} ${this.h}] ` +
        `/Resources << /Font << /F1 ${fontNormal} 0 R /F2 ${fontBold} 0 R >> >> ` +
        `/Contents ${4 + i * 2} 0 R >>`);
      obj(4 + i * 2, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    });

    obj(fontNormal, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(fontBold, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    const xrefAt = cursor;
    push(`xref\n0 ${size}\n`);
    push('0000000000 65535 f \n');
    for (let i = 1; i < size; i++) {
      push(String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n');
    }
    push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

    return Buffer.concat(chunks);
  }
}

// --- the students report ----------------------------------------------------
const M = 34;                    // page margin
const BOTTOM = PAGE_H - 52;      // table must not run past this

// widths add up to the printable width, so the table always fills the sheet
const COLUMNS = [
  { label: '#', w: 20, key: (s, i) => String(i + 1) },
  // “Roll No.” — the extra width comes off Student Name so the row still adds up to the
  // printable width (the header would otherwise wrap to two lines at this column width)
  { label: 'Roll No.', w: 42, key: (s) => String(s.roll_no) },
  { label: 'Student Name', w: 159, key: (s) => s.full_name },
  { label: 'Admission No', w: 76, key: (s) => s.admission_no },
  { label: 'D.O.B.', w: 64, key: (s) => prettyDate(s.dob) },
  { label: 'Blood', w: 40, key: (s) => s.blood_group || '-' },
  { label: 'Category', w: 58, key: (s) => s.category || '-' },
  { label: 'Caste', w: 68.28, key: (s) => s.caste || '-' },
];

const DETAIL_SIZE = 7.2;        // the small family / contact lines under each name
const DETAIL_GAP = '   ·   ';

/**
 * Everything that does not fit as a column is printed as small lines under the
 * student: family + income, then contact numbers + local guardian.
 * Returns the "Label: value" pieces (may be empty).
 */
function studentDetailSegments(s) {
  const withJob = (name, job) => {
    const n = String(name || '').trim();
    const j = String(job || '').trim();
    if (!n) return j;
    return j ? `${n} (${j})` : n;
  };

  // every field is printed for every student — a blank one shows as "-" so the
  // sheet always has the same complete record (and can be filled in by hand too)
  const father = withJob(s.father_name || s.parent_name, s.father_occupation);
  const mother = withJob(s.mother_name, s.mother_occupation);
  const income = String(s.annual_income || '').trim();

  const guardianBits = [String(s.guardian_name || '').trim()];
  const relation = String(s.guardian_relation || '').trim();
  if (relation) guardianBits.push(`(${relation})`);
  const guardianPhone = String(s.guardian_phone || '').trim();
  if (guardianPhone) guardianBits.push(`- ${guardianPhone}`);
  const guardian = guardianBits.filter(Boolean).join(' ');

  return [
    // line 1 — family
    [
      `Father: ${father || '-'}`,
      `Mother: ${mother || '-'}`,
      `Annual income: ${income ? `Rs. ${income}` : '-'}`,
    ],
    // line 2 — contact numbers + local guardian
    [
      `Mobile: ${String(s.parent_phone || '').trim() || '-'}`,
      `Alt mobile: ${String(s.alt_phone || '').trim() || '-'}`,
      `Guardian: ${guardian || '-'}`,
    ],
    // line 3 — Aadhaar numbers of the child and both parents
    [
      `Aadhaar: ${aadhaar.format(s.aadhaar, '-')}`,
      `Father Aadhaar: ${aadhaar.format(s.father_aadhaar, '-')}`,
      `Mother Aadhaar: ${aadhaar.format(s.mother_aadhaar, '-')}`,
    ],
    // line 4 — home address (its own line: an address is long enough to wrap)
    [`Address: ${String(s.address || '').trim() || '-'}`],
  ];
}

/**
 * Wraps the detail pieces onto as many lines as needed so nothing is cut off.
 * Each group (family, then contacts) starts on its own line.
 * (Only a single value wider than the whole sheet would be shortened.)
 */
function studentDetailLines(s, maxWidth) {
  const lines = [];
  studentDetailSegments(s).forEach((group) => {
    let current = '';
    group.forEach((segment) => {
      const sep = current ? DETAIL_GAP : '';
      if (current && textWidth(current + sep + segment, DETAIL_SIZE) > maxWidth) {
        lines.push(current);
        current = segment;
      } else {
        current += sep + segment;
      }
    });
    if (current) lines.push(current);
  });
  return lines;
}

function prettyDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (value || '-');
}

function prettyNow(date) {
  // printed on the sheet: the school's clock (IST) and the same 12-hour style
  // as everywhere else — "14/09/2026 5:09 PM"
  const stamp = date === undefined ? new Date() : date;
  return `${time.fmtDMY(stamp, '-')} ${time.fmtTime(stamp, '')}`.trim();
}

// works with a classes row (name + section) and with a report group ({ className })
function classLabel(cls) {
  if (!cls) return 'Class';
  const name = cls.name || cls.className || '';
  if (!name) return 'Class';
  return cls.section ? `${name} ${cls.section}` : name;
}

function slug(text) {
  return sanitize(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'class';
}

/**
 * groups: [{ className, students: [...] }]  — a new A4 page starts for every class
 * school: { name, typeLine, address, phone, email, session }
 */
function buildStudentsPdf({ school = {}, groups = [], generatedAt = new Date() } = {}) {
  const doc = new Pdf();
  const contentWidth = PAGE_W - M * 2;
  const tableWidth = COLUMNS.reduce((sum, c) => sum + c.w, 0);
  let pageCount = 0;

  const drawSchoolHead = () => {
    let y = 50;
    doc.text(school.name || 'School', PAGE_W / 2, y, { size: 16, bold: true, align: 'center', gray: 0.09 });
    y += 15;
    if (school.typeLine) {
      doc.text(school.typeLine, PAGE_W / 2, y, { size: 8.5, align: 'center', gray: 0.35, maxWidth: contentWidth });
      y += 12;
    }
    if (school.address) {
      doc.text(school.address, PAGE_W / 2, y, { size: 8.5, align: 'center', gray: 0.35, maxWidth: contentWidth });
      y += 12;
    }
    const contact = [school.phone ? `Phone: ${school.phone}` : '', school.email ? `Email: ${school.email}` : '']
      .filter(Boolean).join('   |   ');
    if (contact) {
      doc.text(contact, PAGE_W / 2, y, { size: 8, align: 'center', gray: 0.45, maxWidth: contentWidth });
      y += 12;
    }
    doc.line(M, y, PAGE_W - M, y, { gray: 0.55, width: 1 });
    return y;
  };

  const drawTableHead = (top) => {
    const h = 20;
    doc.rect(M, top, tableWidth, h, { fill: 0.93 });
    let x = M;
    COLUMNS.forEach((col) => {
      doc.text(col.label, x + 5, top + 13.5, { size: 8.5, bold: true, gray: 0.15 });
      x += col.w;
    });
    doc.line(M, top + h, M + tableWidth, top + h, { gray: 0.6, width: 0.8 });
    return top + h;
  };

  // one student = the column line + the small family/contact lines under it
  const rowHeightFor = (lines) => (lines.length ? 20 + (lines.length - 1) * 8 + 4.5 : 18.5);

  const drawStudentRow = (top, student, index, subLines) => {
    const rowHeight = rowHeightFor(subLines);
    if (index % 2 === 1) doc.rect(M, top, tableWidth, rowHeight, { fill: 0.965 });
    let x = M;
    COLUMNS.forEach((col) => {
      doc.text(col.key(student, index), x + 5, top + 12.4, { size: 8.5, maxWidth: col.w - 9, gray: 0.12 });
      x += col.w;
    });
    let dy = top + 19.5;
    subLines.forEach((line) => {
      doc.text(line, M + 6, dy, { size: DETAIL_SIZE, gray: 0.38, maxWidth: tableWidth - 11 });
      dy += 8;
    });
    doc.line(M, top + rowHeight, M + tableWidth, top + rowHeight, { gray: 0.86, width: 0.6 });
    return top + rowHeight;
  };

  groups.forEach((group) => {
    const students = group.students || [];
    let index = 0;
    let first = true;

    // keep drawing until every student of this class is printed
    while (first || index < students.length) {
      doc.addPage();
      pageCount++;
      let y = drawSchoolHead();

      // ---- class heading (the important bit: which class this sheet is) ----
      y += 22;
      doc.text(`STUDENT DETAILS — ${classLabel(group).toUpperCase()}`, M, y, { size: 12.5, bold: true, gray: 0.1, maxWidth: 380 });
      doc.text(`${students.length} student${students.length === 1 ? '' : 's'}`, PAGE_W - M, y, { size: 9.5, bold: true, align: 'right', gray: 0.35 });
      y += 13;
      const meta = [
        school.session ? `Academic Session: ${school.session}` : '',
        'Family, contact and guardian details are printed under each student',
        first ? '' : '(continued)',
      ].filter(Boolean).join('   ·   ');
      if (meta) {
        doc.text(meta, M, y, { size: 8.5, gray: 0.4 });
      }
      y += 12;
      doc.line(M, y, PAGE_W - M, y, { gray: 0.8 });
      y += 8;

      y = drawTableHead(y);

      while (index < students.length) {
        const student = students[index];
        const subLines = studentDetailLines(student, tableWidth - 11);
        if (y + rowHeightFor(subLines) > BOTTOM) break;   // no room left → next page
        y = drawStudentRow(y, student, index, subLines);
        index++;
      }
      first = false;
    }
  });

  // ---- summary page (only useful when several classes are printed together) ----
  if (groups.length > 1) {
    doc.addPage();
    pageCount++;
    let y = drawSchoolHead();
    y += 24;
    doc.text('CLASS-WISE SUMMARY', M, y, { size: 12.5, bold: true, gray: 0.1 });
    y += 13;
    doc.text(`${school.session ? `Academic Session: ${school.session}   ·   ` : ''}Generated on ${prettyNow(generatedAt)}`, M, y, { size: 8.5, gray: 0.4 });
    y += 12;
    doc.line(M, y, PAGE_W - M, y, { gray: 0.8 });
    y += 8;

    const summaryCols = [
      { label: 'Class', w: 240, key: (g) => classLabel(g) },
      { label: 'Students', w: 90, key: (g) => String((g.students || []).length) },
    ];
    const sw = summaryCols.reduce((sum, c) => sum + c.w, 0);
    doc.rect(M, y, sw, 20, { fill: 0.93 });
    let x = M;
    summaryCols.forEach((col) => {
      doc.text(col.label, x + 6, y + 13.5, { size: 9, bold: true, gray: 0.15 });
      x += col.w;
    });
    y += 20;
    doc.line(M, y, M + sw, y, { gray: 0.6, width: 0.8 });

    groups.forEach((group, i) => {
      const h = 18;
      if (i % 2 === 1) doc.rect(M, y, sw, h, { fill: 0.965 });
      x = M;
      summaryCols.forEach((col) => {
        doc.text(col.key(group), x + 6, y + 12.4, { size: 9, gray: 0.12, maxWidth: col.w - 11 });
        x += col.w;
      });
      y += h;
      doc.line(M, y, M + sw, y, { gray: 0.86, width: 0.6 });
    });

    const total = groups.reduce((sum, g) => sum + (g.students || []).length, 0);
    y += 6;
    doc.text(`Total: ${total} students across ${groups.length} classes`, M, y + 12, { size: 10, bold: true, gray: 0.15 });
  }

  return { buffer: doc.build((pageIndex, totalPages) => {
    const y = PAGE_H - 38;
    doc.line(M, y, PAGE_W - M, y, { gray: 0.8 });
    doc.text(`${school.name || 'School'}   ·   Student records`, M, y + 12, { size: 7.5, gray: 0.45, maxWidth: 260 });
    doc.text(`Generated: ${prettyNow(generatedAt)}`, PAGE_W / 2, y + 12, { size: 7.5, gray: 0.45, align: 'center', maxWidth: 220 });
    doc.text(`Page ${pageIndex + 1} of ${totalPages}`, PAGE_W - M, y + 12, { size: 7.5, gray: 0.45, align: 'right' });
  }), pages: pageCount, fileBase: groups.length === 1 ? slug(classLabel(groups[0])) : 'all-classes' };
}

module.exports = {
  buildStudentsPdf, classLabel, slug,
  // shared with the exam result sheet builder
  Pdf, textWidth, fitText, sanitize, prettyDate, prettyNow, PAGE_W, PAGE_H,
};
