#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  excludeFlakyFromTargets,
  loadFlakySpecPaths,
} from './e2e-flaky-list.mjs'

const SPEC_RE = /^e2e\/.+\.spec\.ts$/
const E2E_SOURCE_RE = /^e2e\/.+\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/
const BURN_IN_FIXTURES_RE = /^e2e\/burn-in-fixtures\//

const RESOLVE_EXTS = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]

const IMPORT_RE =
  /(?:import|export)(?:\s+type)?(?:[\s\w{},*$][\s\S]*?\s+from\s*|\s+)['"](\.[^'"]+)['"]|require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g

function normalize(path) {
  return path.replaceAll('\\', '/')
}

export function isE2eSpec(path) {
  const n = normalize(path)
  if (BURN_IN_FIXTURES_RE.test(n)) return false
  return SPEC_RE.test(n)
}

/** Non-spec e2e source: fixtures, helpers, perf helpers, etc. */
export function isE2eSupportFile(path) {
  const n = normalize(path)
  if (BURN_IN_FIXTURES_RE.test(n)) return false
  return E2E_SOURCE_RE.test(n) && !SPEC_RE.test(n)
}

export function extractRelativeImports(source) {
  const out = []
  for (const match of String(source).matchAll(IMPORT_RE)) {
    out.push(match[1] ?? match[2])
  }
  return out
}

/**
 * @param {string} fromFile repo-relative path
 * @param {string} specifier relative import
 * @param {{ exists?: (path: string) => boolean }} [io]
 */
export function resolveE2eImport(fromFile, specifier, io = {}) {
  const exists = io.exists ?? ((path) => existsSync(path))
  const base = normalize(join(dirname(fromFile), specifier))
  const candidates = []
  for (const ext of RESOLVE_EXTS) {
    candidates.push(`${base}${ext}`)
  }
  for (const ext of RESOLVE_EXTS) {
    if (ext === '') continue
    candidates.push(normalize(join(base, `index${ext}`)))
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith('e2e/')) continue
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * @param {string} root
 * @param {{ exists?: (path: string) => boolean, readdir?: typeof readdirSync }} [io]
 */
export function listE2eSourceFiles(root, io = {}) {
  const exists = io.exists ?? ((path) => existsSync(path))
  const readdir = io.readdir ?? readdirSync
  const e2eDir = join(root, 'e2e')
  if (!exists(e2eDir)) return []
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const rel = normalize(relative(root, full))
      if (E2E_SOURCE_RE.test(rel) && !BURN_IN_FIXTURES_RE.test(rel)) {
        out.push(rel)
      }
    }
  }
  walk(e2eDir)
  return out.sort()
}

/**
 * @param {string[]} files
 * @param {{ readFile?: (path: string) => string, exists?: (path: string) => boolean }} [io]
 * @returns {Map<string, Set<string>>}
 */
export function buildImportGraph(files, io = {}) {
  const readFile = io.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const exists = io.exists ?? ((path) => existsSync(path))
  const known = new Set(files)
  /** @type {Map<string, Set<string>>} */
  const graph = new Map()
  for (const file of files) {
    const imports = new Set()
    let source
    try {
      source = readFile(file)
    } catch {
      graph.set(file, imports)
      continue
    }
    for (const specifier of extractRelativeImports(source)) {
      const resolved = resolveE2eImport(file, specifier, { exists })
      if (resolved && known.has(resolved)) imports.add(resolved)
    }
    graph.set(file, imports)
  }
  return graph
}

/**
 * @param {string} start
 * @param {Map<string, Set<string>>} graph
 */
export function transitiveImports(start, graph) {
  const out = new Set()
  const stack = [...(graph.get(start) ?? [])]
  while (stack.length > 0) {
    const next = stack.pop()
    if (!next || out.has(next)) continue
    out.add(next)
    for (const dep of graph.get(next) ?? []) {
      if (!out.has(dep)) stack.push(dep)
    }
  }
  return out
}

/**
 * @param {string[]} changedPaths
 * @param {{
 *   readFile?: (path: string) => string,
 *   exists?: (path: string) => boolean,
 *   listSources?: () => string[],
 *   readdir?: typeof readdirSync,
 * }} [io]
 */
export function selectBurnInTargets(changedPaths, io = {}) {
  const readFile = io.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const exists = io.exists ?? ((path) => existsSync(path))
  const listSources =
    io.listSources ??
    (() => listE2eSourceFiles(process.cwd(), { exists, readdir: io.readdir }))
  const resolveFlaky =
    io.flakyPaths !== undefined
      ? () =>
          typeof io.flakyPaths === 'function' ? io.flakyPaths() : io.flakyPaths
      : () => loadFlakySpecPaths({ root: io.root ?? process.cwd() })

  const changed = [...new Set(changedPaths.map(normalize))]
  const targets = new Set()

  for (const path of changed) {
    if (isE2eSpec(path)) targets.add(path)
  }

  const changedSupport = changed.filter(isE2eSupportFile)
  if (changedSupport.length === 0) {
    return excludeFlakyFromTargets([...targets].sort(), resolveFlaky())
  }

  const supportSet = new Set(changedSupport)
  let sources
  try {
    sources = listSources()
  } catch {
    return excludeFlakyFromTargets([...targets].sort(), resolveFlaky())
  }

  const graph = buildImportGraph(sources, { readFile, exists })

  for (const file of sources) {
    if (!isE2eSpec(file)) continue
    const closure = transitiveImports(file, graph)
    for (const dep of closure) {
      if (supportSet.has(dep)) {
        targets.add(file)
        break
      }
    }
  }

  return excludeFlakyFromTargets([...targets].sort(), resolveFlaky())
}

/**
 * @param {string[]} args
 * @param {{ spawnSync?: typeof spawnSync }} [io]
 */
export function gitLines(args, io = {}) {
  const spawn = io.spawnSync ?? spawnSync
  const result = spawn('git', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim()
    throw new Error(detail || `git ${args.join(' ')} failed`)
  }
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * @param {string} [base]
 * @param {{ gitLines?: (args: string[]) => string[] }} [io]
 */
export function collectChangedPaths(base, io = {}) {
  const resolved = base ?? process.env.STRYKER_DIFF_BASE ?? 'origin/main'
  const lines =
    typeof io.gitLines === 'function'
      ? io.gitLines
      : (args) => gitLines(args, io)
  return [
    ...lines(['diff', '--name-only', '--diff-filter=ACMR', resolved]),
    ...lines([
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      '--cached',
      resolved,
    ]),
    ...lines(['ls-files', '--others', '--exclude-standard']),
  ]
}

export function main(env = process.env, io = {}) {
  const base = env.STRYKER_DIFF_BASE ?? 'origin/main'
  const exists = io.exists ?? ((path) => existsSync(path))
  const isFile =
    io.isFile ??
    ((path) => {
      try {
        return exists(path) && statSync(path).isFile()
      } catch {
        return false
      }
    })
  const write = io.write ?? ((text) => process.stdout.write(text))
  const error = io.error ?? ((text) => console.error(text))
  try {
    const changed = collectChangedPaths(base, io)
    const targets = selectBurnInTargets(changed, io).filter((path) =>
      isFile(path),
    )
    if (targets.length === 0) return 0
    write(`${targets.join('\n')}\n`)
    return 0
  } catch (err) {
    error(err instanceof Error ? err.message : err)
    return 1
  }
}
