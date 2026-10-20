#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolveRepoRoot()
const libsRoot = path.join(root, '.local_dev', 'playwright-libs')
const libDirs = [
  path.join(libsRoot, 'usr', 'lib', 'x86_64-linux-gnu'),
  path.join(libsRoot, 'lib', 'x86_64-linux-gnu'),
].filter((dir) => fs.existsSync(dir))

const env = { ...process.env }
if (libDirs.length > 0) {
  const prefix = libDirs.join(path.delimiter)
  env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
    ? `${prefix}${path.delimiter}${env.LD_LIBRARY_PATH}`
    : prefix
}

if (!env.CHROME_PATH) {
  const cacheDir = path.join(process.env.HOME ?? '', '.cache', 'ms-playwright')
  if (fs.existsSync(cacheDir)) {
    const chrome = fs
      .readdirSync(cacheDir)
      .filter((name) => name.startsWith('chromium'))
      .flatMap((name) => {
        const base = path.join(cacheDir, name)
        return [
          path.join(
            base,
            'chrome-headless-shell-linux64',
            'chrome-headless-shell',
          ),
          path.join(base, 'chrome-linux64', 'chrome'),
        ]
      })
      .find((candidate) => fs.existsSync(candidate))
    if (chrome) {
      env.CHROME_PATH = chrome
    }
  }
}

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('Usage: with-playwright-env <command> [...args]')
  process.exit(1)
}

const child = spawn(command, args, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
