import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GIT_TEST_AUTHOR_EMAIL,
  GIT_TEST_AUTHOR_NAME,
  diffGitSnapshots,
  gitExec,
  gitTestEnv,
  initTmpRepo,
  snapshotGitState,
} from './git-test-helper.mjs'
import { defaultExec } from './agent.mjs'

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
  }
})

describe('gitTestEnv', () => {
  it('strips ambient GIT_* and sets null config + fixed author', () => {
    const env = gitTestEnv({
      GIT_DIR: '/decoy/.git',
      GIT_WORK_TREE: '/decoy',
      PATH: '/bin',
    })
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.PATH).toBe('/bin')
    expect(env.GIT_CONFIG_GLOBAL).toMatch(/null|NUL/i)
    expect(env.GIT_CONFIG_SYSTEM).toMatch(/null|NUL/i)
    expect(env.GIT_AUTHOR_NAME).toBe(GIT_TEST_AUTHOR_NAME)
    expect(env.GIT_AUTHOR_EMAIL).toBe(GIT_TEST_AUTHOR_EMAIL)
  })
})

describe('initTmpRepo / gitExec', () => {
  it('requires cwd and does not write user.* via config', () => {
    expect(() => gitExec(['status'], '')).toThrow(/explicit cwd/)
    const repo = initTmpRepo(tmpDirs)
    const snap = snapshotGitState(repo)
    expect(snap.config).not.toMatch(/user\.name/)
    expect(snap.config).not.toMatch(/user\.email/)
    const log = String(
      gitExec(['log', '-1', '--format=%an <%ae>'], repo),
    ).trim()
    expect(log).toBe(`${GIT_TEST_AUTHOR_NAME} <${GIT_TEST_AUTHOR_EMAIL}>`)
  })
})

describe('sentinel regression', () => {
  it('helper flow leaves a sentinel repo byte-identical under polluted GIT_DIR', () => {
    const sentinel = initTmpRepo(tmpDirs, {
      prefix: 'git-sentinel-',
      seedFiles: { 'keep.txt': 'sentinel\n' },
    })
    // Distinct local config the fixture must not touch.
    gitExec(['config', 'user.name', 'sentinel-owner'], sentinel, {
      stdio: 'ignore',
    })
    gitExec(['config', 'user.email', 'sentinel@example.com'], sentinel, {
      stdio: 'ignore',
    })
    const before = snapshotGitState(sentinel)
    expect(before.config).toContain('user.name=sentinel-owner')
    expect(before.config).toContain('user.email=sentinel@example.com')

    const sentinelGit = path.join(sentinel, '.git')
    const polluted = {
      GIT_DIR: sentinelGit,
      GIT_WORK_TREE: sentinel,
    }
    process.env.GIT_DIR = sentinelGit
    process.env.GIT_WORK_TREE = sentinel
    try {
      const primary = initTmpRepo(tmpDirs)
      gitExec(['branch', '-M', 'main'], primary, {
        stdio: 'ignore',
        env: polluted,
      })
      const wt = path.join(
        os.tmpdir(),
        `git-sentinel-wt-${path.basename(primary)}`,
      )
      tmpDirs.push(wt)
      gitExec(['worktree', 'add', wt, '-b', 'feat/proof'], primary, {
        stdio: 'ignore',
        env: polluted,
      })
      fs.writeFileSync(path.join(wt, 'extra.txt'), 'x\n')
      gitExec(['add', 'extra.txt'], wt, { stdio: 'ignore', env: polluted })
      gitExec(['commit', '-m', 'proof'], wt, {
        stdio: 'ignore',
        env: polluted,
      })
      const r = defaultExec('git', ['rev-parse', '--show-toplevel'], {
        cwd: primary,
        env: { ...process.env, ...polluted },
      })
      expect(r.code).toBe(0)
      expect(path.resolve(r.stdout.trim())).toBe(path.resolve(primary))
    } finally {
      delete process.env.GIT_DIR
      delete process.env.GIT_WORK_TREE
    }

    const after = snapshotGitState(sentinel)
    expect(after).toEqual(before)
    expect(diffGitSnapshots(before, after)).toBe(null)
  })
})

describe('diffGitSnapshots', () => {
  it('returns null when unchanged and a diff when refs change', () => {
    const repo = initTmpRepo(tmpDirs)
    const before = snapshotGitState(repo)
    expect(diffGitSnapshots(before, before)).toBe(null)
    gitExec(['checkout', '-b', 'feat/moved'], repo, { stdio: 'ignore' })
    const after = snapshotGitState(repo)
    const diff = diffGitSnapshots(before, after)
    expect(diff).toMatch(/refs/)
  })

  it('fails when local config changes', () => {
    const repo = initTmpRepo(tmpDirs)
    const before = snapshotGitState(repo)
    gitExec(['config', 'leak.mark', '1'], repo, { stdio: 'ignore' })
    expect(diffGitSnapshots(before, snapshotGitState(repo))).toMatch(/config/)
  })
})
