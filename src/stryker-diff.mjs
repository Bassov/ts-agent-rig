#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadGates } from './load-gates.mjs'
import { loadMutatePatterns } from './mutation-scope.mjs'
import {
  DIFF_CONFIG,
  MUTATE_FILES_LIST,
  MSG_SKIP_PRODUCTION,
  buildStrykerArgs,
  evaluateNoCoverageGate,
  planDiffMutation,
  temporaryExcludePaths,
} from './stryker-diff-gate.mjs'
import {
  buildMutateSpecsFromDiff,
  filterReportToScoredRanges,
  mutateSpecPath,
} from './stryker-diff-ranges.mjs'
import { DEFAULT_MUTATION_REPORT } from './stryker-pr-summary.mjs'

export const MUTATE_RANGES_LIST = 'reports/mutation/mutate-ranges.txt'

function gitLines(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(result.stderr || `git ${args.join(' ')} failed`)
    process.exit(result.status ?? 1)
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function gitText(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(result.stderr || `git ${args.join(' ')} failed`)
    process.exit(result.status ?? 1)
  }
  return result.stdout
}

/**
 * @param {string} file
 * @returns {number}
 */
function countFileLines(file) {
  if (!existsSync(file)) return 0
  const text = readFileSync(file, 'utf8')
  if (text.length === 0) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? Math.max(0, n - 1) : n
}

/**
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function runStrykerDiff(
  argv = process.argv.slice(2),
  env = process.env,
) {
  void argv
  const base = env.STRYKER_DIFF_BASE ?? 'origin/main'
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard'])
  const changed = [
    ...gitLines(['diff', '--name-only', '--diff-filter=ACMR', base]),
    ...gitLines([
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      '--cached',
      base,
    ]),
    ...untracked,
  ]
  const changedSet = [...new Set(changed)]
  const patterns = loadMutatePatterns()
  const gates = loadGates()
  const tempList = gates.mutation?.temporaryExcludes
  const tempPaths = temporaryExcludePaths(
    Array.isArray(tempList) ? tempList : [],
  )
  const plan = planDiffMutation(changedSet, patterns, tempPaths)
  if (plan.errors.length > 0) {
    for (const err of plan.errors) console.error(err)
    return 1
  }
  if (plan.skip) {
    console.log(`No mutable src files changed vs ${base}; skipping Stryker.`)
    return 0
  }

  const mutateFiles = plan.mutateFiles.filter((file) => existsSync(file))
  if (mutateFiles.length === 0) {
    console.error(
      `${MSG_SKIP_PRODUCTION}mutate paths missing on disk: ${plan.mutateFiles.join(', ')}`,
    )
    return 1
  }

  const untrackedSet = new Set(untracked)
  /** @type {Map<string, number>} */
  const wholeFileLineCounts = new Map()
  for (const file of mutateFiles) {
    if (untrackedSet.has(file)) {
      wholeFileLineCounts.set(file, countFileLines(file))
    }
  }

  // Unified diffs for tracked changes (worktree + index) vs base; -U0 → tight hunks.
  const diffParts = []
  if (mutateFiles.some((f) => !untrackedSet.has(f))) {
    const tracked = mutateFiles.filter((f) => !untrackedSet.has(f))
    if (tracked.length > 0) {
      diffParts.push(gitText(['diff', '-U0', base, '--', ...tracked]))
      diffParts.push(
        gitText(['diff', '-U0', '--cached', base, '--', ...tracked]),
      )
    }
  }
  const { specs, rangesByFile, empty } = buildMutateSpecsFromDiff(
    mutateFiles,
    diffParts.join('\n'),
    wholeFileLineCounts,
  )

  if (empty) {
    console.log(
      `No scored line ranges vs ${base} (comment-only / non-mutable); skipping Stryker.`,
    )
    return 0
  }

  console.log(
    `Stryker mutate (${String(specs.length)} range(s) / ${String(rangesByFile.size)} file(s)):\n${specs.join('\n')}`,
  )

  mkdirSync(path.dirname(MUTATE_FILES_LIST), { recursive: true })
  writeFileSync(
    MUTATE_FILES_LIST,
    `${[...new Set(specs.map(mutateSpecPath))].join('\n')}\n`,
    'utf8',
  )
  writeFileSync(MUTATE_RANGES_LIST, `${specs.join('\n')}\n`, 'utf8')

  // Line ranges may yield zero mutants (comments / non-mutable). allowEmpty avoids
  // a hard fail; NoCoverage is still enforced on scored-range mutants below.
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'stryker',
      'run',
      ...buildStrykerArgs(specs, true),
    ],
    { stdio: 'inherit' },
  )
  if ((result.status ?? 1) !== 0) return result.status ?? 1

  const reportPath = env.STRYKER_DIFF_REPORT ?? DEFAULT_MUTATION_REPORT
  if (!existsSync(reportPath)) {
    console.error(`No mutation report at ${reportPath}`)
    return 1
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const scored = filterReportToScoredRanges(report.files ?? {}, rangesByFile)
  const scoredCount = Object.values(scored).reduce(
    (n, f) => n + (Array.isArray(f.mutants) ? f.mutants.length : 0),
    0,
  )
  if (scoredCount === 0) {
    console.log('No mutants on scored line ranges; treating as skip.')
    return 0
  }
  const gate = evaluateNoCoverageGate(scored)
  if (!gate.ok) {
    console.error(gate.error)
    return 1
  }
  return 0
}

export { DIFF_CONFIG, MUTATE_FILES_LIST }

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(runStrykerDiff())
}
