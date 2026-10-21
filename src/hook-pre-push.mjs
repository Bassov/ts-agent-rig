#!/usr/bin/env node
/**
 * Lefthook pre-push entry for agent-loop hosts.
 *
 * Strips Lefthook GIT_* from the env, then:
 * - If AGENT_THIN_FINISH=1 and the stage-11 green-tree stamp is current →
 *   skip A+C1 (one OK line) and exit 0.
 * - Else run `pnpm check:integrity && pnpm check:fast`.
 *
 * Hand-push never sets AGENT_THIN_FINISH, so it always pays both inventories.
 * Finish never uses --no-verify / LEFTHOOK=0.
 *
 * Usage: ts-rig-ci hook-pre-push
 */
import { spawnSync } from 'node:child_process'
import { withGitCanary } from './git-hook-canary.mjs'
import { isGreenTreeStampCurrent } from './green-tree-stamp.mjs'
import { resolveRepoRoot } from './resolve-repo-root.mjs'
import { stripProcessGitEnv } from './strip-git-env.mjs'

export const AGENT_THIN_FINISH_ENV = 'AGENT_THIN_FINISH'

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function shouldSkipPrePushChecks(env = process.env) {
  return String(env[AGENT_THIN_FINISH_ENV] ?? '') === '1'
}

/**
 * @param {{
 *   cwd?: string
 *   root?: string
 *   env?: NodeJS.ProcessEnv
 *   spawnSync?: typeof spawnSync
 *   canary?: boolean
 *   write?: (s: string) => void
 *   isStampCurrent?: (root: string) => boolean
 * }} [opts]
 */
export async function main(opts = {}) {
  const env = opts.env ?? process.env
  stripProcessGitEnv(env)
  const cwd = opts.cwd ?? process.cwd()
  const root = opts.root ?? resolveRepoRoot({ cwd })
  const spawn = opts.spawnSync ?? spawnSync
  const write = opts.write ?? ((s) => process.stdout.write(s))
  const runCanary = opts.canary !== false
  const stampOk =
    opts.isStampCurrent?.(root) ?? isGreenTreeStampCurrent(root, { cwd, env })

  const run = () => {
    if (shouldSkipPrePushChecks(env) && stampOk) {
      write(
        'OK pre-push (skipped A+C1: AGENT_THIN_FINISH + green-tree stamp current)\n',
      )
      return 0
    }

    const result = spawn(
      'sh',
      ['-c', 'pnpm check:integrity && pnpm check:fast'],
      {
        cwd,
        env,
        stdio: 'inherit',
        shell: false,
      },
    )
    return result.status ?? 1
  }

  if (!runCanary) return run()
  return withGitCanary(cwd, run)
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith('hook-pre-push.mjs') ||
    process.argv[1].endsWith('hook-pre-push'))

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
