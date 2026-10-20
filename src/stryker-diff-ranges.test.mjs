import { describe, expect, it } from 'vitest'
import {
  buildMutateSpecsFromDiff,
  filterReportToScoredRanges,
  formatMutateSpecs,
  lineInRanges,
  mergeLineRanges,
  mutateSpecPath,
  parseUnifiedDiffRanges,
} from './stryker-diff-ranges.mjs'

describe('stryker-diff-ranges', () => {
  it('parses unified hunks into new-side ranges', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,0 +11,2 @@',
      '+const x = 1',
      '+const y = 2',
      '@@ -40,1 +42,1 @@',
      '-old',
      '+new',
    ].join('\n')
    const map = parseUnifiedDiffRanges(diff)
    expect(map.get('src/a.ts')).toEqual([
      { start: 11, end: 12 },
      { start: 42, end: 42 },
    ])
  })

  it('ignores pure deletions', () => {
    const diff = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -5,2 +5,0 @@',
      '-gone',
      '-also',
    ].join('\n')
    const map = parseUnifiedDiffRanges(diff)
    expect(map.get('src/a.ts') ?? []).toEqual([])
  })

  it('merges overlapping and adjacent ranges', () => {
    expect(
      mergeLineRanges([
        { start: 10, end: 12 },
        { start: 13, end: 15 },
        { start: 20, end: 21 },
        { start: 11, end: 11 },
      ]),
    ).toEqual([
      { start: 10, end: 15 },
      { start: 20, end: 21 },
    ])
  })

  it('formats mutate specs as path:start-end', () => {
    expect(formatMutateSpecs('src/a.ts', [{ start: 3, end: 5 }])).toEqual([
      'src/a.ts:3-5',
    ])
  })

  it('builds specs from diff; empty when only deletions', () => {
    const diff = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,0 @@',
      '-x',
    ].join('\n')
    const r = buildMutateSpecsFromDiff(['src/a.ts'], diff)
    expect(r.empty).toBe(true)
    expect(r.specs).toEqual([])
  })

  it('falls back to whole-file range for untracked files', () => {
    const r = buildMutateSpecsFromDiff(
      ['src/new.ts'],
      '',
      new Map([['src/new.ts', 4]]),
    )
    expect(r.empty).toBe(false)
    expect(r.specs).toEqual(['src/new.ts:1-4'])
  })

  it('filters report mutants to scored ranges only', () => {
    const ranges = new Map([['src/a.ts', [{ start: 10, end: 12 }]]])
    const scored = filterReportToScoredRanges(
      {
        'src/a.ts': {
          mutants: [
            { status: 'NoCoverage', location: { start: { line: 11 } } },
            { status: 'NoCoverage', location: { start: { line: 99 } } },
            { status: 'Killed', location: { start: { line: 10 } } },
          ],
        },
        'src/other.ts': {
          mutants: [
            { status: 'NoCoverage', location: { start: { line: 1 } } },
          ],
        },
      },
      ranges,
    )
    expect(scored['src/other.ts']).toBeUndefined()
    expect(scored['src/a.ts'].mutants).toHaveLength(2)
    expect(
      scored['src/a.ts'].mutants.every((m) =>
        lineInRanges(m.location?.start?.line, ranges.get('src/a.ts') ?? []),
      ),
    ).toBe(true)
  })

  it('strips range suffix from mutate specs', () => {
    expect(mutateSpecPath('src/a.ts:10-20')).toBe('src/a.ts')
    expect(mutateSpecPath('src/a.ts')).toBe('src/a.ts')
  })
})
