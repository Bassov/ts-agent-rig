// Unified deterministic check entry: fail-all + compact default output.
// Entry: `ts-rig-check` / `pnpm check`. Zero deps, Node 22, ESM.
// Check inventory prefers `quality/gates.json` `checks` with built-in fallback.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGates } from './load-gates.mjs'
import { resolveRepoRoot } from './resolve-repo-root.mjs'

const ROOT_DEFAULT = resolveRepoRoot()
const LOG_DIR = '.cache/checks'
export const PROBLEM_CAP = 20

/** Built-in fallback when `quality/gates.json` has no `checks` block. */
export const DEFAULT_CORE_CHECKS = Object.freeze([
  { name: 'typecheck', argv: ['pnpm', 'typecheck'] },
  { name: 'lint', argv: ['pnpm', 'lint'] },
  { name: 'deps', argv: ['pnpm', 'deps'] },
  { name: 'knip', argv: ['pnpm', 'knip'] },
  { name: 'mutation-scope', argv: ['pnpm', 'mutation-scope'] },
  { name: 'gate-values', argv: ['pnpm', 'gate-values'] },
  { name: 'openspec-budget', argv: ['pnpm', 'openspec-budget'] },
  { name: 'codecov-yml', argv: ['pnpm', 'codecov-yml'] },
  { name: 'roadmap', argv: ['pnpm', '-s', 'roadmap', 'check'] },
  {
    name: 'unit',
    argv: [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--coverage',
      '--reporter=dot',
      '--silent',
    ],
  },
])

/** Hosts should declare afterUnit/optional in quality/gates.json `checks`. */
export const DEFAULT_AFTER_UNIT = Object.freeze([])

export const DEFAULT_OPTIONAL = Object.freeze([])
/**
 * @param {unknown} row
 * @returns {{ name: string, argv?: string[], script?: string } | null}
 */
function normalizeCheckRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
  const r = /** @type {Record<string, unknown>} */ (row)
  if (typeof r.name !== 'string' || r.name.length === 0) return null
  if (Array.isArray(r.argv)) {
    const argv = r.argv.filter((a) => typeof a === 'string')
    if (argv.length === 0) return null
    return { name: r.name, argv }
  }
  if (typeof r.script === 'string' && r.script.length > 0) {
    return { name: r.name, script: r.script }
  }
  return null
}

/**
 * @param {string} root
 * @param {{ loadGatesFn?: typeof loadGates }} [io]
 */
export function resolveCheckTables(root, io = {}) {
  const load = io.loadGatesFn ?? loadGates
  try {
    const gates = load({ root })
    const block =
      gates && typeof gates === 'object' && !Array.isArray(gates)
        ? /** @type {Record<string, unknown>} */ (gates).checks
        : undefined
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const b = /** @type {Record<string, unknown>} */ (block)
      const coreRaw = Array.isArray(b.core) ? b.core : null
      const afterRaw = Array.isArray(b.afterUnit) ? b.afterUnit : null
      const optRaw = Array.isArray(b.optional) ? b.optional : null
      const core = coreRaw
        ? coreRaw.map(normalizeCheckRow).filter(Boolean)
        : null
      const afterUnit = afterRaw
        ? afterRaw.map(normalizeCheckRow).filter(Boolean)
        : null
      const optional = optRaw
        ? optRaw.map(normalizeCheckRow).filter(Boolean)
        : null
      return {
        core: core && core.length > 0 ? core : [...DEFAULT_CORE_CHECKS],
        afterUnit:
          afterUnit && afterUnit.length > 0
            ? afterUnit
            : [...DEFAULT_AFTER_UNIT],
        optional:
          optional && optional.length > 0 ? optional : [...DEFAULT_OPTIONAL],
      }
    }
  } catch {
    // Missing/invalid gates → built-in fallback (gate-values check still fails).
  }
  return {
    core: [...DEFAULT_CORE_CHECKS],
    afterUnit: [...DEFAULT_AFTER_UNIT],
    optional: [...DEFAULT_OPTIONAL],
  }
}

/** @deprecated Prefer resolveCheckTables; kept for test imports. */
export const SEQUENTIAL_AFTER_UNIT = DEFAULT_AFTER_UNIT.map((c) => ({
  name: c.name,
  argv: c.argv
    ? [...c.argv]
    : ['node', /** @type {{ script: string }} */ (c).script],
}))

export const NOISE_STARTS = [
  'RUN',
  'Test Files',
  'Tests ',
  'Start at',
  'Duration',
  'JUNIT',
  'Failed Tests',
  'PASS',
  'passed',
  '✓',
  '✔',
  '✖',
]

/** Drop tool chrome that must never appear in compact failure lines. */
export function isNoiseLine(line) {
  const t = String(line ?? '').trim()
  if (t.length === 0) return true
  if (t === '-' || t === '+') return true
  if (t.startsWith('- ') || t.startsWith('+ ')) return true
  if (t.startsWith('---') || t.startsWith('⎯')) return true
  if (t.length > 1 && t[1] === '|' && t[0] >= '0' && t[0] <= '9') return true
  for (const prefix of NOISE_STARTS) {
    if (t.startsWith(prefix)) return true
  }
  return false
}

/**
 * @param {string} root
 * @param {{
 *   existsSync?: (p: string) => boolean
 *   loadGatesFn?: typeof loadGates
 * }} [io]
 * @returns {{ name: string, argv: string[] }[]}
 */
export function buildInventory(root, io = {}) {
  const exists = io.existsSync ?? fs.existsSync
  const tables = resolveCheckTables(root, io)
  /** @type {{ name: string, argv: string[] }[]} */
  const list = []
  for (const c of tables.core) {
    if (c.argv) list.push({ name: c.name, argv: [...c.argv] })
    else if (c.script) {
      list.push({
        name: c.name,
        argv: [process.execPath, path.join(root, c.script)],
      })
    }
  }
  for (const opt of tables.optional) {
    if (opt.argv) {
      list.push({ name: opt.name, argv: [...opt.argv] })
      continue
    }
    const rel = opt.script
    if (!rel) continue
    const abs = path.join(root, rel)
    if (exists(abs)) {
      list.push({ name: opt.name, argv: [process.execPath, abs] })
    }
  }
  return list
}

/**
 * @param {string} root
 * @param {{
 *   existsSync?: (p: string) => boolean
 *   loadGatesFn?: typeof loadGates
 * }} [io]
 */
export function buildAfterUnitInventory(root, io = {}) {
  const exists = io.existsSync ?? fs.existsSync
  const tables = resolveCheckTables(root, io)
  /** @type {{ name: string, argv: string[], scriptRel?: string }[]} */
  const list = []
  for (const c of tables.afterUnit) {
    if (c.script) {
      if (!exists(path.join(root, c.script))) continue
      list.push({
        name: c.name,
        scriptRel: c.script,
        argv: [process.execPath, path.join(root, c.script)],
      })
    } else if (c.argv) {
      list.push({ name: c.name, argv: [...c.argv] })
    }
  }
  return list
}

/** Extract problem-ish lines from tool output for compact failure reports. */
export function stripAnsi(text) {
  return String(text ?? '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, () => '')
}

export function extractProblemLines(text, checkName) {
  const raw = stripAnsi(text)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => !isNoiseLine(l))

  const preferred = []
  let sawStack = false
  let lastPath = null
  for (const line of raw) {
    const trimmed = line.trim()
    const pathOnly = /^([\w./\\-]+\.[a-zA-Z0-9]+)$/.exec(trimmed)
    if (pathOnly) {
      lastPath = pathOnly[1]
      continue
    }
    const colDiag = /^(\d+):(\d+)\s+(error|warning)\b/i.exec(trimmed)
    if (colDiag && lastPath) {
      preferred.push(`${lastPath}:${colDiag[1]}:${colDiag[2]} ${trimmed}`)
      continue
    }
    if (/^❯/.test(trimmed) || /^at\s+/.test(trimmed)) {
      const hasFileLine = /[\w./\\-]+\.[a-zA-Z0-9]+:\d+/.test(trimmed)
      if (!hasFileLine) continue
      if (sawStack) continue
      sawStack = true
      preferred.push(trimmed)
      continue
    }
    const isDiag =
      /(?:error|fail|✖|×|ERR!|AssertionError|single-line:|orphan:|check failed)/i.test(
        trimmed,
      ) || /[\w./\\-]+\.[a-zA-Z0-9]+:\d+/.test(trimmed)
    if (isDiag) preferred.push(trimmed)
  }

  const picked = preferred.length > 0 ? preferred : raw.map((l) => l.trim())
  return picked.map((l) => `${checkName}: ${l}`)
}

/**
 * @param {{
 *   name: string
 *   ok: boolean
 *   ms: number
 *   problems: string[]
 *   logPath: string
 *   code: number
 * }} result
 * @param {{ problemCap?: number }} [opts]
 */
export function formatCheckResult(result, opts = {}) {
  const cap = opts.problemCap ?? PROBLEM_CAP
  const sec = (result.ms / 1000).toFixed(1)
  if (result.ok) return `OK ${result.name} (${sec}s)`
  const problems = result.problems
  const shown = problems.slice(0, cap)
  const lines = [...shown]
  if (problems.length > cap) {
    lines.push(`… +${problems.length - cap} more, full log: ${result.logPath}`)
  } else if (result.logPath) {
    lines.push(`full log: ${result.logPath}`)
  }
  return lines.join('\n')
}

/**
 * @param {string[]} argv
 * @param {{
 *   cwd: string
 *   env?: NodeJS.ProcessEnv
 *   spawnImpl?: typeof spawn
 * }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runChild(argv, opts) {
  const spawnImpl = opts.spawnImpl ?? spawn
  const [file, ...args] = argv
  return new Promise((resolve) => {
    const child = spawnImpl(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (err) => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
      })
    })
    child.on('close', (code) => {
      resolve({
        code: code === null || code === undefined ? 1 : code,
        stdout,
        stderr,
      })
    })
  })
}

/**
 * Run one named command with the same compact reporter as `pnpm check`.
 * Full output always lands in `.cache/checks/<name>.log`.
 * @param {{
 *   name: string
 *   argv: string[]
 *   root?: string
 *   verbose?: boolean
 *   env?: NodeJS.ProcessEnv
 *   spawnImpl?: typeof spawn
 *   mkdirSync?: typeof fs.mkdirSync
 *   writeFileSync?: typeof fs.writeFileSync
 *   now?: () => number
 *   write?: (text: string) => void
 * }} opts
 */
export async function runOneCheck(opts) {
  const name = opts.name
  const argv = opts.argv
  if (!name || typeof name !== 'string') {
    throw new Error('runOneCheck: name is required')
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('runOneCheck: argv must be a non-empty command')
  }
  const root = opts.root ?? ROOT_DEFAULT
  const verbose = Boolean(opts.verbose)
  const write = opts.write ?? ((t) => process.stdout.write(t))
  const now = opts.now ?? Date.now
  const mkdirSync = opts.mkdirSync ?? fs.mkdirSync
  const writeFileSync = opts.writeFileSync ?? fs.writeFileSync
  mkdirSync(path.join(root, LOG_DIR), { recursive: true })

  const childEnv = { ...(opts.env ?? process.env) }
  // Only the roadmap binary re-wraps via --run; never leak the guard into
  // vitest/stryker/other children (CI `pnpm test:coverage` must match local).
  const spawnsRoadmap =
    name === 'roadmap' ||
    argv.some((a) => /(^|[\\/])roadmap\.mjs$/.test(String(a)))
  if (spawnsRoadmap) {
    childEnv.PHOTOBOOKS_CHECK_INNER = '1'
  }
  const started = now()
  const child = await runChild(argv, {
    cwd: root,
    env: childEnv,
    spawnImpl: opts.spawnImpl,
  })
  const ms = Math.max(0, now() - started)
  const combined = `${child.stdout}\n${child.stderr}`
  const logPath = path.join(LOG_DIR, `${name}.log`)
  writeFileSync(path.join(root, logPath), combined)
  const ok = child.code === 0
  const problems = ok ? [] : extractProblemLines(combined, name)
  const result = {
    name,
    ok,
    ms,
    problems,
    logPath,
    code: child.code,
    argv,
  }
  if (verbose) {
    write(`--- ${name} ---\n`)
    for (const chunk of [child.stdout, child.stderr]) {
      if (!chunk) continue
      write(chunk)
      if (!chunk.endsWith('\n')) write('\n')
    }
  }
  write(`${formatCheckResult(result)}\n`)
  return result
}

/**
 * @param {{
 *   root?: string
 *   verbose?: boolean
 *   skipUnit?: boolean
 *   env?: NodeJS.ProcessEnv
 *   spawnImpl?: typeof spawn
 *   existsSync?: (p: string) => boolean
 *   mkdirSync?: typeof fs.mkdirSync
 *   writeFileSync?: typeof fs.writeFileSync
 *   now?: () => number
 *   write?: (text: string) => void
 *   inventory?: ReturnType<typeof buildInventory>
 * }} [opts]
 */
export async function runChecks(opts = {}) {
  const root = opts.root ?? ROOT_DEFAULT
  const verbose = Boolean(opts.verbose)

  let inventory = opts.inventory ?? buildInventory(root, opts)
  if (opts.skipUnit) {
    inventory = inventory.filter((c) => c.name !== 'unit')
  }

  const results = await Promise.all(
    inventory.map((check) =>
      runOneCheck({
        name: check.name,
        argv: check.argv,
        root,
        verbose,
        env: opts.env,
        spawnImpl: opts.spawnImpl,
        mkdirSync: opts.mkdirSync,
        writeFileSync: opts.writeFileSync,
        now: opts.now,
        write: opts.write,
      }),
    ),
  )

  if (!opts.skipUnit) {
    for (const check of buildAfterUnitInventory(root, opts)) {
      results.push(
        await runOneCheck({
          name: check.name,
          argv: check.argv,
          root,
          verbose,
          env: opts.env,
          spawnImpl: opts.spawnImpl,
          mkdirSync: opts.mkdirSync,
          writeFileSync: opts.writeFileSync,
          now: opts.now,
          write: opts.write,
        }),
      )
    }
  }

  const failed = results.filter((r) => !r.ok)
  return {
    ok: failed.length === 0,
    results,
    failed,
  }
}

/** Parse `check.mjs --run <name> -- <cmd...>` flags from argv. */
export function parseRunArgs(args) {
  const runIdx = args.indexOf('--run')
  if (runIdx === -1) return null
  const name = args[runIdx + 1]
  if (!name || name.startsWith('-')) {
    throw new Error(
      'usage: node scripts/check.mjs --run <name> -- <command...>',
    )
  }
  const dd = args.indexOf('--')
  if (dd === -1 || dd < runIdx + 2) {
    throw new Error(
      'usage: node scripts/check.mjs --run <name> -- <command...>',
    )
  }
  const cmd = args.slice(dd + 1)
  if (cmd.length === 0) {
    throw new Error(
      'usage: node scripts/check.mjs --run <name> -- <command...>',
    )
  }
  return { name, cmd }
}

export async function main(argv, opts = {}) {
  const args = argv === undefined ? process.argv.slice(2) : argv
  const verbose =
    args.includes('--verbose') ||
    args.includes('-v') ||
    process.env.CHECK_VERBOSE === '1'
  const skipUnit = args.includes('--skip-unit')
  let runSpec = null
  try {
    runSpec = parseRunArgs(args)
  } catch (err) {
    const write = opts.write ?? ((t) => process.stderr.write(t))
    write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
  if (runSpec) {
    const result = await runOneCheck({
      ...opts,
      name: runSpec.name,
      argv: runSpec.cmd,
      verbose,
    })
    if (result.ok) return 0
    const code = result.code
    return code === null || code === undefined ? 1 : code
  }
  const summary = await runChecks({
    ...opts,
    verbose,
    skipUnit,
  })
  return summary.ok ? 0 : 1
}

/** Testable CLI bootstrap; returns whether this module is the process entry. */
export function bootCli(
  argv1 = process.argv[1],
  metaUrl = import.meta.url,
  runMain = main,
  setExit = (code) => {
    process.exitCode = code
  },
) {
  if (!argv1) return false
  if (path.resolve(argv1) !== fileURLToPath(metaUrl)) return false
  void runMain().then((code) => {
    setExit(code)
  })
  return true
}

bootCli()
