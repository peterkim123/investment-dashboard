const https = require('https');
const http = require('http');
const { URL } = require('url');

function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const headers = { 'User-Agent': 'investment-dashboard/0.1', ...(opts.headers || {}) };
    if (opts.body) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    const req = lib.request(
      {
        method: opts.method || 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let data = null;
          try { data = body ? JSON.parse(body) : null; } catch { data = { raw: body }; }
          resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, data });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Sync request timed out')));
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

function authedHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function pull(url, token) {
  const res = await request(`${url.replace(/\/$/, '')}/api/positions`, { headers: authedHeaders(token) });
  return res;
}

async function push(url, token, positions, baseVersion) {
  const res = await request(`${url.replace(/\/$/, '')}/api/positions`, {
    method: 'PUT',
    headers: authedHeaders(token),
    body: { positions, baseVersion },
  });
  return res;
}

async function test(url, token) {
  try {
    const res = await pull(url, token);
    if (res.status === 200) return { ok: true, version: res.data?.version || 0 };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Auth failed (token mismatch)' };
    return { ok: false, error: `Server returned ${res.status}: ${res.data?.error || 'unknown error'}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

module.exports = { pull, push, test };
