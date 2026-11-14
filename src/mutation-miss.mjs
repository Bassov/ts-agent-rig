/**
 * One actionable line for mutation misses (Survived / NoCoverage) read from a
 * Stryker JSON report. Misses are scoped to the branch's changed files so a
 * stale report left by another run never fails (or confuses) this branch.
 */
import fs from 'node:fs'
import path from 'node:path'

export const MUTATION_REPORT_CANDIDATES = Object.freeze([
  path.join('reports', 'mutation', 'mutation.json'),
  path.join('.cache', 'stryker', 'mutation.json'),
])

/** Max misses spelled out in the one-line summary. */
export const MISS_LINE_LIMIT = 3

/** @param {string} root @returns {string | null} absolute report path */
export function findMutationReport(root) {
  for (const rel of MUTATION_REPORT_CANDIDATES) {
    const abs = path.join(root, rel)
    if (fs.existsSync(abs)) return abs
  }
  return null
}

/** @param {string} root @param {string} file */
function toRepoRel(root, file) {
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file
  return rel.replaceAll('\\', '/')
}

/**
 * @param {unknown} report parsed mutation-testing-report-schema JSON
 * @param {{ root: string, statuses: string[], changedFiles?: string[] | null }} opts
 *   `changedFiles` null/undefined → every file in the report counts.
 * @returns {{ file: string, line: string, mutator: string, status: string }[]}
 */
export function listMutationMisses(report, opts) {
  const files =
    report && typeof report === 'object' && 'files' in report
      ? /** @type {Record<string, { mutants?: unknown[] }>} */ (report.files)
      : {}
  const wanted = new Set(opts.statuses)
  const scope = opts.changedFiles
    ? new Set(opts.changedFiles.map((f) => f.replaceAll('\\', '/')))
    : null
  /** @type {{ file: string, line: string, mutator: string, status: string }[]} */
  const out = []
  for (const [key, entry] of Object.entries(files ?? {})) {
    const file = toRepoRel(opts.root, key)
    if (scope && !scope.has(file)) continue
    const mutants = Array.isArray(entry?.mutants) ? entry.mutants : []
    for (const m of /** @type {any[]} */ (mutants)) {
      if (!wanted.has(m?.status)) continue
      const line = m.location?.start?.line
      out.push({
        file,
        line: typeof line === 'number' ? String(line) : '?',
        mutator: m.mutatorName || m.id || '',
        status: m.status,
      })
    }
  }
  return out
}

/**
 * @param {{ file: string, line: string, mutator: string, status: string }[]} misses
 * @param {string} rerun command that reruns only the mutation stage
 */
export function formatMutationMissLine(misses, rerun) {
  if (!misses.length) return ''
  const shown = misses
    .slice(0, MISS_LINE_LIMIT)
    .map((m) => `${m.status} ${m.file}:${m.line} ${m.mutator}`.trimEnd())
  const more =
    misses.length > MISS_LINE_LIMIT
      ? ` (+${misses.length - MISS_LINE_LIMIT} more)`
      : ''
  return `${shown.join('; ')}${more} — add a test that kills it, then rerun: ${rerun}`
}

/**
 * Read the local report and return its misses for `changedFiles`.
 * @param {string} root
 * @param {{ statuses: string[], changedFiles?: string[] | null }} opts
 * @returns {{ report: string | null, all: number, misses: ReturnType<typeof listMutationMisses> }}
 */
export function readMutationMisses(root, opts) {
  const report = findMutationReport(root)
  if (!report) return { report: null, all: 0, misses: [] }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(report, 'utf8'))
  } catch {
    return { report, all: 0, misses: [] }
  }
  const all = listMutationMisses(parsed, { root, statuses: opts.statuses })
  const misses = opts.changedFiles
    ? listMutationMisses(parsed, { root, ...opts })
    : all
  return { report, all: all.length, misses }
}
