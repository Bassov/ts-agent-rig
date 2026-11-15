import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkRealInput,
  hasTickEvidence,
  isExternalFormatParser,
  parseTickedTasks,
  runQualitySelfCheck,
} from './quality-self-check.mjs'

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length)
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
})

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'self-check-'))
  tmpDirs.push(d)
  return d
}

describe('quality-self-check', () => {
  it('checks tick evidence, real-input tag scope, and checklist lines', () => {
    const ticks = parseTickedTasks(
      '- [x] 1.1 cover parseLcov (scripts/check-patch-coverage.test.mjs)\n- [x] 1.2 vague\n',
    )
    expect(hasTickEvidence(ticks[0].evidence)).toBe(true)
    expect(hasTickEvidence(ticks[1].evidence)).toBe(false)
    expect(
      isExternalFormatParser('src/core/parse.ts', 'export function parse() {}'),
    ).toBe(false)
    expect(
      isExternalFormatParser(
        'scripts/x.mjs',
        '/** @real-input-parser */\nexport const parseLcov = () => {}',
      ),
    ).toBe(true)

    const root = tmp()
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'scripts/parser.mjs'),
      '/** @real-input-parser */\nexport const parseLcov = () => {}\n',
    )
    fs.writeFileSync(
      path.join(root, 'scripts/parser.test.mjs'),
      "it('x', () => {})\n",
    )
    expect(
      checkRealInput({ root, changedFiles: ['scripts/parser.mjs'] }).ok,
    ).toBe(false)
    fs.writeFileSync(
      path.join(root, 'scripts/parser.test.mjs'),
      "// test/fixtures/real/vitest-lcov-snippet.info\nit('x', () => {})\n",
    )
    expect(
      checkRealInput({ root, changedFiles: ['scripts/parser.mjs'] }).ok,
    ).toBe(true)

    fs.mkdirSync(path.join(root, 'quality'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'quality/review-checklist.md'),
      '- `gates`: g\n- `size`: s\n- `pr-body`: p\n- `evidence`: e\n- `real-input`: r\n- `scope`: s\n',
    )
    fs.mkdirSync(path.join(root, '.github'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.github/PULL_REQUEST_TEMPLATE.md'),
      '## Summary\n\n-\n',
    )
    const lines = []
    const code = runQualitySelfCheck({
      root,
      body: '## Summary\n\n- ok\n',
      warnOnlySize: true,
      git: (args) => {
        if (args.includes('--name-only'))
          return { status: 0, stdout: '', stderr: '' }
        if (args[0] === 'merge-base')
          return { status: 0, stdout: 'abc\n', stderr: '' }
        if (args.includes('--numstat'))
          return { status: 0, stdout: '1\t0\tscripts/a.mjs\n', stderr: '' }
        if (args[0] === 'rev-parse' || args[0] === 'branch') {
          return { status: 0, stdout: 'feat/demo\n', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      runPrPolicy: () => 0,
      write: (s) => lines.push(...String(s).trimEnd().split('\n')),
    })
    expect(code).toBe(0)
    expect(lines.some((l) => l.startsWith('gates:'))).toBe(true)
    expect(lines.some((l) => l.startsWith('scope: n.a.'))).toBe(true)
    // pr-body is no longer gated: a legacy checklist id is reported n.a., never fail.
    expect(lines).toContain('pr-body: n.a. — unhandled')
  })
})

/**
 * Root causes of testdata/finalize-cases/1 and 3: change dirs other items
 * left on main and a stale local Stryker report failed every finalize.
 */
describe('quality-self-check scope (finalize replay cases 1 and 3)', () => {
  const NO_EVIDENCE = '- [x] 1.1 vague tick\n'

  function hostWithLeftovers() {
    const root = tmp()
    for (const name of [
      'design-r3-book-cover',
      'fix-flaky-node-tests',
      'library-json-schema',
    ]) {
      const d = path.join(root, 'openspec', 'changes', name)
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'tasks.md'), NO_EVIDENCE)
    }
    return root
  }

  function writeReport(root, files) {
    const p = path.join(root, 'reports', 'mutation', 'mutation.json')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ files }))
  }

  function selfCheck(root, changed, branch = 'fix/printer-presets') {
    const lines = []
    const code = runQualitySelfCheck({
      root,
      git: (args) => {
        if (args.includes('--name-only'))
          return changed == null
            ? { status: 128, stdout: '', stderr: 'no origin/main' }
            : { status: 0, stdout: changed.join('\n'), stderr: '' }
        if (args[0] === 'branch')
          return { status: 0, stdout: `${branch}\n`, stderr: '' }
        return { status: 0, stdout: '', stderr: '' }
      },
      runPrPolicy: () => 0,
      write: (s) => lines.push(...String(s).trimEnd().split('\n')),
    })
    const row = (id) => lines.find((l) => l.startsWith(`${id}:`))
    return { code, row }
  }

  const noCoverage = (line) => ({
    status: 'NoCoverage',
    mutatorName: 'ConditionalExpression',
    location: { start: { line } },
  })

  it('leftover change dirs and a stale report outside the diff no longer fail', () => {
    const root = hostWithLeftovers()
    writeReport(root, { 'src/other-branch.ts': { mutants: [noCoverage(5)] } })
    const r = selfCheck(root, ['src/printer/presets.ts'])
    expect(r.code).toBe(0)
    expect(r.row('evidence')).toBe('evidence: n.a. — no tasks.md')
    expect(r.row('disables')).toBe(
      'disables: n.a. — stryker report has NoCoverage only outside this diff (stale)',
    )
  })

  it('still fails on change dirs and NoCoverage mutants the branch touches', () => {
    const root = hostWithLeftovers()
    const mine = path.join(root, 'openspec', 'changes', 'printer-presets')
    fs.mkdirSync(mine, { recursive: true })
    fs.writeFileSync(path.join(mine, 'tasks.md'), NO_EVIDENCE)
    const other = path.join(root, 'openspec', 'changes', 'touched-sibling')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'tasks.md'), NO_EVIDENCE)
    writeReport(root, {
      [path.join(root, 'src/printer/presets.ts')]: {
        mutants: [noCoverage(12)],
      },
    })
    const r = selfCheck(root, [
      'src/printer/presets.ts',
      'openspec/changes/touched-sibling/proposal.md',
    ])
    expect(r.code).toBe(1)
    expect(r.row('evidence')).toBe(
      'evidence: fail — openspec/changes/printer-presets/tasks.md:1 no test/link/commit evidence; openspec/changes/touched-sibling/tasks.md:1 no test/link/commit evidence',
    )
    expect(r.row('disables')).toBe(
      'disables: fail — NoCoverage src/printer/presets.ts:12 ConditionalExpression — add a test that kills it, then rerun: pnpm stryker:diff',
    )
  })

  it('without a branch diff it falls back to checking every change dir and the whole report', () => {
    const root = hostWithLeftovers()
    writeReport(root, { 'src/other-branch.ts': { mutants: [noCoverage(5)] } })
    const r = selfCheck(root, null, 'main')
    expect(r.code).toBe(1)
    expect(r.row('evidence')).toMatch(
      /design-r3-book-cover\/tasks\.md:1 .*fix-flaky-node-tests\/tasks\.md:1 .*library-json-schema\/tasks\.md:1 /,
    )
    expect(r.row('disables')).toMatch(
      /^disables: fail — NoCoverage src\/other-branch\.ts:5 /,
    )
  })
})
