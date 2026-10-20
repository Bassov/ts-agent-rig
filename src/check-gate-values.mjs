#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { GATES_RELATIVE_PATH, loadGates } from './load-gates.mjs'

const ROOT_DEFAULT = resolveRepoRoot()

export const CONSUMER_RELATIVE_PATHS = [
  'vite.config.ts',
  'stryker.config.mjs',
  'lighthouserc.cjs',
  'playwright.config.ts',
  'packages/ts-agent-rig/src/e2e-burn-in-count.mjs',
  'packages/ts-agent-rig/src/e2e-flaky-list.mjs',
  'packages/ts-agent-rig/src/load-gates.mjs',
  'packages/ts-agent-rig/src/check-patch-coverage.mjs',
]

export const WORKFLOW_RELATIVE_PATH = '.github/workflows/integration.yml'

/**
 * @param {unknown} a
 * @param {unknown} b
 */
export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * @param {string} source
 */
export function consumerReferencesGates(source) {
  return (
    source.includes('quality/gates.json') ||
    source.includes('load-gates') ||
    source.includes('GATES_RELATIVE_PATH')
  )
}

/**
 * @param {string} source
 * @param {string} relativePath
 */
export function findHardcodedGateLiterals(source, relativePath) {
  /** @type {string[]} */
  const hits = []
  if (relativePath.endsWith('/load-gates.mjs') || relativePath === 'scripts/load-gates.mjs') {
    return hits
  }

  if (
    /thresholds:\s*\{\s*statements:\s*80/.test(source) ||
    /statements:\s*80,\s*branches:\s*80/.test(source)
  ) {
    hits.push('coverage-thresholds-object')
  }

  if (
    /"thresholds"\s*:\s*\{\s*"high"\s*:\s*80/.test(source) ||
    /thresholds:\s*\{\s*high:\s*80/.test(source)
  ) {
    hits.push('stryker-thresholds-object')
  }

  if (
    /numberOfRuns:\s*1\b/.test(source) &&
    !source.includes('gates.lighthouse.numberOfRuns')
  ) {
    hits.push('lhci-numberOfRuns-literal')
  }

  if (
    /['"]performance-budget['"]\s*:\s*['"]error['"]/.test(source) &&
    !source.includes('gates.lighthouse.assertions')
  ) {
    hits.push('lhci-performance-budget-literal')
  }

  if (
    /retries:\s*0\b/.test(source) &&
    !source.includes('gates.playwright.retries')
  ) {
    hits.push('playwright-retries-literal')
  }

  if (
    /retries:\s*2\b/.test(source) &&
    !source.includes('gates.playwright.flakyRetries')
  ) {
    hits.push('playwright-flaky-retries-literal')
  }

  if (/\?\s*10\s*:\s*Number\(\s*raw\s*\)/.test(source)) {
    hits.push('burn-in-default-literal')
  }

  return hits
}

/**
 * @param {string} workflowSource
 */
export function workflowHardcodesBurnIn(workflowSource) {
  return /E2E_BURN_IN:\s*['"]\d+['"]/.test(workflowSource)
}

/**
 * @param {{
 *   root?: string,
 *   readFile?: (path: string) => string,
 *   loadGatesFn?: typeof loadGates,
 * }} [io]
 */
export function checkGateValues(io = {}) {
  const root = io.root ?? ROOT_DEFAULT
  const readFile = io.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const load = io.loadGatesFn ?? loadGates
  /** @type {string[]} */
  const errors = []

  let gates
  try {
    gates = load({ root, readFile })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, errors: [message] }
  }

  try {
    const budget = JSON.parse(readFile(join(root, 'budget.json')))
    if (!deepEqual(budget, gates.lighthouse.budgets)) {
      errors.push(
        'budget.json must deep-equal quality/gates.json lighthouse.budgets',
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`budget.json: ${message}`)
  }

  try {
    const flaky = JSON.parse(readFile(join(root, 'e2e/flaky.json')))
    if (!deepEqual(flaky, gates.e2e.flakySpecs)) {
      errors.push(
        'e2e/flaky.json must deep-equal quality/gates.json e2e.flakySpecs',
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`e2e/flaky.json: ${message}`)
  }

  for (const relativePath of CONSUMER_RELATIVE_PATHS) {
    let source
    try {
      source = readFile(join(root, relativePath))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${relativePath}: ${message}`)
      continue
    }
    if (!consumerReferencesGates(source)) {
      errors.push(
        `${relativePath} must reference ${GATES_RELATIVE_PATH} or load-gates`,
      )
    }
    for (const hit of findHardcodedGateLiterals(source, relativePath)) {
      errors.push(`${relativePath} hardcodes gate value (${hit})`)
    }
  }

  try {
    const workflow = readFile(join(root, WORKFLOW_RELATIVE_PATH))
    if (workflowHardcodesBurnIn(workflow)) {
      errors.push(
        `${WORKFLOW_RELATIVE_PATH} must not hardcode E2E_BURN_IN: '<n>'`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`${WORKFLOW_RELATIVE_PATH}: ${message}`)
  }

  return { ok: errors.length === 0, errors }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = checkGateValues()
  if (!result.ok) {
    console.error(result.errors.join('\n'))
    process.exit(1)
  }
  console.log('Gate values: quality/gates.json is the sole threshold SoT.')
}
