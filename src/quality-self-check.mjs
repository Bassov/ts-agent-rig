#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
/**
 * Deterministic pre-push self-check: one line per review-checklist id.
 * Reuses pr-policy / diff-size / pr-body (no duplicated ratchet rules).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReviewChecklistIds } from './review-checklist.mjs'
import { runPrPolicyCheck } from './check-gate-ratchet.mjs'
import { computeDiffSize, checkPlanSize } from './check-diff-size.mjs'
import { checkPrBody } from './check-pr-body.mjs'
import { stripGitKeys } from './strip-git-env.mjs'

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

export function checkStrykerReportHints(root) {
  const candidates = [
    path.join(root, 'reports', 'mutation', 'mutation.json'),
    path.join(root, '.cache', 'stryker', 'mutation.json'),
  ]
  const found = candidates.find((c) => fs.existsSync(c))
  if (!found) return { ok: true, skipped: true, problems: [] }
  /** @type {string[]} */
  const problems = []
  try {
    const raw = JSON.parse(fs.readFileSync(found, 'utf8'))
    const scan = (obj) => {
      if (!obj || typeof obj !== 'object') return
      for (const m of Array.isArray(obj.mutants) ? obj.mutants : []) {
        if (m?.status === 'NoCoverage') {
          problems.push(`NoCoverage mutant in ${found}`)
          return
        }
      }
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') scan(v)
      }
    }
    scan(raw)
  } catch {
    /* ignore */
  }
  return { ok: problems.length === 0, skipped: false, problems }
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
        'pr-body',
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
      : { status: 'fail', detail: errs.join('; ') || 'pr-policy' }

  const nameOnly = git(['diff', '--name-only', 'origin/main...HEAD'], root)
  const changedFiles =
    (nameOnly.status ?? 1) === 0
      ? nameOnly.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : []

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

  const pr = checkPrBody({ root, body: opts.body, bodyPath: opts.bodyPath })
  if (pr.skipped) rows['pr-body'] = { status: 'n.a.', detail: pr.reason }
  else if (!pr.ok)
    rows['pr-body'] = { status: 'fail', detail: pr.problems.join('; ') }
  else rows['pr-body'] = { status: 'pass' }

  /** @type {string[]} */
  const tasksPaths = []
  if (slug)
    tasksPaths.push(
      path.join(
        root,
        'openspec',
        'changes',
        /** @type {string} */ (slug),
        'tasks.md',
      ),
    )
  const changesDir = path.join(root, 'openspec', 'changes')
  if (fs.existsSync(changesDir)) {
    for (const ent of fs.readdirSync(changesDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === 'archive') continue
      const t = path.join(changesDir, ent.name, 'tasks.md')
      if (fs.existsSync(t) && !tasksPaths.includes(t)) tasksPaths.push(t)
    }
  }
  /** @type {string[]} */
  const evidenceProblems = []
  let sawTasks = false
  for (const tPath of tasksPaths) {
    if (!fs.existsSync(tPath)) continue
    sawTasks = true
    for (const tick of parseTickedTasks(fs.readFileSync(tPath, 'utf8'))) {
      if (!hasTickEvidence(tick.evidence)) {
        evidenceProblems.push(
          `${path.relative(root, tPath)}:${tick.line} no test/link/commit evidence`,
        )
      }
    }
  }
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

  const dis = checkStrykerReportHints(root)
  if (dis.skipped)
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
  let bodyPath
  let body
  let changeSlug
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--body-file') bodyPath = argv[++i]
    else if (a === '--body') body = argv[++i]
    else if (a === '--change') changeSlug = argv[++i]
    // --warn-only-size kept for CLI compat; size is always advisory.
  }
  if (body === undefined && process.env.PR_POLICY_BODY != null)
    body = process.env.PR_POLICY_BODY
  return runQualitySelfCheck({
    bodyPath,
    body,
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
