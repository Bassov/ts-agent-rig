#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectChangedPaths,
  selectBurnInTargets,
} from './e2e-burn-in-targets.mjs'

const ROOT = resolveRepoRoot()
const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), 'with-playwright-env.mjs')

/**
 * @param {string} [base]
 * @param {{
 *   gitLines?: (args: string[]) => string[]
 *   exists?: (path: string) => boolean
 *   isFile?: (path: string) => boolean
 *   listSources?: (root: string) => string[]
 *   readFile?: (path: string) => string
 *   spawnSync?: typeof spawnSync
 *   write?: (text: string) => void
 *   error?: (text: string) => void
 * }} [io]
 */
export function resolveChangedE2eTargets(base, io = {}) {
  const exists = io.exists ?? ((path) => existsSync(path))
  const isFile =
    io.isFile ??
    ((path) => {
      try {
        return exists(path) && statSync(path).isFile()
      } catch {
        return false
      }
    })
  const changed = collectChangedPaths(base, io)
  return selectBurnInTargets(changed, io).filter((path) => isFile(path))
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   gitLines?: (args: string[]) => string[]
 *   exists?: (path: string) => boolean
 *   isFile?: (path: string) => boolean
 *   listSources?: (root: string) => string[]
 *   readFile?: (path: string) => string
 *   spawnSync?: typeof spawnSync
 *   write?: (text: string) => void
 *   error?: (text: string) => void
 * }} [io]
 */
export function main(env = process.env, io = {}) {
  const write = io.write ?? ((text) => process.stdout.write(text))
  const error = io.error ?? ((text) => console.error(text))
  const spawn = io.spawnSync ?? spawnSync
  try {
    const base = env.STRYKER_DIFF_BASE ?? 'origin/main'
    const targets = resolveChangedE2eTargets(base, io)
    if (targets.length === 0) {
      write('changed-e2e: no targets\n')
      return 0
    }
    const result = spawn(
      process.execPath,
      [
        WRAPPER,
        'playwright',
        'test',
        '--project=chromium',
        '--workers=1',
        ...targets,
        '--reporter=dot',
      ],
      {
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stdout = String(result.stdout ?? '')
    const stderr = String(result.stderr ?? '')
    if (stdout) write(stdout)
    if (stderr) error(stderr)
    const code = result.status ?? 1
    const summary =
      code === 0
        ? `changed-e2e: ${targets.length} target(s) passed`
        : `changed-e2e: ${targets.length} target(s) failed (exit ${code})`
    write(`${summary}\n`)
    return code
  } catch (err) {
    error(err instanceof Error ? err.message : err)
    return 1
  }
}
