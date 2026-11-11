'use strict';
const { Wms } = require('../src/wms');
const { createServer } = require('../src/server');

const KEY = 'test-key';
let tick = 0;
const clock = () => `2026-02-01T00:00:${String(tick++ % 60).padStart(2, '0')}Z`;

async function start({ file = null } = {}) {
  const wms = new Wms({ file, clock, asyncDelayMs: null });
  const server = createServer({ wms, apiKey: KEY });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }
  return {
    wms, base, call,
    get: (p) => call('GET', p),
    post: (p, b, h) => call('POST', p, b, h),
    act: (verb, b) => call('POST', `/v1/acts/${verb}`, b),
    settle: () => call('POST', '/v1/admin/settle'),
    close: () => new Promise((r) => server.close(r)),
  };
}
module.exports = { start, KEY };
