import { createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TRIAL_DAYS = 30;

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

export function verifyLicenseDocument(document, publicKeyPem, now = Date.now()) {
  if (!document || typeof document !== 'object' || typeof document.payload !== 'string' || typeof document.signature !== 'string') {
    return { valid: false, reason: 'malformed_license' };
  }
  try {
    const payload = decodeBase64Url(document.payload);
    const signature = decodeBase64Url(document.signature);
    if (!verify(null, payload, createPublicKey(publicKeyPem), signature)) return { valid: false, reason: 'invalid_signature' };
    const claims = JSON.parse(payload.toString('utf8'));
    if (claims.product !== 'super-lightning' || !['individual', 'business'].includes(claims.tier)) return { valid: false, reason: 'invalid_claims' };
    if (claims.expiresAt && Date.parse(claims.expiresAt) <= now) return { valid: false, reason: 'expired_license' };
    return { valid: true, claims };
  } catch {
    return { valid: false, reason: 'invalid_license' };
  }
}

function trialStartedAt(path, now) {
  if (existsSync(path)) {
    try { return Date.parse(JSON.parse(readFileSync(path, 'utf8')).startedAt); } catch { return NaN; }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ startedAt: new Date(now).toISOString() }), { mode: 0o600 });
  return now;
}

export function resolveLicenseStatus(config, now = Date.now()) {
  if (config.licensePath && config.licensePublicKey && existsSync(config.licensePath)) {
    try {
      const result = verifyLicenseDocument(JSON.parse(readFileSync(config.licensePath, 'utf8')), config.licensePublicKey, now);
      if (result.valid) return { state: 'licensed', permitted: true, tier: result.claims.tier, issuedTo: result.claims.issuedTo };
    } catch { /* A corrupted local license falls back to the persisted evaluation state. */ }
  }
  const started = trialStartedAt(config.trialStatePath, now);
  const expiresAt = started + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  return { state: now < expiresAt ? 'trial' : 'expired', permitted: now < expiresAt, expiresAt: new Date(expiresAt).toISOString() };
}
