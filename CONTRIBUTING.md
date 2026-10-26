# Contributing to Super Lightning

Magnexis welcomes focused contributions that make existing infrastructure faster, safer, and easier to operate.

1. Discuss substantial architecture changes in an issue first.
2. Preserve the safe-proxy boundary and prioritize cache correctness over hit rate.
3. Keep additions dependency-free unless a dependency has a clear security and maintenance case.
4. Add behavior-focused tests and run `npm run check` plus `npm test`.
5. Never commit production traffic data, license documents, Stripe IDs, credentials, or signing keys.

Official Magnexis Stripe products, Price IDs, private signing keys, checkout deployment, and commercial policy are controlled outside the public gateway. Do not submit changes intended to alter official pricing or bypass official-license verification.
