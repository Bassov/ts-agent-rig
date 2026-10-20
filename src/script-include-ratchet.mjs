/**
 * Coverage-include / Codecov path subsumption for scripts globs (pr-policy).
 */
import { classifyMutationFile } from './mutation-scope.mjs'

/**
 * ≤10 lines, sole relative sibling `.mjs` import, and an invoke (`(`) of that import.
 * @param {unknown} content
 */
export function isThinDelegatingCli(content) {
  const text = String(content ?? '')
  if (!text) return false
  const lines = text.split('\n')
  if (lines.length > 10) return false
  /** @type {string | null} */
  let fromPath = null
  for (const line of lines) {
    const fromIdx = line.indexOf(' from ')
    if (fromIdx === -1) continue
    const after = line.slice(fromIdx + ' from '.length).trim()
    const quote = after[0]
    if (quote !== "'" && quote !== '"') return false
    const end = after.indexOf(quote, 1)
    if (end === -1) return false
    const spec = after.slice(1, end)
    if (fromPath !== null) return false
    fromPath = spec
  }
  if (fromPath === null) return false
  if (!fromPath.startsWith('./')) return false
  if (!fromPath.endsWith('.mjs')) return false
  if (!text.includes('(')) return false
  return true
}

const SCRIPT_INCLUDE_GLOBS = Object.freeze(['scripts/**/*.mjs', 'scripts/**'])

function normalizeScriptInclude(entry) {
  return entry === 'scripts/**' ? 'scripts/**/*.mjs' : entry
}

/**
 * @param {Iterable<string>} includes
 */
export function hasScriptsCoverageInclude(includes) {
  for (const g of includes) {
    if (SCRIPT_INCLUDE_GLOBS.includes(g)) return true
  }
  return false
}

/**
 * @param {string} baseEntry
 * @param {Iterable<string>} headIncludes
 */
export function coverageIncludeCovered(baseEntry, headIncludes) {
  const head = [...headIncludes].map(normalizeScriptInclude)
  const base = normalizeScriptInclude(baseEntry)
  if (head.includes(base)) return true
  if (base.includes('*')) return false
  for (const h of head) {
    if (h.includes('*') && classifyMutationFile(base, [h]) === 'in-scope') {
      return true
    }
  }
  return false
}

/**
 * @param {string} pattern bang or plain exclude path/glob
 * @param {Record<string, string>} headFiles
 * @param {Iterable<string>} headIncludes
 */
export function isAllowedScriptPairedExclude(pattern, headFiles, headIncludes) {
  if (!hasScriptsCoverageInclude(headIncludes)) return false
  const raw = pattern.startsWith('!') ? pattern.slice(1) : pattern
  if (raw === 'scripts/**/*.test.mjs') return true
  if (!raw.startsWith('scripts/')) return false
  if (raw.includes('*')) return false
  const content = headFiles[raw]
  if (content == null) return false
  return isThinDelegatingCli(content)
}

/**
 * @param {string} basePath
 * @param {Iterable<string>} headPaths
 */
export function codecovFlagPathCovered(basePath, headPaths) {
  for (const h of headPaths) {
    if (basePath === h) return true
    const prefix = h.endsWith('/') ? h : `${h}/`
    if (basePath.startsWith(prefix)) return true
  }
  return false
}

/**
 * @param {Record<string, string | undefined>} baseFiles
 * @param {Record<string, string | undefined>} headFiles
 * @param {(ruleId: string, message: string) => void} fail
 * @param {{
 *   extractCoverageIncludes: (c: unknown) => string[],
 *   extractCoverageExcludes: (c: unknown) => string[],
 *   extractStrykerGateBits: (c: unknown) => { mutate?: string[], bang: string[] },
 *   coerceText: (c: unknown) => string,
 *   getFile: (files: Record<string, string | undefined>, path: string) => string | undefined,
 *   msgs: {
 *     includeRemovedPrefix: string,
 *     mutateIncludeRemovedPrefix: string,
 *     excludeAddedPrefix: string,
 *     bangAddedPrefix: string,
 *   },
 * }} deps
 */
export function compareScriptScopeGates(baseFiles, headFiles, fail, deps) {
  const bVite = deps.getFile(baseFiles, 'vite.config.ts')
  const hVite = deps.getFile(headFiles, 'vite.config.ts')
  const bInc = new Set(deps.extractCoverageIncludes(deps.coerceText(bVite)))
  const hInc = new Set(deps.extractCoverageIncludes(deps.coerceText(hVite)))
  if (hasScriptsCoverageInclude(bInc) && !hasScriptsCoverageInclude(hInc)) {
    fail('include-removed', `${deps.msgs.includeRemovedPrefix}scripts/**/*.mjs`)
  }
  for (const p of bInc) {
    if (!coverageIncludeCovered(p, hInc)) {
      fail('include-removed', `${deps.msgs.includeRemovedPrefix}${p}`)
    }
  }
  const bExc = new Set(deps.extractCoverageExcludes(deps.coerceText(bVite)))
  const hExc = new Set(deps.extractCoverageExcludes(deps.coerceText(hVite)))
  for (const p of hExc) {
    if (bExc.has(p)) continue
    if (isAllowedScriptPairedExclude(p, headFiles, hInc)) continue
    fail('exclude-added', `${deps.msgs.excludeAddedPrefix}${p}`)
  }

  const bS = deps.extractStrykerGateBits(
    deps.coerceText(deps.getFile(baseFiles, 'stryker.config.mjs')),
  )
  const hS = deps.extractStrykerGateBits(
    deps.coerceText(deps.getFile(headFiles, 'stryker.config.mjs')),
  )
  const bMut = (bS.mutate ?? []).filter((p) => !p.startsWith('scripts/'))
  const hMut = hS.mutate ?? []
  for (const p of bMut) {
    if (!coverageIncludeCovered(p, hMut)) {
      fail('include-removed', `${deps.msgs.mutateIncludeRemovedPrefix}${p}`)
    }
  }
  for (const p of hS.bang) {
    if (bS.bang.includes(p)) continue
    if (p.startsWith('!scripts/') || p === '!scripts/**/*.test.mjs') continue
    if (isAllowedScriptPairedExclude(p, headFiles, hInc)) continue
    fail('exclude-added', `${deps.msgs.bangAddedPrefix}${p}`)
  }
}
