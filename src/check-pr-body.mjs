#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
/** Lightweight PR body: template headings non-empty; no fix/revise verdicts. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolveRepoRoot()
const TEMPLATE_REL = '.github/PULL_REQUEST_TEMPLATE.md'

export function extractMarkdownHeadings(text) {
  return String(text ?? '')
    .split('\n')
    .flatMap((raw) => {
      const m = /^##\s+(.+?)\s*$/.exec(raw)
      return m ? [m[1].trim()] : []
    })
}

export function sectionBody(text, title) {
  const re = new RegExp(
    `^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'm',
  )
  const m = re.exec(String(text ?? ''))
  if (!m || m.index === undefined) return null
  const rest = String(text).slice(m.index + m[0].length)
  const next = /^##\s+/m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

/**
 * Strip HTML comments for emptiness checks.
 * Loop until stable: a single `/<!--[\s\S]*?-->/` pass can leave a reformed `<!--`
 * (e.g. `<!<!---->-->` → `<!-->`). Then strip residual `<!--` / `--!?>` delimiters.
 */
export function stripHtmlComments(input) {
  let text = String(input ?? '')
  let previous
  do {
    previous = text
    text = text.replace(/<!--[\s\S]*?-->/g, '')
  } while (text !== previous)
  do {
    previous = text
    text = text.replace(/<!--|--!?>/g, '')
  } while (text !== previous)
  return text
}

export function isSectionNonEmpty(body) {
  if (body == null) return false
  return stripHtmlComments(body)
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l.length > 0 && l !== '-' && l !== '*')
}

export function findFixReviseVerdicts(body) {
  /** @type {string[]} */
  const hits = []
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // Require an explicit verdict marker — plain bullets may say "fix" in prose.
    if (
      (/\bverdict\b/i.test(line) || /^Verdict:/i.test(line)) &&
      /\b(fix|revise)\b/i.test(line)
    ) {
      hits.push(line)
    }
  }
  return hits
}

/** @param {Record<string, unknown>} [opts] */
export function checkPrBody(opts = {}) {
  const root = /** @type {string} */ (opts.root ?? ROOT)
  let body = opts.body
  if (body === undefined && opts.bodyPath) {
    const abs = path.isAbsolute(/** @type {string} */ (opts.bodyPath))
      ? /** @type {string} */ (opts.bodyPath)
      : path.join(root, /** @type {string} */ (opts.bodyPath))
    if (!fs.existsSync(abs))
      return { ok: false, problems: [`body file missing: ${abs}`] }
    body = fs.readFileSync(abs, 'utf8')
  }
  if (body == null || String(body).trim() === '') {
    return {
      ok: true,
      skipped: true,
      problems: [],
      reason: 'no PR body (skip)',
    }
  }
  const templatePath = path.join(root, TEMPLATE_REL)
  if (!opts.templateText && !fs.existsSync(templatePath)) {
    return {
      ok: true,
      skipped: true,
      problems: [],
      reason: 'no PR template (skip)',
    }
  }
  const templateText =
    /** @type {string} */ (opts.templateText) ??
    fs.readFileSync(templatePath, 'utf8')
  /** @type {string[]} */
  const problems = []
  for (const title of extractMarkdownHeadings(templateText)) {
    const sec = sectionBody(/** @type {string} */ (body), title)
    if (sec == null) problems.push(`missing heading ## ${title}`)
    else if (!isSectionNonEmpty(sec)) problems.push(`empty section ## ${title}`)
  }
  for (const hit of findFixReviseVerdicts(/** @type {string} */ (body))) {
    problems.push(`fix/revise verdict: ${hit}`)
  }
  return { ok: problems.length === 0, skipped: false, problems }
}

export function runPrBodyCheck(opts = {}) {
  const write = opts.write ?? ((s) => process.stdout.write(s))
  const error = opts.error ?? ((s) => process.stderr.write(s))
  const result = checkPrBody(opts)
  if (result.skipped) {
    write(`pr-body: skip (${result.reason})\n`)
    return 0
  }
  if (!result.ok) {
    for (const p of result.problems) error(`pr-body: fail — ${p}\n`)
    return 1
  }
  write('pr-body: OK\n')
  return 0
}

export function main(argv = process.argv.slice(2)) {
  let bodyPath
  let body
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--body-file') bodyPath = argv[++i]
    else if (argv[i] === '--body') body = argv[++i]
  }
  if (body === undefined && process.env.PR_POLICY_BODY != null)
    body = process.env.PR_POLICY_BODY
  return runPrBodyCheck({ bodyPath, body })
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main()
}
