# Running tests

```sh
npx playwright test                 # All browser/API cases, standard parallelism
npx playwright test tests/public-id-api.spec.js  # One spec, same isolation
npm run test:node                  # Node tests and isolated HTTP/MCP audit checks
npm run test:all                   # Both suites
```

Playwright builds the application once, then starts one local Wrangler server
per parallel worker. Every server has its own temporary D1 database, R2 storage,
configuration, built asset snapshot and port. It does not reuse port 3000 or `.wrangler/state`, so an
open development server and another test run cannot erase its data. Retrying is
disabled; a failure must be investigated. The legacy `playwright.no-server.config.js`
also uses this isolated setup.

The common fixture clears only its worker's database before and after each
case, including failed cases. Global teardown stops the owned server process
groups and removes their temporary directories. If the runner exits before
async teardown (for example SIGINT), a detached cleanup process stops its owned
server group and removes the same directory. Server logs are copied into
`tests/test-results/servers/`. The HTTP/MCP Node checks use the same server
factory and always stop it in `finally`.

## Adding cases

- Import `test` and `expect` from `./helpers/fixtures.js` for E2E specs. Pure
  in-memory unit specs can import directly from `@playwright/test`.
- Create the users, trees and nodes needed by the case. Do not depend on seeds
  or data left by another case. The fixture owns cleanup; tests exercising
  deletion can still delete their own data explicitly.
- Prefer relative URLs. If an absolute URL is needed, import `TEST_BASE_URL`
  from `./helpers/test-environment.js`; never hardcode port 3000.
- Direct SQLite checks must use `TEST_DB_PATH` from the same module. Never
  reference the developer's `.wrangler/state` database or run `db:reset` while
  a server is running.
- Multi-user cases can keep their existing user numbers and expected emails:
  other workers cannot invalidate those users' sessions.

For a stability check, run `npx playwright test` three times without a worker
or retry override. Run `npm run test:node` separately as well.
