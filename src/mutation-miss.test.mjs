import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findMutationReport,
  formatMutationMissLine,
  listMutationMisses,
  readMutationMisses,
} from './mutation-miss.mjs'

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length)
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
})

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-miss-'))
  tmpDirs.push(d)
  return d
}

const mutant = (status, line, mutatorName = 'ConditionalExpression') => ({
  status,
  mutatorName,
  location: { start: { line, column: 1 } },
})

describe('listMutationMisses', () => {
  it('keeps wanted statuses, makes absolute keys repo-relative, scopes to changed files', () => {
    const root = '/work/repo'
    const report = {
      files: {
        '/work/repo/src/a.ts': {
          mutants: [mutant('NoCoverage', 4), mutant('Killed', 5)],
        },
        'src/b.ts': { mutants: [mutant('Survived', 7, 'BooleanLiteral')] },
        'src/old.ts': { mutants: [mutant('NoCoverage', 1)] },
      },
    }
    expect(
      listMutationMisses(report, {
        root,
        statuses: ['NoCoverage', 'Survived'],
        changedFiles: ['src/a.ts', 'src/b.ts'],
      }),
    ).toEqual([
      { file: 'src/a.ts', line: '4', mutator: 'ConditionalExpression', status: 'NoCoverage' },
      { file: 'src/b.ts', line: '7', mutator: 'BooleanLiteral', status: 'Survived' },
    ])
    expect(
      listMutationMisses(report, { root, statuses: ['NoCoverage'] }).map(
        (m) => m.file,
      ),
    ).toEqual(['src/a.ts', 'src/old.ts'])
    expect(listMutationMisses(null, { root, statuses: ['NoCoverage'] })).toEqual([])
    expect(
      listMutationMisses(
        { files: { 'src/x.ts': { mutants: [{ status: 'NoCoverage', id: '12' }] } } },
        { root, statuses: ['NoCoverage'] },
      ),
    ).toEqual([{ file: 'src/x.ts', line: '?', mutator: '12', status: 'NoCoverage' }])
  })
})

describe('formatMutationMissLine', () => {
  it('is one line: up to 3 misses as file:line, the remainder count and the rerun', () => {
    const misses = [1, 2, 3, 4, 5].map((n) => ({
      file: 'src/a.ts',
      line: String(n),
      mutator: 'M',
      status: 'Survived',
    }))
    const line = formatMutationMissLine(misses, 'pnpm stryker:diff')
    expect(line).toBe(
      'Survived src/a.ts:1 M; Survived src/a.ts:2 M; Survived src/a.ts:3 M (+2 more) — add a test that kills it, then rerun: pnpm stryker:diff',
    )
    expect(line).not.toContain('\n')
    expect(formatMutationMissLine([], 'x')).toBe('')
  })
})

describe('readMutationMisses', () => {
  it('finds the report, survives a broken one and reports totals vs scoped', () => {
    const root = tmp()
    expect(findMutationReport(root)).toBe(null)
    expect(readMutationMisses(root, { statuses: ['NoCoverage'] })).toEqual({
      report: null,
      all: 0,
      misses: [],
    })
    const p = path.join(root, 'reports', 'mutation', 'mutation.json')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '{broken')
    expect(readMutationMisses(root, { statuses: ['NoCoverage'] })).toEqual({
      report: p,
      all: 0,
      misses: [],
    })
    fs.writeFileSync(
      p,
      JSON.stringify({
        files: {
          'src/a.ts': { mutants: [mutant('NoCoverage', 2)] },
          'src/z.ts': { mutants: [mutant('NoCoverage', 3)] },
        },
      }),
    )
    const r = readMutationMisses(root, {
      statuses: ['NoCoverage'],
      changedFiles: ['src/a.ts'],
    })
    expect(r.all).toBe(2)
    expect(r.misses.map((m) => `${m.file}:${m.line}`)).toEqual(['src/a.ts:2'])
  })
})
