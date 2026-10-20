/**
 * Shared git fixture helper for tests. Always passes an explicit cwd and an
 * env with every ambient GIT_* stripped, config global/system nulled, and a
 * fixed author via env (not `git config`).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripGitKeys } from './strip-git-env.mjs'

export const GIT_TEST_AUTHOR_NAME = 'git-test'
export const GIT_TEST_AUTHOR_EMAIL = 'git-test@test.local'

const DEV_NULL = process.platform === 'win32' ? 'NUL' : '/dev/null'

/**
 * @param {NodeJS.ProcessEnv} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitTestEnv(extra = {}) {
  const env = stripGitKeys({ ...process.env, ...extra })
  env.GIT_CONFIG_GLOBAL = DEV_NULL
  env.GIT_CONFIG_SYSTEM = DEV_NULL
  env.GIT_AUTHOR_NAME = GIT_TEST_AUTHOR_NAME
  env.GIT_AUTHOR_EMAIL = GIT_TEST_AUTHOR_EMAIL
  env.GIT_COMMITTER_NAME = GIT_TEST_AUTHOR_NAME
  env.GIT_COMMITTER_EMAIL = GIT_TEST_AUTHOR_EMAIL
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {{
 *   env?: NodeJS.ProcessEnv
 *   encoding?: BufferEncoding | 'buffer'
 *   stdio?: 'ignore' | 'pipe' | readonly ['ignore'|'pipe', 'ignore'|'pipe', 'ignore'|'pipe']
 *   allowFail?: boolean
 * }} [opts]
 */
export function gitExec(args, cwd, opts = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('gitExec requires an explicit cwd')
  }
  const env = gitTestEnv(opts.env)
  const encoding = opts.encoding ?? 'utf8'
  const stdio = opts.stdio ?? 'pipe'
  try {
    return execFileSync('git', args, {
      cwd,
      env,
      encoding: stdio === 'ignore' ? undefined : encoding,
      stdio: stdio === 'ignore' ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    if (opts.allowFail) return e
    throw e
  }
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, allowFail?: boolean }} [opts]
 */
export function gitRun(args, cwd, opts = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('gitRun requires an explicit cwd')
  }
  const result = spawnSync('git', args, {
    cwd,
    env: gitTestEnv(opts.env),
    encoding: 'utf8',
  })
  if ((result.status ?? 1) !== 0 && !opts.allowFail) {
    const detail = String(result.stderr ?? result.stdout ?? '').trim()
    throw new Error(
      detail || `git ${args.join(' ')} failed (exit ${result.status})`,
    )
  }
  return result
}

/**
 * @param {string[]} [track]
 * @param {{ prefix?: string, seedFiles?: Record<string, string> }} [opts]
 */
export function initTmpRepo(track, opts = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix ?? 'git-test-'))
  if (Array.isArray(track)) track.push(d)
  gitExec(['init'], d, { stdio: 'ignore' })
  const seed = opts.seedFiles ?? {
    '.nvmrc': '22\n',
    'tracked.txt': 'base\n',
  }
  for (const [rel, contents] of Object.entries(seed)) {
    const full = path.join(d, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents)
  }
  gitExec(['add', '.'], d, { stdio: 'ignore' })
  gitExec(['commit', '-m', 'init'], d, { stdio: 'ignore' })
  gitExec(['branch', '-M', 'main'], d, { stdio: 'ignore' })
  return d
}

/**
 * Byte-stable snapshot for isolation / canary checks.
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function snapshotGitState(cwd, opts = {}) {
  const run = (args) => {
    const r = gitRun(args, cwd, { env: opts.env, allowFail: true })
    return String(r.stdout ?? '')
  }
  return {
    config: run(['config', '--local', '--list']),
    refs: run(['for-each-ref']),
    worktrees: run(['worktree', 'list']),
  }
}

/**
 * @param {{ config: string, refs: string, worktrees: string }} before
 * @param {{ config: string, refs: string, worktrees: string }} after
 * @returns {string | null} human-readable diff, or null when identical
 */
export function diffGitSnapshots(before, after) {
  const parts = []
  for (const key of /** @type {const} */ (['config', 'refs', 'worktrees'])) {
    if (before[key] !== after[key]) {
      parts.push(
        `--- ${key} before\n${before[key]}--- ${key} after\n${after[key]}`,
      )
    }
  }
  return parts.length === 0 ? null : parts.join('\n')
}
