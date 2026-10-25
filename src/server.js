import { createServer } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { ResponseCache } from './cache.js';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const FORWARDED_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'if-none-match', 'if-modified-since', 'user-agent']);

function findRoute(pathname, routes) {
  return routes.find((route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`));
}

function responseCanBeCached(response) {
  const control = response.headers.get('cache-control') || '';
  return response.ok && !response.headers.has('set-cookie') && !/\b(private|no-store)\b/i.test(control);
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

export function createLightningServer(config) {
  const cache = new ResponseCache(config.maxEntries);
  const inflight = new Map();
  const metrics = { requests: 0, hits: 0, misses: 0, stale: 0, coalesced: 0, bypassed: 0, upstreamErrors: 0 };

  async function fetchEntry(url, request, route) {
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) if (FORWARDED_REQUEST_HEADERS.has(key.toLowerCase()) && value) headers[key] = value;
    const upstreamResponse = await fetch(url, { method: request.method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    const ttl = route.cacheTtlSeconds ?? config.defaultTtlSeconds;
    const createdAt = Date.now();
    return { status: upstreamResponse.status, headers: copyHeaders(upstreamResponse.headers), body, createdAt, expiresAt: createdAt + ttl * 1000, staleUntil: createdAt + (ttl + config.staleWhileRevalidateSeconds) * 1000, cacheable: responseCanBeCached(upstreamResponse) };
  }

  function refresh(key, url, request, route) {
    if (!inflight.has(key)) inflight.set(key, fetchEntry(url, request, route).then((entry) => { if (entry.cacheable) cache.set(key, entry); return entry; }).finally(() => inflight.delete(key)));
    return inflight.get(key);
  }

  const server = createServer(async (request, res) => {
    metrics.requests += 1;
    const requestUrl = new URL(request.url || '/', 'http://super-lightning.local');
    if (requestUrl.pathname === '/_super-lightning/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ status: 'ok', cacheEntries: cache.size, inflight: inflight.size }));
    }
    if (requestUrl.pathname === '/_super-lightning/metrics') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ...metrics, cacheEntries: cache.size, inflight: inflight.size }));
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
    const suffix = requestUrl.pathname.slice(route.prefix.length) || '/';
    const upstreamUrl = new URL(`${route.upstream}${suffix}${requestUrl.search}`);
    const key = cacheKey(upstreamUrl.toString(), request);
    const bypass = Boolean(request.headers.authorization || request.headers.cookie || /no-cache/i.test(request.headers['cache-control'] || ''));
    try {
      if (!bypass) {
        const cached = cache.get(key);
        if (cached.state === 'HIT') { metrics.hits += 1; return send(res, cached.entry, request, 'HIT'); }
        if (cached.state === 'STALE') { metrics.stale += 1; void refresh(key, upstreamUrl, request, route); return send(res, cached.entry, request, 'STALE'); }
        if (inflight.has(key)) { metrics.coalesced += 1; const entry = await inflight.get(key); return send(res, entry, request, 'COALESCED'); }
      }
      bypass ? metrics.bypassed += 1 : metrics.misses += 1;
      const entry = await (bypass ? fetchEntry(upstreamUrl, request, route) : refresh(key, upstreamUrl, request, route));
      return send(res, entry, request, bypass ? 'BYPASS' : 'MISS');
    } catch (error) {
      metrics.upstreamErrors += 1;
      res.writeHead(502, { 'content-type': 'application/json', 'x-super-lightning': 'UPSTREAM_ERROR' });
      return res.end(JSON.stringify({ error: 'upstream_unavailable', message: 'The configured upstream could not be reached.' }));
    }
  });
  return server;
}
