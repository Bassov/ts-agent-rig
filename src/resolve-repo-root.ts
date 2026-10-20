/**
 * Resolve the host repository root when the rig lives under node_modules
 * or packages/ts-agent-rig (not under <host>/scripts/).
 */
import { existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { spawnSync } from 'node:child_process'

function walkForGates(start: string): string | null {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, 'quality', 'gates.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir || parse(parent).root === parent) return null
    dir = parent
  }
}

export function resolveRepoRoot(opts: {
  cwd?: string
  env?: NodeJS.ProcessEnv
} = {}): string {
  const env = opts.env ?? process.env
  const fromEnv = env.TS_RIG_REPO_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim()
  }
  const cwd = opts.cwd ?? process.cwd()
  const walked = walkForGates(cwd)
  if (walked) return walked
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  })
  if (git.status === 0 && typeof git.stdout === 'string') {
    const top = git.stdout.trim()
    if (top) return top
  }
  return cwd
}
