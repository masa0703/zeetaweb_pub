import { run, startTestServer } from '../tests/helpers/test-server.js'

const pureTests = [
  ['--test', 'tests/signup-tree.test.js'],
  ['--experimental-strip-types', 'tests/audit-unit.test.ts'],
  ['--experimental-strip-types', '--test', 'tests/audit.spec.ts'],
  ...['i18n-unit', 'changelog-unit', 'github-email-unit', 'server-security-unit', 'mcp-oauth-purge-unit'].map(name => ['--experimental-strip-types', '--test', `tests/${name}.spec.ts`]),
]

for (const args of pureTests) await run(process.execPath, args)
await run('npm', ['run', 'build'])
const server = await startTestServer()
try {
  const env = { ...process.env, ZEETA_TEST_BASE_URL: server.baseURL, ZEETA_TEST_DB_PATH: server.dbPath, ZEETA_TEST_STATE_PATH: server.state }
  for (const name of ['audit-http', 'audit-mcp']) {
    const cleared = await fetch(`${server.baseURL}/api/test/clear`, { method: 'DELETE' })
    if (!cleared.ok) throw new Error('Failed to clear private Node test DB')
    await run(process.execPath, ['--experimental-strip-types', `tests/${name}.spec.ts`], { env })
  }
} finally {
  await server.stop()
}
