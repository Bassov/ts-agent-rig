/** Pure helpers for @albasov/ts-agent-rig dependency pin comparison. */

export function readPackageDepSpec(
  pkg: unknown,
  name: string,
): string | null {
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return null
  const record = pkg as Record<string, unknown>
  for (const key of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ] as const) {
    const block = record[key]
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      continue
    }
    const v = (block as Record<string, unknown>)[name]
    if (typeof v === 'string') return v
  }
  return null
}

export function extractPnpmLockPackageBlock(
  lockRaw: unknown,
  name: string,
): string {
  const text = typeof lockRaw === 'string' ? lockRaw : ''
  if (!text) return ''
  const lines = text.split('\n')
  const hits: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || !line.includes(name)) continue
    hits.push(line.trim())
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const next = lines[j]
      if (next === undefined || !/^\s+/.test(next)) break
      hits.push(next.trim())
    }
  }
  return hits.join('\n')
}
