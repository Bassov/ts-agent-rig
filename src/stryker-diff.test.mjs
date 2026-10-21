import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadGates } from './load-gates.mjs'
import { loadMutatePatterns } from './mutation-scope.mjs'
import { mutationScore } from './stryker-pr-summary.mjs'
import {
  DIFF_CONFIG,
  MSG_NO_COVERAGE,
  MSG_UNAUTHORIZED_EXCLUDE,
  buildStrykerArgs,
  countNoCoverage,
  evaluateNoCoverageGate,
  exactBangExcludeTarget,
  findUnauthorizedExcludes,
  listNoCoverageMutants,
  planDiffMutation,
  matchesMutateInclude,
  temporaryExcludePaths,
  temporaryExcludesMissingBangs,
} from './stryker-diff-gate.mjs'

/** Minimal mutate patterns mirroring product includes + bangs. */
const PATTERNS = [
  'src/**/*.ts',
  'src/**/*.tsx',
  'scripts/**/*.mjs',
  '!src/**/*.{test,spec}.{ts,tsx}',
  '!src/main.tsx',
  '!src/editor/projectSession.ts',
  '!src/project/fsa/bookLoad.worker.ts',
  '!src/editor/EditorShell.tsx',
]

const TEMP = temporaryExcludePaths([
  { path: 'src/editor/projectSession.ts', until: 'project-session-mutation' },
  { path: 'src/editor/EditorShell.tsx', until: 'editor-shell-mutation' },
])

/**
 * @param {{ killed?: number, survived?: number, noCoverage?: number, file?: string }} opts
 */
function reportWithCounts(opts) {
  const file = opts.file ?? 'src/lib/example.ts'
  /** @type {{ status: string, location: { start: { line: number } }, mutatorName: string }[]} */
  const mutants = []
  let line = 1
  for (let i = 0; i < (opts.killed ?? 0); i += 1) {
    mutants.push({
      status: 'Killed',
      location: { start: { line: line++ } },
      mutatorName: 'K',
    })
  }
  for (let i = 0; i < (opts.survived ?? 0); i += 1) {
    mutants.push({
      status: 'Survived',
      location: { start: { line: line++ } },
      mutatorName: 'S',
    })
  }
  for (let i = 0; i < (opts.noCoverage ?? 0); i += 1) {
    mutants.push({
      status: 'NoCoverage',
      location: { start: { line: line++ } },
      mutatorName: 'N',
    })
  }
  return { [file]: { mutants } }
}

describe('stryker-diff-gate helpers', () => {
  it('exports diff config path and builds argv without allowEmpty for production', () => {
    expect(DIFF_CONFIG).toBe('stryker.diff.config.mjs')
    expect(buildStrykerArgs(['src/a.ts'], false)).toEqual([
      DIFF_CONFIG,
      '--mutate',
      'src/a.ts',
    ])
    expect(buildStrykerArgs(['src/a.ts'], true)).toContain('--allowEmpty')
  })

  it('diff config file spreads nightly and uses gates.diffThresholds', () => {
    const src = readFileSync('stryker.diff.config.mjs', 'utf8')
    expect(src).toContain('stryker.config.mjs')
    expect(src).toContain('diffThresholds')
    expect(src).toContain('load-gates')
  })

  it('resolves scoring base via STRYKER_DIFF_BASE then origin/main', () => {
    const src = readFileSync(
      new URL('./stryker-diff.mjs', import.meta.url),
      'utf8',
    )
    expect(src).toMatch(/env\.STRYKER_DIFF_BASE\s*\?\?\s*'origin\/main'/)
  })

  it('docs-only change plans skip', () => {
    const plan = planDiffMutation(['docs/readme.md'], PATTERNS, TEMP)
    expect(plan.skip).toBe(true)
    expect(plan.errors).toEqual([])
    expect(plan.allowEmpty).toBe(true)
  })

  it('temporary-excluded-only change plans skip', () => {
    const plan = planDiffMutation(
      ['src/editor/projectSession.ts'],
      PATTERNS,
      TEMP,
    )
    expect(plan.skip).toBe(true)
    expect(plan.errors).toEqual([])
  })

  it('PR #70-like: excluded file not on temporary list fails', () => {
    const plan = planDiffMutation(
      ['src/project/fsa/bookLoad.worker.ts'],
      PATTERNS,
      TEMP,
    )
    expect(plan.skip).toBe(false)
    expect(
      plan.errors.some((e) => e.startsWith(MSG_UNAUTHORIZED_EXCLUDE)),
    ).toBe(true)
    expect(
      findUnauthorizedExcludes(
        ['src/project/fsa/bookLoad.worker.ts'],
        PATTERNS,
        TEMP,
      ),
    ).toEqual(['src/project/fsa/bookLoad.worker.ts'])
  })

  it('in-scope change mutates and drops allowEmpty', () => {
    const plan = planDiffMutation(['src/lib/foo.ts'], PATTERNS, TEMP)
    expect(plan.skip).toBe(false)
    expect(plan.mutateFiles).toEqual(['src/lib/foo.ts'])
    expect(plan.allowEmpty).toBe(false)
    expect(plan.errors).toEqual([])
  })

  it('structural test exclude does not fail skip', () => {
    const plan = planDiffMutation(['src/lib/foo.test.ts'], PATTERNS, TEMP)
    expect(plan.skip).toBe(true)
    expect(plan.errors).toEqual([])
  })

  it('PR #71-like: 85.4% with 18 NoCoverage fails NoCoverage gate', () => {
    const files = reportWithCounts({
      killed: 854,
      survived: 128,
      noCoverage: 18,
    })
    expect(mutationScore(854, 0, 128, 18)).toBe(85.4)
    expect(countNoCoverage(files)).toBe(18)
    const gate = evaluateNoCoverageGate(files)
    expect(gate.ok).toBe(false)
    expect(gate.error).toBe(`${MSG_NO_COVERAGE}18`)
    expect(listNoCoverageMutants(files)).toHaveLength(18)
  })

  it('PR #82 r1-like: ~72.5% with 3 NoCoverage fails NoCoverage gate', () => {
    const files = reportWithCounts({
      killed: 7249,
      survived: 2748,
      noCoverage: 3,
    })
    expect(mutationScore(7249, 0, 2748, 3)).toBe(72.5)
    expect(mutationScore(7249, 0, 2748, 3)).toBeLessThan(85)
    const gate = evaluateNoCoverageGate(files)
    expect(gate.ok).toBe(false)
    expect(gate.count).toBe(3)
  })

  it('zero NoCoverage passes the gate', () => {
    const files = reportWithCounts({ killed: 90, survived: 10, noCoverage: 0 })
    expect(evaluateNoCoverageGate(files).ok).toBe(true)
  })

  it('listNoCoverageMutants formats missing line and mutator', () => {
    const listed = listNoCoverageMutants({
      'src/a.ts': { mutants: [{ status: 'NoCoverage' }] },
    })
    expect(listed).toEqual([{ path: 'src/a.ts', line: '?', mutator: '' }])
  })

  it('countNoCoverage ignores non-array mutants', () => {
    expect(countNoCoverage({ 'src/a.ts': { mutants: null } })).toBe(0)
    expect(countNoCoverage({ 'src/a.ts': {} })).toBe(0)
  })

  it('listNoCoverageMutants treats non-array mutants as empty', () => {
    expect(listNoCoverageMutants({ 'src/a.ts': { mutants: null } })).toEqual([])
    expect(listNoCoverageMutants({ 'src/a.ts': {} })).toEqual([])
  })

  it('temporaryExcludePaths skips bad rows', () => {
    expect([
      ...temporaryExcludePaths([null, { path: 1 }, { path: 'ok.ts' }]),
    ]).toEqual(['ok.ts'])
  })

  it('exactBangExcludeTarget ignores globs and non-bangs', () => {
    expect(
      exactBangExcludeTarget('src/a.ts', ['src/**/*.ts', '!src/**/*.ts']),
    ).toBeNull()
    expect(exactBangExcludeTarget('src/a.ts', ['!src/a.ts'])).toBe('src/a.ts')
    expect(
      exactBangExcludeTarget('src/a.ts', ['!src/a.ts', '!src/{a,b}.ts']),
    ).toBe('src/a.ts')
    expect(exactBangExcludeTarget('src/a.ts', ['!src/a?ts'])).toBeNull()
  })

  it('mixed docs + in-scope still drops allowEmpty via some()', () => {
    const plan = planDiffMutation(
      ['docs/readme.md', 'src/lib/foo.ts'],
      PATTERNS,
      TEMP,
    )
    expect(plan.allowEmpty).toBe(false)
    expect(plan.mutateFiles).toEqual(['src/lib/foo.ts'])
  })

  it('temporaryExcludesMissingBangs requires exact bangs', () => {
    expect(
      temporaryExcludesMissingBangs(
        ['src/a.ts', 'src/b.ts'],
        ['src/**/*.ts', '!src/a.ts'],
      ),
    ).toEqual(['src/b.ts'])
    expect(
      temporaryExcludesMissingBangs(
        ['src/a.ts'],
        ['!src/a.ts', '!src/**/*.ts'],
      ),
    ).toEqual([])
    // Glob metacharacters must not count as exact bangs (kills &&→|| mutants).
    expect(temporaryExcludesMissingBangs(['src/a?ts'], ['!src/a?ts'])).toEqual([
      'src/a?ts',
    ])
    expect(
      temporaryExcludesMissingBangs(['src/{a}.ts'], ['!src/{a}.ts']),
    ).toEqual(['src/{a}.ts'])
    expect(
      temporaryExcludesMissingBangs(['src/x.ts'], ['src/**/*.ts', '!src/y.ts']),
    ).toEqual(['src/x.ts'])
  })

  it('matchesMutateInclude skips bang patterns via startsWith', () => {
    expect(
      matchesMutateInclude('src/lib/foo.ts', ['!src/**/*.ts', 'src/**/*.ts']),
    ).toBe(true)
    expect(matchesMutateInclude('docs/a.md', ['src/**/*.ts'])).toBe(false)
    // A pattern that merely ends with '!' must not be treated as a bang skip.
    expect(matchesMutateInclude('src/lib/foo.ts', ['src/**/*.ts!'])).toBe(false)
  })

  it('real gates temporaryExcludes all have exact bangs', () => {
    const gates = loadGates()
    const paths = gates.mutation.temporaryExcludes.map((e) => e.path)
    expect(temporaryExcludesMissingBangs(paths, loadMutatePatterns())).toEqual(
      [],
    )
  })

  it('listNoCoverageMutants prefers mutatorName then id', () => {
    expect(
      listNoCoverageMutants({
        'src/a.ts': {
          mutants: [
            { status: 'NoCoverage', id: 'id-only' },
            {
              status: 'NoCoverage',
              mutatorName: 'BooleanLiteral',
              id: 'ignored',
              location: { start: { line: 3 } },
            },
          ],
        },
      }),
    ).toEqual([
      { path: 'src/a.ts', line: '?', mutator: 'id-only' },
      { path: 'src/a.ts', line: '3', mutator: 'BooleanLiteral' },
    ])
  })
})
