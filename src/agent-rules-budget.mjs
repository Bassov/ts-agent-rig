/**
 * Agent rule-file line/char budgets (quality/gates.json agentRules.budgets).
 */
import { Buffer } from 'node:buffer'

export const AGENT_RULES_OVER_BUDGET = 'agent-rules-over-budget'

export const MSGS = Object.freeze({
  budgetsRemoved: 'agentRules.budgets removed',
  budgetsMissing: 'agentRules.budgets missing',
  missingEntryPrefix: 'agentRules.budgets missing entry for ',
  missingFilePrefix: 'budgeted rule file missing: ',
  overBudgetPrefix: 'agent rule over budget: ',
  raisedLinesPrefix: 'agentRules.budgets maxLines raised: ',
  raisedCharsPrefix: 'agentRules.budgets maxChars raised: ',
  missingBudgetPathPrefix: 'agentRules.budgets missing path: ',
})

/**
 * Editor-style line count (split on newlines; empty / non-string → 0).
 * @param {unknown} text
 * @returns {number}
 */
export function countRuleFileLines(text) {
  if (typeof text !== 'string' || text === '') return 0
  return text.split(/\r?\n/).length
}

/**
 * UTF-8 byte length (non-string → 0).
 * @param {unknown} text
 * @returns {number}
 */
export function countRuleFileChars(text) {
  if (typeof text !== 'string') return 0
  return Buffer.byteLength(text, 'utf8')
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
export function isScopedAgentRulePath(rel) {
  const n = String(rel).replaceAll('\\', '/')
  if (n === 'AGENTS.md') return true
  if (n === 'openspec/config.yaml') return true
  if (n === '.cursor/commands/next-roadmap-item.md') return true
  if (n.startsWith('.cursor/rules/') && n.endsWith('.mdc')) return true
  if (n.startsWith('.cursor/agents/') && n.endsWith('.md')) return true
  if (n === 'CLAUDE.md') return true
  if (/^\.claude\/(agents|commands|rules)\/[^/]+\.md$/.test(n)) return true
  return false
}

/**
 * @param {Record<string, string | undefined>} files
 * @param {(files: Record<string, string | undefined>, rel: string) => string | undefined} [getFile]
 * @returns {string[]}
 */
export function listScopedAgentRulePaths(files, getFile = (f, rel) => f[rel]) {
  /** @type {Set<string>} */
  const out = new Set()
  for (const key of Object.keys(files)) {
    const n = key.replaceAll('\\', '/')
    if (!isScopedAgentRulePath(n)) continue
    if (getFile(files, n) === undefined && getFile(files, key) === undefined) {
      continue
    }
    out.add(n)
  }
  return [...out].sort()
}

/**
 * @param {unknown} gates
 * @returns {Map<string, { maxLines: number, maxChars: number }> | null}
 */
export function parseAgentRuleBudgets(gates) {
  if (gates == null || typeof gates !== 'object' || Array.isArray(gates)) {
    return null
  }
  const agentRules = /** @type {Record<string, unknown>} */ (gates).agentRules
  if (
    agentRules == null ||
    typeof agentRules !== 'object' ||
    Array.isArray(agentRules)
  ) {
    return null
  }
  const list = /** @type {Record<string, unknown>} */ (agentRules).budgets
  if (!Array.isArray(list)) return null
  /** @type {Map<string, { maxLines: number, maxChars: number }>} */
  const map = new Map()
  for (const row of list) {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) continue
    const rec = /** @type {Record<string, unknown>} */ (row)
    if (typeof rec.path !== 'string') continue
    const maxLines = rec.maxLines
    const maxChars = rec.maxChars
    if (typeof maxLines !== 'number' || typeof maxChars !== 'number') continue
    if (
      !Number.isFinite(maxLines) ||
      !Number.isFinite(maxChars) ||
      maxLines < 0 ||
      maxChars < 0
    ) {
      continue
    }
    map.set(rec.path.replaceAll('\\', '/'), { maxLines, maxChars })
  }
  return map
}

/**
 * Absolute head checks. No-op when head has no scoped rule files and no budgets.
 * @param {Record<string, string | undefined>} headFiles
 * @param {unknown} headGates
 * @param {(ruleId: string, message: string) => void} fail
 * @param {{ getFile?: (files: Record<string, string | undefined>, rel: string) => string | undefined }} [opts]
 */
export function checkAgentRuleBudgetsAbsolute(
  headFiles,
  headGates,
  fail,
  opts = {},
) {
  const getFile = opts.getFile ?? ((f, rel) => f[rel])
  const scoped = listScopedAgentRulePaths(headFiles, getFile)
  const budgets = parseAgentRuleBudgets(headGates)
  if (budgets == null) {
    if (scoped.length > 0) {
      fail(AGENT_RULES_OVER_BUDGET, MSGS.budgetsMissing)
    }
    return
  }
  for (const p of scoped) {
    if (!budgets.has(p)) {
      fail(AGENT_RULES_OVER_BUDGET, `${MSGS.missingEntryPrefix}${p}`)
    }
  }
  for (const [p, b] of budgets) {
    const raw = getFile(headFiles, p)
    if (raw === undefined) {
      fail(AGENT_RULES_OVER_BUDGET, `${MSGS.missingFilePrefix}${p}`)
      continue
    }
    const lines = countRuleFileLines(raw)
    const chars = countRuleFileChars(raw)
    if (lines > b.maxLines || chars > b.maxChars) {
      fail(
        AGENT_RULES_OVER_BUDGET,
        `${MSGS.overBudgetPrefix}${p} lines ${lines}/${b.maxLines} chars ${chars}/${b.maxChars}`,
      )
    }
  }
}

/**
 * Ratchet: when base has budgets, head must keep them for surviving files and
 * must not raise maxLines/maxChars.
 * @param {unknown} baseGates
 * @param {unknown} headGates
 * @param {Record<string, string | undefined>} headFiles
 * @param {string} pathLabel
 * @param {(message: string) => void} fail
 * @param {{ getFile?: (files: Record<string, string | undefined>, rel: string) => string | undefined }} [opts]
 */
export function compareAgentRuleBudgets(
  baseGates,
  headGates,
  headFiles,
  pathLabel,
  fail,
  opts = {},
) {
  const getFile = opts.getFile ?? ((f, rel) => f[rel])
  const bMap = parseAgentRuleBudgets(baseGates)
  if (bMap == null) return
  const hMap = parseAgentRuleBudgets(headGates)
  if (hMap == null) {
    fail(`${pathLabel} ${MSGS.budgetsRemoved}`)
    return
  }
  for (const [p, b] of bMap) {
    if (getFile(headFiles, p) === undefined) continue
    const h = hMap.get(p)
    if (h == null) {
      fail(`${pathLabel} ${MSGS.missingBudgetPathPrefix}${p}`)
      continue
    }
    if (h.maxLines > b.maxLines) {
      fail(
        `${pathLabel} ${MSGS.raisedLinesPrefix}${p}: ${b.maxLines} → ${h.maxLines}`,
      )
    }
    if (h.maxChars > b.maxChars) {
      fail(
        `${pathLabel} ${MSGS.raisedCharsPrefix}${p}: ${b.maxChars} → ${h.maxChars}`,
      )
    }
  }
}
