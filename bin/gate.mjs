#!/usr/bin/env node
/**
 * ts-rig-gate <subcommand>
 * pr-policy | gate-values | mutation-scope | codecov-yml | stryker-diff |
 * e2e-changed | e2e-burn-in-targets | e2e-burn-in-count | openspec-budget |
 * patch-coverage | diff-size | test-weakening | git-test-isolation
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const [cmd, ...rest] = process.argv.slice(2)

/** @type {Record<string, string>} */
const MAP = {
  'pr-policy': 'gate-ratchet-cli.mjs',
  'gate-values': 'check-gate-values.mjs',
  'mutation-scope': 'check-mutation-scope.mjs',
  'codecov-yml': 'codecov-yml-cli.mjs',
  'stryker-diff': 'stryker-diff.mjs',
  'e2e-changed': 'e2e-changed-quiet-cli.mjs',
  'e2e-burn-in-targets': 'e2e-burn-in-targets-cli.mjs',
  'e2e-burn-in-count': 'e2e-burn-in-count-cli.mjs',
  'openspec-budget': 'check-openspec-budget.mjs',
  'patch-coverage': 'check-patch-coverage.mjs',
  'diff-size': 'check-diff-size.mjs',
  'test-weakening': 'check-test-weakening.mjs',
  'git-test-isolation': 'check-no-direct-git-in-tests.mjs',
  'quality-self-check': 'quality-self-check.mjs',
}

function usage() {
  console.error(`Usage: ts-rig-gate <${Object.keys(MAP).join('|')}> [...args]`)
}

if (!cmd || cmd === '-h' || cmd === '--help') {
  usage()
  process.exitCode = cmd ? 0 : 1
} else if (!MAP[cmd]) {
  usage()
  process.exitCode = 1
} else {
  // Local `pnpm check` optional pr-policy has no refs; CI passes --base-ref/--head-ref.
  const script =
    cmd === 'pr-policy' && rest.length === 0
      ? 'check-pr-policy.mjs'
      : MAP[cmd]
  const r = spawnSync(process.execPath, [path.join(src, script), ...rest], {
    stdio: 'inherit',
    env: process.env,
  })
  process.exitCode = r.status ?? 1
}
