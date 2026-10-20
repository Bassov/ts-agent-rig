import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  diffGitSnapshots,
  gitRun,
  snapshotGitState,
} from './git-test-helper.mjs'

export { diffGitSnapshots, snapshotGitState }

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseConfigList(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of String(text).split('\n')) {
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

/**
 * @param {Record<string, string>} config
 * @returns {Record<string, string>}
 */
export function nonBranchLocalConfig(config) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('branch.')) continue
    out[key] = value
  }
  return out
}

/**
 * @param {string} text
 * @returns {{ path: string, head: string, branch: string | null }[]}
 */
export function parseWorktreePorcelain(text) {
  /** @type {{ path: string, head: string, branch: string | null }[]} */
  const out = []
  /** @type {{ path: string, head: string, branch: string | null } | null} */
  let cur = null
  const flush = () => {
    if (cur?.path) out.push(cur)
    cur = null
  }
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      cur = {
        path: path.resolve(line.slice('worktree '.length).trim()),
        head: '',
        branch: null,
      }
      continue
    }
    if (!cur) continue
    if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length).trim()
    else if (line.startsWith('branch '))
      cur.branch = line.slice('branch '.length).trim()
    else if (line === 'detached') cur.branch = null
  }
  flush()
  return out
}

/**
 * Rich snapshot for the pre-push canary (parallel-worktree tolerant).
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function snapshotCanaryState(cwd, opts = {}) {
  const absCwd = path.resolve(cwd)
  const configText = String(
    gitRun(['config', '--local', '--list'], absCwd, {
      env: opts.env,
      allowFail: true,
    }).stdout ?? '',
  )
  const mainRef = gitRun(
    ['rev-parse', '-q', '--verify', 'refs/heads/main'],
    absCwd,
    {
      env: opts.env,
      allowFail: true,
    },
  )
  const head = String(
    gitRun(['rev-parse', 'HEAD'], absCwd, { env: opts.env }).stdout ?? '',
  ).trim()
  const branch = String(
    gitRun(['branch', '--show-current'], absCwd, {
      env: opts.env,
      allowFail: true,
    }).stdout ?? '',
  ).trim()
  const wtText = String(
    gitRun(['worktree', 'list', '--porcelain'], absCwd, {
      env: opts.env,
      allowFail: true,
    }).stdout ?? '',
  )
  return {
    cwd: absCwd,
    nonBranchConfig: nonBranchLocalConfig(parseConfigList(configText)),
    mainOid:
      (mainRef.status ?? 1) === 0 ? String(mainRef.stdout ?? '').trim() : null,
    head,
    branch,
    worktrees: parseWorktreePorcelain(wtText),
  }
}

/**
 * @param {string} oldOid
 * @param {string} newOid
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function isDescendantOrEqual(oldOid, newOid, cwd, opts = {}) {
  if (oldOid === newOid) return true
  const r = gitRun(['merge-base', '--is-ancestor', oldOid, newOid], cwd, {
    env: opts.env,
    allowFail: true,
  })
  return (r.status ?? 1) === 0
}

/**
 * @param {string} candidate
 * @param {string} mainCheckout
 * @returns {boolean} true when the path is a leak-shaped addition
 */
export function isSuspiciousNewWorktree(candidate, mainCheckout) {
  const abs = path.resolve(candidate)
  const mainAbs = path.resolve(mainCheckout)
  const allowedRoot = path.resolve(path.dirname(mainAbs))
  const underAllowed =
    abs === allowedRoot || abs.startsWith(`${allowedRoot}${path.sep}`)
  if (underAllowed) return false
  return true
}

/**
 * Compare canary snapshots. Returns null when OK, else a message naming
 * which invariant broke.
 * @param {ReturnType<typeof snapshotCanaryState>} before
 * @param {ReturnType<typeof snapshotCanaryState>} after
 * @param {{ env?: NodeJS.ProcessEnv, tmpdir?: string }} [opts]
 */
export function compareCanaryInvariants(before, after, opts = {}) {
  const failures = []
  const cwd = after.cwd || before.cwd

  const beforeCfg = before.nonBranchConfig
  const afterCfg = after.nonBranchConfig
  const cfgKeys = new Set([...Object.keys(beforeCfg), ...Object.keys(afterCfg)])
  for (const key of [...cfgKeys].sort()) {
    if (beforeCfg[key] !== afterCfg[key]) {
      failures.push(
        `invariant local-config (non-branch): ${key} changed (${beforeCfg[key] ?? '<missing>'} → ${afterCfg[key] ?? '<missing>'})`,
      )
    }
  }

  if (before.mainOid == null) {
    failures.push('invariant refs/heads/main: missing before run')
  } else if (after.mainOid == null) {
    failures.push('invariant refs/heads/main: missing after run')
  } else if (!isDescendantOrEqual(before.mainOid, after.mainOid, cwd, opts)) {
    failures.push(
      `invariant refs/heads/main: not a fast-forward (${before.mainOid} → ${after.mainOid})`,
    )
  }

  if (before.head !== after.head) {
    failures.push(
      `invariant current-worktree HEAD: changed (${before.head} → ${after.head})`,
    )
  }
  if (before.branch !== after.branch) {
    failures.push(
      `invariant current-worktree branch: changed (${before.branch || '<detached>'} → ${after.branch || '<detached>'})`,
    )
  }

  const beforePaths = new Set(before.worktrees.map((w) => w.path))
  for (const wt of after.worktrees) {
    if (beforePaths.has(wt.path)) continue
    if (isSuspiciousNewWorktree(wt.path, before.cwd)) {
      const tmp = path.resolve(opts.tmpdir ?? os.tmpdir())
      const underTmp =
        wt.path === tmp || wt.path.startsWith(`${tmp}${path.sep}`)
      failures.push(
        underTmp
          ? `invariant worktrees: added path under os.tmpdir() outside main checkout parent (${wt.path})`
          : `invariant worktrees: added path outside main checkout parent (${wt.path})`,
      )
    }
  }

  return failures.length === 0 ? null : failures.join('\n')
}

/**
 * Snapshot the repo at `cwd`, run `run()`, snapshot again, fail if a
 * parallel-unsafe isolation invariant broke.
 * @param {string} cwd
 * @param {() => number | void | Promise<number | void>} run
 * @returns {Promise<number>}
 */
export async function withGitCanary(cwd, run) {
  if (!fs.existsSync(cwd)) {
    throw new Error(`withGitCanary: cwd does not exist: ${cwd}`)
  }
  const before = snapshotCanaryState(cwd)
  const code = await run()
  const status = typeof code === 'number' ? code : 0
  const after = snapshotCanaryState(cwd)
  const diff = compareCanaryInvariants(before, after)
  if (diff) {
    console.error(
      'GIT ISOLATION CANARY: isolation invariant broken while the hook command ran.\n' +
        diff,
    )
    return 1
  }
  return status
}
