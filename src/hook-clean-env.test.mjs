import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  diffGitSnapshots,
  initTmpRepo,
  snapshotGitState,
} from './git-test-helper.mjs'
import { main as hookMain, parseHookArgs } from './hook-clean-env.mjs'
import { withGitCanary } from './git-hook-canary.mjs'

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
  }
})

describe('parseHookArgs', () => {
  it('requires a command', () => {
    expect(() => parseHookArgs(['node', 'hook-clean-env.mjs'])).toThrow(/usage/)
    expect(
      parseHookArgs(['node', 'hook-clean-env.mjs', 'pnpm', 'verify:fast']),
    ).toEqual({
      command: 'pnpm',
      commandArgs: ['verify:fast'],
    })
  })
})

describe('hook-clean-env', () => {
  it('strips GIT_* before spawning the child', async () => {
    const seen = { env: null }
    const code = await hookMain(['node', 'hook-clean-env.mjs', 'true'], {
      canary: false,
      env: {
        PATH: process.env.PATH,
        GIT_DIR: '/should-not-leak',
        GIT_WORK_TREE: '/nope',
        HOME: process.env.HOME,
      },
      spawnSync: (_cmd, _args, opts) => {
        seen.env = opts.env
        return { status: 0 }
      },
    })
    expect(code).toBe(0)
    expect(seen.env.GIT_DIR).toBeUndefined()
    expect(seen.env.GIT_WORK_TREE).toBeUndefined()
  })

  it('canary fails when non-branch local config mutates', async () => {
    const repo = initTmpRepo(tmpDirs)
    const code = await withGitCanary(repo, () => {
      fs.writeFileSync(
        `${repo}/.git/config`,
        fs.readFileSync(`${repo}/.git/config`, 'utf8') +
          '\n[leak]\n\tmark = 1\n',
      )
      return 0
    })
    expect(code).toBe(1)
  })

  it('canary ok when state is unchanged', async () => {
    const repo = initTmpRepo(tmpDirs)
    const before = snapshotGitState(repo)
    const code = await withGitCanary(repo, () => 0)
    expect(code).toBe(0)
    expect(diffGitSnapshots(before, snapshotGitState(repo))).toBe(null)
  })

  it('main with canary runs command then compares', async () => {
    const repo = initTmpRepo(tmpDirs)
    const code = await hookMain(
      ['node', 'hook-clean-env.mjs', 'node', '-e', ''],
      {
        cwd: repo,
        env: { ...process.env, GIT_DIR: '/decoy' },
        spawnSync: () => ({ status: 0 }),
      },
    )
    expect(code).toBe(0)
  })
})
