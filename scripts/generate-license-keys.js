import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const outputIndex = process.argv.indexOf('--out');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (!output) throw new Error('Usage: node scripts/generate-license-keys.js --out <private-key-path>');
const privatePath = resolve(output);
const publicPath = `${privatePath}.pub`;
if (existsSync(privatePath) || existsSync(publicPath)) throw new Error('Refusing to overwrite an existing key file.');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
mkdirSync(dirname(privatePath), { recursive: true });
writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
console.log(`Created signing key pair. Keep ${privatePath} private; distribute ${publicPath} to official gateways.`);
