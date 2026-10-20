#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
/**
 * Merge Playwright Istanbul dumps from `.nyc_output/` into `coverage-e2e/lcov.info`.
 * Exits 0 with a note when no dumps exist (suite produced no coverage).
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolveRepoRoot()
const nycOutput = path.join(root, '.nyc_output')
const outDir = path.join(root, 'coverage-e2e')
const nycBin = path.join(
  path.dirname(require.resolve('nyc/package.json')),
  'bin',
  'nyc.js',
)

function main() {
  if (!existsSync(nycOutput)) {
    console.log('merge-e2e-coverage: no .nyc_output directory; skip')
    process.exit(0)
  }
  const dumps = readdirSync(nycOutput).filter((name) => name.endsWith('.json'))
  if (dumps.length === 0) {
    console.log('merge-e2e-coverage: .nyc_output is empty; skip')
    process.exit(0)
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const result = spawnSync(
    process.execPath,
    [
      nycBin,
      'report',
      '--temp-dir',
      nycOutput,
      '--report-dir',
      outDir,
      '--reporter=lcovonly',
      '--reporter=json-summary',
      '--exclude-after-remap',
      'false',
    ],
    { cwd: root, encoding: 'utf8', env: process.env },
  )
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  const lcov = path.join(outDir, 'lcov.info')
  if (!existsSync(lcov)) {
    console.error(
      'merge-e2e-coverage: expected coverage-e2e/lcov.info after nyc report',
    )
    process.exit(1)
  }
  console.log(`merge-e2e-coverage: wrote ${lcov} from ${dumps.length} dump(s)`)
}

main()
