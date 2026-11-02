// Post-deploy smoke test. Runs against a URL, asserts real behaviour, exits non-zero on
// failure so a broken deploy can be reverted automatically.
//
// Always: liveness (health + DB reachable) and access control (no session = 401).
// With SMOKE_FULL=1: the authenticated flow, which needs a seeded account.
const base = process.env.SMOKE_URL || 'http://127.0.0.1:8080';
const email = process.env.SEED_EMAIL || 'qa1@test.local';
const pass = process.env.SEED_PASS || 'qa-pass';
const full = process.env.SMOKE_FULL === '1';

const call = async (method, path, payload, token) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-token': token } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// --- always
const health = await call('GET', '/healthz');
check('health + database reachable', health.status === 200 && health.data.db === 'up',
  `status=${health.status} db=${health.data.db}`);

const anon = await call('GET', '/api/orders');
check('unauthenticated request is rejected', anon.status === 401, `status=${anon.status}`);

// --- authenticated flow
if (full) {
  const login = await call('POST', '/api/login', { email, password: pass });
  check('sign in', login.status === 200 && !!login.data.token, `status=${login.status}`);
  const token = login.data.token;

  if (token) {
    const created = await call('POST', '/api/orders', { item: 'smoke-item' }, token);
    check('create an order', created.status === 201 && !!created.data.id, `status=${created.status}`);

    const list = await call('GET', '/api/orders', null, token);
    check('order appears in my list',
      (list.data.orders || []).some((o) => o.id === created.data.id));

    if (created.data.id) {
      const cancelled = await call('POST', `/api/orders/${created.data.id}/cancel`, null, token);
      check('cancel an order', cancelled.status === 200 && cancelled.data.status === 'cancelled',
        `status=${cancelled.status}`);
    }
  }
} else {
  console.log('(authenticated flow skipped — set SMOKE_FULL=1 where an account is seeded)');
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} smoke checks passed`);
process.exit(failed.length ? 1 : 0);
