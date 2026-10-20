#!/usr/bin/env node
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { collectStrykerDisableComments } from './stryker-disable-detect.mjs'

export const DEFAULT_MUTATION_REPORT = 'reports/mutation/mutation.json'
export const SURVIVED_SAMPLE_LIMIT = 8

/**
 * @param {string} filePath
 * @param {string} text
 */
export function collectDisablesFromText(filePath, text) {
  /** @type {{ path: string, reason: string }[]} */
  const out = []
  const { legal, illegal } = collectStrykerDisableComments(text)
  for (const d of legal) {
    out.push({ path: filePath, reason: d.reason })
  }
  for (const d of illegal) {
    out.push({ path: filePath, reason: d.line.trim() })
  }
  return out
}

/**
 * @param {{ status?: string, location?: { start?: { line?: number } }, mutatorName?: string, id?: string }} mutant
 * @param {string} filePath
 */
export function formatSurvivedSample(mutant, filePath) {
  const line = mutant.location?.start?.line
  const lineText = typeof line === 'number' ? String(line) : '?'
  const name = mutant.mutatorName || mutant.id || ''
  return `- \`${filePath}:${lineText}\` ${name}`
}

/**
 * @param {{ status?: string, location?: { start?: { line?: number } }, mutatorName?: string, id?: string }} mutant
 * @param {string} filePath
 */
export function formatNoCoverageSample(mutant, filePath) {
  const line = mutant.location?.start?.line
  const lineText = typeof line === 'number' ? String(line) : '?'
  const name = mutant.mutatorName || mutant.id || ''
  return `- \`${filePath}:${lineText}\` ${name}`
}

/**
 * @param {Record<string, { mutants?: { status?: string, location?: { start?: { line?: number } }, mutatorName?: string, id?: string }[] }>} fileMap
 */
export function listNoCoverageSamples(fileMap) {
  /** @type {string[]} */
  const out = []
  for (const [filePath, file] of Object.entries(fileMap)) {
    const mutants = Array.isArray(file.mutants) ? file.mutants : []
    for (const mutant of mutants) {
      if (mutant.status === 'NoCoverage') {
        out.push(formatNoCoverageSample(mutant, filePath))
      }
    }
  }
  return out
}

/**
 * Changed files with no entry (or empty mutants) in the mutation report.
 * @param {string[]} changedFiles
 * @param {Record<string, { mutants?: unknown[] }>} fileMap
 */
export function listUnmutatedChangedFiles(changedFiles, fileMap) {
  return changedFiles
    .filter((file) => {
      const entry = fileMap[file]
      if (entry == null) return true
      const mutants = Array.isArray(entry.mutants) ? entry.mutants : []
      return mutants.length === 0
    })
    .sort()
}

/**
 * @param {Record<string, { mutants?: { status?: string, location?: { start?: { line?: number } }, mutatorName?: string, id?: string }[] }>} fileMap
 */
export function summarizeMutationFiles(fileMap) {
  let killed = 0
  let survived = 0
  let timeout = 0
  let noCoverage = 0
  let ignored = 0
  let other = 0
  /** @type {string[]} */
  const survivedSamples = []
  /** @type {{ path: string, ignored: number }[]} */
  const ignoredPerFile = []
  for (const [filePath, file] of Object.entries(fileMap)) {
    let fileIgnored = 0
    const mutants = Array.isArray(file.mutants) ? file.mutants : []
    for (const mutant of mutants) {
      const status = mutant.status
      if (status === 'Killed') killed += 1
      else if (status === 'Survived') {
        survived += 1
        if (survivedSamples.length < SURVIVED_SAMPLE_LIMIT) {
          survivedSamples.push(formatSurvivedSample(mutant, filePath))
        }
      } else if (status === 'Timeout' || status === 'TimedOut') timeout += 1
      else if (status === 'NoCoverage') noCoverage += 1
      else if (status === 'Ignored') {
        ignored += 1
        fileIgnored += 1
      } else other += 1
    }
    if (fileIgnored > 0) {
      ignoredPerFile.push({ path: filePath, ignored: fileIgnored })
    }
  }
  return {
    killed,
    survived,
    timeout,
    noCoverage,
    ignored,
    other,
    survivedSamples,
    ignoredPerFile,
  }
}

/**
 * @param {number} killed
 * @param {number} timeout
 * @param {number} survived
 * @param {number} noCoverage
 */
export function mutationScore(killed, timeout, survived, noCoverage) {
  const detected = killed + timeout
  const scoreValid = detected + survived + noCoverage
  if (scoreValid === 0) return 100
  return Math.round((detected / scoreValid) * 1000) / 10
}

/**
 * @param {{
 *   files: Record<string, { mutants?: unknown[] }>,
 *   readFile?: (p: string) => string | null,
 *   changedFiles?: string[],
 *   mutateRanges?: string[],
 * }} opts
 */
export function buildMutationSummaryMarkdown(opts) {
  const summary = summarizeMutationFiles(opts.files)
  const score = mutationScore(
    summary.killed,
    summary.timeout,
    summary.survived,
    summary.noCoverage,
  )
  const noCoverageSamples = listNoCoverageSamples(
    /** @type {Record<string, { mutants?: { status?: string, location?: { start?: { line?: number } }, mutatorName?: string, id?: string }[] }>} */ (
      opts.files
    ),
  )
  const unmutated = Array.isArray(opts.changedFiles)
    ? listUnmutatedChangedFiles(opts.changedFiles, opts.files)
    : []

  /** @type {{ path: string, reason: string }[]} */
  const disableList = []
  if (opts.readFile) {
    for (const filePath of Object.keys(opts.files)) {
      const text = opts.readFile(filePath)
      if (text == null) continue
      disableList.push(...collectDisablesFromText(filePath, text))
    }
  }

  /** @type {string[]} */
  const lines = [
    '## Mutation testing',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Score | **${score}%** |`,
    `| Killed | ${summary.killed} |`,
    `| Survived | ${summary.survived} |`,
    `| Timed out | ${summary.timeout} |`,
    `| No coverage | ${summary.noCoverage} |`,
    `| Ignored | ${summary.ignored} |`,
    '',
  ]

  if (summary.ignoredPerFile.length > 0) {
    lines.push('### Ignored per file', '')
    for (const row of summary.ignoredPerFile) {
      lines.push(`- \`${row.path}\`: ${row.ignored}`)
    }
    lines.push('')
  }

  if (disableList.length > 0) {
    lines.push('### Mutation suppressions', '')
    for (const d of disableList) {
      lines.push(`- \`${d.path}\`: ${d.reason}`)
    }
    lines.push('')
  }

  if (noCoverageSamples.length > 0) {
    lines.push('### NoCoverage mutants', '')
    for (const sample of noCoverageSamples) {
      lines.push(sample)
    }
    lines.push('')
  }

  const mutateRanges = opts.mutateRanges
  if (Array.isArray(mutateRanges) && mutateRanges.length > 0) {
    lines.push('### Scored mutate ranges', '')
    for (const spec of mutateRanges) {
      lines.push(`- \`${spec}\``)
    }
    lines.push('')
  }

  if (unmutated.length > 0) {
    lines.push('### Changed files not mutated', '')
    for (const file of unmutated) {
      lines.push(`- \`${file}\``)
    }
    lines.push('')
  }

  if (summary.survivedSamples.length > 0) {
    lines.push('### Sample survived mutants', '')
    for (const sample of summary.survivedSamples) {
      lines.push(sample)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * @param {string[]} argv report path in argv[0]
 * @param {NodeJS.ProcessEnv} [env]
 */
/**
 * Resolve the changed/mutate file list for unmutated reporting.
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   exists?: (p: string) => boolean,
 *   read?: (p: string) => string,
 *   mutateListPath?: string,
 * }} [io]
 * @returns {string[] | undefined}
 */
export function resolveChangedFilesForSummary(env, io = {}) {
  const exists = io.exists ?? existsSync
  const read = io.read ?? ((p) => readFileSync(p, 'utf8'))
  const mutateListPath =
    io.mutateListPath ?? 'reports/mutation/mutate-files.txt'
  const fromEnv = env.STRYKER_CHANGED_FILES
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  }
  if (exists(mutateListPath)) {
    return read(mutateListPath)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  }
  return undefined
}

export function runStrykerPrSummaryCli(argv, env = process.env) {
  const reportPath = argv[0]
  if (reportPath == null || reportPath.length === 0) {
    console.error('Usage: stryker-pr-summary-cli.mjs <mutation.json>')
    return 2
  }
  if (!existsSync(reportPath)) {
    console.error(`No mutation report at ${reportPath}`)
    return 2
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const files = report.files ?? {}
  const changedFiles = resolveChangedFilesForSummary(env)
  const rangesPath = 'reports/mutation/mutate-ranges.txt'
  /** @type {string[] | undefined} */
  let mutateRanges
  if (existsSync(rangesPath)) {
    mutateRanges = readFileSync(rangesPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  }
  const markdown = buildMutationSummaryMarkdown({
    files,
    changedFiles,
    mutateRanges,
    readFile: (p) => {
      if (!existsSync(p)) return null
      return readFileSync(p, 'utf8')
    },
  })
  process.stdout.write(markdown)
  const summaryPath = env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    appendFileSync(summaryPath, markdown)
  }
  return 0
}
