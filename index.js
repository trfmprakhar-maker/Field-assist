/**
 * Sharda Field — sync API on Cloudflare Workers + D1
 *
 * Endpoints
 *   GET  /api/health
 *   POST /api/login          { userId, pin }            -> { token, user }
 *   GET  /api/pull?since=ms                             -> { now, docs[] }
 *   POST /api/push           { ops:[{id,type,data,deleted}] } -> { now, applied[] }
 *   POST /api/admin/set-pin  { userId, pin }  (X-Admin-Key)
 *   POST /api/admin/import   { docs[] }       (X-Admin-Key)
 *
 * Storage model: one `docs` table holding JSON documents keyed by id, with a
 * type and an updated_at stamp. Sync is last-write-wins on updated_at, which the
 * server always sets, so `since` paging is monotonic. Reporting is done through
 * the SQL views in schema.sql using json_extract.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'content-type,authorization,x-admin-key',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
}
const ok = (body, env, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...cors(env) } });
const bad = (msg, env, status = 400) => ok({ error: msg }, env, status);

/* ---------------- crypto ---------------- */
const enc = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function b64url(buf) {
  const b = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sign(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${sig}`;
}
async function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(body));
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}
async function auth(request, env) {
  const h = request.headers.get('authorization') || '';
  return verify(h.replace(/^Bearer\s+/i, ''), env.AUTH_SECRET || 'dev-secret-change-me');
}

/* ---------------- scoping ---------------- */
/** Masters everyone may read. */
const MASTER = new Set(['sku', 'scheme', 'salesman', 'distributor', 'asm', 'user', 'target']);

/**
 * Restrict transactional docs to what this user is allowed to see.
 * admin       - everything
 * asm         - own salesmen, own distributors, and their outlets
 * salesman    - own outlets only
 * distributor - own outlets only
 */
function buildScope(user, all) {
  if (user.role === 'admin') return null; // no filter
  const outlets = all.filter(d => d.type === 'outlet').map(d => d.data);
  let men = [], dists = [];
  if (user.role === 'asm') {
    men = all.filter(d => d.type === 'salesman' && d.data.asmId === user.ref).map(d => d.data.id);
    dists = all.filter(d => d.type === 'distributor' && d.data.asmId === user.ref).map(d => d.data.id);
  } else if (user.role === 'salesman') {
    men = [user.ref];
    dists = [...new Set(outlets.filter(o => o.salesmanId === user.ref).map(o => o.distId))];
  } else {
    dists = [user.ref];
    men = [...new Set(outlets.filter(o => o.distId === user.ref).map(o => o.salesmanId))];
  }
  const outletIds = new Set(outlets.filter(o => men.includes(o.salesmanId) || dists.includes(o.distId)).map(o => o.id));
  return { men: new Set(men), dists: new Set(dists), outletIds };
}
function visible(doc, scope) {
  if (!scope) return true;
  if (MASTER.has(doc.type)) return true;
  const d = doc.data || {};
  if (doc.type === 'outlet') return scope.outletIds.has(d.id);
  if (d.outletId) return scope.outletIds.has(d.outletId);
  if (d.distId) return scope.dists.has(d.distId);
  if (d.salesmanId) return scope.men.has(d.salesmanId);
  return true;
}

/* ---------------- handlers ---------------- */
async function login(request, env) {
  const { userId, pin } = await request.json();
  if (!userId || !pin) return bad('userId and pin are required', env);
  const row = await env.DB.prepare('SELECT id,name,role,ref,title,pin FROM users WHERE id=?').bind(userId).first();
  if (!row) return bad('Unknown user', env, 401);
  const hash = await sha256hex(String(pin) + (env.PIN_SALT || 'sharda'));
  if (row.pin !== hash) return bad('Wrong PIN', env, 401);
  const user = { id: row.id, name: row.name, role: row.role, ref: row.ref, title: row.title };
  const token = await sign({ ...user, exp: Date.now() + 30 * 864e5 }, env.AUTH_SECRET || 'dev-secret-change-me');
  return ok({ token, user }, env);
}

async function pull(request, env, user) {
  const since = Number(new URL(request.url).searchParams.get('since') || 0);
  const { results } = await env.DB.prepare(
    'SELECT id,type,data,updated_at,deleted FROM docs WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 5000'
  ).bind(since).all();
  const rows = (results || []).map(r => ({ ...r, data: JSON.parse(r.data) }));

  // scope needs the full outlet/salesman picture, not just the changed slice
  let scope = null;
  if (user.role !== 'admin') {
    const { results: ctx } = await env.DB.prepare(
      "SELECT id,type,data FROM docs WHERE type IN ('outlet','salesman','distributor') AND deleted=0"
    ).all();
    scope = buildScope(user, (ctx || []).map(r => ({ ...r, data: JSON.parse(r.data) })));
  }
  const docs = rows.filter(d => visible(d, scope))
    .map(d => ({ id: d.id, type: d.type, data: d.data, updated_at: d.updated_at, deleted: !!d.deleted }));
  return ok({ now: Date.now(), docs, truncated: rows.length >= 5000 }, env);
}

async function push(request, env, user) {
  const { ops } = await request.json();
  if (!Array.isArray(ops)) return bad('ops must be an array', env);
  if (ops.length > 500) return bad('Too many operations in one push (max 500)', env);
  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO docs (id,type,data,updated_at,deleted,actor) VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at,
                                   deleted=excluded.deleted, actor=excluded.actor`
  );
  const batch = ops.map(o =>
    stmt.bind(o.id, o.type, JSON.stringify(o.data || {}), now, o.deleted ? 1 : 0, user.id)
  );
  if (batch.length) await env.DB.batch(batch);
  return ok({ now, applied: ops.map(o => o.id) }, env);
}

async function setPin(request, env) {
  const { userId, pin } = await request.json();
  const hash = await sha256hex(String(pin) + (env.PIN_SALT || 'sharda'));
  await env.DB.prepare('UPDATE users SET pin=? WHERE id=?').bind(hash, userId).run();
  return ok({ ok: true, userId }, env);
}

async function importDocs(request, env) {
  const { docs } = await request.json();
  if (!Array.isArray(docs)) return bad('docs must be an array', env);
  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO docs (id,type,data,updated_at,deleted,actor) VALUES (?,?,?,?,0,'import')
     ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, deleted=0`
  );
  for (let i = 0; i < docs.length; i += 200) {
    await env.DB.batch(docs.slice(i, i + 200).map(d => stmt.bind(d.id, d.type, JSON.stringify(d.data), now)));
  }
  return ok({ imported: docs.length }, env);
}

/* ---------------- router ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    try {
      if (url.pathname === '/api/health') return ok({ ok: true, time: Date.now() }, env);
      if (url.pathname === '/api/login' && request.method === 'POST') return login(request, env);

      if (url.pathname.startsWith('/api/admin/')) {
        if (!env.ADMIN_KEY || request.headers.get('x-admin-key') !== env.ADMIN_KEY)
          return bad('Admin key required', env, 401);
        if (url.pathname === '/api/admin/set-pin') return setPin(request, env);
        if (url.pathname === '/api/admin/import') return importDocs(request, env);
        return bad('Not found', env, 404);
      }

      const user = await auth(request, env);
      if (!user) return bad('Sign in again', env, 401);
      if (url.pathname === '/api/pull') return pull(request, env, user);
      if (url.pathname === '/api/push' && request.method === 'POST') return push(request, env, user);

      return bad('Not found', env, 404);
    } catch (e) {
      return bad(e.message || 'Server error', env, 500);
    }
  }
};
