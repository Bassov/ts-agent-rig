#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
/**
 * Download and extract Playwright Chromium shared libraries without sudo.
 * Used on constrained WSL hosts where `playwright install-deps` cannot run.
 * Output: .local_dev/playwright-libs/ (gitignored via .local_dev).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolveRepoRoot()
const prefix = path.join(root, '.local_dev', 'playwright-libs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-debs-'))

const packages = [
  'libnspr4',
  'libnss3',
  'libasound2t64',
  'libasound2-data',
  'libgbm1',
  'libglib2.0-0t64',
  'libdrm2',
  'libxcb1',
  'libxkbcommon0',
  'libxcomposite1',
  'libxdamage1',
  'libxext6',
  'libxfixes3',
  'libxrandr2',
  'libcups2t64',
  'libatspi2.0-0t64',
  'libatk-bridge2.0-0t64',
  'libatk1.0-0t64',
  'libcairo2',
  'libpango-1.0-0',
  'libdbus-1-3',
]

fs.rmSync(prefix, { recursive: true, force: true })
fs.mkdirSync(prefix, { recursive: true })

console.log(`Downloading ${String(packages.length)} packages into ${tmp}`)
execFileSync('apt-get', ['download', ...packages], {
  cwd: tmp,
  stdio: 'inherit',
})

const debs = fs.readdirSync(tmp).filter((name) => name.endsWith('.deb'))
for (const deb of debs) {
  console.log(`Extract ${deb}`)
  execFileSync('dpkg-deb', ['-x', path.join(tmp, deb), prefix], {
    stdio: 'inherit',
  })
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`Ready: ${prefix}`)
console.log(
  'test:e2e / verify will pick this up via scripts/with-playwright-env.mjs',
)
