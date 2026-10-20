#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
/**
 * Soft/hard line budgets for openspec/specs/<capability>/spec.md
 * (quality/gates.json openspecSpecs).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadGates } from './load-gates.mjs'

const ROOT_DEFAULT = resolveRepoRoot()
export const SPECS_REL = 'openspec/specs'

export const MSGS = Object.freeze({
  budgetsMissing: 'openspecSpecs softMaxLines/hardMaxLines missing or invalid',
  softGtHard: 'openspecSpecs.softMaxLines must be <= hardMaxLines',
  overHardPrefix: 'openspec spec over hard budget: ',
  overSoftPrefix: 'openspec spec over soft budget: ',
})

/**
 * Editor-style line count (split on newlines; empty / non-string → 0).
 * @param {unknown} text
 * @returns {number}
 */
export function countSpecLines(text) {
  if (typeof text !== 'string' || text === '') return 0
  return text.split(/\r?\n/).length
}

/**
 * @param {unknown} gates
 * @returns {{ softMaxLines: number, hardMaxLines: number } | null}
 */
export function parseOpenspecSpecBudgets(gates) {
  if (gates == null || typeof gates !== 'object' || Array.isArray(gates)) {
    return null
  }
  const block = /** @type {Record<string, unknown>} */ (gates).openspecSpecs
  if (block == null || typeof block !== 'object' || Array.isArray(block)) {
    return null
  }
  const soft = /** @type {Record<string, unknown>} */ (block).softMaxLines
  const hard = /** @type {Record<string, unknown>} */ (block).hardMaxLines
  if (typeof soft !== 'number' || typeof hard !== 'number') return null
  if (
    !Number.isFinite(soft) ||
    !Number.isFinite(hard) ||
    soft < 0 ||
    hard < 0
  ) {
    return null
  }
  return { softMaxLines: soft, hardMaxLines: hard }
}

/**
 * @param {string} root
 * @returns {string[]} repo-relative paths
 */
export function listOpenspecSpecPaths(root = ROOT_DEFAULT) {
  const specsDir = join(root, SPECS_REL)
  /** @type {string[]} */
  const out = []
  let entries
  try {
    entries = readdirSync(specsDir)
  } catch {
    return out
  }
  for (const name of entries) {
    const dir = join(specsDir, name)
    let st
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const rel = `${SPECS_REL}/${name}/spec.md`
    const abs = join(root, rel)
    try {
      if (statSync(abs).isFile()) out.push(rel)
    } catch {
      // no spec.md
    }
  }
  return out.sort()
}

/**
 * @param {{
 *   root?: string
 *   gates?: unknown
 *   readFile?: (abs: string) => string
 *   listPaths?: (root: string) => string[]
 *   warn?: (msg: string) => void
 *   error?: (msg: string) => void
 *   log?: (msg: string) => void
 * }} [opts]
 * @returns {number} exit code
 */
export function runOpenspecBudgetCheck(opts = {}) {
  const root = opts.root ?? ROOT_DEFAULT
  const warn = opts.warn ?? console.warn
  const error = opts.error ?? console.error
  const log = opts.log ?? console.log
  const readFile = opts.readFile ?? ((p) => readFileSync(p, 'utf8'))
  const listPaths = opts.listPaths ?? listOpenspecSpecPaths

  const gates = opts.gates ?? loadGates({ root })
  const budgets = parseOpenspecSpecBudgets(gates)
  if (budgets == null) {
    error(MSGS.budgetsMissing)
    return 1
  }
  if (budgets.softMaxLines > budgets.hardMaxLines) {
    error(MSGS.softGtHard)
    return 1
  }

  const paths = listPaths(root)
  /** @type {string[]} */
  const hardHits = []
  /** @type {string[]} */
  const softHits = []
  for (const rel of paths) {
    const text = readFile(join(root, rel))
    const lines = countSpecLines(text)
    if (lines > budgets.hardMaxLines) {
      hardHits.push(
        `${MSGS.overHardPrefix}${rel} ${lines}/${budgets.hardMaxLines}`,
      )
    } else if (lines > budgets.softMaxLines) {
      softHits.push(
        `${MSGS.overSoftPrefix}${rel} ${lines}/${budgets.softMaxLines}`,
      )
    }
  }

  for (const msg of softHits) warn(msg)
  if (hardHits.length > 0) {
    for (const msg of hardHits) error(msg)
    return 1
  }
  log(
    `OpenSpec specs within hard budget (${String(paths.length)} files, soft ${String(budgets.softMaxLines)} / hard ${String(budgets.hardMaxLines)}).`,
  )
  return 0
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  process.exitCode = runOpenspecBudgetCheck()
}
