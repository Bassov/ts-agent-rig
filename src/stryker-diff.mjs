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
import { DEFAULT_MUTATION_REPORT } from './stryker-pr-summary.mjs'

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
  const changed = [
    ...gitLines(['diff', '--name-only', '--diff-filter=ACMR', base]),
    ...gitLines([
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      '--cached',
      base,
    ]),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
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

  console.log(
    `Stryker mutate (${String(mutateFiles.length)} files):\n${mutateFiles.join('\n')}`,
  )

  mkdirSync(path.dirname(MUTATE_FILES_LIST), { recursive: true })
  writeFileSync(MUTATE_FILES_LIST, `${mutateFiles.join('\n')}\n`, 'utf8')

  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'stryker',
      'run',
      ...buildStrykerArgs(mutateFiles, plan.allowEmpty),
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
  const gate = evaluateNoCoverageGate(report.files ?? {})
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
