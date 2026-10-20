/**
 * Parse Manual test / Browser check / Perf lines for `pnpm agent manual-qa`.
 */

export const MANUAL_QA_CPU_THROTTLE = 4

/**
 * @param {string} text
 * @returns {string[]}
 */
export function parseManualScenarios(text) {
  /** @type {string[]} */
  const out = []
  const lines = String(text ?? '').split('\n')
  let inManual = false
  for (const line of lines) {
    if (/^##\s+Manual test scenarios\b/i.test(line)) {
      inManual = true
      continue
    }
    if (inManual && /^##\s+/.test(line)) break
    if (/^\*\*Browser check:\*\*/i.test(line)) {
      out.push(line.replace(/^\*\*Browser check:\*\*\s*/i, '').trim())
      continue
    }
    if (/^\*\*Perf:\*\*/i.test(line)) {
      out.push(`perf: ${line.replace(/^\*\*Perf:\*\*\s*/i, '').trim()}`)
      continue
    }
    if (inManual) {
      const m = /^\s*\d+\.\s+(.+)$/.exec(line)
      if (m) out.push(m[1].trim())
    }
  }
  return out.filter(Boolean)
}
