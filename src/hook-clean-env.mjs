#!/usr/bin/env node
/**
 * Lefthook / CI entry: strip every GIT_* from the process env, then run the
 * given command. After the command, compare a local git snapshot of cwd so a
 * future test leak cannot mutate the real repo unnoticed.
 *
 * Usage: node scripts/hook-clean-env.mjs <cmd> [args...]
 */
import { spawnSync } from 'node:child_process'
import { withGitCanary } from './git-hook-canary.mjs'
import { stripProcessGitEnv } from './strip-git-env.mjs'

export function parseHookArgs(argv) {
  const args = argv.slice(2)
  if (args.length === 0) {
    throw new Error(
      'usage: node scripts/hook-clean-env.mjs <command> [args...]',
    )
  }
  return { command: args[0], commandArgs: args.slice(1) }
}

/**
 * @param {string[]} argv
 * @param {{
 *   cwd?: string
 *   env?: NodeJS.ProcessEnv
 *   spawnSync?: typeof spawnSync
 *   canary?: boolean
 * }} [opts]
 */
export async function main(argv = process.argv, opts = {}) {
  const env = opts.env ?? process.env
  stripProcessGitEnv(env)
  const { command, commandArgs } = parseHookArgs(argv)
  const cwd = opts.cwd ?? process.cwd()
  const spawn = opts.spawnSync ?? spawnSync
  const runCanary = opts.canary !== false

  const run = () => {
    const result = spawn(command, commandArgs, {
      cwd,
      env,
      stdio: 'inherit',
      shell: false,
    })
    return result.status ?? 1
  }

  if (!runCanary) return run()
  return withGitCanary(cwd, run)
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith('hook-clean-env.mjs') ||
    process.argv[1].endsWith('hook-clean-env'))

if (isDirect) {
  main()
    .then((code) => {
      process.exit(code)
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
