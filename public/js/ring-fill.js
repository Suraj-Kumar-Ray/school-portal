/* ============================================================================
   ring-fill.js — the circles FILL UP as you watch (2026-09-18)
   ----------------------------------------------------------------------------
   The school's ask: “the rings must not sit fixed — when a page opens, the circle
   should fill with colour and stop at its number, like a live calculation.”

   How it works, quietly:
   · The server still prints the FINAL dashoffset on every .ring-fill — so without
     JavaScript, or before this script runs, the ring is simply correct. Nothing
     here computes marks; it only replays the answer.
   · When the ring scrolls into view, the fill is wound back to a full circle (the
     empty state) and let go — the CSS transition draws it to the real value over
     ~1.1s with a gentle ease-out, exactly like a meter settling.
   · The number inside counts along (0 → 75), tabular digits so it never jitters,
     and stops dead on the true value the school stored. No fake overshoot.
   · Runs once per ring. A visitor who scrolls back sees the finished circle —
     a page that re-animates on every scroll feels like a toy, not a report.
   · prefers-reduced-motion: rings print already-filled, numbers already-final.
   ============================================================================ */
(function () {
  'use strict';
  var fills = Array.prototype.slice.call(document.querySelectorAll('.ring-fill'));
  if (!fills.length) return;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return; // the server's final values are already on every element

  var CIRC = 2 * Math.PI * 52; // the viewBox's r=52 — same number the template uses

  function animateRing(fill) {
    if (fill.dataset.ringLive) return; // once only
    fill.dataset.ringLive = '1';

    var svg = fill.ownerSVGElement;
    var num = svg ? svg.querySelector('.ring-num') : null;
    var finalOffset = parseFloat(fill.getAttribute('stroke-dashoffset') || '0');
    var finalText = num ? num.textContent : '';
    var target = parseInt(String(finalText).replace(/[^0-9]/g, ''), 10);
    var isNone = fill.closest && fill.closest('.tone-none');

    if (isNone || isNaN(target)) return; // a grey "no marks yet" ring has nothing to count

    // wind back: full circle = offset 0, number at 0 — then let the transition play
    fill.style.transition = 'none';
    fill.setAttribute('stroke-dashoffset', '0');
    if (num) num.textContent = '0%';
    // force the style flush so the jump is painted before the release
    void fill.getBoundingClientRect();

    requestAnimationFrame(function () {
      fill.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.25,.8,.35,1)';
      fill.setAttribute('stroke-dashoffset', String(finalOffset));

      // the number counts along with the stroke and stops on the stored value
      var t0 = null, DUR = 1100;
      function step(ts) {
        if (t0 === null) t0 = ts;
        var k = Math.min(1, (ts - t0) / DUR);
        var eased = 1 - Math.pow(1 - k, 3); // same ease-out family as the stroke
        if (num) num.textContent = Math.round(target * eased) + '%';
        if (k < 1) requestAnimationFrame(step);
        else if (num) num.textContent = finalText; // land exactly on what the school stored
      }
      requestAnimationFrame(step);
    });
  }

  // play when the ring actually appears — a ring below the fold waits for its turn
  if ('IntersectionObserver' in window) {
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { animateRing(en.target); seen.unobserve(en.target); }
      });
    }, { threshold: 0.35 });
    fills.forEach(function (f) { seen.observe(f); });
  } else {
    fills.forEach(animateRing);
  }
})();
