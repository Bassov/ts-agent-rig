#!/usr/bin/env node
/**
 * ts-rig-ci <subcommand>
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const [cmd, ...rest] = process.argv.slice(2)

/** @type {Record<string, string>} */
const MAP = {
  'report-comment': 'ci-report-comment.mjs',
  'coverage-summary': 'coverage-step-summary.mjs',
  'stryker-summary': 'stryker-pr-summary-cli.mjs',
  'e2e-summary': 'e2e-playwright-summary-cli.mjs',
  'lhci-summary': 'lighthouse-pr-summary.mjs',
  'merge-e2e-coverage': 'merge-e2e-coverage.mjs',
  'with-playwright-env': 'with-playwright-env.mjs',
  'playwright-libs': 'bootstrap-playwright-libs.mjs',
  'hook-clean-env': 'hook-clean-env.mjs',
  'hook-pre-push': 'hook-pre-push.mjs',
}

function usage() {
  console.error(`Usage: ts-rig-ci <${Object.keys(MAP).join('|')}> [...args]`)
}

if (!cmd || cmd === '-h' || cmd === '--help') {
  usage()
  process.exitCode = cmd ? 0 : 1
} else if (!MAP[cmd]) {
  usage()
  process.exitCode = 1
} else {
  const r = spawnSync(process.execPath, [path.join(src, MAP[cmd]), ...rest], {
    stdio: 'inherit',
    env: process.env,
  })
  process.exitCode = r.status ?? 1
}
