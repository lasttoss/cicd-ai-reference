// Zero-framework API on node:http + Postgres. Small enough to read, real enough to
// exercise migrations, sessions, and per-user data isolation.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const PORT = Number(process.env.PORT || 8080);

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function verify(pass, stored) {
  const [kind, saltHex, hashHex] = String(stored).split(':');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = scryptSync(pass, Buffer.from(saltHex, 'hex'), want.length);
  return want.length === got.length && timingSafeEqual(want, got);
}

const body = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
});

const userFor = async (token) => {
  if (!token) return null;
  const { rows } = await pool.query(
    'SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1',
    [token]);
  return rows[0] || null;
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const token = req.headers['x-token'] || '';

  if (path === '/healthz') {
    try {
      await pool.query('SELECT 1');
      return send(res, 200, { ok: true, db: 'up' });
    } catch (e) {
      return send(res, 503, { ok: false, db: 'down', error: e.message });
    }
  }

  if (path === '/api/login' && req.method === 'POST') {
    const { email, password } = await body(req);
    const { rows } = await pool.query('SELECT id, pass_hash FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !verify(password || '', user.pass_hash)) {
      return send(res, 401, { error: 'wrong email or password' });
    }
    const t = randomBytes(24).toString('hex');
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [t, user.id]);
    return send(res, 200, { token: t, email });
  }

  if (path.startsWith('/api/')) {
    const user = await userFor(token);
    if (!user) return send(res, 401, { error: 'unauthorized' });

    if (path === '/api/me') return send(res, 200, { email: user.email });

    // Per-user order counts for the account page. Deliberately ships without an e2e
    // assertion, to check that the reviewer flags an uncovered handler.
    if (path === '/api/summary' && req.method === 'GET') {
      const { rows } = await pool.query(
        `SELECT status, COUNT(*)::int AS n FROM orders
         WHERE user_id = $1 GROUP BY status ORDER BY status`, [user.id]);
      return send(res, 200, { counts: rows });
    }

    if (path === '/api/orders' && req.method === 'GET') {
      const { rows } = await pool.query(
        'SELECT id, item, status FROM orders WHERE user_id = $1 ORDER BY id', [user.id]);
      return send(res, 200, { orders: rows });
    }

    if (path === '/api/orders' && req.method === 'POST') {
      const { item } = await body(req);
      if (!item) return send(res, 400, { error: 'item is required' });
      const { rows } = await pool.query(
        'INSERT INTO orders (user_id, item) VALUES ($1, $2) RETURNING id, item, status',
        [user.id, item]);
      return send(res, 201, rows[0]);
    }

    const cancel = path.match(/^\/api\/orders\/(\d+)\/cancel$/);
    if (cancel) {
      const { rows } = await pool.query(
        `UPDATE orders SET status = 'cancelled'
         WHERE id = $1 AND user_id = $2 AND status = 'new'
         RETURNING id, item, status`, [cancel[1], user.id]);
      if (!rows[0]) {
        const own = await pool.query('SELECT status FROM orders WHERE id = $1 AND user_id = $2',
          [cancel[1], user.id]);
        return own.rows[0]
          ? send(res, 409, { error: 'order is not cancellable' })
          : send(res, 404, { error: 'order not found' });
      }
      return send(res, 200, rows[0]);
    }

    if (path === '/api/address') {
      if (req.method === 'GET') {
        const { rows } = await pool.query('SELECT line FROM addresses WHERE user_id = $1', [user.id]);
        return send(res, 200, { line: rows[0]?.line || '' });
      }
      if (req.method === 'PUT') {
        const { line } = await body(req);
        if (!line || !String(line).trim()) return send(res, 400, { error: 'address is required' });
        await pool.query(
          `INSERT INTO addresses (user_id, line) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET line = EXCLUDED.line`, [user.id, line]);
        return send(res, 200, { line });
      }
    }

    return send(res, 404, { error: 'no such route' });
  }

  // static UI
  const file = path === '/' ? 'index.html' : path.slice(1);
  try {
    const html = await readFile(join(here, 'public', file), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, '0.0.0.0', () => console.log(`shop-example on :${PORT}`));
