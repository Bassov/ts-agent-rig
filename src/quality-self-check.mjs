#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
/**
 * Deterministic pre-push self-check: one line per review-checklist id.
 * Reuses pr-policy / diff-size (no duplicated ratchet rules).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReviewChecklistIds } from './review-checklist.mjs'
import { runPrPolicyCheck } from './check-gate-ratchet.mjs'
import { computeDiffSize, checkPlanSize } from './check-diff-size.mjs'
import { stripGitKeys } from './strip-git-env.mjs'
import { formatMutationMissLine, readMutationMisses } from './mutation-miss.mjs'

const ROOT = resolveRepoRoot()
export const REVIEWER_ONLY_IDS = Object.freeze([
  'scope',
  'exclusions',
  'tests-first',
  'roadmap-follow-ups',
  'english',
])

export function parseTickedTasks(text) {
  return String(text ?? '')
    .split('\n')
    .flatMap((line, i) => {
      const m = /^\s*- \[x\]\s+(.+)$/i.exec(line)
      return m
        ? [{ line: i + 1, title: m[1].trim(), evidence: m[1].trim() }]
        : []
    })
}

export function hasTickEvidence(text) {
  const t = String(text ?? '')
  return (
    /\bhttps?:\/\//i.test(t) ||
    /\b[0-9a-f]{7,40}\b/i.test(t) ||
    /\b[\w./-]+\.(?:ts|tsx|mjs|js|spec\.ts)::/i.test(t) ||
    /\b[\w./-]+\.(?:test|spec)\.(?:ts|tsx|mjs)\b/i.test(t) ||
    (/\bevidenced?\b/i.test(t) && /\b(pass|ok|green)\b/i.test(t)) ||
    /\bN\/A\b/i.test(t)
  )
}

/** External-format parsers opt in with `@real-input-parser` only. */
export function isExternalFormatParser(_rel, source) {
  return /@real-input-parser\b/.test(String(source ?? ''))
}

export function referencesRealFixture(testSource) {
  return /test\/fixtures\/real\//.test(String(testSource ?? ''))
}

/** @param {Record<string, unknown>} [opts] */
export function checkRealInput(opts = {}) {
  const root = /** @type {string} */ (opts.root ?? ROOT)
  const readFile = /** @type {(p: string) => string} */ (
    opts.readFile ?? ((p) => fs.readFileSync(p, 'utf8'))
  )
  const existsSync = /** @type {(p: string) => boolean} */ (
    opts.existsSync ?? fs.existsSync
  )
  /** @type {string[]} */
  const problems = []
  for (const rel of /** @type {string[]} */ (opts.changedFiles ?? [])) {
    const n = rel.replaceAll('\\', '/')
    if (n.includes('.test.') || n.endsWith('.md')) continue
    const abs = path.join(root, n)
    if (!existsSync(abs)) continue
    let source = ''
    try {
      source = readFile(abs)
    } catch {
      continue
    }
    if (!isExternalFormatParser(n, source)) continue
    const base = n.replace(/\.[^.]+$/, '')
    const candidates = [
      `${base}.test.mjs`,
      `${base}.test.ts`,
      `${base}.spec.ts`,
      n.replace(/\.mjs$/, '.test.mjs'),
    ]
    let testText = ''
    let hasTest = false
    for (const c of candidates) {
      const tAbs = path.join(root, c)
      if (!existsSync(tAbs)) continue
      hasTest = true
      try {
        testText += readFile(tAbs)
      } catch {
        /* ignore */
      }
    }
    if (
      hasTest &&
      !referencesRealFixture(testText) &&
      !referencesRealFixture(source)
    ) {
      problems.push(`${n}: parser tests must reference test/fixtures/real/`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/**
 * NoCoverage mutants in the local Stryker report, scoped to `changedFiles`
 * (null → whole report). A report whose NoCoverage mutants all sit outside
 * the branch diff is stale (another branch / run) and is skipped.
 * @param {string} root
 * @param {string[] | null} [changedFiles]
 */
export function checkStrykerReportHints(root, changedFiles = null) {
  const { report, all, misses } = readMutationMisses(root, {
    statuses: ['NoCoverage'],
    changedFiles,
  })
  if (!report) return { ok: true, skipped: true, problems: [] }
  if (all > 0 && misses.length === 0)
    return {
      ok: true,
      skipped: true,
      stale: true,
      problems: [],
    }
  const problems = misses.length
    ? [formatMutationMissLine(misses, 'pnpm stryker:diff')]
    : []
  return { ok: problems.length === 0, skipped: false, problems }
}

/**
 * Tick-evidence problems for the given tasks.md paths (missing files skipped).
 * @param {string} root
 * @param {string[]} tasksPaths absolute paths
 */
export function checkTasksEvidence(root, tasksPaths) {
  /** @type {string[]} */
  const problems = []
  let sawTasks = false
  for (const tPath of tasksPaths) {
    if (!fs.existsSync(tPath)) continue
    sawTasks = true
    for (const tick of parseTickedTasks(fs.readFileSync(tPath, 'utf8'))) {
      if (!hasTickEvidence(tick.evidence)) {
        problems.push(
          `${path.relative(root, tPath)}:${tick.line} no test/link/commit evidence`,
        )
      }
    }
  }
  return { sawTasks, problems }
}

/**
 * tasks.md paths this branch owns: the slug's change plus every change dir
 * the branch diff touches. Change dirs left on main by other items are not
 * this branch's evidence. `changedFiles` null (diff unavailable) → all dirs.
 * @param {string} root
 * @param {string | undefined} slug
 * @param {string[] | null} changedFiles
 */
export function evidenceTasksPaths(root, slug, changedFiles) {
  const changesDir = path.join(root, 'openspec', 'changes')
  /** @type {string[]} */
  const out = []
  const add = (name) => {
    const t = path.join(changesDir, name, 'tasks.md')
    if (!out.includes(t)) out.push(t)
  }
  if (slug) add(slug)
  if (!fs.existsSync(changesDir)) return out
  const touched = changedFiles
    ? new Set(
        changedFiles
          .map((f) => /^openspec\/changes\/([^/]+)\//.exec(f)?.[1])
          .filter(Boolean),
      )
    : null
  for (const ent of fs.readdirSync(changesDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === 'archive') continue
    if (touched && !touched.has(ent.name)) continue
    add(ent.name)
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

/** @param {Record<string, unknown>} [opts] */
export function runQualitySelfCheck(opts = {}) {
  const root = /** @type {string} */ (opts.root ?? ROOT)
  const write = /** @type {(s: string) => void} */ (
    opts.write ?? ((s) => process.stdout.write(s))
  )
  const git = /** @type {typeof defaultGit} */ (opts.git ?? defaultGit)
  const runPrPolicy = /** @type {typeof runPrPolicyCheck} */ (
    opts.runPrPolicy ?? runPrPolicyCheck
  )
  const ids = readReviewChecklistIds(root)
  const checklist = ids.length
    ? ids
    : [
        'scope',
        'size',
        'gates',
        'exclusions',
        'disables',
        'tests-first',
        'evidence',
        'roadmap-follow-ups',
        'english',
        'real-input',
      ]

  /** @type {Record<string, { status: string, detail?: string }>} */
  const rows = Object.fromEntries(
    REVIEWER_ONLY_IDS.map((id) => [id, { status: 'n.a.', detail: 'reviewer' }]),
  )

  const errs = []
  const gateCode = runPrPolicy({
    root,
    git,
    log: () => {},
    error: (m) => errs.push(String(m)),
  })
  rows.gates =
    gateCode === 0
      ? { status: 'pass' }
      : {
          status: 'fail',
          detail:
            errs.join('; ') ||
            'pr-policy (Gate ratchet lines below; rerun: pnpm exec ts-rig-gate pr-policy)',
        }

  const nameOnly = git(['diff', '--name-only', 'origin/main...HEAD'], root)
  // null = diff unavailable: scoped checks fall back to the whole tree.
  const scopeFiles =
    (nameOnly.status ?? 1) === 0
      ? nameOnly.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : null
  const changedFiles = scopeFiles ?? []

  let slug = opts.changeSlug
  if (!slug) {
    const m = /^(?:feat|fix)\/(.+)$/.exec(
      git(['branch', '--show-current'], root).stdout.trim(),
    )
    if (m) slug = m[1]
  }
  const plan = checkPlanSize({ root, changeSlug: slug })
  const size = computeDiffSize({
    root,
    git,
    warnOnly: true,
  })
  // Size is advisory only — never fail self-check / push for line count.
  {
    const bits = []
    if (plan.total != null) bits.push(`plan ${plan.total}`)
    if (size.skipped) bits.push(`skipped (${size.reason})`)
    else bits.push(`${size.lines} lines`)
    const warn =
      plan.overMax ||
      plan.overWarn ||
      size.overMax ||
      size.overWarn ||
      size.skipped ||
      (plan.reason && !plan.skipped)
    const detail = [
      bits.join(', '),
      warn ? plan.reason || size.reason || 'prefer ≤1500; target ≤1000' : null,
    ]
      .filter(Boolean)
      .join(' — ')
    rows.size = { status: 'pass', detail }
  }

  const { sawTasks, problems: evidenceProblems } = checkTasksEvidence(
    root,
    evidenceTasksPaths(root, slug, scopeFiles),
  )
  if (!sawTasks) rows.evidence = { status: 'n.a.', detail: 'no tasks.md' }
  else if (evidenceProblems.length)
    rows.evidence = {
      status: 'fail',
      detail: evidenceProblems.slice(0, 5).join('; '),
    }
  else rows.evidence = { status: 'pass' }

  const real = checkRealInput({ root, changedFiles })
  rows['real-input'] = real.ok
    ? { status: 'pass' }
    : { status: 'fail', detail: real.problems.join('; ') }

  const dis = checkStrykerReportHints(root, scopeFiles)
  if (dis.stale)
    rows.disables = {
      status: 'n.a.',
      detail: 'stryker report has NoCoverage only outside this diff (stale)',
    }
  else if (dis.skipped)
    rows.disables = { status: 'n.a.', detail: 'no local stryker report' }
  else if (!dis.ok)
    rows.disables = { status: 'fail', detail: dis.problems.join('; ') }
  else rows.disables = { status: 'pass' }

  for (const id of checklist) {
    if (!rows[id]) rows[id] = { status: 'n.a.', detail: 'unhandled' }
  }

  let failed = false
  for (const id of checklist) {
    const row = rows[id] ?? { status: 'n.a.' }
    write(`${id}: ${row.status}${row.detail ? ` — ${row.detail}` : ''}\n`)
    if (row.status === 'fail') failed = true
  }
  return failed ? 1 : 0
}

export function main(argv = process.argv.slice(2)) {
  let changeSlug
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // --body / --body-file kept for CLI compat; the PR body is no longer gated.
    if (a === '--body-file' || a === '--body') i++
    else if (a === '--change') changeSlug = argv[++i]
    // --warn-only-size kept for CLI compat; size is always advisory.
  }
  return runQualitySelfCheck({
    changeSlug,
    warnOnlySize: true,
  })
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main()
}
