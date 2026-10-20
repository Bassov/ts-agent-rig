import { resolveRepoRoot } from './resolve-repo-root.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AGENT_RULES_OVER_BUDGET,
  MSGS,
  checkAgentRuleBudgetsAbsolute,
  compareAgentRuleBudgets,
  countRuleFileChars,
  countRuleFileLines,
  isScopedAgentRulePath,
  listScopedAgentRulePaths,
  parseAgentRuleBudgets,
} from './agent-rules-budget.mjs'

const REPO_ROOT = resolveRepoRoot()

/** @returns {{ ruleId: string, message: string }[]} */
function collectAbsolute(files, gates, opts) {
  /** @type {{ ruleId: string, message: string }[]} */
  const violations = []
  checkAgentRuleBudgetsAbsolute(
    files,
    gates,
    (id, m) => violations.push({ ruleId: id, message: m }),
    opts,
  )
  return violations
}

/** @returns {string[]} */
function collectCompare(base, head, files, label = 'quality/gates.json', opts) {
  /** @type {string[]} */
  const msgs = []
  compareAgentRuleBudgets(base, head, files, label, (m) => msgs.push(m), opts)
  return msgs
}

describe('countRuleFileLines / countRuleFileChars', () => {
  it.each([
    ['', 0, 0],
    ['a', 1, 1],
    ['a\n', 2, 2],
    ['a\nb', 2, 3],
    ['a\r\nb', 2, 4],
  ])('lines/chars for %j', (text, lines, chars) => {
    expect(countRuleFileLines(text)).toBe(lines)
    expect(countRuleFileChars(text)).toBe(chars)
  })

  it('non-string yields 0', () => {
    expect(countRuleFileLines(null)).toBe(0)
    expect(countRuleFileLines(12)).toBe(0)
    expect(countRuleFileChars(null)).toBe(0)
    expect(countRuleFileChars(12)).toBe(0)
  })

  it('counts utf8 bytes for non-ascii', () => {
    expect(countRuleFileChars('й')).toBe(2)
  })
})

describe('isScopedAgentRulePath / listScopedAgentRulePaths', () => {
  it.each([
    ['AGENTS.md', true],
    ['openspec/config.yaml', true],
    ['.cursor/commands/next-roadmap-item.md', true],
    ['.cursor/rules/overview.mdc', true],
    ['.cursor/agents/openspec-planning-reviewer.md', true],
    ['.cursor\\rules\\overview.mdc', true],
    ['.cursor/commands/opsx-apply.md', false],
    ['README.md', false],
    ['.cursor/rules/notes.md', false],
    ['.cursor/agents/x.txt', false],
  ])('%s → %s', (p, want) => {
    expect(isScopedAgentRulePath(p)).toBe(want)
  })

  it('lists only scoped present files', () => {
    const files = {
      'AGENTS.md': 'x',
      '.cursor/rules/overview.mdc': 'y',
      '.cursor/commands/opsx-apply.md': 'z',
      'README.md': 'r',
      '.cursor/rules/missing.mdc': undefined,
    }
    expect(listScopedAgentRulePaths(files)).toEqual([
      '.cursor/rules/overview.mdc',
      'AGENTS.md',
    ])
  })

  it('uses custom getFile and backslash keys', () => {
    const files = { dummy: '1' }
    const paths = listScopedAgentRulePaths(files, (f, rel) => {
      if (rel === 'AGENTS.md' || rel === '.cursor\\rules\\a.mdc') return 'body'
      return undefined
    })
    // keys come from Object.keys(files) only — custom getFile cannot invent keys
    expect(paths).toEqual([])
    const withSlash = {
      '.cursor\\rules\\a.mdc': 'body',
      'AGENTS.md': 'x',
    }
    expect(listScopedAgentRulePaths(withSlash)).toEqual([
      '.cursor/rules/a.mdc',
      'AGENTS.md',
    ])
  })
})

describe('parseAgentRuleBudgets', () => {
  it('returns null for absent / invalid agentRules', () => {
    expect(parseAgentRuleBudgets({})).toBeNull()
    expect(parseAgentRuleBudgets(null)).toBeNull()
    expect(parseAgentRuleBudgets([])).toBeNull()
    expect(parseAgentRuleBudgets({ agentRules: null })).toBeNull()
    expect(parseAgentRuleBudgets({ agentRules: [] })).toBeNull()
    expect(parseAgentRuleBudgets({ agentRules: { budgets: {} } })).toBeNull()
  })

  it('parses valid rows and skips junk', () => {
    const map = parseAgentRuleBudgets({
      agentRules: {
        budgets: [
          { path: 'AGENTS.md', maxLines: 10, maxChars: 100 },
          { path: 'win\\AGENTS.md', maxLines: 1, maxChars: 1 },
          { path: 'neg', maxLines: -1, maxChars: 1 },
          { path: 'inf', maxLines: Number.POSITIVE_INFINITY, maxChars: 1 },
          { path: 'nan', maxLines: Number.NaN, maxChars: 1 },
          { path: 'nope', maxLines: 'x', maxChars: 1 },
          null,
          { maxLines: 1, maxChars: 1 },
          ['not-row'],
        ],
      },
    })
    expect(map).not.toBeNull()
    expect(map.get('AGENTS.md')).toEqual({ maxLines: 10, maxChars: 100 })
    expect(map.get('win/AGENTS.md')).toEqual({ maxLines: 1, maxChars: 1 })
    expect(map.has('neg')).toBe(false)
    expect(map.has('inf')).toBe(false)
    expect(map.has('nan')).toBe(false)
  })
})

describe('checkAgentRuleBudgetsAbsolute', () => {
  it('no-ops when no scoped files and no budgets', () => {
    expect(collectAbsolute({ 'README.md': 'x' }, {})).toEqual([])
  })

  it('fails when scoped files exist but budgets missing', () => {
    expect(collectAbsolute({ 'AGENTS.md': 'hi' }, {})).toEqual([
      { ruleId: AGENT_RULES_OVER_BUDGET, message: MSGS.budgetsMissing },
    ])
  })

  it('fails over-budget, missing entry, and missing budgeted file', () => {
    const gates = {
      agentRules: {
        budgets: [
          { path: 'AGENTS.md', maxLines: 1, maxChars: 2 },
          { path: 'openspec/config.yaml', maxLines: 1, maxChars: 1 },
        ],
      },
    }
    const violations = collectAbsolute(
      {
        'AGENTS.md': 'abcdef',
        '.cursor/rules/overview.mdc': 'x',
      },
      gates,
    )
    expect(
      violations.some((v) => v.message.startsWith(MSGS.overBudgetPrefix)),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.message.startsWith(
          `${MSGS.missingEntryPrefix}.cursor/rules/overview.mdc`,
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.message.startsWith(`${MSGS.missingFilePrefix}openspec/config.yaml`),
      ),
    ).toBe(true)
  })

  it('fails on lines-only and chars-only overages', () => {
    const linesOnly = collectAbsolute(
      { 'AGENTS.md': 'a\nb\nc' },
      {
        agentRules: {
          budgets: [{ path: 'AGENTS.md', maxLines: 2, maxChars: 100 }],
        },
      },
    )
    expect(linesOnly.some((v) => v.message.includes('lines 3/2'))).toBe(true)

    const charsOnly = collectAbsolute(
      { 'AGENTS.md': 'abcd' },
      {
        agentRules: {
          budgets: [{ path: 'AGENTS.md', maxLines: 10, maxChars: 2 }],
        },
      },
    )
    expect(charsOnly.some((v) => v.message.includes('chars 4/2'))).toBe(true)
  })

  it('passes when within budget and honors custom getFile', () => {
    const text = 'ab'
    expect(
      collectAbsolute(
        { 'AGENTS.md': text },
        {
          agentRules: {
            budgets: [
              {
                path: 'AGENTS.md',
                maxLines: countRuleFileLines(text),
                maxChars: countRuleFileChars(text),
              },
            ],
          },
        },
      ),
    ).toEqual([])

    const viaOpts = collectAbsolute(
      { 'AGENTS.md': 'ignored' },
      {
        agentRules: {
          budgets: [{ path: 'AGENTS.md', maxLines: 1, maxChars: 1 }],
        },
      },
      { getFile: () => undefined },
    )
    expect(
      viaOpts.some((v) =>
        v.message.startsWith(`${MSGS.missingFilePrefix}AGENTS.md`),
      ),
    ).toBe(true)
  })
})

describe('compareAgentRuleBudgets', () => {
  it('seeds when base has no budgets', () => {
    expect(
      collectCompare(
        {},
        {
          agentRules: {
            budgets: [{ path: 'AGENTS.md', maxLines: 1, maxChars: 1 }],
          },
        },
        { 'AGENTS.md': 'a' },
      ),
    ).toEqual([])
  })

  it('fails when budgets removed', () => {
    const msgs = collectCompare(
      {
        agentRules: {
          budgets: [{ path: 'AGENTS.md', maxLines: 5, maxChars: 50 }],
        },
      },
      {},
      { 'AGENTS.md': 'a' },
    )
    expect(msgs.some((m) => m.includes(MSGS.budgetsRemoved))).toBe(true)
  })

  it('fails when maxLines or maxChars raised, or path budget missing', () => {
    expect(
      collectCompare(
        {
          agentRules: {
            budgets: [{ path: 'AGENTS.md', maxLines: 5, maxChars: 50 }],
          },
        },
        {
          agentRules: {
            budgets: [{ path: 'AGENTS.md', maxLines: 9, maxChars: 50 }],
          },
        },
        { 'AGENTS.md': 'a' },
      ).some((m) => m.includes(MSGS.raisedLinesPrefix)),
    ).toBe(true)

    expect(
      collectCompare(
        {
          agentRules: {
            budgets: [{ path: 'AGENTS.md', maxLines: 5, maxChars: 50 }],
          },
        },
        {
          agentRules: {
            budgets: [{ path: 'AGENTS.md', maxLines: 5, maxChars: 80 }],
          },
        },
        { 'AGENTS.md': 'a' },
      ).some((m) => m.includes(MSGS.raisedCharsPrefix)),
    ).toBe(true)

    expect(
      collectCompare(
        {
          agentRules: {
            budgets: [
              { path: 'AGENTS.md', maxLines: 5, maxChars: 50 },
              { path: 'openspec/config.yaml', maxLines: 1, maxChars: 1 },
            ],
          },
        },
        {
          agentRules: {
            budgets: [{ path: 'AGENTS.md', maxLines: 5, maxChars: 50 }],
          },
        },
        { 'AGENTS.md': 'a', 'openspec/config.yaml': 'x' },
      ).some((m) => m.includes(MSGS.missingBudgetPathPrefix)),
    ).toBe(true)
  })

  it('allows dropping budget when file deleted; equal budgets pass', () => {
    expect(
      collectCompare(
        {
          agentRules: {
            budgets: [
              { path: 'AGENTS.md', maxLines: 5, maxChars: 50 },
              { path: '.cursor/rules/gone.mdc', maxLines: 1, maxChars: 1 },
            ],
          },
        },
        {
          agentRules: {
            budgets: [{ path: 'AGENTS.md', maxLines: 5, maxChars: 50 }],
          },
        },
        { 'AGENTS.md': 'a' },
      ),
    ).toEqual([])

    expect(
      collectCompare(
        {
          agentRules: {
            budgets: [{ path: 'AGENTS.md', maxLines: 5, maxChars: 50 }],
          },
        },
        {
          agentRules: {
            budgets: [{ path: 'AGENTS.md', maxLines: 4, maxChars: 40 }],
          },
        },
        { 'AGENTS.md': 'a' },
      ),
    ).toEqual([])
  })

  it('honors custom getFile for existence', () => {
    const msgs = collectCompare(
      {
        agentRules: {
          budgets: [{ path: 'AGENTS.md', maxLines: 1, maxChars: 1 }],
        },
      },
      {
        agentRules: {
          budgets: [{ path: 'AGENTS.md', maxLines: 2, maxChars: 1 }],
        },
      },
      {},
      'quality/gates.json',
      { getFile: (_f, rel) => (rel === 'AGENTS.md' ? 'x' : undefined) },
    )
    expect(msgs.some((m) => m.includes(MSGS.raisedLinesPrefix))).toBe(true)
  })
})

describe('MSGS freeze', () => {
  it('exports exact fail fragments', () => {
    expect(MSGS.budgetsMissing).toBe('agentRules.budgets missing')
    expect(MSGS.overBudgetPrefix).toBe('agent rule over budget: ')
    expect(AGENT_RULES_OVER_BUDGET).toBe('agent-rules-over-budget')
  })
})

describe('real repo agentRules budgets', () => {
  it('every scoped rule file is within quality/gates.json budgets', () => {
    const gates = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'quality/gates.json'), 'utf8'),
    )
    /** @type {Record<string, string>} */
    const files = {}
    const walk = (dir, relBase = '') => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name
        const abs = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (
            ent.name === 'node_modules' ||
            ent.name === '.git' ||
            ent.name === 'dist'
          ) {
            continue
          }
          walk(abs, rel)
        } else if (
          ent.isFile() &&
          isScopedAgentRulePath(rel.replaceAll('\\', '/'))
        ) {
          files[rel.replaceAll('\\', '/')] = fs.readFileSync(abs, 'utf8')
        }
      }
    }
    walk(REPO_ROOT)
    expect(collectAbsolute(files, gates)).toEqual([])
  })
})
