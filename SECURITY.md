# Security policy

Super Lightning is designed to be deployed as a constrained gateway, not an open proxy.

## Deployment guidance

- Configure specific HTTPS upstreams whenever possible.
- Do not expose `/_super-lightning/metrics` publicly unless its request counts are acceptable to disclose.
- Put TLS termination and any required authentication at a trusted reverse proxy.
- Keep the configuration file read-only for the running process.
- Run one process per cache domain unless you intentionally accept separate per-instance caches.

## Reporting a vulnerability

Please report security issues privately to the repository maintainers rather than opening a public issue. Do not include credentials, production URLs, or customer data in a report.
