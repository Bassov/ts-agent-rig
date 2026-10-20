import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRepoRoot } from '../../src/resolve-repo-root.ts'
import { initTmpRepo } from '../../src/git-test-helper.mjs'

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

describe('resolveRepoRoot integration', () => {
  it('walks up to quality/gates.json in a real temp tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rig-root-'))
    tmpDirs.push(root)
    fs.mkdirSync(path.join(root, 'quality'))
    fs.writeFileSync(path.join(root, 'quality', 'gates.json'), '{}')
    const nested = path.join(root, 'packages', 'app')
    fs.mkdirSync(nested, { recursive: true })
    expect(resolveRepoRoot({ cwd: nested, env: {} })).toBe(root)
  })

  it('uses git toplevel when gates are absent', () => {
    const root = initTmpRepo(tmpDirs)
    expect(resolveRepoRoot({ cwd: root, env: {} })).toBe(root)
  })
})
