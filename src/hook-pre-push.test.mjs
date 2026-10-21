import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { initTmpRepo } from './git-test-helper.mjs'
import {
  AGENT_THIN_FINISH_ENV,
  main as hookPrePushMain,
  shouldSkipPrePushChecks,
} from './hook-pre-push.mjs'

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
  }
})

describe('shouldSkipPrePushChecks', () => {
  it('is true only when AGENT_THIN_FINISH=1', () => {
    expect(shouldSkipPrePushChecks({})).toBe(false)
    expect(shouldSkipPrePushChecks({ [AGENT_THIN_FINISH_ENV]: '0' })).toBe(
      false,
    )
    expect(shouldSkipPrePushChecks({ [AGENT_THIN_FINISH_ENV]: '1' })).toBe(
      true,
    )
  })
})

describe('hook-pre-push', () => {
  it('skips A+C1 when AGENT_THIN_FINISH=1 and stamp is current', async () => {
    const repo = initTmpRepo(tmpDirs)
    const lines = []
    let spawned = false
    const code = await hookPrePushMain({
      cwd: repo,
      root: repo,
      canary: false,
      env: {
        PATH: process.env.PATH,
        [AGENT_THIN_FINISH_ENV]: '1',
        GIT_DIR: '/should-not-leak',
      },
      isStampCurrent: () => true,
      write: (s) => lines.push(String(s)),
      spawnSync: () => {
        spawned = true
        return { status: 0 }
      },
    })
    expect(code).toBe(0)
    expect(spawned).toBe(false)
    expect(lines.join('')).toMatch(/skipped A\+C1/)
  })

  it('runs integrity && check:fast when stamp is missing even with AGENT_THIN_FINISH', async () => {
    const repo = initTmpRepo(tmpDirs)
    /** @type {{ cmd: string, args: string[], env: NodeJS.ProcessEnv } | null} */
    let seen = null
    const code = await hookPrePushMain({
      cwd: repo,
      root: repo,
      canary: false,
      env: {
        PATH: process.env.PATH,
        [AGENT_THIN_FINISH_ENV]: '1',
        GIT_DIR: '/decoy',
      },
      isStampCurrent: () => false,
      spawnSync: (cmd, args, opts) => {
        seen = { cmd, args: [...args], env: opts.env }
        return { status: 0 }
      },
    })
    expect(code).toBe(0)
    expect(seen?.cmd).toBe('sh')
    expect(seen?.args).toEqual([
      '-c',
      'pnpm check:integrity && pnpm check:fast',
    ])
    expect(seen?.env.GIT_DIR).toBeUndefined()
  })

  it('runs checks on hand-push (no AGENT_THIN_FINISH) even when stamp is current', async () => {
    const repo = initTmpRepo(tmpDirs)
    let spawned = false
    const code = await hookPrePushMain({
      cwd: repo,
      root: repo,
      canary: false,
      env: { PATH: process.env.PATH },
      isStampCurrent: () => true,
      spawnSync: () => {
        spawned = true
        return { status: 7 }
      },
    })
    expect(spawned).toBe(true)
    expect(code).toBe(7)
  })
})
