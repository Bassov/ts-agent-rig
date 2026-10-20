import { describe, expect, it } from 'vitest'
import {
  findDirectGitSpawns,
  main,
  scanTestTreeForDirectGit,
} from './check-no-direct-git-in-tests.mjs'

describe('findDirectGitSpawns', () => {
  it('flags direct spawn/exec of git and ignores the helper import', () => {
    expect(
      findDirectGitSpawns(
        `import { gitExec } from './git-test-helper.mjs'\ngitExec(['status'], cwd)`,
      ),
    ).toEqual([])
    // Build violator strings without embedding the forbidden call shape in this file.
    const q = "'"
    const execFileSyncGit = ['execFileSync(', q, 'git', q, ', args)'].join('')
    const spawnSyncGit = ['spawnSync(', q, 'git', q, ', args)'].join('')
    const execGit = ['exec(', q, 'git status', q, ', cb)'].join('')
    expect(findDirectGitSpawns(execFileSyncGit)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          match: expect.stringContaining('execFileSync'),
        }),
      ]),
    )
    expect(findDirectGitSpawns(spawnSyncGit)).not.toEqual([])
    expect(findDirectGitSpawns(execGit)).not.toEqual([])
  })
})

describe('scanTestTreeForDirectGit', () => {
  it('passes on this repository (tests use the shared helper)', () => {
    expect(scanTestTreeForDirectGit(process.cwd())).toEqual([])
    expect(main(process.cwd())).toBe(0)
  })
})
