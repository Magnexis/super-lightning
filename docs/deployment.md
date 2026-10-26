# Deployment guide

## Architecture

```text
Client → Super Lightning → primary origin
                   ├── in-memory cache + compression
                   ├── rate limiter + circuit breakers
                   └── fallback origin(s)
```

Configure only routes that Super Lightning should proxy. A route removes its `prefix` before sending the request upstream, so `/api/products` with prefix `/api` becomes `<upstream>/products`.

## Docker

```sh
docker build -t super-lightning .
docker run --rm -p 8787:8787 \
  -v "$(pwd)/super-lightning.config.json:/app/super-lightning.config.json:ro" \
  -v super-lightning-data:/app/data \
  super-lightning
```

The data volume is required for a persistent evaluation or installed license.

## Production checklist

- Use explicit HTTPS origins and optional compatible fallback origins.
- Put TLS termination and access control at a trusted reverse proxy.
- Restrict `/_super-lightning/*` endpoints; set `SUPER_LIGHTNING_MANAGEMENT_TOKEN` for purge and insight access.
- Start with conservative TTLs and inspect `x-super-lightning` response headers before increasing them.
- Scrape `/_super-lightning/metrics/prometheus` from local Prometheus if desired.
- Do not trust `X-Forwarded-For` unless an outer proxy normalizes it; the built-in rate limiter intentionally uses the peer address.

## Cache behavior

Super Lightning never stores credentialed/cookie requests or responses marked `Set-Cookie`, `private`, `no-store`, or `no-cache`. It only caches safe `Vary` variants and will not retain a response beyond `maxCacheableBodyBytes`. `cacheTtlSeconds` wins when configured; otherwise it honors `s-maxage`/`max-age`, then `defaultTtlSeconds`, capped by `maxTtlSeconds`.

After freshness and stale-while-revalidate windows elapse, `staleIfErrorSeconds` controls how long a public cached response may be served only when every origin attempt fails. This protects end users during a transient origin failure while preventing indefinite stale delivery.

## Release warming

After a deploy or purge, a trusted pipeline can pre-warm public endpoints. Super Lightning accepts only 1–50 local paths matching configured routes; it never accepts an arbitrary upstream URL.

```sh
curl -X POST http://localhost:8787/_super-lightning/warm \
  -H "content-type: application/json" \
  -H "x-super-lightning-token: $SUPER_LIGHTNING_MANAGEMENT_TOKEN" \
  --data '{"paths":["/api/catalog","/api/status"]}'
```
