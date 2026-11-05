// A small text-only PDF writer, so report export needs no new dependency.
const PAGE_W = 612, PAGE_H = 792, MARGIN = 50;
const STYLES = {
  title: { font: 'F2', size: 16, gap: 22 },
  heading: { font: 'F2', size: 11, gap: 16, before: 8 },
  meta: { font: 'F1', size: 8, gap: 11 },
  text: { font: 'F1', size: 9.5, gap: 13 },
};

const REPLACE = { '–': '-', '—': '-', '−': '-', '×': 'x', '…': '...', '‘': "'", '’': "'", '“': '"', '”': '"', '·': '-', '≥': '>=', '≤': '<=', '•': '-', ' ': ' ' };

/** PDF's built-in fonts cover Latin-1 only. Anything else becomes "?", so bad characters can't break the file. */
export function toLatin(s) {
  return String(s).replace(/[^\x20-\x7e]/g, (c) => REPLACE[c] ?? (c.charCodeAt(0) >= 0xa0 && c.charCodeAt(0) <= 0xff ? c : '?'));
}
const escapeText = (s) => toLatin(s).replace(/([\\()])/g, '\\$1');

export function wrapText(text, size, width = PAGE_W - MARGIN * 2) {
  const max = Math.max(10, Math.floor(width / (size * 0.5)));
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > max) {
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, max));
        word = word.slice(max);
      }
      if (line && line.length + 1 + word.length > max) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

/** items: [{ style: 'title'|'heading'|'meta'|'text', text }]. Returns a Buffer. */
export function buildPdf(items, { title = 'Report', footer = '' } = {}) {
  const pages = [[]];
  let y = PAGE_H - MARGIN;
  for (const it of items) {
    const st = STYLES[it.style] || STYLES.text;
    if (st.before) y -= st.before;
    for (const line of wrapText(it.text, st.size)) {
      if (y - st.gap < MARGIN + 14) { pages.push([]); y = PAGE_H - MARGIN; }
      y -= st.gap;
      pages.at(-1).push(`BT /${st.font} ${st.size} Tf ${MARGIN} ${y.toFixed(1)} Td (${escapeText(line)}) Tj ET`);
    }
  }
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  add(`<< /Title (${escapeText(title)}) /Producer (Signal Lab) >>`);
  const kids = [];
  pages.forEach((lines, i) => {
    const foot = `BT /F1 7 Tf ${MARGIN} 30 Td (${escapeText(`${footer} Page ${i + 1} of ${pages.length}`.trim())}) Tj ET`;
    const stream = [...lines, foot].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objects[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
