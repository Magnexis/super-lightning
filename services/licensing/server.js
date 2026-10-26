import { createHmac, sign, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from 'node:http';

const port = Number(process.env.LICENSING_PORT || 4242);
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const privateKey = process.env.SUPER_LIGHTNING_LICENSE_PRIVATE_KEY;
const prices = { individual: process.env.STRIPE_INDIVIDUAL_PRICE_ID, business: process.env.STRIPE_BUSINESS_PRICE_ID };
const publicBaseUrl = process.env.LICENSING_PUBLIC_BASE_URL?.replace(/\/$/, '');
const successUrl = process.env.LICENSING_SUCCESS_URL || (publicBaseUrl ? `${publicBaseUrl}/success?session_id={CHECKOUT_SESSION_ID}` : undefined);
const cancelUrl = process.env.LICENSING_CANCEL_URL || (publicBaseUrl ? `${publicBaseUrl}/cancel` : undefined);
const fulfillmentPath = process.env.LICENSE_FULFILLMENT_PATH || './data/fulfilled-sessions.json';

function required(value, name) { if (!value) throw new Error(`${name} must be configured.`); return value; }
function send(response, status, payload) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(payload)); }
function readBody(request, limit = 32_768) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', (chunk) => { size += chunk.length; if (size > limit) { reject(new Error('body_too_large')); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
async function stripe(path, options = {}) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, { ...options, headers: { authorization: `Bearer ${required(stripeSecretKey, 'STRIPE_SECRET_KEY')}`, 'stripe-version': '2026-08-26.dahlia', ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || 'Stripe request failed.');
  return body;
}
function createLicense(session) {
  const claims = { product: 'super-lightning', tier: session.metadata?.tier, issuedTo: session.customer_details?.email || 'Stripe customer', issuedAt: new Date().toISOString(), licenseId: session.id };
  const payload = Buffer.from(JSON.stringify(claims));
  return { payload: payload.toString('base64url'), signature: sign(null, payload, required(privateKey, 'SUPER_LIGHTNING_LICENSE_PRIVATE_KEY')).toString('base64url') };
}
function signatureIsValid(raw, header) {
  const timestamp = /(?:^|,)t=(\d+)/.exec(header || '')?.[1];
  const signature = /(?:^|,)v1=([a-f0-9]+)/.exec(header || '')?.[1];
  if (!timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', required(webhookSecret, 'STRIPE_WEBHOOK_SECRET')).update(`${timestamp}.${raw}`).digest('hex');
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
function recordFulfillment(session) {
  if (!session?.id || session.payment_status !== 'paid' || session.metadata?.product !== 'super-lightning') return;
  let fulfilled = {};
  try { fulfilled = JSON.parse(readFileSync(fulfillmentPath, 'utf8')); } catch { /* Create the audit store on first successful fulfillment. */ }
  fulfilled[session.id] = { tier: session.metadata.tier, email: session.customer_details?.email || null, fulfilledAt: new Date().toISOString() };
  mkdirSync(dirname(fulfillmentPath), { recursive: true });
  writeFileSync(fulfillmentPath, JSON.stringify(fulfilled, null, 2), { mode: 0o600 });
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ok', stripeConfigured: Boolean(stripeSecretKey), signingConfigured: Boolean(privateKey) });
    if (request.method === 'GET' && url.pathname === '/success') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end('<!doctype html><title>Super Lightning license</title><h1>Payment received</h1><p>Your Super Lightning license is ready. Return to the deployment instructions to retrieve and install it.</p>');
    }
    if (request.method === 'GET' && url.pathname === '/cancel') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end('<!doctype html><title>Checkout cancelled</title><h1>Checkout cancelled</h1><p>No payment was taken. You can return when you are ready.</p>');
    }
    if (request.method === 'POST' && url.pathname === '/checkout') {
      const { tier } = JSON.parse((await readBody(request)).toString('utf8'));
      if (!prices[tier]) return send(response, 400, { error: 'invalid_tier' });
      const form = new URLSearchParams({ mode: 'payment', success_url: required(successUrl, 'LICENSING_SUCCESS_URL'), cancel_url: required(cancelUrl, 'LICENSING_CANCEL_URL'), 'line_items[0][price]': prices[tier], 'line_items[0][quantity]': '1', 'metadata[product]': 'super-lightning', 'metadata[tier]': tier, integration_identifier: `super_lightning_${Math.random().toString(36).slice(2, 10)}` });
      const session = await stripe('/checkout/sessions', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
      return send(response, 200, { checkoutUrl: session.url });
    }
    if (request.method === 'POST' && url.pathname === '/webhooks/stripe') {
      const raw = await readBody(request);
      if (!signatureIsValid(raw, request.headers['stripe-signature'])) return send(response, 400, { error: 'invalid_signature' });
      const event = JSON.parse(raw.toString('utf8'));
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) recordFulfillment(event.data?.object);
      return send(response, 200, { received: true });
    }
    if (request.method === 'GET' && url.pathname === '/license') {
      const sessionId = url.searchParams.get('session_id');
      if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return send(response, 400, { error: 'invalid_session_id' });
      const session = await stripe(`/checkout/sessions/${sessionId}`);
      if (session.payment_status !== 'paid' || session.metadata?.product !== 'super-lightning') return send(response, 409, { error: 'payment_not_fulfilled' });
      return send(response, 200, createLicense(session));
    }
    return send(response, 404, { error: 'not_found' });
  } catch (error) { return send(response, 500, { error: 'service_error', message: error.message }); }
}).listen(port, () => console.log(`Super Lightning licensing service listening on :${port}`));
