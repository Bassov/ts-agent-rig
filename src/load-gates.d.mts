export const GATES_RELATIVE_PATH: string

export interface Gates {
  coverage: {
    statements: number
    branches: number
    functions: number
    lines: number
    patch: number
  }
  stryker: {
    thresholds: {
      high: number
      low: number
      break: number
    }
  }
  lighthouse: {
    numberOfRuns: number
    assertions: Record<string, string>
    budgets: unknown[]
  }
  playwright: {
    retries: number
    flakyRetries: number
  }
  e2e: {
    burnInDefault: number
    flakySpecs: string[]
  }
}

export function validateGates(raw: unknown, pathLabel?: string): Gates

export function loadGates(io?: {
  root?: string
  readFile?: (path: string) => string
}): Gates
