/**
 * ============================================================================
 * Marks entry — one code path for the office sheet and the class teacher's sheet
 * ============================================================================
 *
 * Every marks page renders the SAME table shape (see `views/admin/marks.ejs` and
 * `views/teacher/marks.ejs`), so this file can drive both:
 *
 *   <table class="marks-input">          the wide sheet, one row per student
 *     <tr data-mark-row data-max="600">  the row's maximum total
 *       <th data-subject="Maths" data-max="100">
 *       <input class="mark-input">
 *       <td class="row-total"> / .row-percent / .row-rank
 *   <div id="markCards" hidden>          filled in on a phone
 *
 * Two jobs, both about the same inputs — nothing is ever cloned:
 *
 *   1. PHONE — a 19-subject sheet is ~1500px wide, which no thumb can work through.
 *      Below 640px each student's inputs are MOVED into a card of their own, with
 *      every subject labelled and the totals at the foot. Because they are moved,
 *      Save still posts exactly one mark per student + subject.
 *   2. TYPING — total, percentage and rank are recalculated as marks are typed, and
 *      the listener sits on the FORM so it also hears the inputs that now live
 *      outside the table (in the card view).
 *
 * The subject name and maximum are read from the <th>'s own data- attributes, so a
 * page is free to style its header however it likes.
 */
(function () {
  'use strict';

  var table = document.querySelector('table.marks-input');
  if (!table) return;

  var heads = Array.prototype.slice.call(table.querySelectorAll('thead th'));

  /** Subject name + maximum for the column at `index`, from the header cell. */
  function columnInfo(index) {
    var th = heads[index];
    var name = 'Subject ' + (index + 1);
    var max = '';
    if (th) {
      name = th.getAttribute('data-subject') || th.textContent.replace(/\(\s*\d+\s*\)/, '').trim();
      max = th.getAttribute('data-max') || '';
      if (!max) {
        var el = th.querySelector('.subj-max');
        if (el) max = el.textContent.replace(/[()\s]/g, '');
      }
    }
    return { name: name, max: max };
  }

  // ---- 📱 PHONE: one card per student --------------------------------------
  // Below 640px — the width where a marks sheet stops being usable — the office
  // and the teacher both get the card view instead of a sheet to swipe across.
  (function buildCards() {
    if (!window.matchMedia || !window.matchMedia('(max-width: 640px)').matches) return;
    var box = document.getElementById('markCards');
    if (!box) return;

    table.querySelectorAll('tbody tr[data-mark-row]').forEach(function (tr) {
      var cells = Array.prototype.slice.call(tr.children);
      var nameCell = cells[0];
      var totalCell = tr.querySelector('.row-total');
      var pctCell = tr.querySelector('.row-percent');
      var rankCell = tr.querySelector('.row-rank');
      if (!nameCell || !totalCell || !pctCell || !rankCell) return;

      var card = document.createElement('article');
      card.className = 'mark-card';
      card.setAttribute('data-mark-row', '');
      card.setAttribute('data-max', tr.getAttribute('data-max') || '0');

      var head = document.createElement('div');
      head.className = 'mc-head';
      head.innerHTML = nameCell.innerHTML;
      card.appendChild(head);

      var grid = document.createElement('div');
      grid.className = 'mc-grid';
      cells.forEach(function (td, index) {
        var input = td.querySelector('input.mark-input');
        if (!input) return;                       // the name column, and total / % / rank
        var info = columnInfo(index);
        var label = document.createElement('label');
        label.className = 'mc-field';
        label.innerHTML = '<span class="mc-subj">' + info.name +
          (info.max ? ' <small>out of ' + info.max + '</small>' : '') + '</span>';
        label.appendChild(input);                 // MOVED, not cloned
        grid.appendChild(label);
      });
      card.appendChild(grid);

      var foot = document.createElement('div');
      foot.className = 'mc-foot';
      foot.innerHTML =
        '<span>Total <b class="row-total">' + totalCell.textContent + '</b></span>' +
        '<span>Percent <b class="row-percent">' + pctCell.textContent + '</b></span>' +
        '<span>Rank <b class="row-rank">' + rankCell.textContent + '</b></span>';
      card.appendChild(foot);

      // the (now empty) row must not be counted a second time by the live totals
      tr.removeAttribute('data-mark-row');
      box.appendChild(card);
    });

    if (box.children.length) {
      table.classList.add('is-cards');   // the table is off, the cards are on
      box.hidden = false;
    }
  })();

  // ---- live total / percentage / rank while marks are typed ----------------
  function recalc() {
    var rows = document.querySelectorAll('[data-mark-row]');
    var seen = [];
    Array.prototype.forEach.call(rows, function (row) {
      var inputs = row.querySelectorAll('input.mark-input');
      var total = 0;
      var any = false;
      Array.prototype.forEach.call(inputs, function (input) {
        if (input.value.trim() === '') return;
        var value = parseFloat(input.value);
        if (!isFinite(value)) return;
        any = true;
        total += value;
      });
      var max = parseFloat(row.getAttribute('data-max')) || 0;
      row.querySelector('.row-total').textContent = any ? Math.round(total * 100) / 100 : '—';
      row.querySelector('.row-percent').textContent =
        any && max ? (Math.round((total / max) * 10000) / 100) + '%' : '—';
      row.__total = any ? total : null;
      seen.push(row);
    });

    // rank — students on the same total share a rank
    var ranked = seen.filter(function (row) { return row.__total !== null; })
      .sort(function (a, b) { return b.__total - a.__total; });
    var last = null;
    var lastRank = 0;
    ranked.forEach(function (row, i) {
      if (row.__total !== last) { lastRank = i + 1; last = row.__total; }
      row.querySelector('.row-rank').textContent = lastRank;
    });
    seen.filter(function (row) { return row.__total === null; })
      .forEach(function (row) { row.querySelector('.row-rank').textContent = '—'; });
  }

  // the listener sits on the FORM, not the table: in the phone card view the inputs
  // live outside the table and would otherwise never be heard.
  var host = table.closest('form') || table;
  host.addEventListener('input', function (e) {
    if (e.target.classList && e.target.classList.contains('mark-input')) recalc();
  });
})();
