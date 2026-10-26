# Public Netlify deployment

Super Lightning uses Netlify for its public product page and official licensing endpoints. The accelerator does not run as a Netlify Function: it is a long-running HTTP gateway and should run locally, in a container, or on your chosen infrastructure.

## Included endpoints

| Endpoint | Role |
| --- | --- |
| `POST /.netlify/functions/checkout` | Creates a fixed-price hosted Stripe Checkout Session. |
| `GET /.netlify/functions/license?session_id=cs_...` | Verifies payment with Stripe and returns a signed license. |
| `POST /.netlify/functions/stripe-webhook` | Verifies Stripe’s timestamped event signature. |

## Required Netlify environment variables

Configure these as private Netlify environment variables for production and deploy previews where appropriate:

```text
STRIPE_SECRET_KEY=rk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
SUPER_LIGHTNING_LICENSE_PRIVATE_KEY=<Ed25519 private PEM>
STRIPE_INDIVIDUAL_PRICE_ID=price_1UUpd5DTgI7PpvvUO93U8pcB
STRIPE_BUSINESS_PRICE_ID=price_1UUpdEDTgI7PpvvUbHI4CnyH
```

Use a restricted Stripe key that can create Checkout Sessions and retrieve them. Do not place any of these in repository files or client-side variables.

## Launch checklist

1. Deploy the site.
2. Register the production webhook URL in Stripe and copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Make a test-mode transaction against an equivalent test configuration before accepting a live payment.
4. Confirm the thank-you page downloads a license that the gateway accepts with the configured public key.
5. Enable the live purchase buttons only after those checks succeed.

Netlify’s filesystem is ephemeral, so the function does not use it as a licensing database. License issuance is based on a fresh server-to-server Stripe payment-status check and an Ed25519 signature.
