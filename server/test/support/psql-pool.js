// Test-only stand-in for pg.Pool that talks to a REAL PostgreSQL server through the psql CLI
// (one persistent session, extended-protocol parameters via \bind). Used so the SQL and
// paper-trading logic can be tested where the `pg` npm package isn't installable.
// Production code uses the real `pg` driver (src/db.js).
import { spawn } from 'node:child_process';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const conv = (v) => (v === '' ? null : /^[{[]/.test(v) ? JSON.parse(v) :/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v) ? Number(v) : v === 't' ? true : v === 'f' ? false : v);
const lit = (v) => `'${String(v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function createPsqlPool(args) {
  const proc = spawn('psql', ['-X', '-q', '--csv', '-v', 'ON_ERROR_STOP=0', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '', waiting = null;
  const MARK = '__Q_END__';
  const check = () => {
    if (!waiting) return;
    const o = out.indexOf(MARK + '\n'), e = err.indexOf(MARK + '\n');
    if (o < 0 || e < 0) return;
    const body = out.slice(0, o), errs = err.slice(0, e);
    out = out.slice(o + MARK.length + 1); err = err.slice(e + MARK.length + 1);
    const w = waiting; waiting = null;
    const m = errs.match(/ERROR:\s+(.*)/);
    if (m) return w.reject(new Error(m[1]));
    // keep only the LAST result set (header + rows)
    const blocks = body.split(/\n(?=[a-z_?][a-z0-9_?]*(,[a-z_?][a-z0-9_?]*)*\n)/i).filter(Boolean);
    const last = body.trim() ? parseCsv(body.trim() + '\n') : [];
    let rows = [];
    if (last.length) {
      const hdr = last[0];
      rows = last.slice(1).map((r) => Object.fromEntries(hdr.map((h, i) => [h, conv(r[i] ?? '')])));
    }
    void blocks;
    w.resolve({ rows, rowCount: rows.length });
  };
  proc.stdout.on('data', (d) => { out += d; check(); });
  proc.stderr.on('data', (d) => { err += d; check(); });

  let chain = Promise.resolve();
  function query(sql, params = []) {
    const run = () => new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      let cmd;
      if (params.length) cmd = `${sql.trim().replace(/;\s*$/, '')} \\bind ${params.map((p) => (p === null || p === undefined ? "''" : lit(p))).join(' ')} \\g\n`;
      else cmd = `${sql.trim().replace(/;?\s*$/, ';')}\n`;
      proc.stdin.write(`${cmd}\\echo ${MARK}\n\\warn ${MARK}\n`);
    });
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }
  return {
    query,
    connect: async () => ({ query, release() {} }),
    end: async () => { proc.stdin.end(); },
  };
}
