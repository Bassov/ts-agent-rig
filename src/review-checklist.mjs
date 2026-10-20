/**
 * Shared reader for quality/review-checklist.md row ids.
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * Ids from quality/review-checklist.md when present (no full prose).
 * Recognizes list rows whose first token is a kebab id (optionally backticked).
 * @param {string} root
 * @param {(path: string, enc: string) => string} [readFile]
 */
export function readReviewChecklistIds(root, readFile = fs.readFileSync) {
  const file = path.join(root, 'quality', 'review-checklist.md')
  if (!fs.existsSync(file)) return []
  let text = ''
  try {
    text = readFile(file, 'utf8')
  } catch {
    return []
  }
  const ids = []
  const seen = new Set()
  for (const line of String(text).split('\n')) {
    const m =
      /^\s*[-*]\s+(?:\[[ xX]\]\s+)?`([a-z][a-z0-9-]*)`/.exec(line) ||
      /^\s*[-*]\s+(?:\[[ xX]\]\s+)?([a-z][a-z0-9-]*)\s*[:—-]/.exec(line)
    if (!m) continue
    const id = m[1]
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}
