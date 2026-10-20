import { describe, expect, it } from 'vitest'
import {
  excludeFlakyFromTargets,
  flakyTestDirGlobs,
  loadFlakySpecPaths,
  normalizeFlakyPath,
} from './e2e-flaky-list.mjs'

function gatesWithFlaky(flakySpecs) {
  return {
    coverage: {
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80,
    },
    stryker: {
      thresholds: { high: 80, low: 60, break: 60 },
      diffThresholds: { high: 90, low: 85, break: 85 },
    },
    mutation: { disableBudget: 0, temporaryExcludes: [] },
    lighthouse: {
      numberOfRuns: 1,
      assertions: { 'performance-budget': 'error' },
      budgets: [],
    },
    playwright: { retries: 0, flakyRetries: 2 },
    e2e: { burnInDefault: 10, flakySpecs },
  }
}

describe('normalizeFlakyPath', () => {
  it('trims and normalizes separators', () => {
    expect(normalizeFlakyPath(' ./e2e\\foo.spec.ts ')).toBe('e2e/foo.spec.ts')
  })
})

describe('loadFlakySpecPaths', () => {
  it('returns sorted unique paths from gates', () => {
    const paths = loadFlakySpecPaths({
      loadGatesFn: () =>
        gatesWithFlaky(['e2e/b.spec.ts', 'e2e/a.spec.ts', 'e2e/a.spec.ts']),
    })
    expect(paths).toEqual(['e2e/a.spec.ts', 'e2e/b.spec.ts'])
  })

  it('rejects non-spec paths', () => {
    expect(() =>
      loadFlakySpecPaths({
        loadGatesFn: () => gatesWithFlaky(['e2e/helpers/x.ts']),
      }),
    ).toThrow(/e2e\/\*\*\/\*\.spec\.ts/)
  })
})

describe('flakyTestDirGlobs', () => {
  it('strips e2e/ prefix', () => {
    expect(flakyTestDirGlobs(['e2e/drag-swap.spec.ts'])).toEqual([
      'drag-swap.spec.ts',
    ])
  })
})

describe('excludeFlakyFromTargets', () => {
  it('drops listed paths', () => {
    expect(
      excludeFlakyFromTargets(
        ['e2e/a.spec.ts', 'e2e/b.spec.ts', 'e2e/c.spec.ts'],
        ['e2e/b.spec.ts'],
      ),
    ).toEqual(['e2e/a.spec.ts', 'e2e/c.spec.ts'])
  })
})
