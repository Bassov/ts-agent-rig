/**
 * Green-tree stamp for thin `agent finish` skip-A.
 *
 * After stage 11 (check:integrity + quality:self-check), `agent stamp-green`
 * records a digest of the current HEAD + working tree. Finish skips re-running
 * those checks when the stamp still matches.
 *
 * Identity (sha256 hex of UTF-8):
 *   HEAD + "\0" + porcelain + "\0" + unstagedDiff + "\0" + stagedDiff
 * where:
 *   HEAD          = `git rev-parse HEAD`
 *   porcelain     = `git status --porcelain=v1`
 *   unstagedDiff  = `git diff`
 *   stagedDiff    = `git diff --cached`
 *
 * File: `<root>/.cache/agent-green-tree` (single line: hex digest).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { stripGitKeys } from './strip-git-env.mjs'

export const GREEN_TREE_STAMP_REL = path.join('.cache', 'agent-green-tree')

export function greenTreeStampPath(root) {
  return path.join(root, GREEN_TREE_STAMP_REL)
}

/**
 * @param {((file: string, args: string[], opts?: object) => { code?: number, stdout?: string, stderr?: string }) | undefined} exec
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {string[]} args
 */
function gitOut(exec, cwd, env, args) {
  if (exec) {
    const r = exec('git', args, { cwd, env })
    if ((r.code ?? 0) !== 0) {
      const detail = String(r.stderr ?? r.stdout ?? '').trim()
      throw new Error(
        detail || `git ${args.join(' ')} failed (exit ${r.code ?? 1})`,
      )
    }
    return String(r.stdout ?? '')
  }
  try {
    return execFileSync('git', args, {
      cwd,
      env: stripGitKeys({ ...process.env, ...env }),
      encoding: 'utf8',
    })
  } catch (e) {
    const detail = String(e?.stderr ?? e?.stdout ?? e?.message ?? '').trim()
    throw new Error(detail || `git ${args.join(' ')} failed`)
  }
}

/** Drop the stamp path (or its parent `.cache/`) from porcelain so writing it does not invalidate. */
function porcelainWithoutStamp(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => {
      if (!line) return true
      // porcelain v1: "XY path" or "XY orig -> path"
      const rest = line.length >= 3 ? line.slice(3) : line
      const p = rest.includes(' -> ') ? rest.split(' -> ').at(-1) : rest
      if (p === GREEN_TREE_STAMP_REL || p === '.cache/' || p === '.cache')
        return false
      if (p.startsWith('.cache/')) return false
      return true
    })
    .join('\n')
}

/**
 * @param {string} root
 * @param {{ exec?: Function, cwd?: string, env?: NodeJS.ProcessEnv }} [deps]
 */
export function computeGreenTreeId(root, deps = {}) {
  const cwd = deps.cwd ?? root
  const env = deps.env
  const exec = deps.exec
  const head = gitOut(exec, cwd, env, ['rev-parse', 'HEAD']).trim()
  const porcelain = porcelainWithoutStamp(
    gitOut(exec, cwd, env, ['status', '--porcelain=v1']),
  )
  const diff = gitOut(exec, cwd, env, ['diff'])
  const cached = gitOut(exec, cwd, env, ['diff', '--cached'])
  return createHash('sha256')
    .update(`${head}\0${porcelain}\0${diff}\0${cached}`, 'utf8')
    .digest('hex')
}

/** @param {string} root */
export function readGreenTreeStamp(root) {
  const p = greenTreeStampPath(root)
  if (!fs.existsSync(p)) return null
  const raw = fs.readFileSync(p, 'utf8').trim()
  return raw || null
}

/**
 * @param {string} root
 * @param {{ exec?: Function, cwd?: string, env?: NodeJS.ProcessEnv }} [deps]
 */
export function writeGreenTreeStamp(root, deps = {}) {
  const id = computeGreenTreeId(root, deps)
  const p = greenTreeStampPath(root)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, `${id}\n`, 'utf8')
  return id
}

/**
 * @param {string} root
 * @param {{ exec?: Function, cwd?: string, env?: NodeJS.ProcessEnv }} [deps]
 */
export function isGreenTreeStampCurrent(root, deps = {}) {
  const stamped = readGreenTreeStamp(root)
  if (!stamped) return false
  return stamped === computeGreenTreeId(root, deps)
}
