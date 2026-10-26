# Super Lightning

<p align="center">
  <img src="assets/super-lightning-mark-3d.png" width="280" alt="Super Lightning three-dimensional lightning mark">
</p>

> The private acceleration plane for infrastructure you already own — built by **Magnexis**.

Super Lightning makes existing HTTP services materially faster without forcing a rewrite, paid CDN, or hosted control plane. It is a self-hosted, dependency-free accelerator that combines safe caching, coalescing, compression, stale delivery, stale-on-error resilience, compatible-origin failover, circuit breaking, and local intelligence.

It runs beside an API, on a VM, or inside a container. Its acceleration path does not call Magnexis, Stripe, or any other third party.

## Editions and official pricing

| Edition | Use | Price |
| --- | --- | --- |
| Evaluation | Any product or project for its first 30 days | Free |
| Individual | One person continuing after the 30-day evaluation | **$350 USD**, one-time |
| Business | A company or team continuing after the 30-day evaluation | **$1,500 USD**, one-time |

The free evaluation persists its start state in the configured data directory and requires a cryptographically signed Magnexis license after 30 days. Stripe Price IDs, checkout secrets, and signing keys live only in the separate licensing service, never in the gateway. A fork can choose its own terms, but cannot issue an official Magnexis license or represent itself as the official product.

## What it accelerates

- Repeated `GET` and `HEAD` requests to configured upstream APIs
- Static JSON, JavaScript, CSS, images, fonts, and other cacheable public responses
- Cache stampedes: concurrent identical requests share one upstream fetch
- Transfer size: cached text responses are delivered with Brotli or gzip when the client supports them
- Origin continuity: ordered backup origins are used when the primary fails or returns a 5xx response
- Operational clarity: health, JSON/Prometheus metrics, and a private Acceleration Brief identify hot paths and cache tuning opportunities
- Conditional requests: cache hits honor an upstream ETag and can return `304 Not Modified` without touching the origin
- Origin protection: optional per-client rate limits and a configurable upstream timeout
- Failure containment: an origin circuit breaker stops repeatedly calling an unavailable upstream
- Continuity without vendor lock-in: routes can fail over to one or more compatible backup origins

It does **not** cache authenticated responses, `Set-Cookie` responses, or responses marked `private`/`no-store`. The cache is in-memory, so start with one replica or use it as a per-instance near cache.

## Quick start

1. Copy the example configuration:

   ```sh
   cp super-lightning.config.example.json super-lightning.config.json
   ```

2. Point an upstream at your existing service, then run:

   ```sh
   npm start -- --config ./super-lightning.config.json
   ```

3. Request it through the route prefix you configured:

   ```sh
   curl -i http://localhost:8787/api/products
   ```

The response includes `x-super-lightning: MISS`, `HIT`, `COALESCED`, `STALE`, or `BYPASS` to make behavior observable. Open `GET /_super-lightning/console` for the live Lightning Console: an electric acceleration field whose flow, brightness, and pulse speed react to real request rate, cache efficiency, coalescing, failovers, and circuit events. `GET /_super-lightning/health`, `GET /_super-lightning/metrics`, and `GET /_super-lightning/metrics/prometheus` are local management endpoints. Authenticated `POST /_super-lightning/warm` preloads 1–50 configured public paths after a deploy or purge; it never accepts arbitrary origin URLs.

The console’s **Target Lab** uses authenticated `POST /_super-lightning/analyze` to measure configured paths and report origin latency, cache headers, ETag support, payload size, and safe tuning recommendations. It never modifies upstreams or writes configuration.

## Configuration

Start with a workload profile, then override only the fields your service needs:

| Profile | Optimized for | What it accelerates |
| --- | --- | --- |
| `general` | Typical APIs and static services | Public API reads and web/static resources. |
| `ai-training` | Dataset, checkpoint, tokenizer, and artifact delivery | HTTP data fetches around training; it does **not** make GPU/CPU training computation faster. |
| `ai-agent` | Repeated public reads used by agent tools | Documentation, catalogs, public data APIs, registry metadata, and other safe GET/HEAD tool calls. |
| `developer-work` | Package metadata, artifacts, and internal developer tools | Repeatable public read paths in build and developer workflows. |

Profiles set conservative cache, stale, timeout, entry-count, and response-size defaults. Any explicitly supplied setting wins over the profile.

```json
{
  "workloadProfile": "ai-agent",
  "port": 8787,
  "defaultTtlSeconds": 30,
  "staleWhileRevalidateSeconds": 60,
  "maxEntries": 1000,
  "maxTtlSeconds": 3600,
  "requestTimeoutMs": 15000,
  "maxCacheableBodyBytes": 5242880,
  "circuitBreaker": {
    "failureThreshold": 5,
    "resetSeconds": 15
  },
  "rateLimit": {
    "maxRequests": 120,
    "windowSeconds": 60
  },
  "routes": [
    {
      "prefix": "/api",
      "upstream": "https://api.example.com",
      "fallbackUpstreams": ["https://api-backup.example.com"],
      "ignoreQueryParameters": ["utm_source", "utm_medium"],
      "cacheTtlSeconds": 60
    }
  ]
}
```

Each `prefix` becomes the external route and is removed before the request is sent upstream. For example, `/api/v1/status` becomes `https://api.example.com/v1/status`. Route selection and upstream URLs come entirely from this configuration; requests cannot provide an arbitrary destination URL. If a route has no `cacheTtlSeconds`, Super Lightning uses the origin's `s-maxage`/`max-age` directive, falling back to `defaultTtlSeconds`, and always caps it at `maxTtlSeconds`.

`ignoreQueryParameters` is an explicit per-route list of known non-semantic parameters, such as tracking tags. Super Lightning removes only the listed names before calling the upstream and generating the cache key. Do not list a parameter that changes authorization, content, tenant, model, dataset revision, or other response semantics.

`maxCacheableBodyBytes` keeps unexpectedly large responses out of the in-memory cache while still proxying them to the caller. Super Lightning only stores responses whose `Vary` header is compatible with its cache key (`Accept`, `Accept-Language`, and compression); other variants are safely proxied without caching. The circuit breaker opens after consecutive connectivity failures or upstream 5xx responses, returning a fast `503` for `resetSeconds` before allowing a new attempt.

`fallbackUpstreams` is an ordered list of compatible origins for a route. If the primary connection fails, responds with a 5xx status, or has an open circuit, Super Lightning tries the next origin. This works with ordinary HTTP services and does not depend on a managed CDN, cloud account, or proprietary control plane.

Environment variables can override top-level settings: `SUPER_LIGHTNING_PORT`, `SUPER_LIGHTNING_DEFAULT_TTL_SECONDS`, `SUPER_LIGHTNING_STALE_WHILE_REVALIDATE_SECONDS`, `SUPER_LIGHTNING_MAX_ENTRIES`, `SUPER_LIGHTNING_MAX_TTL_SECONDS`, and `SUPER_LIGHTNING_REQUEST_TIMEOUT_MS`.

## Official licensing and Stripe

Super Lightning begins in `evaluation` mode. Configure an Ed25519 public verification key and a persistent data directory before the evaluation expires; it returns HTTP `402` after 30 days until a valid Magnexis license is installed. `SUPER_LIGHTNING_EDITION=official` is available for deployments that require the public key at startup. The included licensing service creates hosted Stripe Checkout sessions and issues a signed license only after Stripe reports the session as paid.

```sh
# Accelerator: public values and a persisted local state only
SUPER_LIGHTNING_EDITION=official
SUPER_LIGHTNING_LICENSE_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----...'
SUPER_LIGHTNING_LICENSE_PATH=/app/data/super-lightning.license.json

# Licensing service: deploy separately; never expose these values to the gateway
STRIPE_SECRET_KEY=rk_live_...
STRIPE_INDIVIDUAL_PRICE_ID=price_...
STRIPE_BUSINESS_PRICE_ID=price_...
SUPER_LIGHTNING_LICENSE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----...'
npm run license-server
```

The Stripe webhook endpoint is `POST /webhooks/stripe`; configure `STRIPE_WEBHOOK_SECRET` and use Stripe’s signed events. The gateway itself never receives a Stripe secret. Detailed setup is in [docs/licensing.md](docs/licensing.md).

### Cache invalidation

Set `SUPER_LIGHTNING_MANAGEMENT_TOKEN` in the runtime environment (never in the JSON configuration), then purge the complete cache or a public route prefix:

```sh
curl -X POST -H "x-super-lightning-token: $SUPER_LIGHTNING_MANAGEMENT_TOKEN" \
  'http://localhost:8787/_super-lightning/purge?prefix=/api/catalog'
```

The purge endpoint returns `403` until a token is configured. The Prometheus endpoint and management endpoints should be restricted at your outer reverse proxy in production.

### Acceleration Brief

When `SUPER_LIGHTNING_MANAGEMENT_TOKEN` is configured, request `GET /_super-lightning/insights` with the `x-super-lightning-token` header. It returns local-only route activity, hot paths, hit rates, failover observations, and concrete tuning suggestions. It does not upload traffic data or call an AI service.

## Deployment

Build and run the included image:

```sh
docker build -t super-lightning .
docker run --rm -p 8787:8787 -v "$(pwd)/super-lightning.config.json:/app/super-lightning.config.json:ro" super-lightning
```

For a reverse-proxy deployment, restrict the management paths at the outer proxy if you do not want them publicly visible.

### Public site and Stripe Checkout on Netlify

The repository includes a public Magnexis landing site and three Netlify Functions: fixed-price hosted Checkout, signed license retrieval, and Stripe webhook verification. The gateway itself remains deployable anywhere; this Netlify surface only handles the official purchase flow.

1. Connect this repository to a Netlify project and set the build publish directory to `site` (the included [`netlify.toml`](netlify.toml) does this).
2. Set these **server-side Netlify environment variables**—never `NETLIFY_PUBLIC_*` variables: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPER_LIGHTNING_LICENSE_PRIVATE_KEY`, `STRIPE_INDIVIDUAL_PRICE_ID`, and `STRIPE_BUSINESS_PRICE_ID`.
3. In Stripe, register `https://<your-site>/.netlify/functions/stripe-webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Deploy and confirm `POST /.netlify/functions/checkout` produces a hosted Stripe Checkout URL before linking the public purchase buttons to customers.

The repository contains no live secrets. Netlify Functions recheck the payment with Stripe before they sign and return a downloadable license.

## Development

Requires Node.js 20 or newer. There are no runtime dependencies.

```sh
npm test
npm run check
```

## Status

The first release is an in-memory, single-process cache suitable for small and medium services. It includes authenticated cache purges, Prometheus-format metrics, bounded cache entries, and per-upstream circuit breakers. Distributed cache sharing and disk persistence are intentionally out of scope for now.

## Security model

- Only `GET` and `HEAD` are proxied.
- Upstream destinations must be declared in configuration.
- Authorization, cookies, and cache-control directives bypass storage.
- Hop-by-hop request/response headers are stripped.
- Management endpoints are not forwarded upstream.
- Purges require a runtime-only management token.

See [SECURITY.md](SECURITY.md) for operational guidance.

## Documentation and contribution

- [Deployment guide](docs/deployment.md)
- [Licensing and Stripe guide](docs/licensing.md)
- [Architecture](docs/architecture.md)
- [Workload profiles](docs/workload-profiles.md)
- [Security guidance](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Magnexis brand policy](BRAND.md)
