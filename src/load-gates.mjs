#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GATES_RELATIVE_PATH = 'quality/gates.json'

const ROOT_DEFAULT = resolveRepoRoot()

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertPositiveInt(value, label) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertNonNegInt(value, label) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
}

/**
 * @param {unknown} raw
 * @param {string} [pathLabel]
 */
export function validateGates(raw, pathLabel = GATES_RELATIVE_PATH) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${pathLabel} must be a JSON object`)
  }
  const gates = /** @type {Record<string, unknown>} */ (raw)

  const coverage = gates.coverage
  if (
    coverage === null ||
    typeof coverage !== 'object' ||
    Array.isArray(coverage)
  ) {
    throw new Error(`${pathLabel} coverage must be an object`)
  }
  const cov = /** @type {Record<string, unknown>} */ (coverage)
  for (const key of ['statements', 'branches', 'functions', 'lines', 'patch']) {
    assertNonNegInt(cov[key], `${pathLabel} coverage.${key}`)
  }

  const stryker = gates.stryker
  if (
    stryker === null ||
    typeof stryker !== 'object' ||
    Array.isArray(stryker)
  ) {
    throw new Error(`${pathLabel} stryker must be an object`)
  }
  const thresholds = /** @type {Record<string, unknown>} */ (stryker).thresholds
  if (
    thresholds === null ||
    typeof thresholds !== 'object' ||
    Array.isArray(thresholds)
  ) {
    throw new Error(`${pathLabel} stryker.thresholds must be an object`)
  }
  const thr = /** @type {Record<string, unknown>} */ (thresholds)
  for (const key of ['high', 'low', 'break']) {
    assertNonNegInt(thr[key], `${pathLabel} stryker.thresholds.${key}`)
  }

  const diffThresholds = /** @type {Record<string, unknown>} */ (stryker)
    .diffThresholds
  if (
    diffThresholds === null ||
    typeof diffThresholds !== 'object' ||
    Array.isArray(diffThresholds)
  ) {
    throw new Error(`${pathLabel} stryker.diffThresholds must be an object`)
  }
  const diffThr = /** @type {Record<string, unknown>} */ (diffThresholds)
  for (const key of ['high', 'low', 'break']) {
    assertNonNegInt(diffThr[key], `${pathLabel} stryker.diffThresholds.${key}`)
  }

  const mutation = gates.mutation
  if (
    mutation === null ||
    typeof mutation !== 'object' ||
    Array.isArray(mutation)
  ) {
    throw new Error(`${pathLabel} mutation must be an object`)
  }
  const mut = /** @type {Record<string, unknown>} */ (mutation)
  assertNonNegInt(mut.disableBudget, `${pathLabel} mutation.disableBudget`)
  if (!Array.isArray(mut.temporaryExcludes)) {
    throw new Error(`${pathLabel} mutation.temporaryExcludes must be an array`)
  }
  for (const entry of mut.temporaryExcludes) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `${pathLabel} mutation.temporaryExcludes entries must be objects`,
      )
    }
    const row = /** @type {Record<string, unknown>} */ (entry)
    if (typeof row.path !== 'string' || row.path.length === 0) {
      throw new Error(
        `${pathLabel} mutation.temporaryExcludes.path must be a non-empty string`,
      )
    }
    if (typeof row.until !== 'string' || row.until.length === 0) {
      throw new Error(
        `${pathLabel} mutation.temporaryExcludes.until must be a non-empty string`,
      )
    }
  }

  const lighthouse = gates.lighthouse
  if (
    lighthouse === null ||
    typeof lighthouse !== 'object' ||
    Array.isArray(lighthouse)
  ) {
    throw new Error(`${pathLabel} lighthouse must be an object`)
  }
  const lh = /** @type {Record<string, unknown>} */ (lighthouse)
  assertPositiveInt(lh.numberOfRuns, `${pathLabel} lighthouse.numberOfRuns`)
  if (
    lh.assertions === null ||
    typeof lh.assertions !== 'object' ||
    Array.isArray(lh.assertions)
  ) {
    throw new Error(`${pathLabel} lighthouse.assertions must be an object`)
  }
  if (!Array.isArray(lh.budgets)) {
    throw new Error(`${pathLabel} lighthouse.budgets must be an array`)
  }

  const playwright = gates.playwright
  if (
    playwright === null ||
    typeof playwright !== 'object' ||
    Array.isArray(playwright)
  ) {
    throw new Error(`${pathLabel} playwright must be an object`)
  }
  const pw = /** @type {Record<string, unknown>} */ (playwright)
  assertNonNegInt(pw.retries, `${pathLabel} playwright.retries`)
  assertNonNegInt(pw.flakyRetries, `${pathLabel} playwright.flakyRetries`)

  const e2e = gates.e2e
  if (e2e === null || typeof e2e !== 'object' || Array.isArray(e2e)) {
    throw new Error(`${pathLabel} e2e must be an object`)
  }
  const e2eObj = /** @type {Record<string, unknown>} */ (e2e)
  assertPositiveInt(e2eObj.burnInDefault, `${pathLabel} e2e.burnInDefault`)
  if (!Array.isArray(e2eObj.flakySpecs)) {
    throw new Error(`${pathLabel} e2e.flakySpecs must be an array`)
  }
  for (const entry of e2eObj.flakySpecs) {
    if (typeof entry !== 'string') {
      throw new Error(`${pathLabel} e2e.flakySpecs entries must be strings`)
    }
  }

  if (gates.checks !== undefined) {
    validateChecksBlock(gates.checks, pathLabel)
  }

  return gates
}

/**
 * Optional `checks` table for `pnpm check` / future `@albasov/ts-agent-rig`.
 * @param {unknown} raw
 * @param {string} pathLabel
 */
function validateChecksBlock(raw, pathLabel) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${pathLabel} checks must be an object`)
  }
  const block = /** @type {Record<string, unknown>} */ (raw)
  for (const key of ['core', 'afterUnit', 'optional']) {
    const list = block[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      throw new Error(`${pathLabel} checks.${key} must be an array`)
    }
    for (const row of list) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`${pathLabel} checks.${key} entries must be objects`)
      }
      const entry = /** @type {Record<string, unknown>} */ (row)
      if (typeof entry.name !== 'string' || entry.name.length === 0) {
        throw new Error(
          `${pathLabel} checks.${key}[].name must be a non-empty string`,
        )
      }
      const hasArgv = Array.isArray(entry.argv)
      const hasScript =
        typeof entry.script === 'string' && entry.script.length > 0
      if (hasArgv === hasScript) {
        throw new Error(
          `${pathLabel} checks.${key}[].${entry.name} needs exactly one of argv or script`,
        )
      }
      if (hasArgv) {
        const argv = /** @type {unknown[]} */ (entry.argv)
        if (argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
          throw new Error(
            `${pathLabel} checks.${key}[].${entry.name}.argv must be non-empty strings`,
          )
        }
      }
    }
  }
}

/**
 * @param {{
 *   root?: string,
 *   readFile?: (path: string) => string,
 * }} [io]
 */
export function loadGates(io = {}) {
  const root = io.root ?? ROOT_DEFAULT
  const readFile = io.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const filePath = join(root, GATES_RELATIVE_PATH)
  let raw
  try {
    raw = JSON.parse(readFile(filePath))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load ${GATES_RELATIVE_PATH}: ${message}`)
  }
  return validateGates(raw, GATES_RELATIVE_PATH)
}
