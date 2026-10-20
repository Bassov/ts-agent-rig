/**
 * Strip every GIT_* key so Lefthook / ambient hooks cannot redirect git
 * via GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, etc.
 */

/** @param {NodeJS.ProcessEnv} [env] */
export function stripGitKeys(env = process.env) {
  const out = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('GIT_')) delete out[key]
  }
  return out
}

/** Mutate `process.env` in place (Vitest setup / hook entry). */
export function stripProcessGitEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
}
