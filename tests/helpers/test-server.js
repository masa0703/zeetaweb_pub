import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js')
const activeServers = new Set()
let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.allSettled([...activeServers].map(stop => stop()))
  process.exit(signal === 'SIGINT' ? 130 : 143)
}
const interrupt = () => { void shutdown('SIGINT') }
const terminate = () => { void shutdown('SIGTERM') }

export async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options })
  const [code, signal] = await once(child, 'exit')
  if (code !== 0) throw new Error(`${command} exited with ${code ?? signal}`)
}

async function freePort() {
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  return port
}

export async function findDatabase(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findDatabase(filename)
      if (found) return found
    } else if (entry.name.endsWith('.sqlite')) return filename
  }
}

// Every instance owns its process group and persistence directory. Never reuse or
// kill the developer's port 3000 server, and never open .wrangler/state.
export async function startTestServer() {
  const port = await freePort()
  const directory = await mkdtemp(path.join(tmpdir(), 'zeeta-test-'))
  const state = path.join(directory, 'state')
  const assets = path.join(directory, 'dist')
  const baseURL = `http://localhost:${port}`
  const config = path.join(directory, 'wrangler.toml')
  const logPath = path.join(directory, 'server.log')
  let child
  let stopPromise
  const kill = () => {
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
  const cleanupOnExit = () => {
    kill()
    spawn(process.execPath, [path.join(import.meta.dirname, 'cleanup-server.js'), String(child?.pid || 0), directory], {
      detached: true, stdio: 'ignore',
    }).unref()
  }
  const stop = () => stopPromise ||= (async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      kill()
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      }, 5000)
      try { await exited } finally { clearTimeout(timer) }
    }
    kill()
    await rm(directory, { recursive: true, force: true })
    process.removeListener('exit', cleanupOnExit)
    activeServers.delete(stop)
    if (!activeServers.size) {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
    }
  })()
  if (!activeServers.size) {
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
  }
  activeServers.add(stop)
  process.once('exit', cleanupOnExit)
  try {
    await mkdir(state)
    await cp(path.join(root, 'dist'), assets, { recursive: true })
    await writeFile(config, `name = "zeeta-test"
compatibility_date = "2025-12-07"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = ${JSON.stringify(assets)}
[vars]
APP_URL = ${JSON.stringify(baseURL)}
ENABLE_TEST_ENDPOINTS = "true"
JWT_SECRET = "local-isolated-test-secret-only-0123456789"
[[d1_databases]]
binding = "DB"
database_name = "zeeta-test"
database_id = "00000000-0000-0000-0000-000000000001"
migrations_dir = ${JSON.stringify(path.join(root, 'migrations'))}
[[r2_buckets]]
binding = "NODE_IMAGES"
bucket_name = "zeeta-test-images"
`)
    // The migration process must finish before workerd opens the SQLite file.
    let migrationLog = ''
    const migration = spawn(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'zeeta-test', '--local', '--config', config, '--persist-to', state], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child = migration
    migration.stdout.on('data', data => { migrationLog += data })
    migration.stderr.on('data', data => { migrationLog += data })
    const [code] = await once(migration, 'exit')
    if (code !== 0) throw new Error(`Test migrations failed:\n${migrationLog}`)
    const dbPath = await findDatabase(path.join(state, 'v3/d1'))
    if (!dbPath) throw new Error('Test D1 database was not created')
    child = spawn(process.execPath, [wrangler, 'pages', 'dev', assets, '--persist-to', state, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0'], { cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const log = data => { output = (output + data).slice(-100000); appendFileSync(logPath, data) }
    child.stdout.on('data', log)
    child.stderr.on('data', log)
    const deadline = Date.now() + 60000
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        // A static 200 does not establish that D1 or test login is healthy.
        const response = await fetch(`${baseURL}/auth/test-login?user_id=999999`, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
        if (response.status === 302) {
          const cleared = await fetch(`${baseURL}/api/test/clear`, { method: 'DELETE' })
          if (!cleared.ok) throw new Error('Test reset failed')
          return { baseURL, dbPath, state, directory, stop }
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error(`Test server did not become healthy (${baseURL}):\n${output}`)
  } catch (error) {
    await stop()
    throw error
  }
}
