# Architecture

Super Lightning has three explicit trust boundaries.

1. **Gateway:** accepts only `GET` and `HEAD`, maps routes only to configured origins, and owns cache/resilience behavior.
2. **Management:** protected purge and insight endpoints require the local management token.
3. **Licensing:** a separately deployed Magnexis service holds Stripe and Ed25519 private keys. The gateway receives only a public verification key and a signed document.

## Request path

1. Match the request against a configured prefix.
2. Enforce the optional local rate limiter and evaluation/license state.
3. Serve a safe fresh or stale cache entry where available.
4. Coalesce matching in-flight misses.
5. Try the primary origin, then configured fallbacks when failure or 5xx occurs.
6. Store only safe, bounded, public responses and return cache state headers.

The cache is intentionally in-memory and process-local. It favors simple operations and low cost over distributed-cache complexity. Use a shared cache or CDN separately only when the deployment genuinely needs global cache coherence.
