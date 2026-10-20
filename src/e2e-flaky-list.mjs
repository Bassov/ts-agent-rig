import { loadGates } from './load-gates.mjs'

/**
 * @param {string} path
 */
export function normalizeFlakyPath(path) {
  return String(path).trim().replaceAll('\\', '/').replace(/^\.\//, '')
}

/**
 * Load repo-relative spec paths from quality/gates.json (`e2e.flakySpecs`).
 * @param {{
 *   root?: string,
 *   loadGatesFn?: typeof loadGates,
 * }} [io]
 * @returns {string[]}
 */
export function loadFlakySpecPaths(io = {}) {
  const load = io.loadGatesFn ?? loadGates
  const gates = load(io.root !== undefined ? { root: io.root } : {})
  const raw = gates.e2e.flakySpecs
  const paths = raw.map(normalizeFlakyPath).filter((path) => path.length > 0)
  for (const path of paths) {
    if (!path.startsWith('e2e/') || !path.endsWith('.spec.ts')) {
      throw new Error(
        `e2e.flakySpecs entry must be an e2e/**/*.spec.ts path, got ${path}`,
      )
    }
  }
  return [...new Set(paths)].sort()
}

/**
 * Playwright testDir-relative globs for listed specs.
 * @param {string[]} repoPaths
 */
export function flakyTestDirGlobs(repoPaths) {
  return repoPaths.map((path) =>
    path.startsWith('e2e/') ? path.slice('e2e/'.length) : path,
  )
}

/**
 * @param {string[]} targets
 * @param {string[]} flakyPaths
 */
export function excludeFlakyFromTargets(targets, flakyPaths) {
  const blocked = new Set(flakyPaths.map(normalizeFlakyPath))
  return targets.map(normalizeFlakyPath).filter((path) => !blocked.has(path))
}
