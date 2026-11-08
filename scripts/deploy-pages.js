#!/usr/bin/env node
// Cloudflare Pages deploy wrapper.
// Passes an ASCII-safe commit message to avoid API error 8000111
// (Pages API rejects non-UTF-8 or non-ASCII encoded commit messages from git).

import { execSync } from 'child_process'

let commitMsg = 'deploy'
try {
  const raw = execSync('git log -1 --pretty=%s', { encoding: 'utf8' }).trim()
  // Encode non-ASCII chars as their Unicode escape sequences so the string
  // stays valid ASCII when sent to the Cloudflare API.
  commitMsg = raw.replace(/[^\x00-\x7F]/g, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`)
} catch {
  // fallback to default
}

const cmd = `npx wrangler pages deploy dist --commit-message "${commitMsg.replace(/"/g, '\\"')}"`
console.log(`Running: ${cmd}`)
execSync(cmd, { stdio: 'inherit' })
