(() => {
  "use strict";
  window.PdfLocalTextDiff = { textDiff, changedRange, appendPart };
  // A Levenshtein wavefront skips equal runs; traceback grows with edits, not file area.
  function textDiff(left, right, details = false, limit = Infinity) {
    const originalA = [...left], originalB = [...right];
    const { start, oldEnd: endA, newEnd: endB } = changedRange(originalA, originalB);
    const a = originalA.slice(start, endA), b = originalB.slice(start, endB), n = a.length, m = b.length;
    const bound = Math.min(limit, details ? 128 : Infinity, Math.max(n, m));
    let previous = new Int32Array([0]), distance = 0;
    const waves = details ? [{ row: previous, trace: null }] : null;
    for (; distance < bound && previous[n - m + distance] !== n; ) {
      const score = ++distance, row = new Int32Array(2 * score + 1).fill(-1);
      const trace = details ? new Uint8Array(row.length) : null;
      for (let k = -score; k <= score; k++) {
        const at = k + score - 1;
        let x = -1, move = 0, candidate = previous[at];
        if (candidate >= 0 && candidate < n && candidate - k < m) x = candidate + 1;
        candidate = previous[at - 1];
        if (candidate >= 0 && candidate < n && candidate - k + 1 <= m && candidate + 1 > x) {
          x = candidate + 1;
          move = 1;
        }
        candidate = previous[at + 1];
        if (candidate >= 0 && candidate <= n && candidate - k - 1 < m && candidate > x) {
          x = candidate;
          move = 2;
        }
        if (x < 0) continue;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        row[k + score] = x;
        if (trace) trace[k + score] = move;
      }
      previous = row;
      if (details) waves.push({ row, trace });
    }
    if (previous[n - m + distance] !== n) return { distance: bound + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined };
    if (!details) return { distance };
    const reversed = [];
    let x = n, k = n - m;
    for (let score = distance; score > 0; score--) {
      const move = waves[score].trace[k + score], previousK = k + (move === 1 ? -1 : move === 2 ? 1 : 0);
      const previousX = waves[score - 1].row[previousK + score - 1], previousY = previousX - previousK;
      const fromX = previousX + (move !== 2), fromY = previousY + (move !== 1);
      if (x > fromX) reversed.push({ html: a.slice(fromX, x).join(''), pdf: b.slice(fromY, x - k).join(''), changed: false });
      reversed.push({ html: move === 2 ? '' : a[previousX], pdf: move === 1 ? '' : b[previousY], changed: true });
      x = previousX; k = previousK;
    }
    const parts = [];
    appendPart(parts, originalA.slice(0, start).join(''), originalB.slice(0, start).join(''), false);
    for (const part of reversed.reverse()) appendPart(parts, part.html, part.pdf, part.changed);
    appendPart(parts, originalA.slice(endA).join(''), originalB.slice(endB).join(''), false);
    return { distance, parts };
  }
  function changedRange(before, after) {
    let start = 0, oldEnd = before.length, newEnd = after.length;
    while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
    return { start, oldEnd, newEnd };
  }
  function appendPart(parts, html, pdf, changed) {
    if (!html && !pdf) return;
    const last = parts.at(-1);
    if (last?.changed === changed) {
      last.html += html;
      last.pdf += pdf;
    }
    else parts.push({ html, pdf, changed });
  }
})();
