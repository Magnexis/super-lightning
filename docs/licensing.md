# Official Magnexis licensing and Stripe

The public accelerator has two operational modes:

- **Evaluation** (default): free, locally runnable, and persisted for 30 days.
- **Official**: requires a public verification key at startup; after evaluation expiry the proxy returns `402` until a valid Magnexis-signed license is installed.

This design keeps the performance data plane private and free from payment secrets. The official licensing service is a separate deployment.

## 1. Create Stripe products and prices

In the Magnexis Stripe account, create two one-time USD prices:

- Super Lightning Official Individual — **$350.00**
- Super Lightning Official Business — **$1,500.00**

The official live Price IDs are already listed in [`services/licensing/.env.example`](../services/licensing/.env.example). The service uses hosted Checkout Sessions with `mode=payment`; it does not accept an amount from the browser.

Use a restricted Stripe API key for the licensing service and a Stripe sandbox for development. Do not enable automatic tax until Magnexis has configured applicable tax registrations.

## 2. Generate signing keys

Create a dedicated Ed25519 key pair with your organization’s approved key-management process, or use the included local generator:

```sh
npm run license-keys -- --out /secure/path/super-lightning-ed25519.pem
```

Keep the private key only in the licensing-service secret store. Set its matching public key as `SUPER_LIGHTNING_LICENSE_PUBLIC_KEY` on official gateways.

The public gateway verifies `{ payload, signature }` license documents. It cannot mint a license because it never receives the private signing key.

## 3. Deploy the licensing service

Set these secrets/configuration values on the separate service:

```text
STRIPE_SECRET_KEY=rk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_INDIVIDUAL_PRICE_ID=price_...
STRIPE_BUSINESS_PRICE_ID=price_...
SUPER_LIGHTNING_LICENSE_PRIVATE_KEY=<Ed25519 private PEM>
LICENSING_SUCCESS_URL=https://licenses.example.com/success?session_id={CHECKOUT_SESSION_ID}
LICENSING_CANCEL_URL=https://licenses.example.com/cancel
LICENSING_PORT=4242
```

Set `LICENSING_PUBLIC_BASE_URL` to the public HTTPS hostname, then run `npm run license-server` or `docker compose -f docker-compose.licensing.yml up -d --build`. The service derives `/success` and `/cancel` URLs from that one hostname. `POST /checkout` accepts only `individual` or `business`, maps that choice to the server-side Price ID, and returns the hosted Checkout URL. It does not use user-provided amounts or prices.

Register `POST https://licenses.example.com/webhooks/stripe` in Stripe for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. The service verifies Stripe’s timestamped signature before acknowledging events, records a paid Super Lightning fulfillment in its private audit store, and only then confirms receipt. A successful buyer can retrieve a signed license from `GET /license?session_id=cs_...`; the service rechecks Stripe’s payment status before signing.

Verify the deployment before wiring the webhook with `GET /health`; it reports only whether Stripe and signing configuration are present, never secret values.

## 4. Install a license

Save the returned JSON document as the configured `SUPER_LIGHTNING_LICENSE_PATH`, set the public key, and restart the official gateway. `GET /_super-lightning/health` reports `licensed`, `trial`, or `expired` without exposing the license payload.

## Important limitation

Open source means a fork can remove its own license enforcement. The enforcement here protects the **official Magnexis distribution**, official brand, and official signed-license program; it cannot and should not claim to make source code impossible to modify.
