#!/usr/bin/env node
/**
 * One command that proves the portal actually works: `npm run smoke`.
 *
 * It boots the real server against a throwaway database, waits for /healthz, then
 * drives the public site and all three logins over HTTP. No mocks, no test framework —
 * if the server, the seed data, the session or a route breaks, this exits non-zero.
 *
 * CI runs exactly this file, so a green badge means the same thing locally.
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT) || 3111
const BASE = `http://127.0.0.1:${PORT}`
const READY_TIMEOUT_S = 60

/** role:username:password:landing page */
const LOGINS = [
  ['admin', 'admin', 'admin123', '/admin'],
  ['parent', 'parent1', 'parent123', '/parent'],
  ['teacher', 'teacher1', 'teacher123', '/teacher'],
]

let log = ''
function note(line) {
  log += line + '\n'
  process.stdout.write(line + '\n')
}
function fail(reason) {
  console.error(`\n✗ ${reason}`)
  console.error('\n--- server output ---')
  console.error(log || '(empty)')
  throw new Error(reason)
}
function expect(actual, expected, what) {
  if (actual !== expected) fail(`${what}: got ${actual}, expected ${expected}`)
  note(`  ✓ ${what}`)
}

/** Minimal cookie jar — enough for express-session's single cookie. */
function cookiesFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean)
  return raw.map((c) => c.split(';')[0]).join('; ')
}

async function waitForServer(child) {
  for (let i = 1; i <= READY_TIMEOUT_S; i++) {
    if (child.exitCode !== null) fail(`server exited before becoming ready (code ${child.exitCode})`)
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) {
        const body = await res.text()
        note(`server ready after ~${i}s: ${body}`)
        return body
      }
    } catch {
      // not listening yet
    }
    await sleep(1000)
  }
  fail(`server never became ready on ${BASE} within ${READY_TIMEOUT_S}s`)
}

async function main() {
  note(`starting ${BASE} (NODE_ENV=${process.env.NODE_ENV ?? 'default'})`)
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      SESSION_SECRET: process.env.SESSION_SECRET || 'smoke-test-secret-not-for-deployments',
      NODE_ENV: process.env.NODE_ENV || 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))

  const stop = () => {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  process.on('exit', stop)
  process.on('SIGINT', () => { stop(); process.exit(130) })

  try {
    note('\n[1] health check reads the database, not just the process')
    const health = await waitForServer(child)
    if (!health.includes('"ok":true')) fail(`healthz did not report ok:true (got ${health})`)
    note('  ✓ healthz reports ok:true')

    note('\n[2] the public site renders')
    const home = await fetch(`${BASE}/`)
    expect(home.status, 200, 'GET / returns 200')
    const html = await home.text()
    if (!/green valley/i.test(html)) fail('home page lost the school name')
    note('  ✓ home page still names the school')

    note('\n[3] the demo database really is seeded')
    expect((await fetch(`${BASE}/login?role=parent`)).status, 200, 'GET /login?role=parent returns 200')

    note('\n[4] a wrong password is rejected, not silently accepted')
    const rejected = await fetch(`${BASE}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'parent1', password: 'wrong-password', role: 'parent' }),
    })
    expect(rejected.status, 401, 'wrong password returns 401')

    note('\n[5] one sign-in per role lands on that role home page')
    for (const [role, user, pass, homePage] of LOGINS) {
      const res = await fetch(`${BASE}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: user, password: pass, role }),
      })
      expect(res.status, 302, `${role} sign-in returns 302`)
      const location = res.headers.get('location')
      expect(location, homePage, `${role} sign-in redirects to ${homePage}`)

      const cookie = cookiesFrom(res)
      if (!cookie) fail(`${role} sign-in set no session cookie`)
      const dashboard = await fetch(`${BASE}${homePage}`, { headers: { cookie }, redirect: 'manual' })
      expect(dashboard.status, 200, `${homePage} opens with the signed-in session`)
    }

    note('\n✓ public site, rejected password and all three portals behave')
  } finally {
    stop()
  }
}

main().catch(() => {
  process.exitCode = 1
})
