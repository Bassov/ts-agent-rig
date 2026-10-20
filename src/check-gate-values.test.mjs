import { describe, expect, it } from 'vitest'
import {
  checkGateValues,
  consumerReferencesGates,
  deepEqual,
  findHardcodedGateLiterals,
  workflowHardcodesBurnIn,
} from './check-gate-values.mjs'

const validGates = {
  coverage: {
    statements: 80,
    branches: 80,
    functions: 80,
    lines: 80,
    patch: 85,
  },
  stryker: { thresholds: { high: 80, low: 60, break: 60 } },
  lighthouse: {
    numberOfRuns: 1,
    assertions: { 'performance-budget': 'error' },
    budgets: [{ path: '/*' }],
  },
  playwright: { retries: 0, flakyRetries: 2 },
  e2e: { burnInDefault: 10, flakySpecs: [] },
}

function coherentFiles(overrides = {}) {
  return {
    '/repo/quality/gates.json': JSON.stringify(validGates),
    '/repo/budget.json': JSON.stringify(validGates.lighthouse.budgets),
    '/repo/e2e/flaky.json': '[]',
    '/repo/vite.config.ts':
      "import { loadGates } from '@albasov/ts-agent-rig/load-gates'\nthresholds: gates.coverage",
    '/repo/stryker.config.mjs':
      "import { loadGates } from '@albasov/ts-agent-rig/load-gates'\nthresholds: gates.stryker.thresholds",
    '/repo/lighthouserc.cjs':
      'quality/gates.json\nnumberOfRuns: gates.lighthouse.numberOfRuns\nassertions: gates.lighthouse.assertions',
    '/repo/playwright.config.ts':
      "import { loadGates } from '@albasov/ts-agent-rig/load-gates'\nretries: gates.playwright.retries\nretries: gates.playwright.flakyRetries",
    '/repo/packages/ts-agent-rig/src/e2e-burn-in-count.mjs':
      "import { loadGates } from './load-gates.mjs'\nload({ root }).e2e.burnInDefault",
    '/repo/packages/ts-agent-rig/src/e2e-flaky-list.mjs':
      "import { loadGates } from './load-gates.mjs'",
    '/repo/packages/ts-agent-rig/src/load-gates.mjs':
      "export const GATES_RELATIVE_PATH = 'quality/gates.json'",
    '/repo/packages/ts-agent-rig/src/check-patch-coverage.mjs':
      "import { loadGates } from './load-gates.mjs'\nloadGates().coverage.patch",
    '/repo/.github/workflows/integration.yml': 'jobs: {}',
    ...overrides,
  }
}

describe('deepEqual', () => {
  it('compares JSON values', () => {
    expect(deepEqual([], [])).toBe(true)
    expect(deepEqual([1], [])).toBe(false)
  })
})

describe('consumerReferencesGates', () => {
  it('detects load-gates and gates.json', () => {
    expect(
      consumerReferencesGates("import { loadGates } from './load-gates.mjs'"),
    ).toBe(true)
    expect(consumerReferencesGates("readFileSync('quality/gates.json')")).toBe(
      true,
    )
    expect(consumerReferencesGates('const x = 1')).toBe(false)
  })
})

describe('findHardcodedGateLiterals', () => {
  it('flags a bare coverage threshold object', () => {
    expect(
      findHardcodedGateLiterals(
        'thresholds: { statements: 80, branches: 80 }',
        'vite.config.ts',
      ),
    ).toContain('coverage-thresholds-object')
  })

  it('flags unquoted stryker thresholds object', () => {
    expect(
      findHardcodedGateLiterals(
        'thresholds: { high: 80, low: 60, break: 60 }',
        'stryker.config.mjs',
      ),
    ).toContain('stryker-thresholds-object')
  })

  it('allows playwright retries from gates', () => {
    expect(
      findHardcodedGateLiterals(
        'retries: gates.playwright.retries\nflakyRetries: gates.playwright.flakyRetries',
        'playwright.config.ts',
      ),
    ).toEqual([])
  })
})

describe('workflowHardcodesBurnIn', () => {
  it('detects hardcoded E2E_BURN_IN', () => {
    expect(workflowHardcodesBurnIn("E2E_BURN_IN: '10'")).toBe(true)
    expect(workflowHardcodesBurnIn('jobs:\n  e2e:')).toBe(false)
  })
})

describe('checkGateValues', () => {
  it('fails when budget mirror diverges', () => {
    const files = coherentFiles({
      '/repo/budget.json': JSON.stringify([{ path: '/other' }]),
    })
    const result = checkGateValues({
      root: '/repo',
      readFile: (path) => {
        const body = files[path]
        if (body === undefined) throw new Error(`missing ${path}`)
        return body
      },
      loadGatesFn: () => validGates,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('budget.json'))).toBe(true)
  })

  it('fails when flaky mirror diverges', () => {
    const files = coherentFiles({
      '/repo/e2e/flaky.json': JSON.stringify(['e2e/x.spec.ts']),
    })
    const result = checkGateValues({
      root: '/repo',
      readFile: (path) => {
        const body = files[path]
        if (body === undefined) throw new Error(`missing ${path}`)
        return body
      },
      loadGatesFn: () => validGates,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('e2e/flaky.json'))).toBe(true)
  })

  it('fails when a consumer omits load-gates', () => {
    const files = coherentFiles({
      '/repo/vite.config.ts': 'export default {}',
    })
    const result = checkGateValues({
      root: '/repo',
      readFile: (path) => {
        const body = files[path]
        if (body === undefined) throw new Error(`missing ${path}`)
        return body
      },
      loadGatesFn: () => validGates,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('vite.config.ts'))).toBe(true)
  })

  it('fails when workflow hardcodes burn-in', () => {
    const files = coherentFiles({
      '/repo/.github/workflows/integration.yml': "E2E_BURN_IN: '10'\njobs: {}",
    })
    const result = checkGateValues({
      root: '/repo',
      readFile: (path) => {
        const body = files[path]
        if (body === undefined) throw new Error(`missing ${path}`)
        return body
      },
      loadGatesFn: () => validGates,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('E2E_BURN_IN'))).toBe(true)
  })

  it('passes a coherent fixture tree', () => {
    const files = coherentFiles()
    const result = checkGateValues({
      root: '/repo',
      readFile: (path) => {
        const body = files[path]
        if (body === undefined) throw new Error(`missing ${path}`)
        return body
      },
      loadGatesFn: () => validGates,
    })
    expect(result.ok).toBe(true)
  })

  it('passes against the real repository tree', () => {
    const result = checkGateValues()
    expect(result.ok).toBe(true)
  })
})
