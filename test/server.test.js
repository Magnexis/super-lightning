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

test('uses the origin cache-control lifetime when a route does not override it', async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_, response) => { upstreamRequests += 1; response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' }); response.end('{}'); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 0, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  await fetch(`http://127.0.0.1:${lightningPort}/api/status`);
  const second = await fetch(`http://127.0.0.1:${lightningPort}/api/status`);
  assert.equal(second.headers.get('x-super-lightning'), 'HIT');
  assert.equal(upstreamRequests, 1);
});

test('purges a scoped cache prefix with a runtime-only management token', async (t) => {
  const oldToken = process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN;
  process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN = 'test-token';
  t.after(() => { if (oldToken === undefined) delete process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN; else process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN = oldToken; });
  let upstreamRequests = 0;
  const upstream = createServer((_, response) => { upstreamRequests += 1; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 60, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  const purge = await fetch(`http://127.0.0.1:${lightningPort}/_super-lightning/purge?prefix=/api/catalog`, { method: 'POST', headers: { 'x-super-lightning-token': 'test-token' } });
  assert.deepEqual(await purge.json(), { removed: 1, prefix: '/api/catalog' });
  const afterPurge = await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  assert.equal(afterPurge.headers.get('x-super-lightning'), 'MISS');
  assert.equal(upstreamRequests, 2);
});

test('returns 429 when the configured local rate limit is exceeded', async (t) => {
  const upstream = createServer((_, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 0, staleWhileRevalidateSeconds: 0, maxEntries: 0, rateLimit: { maxRequests: 1, windowSeconds: 60 }, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  assert.equal((await fetch(`http://127.0.0.1:${lightningPort}/api/status`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${lightningPort}/api/status`)).status, 429);
});

test('does not cache a response with an unsafe Vary header', async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_, response) => { upstreamRequests += 1; response.writeHead(200, { 'content-type': 'application/json', vary: 'User-Agent' }); response.end('{}'); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 60, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  assert.equal(upstreamRequests, 2);
});

test('does not retain an oversized upstream response in cache', async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_, response) => { upstreamRequests += 1; response.writeHead(200, { 'content-type': 'text/plain' }); response.end('larger-than-one-byte'); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 60, staleWhileRevalidateSeconds: 0, maxEntries: 10, maxCacheableBodyBytes: 1, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  assert.equal(upstreamRequests, 2);
});

test('opens the circuit after the configured upstream failure threshold', async (t) => {
  const upstream = createServer();
  const upstreamPort = await listen(upstream);
  await close(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 0, staleWhileRevalidateSeconds: 0, maxEntries: 0, circuitBreaker: { failureThreshold: 1, resetSeconds: 60 }, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); });

  assert.equal((await fetch(`http://127.0.0.1:${lightningPort}/api/status`)).status, 502);
  const blocked = await fetch(`http://127.0.0.1:${lightningPort}/api/status`);
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get('x-super-lightning'), 'CIRCUIT_OPEN');
});

test('fails over to a configured compatible origin when the primary returns a 5xx response', async (t) => {
  let primaryRequests = 0;
  let fallbackRequests = 0;
  const primary = createServer((_, response) => { primaryRequests += 1; response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"origin":"primary"}'); });
  const fallback = createServer((_, response) => { fallbackRequests += 1; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"origin":"fallback"}'); });
  const primaryPort = await listen(primary);
  const fallbackPort = await listen(fallback);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 60, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${primaryPort}`, fallbackUpstreams: [`http://127.0.0.1:${fallbackPort}`] }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(primary); await close(fallback); });

  const response = await fetch(`http://127.0.0.1:${lightningPort}/api/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { origin: 'fallback' });
  assert.equal(primaryRequests, 1);
  assert.equal(fallbackRequests, 1);
});

test('returns a protected local acceleration brief with route recommendations', async (t) => {
  const oldToken = process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN;
  process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN = 'brief-token';
  t.after(() => { if (oldToken === undefined) delete process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN; else process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN = oldToken; });
  const upstream = createServer((_, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 60, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  const blocked = await fetch(`http://127.0.0.1:${lightningPort}/_super-lightning/insights`);
  assert.equal(blocked.status, 403);
  const brief = await fetch(`http://127.0.0.1:${lightningPort}/_super-lightning/insights`, { headers: { 'x-super-lightning-token': 'brief-token' } });
  const body = await brief.json();
  assert.equal(brief.status, 200);
  assert.equal(body.routes[0].prefix, '/api');
  assert.equal(body.routes[0].cacheHitRate, 0.5);
  assert.deepEqual(body.routes[0].hotPaths, [{ path: '/api/catalog', requests: 2 }]);
});

test('warms configured public paths without accepting arbitrary upstream URLs', async (t) => {
  const oldToken = process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN;
  process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN = 'warm-token';
  t.after(() => { if (oldToken === undefined) delete process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN; else process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN = oldToken; });
  let upstreamRequests = 0;
  const upstream = createServer((_, response) => { upstreamRequests += 1; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 60, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  const warm = await fetch(`http://127.0.0.1:${lightningPort}/_super-lightning/warm`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-super-lightning-token': 'warm-token' }, body: JSON.stringify({ paths: ['/api/catalog', '/unknown'] }) });
  assert.deepEqual(await warm.json(), { results: [{ path: '/api/catalog', status: 'warmed' }, { path: '/unknown', status: 'skipped', reason: 'route_not_found' }] });
  const cached = await fetch(`http://127.0.0.1:${lightningPort}/api/catalog`);
  assert.equal(cached.headers.get('x-super-lightning'), 'HIT');
  assert.equal(upstreamRequests, 1);
});

test('serves the live Lightning Console without proxying it upstream', async (t) => {
  const upstream = createServer((_, response) => { response.writeHead(500); response.end(); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 60, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  const consolePage = await fetch(`http://127.0.0.1:${lightningPort}/_super-lightning/console`);
  assert.equal(consolePage.status, 200);
  assert.match(consolePage.headers.get('content-type'), /text\/html/);
  assert.match(await consolePage.text(), /Live acceleration field/);
});

test('serves a bounded stale response when the origin fails after expiry', async (t) => {
  let healthy = true;
  const upstream = createServer((_, response) => {
    if (!healthy) return response.destroy();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"cached":true}');
  });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 0, staleWhileRevalidateSeconds: 0, staleIfErrorSeconds: 60, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  await fetch(`http://127.0.0.1:${lightningPort}/api/status`);
  healthy = false;
  const response = await fetch(`http://127.0.0.1:${lightningPort}/api/status`);
  assert.equal(response.headers.get('x-super-lightning'), 'STALE_IF_ERROR');
  assert.deepEqual(await response.json(), { cached: true });
});

test('analyzes only configured paths and returns origin recommendations', async (t) => {
  const oldToken = process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN;
  process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN = 'analyze-token';
  t.after(() => { if (oldToken === undefined) delete process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN; else process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN = oldToken; });
  const upstream = createServer((_, response) => { response.writeHead(200, { 'content-type': 'application/json', 'content-length': '512' }); response.end('{}'); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 60, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}` }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  const response = await fetch(`http://127.0.0.1:${lightningPort}/_super-lightning/analyze`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-super-lightning-token': 'analyze-token' }, body: JSON.stringify({ paths: ['/api/status', '/not-configured'] }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.results[0].status, 'analyzed');
  assert.ok(body.results[0].recommendations.some((message) => message.includes('Cache-Control')));
  assert.deepEqual(body.results[1], { path: '/not-configured', status: 'skipped', reason: 'route_not_found' });
});

test('normalizes explicitly configured query parameters for the upstream and cache key', async (t) => {
  const receivedUrls = [];
  const upstream = createServer((request, response) => { receivedUrls.push(request.url); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); });
  const upstreamPort = await listen(upstream);
  const config = validateConfig({ port: 0, defaultTtlSeconds: 60, staleWhileRevalidateSeconds: 0, maxEntries: 10, routes: [{ prefix: '/api', upstream: `http://127.0.0.1:${upstreamPort}`, ignoreQueryParameters: ['utm_source'] }] });
  const lightning = createLightningServer(config);
  const lightningPort = await listen(lightning);
  t.after(async () => { await close(lightning); await close(upstream); });

  await fetch(`http://127.0.0.1:${lightningPort}/api/catalog?category=books&utm_source=one`);
  const repeat = await fetch(`http://127.0.0.1:${lightningPort}/api/catalog?utm_source=two&category=books`);
  assert.equal(repeat.headers.get('x-super-lightning'), 'HIT');
  assert.deepEqual(receivedUrls, ['/catalog?category=books']);
});

test('applies AI training profile defaults while allowing explicit overrides', () => {
  const config = validateConfig({ workloadProfile: 'ai-training', defaultTtlSeconds: 120, routes: [{ prefix: '/data', upstream: 'https://datasets.example.com' }] });
  assert.equal(config.workloadProfile, 'ai-training');
  assert.equal(config.defaultTtlSeconds, 120);
  assert.equal(config.staleIfErrorSeconds, 3600);
  assert.equal(config.maxCacheableBodyBytes, 64 * 1024 * 1024);
});
