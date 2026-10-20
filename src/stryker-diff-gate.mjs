/**
 * Pure helpers for honest diff mutation (thresholds / excludes / NoCoverage).
 * Kept separate from the thin CLI in stryker-diff.mjs for mutation testing.
 */
import {
  classifyMutationFile,
  selectMutableChanges,
} from './mutation-scope.mjs'

export const DIFF_CONFIG = 'stryker.diff.config.mjs'
export const MUTATE_FILES_LIST = 'reports/mutation/mutate-files.txt'
export const MSG_UNAUTHORIZED_EXCLUDE =
  'changed excluded production file not in mutation.temporaryExcludes: '
export const MSG_SKIP_PRODUCTION =
  'diff mutation skipped while production files changed: '
export const MSG_NO_COVERAGE = 'NoCoverage mutants in diff mutation report: '

/**
 * @param {string} file
 * @param {string[]} patterns
 */
export function matchesMutateInclude(file, patterns) {
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue
    if (classifyMutationFile(file, [pattern]) === 'in-scope') return true
  }
  return false
}

/**
 * Exact-file bang (`!path` without glob metacharacters).
 * @param {string} file
 * @param {string[]} patterns
 */
export function exactBangExcludeTarget(file, patterns) {
  for (const pattern of patterns) {
    if (!pattern.startsWith('!')) continue
    const target = pattern.slice(1)
    if (
      !target.includes('*') &&
      !target.includes('?') &&
      !target.includes('{') &&
      target === file
    ) {
      return target
    }
  }
  return null
}

/**
 * @param {{ path?: unknown }[]} temporaryExcludes
 * @returns {Set<string>}
 */
export function temporaryExcludePaths(temporaryExcludes) {
  const out = new Set()
  for (const row of temporaryExcludes) {
    if (row && typeof row.path === 'string') out.add(row.path)
  }
  return out
}

/**
 * @param {string} file
 * @param {string[]} patterns
 * @param {Set<string>} tempPaths
 */
export function isUnauthorizedExclude(file, patterns, tempPaths) {
  if (!matchesMutateInclude(file, patterns)) return false
  if (classifyMutationFile(file, patterns) !== 'excluded') return false
  if (tempPaths.has(file)) return false
  return exactBangExcludeTarget(file, patterns) !== null
}

/**
 * @param {string[]} changed
 * @param {string[]} patterns
 * @param {Set<string>} tempPaths
 */
export function findUnauthorizedExcludes(changed, patterns, tempPaths) {
  return changed
    .filter((file) => isUnauthorizedExclude(file, patterns, tempPaths))
    .sort()
}

/**
 * @param {string[]} changed
 * @param {string[]} patterns
 * @param {Set<string>} tempPaths
 */
export function planDiffMutation(changed, patterns, tempPaths) {
  const unauthorized = findUnauthorizedExcludes(changed, patterns, tempPaths)
  const mutateFiles = selectMutableChanges(changed, patterns)
  /** @type {string[]} */
  const errors = []
  for (const file of unauthorized) {
    errors.push(`${MSG_UNAUTHORIZED_EXCLUDE}${file}`)
  }
  if (errors.length > 0) {
    return {
      mutateFiles,
      unauthorized,
      skip: false,
      allowEmpty: false,
      errors,
    }
  }
  // Empty mutate set: docs / structural bangs / temporaryExcludes only.
  // Unauthorized product bangs already failed above; in-scope files appear in mutateFiles.
  if (mutateFiles.length === 0) {
    return {
      mutateFiles,
      unauthorized,
      skip: true,
      allowEmpty: true,
      errors,
    }
  }
  const productionChanged = changed.some((file) =>
    matchesMutateInclude(file, patterns),
  )
  return {
    mutateFiles,
    unauthorized,
    skip: false,
    allowEmpty: !productionChanged,
    errors,
  }
}

/**
 * @param {Record<string, { mutants?: { status?: string }[] }>} fileMap
 */
export function countNoCoverage(fileMap) {
  let n = 0
  for (const file of Object.values(fileMap)) {
    const mutants = Array.isArray(file.mutants) ? file.mutants : []
    for (const mutant of mutants) {
      if (mutant.status === 'NoCoverage') n += 1
    }
  }
  return n
}

/**
 * @param {Record<string, { mutants?: { status?: string, location?: { start?: { line?: number } }, mutatorName?: string, id?: string }[] }>} fileMap
 */
export function listNoCoverageMutants(fileMap) {
  /** @type {{ path: string, line: string, mutator: string }[]} */
  const out = []
  for (const [filePath, file] of Object.entries(fileMap)) {
    const mutants = Array.isArray(file.mutants) ? file.mutants : []
    for (const mutant of mutants) {
      if (mutant.status !== 'NoCoverage') continue
      const line = mutant.location?.start?.line
      out.push({
        path: filePath,
        line: typeof line === 'number' ? String(line) : '?',
        mutator: mutant.mutatorName || mutant.id || '',
      })
    }
  }
  return out
}

/**
 * @param {Record<string, { mutants?: { status?: string }[] }>} fileMap
 */
export function evaluateNoCoverageGate(fileMap) {
  const n = countNoCoverage(fileMap)
  if (n === 0) return { ok: true, count: 0, error: null }
  return {
    ok: false,
    count: n,
    error: `${MSG_NO_COVERAGE}${n}`,
  }
}

/**
 * Build Stryker argv for a planned diff run.
 * @param {string[]} mutateFiles
 * @param {boolean} allowEmpty
 */
export function buildStrykerArgs(mutateFiles, allowEmpty) {
  const args = [DIFF_CONFIG, '--mutate', mutateFiles.join(',')]
  if (allowEmpty) args.push('--allowEmpty')
  return args
}

/**
 * temporaryExcludes paths that lack an exact `!path` mutate bang.
 * @param {string[]} paths
 * @param {string[]} patterns
 */
export function temporaryExcludesMissingBangs(paths, patterns) {
  const bangs = new Set()
  for (const pattern of patterns) {
    if (!pattern.startsWith('!')) continue
    const target = pattern.slice(1)
    if (
      !target.includes('*') &&
      !target.includes('?') &&
      !target.includes('{')
    ) {
      bangs.add(target)
    }
  }
  return paths.filter((p) => !bangs.has(p)).sort()
}
