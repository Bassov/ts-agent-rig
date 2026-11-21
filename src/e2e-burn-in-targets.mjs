#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { resolveBurnInCount } from './e2e-burn-in-count.mjs'
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
 *   env?: NodeJS.ProcessEnv,
 *   repeats?: number | (() => number),
 *   log?: (text: string) => void,
 * }} [io]
 *
 * Changed specs are always targets. Specs reached only through a changed
 * e2e support file (fixture/helper) are a deterministic sample that fits
 * `E2E_BURN_IN_BUDGET` test runs (default 900) at the burn-in repeat count;
 * at least one such spec is kept, so a fixture change is never skipped.
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

  const pulledIn = []
  for (const file of sources) {
    if (!isE2eSpec(file) || targets.has(file)) continue
    const closure = transitiveImports(file, graph)
    for (const dep of closure) {
      if (supportSet.has(dep)) {
        pulledIn.push(file)
        break
      }
    }
  }

  const flaky = resolveFlaky()
  const direct = excludeFlakyFromTargets([...targets].sort(), flaky)
  const candidates = excludeFlakyFromTargets(pulledIn.sort(), flaky)
  if (candidates.length === 0) return direct

  const repeats = resolveRepeats(io)
  const budget = resolveBudget(io.env ?? process.env)
  const estimate = (path) => {
    try {
      return estimateSpecTests(readFile(path))
    } catch {
      return 1
    }
  }
  const directRuns =
    direct.reduce((sum, path) => sum + estimate(path), 0) * repeats
  const sampled = sampleTransitiveSpecs(candidates, {
    seed: [...supportSet].sort().join('\n'),
    budgetTests: Math.floor(Math.max(0, budget - directRuns) / repeats),
    estimate,
  })
  const log = io.log ?? ((text) => console.error(text))
  log(
    `e2e-burn-in-targets: ${String(direct.length)} changed spec(s) + ` +
      `${String(sampled.length)}/${String(candidates.length)} spec(s) pulled in by ` +
      `changed e2e support files (budget ${String(budget)} test runs, ` +
      `×${String(repeats)} repeats)`,
  )
  return [...new Set([...direct, ...sampled])].sort()
}

/** Default test-run budget: ~30 min on one worker at ~30 tests/min. */
export const DEFAULT_BURN_IN_BUDGET = 900
const FALLBACK_REPEATS = 10

const TEST_CALL_RE =
  /^\s*(?:test|it)(?:\.(?:only|fixme|fail|slow|skip))?\(\s*['"`]/gm

/**
 * Static test count of a spec (titled `test(` / `it(` calls; ≥1).
 * Loops that generate tests count once, so this is a lower bound per call site.
 * @param {string} source
 */
export function estimateSpecTests(source) {
  const matches = String(source).match(TEST_CALL_RE)
  return Math.max(1, matches ? matches.length : 0)
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveBudget(env) {
  const raw = env.E2E_BURN_IN_BUDGET
  if (raw === undefined || raw === '') return DEFAULT_BURN_IN_BUDGET
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `E2E_BURN_IN_BUDGET must be a positive integer, got ${String(raw)}`,
    )
  }
  return value
}

/**
 * Repeat count the burn-in job runs with (same resolution as e2e-burn-in-count).
 * @param {{ repeats?: number | (() => number), env?: NodeJS.ProcessEnv, root?: string }} io
 */
export function resolveRepeats(io) {
  if (typeof io.repeats === 'number') return io.repeats
  if (typeof io.repeats === 'function') return io.repeats()
  try {
    return resolveBurnInCount({
      env: io.env ?? process.env,
      root: io.root ?? process.cwd(),
    })
  } catch {
    return FALLBACK_REPEATS
  }
}

/**
 * @param {string} seed
 * @param {string} path
 */
function rank(seed, path) {
  return createHash('sha256').update(`${seed}\0${path}`).digest('hex')
}

/**
 * Deterministic budgeted sample of specs pulled in only through changed
 * support files: order by sha256(seed, path), take each spec whose estimated
 * tests still fit, and always keep at least one spec.
 * @param {string[]} candidates
 * @param {{ seed: string, budgetTests: number, estimate: (path: string) => number }} opts
 * @returns {string[]} sorted sample
 */
export function sampleTransitiveSpecs(candidates, opts) {
  const ordered = [...new Set(candidates)]
    .map((path) => ({ path, key: rank(opts.seed, path) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const picked = []
  let left = opts.budgetTests
  for (const { path } of ordered) {
    const cost = opts.estimate(path)
    if (cost > left) continue
    picked.push(path)
    left -= cost
  }
  if (picked.length === 0 && ordered.length > 0) picked.push(ordered[0].path)
  return picked.sort()
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
    const targets = selectBurnInTargets(changed, { env, ...io }).filter(
      (path) =>
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
