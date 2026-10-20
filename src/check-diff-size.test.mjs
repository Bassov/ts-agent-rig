import { describe, expect, it } from 'vitest'
import {
  checkPlanSize,
  computeDiffSize,
  isExcludedDiffPath,
  parseNumstat,
  parsePlanSizeEstimate,
  runDiffSizeCheck,
} from './check-diff-size.mjs'

describe('check-diff-size', () => {
  it('excludes lockfile, openspec/changes, uikit, binaries', () => {
    expect(isExcludedDiffPath('pnpm-lock.yaml')).toBe(true)
    expect(isExcludedDiffPath('openspec/changes/foo/tasks.md')).toBe(true)
    expect(isExcludedDiffPath('uikit/src/a.ts')).toBe(true)
    expect(isExcludedDiffPath('src/x.png')).toBe(true)
    expect(isExcludedDiffPath('scripts/a.mjs')).toBe(false)
  })

  it('counts numstat lines and stays advisory when over prefer max', () => {
    const text = [
      '10\t2\tscripts/a.mjs',
      '100\t0\tpnpm-lock.yaml',
      '5\t5\tuikit/x.ts',
      '-\t-\tsrc/photo.png',
    ].join('\n')
    const r = computeDiffSize({
      numstatText: text,
      max: 20,
    })
    expect(r.lines).toBe(12)
    expect(r.ok).toBe(true)
    expect(r.overMax).toBe(false)
    const over = computeDiffSize({ numstatText: text, max: 10 })
    expect(over.ok).toBe(true)
    expect(over.overMax).toBe(true)
    expect(over.reason).toMatch(/prefer ≤10/)
    expect(parseNumstat('3\t1\told => new.mjs\n')).toEqual([
      { file: 'new.mjs', added: 3, deleted: 1 },
    ])
  })

  it('skips without failing when merge-base is unavailable', () => {
    const r = computeDiffSize({
      git: () => ({
        status: 128,
        stdout: '',
        stderr: 'fatal: Not a valid object name origin/main',
      }),
    })
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe(true)
    expect(r.reason).toMatch(/merge-base unavailable/)
    const out = []
    expect(
      runDiffSizeCheck({
        git: () => ({
          status: 128,
          stdout: '',
          stderr: 'fatal: Not a valid object name origin/main',
        }),
        write: (s) => out.push(s),
      }),
    ).toBe(0)
    expect(out.join('')).toMatch(/diff-size: warn — skipped/)
  })

  it('parses plan size estimate as advisory', () => {
    expect(
      parsePlanSizeEstimate('**Size estimate:** 400 prod + 600 tests = 1000\n'),
    ).toBe(1000)
    const over = checkPlanSize({
      proposalText: '**Size estimate:** 900 prod + 800 tests = 1700\n',
    })
    expect(over.ok).toBe(true)
    expect(over.overMax).toBe(true)
    expect(over.reason).toMatch(/prefer ≤1500/)
    expect(
      checkPlanSize({
        proposalText: '**Size estimate:** 400 prod + 400 tests = 800\n',
      }).ok,
    ).toBe(true)
    const missing = checkPlanSize({ proposalText: 'no estimate line\n' })
    expect(missing.ok).toBe(true)
    expect(missing.reason).toMatch(/advisory/)
  })
})
