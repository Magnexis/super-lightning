import { readFile } from 'node:fs/promises';

const DEFAULTS = {
  port: 8787,
  defaultTtlSeconds: 30,
  staleWhileRevalidateSeconds: 60,
  maxEntries: 1000,
};

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

  let upstream;
  try { upstream = new URL(route.upstream); } catch { throw new Error(`Route ${route.prefix} has an invalid upstream URL.`); }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) {
    throw new Error(`Route ${route.prefix} must use an http(s) upstream without embedded credentials.`);
  }

  return Object.freeze({
    prefix: route.prefix,
    upstream: upstream.toString().replace(/\/$/, ''),
    cacheTtlSeconds: route.cacheTtlSeconds === undefined
      ? undefined
      : positiveInteger(route.cacheTtlSeconds, `cacheTtlSeconds for ${route.prefix}`),
  });
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Configuration must be a JSON object.');
  if (!Array.isArray(raw.routes) || raw.routes.length === 0) throw new Error('Configuration requires at least one route.');

  const config = {
    port: raw.port === undefined ? DEFAULTS.port : positiveInteger(raw.port, 'port'),
    defaultTtlSeconds: raw.defaultTtlSeconds === undefined ? DEFAULTS.defaultTtlSeconds : positiveInteger(raw.defaultTtlSeconds, 'defaultTtlSeconds'),
    staleWhileRevalidateSeconds: raw.staleWhileRevalidateSeconds === undefined ? DEFAULTS.staleWhileRevalidateSeconds : positiveInteger(raw.staleWhileRevalidateSeconds, 'staleWhileRevalidateSeconds'),
    maxEntries: raw.maxEntries === undefined ? DEFAULTS.maxEntries : positiveInteger(raw.maxEntries, 'maxEntries'),
    routes: raw.routes.map(validateRoute).sort((a, b) => b.prefix.length - a.prefix.length),
  };
  const prefixes = new Set();
  for (const route of config.routes) {
    if (prefixes.has(route.prefix)) throw new Error(`Duplicate route prefix: ${route.prefix}`);
    prefixes.add(route.prefix);
  }
  return Object.freeze(config);
}

export async function loadConfig(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const overrides = {
    port: process.env.SUPER_LIGHTNING_PORT,
    defaultTtlSeconds: process.env.SUPER_LIGHTNING_DEFAULT_TTL_SECONDS,
    staleWhileRevalidateSeconds: process.env.SUPER_LIGHTNING_STALE_WHILE_REVALIDATE_SECONDS,
    maxEntries: process.env.SUPER_LIGHTNING_MAX_ENTRIES,
  };
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) raw[key] = Number(value);
  return validateConfig(raw);
}
