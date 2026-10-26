import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveLicenseStatus, verifyLicenseDocument } from '../src/license.js';

test('verifies a Magnexis-issued signed Super Lightning license', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload = Buffer.from(JSON.stringify({ product: 'super-lightning', tier: 'business', issuedTo: 'team@example.com', issuedAt: '2026-10-25T00:00:00.000Z', licenseId: 'cs_test_license' }));
  const document = { payload: payload.toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url') };
  const result = verifyLicenseDocument(document, publicKey.export({ type: 'spki', format: 'pem' }));
  assert.equal(result.valid, true);
  assert.equal(result.claims.tier, 'business');
});

test('rejects a tampered license payload', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload = Buffer.from(JSON.stringify({ product: 'super-lightning', tier: 'individual' }));
  const document = { payload: Buffer.from(JSON.stringify({ product: 'super-lightning', tier: 'business' })).toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url') };
  assert.deepEqual(verifyLicenseDocument(document, publicKey.export({ type: 'spki', format: 'pem' })), { valid: false, reason: 'invalid_signature' });
});

test('requires a license when a persisted evaluation has expired', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'super-lightning-license-'));
  const trialStatePath = join(directory, 'trial.json');
  await writeFile(trialStatePath, JSON.stringify({ startedAt: '2026-01-01T00:00:00.000Z' }));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const status = resolveLicenseStatus({ edition: 'evaluation', licensePath: join(directory, 'license.json'), licensePublicKey: undefined, trialStatePath }, Date.parse('2026-03-01T00:00:00.000Z'));
  assert.equal(status.state, 'expired');
  assert.equal(status.permitted, false);
});
