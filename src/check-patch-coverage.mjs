#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
/**
 * Local patch coverage vs origin/main from Vitest lcov (codecov.yml unit paths).
 * @real-input-parser lcov (Vitest / Codecov unit upload)
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGates } from './load-gates.mjs'
import { resolvePrPolicyBaseRef } from './check-gate-ratchet.mjs'
import { hasOwnerApprovedScopeChange } from './check-test-weakening.mjs'
import { stripGitKeys } from './strip-git-env.mjs'

const ROOT = resolveRepoRoot()
export const UNIT_PATH_PREFIXES = Object.freeze(['src/', 'scripts/'])
const LCOV_REL = 'coverage/lcov.info'

export function isUnitPath(rel) {
  const n = String(rel).replaceAll('\\', '/')
  return UNIT_PATH_PREFIXES.some((p) => n === p.slice(0, -1) || n.startsWith(p))
}

/** @param {string} text */
export function parseLcov(text) {
  /** @type {Map<string, Map<number, number>>} */
  const out = new Map()
  let file = ''
  /** @type {Map<number, number>} */
  let lines = new Map()
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('SF:')) {
      file = line.slice(3).replaceAll('\\', '/')
      lines = new Map()
      out.set(file, lines)
    } else if (line.startsWith('DA:') && file) {
      const [ln, hits] = line.slice(3).split(',')
      const n = Number.parseInt(ln, 10)
      const h = Number.parseInt(hits, 10)
      if (Number.isFinite(n) && Number.isFinite(h)) lines.set(n, h)
    }
  }
  return out
}

export function normalizeLcovPath(sf, root) {
  let n = String(sf).replaceAll('\\', '/')
  const rootPosix = root.replaceAll('\\', '/')
  if (n.startsWith(rootPosix + '/')) return n.slice(rootPosix.length + 1)
  if (path.isAbsolute(sf)) {
    const rel = path.relative(root, sf).replaceAll('\\', '/')
    if (rel && !rel.startsWith('..')) return rel
  }
  return n
}

/** @param {string} diffText */
export function parseAddedLinesFromDiff(diffText) {
  /** @type {Map<string, number[]>} */
  const out = new Map()
  let file = ''
  for (const raw of String(diffText ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('+++ ')) {
      const rest = line.slice(4).trim()
      file =
        rest === '/dev/null'
          ? ''
          : rest.replace(/^b\//, '').replaceAll('\\', '/')
      if (file && !out.has(file)) out.set(file, [])
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!hunk || !file) continue
    const start = Number.parseInt(hunk[1], 10)
    const count = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10)
    if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0)
      continue
    const list = out.get(file) ?? []
    for (let i = 0; i < count; i++) list.push(start + i)
    out.set(file, list)
  }
  return out
}

function defaultGit(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: stripGitKeys({ ...process.env }),
  })
}

function skipFile(file) {
  return (
    /\.(test|spec)\.[a-z]+$/i.test(file) ||
    file.endsWith('.test-helpers.ts') ||
    file.endsWith('.d.ts') ||
    file === 'src/main.tsx' ||
    /scripts\/.*-cli\.mjs$/.test(file)
  )
}

/** @param {Record<string, unknown>} [opts] */
export function computePatchCoverage(opts = {}) {
  const root = /** @type {string} */ (opts.root ?? ROOT)
  const git = /** @type {typeof defaultGit} */ (opts.git ?? defaultGit)
  const loadGatesFn = /** @type {typeof loadGates} */ (
    opts.loadGatesFn ?? loadGates
  )
  const gates = loadGatesFn({ root })
  const threshold =
    opts.threshold ??
    (typeof gates.coverage?.patch === 'number' ? gates.coverage.patch : 85)

  let base = opts.baseRef
  if (base === undefined) base = resolvePrPolicyBaseRef({ root, git })
  if (!base) {
    return {
      ok: true,
      skipped: true,
      reason: 'no origin/main or GATE_RATCHET_BASE',
      percent: null,
      threshold,
      uncovered: [],
    }
  }

  let diffText = opts.diffText
  if (diffText === undefined) {
    const diff = git(
      [
        'diff',
        '-U0',
        '--find-renames',
        `${base}...HEAD`,
        '--',
        'src',
        'scripts',
      ],
      root,
    )
    if ((diff.status ?? 1) !== 0) {
      return {
        ok: false,
        skipped: false,
        reason: `git diff failed: ${diff.stderr || diff.stdout}`,
        percent: null,
        threshold,
        uncovered: [],
      }
    }
    diffText = diff.stdout
  }

  /** @type {Map<string, number[]>} */
  const changed = new Map()
  for (const [file, lines] of parseAddedLinesFromDiff(diffText)) {
    if (!isUnitPath(file) || skipFile(file) || !lines.length) continue
    changed.set(file, lines)
  }
  if (changed.size === 0) {
    return {
      ok: true,
      skipped: false,
      reason: 'no changed unit lines',
      percent: 100,
      threshold,
      uncovered: [],
      covered: 0,
      total: 0,
    }
  }

  let lcovText = opts.lcovText
  if (lcovText === undefined) {
    const lcovPath = opts.lcovPath ?? path.join(root, LCOV_REL)
    if (!fs.existsSync(lcovPath)) {
      spawnSync(
        'pnpm',
        ['exec', 'vitest', 'run', '--coverage', '--reporter=dot', '--silent'],
        {
          cwd: root,
          encoding: 'utf8',
          env: process.env,
        },
      )
    }
    if (!fs.existsSync(lcovPath)) {
      return {
        ok: false,
        skipped: false,
        reason: `missing ${LCOV_REL}`,
        percent: null,
        threshold,
        uncovered: [],
      }
    }
    lcovText = fs.readFileSync(lcovPath, 'utf8')
  }

  /** @type {Map<string, Map<number, number>>} */
  const byRel = new Map()
  for (const [sf, lineMap] of parseLcov(lcovText)) {
    byRel.set(normalizeLcovPath(sf, root), lineMap)
  }

  let covered = 0
  let total = 0
  /** @type {{ file: string, lines: number[] }[]} */
  const uncovered = []
  for (const [file, lines] of [...changed.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const hits = byRel.get(file)
    const miss = []
    for (const ln of lines) {
      // When Istanbul instrumented the file, only count statement lines
      // (imports/comments/braces often lack DA: entries and inflate the fail).
      if (hits && !hits.has(ln)) continue
      total++
      const h = hits?.get(ln)
      if (h !== undefined && h > 0) covered++
      else miss.push(ln)
    }
    if (miss.length) uncovered.push({ file, lines: miss })
  }
  const percent = total === 0 ? 100 : (covered / total) * 100
  return {
    ok: percent + 1e-9 >= threshold,
    skipped: false,
    reason: percent + 1e-9 >= threshold ? null : 'below threshold',
    percent,
    threshold,
    covered,
    total,
    uncovered,
  }
}

export function formatPatchCoverageFailure(result) {
  const pct = result.percent == null ? 'n/a' : result.percent.toFixed(1)
  const bits = result.uncovered.map((u) => `${u.file}:${u.lines.join(',')}`)
  return `patch coverage ${pct}% (${bits.length ? bits.join('; ') : result.reason || 'uncovered'})`
}

function branchHasOwnerApproval(root = ROOT) {
  if (hasOwnerApprovedScopeChange(process.env.PR_POLICY_BODY ?? '')) return true
  const log = spawnSync('git', ['log', 'origin/main..HEAD', '--format=%B'], {
    cwd: root,
    encoding: 'utf8',
    env: stripGitKeys({ ...process.env }),
  })
  return (
    (log.status ?? 1) === 0 && hasOwnerApprovedScopeChange(log.stdout ?? '')
  )
}

export function runPatchCoverageCheck(opts = {}) {
  const root = opts.root ?? ROOT
  if (opts.skipOwnerWaiver !== true && branchHasOwnerApproval(root)) {
    console.log(
      'patch-coverage: skip (Owner-approved scope change — bootstrap / intentional oversized diff)',
    )
    return 0
  }
  const result = computePatchCoverage(opts)
  if (result.skipped) {
    console.log(`patch-coverage: skip (${result.reason})`)
    return 0
  }
  if (result.ok) {
    console.log(
      `patch-coverage: OK ${(result.percent ?? 100).toFixed(1)}% (${result.covered ?? 0}/${result.total ?? 0} changed lines)`,
    )
    return 0
  }
  console.error(formatPatchCoverageFailure(result))
  return 1
}

export function main() {
  return runPatchCoverageCheck()
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main()
}
