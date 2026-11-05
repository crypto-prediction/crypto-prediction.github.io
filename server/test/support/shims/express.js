// TEST-ONLY minimal Express-compatible shim (app.use/get/post, express.json, req.query/body,
// res.status/json). Lets the real src/app.js run in a sandbox where the express package
// cannot be installed. Production uses real Express.
function express() {
  const mws = [];
  const routes = [];
  const app = (req, res) => {
    const u = new URL(req.url, 'http://x');
    req.path = u.pathname;
    req.query = Object.fromEntries(u.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { if (!res.headersSent) res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return res; };
    const stack = [...mws, (rq, rs, next) => {
      const r = routes.find((x) => x.method === rq.method && x.path === rq.path);
      if (!r) { rs.statusCode = 404; return rs.json({ error: 'not found' }); }
      Promise.resolve(r.fn(rq, rs, next)).catch((e) => { rs.statusCode = 500; rs.json({ error: e.message }); });
    }];
    let i = 0;
    const next = () => stack[i++](req, res, next);
    next();
  };
  app.use = (fn) => { mws.push(fn); return app; };
  app.get = (path, fn) => { routes.push({ method: 'GET', path, fn }); return app; };
  app.post = (path, fn) => { routes.push({ method: 'POST', path, fn }); return app; };
  return app;
}
express.json = () => (req, res, next) => {
  if (req.method !== 'POST') { req.body = {}; return next(); }
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => { try { req.body = b ? JSON.parse(b) : {}; } catch { req.body = {}; } next(); });
};
export default express;
