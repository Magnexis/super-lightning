import { createServer } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { ResponseCache } from './cache.js';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import { resolveLicenseStatus } from './license.js';
import { lightningConsoleHtml } from './console.js';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const FORWARDED_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'if-none-match', 'if-modified-since']);

function findRoute(pathname, routes) {
  return routes.find((route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`));
}

function routeSearch(requestUrl, route) {
  const parameters = new URLSearchParams(requestUrl.search);
  for (const name of route.ignoreQueryParameters) parameters.delete(name);
  const search = parameters.toString();
  return search ? `?${search}` : '';
}

function responseCanBeCached(response) {
  const control = response.headers.get('cache-control') || '';
  const vary = response.headers.get('vary') || '';
  const unsafeVary = vary.split(',').map((value) => value.trim().toLowerCase()).some((value) => value && !['accept', 'accept-language', 'accept-encoding'].includes(value));
  return response.ok && !response.headers.has('set-cookie') && !unsafeVary && !/\b(private|no-store|no-cache)\b/i.test(control);
}

function cacheControlSeconds(response) {
  const control = response.headers.get('cache-control') || '';
  const match = /(?:s-maxage|max-age)\s*=\s*"?(\d+)"?/i.exec(control);
  return match ? Number(match[1]) : undefined;
}

function cacheKey(requestUrl, request) {
  return `${requestUrl}|accept=${request.headers.accept || ''}|lang=${request.headers['accept-language'] || ''}`;
}

function copyHeaders(headers) {
  const output = {};
  for (const [key, value] of headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) output[key] = value;
  }
  return output;
}

function acceptsEncoding(request, encoding) {
  return new RegExp(`(?:^|,)\\s*${encoding}(?:;|,|$)`, 'i').test(request.headers['accept-encoding'] || '');
}

function send(res, entry, request, cacheState) {
  const headers = { ...entry.headers, 'x-super-lightning': cacheState, 'x-super-lightning-age-ms': String(Math.max(0, Date.now() - entry.createdAt)) };
  if (request.headers['if-none-match'] && headers.etag === request.headers['if-none-match']) {
    res.writeHead(304, headers);
    return res.end();
  }
  let body = entry.body;
  const contentType = headers['content-type'] || '';
  if (request.method === 'GET' && body.length > 256 && /(?:json|text|javascript|xml|svg)/i.test(contentType)) {
    if (acceptsEncoding(request, 'br')) { body = brotliCompressSync(body); headers['content-encoding'] = 'br'; }
    else if (acceptsEncoding(request, 'gzip')) { body = gzipSync(body); headers['content-encoding'] = 'gzip'; }
    if (headers['content-encoding']) headers.vary = headers.vary ? `${headers.vary}, accept-encoding` : 'accept-encoding';
  }
  delete headers['content-length'];
  res.writeHead(entry.status, headers);
  res.end(request.method === 'HEAD' ? undefined : body);
}

function createRateLimiter(config) {
  const clients = new Map();
  if (!config.rateLimit) return () => true;
  return (address) => {
    const now = Date.now();
    const current = clients.get(address);
    if (!current || now >= current.resetAt) {
      clients.set(address, { count: 1, resetAt: now + config.rateLimit.windowSeconds * 1000 });
      return true;
    }
    current.count += 1;
    return current.count <= config.rateLimit.maxRequests;
  };
}

function prometheusMetrics(metrics, cacheEntries, inflight) {
  const lines = [
    '# TYPE super_lightning_requests_total counter',
    `super_lightning_requests_total ${metrics.requests}`,
    '# TYPE super_lightning_cache_hits_total counter',
    `super_lightning_cache_hits_total ${metrics.hits}`,
    '# TYPE super_lightning_upstream_errors_total counter',
    `super_lightning_upstream_errors_total ${metrics.upstreamErrors}`,
    '# TYPE super_lightning_circuit_open_total counter',
    `super_lightning_circuit_open_total ${metrics.circuitOpen}`,
    '# TYPE super_lightning_oversized_responses_total counter',
    `super_lightning_oversized_responses_total ${metrics.oversizedResponses}`,
    '# TYPE super_lightning_failovers_total counter',
    `super_lightning_failovers_total ${metrics.failovers}`,
    '# TYPE super_lightning_stale_if_error_total counter',
    `super_lightning_stale_if_error_total ${metrics.staleIfError}`,
    '# TYPE super_lightning_cache_entries gauge',
    `super_lightning_cache_entries ${cacheEntries}`,
    '# TYPE super_lightning_inflight_requests gauge',
    `super_lightning_inflight_requests ${inflight}`,
  ];
  return `${lines.join('\n')}\n`;
}

function accelerationBrief(routeMetrics) {
  const routes = [...routeMetrics.values()].map((route) => {
    const hotPaths = [...route.paths.entries()]
      .map(([path, value]) => ({ path, ...value }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 5);
    const cacheHitRate = route.cacheableRequests === 0 ? 0 : Number((route.hits / route.cacheableRequests).toFixed(3));
    const recommendations = [];
    if (route.cacheableRequests >= 10 && cacheHitRate < 0.5) recommendations.push('Review origin cache-control headers or raise the route cache TTL for this read-heavy route.');
    if (route.bypassed > 0) recommendations.push('Credentialed and cookie-bearing traffic bypasses caching by design; consider separating public reads from authenticated endpoints.');
    if (route.failovers > 0) recommendations.push('This route has used a fallback origin; investigate primary-origin health and capacity.');
    return { prefix: route.prefix, requests: route.requests, cacheHitRate, hotPaths, recommendations };
  });
  return { generatedAt: new Date().toISOString(), routes };
}

function readJsonBody(request, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body_too_large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid_json')); }
    });
    request.on('error', reject);
  });
}

async function analyzeConfiguredPath(path, config) {
  const requestUrl = new URL(path, 'http://super-lightning.local');
  const route = findRoute(requestUrl.pathname, config.routes);
  if (!route) return { path, status: 'skipped', reason: 'route_not_found' };
  const suffix = requestUrl.pathname.slice(route.prefix.length) || '/';
  const origins = [route.upstream, ...route.fallbackUpstreams];
  const originsReport = await Promise.all(origins.map(async (origin) => {
    const target = new URL(`${origin}${suffix}${routeSearch(requestUrl, route)}`);
    const started = performance.now();
    try {
      const response = await fetch(target, { headers: { accept: '*/*', 'accept-language': '*' }, redirect: 'manual', signal: AbortSignal.timeout(config.requestTimeoutMs) });
      const durationMs = Math.round(performance.now() - started);
      const contentLength = Number(response.headers.get('content-length')) || null;
      await response.body?.cancel();
      return { origin, status: response.status, durationMs, cacheControl: response.headers.get('cache-control'), etag: Boolean(response.headers.get('etag')), contentLength, cacheable: responseCanBeCached(response) };
    } catch {
      return { origin, status: 'unreachable', durationMs: Math.round(performance.now() - started), cacheable: false };
    }
  }));
  const primary = originsReport[0];
  const recommendations = [];
  if (!primary.cacheControl) recommendations.push('Set an explicit Cache-Control header so the accelerator and downstream clients can reuse safe responses predictably.');
  if (!primary.etag) recommendations.push('Add an ETag for inexpensive conditional requests and smaller repeat responses.');
  if (primary.contentLength && primary.contentLength > 256) recommendations.push('This response is large enough for Super Lightning compression when the content type is text-like.');
  if (primary.status === 'unreachable' || Number(primary.status) >= 500) recommendations.push('Consider a compatible fallback origin to preserve reads during primary-origin failure.');
  return { path, status: 'analyzed', origins: originsReport, recommendations };
}

export function createLightningServer(config) {
  const cache = new ResponseCache(config.maxEntries);
  const inflight = new Map();
  const metrics = { requests: 0, hits: 0, misses: 0, stale: 0, staleIfError: 0, coalesced: 0, bypassed: 0, upstreamErrors: 0, circuitOpen: 0, oversizedResponses: 0, failovers: 0 };
  const allowRequest = createRateLimiter(config);
  const circuits = new Map(config.routes.flatMap((route) => [route.upstream, ...route.fallbackUpstreams].map((upstream) => [`${route.prefix}:${new URL(upstream).origin}`, new CircuitBreaker(config.circuitBreaker)])));
  const routeMetrics = new Map(config.routes.map((route) => [route.prefix, { prefix: route.prefix, requests: 0, cacheableRequests: 0, hits: 0, bypassed: 0, failovers: 0, paths: new Map() }]));

  async function fetchEntry(url, request, route) {
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) if (FORWARDED_REQUEST_HEADERS.has(key.toLowerCase()) && value) headers[key] = value;
    const upstreamResponse = await fetch(url, { method: request.method, headers, redirect: 'manual', signal: AbortSignal.timeout(config.requestTimeoutMs) });
    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    const ttl = Math.min(route.cacheTtlSeconds ?? cacheControlSeconds(upstreamResponse) ?? config.defaultTtlSeconds, config.maxTtlSeconds);
    const createdAt = Date.now();
    const cacheable = responseCanBeCached(upstreamResponse) && body.length <= config.maxCacheableBodyBytes;
    if (responseCanBeCached(upstreamResponse) && !cacheable) metrics.oversizedResponses += 1;
    return { status: upstreamResponse.status, headers: copyHeaders(upstreamResponse.headers), body, createdAt, expiresAt: createdAt + ttl * 1000, staleUntil: createdAt + (ttl + config.staleWhileRevalidateSeconds) * 1000, errorStaleUntil: createdAt + (ttl + config.staleWhileRevalidateSeconds + config.staleIfErrorSeconds) * 1000, cacheable, requestPath: request.url || '/' };
  }

  async function fetchFromUpstream(urls, request, route) {
    let lastError;
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index];
      const circuit = circuits.get(`${route.prefix}:${url.origin}`);
      try {
        circuit.assertAvailable();
        const entry = await fetchEntry(url, request, route);
        if (entry.status >= 500) {
          circuit.recordFailure();
          lastError = new Error(`Upstream ${url.origin} returned ${entry.status}.`);
          continue;
        }
        circuit.recordSuccess();
        if (index > 0) {
          metrics.failovers += 1;
          routeMetrics.get(route.prefix).failovers += 1;
        }
        return entry;
      } catch (error) {
        if (error instanceof CircuitOpenError) lastError = error;
        else { circuit.recordFailure(); lastError = error; }
      }
    }
    throw lastError;
  }

  function refresh(key, urls, request, route) {
    if (!inflight.has(key)) inflight.set(key, fetchFromUpstream(urls, request, route).then((entry) => { if (entry.cacheable) cache.set(key, entry); return entry; }).finally(() => inflight.delete(key)));
    return inflight.get(key);
  }

  const server = createServer(async (request, res) => {
    metrics.requests += 1;
    const requestUrl = new URL(request.url || '/', 'http://super-lightning.local');
    if (!allowRequest(request.socket.remoteAddress || 'unknown')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(config.rateLimit.windowSeconds) });
      return res.end(JSON.stringify({ error: 'rate_limited', message: 'Too many requests from this client.' }));
    }
    if (requestUrl.pathname === '/_super-lightning/health') {
      const license = resolveLicenseStatus(config);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ status: license.permitted ? 'ok' : 'license_expired', license, cacheEntries: cache.size, inflight: inflight.size }));
    }
    if (requestUrl.pathname === '/_super-lightning/console') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
      return res.end(lightningConsoleHtml);
    }
    if (requestUrl.pathname === '/_super-lightning/metrics') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ...metrics, cacheEntries: cache.size, inflight: inflight.size }));
    }
    if (requestUrl.pathname === '/_super-lightning/metrics/prometheus') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' });
      return res.end(prometheusMetrics(metrics, cache.size, inflight.size));
    }
    if (requestUrl.pathname === '/_super-lightning/insights') {
      if (!config.managementToken || request.headers['x-super-lightning-token'] !== config.managementToken) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'forbidden', message: 'A valid management token is required.' }));
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(accelerationBrief(routeMetrics)));
    }
    if (requestUrl.pathname === '/_super-lightning/purge') {
      if (request.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'method_not_allowed', message: 'Use POST to purge cached entries.' }));
      }
      if (!config.managementToken || request.headers['x-super-lightning-token'] !== config.managementToken) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'forbidden', message: 'A valid management token is required.' }));
      }
      const prefix = requestUrl.searchParams.get('prefix');
      if (prefix !== null && (!prefix.startsWith('/') || prefix.length > 2048)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_prefix', message: 'prefix must be a valid path beginning with /.' }));
      }
      const removed = cache.deleteWhere((entry) => prefix === null || new URL(entry.requestPath, 'http://super-lightning.local').pathname.startsWith(prefix));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ removed, prefix }));
    }
    if (requestUrl.pathname === '/_super-lightning/warm') {
      if (request.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'method_not_allowed', message: 'Use POST to warm cached entries.' }));
      }
      if (!config.managementToken || request.headers['x-super-lightning-token'] !== config.managementToken) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'forbidden', message: 'A valid management token is required.' }));
      }
      try {
        const body = await readJsonBody(request);
        if (!Array.isArray(body.paths) || body.paths.length === 0 || body.paths.length > 50 || body.paths.some((path) => typeof path !== 'string' || !path.startsWith('/') || path.length > 2048)) throw new Error('invalid_paths');
        const results = await Promise.all(body.paths.map(async (path) => {
          const pathUrl = new URL(path, 'http://super-lightning.local');
          const route = findRoute(pathUrl.pathname, config.routes);
          if (!route) return { path, status: 'skipped', reason: 'route_not_found' };
          const suffix = pathUrl.pathname.slice(route.prefix.length) || '/';
          const upstreamUrls = [route.upstream, ...route.fallbackUpstreams].map((upstream) => new URL(`${upstream}${suffix}${routeSearch(pathUrl, route)}`));
          const warmRequest = { method: 'GET', headers: { accept: '*/*', 'accept-language': '*' }, url: path };
          const key = cacheKey(upstreamUrls[0].toString(), warmRequest);
          const entry = await refresh(key, upstreamUrls, warmRequest, route);
          return { path, status: entry.cacheable ? 'warmed' : 'skipped', reason: entry.cacheable ? undefined : 'response_not_cacheable' };
        }));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ results }));
      } catch (error) {
        const status = ['invalid_json', 'invalid_paths', 'body_too_large'].includes(error.message) ? 400 : 502;
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: status === 400 ? 'invalid_warm_request' : 'warm_failed', message: status === 400 ? 'Provide 1–50 valid configured paths as JSON.' : 'One or more upstreams could not be warmed.' }));
      }
    }
    if (requestUrl.pathname === '/_super-lightning/analyze') {
      if (request.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'method_not_allowed', message: 'Use POST to analyze configured paths.' }));
      }
      if (!config.managementToken || request.headers['x-super-lightning-token'] !== config.managementToken) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'forbidden', message: 'A valid management token is required.' }));
      }
      try {
        const body = await readJsonBody(request);
        if (!Array.isArray(body.paths) || body.paths.length === 0 || body.paths.length > 20 || body.paths.some((path) => typeof path !== 'string' || !path.startsWith('/') || path.length > 2048)) throw new Error('invalid_paths');
        const results = await Promise.all(body.paths.map((path) => analyzeConfiguredPath(path, config)));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ results }));
      } catch (error) {
        const status = ['invalid_json', 'invalid_paths', 'body_too_large'].includes(error.message) ? 400 : 502;
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: status === 400 ? 'invalid_analysis_request' : 'analysis_failed', message: status === 400 ? 'Provide 1–20 valid configured paths as JSON.' : 'One or more origins could not be analyzed.' }));
      }
    }
    if (!['GET', 'HEAD'].includes(request.method || '')) {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'method_not_allowed', message: 'Super Lightning proxies GET and HEAD requests only.' }));
    }
    const route = findRoute(requestUrl.pathname, config.routes);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'route_not_found', message: 'No configured upstream matches this path.' }));
    }
    const license = resolveLicenseStatus(config);
    if (!license.permitted) {
      res.writeHead(402, { 'content-type': 'application/json', 'x-super-lightning': 'LICENSE_REQUIRED' });
      return res.end(JSON.stringify({ error: 'license_required', message: 'The official evaluation period has ended. Install a valid Magnexis license to continue.', expiresAt: license.expiresAt }));
    }
    const routeMetric = routeMetrics.get(route.prefix);
    routeMetric.requests += 1;
    const pathMetric = routeMetric.paths.get(requestUrl.pathname) || { requests: 0 };
    pathMetric.requests += 1;
    routeMetric.paths.set(requestUrl.pathname, pathMetric);
    const suffix = requestUrl.pathname.slice(route.prefix.length) || '/';
    const upstreamUrls = [route.upstream, ...route.fallbackUpstreams].map((upstream) => new URL(`${upstream}${suffix}${routeSearch(requestUrl, route)}`));
    const key = cacheKey(upstreamUrls[0].toString(), request);
    const bypass = Boolean(request.headers.authorization || request.headers.cookie || /no-cache/i.test(request.headers['cache-control'] || ''));
    let errorStaleEntry;
    try {
      if (!bypass) {
        routeMetric.cacheableRequests += 1;
        const cached = cache.get(key);
        if (cached.state === 'HIT') { metrics.hits += 1; routeMetric.hits += 1; return send(res, cached.entry, request, 'HIT'); }
        if (cached.state === 'STALE') { metrics.stale += 1; void refresh(key, upstreamUrls, request, route).catch(() => {}); return send(res, cached.entry, request, 'STALE'); }
        if (cached.state === 'ERROR_STALE') errorStaleEntry = cached.entry;
        if (inflight.has(key)) { metrics.coalesced += 1; const entry = await inflight.get(key); return send(res, entry, request, 'COALESCED'); }
      }
      if (bypass) { metrics.bypassed += 1; routeMetric.bypassed += 1; } else metrics.misses += 1;
      const entry = await (bypass ? fetchFromUpstream(upstreamUrls, request, route) : refresh(key, upstreamUrls, request, route));
      return send(res, entry, request, bypass ? 'BYPASS' : 'MISS');
    } catch (error) {
      if (errorStaleEntry) {
        metrics.staleIfError += 1;
        return send(res, errorStaleEntry, request, 'STALE_IF_ERROR');
      }
      if (error instanceof CircuitOpenError) {
        metrics.circuitOpen += 1;
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': String(error.retryAfterSeconds), 'x-super-lightning': 'CIRCUIT_OPEN' });
        return res.end(JSON.stringify({ error: 'upstream_circuit_open', message: 'The upstream is temporarily unavailable; please retry later.' }));
      }
      metrics.upstreamErrors += 1;
      res.writeHead(502, { 'content-type': 'application/json', 'x-super-lightning': 'UPSTREAM_ERROR' });
      return res.end(JSON.stringify({ error: 'upstream_unavailable', message: 'The configured upstream could not be reached.' }));
    }
  });
  return server;
}
