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
