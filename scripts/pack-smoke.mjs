#!/usr/bin/env node
/**
 * Pack the package, install into a temp host fixture, run key CLIs.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...opts,
  })
  if (r.status !== 0) {
    console.error(r.stdout)
    console.error(r.stderr)
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`)
  }
  return r
}

const pack = run('pnpm', ['pack'], { cwd: pkgRoot })
const line = (pack.stdout || '')
  .split('\n')
  .map((l) => l.trim())
  .find((l) => l.endsWith('.tgz'))
if (!line) throw new Error('pnpm pack did not print a .tgz path')
const tgz = path.isAbsolute(line) ? line : path.join(pkgRoot, line)

const host = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rig-smoke-'))
fs.writeFileSync(
  path.join(host, 'package.json'),
  JSON.stringify(
    {
      name: 'ts-rig-smoke-host',
      private: true,
      type: 'module',
      packageManager: 'pnpm@10.28.0',
    },
    null,
    2,
  ),
)
fs.mkdirSync(path.join(host, 'quality'), { recursive: true })
fs.writeFileSync(
  path.join(host, 'quality', 'gates.json'),
  JSON.stringify(
    {
      coverage: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        patch: 85,
      },
      stryker: {
        thresholds: { high: 80, low: 60, break: 60 },
        diffThresholds: { high: 90, low: 85, break: 85 },
      },
      mutation: { disableBudget: 10, temporaryExcludes: [] },
      lighthouse: { numberOfRuns: 1, assertions: {}, budgets: [] },
      playwright: { retries: 0, flakyRetries: 0 },
      e2e: { burnInDefault: 1, flakySpecs: [] },
      requiredCheckJobs: [],
      openspecSpecs: { maxFiles: 50, maxLines: 5000 },
      agentRules: { budgets: {} },
      checks: {
        core: [{ name: 'noop', argv: ['node', '-e', 'process.exit(0)'] }],
        afterUnit: [],
        optional: [],
      },
    },
    null,
    2,
  ),
)
fs.mkdirSync(path.join(host, 'docs'), { recursive: true })
fs.writeFileSync(
  path.join(host, 'docs', 'roadmap.md'),
  '# Roadmap\n\n| ID | Title | Status |\n| --- | --- | --- |\n',
)
fs.mkdirSync(path.join(host, 'openspec'), { recursive: true })
fs.writeFileSync(path.join(host, 'openspec', 'config.yaml'), 'schema: 1\n')

run('pnpm', ['add', '-D', tgz], { cwd: host, stdio: 'inherit' })

const bins = [
  ['roadmap', ['check']],
  ['ts-rig-check', ['--run', 'noop', '--', 'node', '-e', 'process.exit(0)']],
]
for (const [bin, args] of bins) {
  const r = spawnSync('pnpm', ['exec', bin, ...args], {
    cwd: host,
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr)
    throw new Error(`${bin} ${args.join(' ')} failed`)
  }
}

console.log('pack-smoke OK', host)
fs.rmSync(host, { recursive: true, force: true })
fs.rmSync(tgz, { force: true })
