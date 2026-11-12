'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { Wms, ApiError, VERBS } = require('./wms');

const ACT_ROUTE = new RegExp(`^/v1/acts/(${VERBS.join('|')})$`);
const MAX_BODY = 1_000_000;
const MAX_DRAIN = 16_000_000; // after a 413, keep reading this much so the client can read the answer, then cut it off

function sameKey(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function createServer({ wms, apiKey }) {
  // The one API-key check. Used by every /v1 route.
  const requireKey = (req) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const given = req.headers['x-api-key'] || bearer;
    if (!given || !sameKey(given, apiKey)) throw new ApiError(401, 'unauthorized', 'Missing or wrong API key. Send it in the X-API-Key header.');
  };
  const send = (res, status, body, headers = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (over) { if (size > MAX_DRAIN) req.destroy(); return; }
      if (size > MAX_BODY) {
        // Do not destroy the request yet: the client must be able to read the 413 first.
        over = true;
        chunks.length = 0;
        reject(new ApiError(413, 'body_too_large', 'Request body is larger than 1 MB.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      if (!chunks.length) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ApiError(400, 'invalid_json', 'Request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;

    if (p === '/health' && m === 'GET') return send(res, 200, { ok: true });

    if (p.startsWith('/v1')) {
      requireKey(req);
    } else {
      throw new ApiError(404, 'not_found', `No route for ${m} ${p}.`);
    }

    if (p === '/v1/snapshot') { if (m !== 'GET') throw methodNo(); return send(res, 200, wms.snapshot()); }
    if (p === '/v1/changes') {
      if (m !== 'GET') throw methodNo();
      const after = url.searchParams.get('after') ?? '0';
      const limit = url.searchParams.get('limit') ?? '100';
      if (!/^\d+$/.test(after)) throw new ApiError(400, 'invalid_request', 'after must be a whole number.');
      if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1000) throw new ApiError(400, 'invalid_request', 'limit must be a whole number from 1 to 1000.');
      return send(res, 200, wms.changes(Number(after), Number(limit)));
    }
    if (p === '/v1/reconcile') { if (m !== 'GET') throw methodNo(); return send(res, 200, wms.reconcile()); }

    let mm = p.match(/^\/v1\/acts\/([^/]+)$/);
    if (mm) {
      if (m !== 'GET') throw new ApiError(404, 'unknown_act', `Unknown act "${mm[1]}". Use one of: ${VERBS.join(', ')}.`);
      const act = wms.getAct(mm[1]);
      if (!act) throw new ApiError(404, 'not_found', `Act ${mm[1]} does not exist.`);
      return send(res, 200, act);
    }


    if (p === '/v1/admin/settle') { if (m !== 'POST') throw methodNo(); return send(res, 200, { settled: wms.settle() }); }
    if (p === '/v1/admin/reset') { if (m !== 'POST') throw methodNo(); wms.reset(); return send(res, 200, { ok: true, as_of_seq: 0 }); }

    throw new ApiError(404, 'not_found', `No route for ${m} ${p}.`);
  }
  const methodNo = () => new ApiError(405, 'method_not_allowed', 'This path does not allow that HTTP method.');

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/\/+$/, '');
      const act = p.match(ACT_ROUTE);
      if (act && req.method === 'POST') {
        requireKey(req);
        const body = await readBody(req);
        const out = wms.submit(act[1], body, req.headers['idempotency-key']);
        return send(res, out.status, out.body, out.replay ? { 'idempotent-replay': 'true' } : {});
      }
      if (act && req.method !== 'POST') throw methodNo();
      await route(req, res);
    } catch (e) {
      if (e instanceof ApiError) {
        // After a 413 the rest of the upload is still arriving. Close the connection once the answer is sent.
        const headers = e.status === 413 ? { connection: 'close' } : {};
        return send(res, e.status, { error: { code: e.code, reason: e.reason } }, headers);
      }
      console.error(e);
      return send(res, 500, { error: { code: 'internal_error', reason: 'Unexpected server error.' } });
    }
  });
}

if (require.main === module) {
  const apiKey = process.env.WMS_API_KEY || 'wms-dev-key';
  const delayEnv = process.env.WMS_ASYNC_DELAY_MS;
  const asyncDelayMs = delayEnv === 'manual' ? null : Number(delayEnv ?? 1500);
  const file = process.env.WMS_DATA_FILE || path.join(__dirname, '..', 'var', 'state.json');
  const wms = new Wms({ file, asyncDelayMs });
  const port = Number(process.env.PORT || 8080);
  createServer({ wms, apiKey }).listen(port, () => {
    console.log(`WMS-WitMock listening on :${port} (store: ${file}, async delay: ${asyncDelayMs === null ? 'manual' : asyncDelayMs + 'ms'})`);
  });
}

module.exports = { createServer };
