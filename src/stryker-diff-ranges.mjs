/**
 * Derive Stryker mutate specs (`path:start-end`) from unified-diff hunks.
 */

/**
 * @typedef {{ start: number, end: number }} LineRange
 */

/**
 * Parse unified diff text into new-side line ranges per file path.
 * Pure deletions (no new lines) contribute no ranges.
 *
 * @param {string} diffText
 * @returns {Map<string, LineRange[]>}
 */
export function parseUnifiedDiffRanges(diffText) {
  /** @type {Map<string, LineRange[]>} */
  const byFile = new Map()
  let current = /** @type {string | null} */ (null)

  for (const raw of diffText.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('+++ ')) {
      const rest = line.slice(4).trim()
      if (rest === '/dev/null') {
        current = null
        continue
      }
      current = rest.startsWith('b/') ? rest.slice(2) : rest
      if (!byFile.has(current)) byFile.set(current, [])
      continue
    }
    if (current == null) continue
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line)
    if (!hunk) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    if (!Number.isFinite(start) || start < 1 || count <= 0) continue
    const end = start + count - 1
    const ranges = byFile.get(current) ?? []
    ranges.push({ start, end })
    byFile.set(current, ranges)
  }
  return byFile
}

/**
 * Merge overlapping/adjacent ranges and sort.
 * @param {LineRange[]} ranges
 * @returns {LineRange[]}
 */
export function mergeLineRanges(ranges) {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  /** @type {LineRange[]} */
  const out = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]
    const last = out[out.length - 1]
    if (cur.start <= last.end + 1) {
      last.end = Math.max(last.end, cur.end)
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

/**
 * @param {string} file
 * @param {LineRange[]} ranges
 * @returns {string[]}
 */
export function formatMutateSpecs(file, ranges) {
  const merged = mergeLineRanges(ranges)
  return merged.map((r) =>
    r.start === r.end ? `${file}:${r.start}-${r.end}` : `${file}:${r.start}-${r.end}`,
  )
}

/**
 * True when mutant start line falls inside any range (inclusive).
 * @param {number | undefined} line
 * @param {LineRange[]} ranges
 */
export function lineInRanges(line, ranges) {
  if (typeof line !== 'number' || !Number.isFinite(line)) return false
  for (const r of ranges) {
    if (line >= r.start && line <= r.end) return true
  }
  return false
}

/**
 * Keep only mutants whose start line is in the scored ranges for that file.
 * Files without a ranges entry are dropped from the map (not scored).
 *
 * @param {Record<string, { mutants?: { status?: string, location?: { start?: { line?: number } } }[] }>} fileMap
 * @param {Map<string, LineRange[]>} rangesByFile
 */
export function filterReportToScoredRanges(fileMap, rangesByFile) {
  /** @type {Record<string, { mutants: { status?: string, location?: { start?: { line?: number } } }[] }>} */
  const out = {}
  for (const [filePath, file] of Object.entries(fileMap)) {
    const ranges = rangesByFile.get(filePath)
    if (!ranges || ranges.length === 0) continue
    const mutants = Array.isArray(file.mutants) ? file.mutants : []
    const kept = mutants.filter((m) =>
      lineInRanges(m.location?.start?.line, ranges),
    )
    if (kept.length > 0) out[filePath] = { mutants: kept }
  }
  return out
}

/**
 * Strip optional `:start-end` / `:start:col-end:col` suffix from a mutate spec.
 * @param {string} spec
 */
export function mutateSpecPath(spec) {
  const idx = spec.indexOf(':')
  if (idx <= 0) return spec
  // Windows drive letter `C:\...` — keep path when second char is `:` and third is `\`
  if (spec.length > 2 && spec[1] === ':' && (spec[2] === '\\' || spec[2] === '/')) {
    const next = spec.indexOf(':', 2)
    return next < 0 ? spec : spec.slice(0, next)
  }
  return spec.slice(0, idx)
}

/**
 * Build mutate specs for planned files from a unified diff + optional whole-file fallbacks.
 *
 * @param {string[]} mutateFiles
 * @param {string} diffText unified diff covering those files (new side)
 * @param {Map<string, number>} [wholeFileLineCounts] untracked / new files → line count (mutate 1..N)
 * @returns {{ specs: string[], rangesByFile: Map<string, LineRange[]>, empty: boolean }}
 */
export function buildMutateSpecsFromDiff(
  mutateFiles,
  diffText,
  wholeFileLineCounts = new Map(),
) {
  const parsed = parseUnifiedDiffRanges(diffText)
  /** @type {Map<string, LineRange[]>} */
  const rangesByFile = new Map()
  /** @type {string[]} */
  const specs = []

  for (const file of mutateFiles) {
    let ranges = mergeLineRanges(parsed.get(file) ?? [])
    if (ranges.length === 0) {
      const n = wholeFileLineCounts.get(file)
      if (typeof n === 'number' && n > 0) {
        ranges = [{ start: 1, end: n }]
      }
    }
    if (ranges.length === 0) continue
    rangesByFile.set(file, ranges)
    specs.push(...formatMutateSpecs(file, ranges))
  }

  return { specs, rangesByFile, empty: specs.length === 0 }
}
