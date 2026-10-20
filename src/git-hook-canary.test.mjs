import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compareCanaryInvariants,
  snapshotCanaryState,
  withGitCanary,
} from './git-hook-canary.mjs'
import { gitExec, initTmpRepo } from './git-test-helper.mjs'

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
  }
})

/** Primary under a private "home" dir so /tmp leak paths sit outside the parent. */
function initHomeRepo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-home-'))
  tmpDirs.push(home)
  const repo = path.join(home, 'repo')
  fs.mkdirSync(repo)
  gitExec(['init'], repo, { stdio: 'ignore' })
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  gitExec(['add', '.'], repo, { stdio: 'ignore' })
  gitExec(['commit', '-m', 'init'], repo, { stdio: 'ignore' })
  gitExec(['branch', '-M', 'main'], repo, { stdio: 'ignore' })
  return { home, repo }
}

/** Root commit with no parents (unrelated history), created in a side worktree. */
function makeOrphanOid(repo) {
  const side = path.join(
    path.dirname(repo),
    `orphan-side-${path.basename(repo)}`,
  )
  gitExec(['worktree', 'add', '--detach', side], repo, { stdio: 'ignore' })
  tmpDirs.push(side)
  gitExec(['checkout', '--orphan', 'tmp-orphan'], side, { stdio: 'ignore' })
  fs.writeFileSync(path.join(side, 'orphan.txt'), 'orphan-root\n')
  gitExec(['add', 'orphan.txt'], side, { stdio: 'ignore' })
  gitExec(['commit', '-m', 'orphan root'], side, { stdio: 'ignore' })
  const oid = String(gitExec(['rev-parse', 'HEAD'], side)).trim()
  gitExec(['checkout', '--detach', oid], side, { stdio: 'ignore' })
  gitExec(['branch', '-D', 'tmp-orphan'], repo, { stdio: 'ignore' })
  gitExec(['worktree', 'remove', '--force', side], repo, { stdio: 'ignore' })
  return oid
}

describe('compareCanaryInvariants (parallel-tolerant)', () => {
  it('passes when another linked worktree commits during the run', async () => {
    const { home, repo } = initHomeRepo()
    const sibling = path.join(home, 'sibling-wt')
    gitExec(['worktree', 'add', sibling, '-b', 'feat/other'], repo, {
      stdio: 'ignore',
    })
    tmpDirs.push(sibling)
    const code = await withGitCanary(repo, () => {
      fs.writeFileSync(path.join(sibling, 'x.txt'), 'from-other\n')
      gitExec(['add', 'x.txt'], sibling, { stdio: 'ignore' })
      gitExec(['commit', '-m', 'other session'], sibling, { stdio: 'ignore' })
      return 0
    })
    expect(code).toBe(0)
  })

  it('passes when a remote-tracking ref is updated', async () => {
    const { repo } = initHomeRepo()
    const code = await withGitCanary(repo, () => {
      gitExec(['update-ref', 'refs/remotes/origin/main', 'HEAD'], repo, {
        stdio: 'ignore',
      })
      return 0
    })
    expect(code).toBe(0)
  })

  it('passes when branch.<name>.remote is added', async () => {
    const { repo } = initHomeRepo()
    const code = await withGitCanary(repo, () => {
      gitExec(['config', 'branch.feat/x.remote', 'origin'], repo, {
        stdio: 'ignore',
      })
      gitExec(['config', 'branch.feat/x.merge', 'refs/heads/feat/x'], repo, {
        stdio: 'ignore',
      })
      return 0
    })
    expect(code).toBe(0)
  })

  it('passes when a sibling worktree is added under the main parent', async () => {
    const { home, repo } = initHomeRepo()
    const sibling = path.join(home, 'new-sibling')
    const code = await withGitCanary(repo, () => {
      gitExec(['worktree', 'add', sibling, '-b', 'feat/sib'], repo, {
        stdio: 'ignore',
      })
      tmpDirs.push(sibling)
      return 0
    })
    expect(code).toBe(0)
  })

  it('fails when core.bare is flipped', async () => {
    const { repo } = initHomeRepo()
    const code = await withGitCanary(repo, () => {
      gitExec(['config', 'core.bare', 'true'], repo, { stdio: 'ignore' })
      return 0
    })
    expect(code).toBe(1)
  })

  it('fails when user.name is added', async () => {
    const { repo } = initHomeRepo()
    const code = await withGitCanary(repo, () => {
      gitExec(['config', 'user.name', 'leaked'], repo, { stdio: 'ignore' })
      return 0
    })
    expect(code).toBe(1)
  })

  it('passes when main fast-forwards while this worktree stays put', async () => {
    const { home, repo } = initHomeRepo()
    gitExec(['checkout', '-b', 'feat/stay'], repo, { stdio: 'ignore' })
    const side = path.join(home, 'ff-side')
    gitExec(['worktree', 'add', side, 'main'], repo, { stdio: 'ignore' })
    tmpDirs.push(side)
    const code = await withGitCanary(repo, () => {
      fs.writeFileSync(path.join(side, 'ff.txt'), 'ff\n')
      gitExec(['add', 'ff.txt'], side, { stdio: 'ignore' })
      gitExec(['commit', '-m', 'ff main'], side, { stdio: 'ignore' })
      return 0
    })
    expect(code).toBe(0)
  })

  it('fails when main is reset to an unrelated commit', async () => {
    const { repo } = initHomeRepo()
    gitExec(['checkout', '-b', 'feat/stay'], repo, { stdio: 'ignore' })
    const orphanOid = makeOrphanOid(repo)
    const code = await withGitCanary(repo, () => {
      gitExec(['update-ref', 'refs/heads/main', orphanOid], repo, {
        stdio: 'ignore',
      })
      return 0
    })
    expect(code).toBe(1)
  })

  it('fails when a worktree is added under os.tmpdir() outside the parent', async () => {
    const { repo } = initHomeRepo()
    const leak = path.join(os.tmpdir(), `canary-leak-${path.basename(repo)}`)
    tmpDirs.push(leak)
    const code = await withGitCanary(repo, () => {
      gitExec(['worktree', 'add', leak, '-b', 'feat/leak'], repo, {
        stdio: 'ignore',
      })
      return 0
    })
    expect(code).toBe(1)
  })

  it('names the broken invariant on failure', () => {
    const { repo } = initHomeRepo()
    const before = snapshotCanaryState(repo)
    gitExec(['config', 'user.email', 'x@y.z'], repo, { stdio: 'ignore' })
    const after = snapshotCanaryState(repo)
    const msg = compareCanaryInvariants(before, after)
    expect(msg).toMatch(/local-config \(non-branch\): user\.email/)
  })
})

describe('withGitCanary smoke', () => {
  it('passes on an unchanged tmp repo from initTmpRepo', async () => {
    const repo = initTmpRepo(tmpDirs)
    expect(await withGitCanary(repo, () => 0)).toBe(0)
  })
})
