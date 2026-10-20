import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveRepoRoot } from './resolve-repo-root.mjs'

const REASON_PATTERN = /`(![^`]+)`/g
const DEFAULT_STRYKER_CONFIG = 'stryker.config.mjs'

/** @type {{ mutate?: unknown }} */
let defaultStrykerConfig
try {
  const mod = await import(
    pathToFileURL(
      path.resolve(resolveRepoRoot(), DEFAULT_STRYKER_CONFIG),
    ).href,
  )
  defaultStrykerConfig = mod.default
} catch {
  // Minimal hosts (pack-smoke) may omit Stryker; callers that need mutate pass config.
  defaultStrykerConfig = { mutate: [] }
}

function escapeLiteral(char) {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

function globToRegExp(pattern) {
  let source = '^'
  let index = 0
  while (index < pattern.length) {
    if (pattern.startsWith('**', index)) {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 3
      } else {
        source += '.*'
        index += 2
      }
      continue
    }
    const char = pattern[index]
    if (char === '*') {
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (char === '{') {
      const end = pattern.indexOf('}', index)
      if (end === -1) {
        source += escapeLiteral(char)
        index += 1
        continue
      }
      const alternatives = pattern
        .slice(index + 1, end)
        .split(',')
        .map((alternative) => alternative.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      source += `(?:${alternatives.join('|')})`
      index = end + 1
      continue
    }
    source += escapeLiteral(char)
    index += 1
  }
  return new RegExp(`${source}$`)
}

function matchGlob(file, pattern) {
  return globToRegExp(pattern).test(file)
}

/**
 * @param {string} [configPath]
 * @param {{ mutate?: unknown }} [config]
 */
export function loadMutatePatterns(
  configPath = DEFAULT_STRYKER_CONFIG,
  config = defaultStrykerConfig,
) {
  if (configPath !== DEFAULT_STRYKER_CONFIG) {
    throw new Error(
      `mutation scope only loads ${DEFAULT_STRYKER_CONFIG}, got ${configPath}`,
    )
  }
  if (!Array.isArray(config?.mutate)) {
    throw new Error(`${configPath} mutate must be an array of glob strings`)
  }
  return config.mutate.map((pattern) => {
    if (typeof pattern !== 'string') {
      throw new Error(`${configPath} mutate entries must be strings`)
    }
    return pattern
  })
}

export function classifyMutationFile(file, patterns) {
  let covered = false
  let excluded = false
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (matchGlob(file, pattern.slice(1))) {
        covered = false
        excluded = true
      }
      continue
    }
    if (matchGlob(file, pattern)) {
      covered = true
      excluded = false
    }
  }
  if (covered) {
    return 'in-scope'
  }
  if (excluded) {
    return 'excluded'
  }
  return 'unclassified'
}

export function selectMutableChanges(files, patterns) {
  return files
    .filter((file) => classifyMutationFile(file, patterns) === 'in-scope')
    .sort()
}

export function findUnclassifiedProductionFiles(files, patterns) {
  return files.filter(
    (file) => classifyMutationFile(file, patterns) === 'unclassified',
  )
}

export function findExcludeReasonGaps(patterns, reasonText) {
  const configured = patterns.filter((pattern) => pattern.startsWith('!'))
  const documented = [...reasonText.matchAll(REASON_PATTERN)].map(
    (match) => match[1],
  )
  const documentedSet = new Set(documented)
  const configuredSet = new Set(configured)
  return {
    missing: configured.filter((pattern) => !documentedSet.has(pattern)),
    extra: documented.filter((pattern) => !configuredSet.has(pattern)),
  }
}
