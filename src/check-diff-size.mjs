#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
/**
 * Advisory changed-line budget vs merge-base (target ~1000, prefer ≤1500).
 * Never fails CI / pnpm check / finish — warns only; plans should still split via roadmap add.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripGitKeys } from './strip-git-env.mjs'

const ROOT = resolveRepoRoot()
export const DIFF_SIZE_MAX = 1500
export const DIFF_SIZE_WARN = 1000
export const DEFAULT_EXCLUDED_EXACT = Object.freeze(['pnpm-lock.yaml'])
export const DEFAULT_EXCLUDED_PREFIXES = Object.freeze([
  'openspec/changes/',
  'uikit/',
])
export const BINARY_EXTENSIONS = Object.freeze(
  new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.avif',
    '.ico',
    '.bmp',
    '.svg',
    '.pdf',
    '.wasm',
    '.zip',
    '.gz',
    '.tgz',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.mp4',
    '.webm',
    '.bin',
  ]),
)

export function loadDiffSizeExclusionGlobs(root) {
  const file = path.join(root, 'quality', 'diff-size-exclusions.json')
  if (!fs.existsSync(file)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(raw?.globs)
      ? raw.globs.filter((g) => typeof g === 'string')
      : []
  } catch {
    return []
  }
}

export function matchSimpleGlob(file, glob) {
  const f = file.replaceAll('\\', '/')
  const g = glob.replaceAll('\\', '/')
  if (g.endsWith('/**')) {
    const prefix = g.slice(0, -3)
    return f === prefix || f.startsWith(prefix + '/')
  }
  return !g.includes('*') && f === g
}

export function isExcludedDiffPath(rel, extraGlobs = []) {
  const n = String(rel).replaceAll('\\', '/')
  if (DEFAULT_EXCLUDED_EXACT.includes(n)) return true
  for (const p of DEFAULT_EXCLUDED_PREFIXES) {
    if (n === p.slice(0, -1) || n.startsWith(p)) return true
  }
  if (BINARY_EXTENSIONS.has(path.posix.extname(n).toLowerCase())) return true
  return extraGlobs.some((g) => matchSimpleGlob(n, g))
}

export function parseNumstat(text) {
  /** @type {{ file: string, added: number, deleted: number }[]} */
  const rows = []
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw.trim()) continue
    const parts = raw.split('\t')
    if (parts.length < 3) continue
    const [a, d, ...fileParts] = parts
    let file = fileParts.join('\t').replaceAll('\\', '/')
    if (file.includes(' => '))
      file = file.slice(file.lastIndexOf(' => ') + 4).replace(/[{}]/g, '')
    const added = a === '-' ? 0 : Number.parseInt(a, 10)
    const deleted = d === '-' ? 0 : Number.parseInt(d, 10)
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue
    rows.push({ file: file.trim(), added, deleted })
  }
  return rows
}

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: stripGitKeys({ ...process.env }),
  })
}

/** @param {Record<string, unknown>} [opts] */
export function computeDiffSize(opts = {}) {
  const root = /** @type {string} */ (opts.root ?? ROOT)
  const max = /** @type {number} */ (opts.max ?? DIFF_SIZE_MAX)
  const warnAt = /** @type {number} */ (opts.warnAt ?? DIFF_SIZE_WARN)
  // Advisory gate: size never fails check/CI; warnOnly kept for API compat (always treated as true).
  const warnOnly = opts.warnOnly === undefined ? true : Boolean(opts.warnOnly)
  const gitFn = /** @type {typeof git} */ (opts.git ?? git)
  const extra = loadDiffSizeExclusionGlobs(root)

  let numstatText = opts.numstatText
  if (numstatText === undefined) {
    const base = /** @type {string} */ (opts.baseRef ?? 'origin/main')
    const head = /** @type {string} */ (opts.headRef ?? 'HEAD')
    const merge = gitFn(['merge-base', base, head], root)
    if ((merge.status ?? 1) !== 0) {
      return {
        ok: true,
        skipped: true,
        lines: 0,
        max,
        warnAt,
        overMax: false,
        overWarn: false,
        warnOnly: true,
        reason: `merge-base unavailable: ${String(merge.stderr || merge.stdout || '').trim() || 'no origin/main'}`,
      }
    }
    const ns = gitFn(
      ['diff', '--numstat', '--find-renames', merge.stdout.trim(), head],
      root,
    )
    if ((ns.status ?? 1) !== 0) {
      return {
        ok: true,
        skipped: true,
        lines: 0,
        max,
        warnAt,
        overMax: false,
        overWarn: false,
        warnOnly: true,
        reason: `numstat unavailable: ${String(ns.stderr || ns.stdout || '').trim()}`,
      }
    }
    numstatText = ns.stdout
  }

  let lines = 0
  for (const row of parseNumstat(/** @type {string} */ (numstatText))) {
    if (!isExcludedDiffPath(row.file, extra)) lines += row.added + row.deleted
  }
  const overMax = lines > max
  const overWarn = lines > warnAt
  return {
    ok: true,
    skipped: false,
    lines,
    max,
    warnAt,
    overMax,
    overWarn,
    warnOnly,
    reason: overMax
      ? `diff size ${lines} > prefer ≤${max} (split with pnpm roadmap add --after)`
      : overWarn
        ? `diff size ${lines} > target ≤${warnAt}`
        : null,
  }
}

export function parsePlanSizeEstimate(text) {
  const m =
    /\*\*Size estimate:\*\*[^\n=]*=\s*(\d+)/i.exec(String(text ?? '')) ||
    /^Size estimate:[^\n=]*=\s*(\d+)/im.exec(String(text ?? ''))
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

/** @param {Record<string, unknown>} [opts] */
export function checkPlanSize(opts = {}) {
  const root = /** @type {string} */ (opts.root ?? ROOT)
  const max = /** @type {number} */ (opts.max ?? DIFF_SIZE_MAX)
  const warnAt = /** @type {number} */ (opts.warnAt ?? DIFF_SIZE_WARN)
  let text = opts.proposalText
  if (text === undefined) {
    const slug = opts.changeSlug
    if (!slug)
      return {
        ok: true,
        total: null,
        reason: 'missing change slug (skip plan size)',
        skipped: true,
        overMax: false,
        overWarn: false,
      }
    const file = path.join(
      root,
      'openspec',
      'changes',
      /** @type {string} */ (slug),
      'proposal.md',
    )
    if (!fs.existsSync(file)) {
      return {
        ok: true,
        total: null,
        reason: 'no proposal.md (skip plan size)',
        skipped: true,
        overMax: false,
        overWarn: false,
      }
    }
    text = fs.readFileSync(file, 'utf8')
  }
  const total = parsePlanSizeEstimate(/** @type {string} */ (text))
  if (total == null) {
    return {
      ok: true,
      total: null,
      overMax: false,
      overWarn: false,
      reason:
        'proposal.md missing **Size estimate:** … = <total> (prefer ≤1500; advisory)',
    }
  }
  const overMax = total > max
  const overWarn = total > warnAt
  return {
    ok: true,
    total,
    overMax,
    overWarn,
    reason: overMax
      ? `plan size ${total} > prefer ≤${max} (pnpm roadmap add --after)`
      : overWarn
        ? `plan size ${total} > target ≤${warnAt}`
        : null,
  }
}

export function runDiffSizeCheck(opts = {}) {
  const write = opts.write ?? ((s) => process.stdout.write(s))
  const result = computeDiffSize({ ...opts, warnOnly: true })
  if (result.skipped) {
    write(`diff-size: warn — skipped (${result.reason})\n`)
    return 0
  }
  if (result.overMax) {
    write(
      `diff-size: warn — ${result.lines} lines (prefer ≤${result.max}; target ≤${result.warnAt}; split with pnpm roadmap add --after)\n`,
    )
  } else if (result.overWarn) {
    write(
      `diff-size: warn — ${result.lines} lines (target ≤ ${result.warnAt})\n`,
    )
  } else {
    write(
      `diff-size: OK ${result.lines} lines (target ≤${result.warnAt}, prefer ≤${result.max})\n`,
    )
  }
  return 0
}

export function main(_argv = process.argv.slice(2)) {
  return runDiffSizeCheck({ warnOnly: true })
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main()
}
