import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { validateConfig } from '../src/config.js';
import { createLightningServer } from '../src/server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) { await new Promise((resolve) => server.close(resolve)); }

test('caches a configured upstream response and exposes a cache hit', async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=120' });
    response.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 30, staleWhileRevalidateSeconds: 10, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  const first = await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  const second = await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  assert.equal(first.headers.get('x-super-lightning'), 'MISS');
  assert.equal(second.headers.get('x-super-lightning'), 'HIT');
  assert.equal(upstreamRequests, 1);
});

test('coalesces simultaneous matching requests', async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_, response) => {
    upstreamRequests += 1;
    setTimeout(() => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}'); }, 40);
  });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 30, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  const responses = await Promise.all([1, 2, 3].map(() => fetch(`http://127.0.0.1:${lightningPort}/api/status`)));
  assert.equal(upstreamRequests, 1);
  assert.ok(responses.some((response) => response.headers.get('x-super-lightning') === 'COALESCED'));
});

test('does not cache credential-bearing requests', async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_, response) => { upstreamRequests += 1; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 30, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  for (let i = 0; i < 2; i += 1) {
    const response = await fetch(`http://127.0.0.1:${lightningPort}/api/me`, { headers: { authorization: 'Bearer test' } });
    assert.equal(response.headers.get('x-super-lightning'), 'BYPASS');
  }
  assert.equal(upstreamRequests, 2);
});
