import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  computePatchCoverage,
  formatPatchCoverageFailure,
  isUnitPath,
  normalizeLcovPath,
  parseAddedLinesFromDiff,
  parseLcov,
} from './check-patch-coverage.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('check-patch-coverage', () => {
  it('parses real lcov fixture and diff hunks', () => {
    const lcov = parseLcov(
      fs.readFileSync(
        path.join(
          here,
          '../../../test/fixtures/real/vitest-lcov-snippet.info',
        ),
        'utf8',
      ),
    )
    expect(lcov.get('scripts/load-gates.mjs')?.get(1)).toBe(1)
    expect(lcov.get('scripts/load-gates.mjs')?.get(3)).toBe(0)
    expect(
      parseAddedLinesFromDiff(
        '+++ b/scripts/foo.mjs\n@@ -10,0 +11,2 @@\n+one\n+two\n',
      ).get('scripts/foo.mjs'),
    ).toEqual([11, 12])
    expect(isUnitPath('scripts/a.mjs')).toBe(true)
    expect(isUnitPath('docs/x.md')).toBe(false)
    expect(normalizeLcovPath('/repo/scripts/a.mjs', '/repo')).toBe(
      'scripts/a.mjs',
    )
  })

  it('fails below threshold with file:lines uncovered', () => {
    const result = computePatchCoverage({
      baseRef: 'BASE',
      diffText: '+++ b/scripts/new.mjs\n@@ -0,0 +1,4 @@\n+a\n+b\n+c\n+d\n',
      lcovText:
        'SF:scripts/new.mjs\nDA:1,1\nDA:2,0\nDA:3,0\nDA:4,0\nend_of_record\n',
      loadGatesFn: () => ({ coverage: { patch: 85 } }),
    })
    expect(result.ok).toBe(false)
    expect(result.percent).toBe(25)
    expect(formatPatchCoverageFailure(result)).toMatch(
      /patch coverage 25\.0% \(scripts\/new\.mjs:2,3,4\)/,
    )
  })

  it('passes when changed lines are covered', () => {
    const result = computePatchCoverage({
      baseRef: 'BASE',
      diffText: '+++ b/src/lib/x.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n',
      lcovText: 'SF:src/lib/x.ts\nDA:1,1\nDA:2,2\nend_of_record\n',
      loadGatesFn: () => ({ coverage: { patch: 85 } }),
    })
    expect(result.ok).toBe(true)
    expect(result.percent).toBe(100)
  })

  it('skips changed lines absent from lcov when the file was instrumented', () => {
    const result = computePatchCoverage({
      baseRef: 'BASE',
      diffText:
        '+++ b/src/lib/x.ts\n@@ -0,0 +1,5 @@\n+import\n+/** c */\n+body\n+}\n+\n',
      lcovText: 'SF:src/lib/x.ts\nDA:3,1\nend_of_record\n',
      loadGatesFn: () => ({ coverage: { patch: 85 } }),
    })
    expect(result.ok).toBe(true)
    expect(result.percent).toBe(100)
    expect(result.covered).toBe(1)
    expect(result.total).toBe(1)
  })

  it('still fails when the whole file is missing from lcov', () => {
    const result = computePatchCoverage({
      baseRef: 'BASE',
      diffText: '+++ b/src/lib/x.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n',
      lcovText: '',
      loadGatesFn: () => ({ coverage: { patch: 85 } }),
    })
    expect(result.ok).toBe(false)
    expect(result.percent).toBe(0)
    expect(result.uncovered[0]?.lines).toEqual([1, 2])
  })
})
