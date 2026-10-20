#!/usr/bin/env node
/**
 * Fail verify/CI when a test file spawns `git` directly instead of using
 * `scripts/git-test-helper.mjs`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Literal git process spawns / execs in test sources. */
export const DIRECT_GIT_SPAWN_PATTERNS = [
  /\bexecFileSync\s*\(\s*['"]git['"]/,
  /\bexecFile\s*\(\s*['"]git['"]/,
  /\bexecSync\s*\(\s*['"]git['"]/,
  /\bexec\s*\(\s*['"]git(?:\s|['"])/,
  /\bspawnSync\s*\(\s*['"]git['"]/,
  /\bspawn\s*\(\s*['"]git['"]/,
]

const TEST_FILE_RE = /\.(test|spec)\.(mjs|js|ts|tsx)$/

/**
 * @param {string} source
 * @returns {{ index: number, match: string }[]}
 */
export function findDirectGitSpawns(source) {
  const hits = []
  for (const pattern of DIRECT_GIT_SPAWN_PATTERNS) {
    pattern.lastIndex = 0
    const flags = pattern.flags.includes('g')
      ? pattern.flags
      : `${pattern.flags}g`
    const global = new RegExp(pattern.source, flags)
    let m
    while ((m = global.exec(source)) !== null) {
      hits.push({ index: m.index, match: m[0] })
    }
  }
  return hits
}

/**
 * @param {string} root
 * @param {{ roots?: string[] }} [opts]
 * @returns {string[]}
 */
export function listTestFiles(root, opts = {}) {
  const roots = opts.roots ?? ['scripts', 'src', 'e2e']
  /** @type {string[]} */
  const out = []
  for (const rel of roots) {
    const abs = join(root, rel)
    try {
      if (!statSync(abs).isDirectory()) continue
    } catch {
      continue
    }
    walk(abs, out)
  }
  return out.sort()
}

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (TEST_FILE_RE.test(name)) out.push(full)
  }
}

/**
 * @param {string} root
 * @returns {{ file: string, match: string }[]}
 */
export function scanTestTreeForDirectGit(root = process.cwd()) {
  /** @type {{ file: string, match: string }[]} */
  const violations = []
  for (const file of listTestFiles(root)) {
    const source = readFileSync(file, 'utf8')
    for (const hit of findDirectGitSpawns(source)) {
      violations.push({
        file: relative(root, file).replaceAll('\\', '/'),
        match: hit.match,
      })
    }
  }
  return violations
}

export function main(root = process.cwd()) {
  const violations = scanTestTreeForDirectGit(root)
  if (violations.length > 0) {
    const lines = violations.map((v) => `  ${v.file}: ${v.match}`)
    console.error(
      'Direct git spawn/exec in test files (use scripts/git-test-helper.mjs):\n' +
        lines.join('\n'),
    )
    return 1
  }
  console.log('No direct git spawns in test files.')
  return 0
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith('check-no-direct-git-in-tests.mjs') ||
    process.argv[1].endsWith('check-no-direct-git-in-tests'))

if (isDirect) {
  process.exit(main())
}
