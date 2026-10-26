# Security policy

Super Lightning is designed to be deployed as a constrained gateway, not an open proxy.

## Deployment guidance

- Configure specific HTTPS upstreams whenever possible.
- Do not expose `/_super-lightning/metrics` publicly unless its request counts are acceptable to disclose.
- Put TLS termination and any required authentication at a trusted reverse proxy.
- Set `SUPER_LIGHTNING_MANAGEMENT_TOKEN` only as a secret environment variable if cache purging is enabled; do not place it in the JSON configuration or a container image.
- Treat the configured rate limit as local process protection. It is not a distributed DDoS control and intentionally does not trust `X-Forwarded-For` by default.
- Set `maxCacheableBodyBytes` to a bound appropriate for the host. The limit prevents cache retention of oversized upstream responses, but it is not a substitute for ingress request/response size limits at a reverse proxy.
- Keep the configuration file read-only for the running process.
- Run one process per cache domain unless you intentionally accept separate per-instance caches.

## Reporting a vulnerability

Please report security issues privately to the repository maintainers rather than opening a public issue. Do not include credentials, production URLs, or customer data in a report.
