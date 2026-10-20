import { describe, expect, it } from 'vitest'
import {
  countSpecLines,
  MSGS,
  parseOpenspecSpecBudgets,
  runOpenspecBudgetCheck,
} from './check-openspec-budget.mjs'

describe('countSpecLines', () => {
  it('counts newlines like editors', () => {
    expect(countSpecLines('')).toBe(0)
    expect(countSpecLines('a')).toBe(1)
    expect(countSpecLines('a\nb')).toBe(2)
    expect(countSpecLines('a\nb\n')).toBe(3)
  })
})

describe('parseOpenspecSpecBudgets', () => {
  it('returns null for absent or invalid', () => {
    expect(parseOpenspecSpecBudgets(null)).toBeNull()
    expect(parseOpenspecSpecBudgets({})).toBeNull()
    expect(parseOpenspecSpecBudgets({ openspecSpecs: {} })).toBeNull()
    expect(
      parseOpenspecSpecBudgets({
        openspecSpecs: { softMaxLines: -1, hardMaxLines: 10 },
      }),
    ).toBeNull()
  })

  it('parses soft and hard', () => {
    expect(
      parseOpenspecSpecBudgets({
        openspecSpecs: { softMaxLines: 400, hardMaxLines: 500 },
      }),
    ).toEqual({ softMaxLines: 400, hardMaxLines: 500 })
  })
})

describe('runOpenspecBudgetCheck', () => {
  const gates = {
    openspecSpecs: { softMaxLines: 3, hardMaxLines: 5 },
  }

  it('fails when budgets missing', () => {
    const errors = []
    const code = runOpenspecBudgetCheck({
      gates: {},
      listPaths: () => [],
      error: (m) => errors.push(m),
      warn: () => {},
      log: () => {},
    })
    expect(code).toBe(1)
    expect(errors).toContain(MSGS.budgetsMissing)
  })

  it('fails when soft > hard', () => {
    const errors = []
    const code = runOpenspecBudgetCheck({
      gates: { openspecSpecs: { softMaxLines: 10, hardMaxLines: 5 } },
      listPaths: () => [],
      error: (m) => errors.push(m),
      warn: () => {},
      log: () => {},
    })
    expect(code).toBe(1)
    expect(errors).toContain(MSGS.softGtHard)
  })

  it('warns on soft, fails on hard', () => {
    const warns = []
    const errors = []
    const files = {
      'openspec/specs/a/spec.md': '1\n2\n3\n4', // 4 lines → soft
      'openspec/specs/b/spec.md': '1\n2\n3\n4\n5\n6', // 6 → hard
    }
    const code = runOpenspecBudgetCheck({
      root: '/tmp',
      gates,
      listPaths: () => Object.keys(files),
      readFile: (abs) => {
        const rel = abs.replace(/^\/tmp\//, '')
        return files[rel] ?? ''
      },
      warn: (m) => warns.push(m),
      error: (m) => errors.push(m),
      log: () => {},
    })
    expect(code).toBe(1)
    expect(warns.some((m) => m.includes('openspec/specs/a/spec.md'))).toBe(true)
    expect(errors.some((m) => m.includes('openspec/specs/b/spec.md'))).toBe(
      true,
    )
  })

  it('passes within soft', () => {
    const warns = []
    const code = runOpenspecBudgetCheck({
      root: '/tmp',
      gates,
      listPaths: () => ['openspec/specs/ok/spec.md'],
      readFile: () => 'a\nb',
      warn: (m) => warns.push(m),
      error: () => {},
      log: () => {},
    })
    expect(code).toBe(0)
    expect(warns).toEqual([])
  })

  it('real repo specs stay within hard budget', () => {
    const errors = []
    const code = runOpenspecBudgetCheck({
      error: (m) => errors.push(m),
      warn: () => {},
      log: () => {},
    })
    expect(code).toBe(0)
    expect(errors).toEqual([])
  })
})
