/**
 * Mutation-suppression comment detector for gate ratchet.
 * Finds every `stryker` + ws + (`disable`|`restore`) (any case), plus main-style
 * exact `Stryker` + optional ws + `disable` prefix so counts never fall below main.
 */

export const STRYKER_DISABLE_PER_FILE_CAP = 3
export const STRYKER_DISABLE_REASON_MIN = 10
export const STRYKER_KEYWORD = 'stryker'
export const DISABLE_KEYWORD = 'disable'
export const RESTORE_KEYWORD = 'restore'
export const NEXT_LINE_KEYWORD = 'next-line'
export const DETECTOR_SCRIPT = 'scripts/stryker-disable-detect.mjs'
export const RATCHET_SCRIPT = 'scripts/check-gate-ratchet.mjs'

/**
 * @param {string} ch
 */
export function isWsChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

/**
 * @param {string} ch
 */
export function isIdentContinue(ch) {
  if (ch >= 'a' && ch <= 'z') return true
  if (ch >= 'A' && ch <= 'Z') return true
  if (ch >= '0' && ch <= '9') return true
  return ch === '_' || ch === '$'
}

/**
 * @param {string} hay
 * @param {string} needle
 * @param {number} from
 */
export function indexOfIgnoreCase(hay, needle, from) {
  const start = from < 0 ? 0 : from
  return hay.toLowerCase().indexOf(needle.toLowerCase(), start)
}

/**
 * @param {string} s
 * @param {number} i
 */
export function skipWs(s, i) {
  let p = i
  while (p < s.length && isWsChar(s[p])) p++
  return p
}

/**
 * @param {string} s
 * @param {number} i
 * @param {string} word
 */
export function matchPrefixIgnoreCase(s, i, word) {
  if (indexOfIgnoreCase(s, word, i) !== i) return -1
  return i + word.length
}

/**
 * @param {string} s
 * @param {number} i
 * @param {string} word
 */
export function matchKeywordAt(s, i, word) {
  const end = matchPrefixIgnoreCase(s, i, word)
  if (end < 0) return -1
  if (end < s.length && isIdentContinue(s[end])) return -1
  return end
}

/**
 * Main-branch countStrykerDisable (exact `Stryker` + optional ws + `disable` prefix).
 * @param {string} text
 */
export function countStrykerDisableMainStyle(text) {
  const s = String(text)
  let count = 0
  let from = 0
  while (from < s.length) {
    const at = s.indexOf('Stryker', from)
    if (at === -1) break
    let i = at + 'Stryker'.length
    while (i < s.length && isWsChar(s[i])) i++
    if (s.startsWith('disable', i)) count++
    from = at + 1
  }
  return count
}

/**
 * @param {string} s
 * @param {number} from
 * @returns {null | { at: number, verb: 'disable' | 'restore', verbEnd: number }}
 */
export function findNextStrykerDirective(s, from) {
  let searchFrom = from < 0 ? 0 : from
  while (searchFrom < s.length) {
    const at = indexOfIgnoreCase(s, STRYKER_KEYWORD, searchFrom)
    if (at < 0) return null
    const afterKw = skipWs(s, at + STRYKER_KEYWORD.length)
    const wsCount = afterKw - (at + STRYKER_KEYWORD.length)
    if (wsCount > 0) {
      const restoreEnd = matchPrefixIgnoreCase(s, afterKw, RESTORE_KEYWORD)
      if (restoreEnd >= 0) {
        return { at, verb: 'restore', verbEnd: restoreEnd }
      }
      const disableEnd = matchPrefixIgnoreCase(s, afterKw, DISABLE_KEYWORD)
      if (disableEnd >= 0) {
        return { at, verb: 'disable', verbEnd: disableEnd }
      }
    } else if (
      s.startsWith('Stryker', at) &&
      s.startsWith(DISABLE_KEYWORD, afterKw)
    ) {
      return {
        at,
        verb: 'disable',
        verbEnd: afterKw + DISABLE_KEYWORD.length,
      }
    }
    searchFrom = at + 1
  }
  return null
}

/**
 * @param {string} s
 * @param {{ at: number, verbEnd: number }} hit
 * @returns {null | { reason: string, mutators: string }}
 */
export function tryParseLegalNextLineDisable(s, hit) {
  const lineStart = s.lastIndexOf('\n', hit.at - 1) + 1
  let lineEnd = s.indexOf('\n', hit.at)
  if (lineEnd < 0) lineEnd = s.length
  let i = lineStart
  while (i < lineEnd && isWsChar(s[i])) i++
  if (!s.startsWith('//', i)) return null
  i = skipWs(s, i + 2)
  if (i !== hit.at) return null
  let j = skipWs(s, hit.verbEnd)
  const nlEnd = matchKeywordAt(s, j, NEXT_LINE_KEYWORD)
  if (nlEnd < 0) return null
  j = skipWs(s, nlEnd)
  const colon = s.indexOf(':', j)
  if (colon < 0 || colon >= lineEnd) return null
  const mutators = s.slice(j, colon).trim()
  if (mutators.length === 0) return null
  const reason = s.slice(colon + 1, lineEnd).trim()
  if (reason.length < STRYKER_DISABLE_REASON_MIN) return null
  return { reason, mutators }
}

/**
 * @param {string} s
 * @param {number} at
 */
export function lineContaining(s, at) {
  const lineStart = s.lastIndexOf('\n', at - 1) + 1
  let lineEnd = s.indexOf('\n', at)
  if (lineEnd < 0) lineEnd = s.length
  return s.slice(lineStart, lineEnd)
}

/**
 * @param {string} text
 * @returns {{ legal: { reason: string, mutators: string, line: string }[], illegal: { line: string }[] }}
 */
export function collectStrykerDisableComments(text) {
  const s = String(text)
  /** @type {{ reason: string, mutators: string, line: string }[]} */
  const legal = []
  /** @type {{ line: string }[]} */
  const illegal = []
  let from = 0
  while (from < s.length) {
    const hit = findNextStrykerDirective(s, from)
    if (hit == null) break
    const line = lineContaining(s, hit.at)
    if (hit.verb === 'restore') {
      illegal.push({ line })
    } else {
      const parsed = tryParseLegalNextLineDisable(s, hit)
      if (parsed) {
        legal.push({ reason: parsed.reason, mutators: parsed.mutators, line })
      } else {
        illegal.push({ line })
      }
    }
    from = hit.at + 1
  }
  return { legal, illegal }
}

/**
 * @param {string} line
 * @returns {null | { kind: 'legal', reason: string, mutators: string } | { kind: 'illegal' }}
 */
export function classifyStrykerDisableLine(line) {
  const { legal, illegal } = collectStrykerDisableComments(line)
  if (legal.length > 0) {
    return {
      kind: 'legal',
      reason: legal[0].reason,
      mutators: legal[0].mutators,
    }
  }
  if (illegal.length > 0) return { kind: 'illegal' }
  return null
}

/**
 * @param {string} text
 */
export function countStrykerDisable(text) {
  const { legal, illegal } = collectStrykerDisableComments(text)
  return legal.length + illegal.length
}

/**
 * Paths whose source may mention detector keywords without being suppressions.
 * @param {string} p
 */
export function isStrykerDetectorPath(p) {
  return p === DETECTOR_SCRIPT || p === RATCHET_SCRIPT
}
