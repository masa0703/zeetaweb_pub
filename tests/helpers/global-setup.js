import { run, startTestServer } from './test-server.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export default async function setup(config) {
  await run('npm', ['run', 'build'])
  const servers = []
  try {
    // Start sequentially to avoid Wrangler CLI startup contention. Tests then
    // run in parallel; each parallelIndex has its own D1 and R2 instance.
    for (let index = 0; index < config.workers; index++) {
      servers.push(await startTestServer())
    }
    process.env.ZEETA_TEST_SERVERS = JSON.stringify(servers.map(({ baseURL, dbPath, state }) => ({ baseURL, dbPath, state })))
  } catch (error) {
    await Promise.all(servers.map(server => server.stop()))
    throw error
  }
  return async () => {
    try {
      const logs = path.join(config.projects[0].outputDir, 'servers')
      await mkdir(logs, { recursive: true })
      for (const [index, server] of servers.entries()) {
        await writeFile(path.join(logs, `worker-${index}.log`), await readFile(path.join(server.directory, 'server.log')))
      }
    } finally {
      await Promise.all(servers.map(server => server.stop()))
      delete process.env.ZEETA_TEST_SERVERS
    }
  }
}
