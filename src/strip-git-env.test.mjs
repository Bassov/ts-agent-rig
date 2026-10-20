import { describe, expect, it } from 'vitest'
import { stripGitKeys, stripProcessGitEnv } from './strip-git-env.mjs'

describe('stripGitKeys', () => {
  it('removes every GIT_* key and keeps others', () => {
    const out = stripGitKeys({
      PATH: '/bin',
      GIT_DIR: '/x',
      GIT_WORK_TREE: '/y',
      GIT_SSH_COMMAND: 'ssh',
      HOME: '/home',
    })
    expect(out.PATH).toBe('/bin')
    expect(out.HOME).toBe('/home')
    expect(out.GIT_DIR).toBeUndefined()
    expect(out.GIT_WORK_TREE).toBeUndefined()
    expect(out.GIT_SSH_COMMAND).toBeUndefined()
  })
})

describe('stripProcessGitEnv', () => {
  it('mutates the provided env object in place', () => {
    const env = { GIT_DIR: '/a', KEEP: '1' }
    stripProcessGitEnv(env)
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.KEEP).toBe('1')
  })
})
