import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExec, initTmpRepo } from './git-test-helper.mjs'
import {
  computeGreenTreeId,
  greenTreeStampPath,
  isGreenTreeStampCurrent,
  readGreenTreeStamp,
  writeGreenTreeStamp,
} from './green-tree-stamp.mjs'

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
  }
})

function seededRepo() {
  const root = initTmpRepo(tmpDirs, { prefix: 'green-stamp-' })
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n')
  gitExec(['add', 'a.txt'], root)
  gitExec(['commit', '-m', 'init'], root)
  return root
}

describe('green-tree-stamp', () => {
  it('write/read round-trip and isGreenTreeStampCurrent', () => {
    const root = seededRepo()
    expect(readGreenTreeStamp(root)).toBeNull()
    expect(isGreenTreeStampCurrent(root)).toBe(false)

    const id = writeGreenTreeStamp(root)
    expect(id).toMatch(/^[a-f0-9]{64}$/)
    expect(readGreenTreeStamp(root)).toBe(id)
    expect(isGreenTreeStampCurrent(root)).toBe(true)
    expect(fs.readFileSync(greenTreeStampPath(root), 'utf8')).toBe(`${id}\n`)
  })

  it('becomes stale when working tree changes', () => {
    const root = seededRepo()
    writeGreenTreeStamp(root)
    expect(isGreenTreeStampCurrent(root)).toBe(true)

    fs.writeFileSync(path.join(root, 'a.txt'), 'two\n')
    expect(isGreenTreeStampCurrent(root)).toBe(false)
  })

  it('becomes stale when HEAD moves', () => {
    const root = seededRepo()
    writeGreenTreeStamp(root)
    fs.writeFileSync(path.join(root, 'b.txt'), 'x\n')
    gitExec(['add', 'b.txt'], root)
    gitExec(['commit', '-m', 'second'], root)
    expect(isGreenTreeStampCurrent(root)).toBe(false)
  })

  it('computeGreenTreeId matches stamp written for the same tree', () => {
    const root = seededRepo()
    const before = computeGreenTreeId(root)
    const written = writeGreenTreeStamp(root)
    expect(written).toBe(before)
    expect(computeGreenTreeId(root)).toBe(before)
  })

  it('uses injectable exec for identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'green-stamp-fake-'))
    tmpDirs.push(root)
    const calls = []
    const exec = (file, args) => {
      calls.push([file, [...args]])
      const key = args.join(' ')
      if (key === 'rev-parse HEAD') return { code: 0, stdout: 'abc123\n' }
      if (key === 'status --porcelain=v1') return { code: 0, stdout: ' M x\n' }
      if (key === 'diff') return { code: 0, stdout: 'diff --git a\n' }
      if (key === 'diff --cached') return { code: 0, stdout: '' }
      return { code: 1, stderr: `unhandled ${key}` }
    }
    const id = writeGreenTreeStamp(root, { exec })
    expect(id).toMatch(/^[a-f0-9]{64}$/)
    expect(isGreenTreeStampCurrent(root, { exec })).toBe(true)
    expect(calls.some((c) => c[1].includes('--porcelain=v1'))).toBe(true)
  })
})
