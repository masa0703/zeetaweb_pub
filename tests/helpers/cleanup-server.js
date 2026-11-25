// Emergency cleanup runs in a separate process group when the test runner exits
// before its async teardown. It receives only the process group and temporary
// directory created by startTestServer, never the developer's server or DB.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

const pid = Number(process.argv[2])
const directory = process.argv[3]
if (!directory || path.dirname(directory) !== tmpdir().replace(/\/$/, '') || !path.basename(directory).startsWith('zeeta-test-')) {
  throw new Error('Refusing to clean a non-test directory')
}
const alive = () => {
  if (!pid) return false
  try { process.kill(-pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
if (alive()) {
  try { process.kill(-pid, 'SIGTERM') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
const deadline = Date.now() + 5000
while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
if (alive()) {
  try { process.kill(-pid, 'SIGKILL') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  await new Promise(resolve => setTimeout(resolve, 200))
}
await rm(directory, { recursive: true, force: true })
