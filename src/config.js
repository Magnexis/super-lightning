import { readFile } from 'node:fs/promises';

const DEFAULTS = {
  port: 8787,
  defaultTtlSeconds: 30,
  staleWhileRevalidateSeconds: 60,
  staleIfErrorSeconds: 300,
  maxEntries: 1000,
  maxTtlSeconds: 3600,
  requestTimeoutMs: 15_000,
  maxCacheableBodyBytes: 5 * 1024 * 1024,
  circuitBreaker: { failureThreshold: 5, resetSeconds: 15 },
};

const WORKLOAD_PROFILES = Object.freeze({
  general: Object.freeze({}),
  'ai-training': Object.freeze({ defaultTtlSeconds: 300, staleWhileRevalidateSeconds: 600, staleIfErrorSeconds: 3600, maxEntries: 2000, maxCacheableBodyBytes: 64 * 1024 * 1024, requestTimeoutMs: 60_000 }),
  'ai-agent': Object.freeze({ defaultTtlSeconds: 90, staleWhileRevalidateSeconds: 300, staleIfErrorSeconds: 900, maxEntries: 1500, requestTimeoutMs: 30_000 }),
  'developer-work': Object.freeze({ defaultTtlSeconds: 300, staleWhileRevalidateSeconds: 600, staleIfErrorSeconds: 1800, maxEntries: 2000, requestTimeoutMs: 30_000 }),
});

function positiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`);
  }
  return value;
}

function validateRoute(route) {
  if (!route || typeof route !== 'object') throw new Error('Every route must be an object.');
  if (typeof route.prefix !== 'string' || !route.prefix.startsWith('/') || route.prefix === '/') {
    throw new Error('Route prefix must start with / and cannot be /.');
  }
  if (route.prefix.endsWith('/')) throw new Error(`Route prefix ${route.prefix} must not end with /.`);

  const validateUpstream = (value) => {
    let upstream;
    try { upstream = new URL(value); } catch { throw new Error(`Route ${route.prefix} has an invalid upstream URL.`); }
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) {
      throw new Error(`Route ${route.prefix} must use an http(s) upstream without embedded credentials.`);
    }
    return upstream.toString().replace(/\/$/, '');
  };
  const upstream = validateUpstream(route.upstream);
  if (route.fallbackUpstreams !== undefined && (!Array.isArray(route.fallbackUpstreams) || route.fallbackUpstreams.length === 0)) {
    throw new Error(`fallbackUpstreams for ${route.prefix} must be a non-empty array when provided.`);
  }
  const fallbackUpstreams = (route.fallbackUpstreams || []).map(validateUpstream);
  if (new Set([upstream, ...fallbackUpstreams]).size !== fallbackUpstreams.length + 1) throw new Error(`Route ${route.prefix} contains duplicate upstreams.`);
  if (route.ignoreQueryParameters !== undefined && (!Array.isArray(route.ignoreQueryParameters) || route.ignoreQueryParameters.length > 32 || route.ignoreQueryParameters.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)))) {
    throw new Error(`ignoreQueryParameters for ${route.prefix} must contain up to 32 simple parameter names.`);
  }

  return Object.freeze({
    prefix: route.prefix,
    upstream,
    fallbackUpstreams: Object.freeze(fallbackUpstreams),
    ignoreQueryParameters: Object.freeze(route.ignoreQueryParameters || []),
    cacheTtlSeconds: route.cacheTtlSeconds === undefined
      ? undefined
      : positiveInteger(route.cacheTtlSeconds, `cacheTtlSeconds for ${route.prefix}`),
  });
}

function validateRateLimit(raw) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') throw new Error('rateLimit must be an object.');
  return Object.freeze({
    maxRequests: positiveInteger(raw.maxRequests, 'rateLimit.maxRequests'),
    windowSeconds: positiveInteger(raw.windowSeconds, 'rateLimit.windowSeconds'),
  });
}

function validateCircuitBreaker(raw) {
  if (raw === undefined) return Object.freeze({ ...DEFAULTS.circuitBreaker });
  if (!raw || typeof raw !== 'object') throw new Error('circuitBreaker must be an object.');
  const failureThreshold = positiveInteger(raw.failureThreshold, 'circuitBreaker.failureThreshold');
  const resetSeconds = positiveInteger(raw.resetSeconds, 'circuitBreaker.resetSeconds');
  if (failureThreshold === 0 || resetSeconds === 0) throw new Error('circuitBreaker values must be greater than zero.');
  return Object.freeze({ failureThreshold, resetSeconds });
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Configuration must be a JSON object.');
  const workloadProfile = raw.workloadProfile || 'general';
  if (!Object.hasOwn(WORKLOAD_PROFILES, workloadProfile)) throw new Error(`Unknown workloadProfile: ${workloadProfile}.`);
  const normalized = { ...WORKLOAD_PROFILES[workloadProfile], ...raw };
  if (!Array.isArray(normalized.routes) || normalized.routes.length === 0) throw new Error('Configuration requires at least one route.');

  const config = {
    workloadProfile,
    port: normalized.port === undefined ? DEFAULTS.port : positiveInteger(normalized.port, 'port'),
    defaultTtlSeconds: normalized.defaultTtlSeconds === undefined ? DEFAULTS.defaultTtlSeconds : positiveInteger(normalized.defaultTtlSeconds, 'defaultTtlSeconds'),
    staleWhileRevalidateSeconds: normalized.staleWhileRevalidateSeconds === undefined ? DEFAULTS.staleWhileRevalidateSeconds : positiveInteger(normalized.staleWhileRevalidateSeconds, 'staleWhileRevalidateSeconds'),
    staleIfErrorSeconds: normalized.staleIfErrorSeconds === undefined ? DEFAULTS.staleIfErrorSeconds : positiveInteger(normalized.staleIfErrorSeconds, 'staleIfErrorSeconds'),
    maxEntries: normalized.maxEntries === undefined ? DEFAULTS.maxEntries : positiveInteger(normalized.maxEntries, 'maxEntries'),
    maxTtlSeconds: normalized.maxTtlSeconds === undefined ? DEFAULTS.maxTtlSeconds : positiveInteger(normalized.maxTtlSeconds, 'maxTtlSeconds'),
    requestTimeoutMs: normalized.requestTimeoutMs === undefined ? DEFAULTS.requestTimeoutMs : positiveInteger(normalized.requestTimeoutMs, 'requestTimeoutMs'),
    maxCacheableBodyBytes: normalized.maxCacheableBodyBytes === undefined ? DEFAULTS.maxCacheableBodyBytes : positiveInteger(normalized.maxCacheableBodyBytes, 'maxCacheableBodyBytes'),
    circuitBreaker: validateCircuitBreaker(normalized.circuitBreaker),
    rateLimit: validateRateLimit(normalized.rateLimit),
    managementToken: process.env.SUPER_LIGHTNING_MANAGEMENT_TOKEN,
    edition: process.env.SUPER_LIGHTNING_EDITION || 'evaluation',
    licensePath: process.env.SUPER_LIGHTNING_LICENSE_PATH || './data/super-lightning.license.json',
    licensePublicKey: process.env.SUPER_LIGHTNING_LICENSE_PUBLIC_KEY,
    trialStatePath: process.env.SUPER_LIGHTNING_TRIAL_STATE_PATH || './data/super-lightning.trial.json',
    routes: normalized.routes.map(validateRoute).sort((a, b) => b.prefix.length - a.prefix.length),
  };
  const prefixes = new Set();
  for (const route of config.routes) {
    if (prefixes.has(route.prefix)) throw new Error(`Duplicate route prefix: ${route.prefix}`);
    prefixes.add(route.prefix);
  }
  if (!['evaluation', 'official'].includes(config.edition)) throw new Error('SUPER_LIGHTNING_EDITION must be evaluation or official.');
  if (config.edition === 'official' && !config.licensePublicKey) throw new Error('SUPER_LIGHTNING_LICENSE_PUBLIC_KEY is required for the official edition.');
  return Object.freeze(config);
}

export async function loadConfig(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const overrides = {
    port: process.env.SUPER_LIGHTNING_PORT,
    defaultTtlSeconds: process.env.SUPER_LIGHTNING_DEFAULT_TTL_SECONDS,
    staleWhileRevalidateSeconds: process.env.SUPER_LIGHTNING_STALE_WHILE_REVALIDATE_SECONDS,
    staleIfErrorSeconds: process.env.SUPER_LIGHTNING_STALE_IF_ERROR_SECONDS,
    maxEntries: process.env.SUPER_LIGHTNING_MAX_ENTRIES,
    maxTtlSeconds: process.env.SUPER_LIGHTNING_MAX_TTL_SECONDS,
    requestTimeoutMs: process.env.SUPER_LIGHTNING_REQUEST_TIMEOUT_MS,
    maxCacheableBodyBytes: process.env.SUPER_LIGHTNING_MAX_CACHEABLE_BODY_BYTES,
  };
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) raw[key] = Number(value);
  return validateConfig(raw);
}
