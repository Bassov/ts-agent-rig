#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadFlakySpecPaths } from './e2e-flaky-list.mjs'

function asSuites(report) {
  return Array.isArray(report?.suites) ? report.suites : []
}

function asList(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Count tests that passed only after a prior failed attempt (retried pass).
 * @param {unknown} report Playwright JSON report
 */
export function countFlakyRetriedPasses(report) {
  let flaky = 0
  const walk = (suite) => {
    for (const child of asList(suite?.suites)) walk(child)
    for (const spec of asList(suite?.specs)) {
      for (const test of asList(spec?.tests)) {
        const results = asList(test?.results)
        if (results.length < 2) continue
        const last = results.at(-1)
        const earlierFailed = results
          .slice(0, -1)
          .some(
            (result) =>
              result.status === 'failed' || result.status === 'timedOut',
          )
        if (earlierFailed && last?.status === 'passed') flaky += 1
      }
    }
  }
  for (const suite of asSuites(report)) walk(suite)
  return flaky
}

/**
 * Count tests whose final attempt failed or timed out.
 * @param {unknown} report Playwright JSON report
 */
export function countFailedTests(report) {
  let failed = 0
  const walk = (suite) => {
    for (const child of asList(suite?.suites)) walk(child)
    for (const spec of asList(suite?.specs)) {
      for (const test of asList(spec?.tests)) {
        const results = asList(test?.results)
        const last = results.at(-1)
        if (last?.status === 'failed' || last?.status === 'timedOut') {
          failed += 1
        }
      }
    }
  }
  for (const suite of asSuites(report)) walk(suite)
  return failed
}

/**
 * Playwright CLI args for PR burn-in (no shell wrapping).
 * @param {{ targets: string[], count: number }} opts
 */
export function buildBurnInArgs({ targets, count }) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `burn-in count must be a positive integer, got ${String(count)}`,
    )
  }
  const list = (Array.isArray(targets) ? targets : [])
    .map((t) => String(t).trim())
    .filter(Boolean)
  return [
    'playwright',
    'test',
    '--project=chromium',
    ...list,
    `--repeat-each=${String(count)}`,
    '--retries=0',
    '--workers=1',
  ]
}

/**
 * @param {{
 *   burnInCount: number | null,
 *   flakyCount: number,
 *   flakyListCount?: number,
 *   burnInOutcome?: string | null,
 *   burnInFailedCount?: number | null,
 * }} metrics
 */
export function formatE2eSectionMarkdown({
  burnInCount,
  flakyCount,
  flakyListCount = 0,
  burnInOutcome = null,
  burnInFailedCount = null,
}) {
  const lines = [
    '## E2E',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Flaky (retried pass) | ${String(flakyCount)} |`,
    `| @flaky list | ${String(flakyListCount)} |`,
  ]
  if (burnInCount !== null && burnInCount !== undefined) {
    lines.push(`| Burn-in | ${String(burnInCount)} |`)
  }
  if (burnInOutcome && burnInOutcome !== 'skipped') {
    let result = burnInOutcome === 'success' ? 'passed' : 'failed'
    if (
      burnInOutcome !== 'success' &&
      burnInFailedCount !== null &&
      burnInFailedCount !== undefined
    ) {
      result = `failed (${String(burnInFailedCount)} failed)`
    }
    lines.push(`| Burn-in result | ${result} |`)
  }
  return `${lines.join('\n')}\n`
}

export function loadPlaywrightJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** @param {unknown} value */
export function optionalArg(value) {
  if (value === undefined || value === true || value === '') return null
  return String(value)
}

export function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

export function main(argv, io = {}) {
  if (!Array.isArray(argv)) {
    throw new Error(
      'Usage: e2e-playwright-summary.mjs --report <json> [--burn-in N] [--burn-in-outcome O] [--burn-in-report json] [--out file]',
    )
  }
  const args = parseArgs(argv)
  const readJson = io.loadJson ?? loadPlaywrightJson
  const writeOut =
    io.writeFile ??
    ((path, body) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
    })
  const writeStdout =
    typeof io.write === 'function'
      ? io.write
      : (text) => process.stdout.write(text)
  const exists =
    typeof io.exists === 'function' ? io.exists : (path) => existsSync(path)

  const reportPath = optionalArg(args.report)
  if (!reportPath || !exists(reportPath)) {
    throw new Error(
      'Usage: e2e-playwright-summary.mjs --report <json> [--burn-in N] [--burn-in-outcome O] [--burn-in-report json] [--out file]',
    )
  }

  const burnInRaw = optionalArg(args['burn-in'])
  const burnInCount = burnInRaw === null ? null : Number(burnInRaw)
  const burnInOutcome = optionalArg(args['burn-in-outcome'])
  const burnInReport = optionalArg(args['burn-in-report'])

  let burnInFailedCount = null
  if (burnInReport && exists(burnInReport)) {
    burnInFailedCount = countFailedTests(readJson(burnInReport))
  }

  const flakyCount = countFlakyRetriedPasses(readJson(reportPath))
  const loadFlaky =
    io.loadFlakySpecPaths ??
    (() => loadFlakySpecPaths({ root: io.root ?? process.cwd() }))
  const flakyListCount = loadFlaky().length
  const body = formatE2eSectionMarkdown({
    burnInCount,
    flakyCount,
    flakyListCount,
    burnInOutcome,
    burnInFailedCount,
  })
  const outPath = optionalArg(args.out)
  if (outPath) {
    writeOut(outPath, body)
  } else {
    writeStdout(body)
  }
  return 0
}
