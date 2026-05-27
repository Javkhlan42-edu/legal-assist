# Test Layout

All project tests live under this root-level `test/` directory.

- `api/` contains Vitest tests for `apps/api`.
- `worker/` contains Vitest tests for `apps/worker`.
- `scripts/` contains manual smoke-test and verification scripts.

Package-level `vitest.config.ts` files point each workspace package at its matching test folder.
