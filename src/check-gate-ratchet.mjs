#!/usr/bin/env node
import { resolveRepoRoot } from './resolve-repo-root.mjs'
/**
 * Gate ratchet: head tree must not be weaker than base.
 * CI: run from base checkout; head is read as git object data only.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  compareItemCriteria,
  compareTestWeakening,
  hasOwnerApprovedScopeChange,
} from './check-test-weakening.mjs'
import {
  codecovFlagPathCovered,
  compareScriptScopeGates,
} from './script-include-ratchet.mjs'
import { stripGitKeys } from './strip-git-env.mjs'
import {
  AGENT_RULES_OVER_BUDGET,
  checkAgentRuleBudgetsAbsolute,
  compareAgentRuleBudgets,
} from './agent-rules-budget.mjs'

/** Intentional baseline edits waived when Owner-approved scope change is present. */
export const OWNER_WAIVABLE_RULE_IDS = Object.freeze([
  'gates-json-weaker',
  'stryker-weaker',
  'item-criteria-loosened',
  'include-removed',
  'exclude-added',
  'gate-file-gone',
  'temporary-excludes-grew',
])

export const TS_AGENT_RIG_PACKAGE = '@albasov/ts-agent-rig'

export const RULE_IDS = Object.freeze([
  'gates-json-weaker',
  'codecov-weaker',
  'exclude-added',
  'include-removed',
  'stryker-weaker',
  'patched-deps-grown',
  'ignore-comment-added',
  'stryker-disable-added',
  'stryker-disable-per-file',
  'stryker-disable-budget',
  'gate-file-gone',
  'required-job-step-moved',
  'test-skip-added',
  'test-retries-added',
  'test-file-deleted',
  'allow-only-weaker',
  'forbid-only-weaker',
  'item-criteria-loosened',
  'diff-below-nightly',
  'temporary-excludes-grew',
  AGENT_RULES_OVER_BUDGET,
])

export const FIXTURE_IDS = Object.freeze([
  'weaker-threshold',
  'new-exclude',
  'removed-agent-include',
  'new-excluded-mutations',
  'new-v8-ignore',
  'new-stryker-disable',
  'legal-stryker-disable-within-budget',
  'stryker-disable-over-per-file',
  'stryker-disable-over-budget',
  'burn-in-moved-without-needs',
  'burn-in-moved-with-needs',
  'added-skip',
  'added-fixme',
  'added-retries',
  'forbid-only-false',
  'allow-only-true',
  'deleted-test-file-alone',
  'deleted-test-file-with-companion',
  'done-when-rewrite',
  'deferral-item',
  'checkbox-done-note',
  'done-when-heading-bypass',
  'blank-done-when-bypass',
  'weaker-diff-threshold',
  'diff-below-nightly',
  'temporary-excludes-grew',
  'temporary-excludes-seed',
  'scripts-glob-pr126-replay',
  'scripts-include-uncovered-removed',
  'broad-script-exclude',
  'non-thin-cli-exclude',
  'codecov-path-uncovered',
  'agent-rules-over-budget',
  'agent-rules-within-budget',
  'agent-rules-budget-raised',
])

/** Fail-message fragments — exact values pinned by unit tests. */
export const MSGS = Object.freeze({
  gatesJsonDeleted: 'quality/gates.json deleted',
  codecovDeleted: 'codecov.yml deleted',
  gateFileMissingPrefix: 'gate file missing on head: ',
  parseGatesPrefix: 'failed to parse quality/gates.json: ',
  parseCodecovPrefix: 'failed to parse codecov.yml: ',
  includeRemovedPrefix: 'coverage include removed: ',
  mutateIncludeRemovedPrefix: 'stryker mutate include removed: ',
  excludeAddedPrefix: 'coverage exclude added: ',
  bangAddedPrefix: 'stryker mutate bang added: ',
  excludedMutationsPrefix: 'excludedMutations added: ',
  strykerWeakerPrefix: 'stryker weaker: ',
  patchedGrewPrefix: 'pnpm.patchedDependencies grew: ',
  packageParsePrefix: 'package.json parse failed: ',
  ignoreCommentPrefix: 'suppression comment added in ',
  strykerDisablePrefix: 'mutation suppression comment added in ',
  strykerDisablePerFilePrefix: 'mutation suppression per-file cap exceeded in ',
  strykerDisableBudgetPrefix: 'mutation suppression repo budget exceeded: ',
  strykerDisableBudgetMid: ' > ',
  requiredJobFailedPrefix: 'required-job check failed: ',
  requiredJobRemovedPrefix: 'required job ',
  requiredJobRemovedSuffix: ' removed',
  lostGateMid: ' lost gate ',
  lostGateSuffix: ' without needs:+fail aggregation',
  codecovLabelRemovedSuffix: ' removed',
  codecovYmlPrefix: 'codecov.yml ',
  diffBelowNightlyPrefix: 'stryker.diffThresholds.',
  diffBelowNightlyMid: ' < stryker.thresholds.',
  tempExcludesGrewPrefix: 'mutation.temporaryExcludes grew: ',
})

/** Detector / probe needles — exact values pinned by unit tests. */
export const NEEDLES = Object.freeze({
  coverage: 'coverage',
  include: 'include',
  exclude: 'exclude',
  coverageExcludeGlobs: 'coverageExcludeGlobs',
  mutate: 'mutate',
  excludedMutations: 'excludedMutations',
  bangPrefix: '!',
  disableTypeChecksTrue: 'disableTypeChecks:true',
  ignoreStaticFalse: 'ignoreStatic:false',
  coverageAnalysisOffSingle: "coverageAnalysis:'off'",
  coverageAnalysisOffDouble: 'coverageAnalysis:"off"',
  ignorersOpen: 'ignorers:[',
  ignorersEmpty: 'ignorers:[]',
  exit1: 'exit 1',
  needsDot: 'needs.',
  resultDot: '.result',
  resultVar: '_RESULT"',
  burnIn: 'e2e-burn-in',
  burnInTargets: 'burn-in-targets',
  burnInCount: 'burn-in-count',
  repeatEach: '--repeat-each',
  testE2e: 'test:e2e',
  playwrightTest: 'playwright test',
  pnpmTestE2e: 'pnpm test:e2e',
  testCoverage: 'test:coverage',
  vitestRunCoverage: 'vitest run --coverage',
  vitest: 'vitest',
  coverageFlag: '--coverage',
  stryker: 'stryker',
  lhci: 'lhci',
  lighthouse: 'lighthouse',
  gitleaks: 'gitleaks',
  auditCi: 'audit:ci',
  pnpmAudit: 'pnpm audit',
  objectFreeze: 'Object.freeze',
  auto: 'auto',
  target: 'target',
  threshold: 'threshold',
  informational: 'informational',
  higherStricter: 'higher-stricter',
  lowerStricter: 'lower-stricter',
})

const GATE_FILES = Object.freeze([
  'quality/gates.json',
  'codecov.yml',
  'vite.config.ts',
  'stryker.config.mjs',
  'package.json',
  'scripts/check-gate-ratchet.mjs',
  'scripts/check-gate-ratchet.test.mjs',
])

const SOURCE_SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'])

const GATE_STEP_KINDS = Object.freeze([
  'burn-in',
  'e2e',
  'coverage',
  'stryker',
  'lighthouse',
  'gitleaks',
  'audit',
])

/** @type {{ path: string[], dir: NEEDLES.higherStricter | 'lower-stricter', label: string }[]} */
const GATES_NUMERIC = [
  {
    path: ['coverage', 'statements'],
    dir: NEEDLES.higherStricter,
    label: 'coverage.statements',
  },
  {
    path: ['coverage', 'branches'],
    dir: NEEDLES.higherStricter,
    label: 'coverage.branches',
  },
  {
    path: ['coverage', 'functions'],
    dir: NEEDLES.higherStricter,
    label: 'coverage.functions',
  },
  {
    path: ['coverage', 'lines'],
    dir: NEEDLES.higherStricter,
    label: 'coverage.lines',
  },
  {
    path: ['coverage', 'patch'],
    dir: NEEDLES.higherStricter,
    label: 'coverage.patch',
  },
  {
    path: ['stryker', 'thresholds', 'high'],
    dir: NEEDLES.higherStricter,
    label: 'stryker.thresholds.high',
  },
  {
    path: ['stryker', 'thresholds', 'low'],
    dir: NEEDLES.higherStricter,
    label: 'stryker.thresholds.low',
  },
  {
    path: ['stryker', 'thresholds', 'break'],
    dir: NEEDLES.higherStricter,
    label: 'stryker.thresholds.break',
  },
  {
    path: ['stryker', 'diffThresholds', 'high'],
    dir: NEEDLES.higherStricter,
    label: 'stryker.diffThresholds.high',
  },
  {
    path: ['stryker', 'diffThresholds', 'low'],
    dir: NEEDLES.higherStricter,
    label: 'stryker.diffThresholds.low',
  },
  {
    path: ['stryker', 'diffThresholds', 'break'],
    dir: NEEDLES.higherStricter,
    label: 'stryker.diffThresholds.break',
  },
  {
    path: ['lighthouse', 'numberOfRuns'],
    dir: NEEDLES.higherStricter,
    label: 'lighthouse.numberOfRuns',
  },
  {
    path: ['playwright', 'retries'],
    dir: NEEDLES.lowerStricter,
    label: 'playwright.retries',
  },
  {
    path: ['playwright', 'flakyRetries'],
    dir: NEEDLES.lowerStricter,
    label: 'playwright.flakyRetries',
  },
  {
    path: ['e2e', 'burnInDefault'],
    dir: NEEDLES.higherStricter,
    label: 'e2e.burnInDefault',
  },
  {
    path: ['mutation', 'disableBudget'],
    dir: NEEDLES.lowerStricter,
    label: 'mutation.disableBudget',
  },
  {
    path: ['openspecSpecs', 'softMaxLines'],
    dir: NEEDLES.lowerStricter,
    label: 'openspecSpecs.softMaxLines',
  },
  {
    path: ['openspecSpecs', 'hardMaxLines'],
    dir: NEEDLES.lowerStricter,
    label: 'openspecSpecs.hardMaxLines',
  },
]

export {
  STRYKER_DISABLE_PER_FILE_CAP,
  STRYKER_DISABLE_REASON_MIN,
  STRYKER_KEYWORD,
  DISABLE_KEYWORD,
  RESTORE_KEYWORD,
  NEXT_LINE_KEYWORD,
  DETECTOR_SCRIPT,
  RATCHET_SCRIPT,
  indexOfIgnoreCase,
  matchPrefixIgnoreCase,
  matchKeywordAt,
  countStrykerDisableMainStyle,
  findNextStrykerDirective,
  tryParseLegalNextLineDisable,
  lineContaining,
  collectStrykerDisableComments,
  classifyStrykerDisableLine,
  countStrykerDisable,
  isStrykerDetectorPath,
  skipWs,
} from './stryker-disable-detect.mjs'

import {
  STRYKER_DISABLE_PER_FILE_CAP,
  collectStrykerDisableComments,
  isStrykerDetectorPath,
} from './stryker-disable-detect.mjs'

/**
 * Strip `# ...` shell comments so `exit 1` in comments cannot spoof failOnNeeds.
 * @param {unknown} run
 */
export function stripShellComments(run) {
  const text = coerceText(run)
  const lines = text.split('\n')
  const out = []
  for (const line of lines) {
    const cleaned = line.endsWith('\r') ? line.slice(0, -1) : line
    const idx = cleaned.indexOf('#')
    out.push(idx === -1 ? cleaned : cleaned.slice(0, idx))
  }
  return out.join('\n')
}

export const QUOTE_SINGLE = "'"
export const QUOTE_DOUBLE = '"'

/**
 * @param {string} ch
 */
export function isWsChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/**
 * @param {unknown} value
 */
export function coerceText(value) {
  return value == null ? '' : String(value)
}

/**
 * @param {string} ch
 */
export function isQuoteChar(ch) {
  return ch === QUOTE_SINGLE || ch === QUOTE_DOUBLE
}

/**
 * Collect single-quoted or double-quoted string literals from a slice.
 * @param {string} block
 * @returns {string[]}
 */
export function extractQuotedStrings(block) {
  /** @type {string[]} */
  const out = []
  const s = String(block)
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (!isQuoteChar(c)) continue
    let j = i + 1
    while (j < s.length && s[j] !== c) j++
    out.push(s.slice(i + 1, j))
    i = j
  }
  return out
}

/**
 * Find `key` + (`:`|`=`) + `[` … `]` (flat arrays only) and return quoted strings.
 * Gate config files use flat string arrays; nested brackets are out of scope.
 * @param {string} text
 * @param {string} key
 * @returns {string[]}
 */
export function extractFirstKeyedArray(text, key) {
  const src = String(text)
  let from = 0
  while (from < src.length) {
    const keyAt = src.indexOf(key, from)
    if (keyAt === -1) return []
    let i = keyAt + key.length
    while (i < src.length && isWsChar(src[i])) i++
    if (src[i] !== ':' && src[i] !== '=') {
      from = keyAt + 1
      continue
    }
    i++
    while (i < src.length && isWsChar(src[i])) i++
    if (src[i] !== '[') {
      from = keyAt + 1
      continue
    }
    i++
    const start = i
    while (i < src.length) {
      const ch = src[i]
      if (isQuoteChar(ch)) {
        const q = ch
        i++
        while (i < src.length && src[i] !== q) i++
        i++
        continue
      }
      if (ch === ']') break
      i++
    }
    return extractQuotedStrings(src.slice(start, i))
  }
  return []
}

/**
 * @param {string} text
 * @param {string} exportName
 * @returns {string[]}
 */
export function parseExportedStringArray(text, exportName) {
  const src = coerceText(text)
  const needle = `export const ${exportName}`
  const at = src.indexOf(needle)
  if (at === -1) return []
  const freezeAt = src.indexOf(NEEDLES.objectFreeze, at)
  if (freezeAt === -1) return []
  const bracketAt = src.indexOf('[', freezeAt)
  if (bracketAt === -1) return []
  let i = bracketAt + 1
  const start = i
  while (i < src.length) {
    const ch = src[i]
    if (isQuoteChar(ch)) {
      const q = ch
      i++
      while (i < src.length && src[i] !== q) i++
      i++
      continue
    }
    if (ch === ']') break
    i++
  }
  return extractQuotedStrings(src.slice(start, i))
}

/**
 * @param {Record<string, string>} files
 * @param {string} rel
 */
export function getFile(files, rel) {
  return files[rel.replaceAll('\\', '/')]
}

import {
  extractPnpmLockPackageBlock,
  readPackageDepSpec,
} from '../dist/gates/compare-pin.js'
export { extractPnpmLockPackageBlock, readPackageDepSpec }

/**
 * True when `ch` can continue an identifier after a keyword match.
 * @param {string} ch
 */
export function isIdentContinue(ch) {
  if (ch >= 'a' && ch <= 'z') return true
  if (ch >= 'A' && ch <= 'Z') return true
  if (ch >= '0' && ch <= '9') return true
  return ch === '_' || ch === '$'
}

/**
 * Slice the first `coverage: { ... }` object literal (skips names like coverageExcludeGlobs).
 * @param {unknown} content
 * @returns {string}
 */
export function sliceCoverageConfigBlock(content) {
  const src = coerceText(content)
  let from = 0
  while (from < src.length) {
    const cov = src.indexOf(NEEDLES.coverage, from)
    if (cov === -1) return ''
    if (cov > 0 && isIdentContinue(src[cov - 1])) {
      from = cov + 1
      continue
    }
    let i = cov + NEEDLES.coverage.length
    if (i < src.length && isIdentContinue(src[i])) {
      from = cov + 1
      continue
    }
    while (i < src.length && isWsChar(src[i])) i++
    if (src[i] !== ':') {
      from = cov + 1
      continue
    }
    i++
    while (i < src.length && isWsChar(src[i])) i++
    if (src[i] !== '{') {
      from = cov + 1
      continue
    }
    let depth = 0
    const start = i
    for (; i < src.length; i++) {
      const ch = src[i]
      if (isQuoteChar(ch)) {
        const q = ch
        i++
        while (i < src.length && src[i] !== q) i++
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return src.slice(start, i + 1)
      }
    }
    return ''
  }
  return ''
}

/**
 * Coverage include from `coverage: { ... include: [...] }` (not test.include).
 * @param {unknown} content
 * @returns {string[]}
 */
export function extractCoverageIncludes(content) {
  const block = sliceCoverageConfigBlock(content)
  if (block === '') return []
  return extractFirstKeyedArray(block, NEEDLES.include)
}

/**
 * @param {unknown} content
 * @returns {string[]}
 */
export function extractCoverageExcludes(content) {
  const text = coerceText(content)
  const out = new Set()
  for (const p of extractFirstKeyedArray(text, NEEDLES.coverageExcludeGlobs)) {
    out.add(p)
  }
  const block = sliceCoverageConfigBlock(text)
  if (block !== '') {
    for (const p of extractFirstKeyedArray(block, NEEDLES.exclude)) {
      out.add(p)
    }
  }
  return [...out]
}

/**
 * Compact whitespace for simple flag probes.
 * @param {string} text
 */
export function compactWs(text) {
  let out = ''
  for (const ch of String(text)) {
    if (isWsChar(ch)) continue
    out += ch
  }
  return out
}

/**
 * @param {unknown} content
 * @returns {{
 *   mutate: string[],
 *   bang: string[],
 *   excludedMutations: string[],
 *   weakerFlags: string[],
 * }}
 */
export function extractStrykerGateBits(content) {
  const text = coerceText(content)
  const mutateEntries = extractFirstKeyedArray(text, NEEDLES.mutate)
  const bang = mutateEntries.filter((p) => p.startsWith(NEEDLES.bangPrefix))
  const mutate = mutateEntries.filter((p) => !p.startsWith(NEEDLES.bangPrefix))
  const excludedMutations = extractFirstKeyedArray(
    text,
    NEEDLES.excludedMutations,
  )
  /** @type {string[]} */
  const weakerFlags = []
  const compact = compactWs(text)
  if (compact.includes(NEEDLES.disableTypeChecksTrue)) {
    weakerFlags.push('disableTypeChecks')
  }
  if (compact.includes(NEEDLES.ignoreStaticFalse)) {
    weakerFlags.push('ignoreStatic:false')
  }
  if (
    compact.includes(NEEDLES.coverageAnalysisOffSingle) ||
    compact.includes(NEEDLES.coverageAnalysisOffDouble)
  ) {
    weakerFlags.push('coverageAnalysis:off')
  }
  if (
    compact.includes(NEEDLES.ignorersOpen) &&
    !compact.includes(NEEDLES.ignorersEmpty)
  ) {
    weakerFlags.push('ignorers')
  }
  return { mutate, bang, excludedMutations, weakerFlags }
}

/**
 * @param {number} base
 * @param {number} head
 * @param {'higher-stricter' | 'lower-stricter'} dir
 */
export function numberWeaker(base, head, dir) {
  if (typeof base !== 'number' || typeof head !== 'number') return false
  if (dir === NEEDLES.higherStricter) return head < base
  return head > base
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function parsePercentish(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const t = value.trim()
    if (t === NEEDLES.auto) return null
    if (t.length === 0) return null
    let body = t
    if (body.endsWith('%')) body = body.slice(0, -1)
    if (body.length === 0) return null
    let ok = true
    let dot = false
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (ch >= '0' && ch <= '9') continue
      if (ch === '.' && !dot) {
        dot = true
        continue
      }
      ok = false
      break
    }
    if (ok) return Number(body)
  }
  return null
}

/**
 * True for non-null plain objects (not arrays).
 * @param {unknown} x
 * @returns {x is Record<string, any>}
 */
export function isRecord(x) {
  return x != null && typeof x === 'object' && !Array.isArray(x)
}

/**
 * @param {unknown} obj
 * @param {string[]} pathKeys
 */
export function dig(obj, pathKeys) {
  let cur = obj
  for (const key of pathKeys) {
    if (!isRecord(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

/**
 * Index of `tool` + whitespace run + `ignore` (spaces/tabs/newlines), or -1.
 * @param {string} lower
 * @param {string} tool
 * @param {number} from
 */
export function indexOfToolIgnore(lower, tool, from) {
  const src = String(lower)
  let pos = from < 0 ? 0 : from
  while (pos < src.length) {
    const at = src.indexOf(tool, pos)
    if (at === -1) break
    let i = at + tool.length
    if (i < src.length && isWsChar(src[i])) {
      while (i < src.length && isWsChar(src[i])) i++
      if (src.startsWith('ignore', i)) return at
    }
    pos = at + 1
  }
  return -1
}

/**
 * Count coverage/type suppression comments (v8|istanbul|c8 ignore, blanket eslint-disable, @ts-ignore).
 * Whitespace between the tool name and `ignore` is required (spaces/tabs/newlines).
 * @param {string} text
 */
export function countIgnoreComments(text) {
  const s = String(text)
  const lower = s.toLowerCase()
  let count = 0
  let from = 0
  while (from < lower.length) {
    const v8 = indexOfToolIgnore(lower, 'v8', from)
    const istan = indexOfToolIgnore(lower, 'istanbul', from)
    const c8 = indexOfToolIgnore(lower, 'c8', from)
    const eslint = lower.indexOf('eslint-disable', from)
    const tsIgnore = lower.indexOf('@ts-ignore', from)
    const candidates = [v8, istan, c8, eslint, tsIgnore].filter((n) => n >= 0)
    if (candidates.length === 0) break
    const at = Math.min(...candidates)
    if (at === eslint) {
      const after = lower.slice(at + 'eslint-disable'.length)
      if (after.startsWith('-next-line')) {
        from = at + 1
        continue
      }
    }
    count++
    from = at + 1
  }
  return count
}

/**
 * @param {Record<string, string>} files
 * @returns {number}
 */
export function countLegalStrykerDisablesInTree(files) {
  let total = 0
  for (const p of listSourcePaths(files)) {
    if (isStrykerDetectorPath(p)) continue
    const raw = getFile(files, p)
    if (raw == null) continue
    total += collectStrykerDisableComments(coerceText(raw)).legal.length
  }
  return total
}

/**
 * @param {unknown} gates
 * @returns {number}
 */
export function readDisableBudget(gates) {
  const v = dig(gates, ['mutation', 'disableBudget'])
  return typeof v === 'number' ? v : 0
}

/**
 * @param {string} run
 */
export function isBurnInRun(run) {
  return (
    run.includes(NEEDLES.burnIn) ||
    run.includes(NEEDLES.burnInTargets) ||
    run.includes(NEEDLES.burnInCount) ||
    run.includes(NEEDLES.repeatEach)
  )
}

/**
 * @param {string} run
 * @param {string} blob
 */
export function isE2eStep(run, blob) {
  if (isBurnInRun(run)) return false
  return (
    blob.includes(NEEDLES.testE2e) ||
    blob.includes(NEEDLES.playwrightTest) ||
    blob.includes(NEEDLES.pnpmTestE2e)
  )
}

/**
 * @param {string} blob
 */
export function detectGateKindsFromBlob(run, blob) {
  /** @type {string[]} */
  const kinds = []
  if (isBurnInRun(run)) kinds.push('burn-in')
  if (isE2eStep(run, blob)) kinds.push('e2e')
  if (
    blob.includes(NEEDLES.testCoverage) ||
    blob.includes(NEEDLES.vitestRunCoverage) ||
    (blob.includes(NEEDLES.vitest) && blob.includes(NEEDLES.coverageFlag))
  ) {
    kinds.push('coverage')
  }
  if (blob.includes(NEEDLES.stryker)) kinds.push('stryker')
  if (blob.includes(NEEDLES.lhci) || blob.includes(NEEDLES.lighthouse)) {
    kinds.push('lighthouse')
  }
  if (blob.includes(NEEDLES.gitleaks)) kinds.push('gitleaks')
  if (blob.includes(NEEDLES.auditCi) || blob.includes(NEEDLES.pnpmAudit)) {
    kinds.push('audit')
  }
  return kinds
}

/**
 * @param {string} run
 */
export function runFailsOnNeeds(run) {
  const cleaned = stripShellComments(run)
  if (!cleaned.includes(NEEDLES.exit1)) return false
  if (
    cleaned.includes(NEEDLES.needsDot) &&
    cleaned.includes(NEEDLES.resultDot)
  ) {
    return true
  }
  if (cleaned.includes(NEEDLES.resultVar)) return true
  return false
}

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} head
 * @param {string} pathLabel
 * @param {(msg: string) => void} fail
 */
/**
 * @param {unknown} gates
 * @returns {Set<string>}
 */
export function temporaryExcludePathSet(gates) {
  const list = dig(isRecord(gates) ? gates : {}, [
    'mutation',
    'temporaryExcludes',
  ])
  const out = new Set()
  if (!Array.isArray(list)) return out
  for (const row of list) {
    if (isRecord(row) && typeof row.path === 'string') out.add(row.path)
  }
  return out
}

/**
 * Head diff thresholds must be ≥ matching nightly thresholds.
 * @param {Record<string, unknown>} head
 * @param {string} pathLabel
 * @param {(msg: string) => void} fail
 */
export function compareDiffVsNightly(head, pathLabel, fail) {
  for (const key of ['high', 'low', 'break']) {
    const nightly = dig(head, ['stryker', 'thresholds', key])
    const diff = dig(head, ['stryker', 'diffThresholds', key])
    if (
      typeof nightly === 'number' &&
      typeof diff === 'number' &&
      diff < nightly
    ) {
      fail(
        `${pathLabel} ${MSGS.diffBelowNightlyPrefix}${key}${MSGS.diffBelowNightlyMid}${key}: ${diff} < ${nightly}`,
      )
    }
  }
}

/**
 * temporaryExcludes paths: seed when base has no array; else head ⊆ base.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} head
 * @param {string} pathLabel
 * @param {(msg: string) => void} fail
 */
export function compareTemporaryExcludes(base, head, pathLabel, fail) {
  const bList = dig(base, ['mutation', 'temporaryExcludes'])
  const hList = dig(head, ['mutation', 'temporaryExcludes'])
  if (!Array.isArray(bList)) return
  if (!Array.isArray(hList)) {
    fail(`${pathLabel} mutation.temporaryExcludes removed`)
    return
  }
  const bPaths = temporaryExcludePathSet(base)
  for (const row of hList) {
    if (!isRecord(row) || typeof row.path !== 'string') continue
    if (!bPaths.has(row.path)) {
      fail(`${pathLabel} ${MSGS.tempExcludesGrewPrefix}${row.path}`)
    }
  }
}

export function compareGatesJson(base, head, pathLabel, fail) {
  for (const row of GATES_NUMERIC) {
    const b = dig(base, row.path)
    const h = dig(head, row.path)
    if (
      typeof b === 'number' &&
      numberWeaker(b, /** @type {number} */ (h), row.dir)
    ) {
      fail(`${pathLabel} ${row.label}: ${b} → ${h} (weaker)`)
    }
  }

  const bAssert = dig(base, ['lighthouse', 'assertions'])
  const hAssert = dig(head, ['lighthouse', 'assertions'])
  if (isRecord(bAssert)) {
    for (const k of Object.keys(bAssert)) {
      if (
        !isRecord(hAssert) ||
        !Object.prototype.hasOwnProperty.call(hAssert, k)
      ) {
        fail(`${pathLabel} lighthouse.assertions missing ${k}`)
      } else if (bAssert[k] === 'error' && hAssert[k] !== 'error') {
        fail(`${pathLabel} lighthouse.assertions.${k} no longer error`)
      }
    }
  }

  const bList = dig(base, ['e2e', 'flakySpecs'])
  const hList = dig(head, ['e2e', 'flakySpecs'])
  if (Array.isArray(bList) && Array.isArray(hList)) {
    for (const spec of hList) {
      if (!bList.includes(spec)) {
        fail(`${pathLabel} e2e.flakySpecs grew: ${spec}`)
      }
    }
  }

  const bJobs = dig(base, ['requiredCheckJobs'])
  const hJobs = dig(head, ['requiredCheckJobs'])
  if (Array.isArray(bJobs)) {
    if (!Array.isArray(hJobs)) {
      fail(`${pathLabel} requiredCheckJobs removed`)
    } else {
      for (const job of bJobs) {
        if (!hJobs.includes(job)) {
          fail(`${pathLabel} requiredCheckJobs missing ${job}`)
        }
      }
    }
  }

  const bBudgets = dig(base, ['lighthouse', 'budgets'])
  const hBudgets = dig(head, ['lighthouse', 'budgets'])
  if (!Array.isArray(bBudgets) || !Array.isArray(hBudgets)) return
  if (JSON.stringify(bBudgets) === JSON.stringify(hBudgets)) return
  for (const bb of bBudgets) {
    if (!isRecord(bb)) continue
    const pathName = bb.path
    const hb = hBudgets.find((x) => isRecord(x) && x.path === pathName)
    if (!hb) {
      fail(`${pathLabel} lighthouse.budgets path missing: ${pathName}`)
      continue
    }
    const sizes = bb.resourceSizes
    if (!Array.isArray(sizes)) continue
    const headSizes = hb.resourceSizes
    for (const rs of sizes) {
      if (!isRecord(rs)) continue
      const hrs = Array.isArray(headSizes)
        ? headSizes.find(
            (x) => isRecord(x) && x.resourceType === rs.resourceType,
          )
        : undefined
      if (!isRecord(hrs)) {
        fail(
          `${pathLabel} lighthouse budget resourceType missing: ${rs.resourceType}`,
        )
      } else if (
        typeof rs.budget === 'number' &&
        numberWeaker(rs.budget, hrs.budget, NEEDLES.lowerStricter)
      ) {
        fail(
          `${pathLabel} lighthouse budget ${rs.resourceType}: ${rs.budget} → ${hrs.budget}`,
        )
      }
    }
  }
}

/**
 * @param {unknown} baseRaw
 * @param {unknown} headRaw
 * @param {(msg: string) => void} fail
 */
export function compareCodecov(baseRaw, headRaw, fail) {
  const base = isRecord(baseRaw) ? baseRaw : {}
  const head = isRecord(headRaw) ? headRaw : {}

  /**
   * @param {unknown} bNode
   * @param {unknown} hNode
   * @param {string} label
   */
  const walkStatus = (bNode, hNode, label) => {
    if (!isRecord(bNode)) return
    if (!isRecord(hNode)) {
      fail(`codecov.yml ${label} removed`)
      return
    }
    for (const key of Object.keys(bNode)) {
      if (!Object.prototype.hasOwnProperty.call(hNode, key)) {
        fail(`codecov.yml ${label}.${key} removed`)
        continue
      }
      const bv = bNode[key]
      const hv = hNode[key]
      if (!isRecord(bv)) continue
      const isLeaf =
        NEEDLES.target in bv ||
        NEEDLES.threshold in bv ||
        NEEDLES.informational in bv
      if (!isLeaf) {
        walkStatus(bv, hv, `${label}.${key}`)
        continue
      }
      const hvObj = isRecord(hv) ? hv : {}
      const bt = parsePercentish(bv.target)
      const ht = parsePercentish(hvObj.target)
      if (bt !== null && ht !== null && ht < bt) {
        fail(
          `codecov.yml ${label}.${key}.target: ${bv.target} → ${hvObj.target}`,
        )
      }
      const bth = parsePercentish(bv.threshold)
      const hth = parsePercentish(hvObj.threshold)
      if (bth !== null && hth !== null && hth > bth) {
        fail(
          `codecov.yml ${label}.${key}.threshold: ${bv.threshold} → ${hvObj.threshold}`,
        )
      }
      if (bv.informational !== true && hvObj.informational === true) {
        fail(`codecov.yml ${label}.${key} informational turned on`)
      }
    }
  }

  const bCoverage = isRecord(base.coverage) ? base.coverage : null
  const hCoverage = isRecord(head.coverage) ? head.coverage : null
  walkStatus(
    bCoverage ? bCoverage.status : undefined,
    hCoverage ? hCoverage.status : undefined,
    'coverage.status',
  )

  const bBundle = isRecord(base.bundle_analysis) ? base.bundle_analysis : null
  const hBundle = isRecord(head.bundle_analysis) ? head.bundle_analysis : null
  if (
    bBundle &&
    bBundle.status !== NEEDLES.informational &&
    hBundle &&
    hBundle.status === NEEDLES.informational
  ) {
    fail('codecov.yml bundle_analysis informational turned on')
  }

  const bFlags = isRecord(base.flags) ? base.flags : {}
  const hFlags = isRecord(head.flags) ? head.flags : {}
  for (const flag of Object.keys(bFlags)) {
    if (!Object.prototype.hasOwnProperty.call(hFlags, flag)) {
      fail(`codecov.yml flags.${flag} removed`)
      continue
    }
    const bFlagObj = bFlags[flag]
    const hFlagObj = hFlags[flag]
    const bPaths = isRecord(bFlagObj) ? bFlagObj.paths : undefined
    const hPaths = isRecord(hFlagObj) ? hFlagObj.paths : undefined
    if (!Array.isArray(bPaths)) continue
    const headPaths = Array.isArray(hPaths) ? hPaths : []
    for (const p of bPaths) {
      if (!codecovFlagPathCovered(String(p), headPaths.map(String))) {
        fail(`codecov.yml flags.${flag}.paths removed ${p}`)
      }
    }
  }

  const bIgnore = new Set(Array.isArray(base.ignore) ? base.ignore : [])
  const hIgnore = new Set(Array.isArray(head.ignore) ? head.ignore : [])
  for (const p of hIgnore) {
    if (!bIgnore.has(p)) fail(`codecov.yml ignore added ${p}`)
  }

  const bCompRoot = isRecord(base.component_management)
    ? base.component_management
    : null
  const hCompRoot = isRecord(head.component_management)
    ? head.component_management
    : null
  const bComp = bCompRoot ? bCompRoot.individual_components : undefined
  const hComp = hCompRoot ? hCompRoot.individual_components : undefined
  if (!Array.isArray(bComp)) return
  if (!Array.isArray(hComp)) {
    fail('codecov.yml component_management.individual_components removed')
    return
  }
  for (const c of bComp) {
    if (!isRecord(c)) continue
    const id = c.component_id
    if (!id) continue
    const stillThere = hComp.some((x) => isRecord(x) && x.component_id === id)
    if (!stillThere) {
      fail(`codecov.yml component ${id} removed`)
    }
  }
}

/**
 * @param {unknown} step
 * @returns {Set<string>}
 */
export function classifyGateSteps(step) {
  const stepObj = isRecord(step) ? step : {}
  const name = String(coerceText(stepObj.name))
  const run = String(coerceText(stepObj.run)).toLowerCase()
  const uses = String(coerceText(stepObj.uses))
  const blob = `${name}\n${run}\n${uses}`.toLowerCase()
  return new Set(detectGateKindsFromBlob(run, blob))
}

/**
 * @param {unknown} workflow
 * @returns {Map<string, { kinds: Set<string>, needs: string[], continueOnErrorKinds: Set<string>, failOnNeeds: boolean }>}
 */
export function analyzeWorkflowJobs(workflow) {
  const wf = isRecord(workflow) ? workflow : {}
  const jobs = wf.jobs
  /** @type {Map<string, { kinds: Set<string>, needs: string[], continueOnErrorKinds: Set<string>, failOnNeeds: boolean }>} */
  const out = new Map()
  if (!isRecord(jobs)) return out
  for (const [name, jobRaw] of Object.entries(jobs)) {
    const job = isRecord(jobRaw) ? jobRaw : {}
    const kinds = new Set()
    const continueOnErrorKinds = new Set()
    const needsRaw = job.needs
    const needs = Array.isArray(needsRaw)
      ? needsRaw.map(String)
      : needsRaw
        ? [String(needsRaw)]
        : []
    let failOnNeeds = false
    const steps = Array.isArray(job.steps) ? job.steps : []
    for (const step of steps) {
      const stepKinds = classifyGateSteps(step)
      for (const k of stepKinds) kinds.add(k)
      const stepObj = isRecord(step) ? step : {}
      if (stepObj['continue-on-error'] === true) {
        for (const k of stepKinds) continueOnErrorKinds.add(k)
      }
      const runText = String(coerceText(stepObj.run))
      const cleaned = stripShellComments(runText)
      const hasExit1 = cleaned.includes(NEEDLES.exit1)
      const hasNeedsResult =
        cleaned.includes(NEEDLES.needsDot) &&
        cleaned.includes(NEEDLES.resultDot)
      const hasResultVar = cleaned.includes(NEEDLES.resultVar)
      if (hasExit1 && hasNeedsResult) failOnNeeds = true
      if (hasExit1 && hasResultVar && needs.length > 0) failOnNeeds = true
    }
    if (job['continue-on-error'] === true) {
      for (const k of kinds) continueOnErrorKinds.add(k)
    }
    out.set(name, { kinds, needs, continueOnErrorKinds, failOnNeeds })
  }
  return out
}

/**
 * @param {Map<string, { kinds: Set<string>, needs: string[], continueOnErrorKinds: Set<string>, failOnNeeds: boolean }>} jobs
 * @param {string} jobName
 * @returns {Set<string>}
 */
export function coveredKindsForJob(jobs, jobName) {
  const info = jobs.get(jobName)
  /** @type {Set<string>} */
  const kinds = new Set()
  if (!info) return kinds
  for (const k of info.kinds) kinds.add(k)
  for (const dep of info.needs) {
    const d = jobs.get(dep)
    if (!d) continue
    for (const k of d.kinds) kinds.add(k)
  }
  return kinds
}

/**
 * @param {Map<string, { kinds: Set<string>, needs: string[], continueOnErrorKinds: Set<string>, failOnNeeds: boolean }>} jobs
 * @param {string} kind
 */
export function jobsProvidingKind(jobs, kind) {
  /** @type {string[]} */
  const names = []
  for (const [name, info] of jobs) {
    if (info.kinds.has(kind)) names.push(name)
  }
  return names
}

/**
 * @param {string} p
 */
export function isWorkflowYmlPath(p) {
  return p.startsWith('.github/workflows/') && p.endsWith('.yml')
}

/**
 * @param {Record<string, string>} baseFiles
 * @param {Record<string, string>} headFiles
 * @param {string[]} requiredJobs
 * @param {(msg: string) => void} fail
 */
export function compareRequiredJobGates(
  baseFiles,
  headFiles,
  requiredJobs,
  fail,
) {
  const workflowPaths = new Set([
    ...Object.keys(baseFiles).filter(isWorkflowYmlPath),
    ...Object.keys(headFiles).filter(isWorkflowYmlPath),
  ])

  /** @type {Map<string, { kinds: Set<string>, needs: string[], continueOnErrorKinds: Set<string>, failOnNeeds: boolean }>} */
  const baseJobs = new Map()
  /** @type {Map<string, { kinds: Set<string>, needs: string[], continueOnErrorKinds: Set<string>, failOnNeeds: boolean }>} */
  const headJobs = new Map()

  for (const wp of workflowPaths) {
    const b = getFile(baseFiles, wp)
    const h = getFile(headFiles, wp)
    if (b !== undefined) {
      for (const [n, info] of analyzeWorkflowJobs(parseYaml(b))) {
        baseJobs.set(n, info)
      }
    }
    if (h !== undefined) {
      for (const [n, info] of analyzeWorkflowJobs(parseYaml(h))) {
        headJobs.set(n, info)
      }
    }
  }

  for (const req of requiredJobs) {
    const bJob = baseJobs.get(req)
    if (!bJob) continue
    const hJob = headJobs.get(req)
    if (!hJob) {
      fail(
        `${MSGS.requiredJobRemovedPrefix}${req}${MSGS.requiredJobRemovedSuffix}`,
      )
      continue
    }
    const baseCovered = coveredKindsForJob(baseJobs, req)
    for (const kind of GATE_STEP_KINDS) {
      if (!baseCovered.has(kind)) continue
      if (hJob.continueOnErrorKinds.has(kind)) {
        fail(`required job ${req} gate ${kind} has continue-on-error`)
      }
      if (hJob.kinds.has(kind)) continue
      const providers = jobsProvidingKind(headJobs, kind).filter(
        (n) => n !== req,
      )
      const neededOk = providers.some((p) => {
        const pJob = headJobs.get(p)
        // providers come from headJobs keys, so pJob is always defined.
        if (pJob.continueOnErrorKinds.has(kind)) return false
        return hJob.needs.includes(p) && hJob.failOnNeeds
      })
      if (!neededOk) {
        fail(
          `${MSGS.requiredJobRemovedPrefix}${req}${MSGS.lostGateMid}${kind}${MSGS.lostGateSuffix}`,
        )
      }
    }
  }
}

/**
 * @param {Record<string, string>} files
 * @returns {string[]}
 */
export function listSourcePaths(files) {
  return Object.keys(files).filter((p) => {
    const ext = path.posix.extname(p)
    if (!SOURCE_SCAN_EXT.has(ext)) return false
    if (p.includes('node_modules/')) return false
    if (p.startsWith('openspec/')) return false
    if (p.includes('.test.')) return false
    return true
  })
}

/**
 * Compare two file maps (path → utf8 content).
 * @param {Record<string, string>} baseFiles
 * @param {Record<string, string>} headFiles
 * @param {{ prBody?: string, branch?: string }} [opts]
 * @returns {{ ok: boolean, violations: { ruleId: string, message: string }[] }}
 */
export function compareGateTrees(baseFiles, headFiles, opts = {}) {
  /** @type {{ ruleId: string, message: string }[] } */
  const violations = []
  const fail = (ruleId, message) => {
    violations.push({ ruleId, message })
  }
  for (const gf of GATE_FILES) {
    if (
      getFile(baseFiles, gf) !== undefined &&
      getFile(headFiles, gf) === undefined
    ) {
      fail('gate-file-gone', `${MSGS.gateFileMissingPrefix}${gf}`)
    }
  }

  try {
    const bRaw = getFile(baseFiles, 'quality/gates.json')
    const hRaw = getFile(headFiles, 'quality/gates.json')
    if (bRaw !== undefined && hRaw !== undefined) {
      const bGates = JSON.parse(bRaw)
      const hGates = JSON.parse(hRaw)
      compareGatesJson(bGates, hGates, 'quality/gates.json', (m) =>
        fail('gates-json-weaker', m),
      )
      compareDiffVsNightly(hGates, 'quality/gates.json', (m) =>
        fail('diff-below-nightly', m),
      )
      compareTemporaryExcludes(bGates, hGates, 'quality/gates.json', (m) =>
        fail('temporary-excludes-grew', m),
      )
      compareAgentRuleBudgets(
        bGates,
        hGates,
        headFiles,
        'quality/gates.json',
        (m) => fail('gates-json-weaker', m),
        { getFile },
      )
      checkAgentRuleBudgetsAbsolute(headFiles, hGates, fail, { getFile })
    } else if (bRaw !== undefined && hRaw === undefined) {
      fail('gate-file-gone', MSGS.gatesJsonDeleted)
    }
  } catch (e) {
    fail(
      'gates-json-weaker',
      `${MSGS.parseGatesPrefix}${e instanceof Error ? e.message : e}`,
    )
  }

  try {
    const bRaw = getFile(baseFiles, 'codecov.yml')
    const hRaw = getFile(headFiles, 'codecov.yml')
    if (bRaw !== undefined && hRaw !== undefined) {
      compareCodecov(parseYaml(bRaw), parseYaml(hRaw), (m) =>
        fail('codecov-weaker', m),
      )
    } else if (bRaw !== undefined && hRaw === undefined) {
      fail('gate-file-gone', MSGS.codecovDeleted)
    }
  } catch (e) {
    fail(
      'codecov-weaker',
      `${MSGS.parseCodecovPrefix}${e instanceof Error ? e.message : e}`,
    )
  }

  compareScriptScopeGates(baseFiles, headFiles, fail, {
    extractCoverageIncludes,
    extractCoverageExcludes,
    extractStrykerGateBits,
    coerceText,
    getFile,
    msgs: MSGS,
  })

  {
    const bS = extractStrykerGateBits(
      coerceText(getFile(baseFiles, 'stryker.config.mjs')),
    )
    const hS = extractStrykerGateBits(
      coerceText(getFile(headFiles, 'stryker.config.mjs')),
    )
    for (const p of hS.excludedMutations) {
      if (!bS.excludedMutations.includes(p)) {
        fail('stryker-weaker', `${MSGS.excludedMutationsPrefix}${p}`)
      }
    }
    for (const f of hS.weakerFlags) {
      if (!bS.weakerFlags.includes(f)) {
        fail('stryker-weaker', `${MSGS.strykerWeakerPrefix}${f}`)
      }
    }
  }

  try {
    const bPkgRaw = getFile(baseFiles, 'package.json')
    const hPkgRaw = getFile(headFiles, 'package.json')
    const bPkg = JSON.parse(bPkgRaw == null ? '{}' : bPkgRaw)
    const hPkg = JSON.parse(hPkgRaw == null ? '{}' : hPkgRaw)
    const bPnpm = isRecord(bPkg.pnpm) ? bPkg.pnpm : {}
    const hPnpm = isRecord(hPkg.pnpm) ? hPkg.pnpm : {}
    const bPatched = isRecord(bPnpm.patchedDependencies)
      ? bPnpm.patchedDependencies
      : {}
    const hPatched = isRecord(hPnpm.patchedDependencies)
      ? hPnpm.patchedDependencies
      : {}
    for (const k of Object.keys(hPatched)) {
      if (!Object.prototype.hasOwnProperty.call(bPatched, k)) {
        fail('patched-deps-grown', `${MSGS.patchedGrewPrefix}${k}`)
      }
    }
  } catch (e) {
    fail(
      'patched-deps-grown',
      `${MSGS.packageParsePrefix}${e instanceof Error ? e.message : e}`,
    )
  }
  {
    const paths = new Set([
      ...listSourcePaths(baseFiles),
      ...listSourcePaths(headFiles),
    ])
    let headLegalTotal = 0
    for (const p of paths) {
      if (isStrykerDetectorPath(p)) continue
      const bRaw = getFile(baseFiles, p)
      const hRaw = getFile(headFiles, p)
      const b = coerceText(bRaw)
      const h = coerceText(hRaw)
      const bDis = collectStrykerDisableComments(b)
      const hDis = collectStrykerDisableComments(h)
      headLegalTotal += hDis.legal.length
      if (hDis.legal.length > STRYKER_DISABLE_PER_FILE_CAP) {
        fail(
          'stryker-disable-per-file',
          `${MSGS.strykerDisablePerFilePrefix}${p}`,
        )
      }
      if (b === h) continue
      const bIgnores = countIgnoreComments(b)
      const hIgnores = countIgnoreComments(h)
      if (hIgnores > bIgnores) {
        fail('ignore-comment-added', `${MSGS.ignoreCommentPrefix}${p}`)
      }
      if (hDis.illegal.length > bDis.illegal.length) {
        fail('stryker-disable-added', `${MSGS.strykerDisablePrefix}${p}`)
      }
    }
    try {
      const hGatesRaw = getFile(headFiles, 'quality/gates.json')
      const hGates = JSON.parse(hGatesRaw == null ? '{}' : hGatesRaw)
      const ceiling = readDisableBudget(hGates)
      if (headLegalTotal > ceiling) {
        fail(
          'stryker-disable-budget',
          `${MSGS.strykerDisableBudgetPrefix}${headLegalTotal}${MSGS.strykerDisableBudgetMid}${ceiling}`,
        )
      }
    } catch (e) {
      fail(
        'stryker-disable-budget',
        `${MSGS.parseGatesPrefix}${e instanceof Error ? e.message : e}`,
      )
    }
  }

  try {
    const bGatesRaw = getFile(baseFiles, 'quality/gates.json')
    const bGates = JSON.parse(bGatesRaw == null ? '{}' : bGatesRaw)
    const required = Array.isArray(bGates.requiredCheckJobs)
      ? bGates.requiredCheckJobs.map(String)
      : []
    compareRequiredJobGates(baseFiles, headFiles, required, (m) =>
      fail('required-job-step-moved', m),
    )
  } catch (e) {
    fail(
      'required-job-step-moved',
      `${MSGS.requiredJobFailedPrefix}${e instanceof Error ? e.message : e}`,
    )
  }

  compareTestWeakening(baseFiles, headFiles, fail)
  compareItemCriteria(
    baseFiles,
    headFiles,
    { prBody: opts.prBody, branch: opts.branch },
    fail,
  )

  if (hasOwnerApprovedScopeChange(opts.prBody ?? '')) {
    const kept = violations.filter(
      (v) => !OWNER_WAIVABLE_RULE_IDS.includes(v.ruleId),
    )
    return { ok: kept.length === 0, violations: kept }
  }

  return { ok: violations.length === 0, violations }
}
/**
 * @param {string} root
 * @returns {Record<string, string>}
 */
export function readTreeFromDir(root) {
  /** @type {Record<string, string>} */
  const files = {}
  const walk = (dir, relBase = '') => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (
        ent.name === 'node_modules' ||
        ent.name === '.git' ||
        ent.name === 'dist'
      ) {
        continue
      }
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(abs, rel)
      else if (ent.isFile()) {
        try {
          files[rel.replaceAll('\\', '/')] = fs.readFileSync(abs, 'utf8')
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  walk(root)
  return files
}

/**
 * @param {string} cwd
 * @param {string} ref
 * @param {string[]} [paths]
 * @returns {Record<string, string>}
 */
export function readTreeFromGitRef(cwd, ref, paths) {
  const env = stripGitKeys({ ...process.env })
  /** @type {Record<string, string>} */
  const files = {}
  let list = paths
  if (!list) {
    const ls = spawnSync('git', ['ls-tree', '-r', '--name-only', ref], {
      cwd,
      encoding: 'utf8',
      env,
    })
    if (ls.status !== 0) {
      throw new Error(
        `git ls-tree failed for ${ref}: ${ls.stderr || ls.stdout}`,
      )
    }
    list = ls.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  for (const p of list) {
    const show = spawnSync('git', ['show', `${ref}:${p}`], {
      cwd,
      encoding: 'utf8',
      env,
      maxBuffer: 20 * 1024 * 1024,
    })
    if (show.status !== 0) continue
    files[p.replaceAll('\\', '/')] = show.stdout
  }
  return files
}

/**
 * Resolve base ref for local pr-policy: GATE_RATCHET_BASE → origin/main → main.
 * @param {{
 *   root: string,
 *   env?: NodeJS.ProcessEnv,
 *   git?: (args: string[], cwd: string) => { status: number | null, stdout: string, stderr: string },
 * }} opts
 * @returns {string | null}
 */
export function resolvePrPolicyBaseRef(opts) {
  const env = opts.env == null ? process.env : opts.env
  const fromEnv = String(coerceText(env.GATE_RATCHET_BASE)).trim()
  if (fromEnv) return fromEnv
  const git =
    opts.git == null
      ? (args, cwd) =>
          spawnSync('git', args, {
            cwd,
            encoding: 'utf8',
            env: stripGitKeys({ ...process.env }),
          })
      : opts.git
  const origin = git(['rev-parse', 'origin/main'], opts.root)
  if ((origin.status == null ? 1 : origin.status) === 0) {
    return String(origin.stdout).trim()
  }
  const main = git(['rev-parse', 'main'], opts.root)
  if ((main.status == null ? 1 : main.status) === 0) {
    return String(main.stdout).trim()
  }
  return null
}

/**
 * Local optional check: compare HEAD to base ref via the same CLI path as CI.
 * @param {{
 *   root?: string,
 *   env?: NodeJS.ProcessEnv,
 *   git?: (args: string[], cwd: string) => { status: number | null, stdout: string, stderr: string },
 *   runCli?: typeof runGateRatchetCli,
 *   log?: (msg: string) => void,
 *   error?: (msg: string) => void,
 * }} [opts]
 * @returns {number} exit code
 */
export function runPrPolicyCheck(opts = {}) {
  const root =
    opts.root == null
      ? resolveRepoRoot()
      : opts.root
  const log = opts.log == null ? console.log : opts.log
  const error = opts.error == null ? console.error : opts.error
  const runCli = opts.runCli == null ? runGateRatchetCli : opts.runCli
  const git =
    opts.git == null
      ? (args, cwd) =>
          spawnSync('git', args, {
            cwd,
            encoding: 'utf8',
            env: stripGitKeys({ ...process.env }),
          })
      : opts.git
  const base = resolvePrPolicyBaseRef({ root, env: opts.env, git })
  if (!base) {
    log('pr-policy: skip (no origin/main or GATE_RATCHET_BASE)')
    return 0
  }
  const head = git(['rev-parse', 'HEAD'], root)
  if ((head.status == null ? 1 : head.status) !== 0) {
    error('pr-policy: cannot resolve HEAD')
    return 1
  }
  return runCli([
    '--cwd',
    root,
    '--base-ref',
    base,
    '--head-ref',
    String(head.stdout).trim(),
  ])
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (
      a === '--base-ref' ||
      a === '--head-ref' ||
      a === '--base-dir' ||
      a === '--head-dir' ||
      a === '--cwd' ||
      a === '--pr-body' ||
      a === '--pr-body-env' ||
      a === '--branch'
    ) {
      const next = argv[i + 1]
      out[a.slice(2)] = coerceText(next)
      i++
    }
  }
  return out
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string }} [opts]
 */
export function runGateRatchetCli(argv = process.argv.slice(2), opts = {}) {
  const args = parseArgs(argv)
  const cwd = args.cwd || opts.cwd || process.cwd()
  let baseFiles
  let headFiles
  if (args['base-dir'] && args['head-dir']) {
    baseFiles = readTreeFromDir(path.resolve(cwd, args['base-dir']))
    headFiles = readTreeFromDir(path.resolve(cwd, args['head-dir']))
  } else if (args['base-ref'] && args['head-ref']) {
    baseFiles = readTreeFromGitRef(cwd, args['base-ref'])
    headFiles = readTreeFromGitRef(cwd, args['head-ref'])
  } else {
    console.error(
      'Usage: check-gate-ratchet.mjs --base-ref <sha> --head-ref <sha> | --base-dir <dir> --head-dir <dir>',
    )
    return 2
  }
  /** Explicit `--pr-body` (including empty) wins over env. */
  const hasPrBodyFlag = Object.prototype.hasOwnProperty.call(args, 'pr-body')
  let prBody = ''
  if (hasPrBodyFlag) {
    prBody = args['pr-body']
  } else if (args['pr-body-env']) {
    prBody = process.env[args['pr-body-env']] ?? ''
  } else if (process.env.PR_POLICY_BODY != null) {
    prBody = process.env.PR_POLICY_BODY
  } else {
    // Local pre-PR: collect Owner-approved lines from branch commits.
    const baseRef = args['base-ref'] || 'origin/main'
    const headRef = args['head-ref'] || 'HEAD'
    const log = spawnSync(
      'git',
      ['log', `${baseRef}..${headRef}`, '--format=%B'],
      {
        cwd,
        encoding: 'utf8',
        env: stripGitKeys({ ...process.env }),
      },
    )
    if ((log.status ?? 1) === 0) prBody = coerceText(log.stdout)
  }
  const hasBranchFlag = Object.prototype.hasOwnProperty.call(args, 'branch')
  const branch = hasBranchFlag
    ? args.branch
    : process.env.PR_POLICY_BRANCH || process.env.GITHUB_HEAD_REF || ''
  const result = compareGateTrees(baseFiles, headFiles, { prBody, branch })
  if (result.ok) {
    console.log('Gate ratchet: OK (head not weaker than base)')
    return 0
  }
  console.error('Gate ratchet: FAIL')
  for (const v of result.violations) {
    console.error(`- [${v.ruleId}] ${v.message}`)
  }
  return 1
}
