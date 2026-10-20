import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MUTATION_REPORT,
  SURVIVED_SAMPLE_LIMIT,
  buildMutationSummaryMarkdown,
  collectDisablesFromText,
  formatSurvivedSample,
  listNoCoverageSamples,
  listUnmutatedChangedFiles,
  mutationScore,
  resolveChangedFilesForSummary,
  runStrykerPrSummaryCli,
  summarizeMutationFiles,
} from './stryker-pr-summary.mjs'

const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
  }
})

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stryker-sum-'))
  tmpDirs.push(d)
  return d
}

describe('stryker-pr-summary', () => {
  it('exports pinned constants', () => {
    expect(DEFAULT_MUTATION_REPORT).toBe('reports/mutation/mutation.json')
    expect(SURVIVED_SAMPLE_LIMIT).toBe(8)
  })

  it('summarizeMutationFiles counts every status and missing mutants array', () => {
    const summary = summarizeMutationFiles({
      'src/a.ts': {
        mutants: [
          { status: 'Killed' },
          { status: 'Ignored' },
          { status: 'Ignored' },
          { status: 'Timeout' },
          { status: 'TimedOut' },
          { status: 'NoCoverage' },
          { status: 'Weird' },
        ],
      },
      'src/b.ts': {
        mutants: [
          {
            status: 'Survived',
            location: { start: { line: 3 } },
            mutatorName: 'BooleanLiteral',
          },
        ],
      },
      'src/c.ts': {},
    })
    expect(summary).toEqual({
      killed: 1,
      survived: 1,
      timeout: 2,
      noCoverage: 1,
      ignored: 2,
      other: 1,
      survivedSamples: ['- `src/b.ts:3` BooleanLiteral'],
      ignoredPerFile: [{ path: 'src/a.ts', ignored: 2 }],
    })
  })

  it('formatSurvivedSample falls back across name and line', () => {
    expect(formatSurvivedSample({ id: 'm9' }, 'f.ts')).toBe('- `f.ts:?` m9')
    expect(formatSurvivedSample({}, 'f.ts')).toBe('- `f.ts:?` ')
    expect(
      formatSurvivedSample(
        { location: { start: { line: 4 } }, mutatorName: '', id: 'x' },
        'a.ts',
      ),
    ).toBe('- `a.ts:4` x')
    expect(
      formatSurvivedSample(
        { location: { start: {} }, mutatorName: 'B' },
        'a.ts',
      ),
    ).toBe('- `a.ts:?` B')
    expect(
      formatSurvivedSample(
        { location: { start: null }, mutatorName: 'B' },
        'a.ts',
      ),
    ).toBe('- `a.ts:?` B')
  })

  it('caps survived samples at SURVIVED_SAMPLE_LIMIT', () => {
    /** @type {{ status: string, location: { start: { line: number } }, mutatorName: string }[]} */
    const mutants = []
    for (let i = 0; i < SURVIVED_SAMPLE_LIMIT + 3; i++) {
      mutants.push({
        status: 'Survived',
        location: { start: { line: i + 1 } },
        mutatorName: `M${i}`,
      })
    }
    const summary = summarizeMutationFiles({ 'src/a.ts': { mutants } })
    expect(summary.survived).toBe(SURVIVED_SAMPLE_LIMIT + 3)
    expect(summary.survivedSamples).toHaveLength(SURVIVED_SAMPLE_LIMIT)
    expect(summary.survivedSamples[0]).toBe('- `src/a.ts:1` M0')
    expect(summary.survivedSamples[7]).toBe('- `src/a.ts:8` M7')
  })

  it('collectDisablesFromText lists legal reasons and illegal lines', () => {
    expect(
      collectDisablesFromText(
        'src/a.ts',
        '// Stryker disable next-line BooleanLiteral: justified reason ok\n// Stryker disable all\nexport const x = 1\n',
      ),
    ).toEqual([
      { path: 'src/a.ts', reason: 'justified reason ok' },
      { path: 'src/a.ts', reason: '// Stryker disable all' },
    ])
    expect(
      collectDisablesFromText('src/a.ts', '  // Stryker disable all  \n'),
    ).toEqual([{ path: 'src/a.ts', reason: '// Stryker disable all' }])
  })

  it('mutationScore distinguishes + from - and empty denominator', () => {
    expect(mutationScore(0, 0, 0, 0)).toBe(100)
    expect(mutationScore(2, 0, 1, 1)).toBe(50)
    expect(mutationScore(1, 1, 0, 0)).toBe(100)
    expect(mutationScore(3, 1, 1, 1)).toBe(66.7)
    expect(mutationScore(2, 2, 0, 0)).toBe(100)
  })

  it('buildMutationSummaryMarkdown exact empty report', () => {
    expect(buildMutationSummaryMarkdown({ files: {} })).toBe(
      [
        '## Mutation testing',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| Score | **100%** |',
        '| Killed | 0 |',
        '| Survived | 0 |',
        '| Timed out | 0 |',
        '| No coverage | 0 |',
        '| Ignored | 0 |',
        '',
      ].join('\n'),
    )
  })

  it('buildMutationSummaryMarkdown exact full sections', () => {
    const md = buildMutationSummaryMarkdown({
      files: {
        'src/a.ts': {
          mutants: [
            { status: 'Ignored' },
            { status: 'Killed' },
            {
              status: 'Survived',
              location: { start: { line: 9 } },
              id: 'm1',
            },
            { status: 'NoCoverage' },
          ],
        },
      },
      readFile: (p) =>
        p === 'src/a.ts'
          ? '// Stryker disable next-line BooleanLiteral: justified reason ok\nexport const x = 1\n'
          : null,
    })
    expect(md).toBe(
      [
        '## Mutation testing',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| Score | **33.3%** |',
        '| Killed | 1 |',
        '| Survived | 1 |',
        '| Timed out | 0 |',
        '| No coverage | 1 |',
        '| Ignored | 1 |',
        '',
        '### Ignored per file',
        '',
        '- `src/a.ts`: 1',
        '',
        '### Mutation suppressions',
        '',
        '- `src/a.ts`: justified reason ok',
        '',
        '### NoCoverage mutants',
        '',
        '- `src/a.ts:?` ',
        '',
        '### Sample survived mutants',
        '',
        '- `src/a.ts:9` m1',
        '',
      ].join('\n'),
    )
  })

  it('lists NoCoverage with line/mutator and unmutated changed files', () => {
    const md = buildMutationSummaryMarkdown({
      files: {
        'src/a.ts': {
          mutants: [
            {
              status: 'NoCoverage',
              location: { start: { line: 4 } },
              mutatorName: 'BooleanLiteral',
            },
          ],
        },
        'src/b.ts': { mutants: [] },
      },
      changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    })
    expect(md).toContain('### NoCoverage mutants')
    expect(md).toContain('- `src/a.ts:4` BooleanLiteral')
    expect(md).toContain('### Changed files not mutated')
    expect(md).toContain('- `src/b.ts`')
    expect(md).toContain('- `src/c.ts`')
  })

  it('resolveChangedFilesForSummary prefers env then mutate-files list', () => {
    expect(
      resolveChangedFilesForSummary(
        { STRYKER_CHANGED_FILES: ' a.ts \n\nb.ts\n' },
        { exists: () => false },
      ),
    ).toEqual(['a.ts', 'b.ts'])
    expect(
      resolveChangedFilesForSummary(
        {},
        {
          exists: (p) => p === 'reports/mutation/mutate-files.txt',
          read: () => 'x.ts\n\ny.ts\n',
        },
      ),
    ).toEqual(['x.ts', 'y.ts'])
    expect(
      resolveChangedFilesForSummary({}, { exists: () => false }),
    ).toBeUndefined()
    expect(
      resolveChangedFilesForSummary(
        { STRYKER_CHANGED_FILES: '' },
        {
          exists: () => false,
        },
      ),
    ).toBeUndefined()
  })

  it('resolveChangedFilesForSummary default read uses utf8 mutate list', () => {
    const dir = tmpDir()
    const listPath = path.join(dir, 'mutate-files.txt')
    fs.writeFileSync(listPath, 'z.ts\n', 'utf8')
    expect(
      resolveChangedFilesForSummary({}, { mutateListPath: listPath }),
    ).toEqual(['z.ts'])
  })

  it('list helpers treat non-array mutants as empty', () => {
    expect(listNoCoverageSamples({ 'src/a.ts': { mutants: null } })).toEqual([])
    expect(
      listUnmutatedChangedFiles(['src/a.ts'], {
        'src/a.ts': { mutants: null },
      }),
    ).toEqual(['src/a.ts'])
  })

  it('runStrykerPrSummaryCli on real tmp report lists disables and writes summary', () => {
    const root = tmpDir()
    const srcFile = path.join(root, 'a.ts')
    fs.writeFileSync(
      srcFile,
      '// Stryker disable next-line BooleanLiteral: justified reason ok\nexport const x = 1\n',
    )
    const reportPath = path.join(root, 'mutation.json')
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        files: {
          [srcFile]: {
            mutants: [
              { status: 'Killed' },
              { status: 'Ignored' },
              { status: 'TimedOut' },
              { status: 'NoCoverage' },
            ],
          },
        },
      }),
    )
    const summaryPath = path.join(root, 'summary.md')
    /** @type {string[]} */
    const chunks = []
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = (c) => {
      chunks.push(String(c))
      return true
    }
    let code
    try {
      code = runStrykerPrSummaryCli([reportPath], {
        GITHUB_STEP_SUMMARY: summaryPath,
      })
    } finally {
      process.stdout.write = orig
    }
    expect(code).toBe(0)
    const out = chunks.join('')
    expect(out).toContain('justified reason ok')
    expect(out).toContain('### Ignored per file')
    expect(out).toContain('| Ignored | 1 |')
    expect(fs.readFileSync(summaryPath, 'utf8')).toBe(out)
  })

  it('runStrykerPrSummaryCli returns 2 when report missing', () => {
    /** @type {string[]} */
    const errs = []
    const orig = console.error
    console.error = (...args) => {
      errs.push(args.map(String).join(' '))
    }
    try {
      expect(
        runStrykerPrSummaryCli([path.join(tmpDir(), 'nope.json')], {}),
      ).toBe(2)
    } finally {
      console.error = orig
    }
    expect(errs[0]).toMatch(/^No mutation report at /)
  })

  it('runStrykerPrSummaryCli returns 2 when argv empty or blank', () => {
    /** @type {string[]} */
    const errs = []
    const orig = console.error
    console.error = (...args) => {
      errs.push(args.map(String).join(' '))
    }
    try {
      expect(runStrykerPrSummaryCli([], {})).toBe(2)
      expect(runStrykerPrSummaryCli([''], {})).toBe(2)
    } finally {
      console.error = orig
    }
    expect(errs[0]).toBe('Usage: stryker-pr-summary-cli.mjs <mutation.json>')
    expect(errs[1]).toBe('Usage: stryker-pr-summary-cli.mjs <mutation.json>')
  })

  it('runStrykerPrSummaryCli skips missing source files', () => {
    const root = tmpDir()
    const reportPath = path.join(root, 'mutation.json')
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        files: { 'src/does-not-exist.ts': { mutants: [{ status: 'Killed' }] } },
      }),
    )
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = () => true
    let code
    try {
      code = runStrykerPrSummaryCli([reportPath], {})
    } finally {
      process.stdout.write = orig
    }
    expect(code).toBe(0)
  })

  it('runStrykerPrSummaryCli without GITHUB_STEP_SUMMARY still prints', () => {
    const root = tmpDir()
    const reportPath = path.join(root, 'mutation.json')
    fs.writeFileSync(reportPath, JSON.stringify({ files: {} }))
    /** @type {string[]} */
    const chunks = []
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = (c) => {
      chunks.push(String(c))
      return true
    }
    let code
    try {
      code = runStrykerPrSummaryCli([reportPath], {})
    } finally {
      process.stdout.write = orig
    }
    expect(code).toBe(0)
    expect(chunks.join('')).toContain('| Score | **100%** |')
  })
})
