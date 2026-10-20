#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { loadGates } from './load-gates.mjs'
import {
  findExcludeReasonGaps,
  findUnclassifiedProductionFiles,
  loadMutatePatterns,
} from './mutation-scope.mjs'
import { temporaryExcludesMissingBangs } from './stryker-diff-gate.mjs'

/**
 * @param {string} [root]
 * @returns {string[]}
 */
export function listSrcProductionFiles(root = 'src') {
  return readdirSync(root, { recursive: true })
    .map((entry) => `${root}/${String(entry).replaceAll('\\', '/')}`)
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    .sort()
}

/**
 * @param {{
 *   patterns?: string[],
 *   srcFiles?: string[],
 *   reasonText?: string,
 *   gates?: ReturnType<typeof loadGates>,
 *   error?: (msg: string) => void,
 *   log?: (msg: string) => void,
 * }} [opts]
 * @returns {number}
 */
export function runMutationScopeCheck(opts = {}) {
  const error = opts.error ?? console.error
  const log = opts.log ?? console.log
  const patterns = opts.patterns ?? loadMutatePatterns()
  const srcFiles = opts.srcFiles ?? listSrcProductionFiles()
  const unclassified = findUnclassifiedProductionFiles(srcFiles, patterns)
  const reasonText =
    opts.reasonText ?? readFileSync('stryker.mutate.md', 'utf8')
  const gaps = findExcludeReasonGaps(patterns, reasonText)
  const gates = opts.gates ?? loadGates()
  const tempList = gates.mutation?.temporaryExcludes
  const tempPaths = (Array.isArray(tempList) ? tempList : [])
    .map((row) => row.path)
    .filter((p) => typeof p === 'string')
  const tempMissingBangs = temporaryExcludesMissingBangs(tempPaths, patterns)

  const failed =
    unclassified.length > 0 ||
    gaps.missing.length > 0 ||
    gaps.extra.length > 0 ||
    tempMissingBangs.length > 0

  if (!failed) {
    log(
      `Mutation scope covers ${String(srcFiles.length)} src production files.`,
    )
    return 0
  }

  if (unclassified.length > 0) {
    error(
      `Production files under src/ are neither in mutation scope nor excluded:\n${unclassified.join('\n')}`,
    )
  }
  if (gaps.missing.length > 0) {
    error(
      `Exclude patterns missing a reason in stryker.mutate.md:\n${gaps.missing.join('\n')}`,
    )
  }
  if (gaps.extra.length > 0) {
    error(
      `stryker.mutate.md documents excludes that are not in stryker.config.mjs:\n${gaps.extra.join('\n')}`,
    )
  }
  if (tempMissingBangs.length > 0) {
    error(
      `mutation.temporaryExcludes paths missing exact ! bang in stryker.config.mjs:\n${tempMissingBangs.join('\n')}`,
    )
  }
  return 1
}

process.exitCode = runMutationScopeCheck()
