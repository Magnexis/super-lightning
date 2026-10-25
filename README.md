# Super Lightning

Super Lightning is a small, self-hosted cache gateway for existing JSON and static HTTP APIs. Put it in front of services that are correct but slow or expensive to call repeatedly. It safely proxies only explicitly configured upstreams, coalesces identical in-flight requests, serves cache hits with compression, and exposes lightweight runtime metrics.

It is deliberately a focused alternative to a general-purpose CDN: no account, database, or dependency install is required. It is useful on a single VM, behind a load balancer, or in a container alongside an existing application.

## What it accelerates

- Repeated `GET` and `HEAD` requests to configured upstream APIs
- Static JSON, JavaScript, CSS, images, fonts, and other cacheable public responses
- Cache stampedes: concurrent identical requests share one upstream fetch
- Transfer size: cached text responses are delivered with Brotli or gzip when the client supports them

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

The response includes `x-super-lightning: MISS`, `HIT`, `COALESCED`, `STALE`, or `BYPASS` to make behavior observable. `GET /_super-lightning/health` and `GET /_super-lightning/metrics` are local management endpoints.

## Configuration

```json
{
  "port": 8787,
  "defaultTtlSeconds": 30,
  "staleWhileRevalidateSeconds": 60,
  "maxEntries": 1000,
  "routes": [
    {
      "prefix": "/api",
      "upstream": "https://api.example.com",
      "cacheTtlSeconds": 60
    }
  ]
}
```

Each `prefix` becomes the external route and is removed before the request is sent upstream. For example, `/api/v1/status` becomes `https://api.example.com/v1/status`. Route selection and upstream URLs come entirely from this configuration; requests cannot provide an arbitrary destination URL.

Environment variables can override top-level settings: `SUPER_LIGHTNING_PORT`, `SUPER_LIGHTNING_DEFAULT_TTL_SECONDS`, `SUPER_LIGHTNING_STALE_WHILE_REVALIDATE_SECONDS`, and `SUPER_LIGHTNING_MAX_ENTRIES`.

## Deployment

Build and run the included image:

```sh
docker build -t super-lightning .
docker run --rm -p 8787:8787 -v "$(pwd)/super-lightning.config.json:/app/super-lightning.config.json:ro" super-lightning
```

For a reverse-proxy deployment, restrict the management paths at the outer proxy if you do not want them publicly visible.

## Development

Requires Node.js 20 or newer. There are no runtime dependencies.

```sh
npm test
npm run check
```

## Status

The first release is an in-memory, single-process cache suitable for small and medium services. Distributed cache sharing, disk persistence, cache purges, and observability exporters are intentionally out of scope for now.

## Security model

- Only `GET` and `HEAD` are proxied.
- Upstream destinations must be declared in configuration.
- Authorization, cookies, and cache-control directives bypass storage.
- Hop-by-hop request/response headers are stripped.
- Management endpoints are not forwarded upstream.

See [SECURITY.md](SECURITY.md) for operational guidance.
